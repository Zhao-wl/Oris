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
    /// worktree / 子模块 Git 目录的登记发生变化（新增、删除）：工作区需要重新读取成员列表（V2-D82）。
    Members,
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
///   结束后的尾窗口内只跳过写操作自身的回声：文件修改时间不晚于操作结束（含结束时的刷新）的事件，
///   以及操作删除的路径。操作结束之后才发生的修改照常下发。
#[derive(Default)]
pub struct Suppression {
    index_until: Mutex<Option<Instant>>,
    op: Mutex<OpWindow>,
}

#[derive(Default, Clone)]
struct OpWindow {
    active: bool,
    tail_until: Option<Instant>,
    ended_at: Option<std::time::SystemTime>,
    /// 操作结束时不存在的工作区相对路径（操作删除的文件及其上级目录）。
    absent: HashSet<String>,
}

/// 尾窗口内的事件是否只是写操作的回声。
fn is_echo(window: &OpWindow, path: &Path, relative: Option<&str>) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => match (meta.modified(), window.ended_at) {
            (Ok(modified), Some(ended)) => modified <= ended,
            _ => false,
        },
        // 已不存在：工作区路径只有在操作结束时就不存在才算回声；`.git` 内的删除（如撤销根提交删除分支 ref）由操作刷新覆盖。
        Err(_) => relative.is_none_or(|rel| window.absent.contains(rel)),
    }
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
        *op = OpWindow { active: true, ..OpWindow::default() };
    }
    /// 在操作（含结束时的精确刷新）完成后调用。`touched` 为操作改动的工作区相对路径（`/` 分隔），
    /// 用于识别被删除的路径；`tail` 覆盖合并窗口内迟到的回声事件。
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn end_operation(&self, worktree: &Path, touched: impl IntoIterator<Item = String>, tail: Duration) {
        let mut absent = HashSet::new();
        for path in touched {
            let mut current = Some(path.as_str());
            while let Some(rel) = current.filter(|r| !r.is_empty()) {
                if std::fs::symlink_metadata(worktree.join(rel)).is_err() {
                    absent.insert(rel.to_owned());
                }
                current = rel.rfind('/').map(|i| &rel[..i]);
            }
        }
        let mut op = self.op.lock().unwrap_or_else(|p| p.into_inner());
        *op = OpWindow { active: false, tail_until: Some(Instant::now() + tail), ended_at: Some(std::time::SystemTime::now()), absent };
    }
    /// None：不屏蔽；Some(窗口)：操作进行中（active）或处于尾窗口。
    fn operation_state(&self) -> Option<OpWindow> {
        let op = self.op.lock().unwrap_or_else(|p| p.into_inner());
        if op.active || op.tail_until.is_some_and(|until| Instant::now() < until) {
            Some(op.clone())
        } else {
            None
        }
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
    if operation.as_ref().is_some_and(|op| op.active) {
        return None;
    }
    let echo = |path: &Path, relative: Option<&str>| operation.as_ref().is_some_and(|op| is_echo(op, path, relative));
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
                (!suppression.index_suppressed() && !echo(path, None)).then_some(ChangeKind::Index)
            } else if text == "refs/stash" {
                (!echo(path, None)).then_some(ChangeKind::Stash)
            } else if text == "HEAD" || text == "packed-refs" || first == "refs" {
                (!echo(path, None)).then_some(ChangeKind::Refs)
            } else if matches!(first, "worktrees" | "modules") && text.split('/').filter(|part| !part.is_empty()).count() <= 2 {
                Some(ChangeKind::Members)
            } else if matches!(first, "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "BISECT_LOG" | "rebase-merge" | "rebase-apply") {
                Some(ChangeKind::InProgress)
            } else if text.is_empty() {
                // git 目录本身被删除 / 重建。Windows 上目录内新建 / 删除文件（锁文件、ORIG_HEAD 等）也会报告目录自身的修改：
                // 写操作尾窗口内修改时间不晚于操作结束的是操作自身的回声（V2-D60），跳过；手动刷新回写 index 的窗口内同样跳过
                // （回写时建立的 index.lock）。其余情况照旧按全局失效处理；真实的 refs 变化另有自身路径的事件。
                if echo(path, None) || suppression.index_suppressed() {
                    None
                } else {
                    global = true;
                    Some(ChangeKind::Refs)
                }
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
        // 写操作尾窗口：跳过操作自身的回声（修改时间不晚于操作结束，或操作删除的路径）。
        if echo(path, Some(&relative_text)) {
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
    /// 每个成员仓库自己的屏蔽窗口（单仓库 watcher 只有一项）。
    suppressions: HashMap<String, Arc<Suppression>>,
}

impl RepoWatcher {
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn suppression(&self, repo_id: &str) -> Option<Arc<Suppression>> {
        self.suppressions.get(repo_id).cloned()
    }
    pub fn covers(&self, repo_id: &str) -> bool {
        self.suppressions.contains_key(repo_id)
    }
}

pub struct WatchTarget {
    pub repo_id: String,
    pub worktree: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    /// 已跟踪但被忽略的文件清单；在后台线程中计算，不阻塞项目打开。
    pub tracked_ignored: Box<dyn FnOnce() -> HashSet<String> + Send>,
}

/// 分派用的成员信息（工作区共用一个 watcher，技术方案 §10.5）。
struct Member {
    repo_id: String,
    worktree: PathBuf,
    git_dirs: Vec<PathBuf>,
    rules: Arc<IgnoreRules>,
    suppression: Arc<Suppression>,
}

impl Member {
    /// 路径属于该成员时返回匹配前缀的深度（工作区根或 Git 目录中最长的一个）。
    fn prefix_depth(&self, path: &Path) -> Option<usize> {
        std::iter::once(&self.worktree)
            .chain(self.git_dirs.iter())
            .filter(|prefix| path.starts_with(prefix))
            .map(|prefix| prefix.components().count())
            .max()
    }
}

/// 按“最长路径前缀”把一批事件路径分给所属成员：子仓库目录与 `.git/modules/<名称>` 归子仓库，
/// 共享的 common dir（linked worktree 与主仓库共用的 refs）同时分给共用它的成员；空路径（需要重扫）分给全部成员；
/// 不属于任何成员的路径交给第一个成员（按工作区外路径做全局刷新）。
fn dispatch(members: &[Member], paths: &[PathBuf]) -> Vec<Vec<PathBuf>> {
    let mut batches = vec![Vec::new(); members.len()];
    for path in paths {
        if path.as_os_str().is_empty() {
            for batch in &mut batches {
                batch.push(path.clone());
            }
            continue;
        }
        let depths: Vec<Option<usize>> = members.iter().map(|m| m.prefix_depth(path)).collect();
        match depths.iter().flatten().max().copied() {
            Some(best) => {
                for (index, depth) in depths.iter().enumerate() {
                    if *depth == Some(best) {
                        batches[index].push(path.clone());
                    }
                }
            }
            None => batches[0].push(path.clone()),
        }
    }
    batches
}

/// 启动一个仓库 watcher；`emit` 在后台线程上以合并后的分类结果调用。
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub fn watch(
    target: WatchTarget,
    debounce: Duration,
    emit: impl Fn(Invalidation) + Send + 'static,
) -> Result<RepoWatcher, String> {
    watch_group(vec![target], debounce, emit)
}

/// 启动一个覆盖多个仓库的 watcher（工作区，V2-D82）：只为不在其他目标之内的根目录建立递归监听，
/// 事件按最长前缀分派后，由各成员自己的忽略规则与屏蔽窗口分类。第一个目标是工作区的父仓库。
pub fn watch_group(
    targets: Vec<WatchTarget>,
    debounce: Duration,
    emit: impl Fn(Invalidation) + Send + 'static,
) -> Result<RepoWatcher, String> {
    if targets.is_empty() {
        return Err("没有要监听的仓库".into());
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut members = Vec::new();
    let mut suppressions = HashMap::new();
    for target in targets {
        let suppression = Arc::new(Suppression::default());
        let rules = Arc::new(IgnoreRules::new(&target.worktree, &target.git_dir, HashSet::new()));
        let pending_rules = rules.clone();
        let tracked_ignored = target.tracked_ignored;
        std::thread::spawn(move || pending_rules.set_tracked_ignored(tracked_ignored()));
        for root in [&target.worktree, &target.git_dir, &target.common_dir] {
            if !roots.iter().any(|existing| root.starts_with(existing)) {
                roots.retain(|existing| !existing.starts_with(root));
                roots.push(root.clone());
            }
        }
        suppressions.insert(target.repo_id.clone(), suppression.clone());
        members.push(Member {
            repo_id: target.repo_id,
            worktree: target.worktree,
            git_dirs: vec![target.git_dir, target.common_dir],
            rules,
            suppression,
        });
    }
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
        for (member, batch) in members.iter().zip(dispatch(&members, &paths)) {
            if batch.is_empty() {
                continue;
            }
            if let Some(invalidation) = classify(&member.repo_id, &member.worktree, &member.git_dirs, &member.rules, &member.suppression, &batch) {
                emit(invalidation);
            }
        }
    }, NoCache, notify::Config::default())
    .map_err(|error| format!("无法启动文件监听：{error}"))?;
    for root in roots {
        debouncer
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| format!("无法监听 {}：{error}", root.display()))?;
    }
    Ok(RepoWatcher { _debouncer: debouncer, suppressions })
}

/// watcher 的 LRU 登记：最多保留 [`MAX_WATCHED`] 个，超出时关闭最久未使用的项目。
/// 键为项目（普通仓库为自身 repoId，工作区为父仓库 repoId）；一个工作区的 watcher 覆盖全部成员，只占一个名额。
#[derive(Default)]
pub struct WatchLru {
    order: Vec<String>,
    watchers: HashMap<String, RepoWatcher>,
}

impl WatchLru {
    /// 覆盖该仓库的 watcher 的键（自身，或所属工作区）。
    fn key_for(&self, repo_id: &str) -> Option<String> {
        if self.watchers.contains_key(repo_id) {
            return Some(repo_id.to_owned());
        }
        self.watchers.iter().find(|(_, watcher)| watcher.covers(repo_id)).map(|(key, _)| key.clone())
    }
    /// 标记项目为最近使用；返回该项目当前是否仍有 watcher（含所属工作区的 watcher）。
    pub fn touch(&mut self, repo_id: &str) -> bool {
        let key = self.key_for(repo_id).unwrap_or_else(|| repo_id.to_owned());
        self.order.retain(|id| *id != key);
        self.order.push(key.clone());
        self.watchers.contains_key(&key)
    }
    /// 登记 watcher，返回因超过上限而被关闭 watcher 的项目。工作区 watcher 会替换其成员各自的 watcher。
    pub fn insert(&mut self, key: &str, watcher: RepoWatcher) -> Vec<String> {
        let covered: Vec<String> = self.watchers.keys().filter(|id| *id != key && watcher.covers(id)).cloned().collect();
        for id in covered {
            self.remove(&id);
        }
        self.touch(key);
        self.watchers.insert(key.to_owned(), watcher);
        let mut evicted = Vec::new();
        while self.watchers.len() > MAX_WATCHED {
            let Some(oldest) = self.order.iter().find(|id| self.watchers.contains_key(*id)).cloned() else { break };
            self.watchers.remove(&oldest);
            evicted.push(oldest);
        }
        evicted
    }
    /// 移除以该仓库为键的 watcher；成员仓库属于某个工作区 watcher 时不影响工作区。
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn remove(&mut self, repo_id: &str) {
        self.order.retain(|id| id != repo_id);
        self.watchers.remove(repo_id);
    }
    /// 覆盖该仓库的 watcher。
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn get(&self, repo_id: &str) -> Option<&RepoWatcher> {
        self.key_for(repo_id).and_then(|key| self.watchers.get(&key))
    }
    /// 该仓库由某个工作区 watcher 覆盖（键不是它自己）。
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub fn in_group(&self, repo_id: &str) -> bool {
        self.key_for(repo_id).is_some_and(|key| key != repo_id || self.watchers.get(&key).is_some_and(|w| w.suppressions.len() > 1))
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

    /// 写操作屏蔽窗口：操作期间全部只合并不下发；尾窗口内只跳过操作自身的回声（修改时间不晚于操作结束、操作删除的路径），
    /// 操作结束之后才发生的修改照常下发（即使路径与操作相同）。
    #[test]
    fn operation_window_swallows_own_echo_but_keeps_later_changes() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let rules = rules(&root);
        let suppression = Suppression::default();
        let dirs = vec![root.join(".git")];
        let classify_paths = |paths: &[&str]| classify("r", &root, &dirs, &rules, &suppression, &paths.iter().map(|p| root.join(p)).collect::<Vec<_>>());
        fs::write(root.join("other.txt"), b"old").unwrap();
        suppression.begin_operation();
        assert!(classify_paths(&["src/main.rs", ".git/index", ".git/HEAD", "other.txt"]).is_none(), "操作进行中全部只合并");
        fs::write(root.join("src/main.rs"), b"written by the operation").unwrap();
        fs::create_dir_all(root.join("gone/dir")).unwrap();
        fs::write(root.join("gone/dir/file.txt"), b"x").unwrap();
        fs::remove_dir_all(root.join("gone")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        suppression.end_operation(&root, vec!["src/main.rs".to_owned(), "gone/dir/file.txt".to_owned()], Duration::from_secs(5));
        assert!(classify_paths(&["src/main.rs", ".git/index", ".git/HEAD", "gone/dir/file.txt", "gone/dir", "gone", "other.txt"]).is_none(), "操作的回声与更早的修改被跳过");
        std::thread::sleep(Duration::from_millis(20));
        fs::write(root.join("src/main.rs"), b"edited by the user right after the operation").unwrap();
        fs::write(root.join("other.txt"), b"new").unwrap();
        let later = classify_paths(&["src/main.rs", "other.txt"]).unwrap();
        assert_eq!(later.paths, vec!["other.txt".to_owned(), "src/main.rs".to_owned()], "操作结束后的修改照常下发");
        fs::remove_file(root.join("other.txt")).unwrap();
        assert_eq!(classify_paths(&["other.txt"]).unwrap().paths, vec!["other.txt".to_owned()], "操作之外的删除照常下发");
        suppression.end_operation(&root, Vec::new(), Duration::ZERO);
        assert_eq!(classify_paths(&[".git/index"]).unwrap().kinds, vec![ChangeKind::Index]);
    }

    /// V2-D60：git 目录本身的修改（Windows 上目录内新建 / 删除锁文件时报告）与 refs/stash 在尾窗口内同样按回声跳过；
    /// 窗口外、或操作结束之后才发生的修改照旧下发（git 目录本身仍是全局 refs 失效）。
    #[test]
    fn operation_tail_skips_git_dir_and_stash_echo() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let rules = rules(&root);
        let suppression = Suppression::default();
        let dirs = vec![root.join(".git")];
        let classify_paths = |paths: &[&str]| classify("r", &root, &dirs, &rules, &suppression, &paths.iter().map(|p| root.join(p)).collect::<Vec<_>>());
        let git_dir_event = || classify("r", &root, &dirs, &rules, &suppression, &[root.join(".git")]);
        // 窗口外：与修复前相同。
        let outside = git_dir_event().unwrap();
        assert!(outside.global);
        assert_eq!(outside.kinds, vec![ChangeKind::Refs]);
        assert_eq!(classify_paths(&[".git/refs/stash"]).unwrap().kinds, vec![ChangeKind::Stash]);
        // 操作期间：git 目录内新建 / 删除锁文件，写 refs/stash。
        suppression.begin_operation();
        fs::write(root.join(".git/oris-test.lock"), b"x").unwrap();
        fs::remove_file(root.join(".git/oris-test.lock")).unwrap();
        fs::write(root.join(".git/refs/stash"), b"0000000000000000000000000000000000000000\n").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        suppression.end_operation(&root, Vec::new(), Duration::from_secs(5));
        assert!(git_dir_event().is_none(), "git 目录本身的回声被跳过");
        assert!(classify_paths(&[".git/refs/stash"]).is_none(), "refs/stash 的回声被跳过");
        // 操作结束之后外部再次修改：照常下发。
        std::thread::sleep(Duration::from_millis(20));
        fs::write(root.join(".git/oris-test-later"), b"x").unwrap();
        fs::write(root.join(".git/refs/stash"), b"1111111111111111111111111111111111111111\n").unwrap();
        let later = git_dir_event().unwrap();
        assert!(later.global);
        assert_eq!(later.kinds, vec![ChangeKind::Refs]);
        assert_eq!(classify_paths(&[".git/refs/stash"]).unwrap().kinds, vec![ChangeKind::Stash]);
        // 尾窗口内 .git 中的删除按现有规则算回声（与 HEAD / refs 相同，由操作刷新覆盖）。
        fs::remove_file(root.join(".git/refs/stash")).unwrap();
        assert!(classify_paths(&[".git/refs/stash"]).is_none());
        // 手动刷新回写 index 的窗口：git 目录本身的事件（index.lock）与 index 一起跳过，refs 自身的事件照常下发。
        suppression.end_operation(&root, Vec::new(), Duration::ZERO);
        assert!(git_dir_event().is_some());
        suppression.index_for(Duration::from_secs(5));
        assert!(git_dir_event().is_none());
        assert_eq!(classify_paths(&[".git", ".git/refs/heads/main"]).unwrap().kinds, vec![ChangeKind::Refs]);
        assert!(!classify_paths(&[".git", ".git/refs/heads/main"]).unwrap().global);
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

    fn member(repo_id: &str, worktree: &Path, git_dir: &Path, common_dir: &Path) -> Member {
        Member {
            repo_id: repo_id.into(),
            worktree: worktree.to_path_buf(),
            git_dirs: vec![git_dir.to_path_buf(), common_dir.to_path_buf()],
            rules: Arc::new(IgnoreRules::new(worktree, git_dir, HashSet::new())),
            suppression: Arc::default(),
        }
    }

    /// 技术方案 §10.5：事件按最长前缀归属；子模块的 Git 目录在父仓库 `.git/modules` 下，归子模块；
    /// 共享的 common dir 同时分给主仓库与它的 linked worktree；需要重扫的空路径分给全部成员。
    #[test]
    fn group_dispatch_routes_paths_to_the_longest_prefix() {
        let root = PathBuf::from(if cfg!(windows) { r"C:\ws" } else { "/ws" });
        let modules = root.join(".git").join("modules");
        let members = vec![
            member("root", &root, &root.join(".git"), &root.join(".git")),
            member("battle", &root.join("battle"), &modules.join("battle"), &modules.join("battle")),
            member("r2", &root.join("battle-r2"), &modules.join("battle").join("worktrees").join("battle-r2"), &modules.join("battle")),
        ];
        let paths = vec![
            root.join("AGENTS.md"),
            root.join("battle").join("src").join("a.rs"),
            root.join("battle-r2").join("b.rs"),
            modules.join("battle").join("index"),
            modules.join("battle").join("refs").join("heads").join("main"),
            modules.join("battle").join("worktrees").join("battle-r2").join("HEAD"),
            root.join(".git").join("index"),
            PathBuf::new(),
        ];
        let batches = dispatch(&members, &paths);
        let names = |batch: &Vec<PathBuf>| batch.iter().map(|p| p.strip_prefix(&root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()).collect::<Vec<_>>();
        assert_eq!(names(&batches[0]), vec!["AGENTS.md", ".git/index", ""]);
        assert_eq!(names(&batches[1]), vec!["battle/src/a.rs", ".git/modules/battle/index", ".git/modules/battle/refs/heads/main", ""]);
        // linked worktree 与主仓库共用 common dir：其中的事件两者都收到（与单仓库 watcher 同时监听 git dir 与 common dir 的行为一致）。
        assert_eq!(names(&batches[2]), vec!["battle-r2/b.rs", ".git/modules/battle/index", ".git/modules/battle/refs/heads/main", ".git/modules/battle/worktrees/battle-r2/HEAD", ""]);
    }

    /// V2-D82：父仓库不因子仓库目录中的写入（含被子仓库忽略的大量写入）收到通知；一个 watcher 在 LRU 中只占一个名额。
    #[test]
    fn group_watcher_keeps_parent_quiet_for_child_writes() {
        let dir = repo();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let child = root.join("child");
        fs::create_dir_all(&child).unwrap();
        git(&child, &["init", "-q"]);
        fs::write(child.join(".gitignore"), "Library/\n").unwrap();
        fs::create_dir_all(child.join("Library")).unwrap();
        let (sender, receiver) = mpsc::channel();
        let targets = vec![
            WatchTarget { repo_id: "root".into(), worktree: root.clone(), git_dir: root.join(".git"), common_dir: root.join(".git"), tracked_ignored: Box::new(HashSet::new) },
            WatchTarget { repo_id: "child".into(), worktree: child.clone(), git_dir: child.join(".git"), common_dir: child.join(".git"), tracked_ignored: Box::new(HashSet::new) },
        ];
        let watcher = watch_group(targets, DEBOUNCE, move |change| {
            let _ = sender.send(change);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let _ = receiver.try_iter().count();
        for i in 0..2_000 {
            fs::write(child.join("Library").join(format!("cache-{i}.bin")), b"x").unwrap();
        }
        std::thread::sleep(Duration::from_millis(1200));
        let ignored: Vec<_> = receiver.try_iter().collect();
        assert!(ignored.iter().all(|c| c.repo_id != "root"), "父仓库收到了子仓库的事件：{ignored:?}");
        fs::write(child.join("real.txt"), b"y").unwrap();
        let mut seen = Vec::new();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(3) {
            if let Ok(change) = receiver.recv_timeout(Duration::from_millis(100)) {
                seen.push(change);
            } else if !seen.is_empty() {
                break;
            }
        }
        assert!(seen.iter().any(|c| c.repo_id == "child" && c.paths == vec!["real.txt".to_owned()]), "{seen:?}");
        assert!(seen.iter().all(|c| c.repo_id != "root"), "{seen:?}");
        fs::write(root.join("top.txt"), b"z").unwrap();
        let top = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!((top.repo_id.as_str(), top.paths.clone()), ("root", vec!["top.txt".to_owned()]));
        let mut lru = WatchLru::default();
        lru.insert("root", watcher);
        assert_eq!(lru.len(), 1);
        assert!(lru.touch("child") && lru.in_group("child") && lru.in_group("root"));
        assert!(lru.get("child").and_then(|w| w.suppression("child")).is_some());
        lru.remove("child");
        assert_eq!(lru.len(), 1, "移除成员自身的键不影响工作区 watcher");
    }
}
