//! V2 Watcher（技术方案 §5.4）：后端合并事件（notify-debouncer-full，约 200 ms），
//! 按 gitignore 过滤被忽略路径，把 `.git` 内的变化分类后再下发。
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use notify_debouncer_full::notify::{self, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// 同时保留 watcher 的项目数上限（LRU）。
pub const MAX_WATCHED: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Worktree,
    Index,
    Refs,
    Stash,
    InProgress,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invalidation {
    pub repo_id: String,
    /// 工作区相对路径（`/` 分隔）。
    pub paths: Vec<String>,
    /// 无法精确归类（溢出 / 需要重扫 / 工作区外路径）。
    pub global: bool,
    pub kinds: Vec<ChangeKind>,
}

/// 屏蔽窗口（V2-D09、技术方案 §4）：
/// - 手动刷新回写 index stat 缓存时，跳过由此产生的 `.git/index` 事件；
/// - Oris 写操作期间该仓库的事件只合并、不下发（操作结束后由 OperationRunner 精确刷新）；
///   结束后的短尾窗口内再跳过写操作自身的回声：index / refs 事件与操作触及的工作区路径。
#[derive(Default)]
pub struct Suppression {
    index_until: Mutex<Option<Instant>>,
    op: Mutex<OpWindow>,
}

#[derive(Default)]
struct OpWindow {
    active: bool,
    tail_until: Option<Instant>,
    paths: HashSet<String>,
}

impl Suppression {
    pub fn index_for(&self, duration: Duration) {
        *self.index_until.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now() + duration);
    }
    fn index_suppressed(&self) -> bool {
        self.index_until
            .lock()
            .map(|g| g.is_some_and(|until| Instant::now() < until))
            .unwrap_or(false)
    }
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn begin_operation(&self) {
        let mut op = self.op.lock().unwrap_or_else(|p| p.into_inner());
        *op = OpWindow { active: true, tail_until: None, paths: HashSet::new() };
    }
    /// `touched` 为操作改动的工作区相对路径（`/` 分隔）；`tail` 覆盖合并窗口内迟到的回声事件。
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn end_operation(&self, touched: impl IntoIterator<Item = String>, tail: Duration) {
        let mut op = self.op.lock().unwrap_or_else(|p| p.into_inner());
        *op = OpWindow { active: false, tail_until: Some(Instant::now() + tail), paths: touched.into_iter().collect() };
    }
    /// None：不屏蔽；Some(true)：操作进行中，全部跳过；Some(false)：尾窗口，跳过回声。
    fn operation_state(&self) -> Option<(bool, HashSet<String>)> {
        let op = self.op.lock().unwrap_or_else(|p| p.into_inner());
        if op.active {
            return Some((true, HashSet::new()));
        }
        op.tail_until.filter(|until| Instant::now() < *until).map(|_| (false, op.paths.clone()))
    }
}

/// 分层 gitignore 匹配器：根 `.gitignore`、子目录 `.gitignore`、`info/exclude` 与全局 excludes。
pub struct IgnoreRules {
    root: PathBuf,
    per_dir: Mutex<HashMap<PathBuf, Option<Arc<Gitignore>>>>,
    base: Arc<Gitignore>,
    global: Arc<Gitignore>,
    /// 已跟踪但匹配忽略规则的路径：它们的变化仍然有效（与 `git check-ignore` 默认不报告已跟踪文件一致）。
    tracked_ignored: Mutex<HashSet<String>>,
}

impl IgnoreRules {
    pub fn set_tracked_ignored(&self, paths: HashSet<String>) {
        *self.tracked_ignored.lock().unwrap_or_else(|p| p.into_inner()) = paths;
    }

    pub fn new(root: &Path, git_dir: &Path, tracked_ignored: HashSet<String>) -> Self {
        let mut builder = GitignoreBuilder::new(root);
        let _ = builder.add(git_dir.join("info").join("exclude"));
        let base = builder.build().unwrap_or_else(|_| Gitignore::empty());
        Self {
            root: root.to_path_buf(),
            per_dir: Mutex::new(HashMap::new()),
            base: Arc::new(base),
            global: Arc::new(Gitignore::global().0),
            tracked_ignored: Mutex::new(tracked_ignored),
        }
    }

    /// `.gitignore` 变化后丢弃缓存的匹配器，下次按需重新加载。
    pub fn reload(&self) {
        self.per_dir.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    fn matcher(&self, dir: &Path) -> Option<Arc<Gitignore>> {
        let mut cache = self.per_dir.lock().unwrap_or_else(|p| p.into_inner());
        cache
            .entry(dir.to_path_buf())
            .or_insert_with(|| {
                let file = dir.join(".gitignore");
                if !file.is_file() {
                    return None;
                }
                let mut builder = GitignoreBuilder::new(dir);
                builder.add(&file);
                builder.build().ok().map(Arc::new)
            })
            .clone()
    }

    /// 路径（绝对）是否被忽略：自身或任一上级目录被忽略即视为忽略；更深层规则优先。
    pub fn ignored(&self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.root) else { return false };
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        if self
            .tracked_ignored
            .lock()
            .map(|set| set.contains(&relative_text))
            .unwrap_or(false)
        {
            return false;
        }
        // 从路径本身开始，逐级检查“路径或其上级”是否被忽略。
        let mut candidates: Vec<&Path> = Vec::new();
        let mut current = Some(relative);
        while let Some(value) = current {
            if value.as_os_str().is_empty() {
                break;
            }
            candidates.push(value);
            current = value.parent();
        }
        // candidates：从最深到最浅；Git 语义下上级目录被忽略则其内容全部忽略。
        for candidate in candidates.iter().rev() {
            let absolute = self.root.join(candidate);
            let is_dir = *candidate != relative || absolute.is_dir();
            if self.decide(&absolute, is_dir) {
                return true;
            }
        }
        false
    }

    fn decide(&self, absolute: &Path, is_dir: bool) -> bool {
        // 从路径所在目录向上找各层 .gitignore，最近的一层先判定。
        let mut dir = absolute.parent();
        while let Some(current) = dir {
            if !current.starts_with(&self.root) {
                break;
            }
            if let Some(matcher) = self.matcher(current) {
                match matcher.matched(absolute, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if current == self.root {
                break;
            }
            dir = current.parent();
        }
        match self.base.matched(absolute, is_dir) {
            Match::Ignore(_) => true,
            Match::Whitelist(_) => false,
            Match::None => matches!(self.global.matched(absolute, is_dir), Match::Ignore(_)),
        }
    }
}

/// 把一批原始路径归类为一次失效通知；全部被忽略时返回 None。
pub fn classify(
    repo_id: &str,
    worktree: &Path,
    git_dirs: &[PathBuf],
    rules: &IgnoreRules,
    suppression: &Suppression,
    paths: &[PathBuf],
) -> Option<Invalidation> {
    let operation = suppression.operation_state();
    if matches!(operation, Some((true, _))) {
        return None;
    }
    let echo = operation.map(|(_, paths)| paths);
    let mut kinds = BTreeSet::new();
    let mut relative = BTreeSet::new();
    let mut global = false;
    let mut reload_rules = false;
    for path in paths {
        if path.as_os_str().is_empty() {
            global = true;
            kinds.insert(ChangeKind::Worktree);
            continue;
        }
        if let Some(dir) = git_dirs.iter().find(|dir| path.starts_with(dir)) {
            let inner = path.strip_prefix(dir).unwrap_or(path);
            let text = inner.to_string_lossy().replace('\\', "/");
            let first = text.split('/').next().unwrap_or("");
            let kind = if text.ends_with(".lock") || matches!(first, "objects" | "logs" | "lfs" | "hooks") {
                None
            } else if text == "index" {
                (!suppression.index_suppressed() && echo.is_none()).then_some(ChangeKind::Index)
            } else if text == "refs/stash" {
                Some(ChangeKind::Stash)
            } else if text == "HEAD" || text == "packed-refs" || first == "refs" {
                echo.is_none().then_some(ChangeKind::Refs)
            } else if matches!(first, "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "BISECT_LOG" | "rebase-merge" | "rebase-apply") {
                Some(ChangeKind::InProgress)
            } else if text.is_empty() {
                // git 目录本身被删除 / 重建。
                global = true;
                Some(ChangeKind::Refs)
            } else {
                None
            };
            if let Some(kind) = kind {
                kinds.insert(kind);
            }
            continue;
        }
        let Ok(inner) = path.strip_prefix(worktree) else {
            global = true;
            kinds.insert(ChangeKind::Worktree);
            continue;
        };
        if inner.as_os_str().is_empty() {
            global = true;
            kinds.insert(ChangeKind::Worktree);
            continue;
        }
        let relative_text = inner.to_string_lossy().replace('\\', "/");
        if inner.file_name().is_some_and(|name| name == ".gitignore") {
            reload_rules = true;
        } else if rules.ignored(path) {
            continue;
        }
        // 写操作尾窗口：跳过操作自身改动的路径（及其上级目录的事件）。
        if echo.as_ref().is_some_and(|paths| paths.iter().any(|p| *p == relative_text || p.starts_with(&format!("{relative_text}/")))) {
            continue;
        }
        kinds.insert(ChangeKind::Worktree);
        relative.insert(relative_text);
    }
    if reload_rules {
        rules.reload();
    }
    if kinds.is_empty() {
        return None;
    }
    Some(Invalidation {
        repo_id: repo_id.to_owned(),
        paths: relative.into_iter().take(200).collect(),
        global,
        kinds: kinds.into_iter().collect(),
    })
}

/// 读取是否属于应当丢弃的访问类事件。
fn noise(event: &notify::Event) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Access(_)
            | notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
                notify::event::MetadataKind::AccessTime
            ))
    ) && !event.need_rescan()
}

pub struct RepoWatcher {
    // 不使用文件 ID 缓存：Windows 上默认的 FileIdMap 会在 watch() 时遍历整棵目录树并为每个文件保存 ID，
    // 大仓库打开会慢上秒级并常驻内存；我们不需要跨事件的 rename 缝合。
    _debouncer: Debouncer<notify::RecommendedWatcher, NoCache>,
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub suppression: Arc<Suppression>,
}

pub struct WatchTarget {
    pub repo_id: String,
    pub worktree: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    /// 已跟踪但被忽略的文件清单；在后台线程中计算，不阻塞项目打开。
    pub tracked_ignored: Box<dyn FnOnce() -> HashSet<String> + Send>,
}

/// 启动一个仓库 watcher；`emit` 在后台线程上以合并后的分类结果调用。
pub fn watch(
    target: WatchTarget,
    debounce: Duration,
    emit: impl Fn(Invalidation) + Send + 'static,
) -> Result<RepoWatcher, String> {
    let suppression = Arc::new(Suppression::default());
    let handler_rules = Arc::new(IgnoreRules::new(&target.worktree, &target.git_dir, HashSet::new()));
    let pending_rules = handler_rules.clone();
    let tracked_ignored = target.tracked_ignored;
    std::thread::spawn(move || pending_rules.set_tracked_ignored(tracked_ignored()));
    let git_dirs = vec![target.git_dir.clone(), target.common_dir.clone()];
    let handler_suppression = suppression.clone();
    let repo_id = target.repo_id.clone();
    let worktree = target.worktree.clone();
    let mut debouncer = new_debouncer_opt::<_, notify::RecommendedWatcher, NoCache>(debounce, None, move |result: DebounceEventResult| {
        let paths: Vec<PathBuf> = match result {
            Ok(events) => events
                .iter()
                .filter(|event| !noise(event))
                .flat_map(|event| {
                    if event.need_rescan() || event.paths.is_empty() {
                        vec![PathBuf::new()]
                    } else {
                        event.paths.clone()
                    }
                })
                .collect(),
            Err(_) => vec![PathBuf::new()],
        };
        if paths.is_empty() {
            return;
        }
        if let Some(invalidation) = classify(&repo_id, &worktree, &git_dirs, &handler_rules, &handler_suppression, &paths) {
            emit(invalidation);
        }
    }, NoCache, notify::Config::default())
    .map_err(|error| format!("无法启动文件监听：{error}"))?;
    let mut roots = vec![target.worktree.clone()];
    if !target.git_dir.starts_with(&target.worktree) {
        roots.push(target.git_dir.clone());
    }
    if target.common_dir != target.git_dir && !target.common_dir.starts_with(&target.worktree) {
        roots.push(target.common_dir.clone());
    }
    for root in roots {
        debouncer
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| format!("无法监听 {}：{error}", root.display()))?;
    }
    Ok(RepoWatcher { _debouncer: debouncer, suppression })
}

/// watcher 的 LRU 登记：最多保留 [`MAX_WATCHED`] 个，超出时关闭最久未使用的项目。
#[derive(Default)]
pub struct WatchLru {
    order: Vec<String>,
    watchers: HashMap<String, RepoWatcher>,
}

impl WatchLru {
    /// 标记项目为最近使用；返回该项目当前是否仍有 watcher。
    pub fn touch(&mut self, repo_id: &str) -> bool {
        self.order.retain(|id| id != repo_id);
        self.order.push(repo_id.to_owned());
        self.watchers.contains_key(repo_id)
    }
    /// 登记 watcher，返回因超过上限而被关闭 watcher 的项目。
    pub fn insert(&mut self, repo_id: &str, watcher: RepoWatcher) -> Vec<String> {
        self.touch(repo_id);
        self.watchers.insert(repo_id.to_owned(), watcher);
        let mut evicted = Vec::new();
        while self.watchers.len() > MAX_WATCHED {
            let Some(oldest) = self.order.iter().find(|id| self.watchers.contains_key(*id)).cloned() else { break };
            self.watchers.remove(&oldest);
            evicted.push(oldest);
        }
        evicted
    }
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn remove(&mut self, repo_id: &str) {
        self.order.retain(|id| id != repo_id);
        self.watchers.remove(repo_id);
    }
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn get(&self, repo_id: &str) -> Option<&RepoWatcher> {
        self.watchers.get(repo_id)
    }
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.watchers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::sync::mpsc;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q"]);
        git(p, &["config", "user.name", "Watch"]);
        git(p, &["config", "user.email", "watch@example.invalid"]);
        fs::write(p.join(".gitignore"), "node_modules/\ndist/\n*.log\n!keep.log\n").unwrap();
        fs::create_dir_all(p.join("src/generated")).unwrap();
        fs::write(p.join("src/.gitignore"), "generated/\n").unwrap();
        fs::write(p.join("src/main.rs"), "fn main() {}\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "init"]);
        dir
    }

    fn rules(dir: &Path) -> IgnoreRules {
        let root = dunce::canonicalize(dir).unwrap();
        IgnoreRules::new(&root, &root.join(".git"), HashSet::new())
    }

    #[test]
    fn gitignore_layers_negation_and_git_dir_classes() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let rules = rules(&root);
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        assert!(rules.ignored(&root.join("node_modules/pkg/index.js")));
        assert!(rules.ignored(&root.join("dist/app.js")));
        assert!(rules.ignored(&root.join("build.log")));
        assert!(!rules.ignored(&root.join("keep.log")));
        assert!(rules.ignored(&root.join("src/generated/out.rs")));
        assert!(!rules.ignored(&root.join("src/main.rs")));
        let suppression = Suppression::default();
        let dirs = vec![root.join(".git")];
        let classify_paths = |paths: &[&str]| {
            classify("r", &root, &dirs, &rules, &suppression, &paths.iter().map(|p| root.join(p)).collect::<Vec<_>>())
        };
        assert!(classify_paths(&["node_modules/a.js", "dist/x", ".git/objects/ab/cd", ".git/index.lock"]).is_none());
        let change = classify_paths(&["src/main.rs", "node_modules/a.js"]).unwrap();
        assert_eq!(change.kinds, vec![ChangeKind::Worktree]);
        assert_eq!(change.paths, vec!["src/main.rs".to_owned()]);
        assert_eq!(classify_paths(&[".git/index"]).unwrap().kinds, vec![ChangeKind::Index]);
        assert_eq!(classify_paths(&[".git/refs/heads/main"]).unwrap().kinds, vec![ChangeKind::Refs]);
        assert_eq!(classify_paths(&[".git/HEAD"]).unwrap().kinds, vec![ChangeKind::Refs]);
        assert_eq!(classify_paths(&[".git/refs/stash"]).unwrap().kinds, vec![ChangeKind::Stash]);
        assert_eq!(classify_paths(&[".git/MERGE_HEAD"]).unwrap().kinds, vec![ChangeKind::InProgress]);
        suppression.index_for(Duration::from_secs(5));
        assert!(classify_paths(&[".git/index"]).is_none());
        assert_eq!(classify_paths(&[".git/index", ".git/HEAD"]).unwrap().kinds, vec![ChangeKind::Refs]);
        let overflow = classify("r", &root, &dirs, &rules, &suppression, &[PathBuf::new()]).unwrap();
        assert!(overflow.global);
    }

    /// 写操作屏蔽窗口：操作期间全部只合并不下发；尾窗口内跳过 index / refs 与操作触及路径的回声，其他路径照常下发。
    #[test]
    fn operation_window_swallows_own_echo_but_keeps_other_changes() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let rules = rules(&root);
        let suppression = Suppression::default();
        let dirs = vec![root.join(".git")];
        let classify_paths = |paths: &[&str]| classify("r", &root, &dirs, &rules, &suppression, &paths.iter().map(|p| root.join(p)).collect::<Vec<_>>());
        suppression.begin_operation();
        assert!(classify_paths(&["src/main.rs", ".git/index", ".git/HEAD", "other.txt"]).is_none());
        suppression.end_operation(vec!["src/main.rs".to_owned(), "gone/dir/file.txt".to_owned()], Duration::from_secs(5));
        assert!(classify_paths(&["src/main.rs", ".git/index", ".git/refs/heads/main", "gone/dir"]).is_none());
        let other = classify_paths(&["src/main.rs", "other.txt"]).unwrap();
        assert_eq!(other.paths, vec!["other.txt".to_owned()]);
        suppression.end_operation(Vec::new(), Duration::ZERO);
        assert_eq!(classify_paths(&[".git/index"]).unwrap().kinds, vec![ChangeKind::Index]);
    }

    #[test]
    fn tracked_files_under_ignore_rules_still_count() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/committed.js"), "1").unwrap();
        git(&root, &["add", "-f", "dist/committed.js"]);
        git(&root, &["commit", "-qm", "force"]);
        let rules = IgnoreRules::new(&root, &root.join(".git"), HashSet::from(["dist/committed.js".to_owned()]));
        assert!(!rules.ignored(&root.join("dist/committed.js")));
        assert!(rules.ignored(&root.join("dist/other.js")));
    }

    #[test]
    fn access_is_noise_but_overflow_remains_dirty() {
        let access = notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Read));
        assert!(noise(&access));
        assert!(!noise(&access.set_flag(notify::event::Flag::Rescan)));
        let atime = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
            notify::event::MetadataKind::AccessTime,
        )));
        assert!(noise(&atime));
        let write = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Any,
        )));
        assert!(!noise(&write));
    }

    /// 原 V1 用例：读取被选中的文件不产生刷新通知，写入会产生（经过新的合并与分类链路）。
    #[test]
    fn native_filesystem_watch_reads_do_not_dirty_but_writes_do() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let file = root.join("selected.json");
        fs::write(&file, b"{\"a\":1}").unwrap();
        let (sender, receiver) = mpsc::channel();
        let _watcher = watch(
            WatchTarget { repo_id: "r".into(), worktree: root.clone(), git_dir: root.join(".git"), common_dir: root.join(".git"), tracked_ignored: Box::new(HashSet::new) },
            DEBOUNCE,
            move |change| {
                let _ = sender.send(change);
            },
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let _ = receiver.try_iter().count();
        for _ in 0..20 {
            let _ = fs::metadata(&file).unwrap();
            let _ = fs::read(&file).unwrap();
        }
        std::thread::sleep(Duration::from_millis(800));
        let read_invalidations = receiver.try_iter().count();
        fs::write(&file, b"{\"a\":222}").unwrap();
        let write = receiver.recv_timeout(Duration::from_secs(3)).ok();
        println!("FILESYSTEM_WATCH read_invalidations={read_invalidations} write={write:?}");
        assert_eq!(read_invalidations, 0);
        assert_eq!(write.unwrap().paths, vec!["selected.json".to_owned()]);
    }

    #[test]
    fn lru_keeps_at_most_five_watchers() {
        let dirs: Vec<_> = (0..7).map(|_| repo()).collect();
        let mut lru = WatchLru::default();
        let mut evicted = Vec::new();
        for (i, dir) in dirs.iter().enumerate() {
            let root = dunce::canonicalize(dir.path()).unwrap();
            let watcher = watch(
                WatchTarget { repo_id: format!("r{i}"), worktree: root.clone(), git_dir: root.join(".git"), common_dir: root.join(".git"), tracked_ignored: Box::new(HashSet::new) },
                DEBOUNCE,
                |_| {},
            )
            .unwrap();
            evicted.extend(lru.insert(&format!("r{i}"), watcher));
        }
        assert_eq!(lru.len(), MAX_WATCHED);
        assert_eq!(evicted, vec!["r0".to_owned(), "r1".to_owned()]);
        assert!(!lru.touch("r0"));
        assert!(lru.touch("r6"));
    }

    /// B04：被忽略目录大量写入不触发通知；非忽略路径的写入在合并窗口后以一次通知送达。
    #[test]
    fn ignored_storm_is_silent_and_real_changes_are_batched() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        let (sender, receiver) = mpsc::channel();
        let _watcher = watch(
            WatchTarget { repo_id: "r".into(), worktree: root.clone(), git_dir: root.join(".git"), common_dir: root.join(".git"), tracked_ignored: Box::new(HashSet::new) },
            DEBOUNCE,
            move |change| {
                let _ = sender.send(change);
            },
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        for i in 0..10_000 {
            fs::write(root.join(format!("node_modules/pkg/f{i}.js")), b"x").unwrap();
        }
        let storm: Vec<_> = receiver.try_iter().collect();
        std::thread::sleep(Duration::from_millis(1500));
        let late: Vec<_> = receiver.try_iter().collect();
        let ignored_notifications = storm.len() + late.len();
        let started = Instant::now();
        for i in 0..200 {
            fs::write(root.join(format!("src/real-{i}.txt")), b"y").unwrap();
        }
        let mut received = Vec::new();
        while started.elapsed() < Duration::from_secs(5) {
            if let Ok(change) = receiver.recv_timeout(Duration::from_millis(100)) {
                received.push(change);
            } else if !received.is_empty() {
                break;
            }
        }
        let paths: BTreeSet<String> = received.iter().flat_map(|c| c.paths.clone()).collect();
        println!(
            "WATCH_B04 ignored_writes=10000 ignored_notifications={ignored_notifications} real_writes=200 notifications={} distinct_paths={} first_after_ms={}",
            received.len(),
            paths.len(),
            started.elapsed().as_millis()
        );
        // 忽略目录的 10,000 次写入：零通知（被忽略路径不下发）。
        assert_eq!(ignored_notifications, 0, "{storm:?} {late:?}");
        assert!(!received.is_empty());
        assert!(received.len() <= 10, "事件应被合并，实际 {} 次", received.len());
        assert!(received.iter().all(|c| c.kinds == vec![ChangeKind::Worktree]));
    }
}
