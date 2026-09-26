//! V2-05 验收测试（B15 / B16 / B17）：hunk 级暂存、取消暂存与丢弃。
//! 每个场景记录操作前后的 `git diff` / `git diff --cached` 与工作区、index、refs、stash、config 指纹，
//! 断言只有目标块被移动或丢弃。设置环境变量 `ORIS_HUNK_EVIDENCE=<目录>` 时把每个场景的前后输出写成 JSON 证据。
use super::hunk::HunkRef;
use super::process::CancelHandle;
use super::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

fn git_raw(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git").arg("-C").arg(root).args(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"]).args(args).output().unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    output.stdout
}

fn init() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git_raw(p, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.name", "Hunk"), ("user.email", "hunk@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        git_raw(p, &["config", key, value]);
    }
    dir
}

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn id(path: &str) -> String {
    URL_SAFE_NO_PAD.encode(path.as_bytes())
}

fn commit_all(root: &Path) {
    git_raw(root, &["add", "-A"]);
    git_raw(root, &["commit", "-qm", "base"]);
}

static OPS: AtomicUsize = AtomicUsize::new(0);

struct Harness {
    adapter: GitAdapter,
    store: BackupStore,
    _backups: tempfile::TempDir,
}

impl Harness {
    fn new(root: &Path) -> Self {
        let backups = tempfile::tempdir().unwrap();
        Self { adapter: GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap(), store: BackupStore::new(backups.path().join("b")), _backups: backups }
    }
    fn run(&self, request: OperationRequest, scope: CompareScope) -> Result<OperationOutcome, GitError> {
        let ctx = OpContext::new(format!("hunk-{}-{}", std::process::id(), OPS.fetch_add(1, Ordering::SeqCst)), Arc::new(CancelHandle::default()), &self.store, &|_| {});
        self.adapter.run_operation(request, scope, &ctx)
    }
    /// 当前状态下的块映射（只读）。
    fn map(&self, scope: CompareScope, path: &str) -> HunkMap {
        let snapshot = self.adapter.snapshot_for_scope("map".into(), scope).unwrap();
        self.adapter.hunk_map(scope, &snapshot.revision, &id(path)).unwrap()
    }
}

/// 工作区、index、refs（HEAD、refs/ 除 stash、packed-refs）、stash（refs/stash 与 logs/refs/stash）、config 分类指纹。
fn fingerprint(root: &Path) -> BTreeMap<&'static str, String> {
    let mut groups: BTreeMap<&'static str, Vec<(String, String)>> = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if rel == ".git/objects" || rel.starts_with(".git/hooks") {
                continue;
            }
            if entry.file_type().unwrap().is_dir() {
                stack.push(path);
                continue;
            }
            let group = if rel == ".git/index" {
                "index"
            } else if rel == ".git/refs/stash" || rel == ".git/logs/refs/stash" {
                "stash"
            } else if rel == ".git/HEAD" || rel.starts_with(".git/refs/") || rel == ".git/packed-refs" {
                "refs"
            } else if rel == ".git/config" {
                "config"
            } else if rel.starts_with(".git/") {
                continue;
            } else {
                "worktree"
            };
            groups.entry(group).or_default().push((rel, hash_bytes(&fs::read(&path).unwrap())));
        }
    }
    let mut out = BTreeMap::new();
    for group in ["worktree", "index", "refs", "stash", "config"] {
        let mut list = groups.remove(group).unwrap_or_default();
        list.sort();
        out.insert(group, hash_bytes(format!("{list:?}").as_bytes()));
    }
    out
}

/// index 内容（`ls-files -s`）：与 stat 缓存无关。
fn index_entries(root: &Path) -> String {
    String::from_utf8_lossy(&git_raw(root, &["ls-files", "-s"])).into_owned()
}

fn diffs(root: &Path) -> (String, String) {
    let unstaged = String::from_utf8_lossy(&git_raw(root, &["diff", "--no-color", "-U0", "--no-ext-diff", "--no-textconv"])).into_owned();
    let staged = String::from_utf8_lossy(&git_raw(root, &["diff", "--cached", "--no-color", "-U0", "--no-ext-diff", "--no-textconv"])).into_owned();
    (unstaged, staged)
}

fn diffs_path(root: &Path, path: &str) -> (String, String) {
    let unstaged = String::from_utf8_lossy(&git_raw(root, &["diff", "--no-color", "-U0", "--no-ext-diff", "--no-textconv", "--", path])).into_owned();
    let staged = String::from_utf8_lossy(&git_raw(root, &["diff", "--cached", "--no-color", "-U0", "--no-ext-diff", "--no-textconv", "--", path])).into_owned();
    (unstaged, staged)
}

/// 只保留差异块的正文行（去掉 index 行等随对象变化的头部），便于逐块比较。
fn bodies(diff: &str) -> Vec<String> {
    let mut hunks: Vec<String> = Vec::new();
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunks.push(String::new());
        } else if let Some(last) = hunks.last_mut() {
            if line.starts_with('-') || line.starts_with('+') || line.starts_with('\\') {
                last.push_str(line);
                last.push('\n');
            }
        }
    }
    hunks
}

struct Evidence {
    name: &'static str,
    before: (String, String),
    after: (String, String),
    fingerprint_before: BTreeMap<&'static str, String>,
    fingerprint_after: BTreeMap<&'static str, String>,
    changed: Vec<&'static str>,
}

fn evidence(name: &'static str, root: &Path, before: (String, String), fp_before: BTreeMap<&'static str, String>) -> Evidence {
    let after = diffs(root);
    let fp_after = fingerprint(root);
    let changed = fp_before.keys().filter(|k| fp_before.get(*k) != fp_after.get(*k)).copied().collect();
    let e = Evidence { name, before, after, fingerprint_before: fp_before, fingerprint_after: fp_after, changed };
    if let Ok(dir) = std::env::var("ORIS_HUNK_EVIDENCE") {
        let _ = fs::create_dir_all(&dir);
        let json = serde_json::json!({
            "scenario": e.name,
            "gitDiffBefore": e.before.0, "gitDiffCachedBefore": e.before.1,
            "gitDiffAfter": e.after.0, "gitDiffCachedAfter": e.after.1,
            "fingerprintBefore": e.fingerprint_before, "fingerprintAfter": e.fingerprint_after,
            "changedGroups": e.changed,
        });
        let _ = fs::write(Path::new(&dir).join(format!("{}.json", e.name)), serde_json::to_vec_pretty(&json).unwrap());
    }
    e
}

fn numbered(n: usize, edit: impl Fn(usize) -> Option<String>) -> String {
    (1..=n).map(|i| edit(i).unwrap_or_else(|| format!("line {i}")) + "\n").collect()
}

fn hunk_ref(map: &HunkMap, index: usize) -> HunkRef {
    map.hunks[index].clone()
}

#[test]
fn b15_stage_unstage_and_discard_move_only_the_target_hunk() {
    let dir = init();
    let p = dir.path();
    write(p, "a.txt", numbered(24, |_| None).as_bytes());
    commit_all(p);
    // 三块：第 3 行、第 9 行与相邻的第 11 行（中间只隔一行未变化），外加第 20 行后插入两行
    let edited = numbered(24, |i| match i {
        3 => Some("line 3 changed".into()),
        9 => Some("line 9 changed".into()),
        11 => Some("line 11 changed".into()),
        20 => Some("line 20\ninserted a\ninserted b".into()),
        _ => None,
    });
    write(p, "a.txt", edited.as_bytes());
    let h = Harness::new(p);
    let map = h.map(CompareScope::Unstaged, "a.txt");
    assert!(map.blocked.is_none(), "{:?}", map.blocked);
    assert_eq!(map.hunks.len(), 4, "相邻块（第 9、11 行）在 -U0 中是两块");
    let all = bodies(&diffs(p).0);

    // 1. 暂存第 3 块（第 11 行，与第 9 行相邻）
    let (before, fp) = (diffs(p), fingerprint(p));
    let outcome = h.run(OperationRequest::HunkStage { path_id: id("a.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 2) }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let e = evidence("stage-adjacent-hunk", p, before, fp);
    assert_eq!(bodies(&e.after.1), vec![all[2].clone()], "已暂存范围只有目标块");
    assert_eq!(bodies(&e.after.0), vec![all[0].clone(), all[1].clone(), all[3].clone()], "未暂存范围少了目标块");
    assert_eq!(e.changed, vec!["index"], "只改 index");
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), edited, "工作区不变");

    // 2. 取消暂存该块：回到三块未暂存 + 0 块已暂存之前的状态
    let staged_map = h.map(CompareScope::Staged, "a.txt");
    assert_eq!(staged_map.hunks.len(), 1);
    let (before, fp) = (diffs(p), fingerprint(p));
    let outcome = h.run(OperationRequest::HunkUnstage { path_id: id("a.txt"), content_ids: staged_map.content_ids.clone(), hunk: hunk_ref(&staged_map, 0) }, CompareScope::Staged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let e = evidence("unstage-hunk", p, before, fp);
    assert!(e.after.1.is_empty(), "已暂存范围为空");
    assert_eq!(bodies(&e.after.0), all, "四块都回到未暂存");
    assert_eq!(e.changed, vec!["index"]);

    // 3. 丢弃最后一块（插入的两行）：工作区只还原这一块；备份可撤销
    let map = h.map(CompareScope::Unstaged, "a.txt");
    let (before, fp) = (diffs(p), fingerprint(p));
    let index_before = index_entries(p);
    let outcome = h.run(OperationRequest::HunkDiscard { path_id: id("a.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 3), confirmed_unrecoverable: false }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let backup = outcome.backup.clone().expect("丢弃块有备份");
    let e = evidence("discard-hunk", p, before, fp);
    assert_eq!(bodies(&e.after.0), all[..3].to_vec(), "只丢弃目标块");
    assert!(e.after.1.is_empty());
    assert!(e.changed.iter().all(|g| *g == "worktree" || *g == "index"), "{:?}", e.changed);
    assert_eq!(index_entries(p), index_before, "丢弃不改 index 内容（只允许 stat 缓存回写）");
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), numbered(24, |i| match i { 3 => Some("line 3 changed".into()), 9 => Some("line 9 changed".into()), 11 => Some("line 11 changed".into()), _ => None }));
    // 撤销丢弃：整个文件回到丢弃前
    let outcome = h.run(OperationRequest::UndoDiscard { backup_id: backup.id, overwrite: false }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), edited, "撤销后恢复丢弃前的内容");
}

#[test]
fn b15_crlf_final_newline_and_non_utf8_hunks_keep_raw_bytes() {
    let dir = init();
    let p = dir.path();
    write(p, "crlf.txt", b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\n");
    write(p, "tail.txt", b"a\nb\nc\nd\ne\nf\ng\nlast");
    write(p, "latin1.txt", b"caf\xe9 1\nplain 2\nplain 3\nplain 4\nplain 5\nplain 6\nna\xefve 7\n");
    commit_all(p);
    write(p, "crlf.txt", b"one\r\nTWO\r\nthree\r\nfour\r\nfive\r\nSIX\r\nseven\r\n");
    write(p, "tail.txt", b"a\nB\nc\nd\ne\nf\ng\nlast changed");
    write(p, "latin1.txt", b"caf\xe9 1 \xa9\nplain 2\nplain 3\nplain 4\nplain 5\nplain 6\nna\xefve 7 \xae\n");
    let h = Harness::new(p);

    // CRLF：暂存第 2 块，index 中该行保留 CRLF
    let map = h.map(CompareScope::Unstaged, "crlf.txt");
    assert_eq!(map.hunks.len(), 2);
    let (before, fp) = (diffs(p), fingerprint(p));
    let outcome = h.run(OperationRequest::HunkStage { path_id: id("crlf.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 1) }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let e = evidence("crlf-stage-hunk", p, before, fp);
    assert_eq!(git_raw(p, &["show", ":crlf.txt"]), b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nSIX\r\nseven\r\n");
    assert_eq!(bodies(&diffs_path(p, "crlf.txt").0).len(), 1, "crlf.txt 只剩一块未暂存");
    assert_eq!(bodies(&diffs_path(p, "crlf.txt").1).len(), 1, "crlf.txt 已暂存一块");
    assert_eq!(e.changed, vec!["index"]);

    // 末尾无换行：暂存最后一块（“last” → “last changed”，两侧都没有末尾换行）
    let map = h.map(CompareScope::Unstaged, "tail.txt");
    assert_eq!(map.hunks.len(), 2);
    let (before, fp) = (diffs(p), fingerprint(p));
    let outcome = h.run(OperationRequest::HunkStage { path_id: id("tail.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 1) }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let e = evidence("no-final-newline-stage-hunk", p, before, fp);
    assert_eq!(git_raw(p, &["show", ":tail.txt"]), b"a\nb\nc\nd\ne\nf\ng\nlast changed");
    assert_eq!(e.changed, vec!["index"]);
    // 丢弃另一块，末尾无换行的最后一行保持原样
    let map = h.map(CompareScope::Unstaged, "tail.txt");
    let outcome = h.run(OperationRequest::HunkDiscard { path_id: id("tail.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 0), confirmed_unrecoverable: false }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(fs::read(p.join("tail.txt")).unwrap(), b"a\nb\nc\nd\ne\nf\ng\nlast changed");

    // 非 UTF-8：暂存最后一块，index 中是原始字节
    let map = h.map(CompareScope::Unstaged, "latin1.txt");
    assert_eq!(map.hunks.len(), 2);
    let (before, fp) = (diffs(p), fingerprint(p));
    let outcome = h.run(OperationRequest::HunkStage { path_id: id("latin1.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 1) }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let e = evidence("non-utf8-stage-hunk", p, before, fp);
    assert_eq!(git_raw(p, &["show", ":latin1.txt"]), b"caf\xe9 1\nplain 2\nplain 3\nplain 4\nplain 5\nplain 6\nna\xefve 7 \xae\n");
    assert_eq!(e.changed, vec!["index"]);
}

#[test]
fn b15_final_newline_only_hunk_can_be_staged() {
    let dir = init();
    let p = dir.path();
    write(p, "f.txt", b"x\ny\n");
    commit_all(p);
    write(p, "f.txt", b"x\ny");
    let h = Harness::new(p);
    let map = h.map(CompareScope::Unstaged, "f.txt");
    assert_eq!(map.hunks.len(), 1);
    assert_eq!((map.hunks[0].old_start, map.hunks[0].old_end, map.hunks[0].new_start, map.hunks[0].new_end), (1, 2, 1, 2));
    let outcome = h.run(OperationRequest::HunkStage { path_id: id("f.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 0) }, CompareScope::Unstaged).unwrap();
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(git_raw(p, &["show", ":f.txt"]), b"x\ny");
}

#[test]
fn b15_modified_after_display_is_rejected_without_changes() {
    let dir = init();
    let p = dir.path();
    write(p, "a.txt", numbered(10, |_| None).as_bytes());
    commit_all(p);
    write(p, "a.txt", numbered(10, |i| (i == 2).then(|| "two".into())).as_bytes());
    let h = Harness::new(p);
    let map = h.map(CompareScope::Unstaged, "a.txt");
    // 显示之后，外部又改了文件（另一行）
    write(p, "a.txt", numbered(10, |i| match i { 2 => Some("two".into()), 8 => Some("eight".into()), _ => None }).as_bytes());
    let (before, fp) = (diffs(p), fingerprint(p));
    let index_before = index_entries(p);
    for request in [
        OperationRequest::HunkStage { path_id: id("a.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 0) },
        OperationRequest::HunkDiscard { path_id: id("a.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 0), confirmed_unrecoverable: false },
    ] {
        let outcome = h.run(request, CompareScope::Unstaged).unwrap();
        assert_eq!(outcome.status, OpStatus::Failed);
        assert!(outcome.message.contains("显示之后已被修改"), "{}", outcome.message);
        assert!(outcome.snapshot.is_some(), "拒绝后返回刷新的快照");
    }
    let e = evidence("modified-after-display-rejected", p, before, fp);
    assert_eq!(e.before, e.after, "git diff / --cached 不变");
    assert_eq!(index_entries(p), index_before, "index 内容不变（只允许 stat 缓存回写）");
    assert!(e.changed.iter().all(|g| *g == "index"), "{:?}", e.changed);
    assert!(h.store.list(h.adapter.repo_id()).is_empty(), "被拒绝的丢弃没有留下备份记录");
}

#[test]
fn b15_disabled_conditions_have_reasons() {
    let dir = init();
    let p = dir.path();
    write(p, "text.txt", b"a\nb\n");
    write(p, "bin.dat", b"\x00\x01\x02");
    write(p, "mode.sh", b"echo\n");
    write(p, "big.txt", &vec![b'x'; MAX_TEXT_BYTES + 10]);
    commit_all(p);
    write(p, "text.txt", b"a\nB\n");
    write(p, "bin.dat", b"\x00\x09\x02");
    git_raw(p, &["update-index", "--chmod=+x", "mode.sh"]);
    write(p, "big.txt", &vec![b'y'; MAX_TEXT_BYTES + 10]);
    write(p, "new.txt", b"new\n");
    git_raw(p, &["add", "new.txt"]);
    let h = Harness::new(p);
    let reason = |scope, path: &str| h.map(scope, path).blocked.unwrap_or_default();
    assert!(reason(CompareScope::All, "text.txt").contains("“全部”范围"));
    assert!(reason(CompareScope::Unstaged, "bin.dat").contains("二进制"));
    assert!(reason(CompareScope::Staged, "mode.sh").contains("只有文件模式变化"));
    assert!(reason(CompareScope::Unstaged, "big.txt").contains("超出内容预算"));
    assert!(reason(CompareScope::Staged, "new.txt").contains("文件级操作"));
    assert!(h.map(CompareScope::Unstaged, "text.txt").blocked.is_none());
    // 读取块映射不改动仓库（B17）
    let fp = fingerprint(p);
    let index_before = index_entries(p);
    let _ = h.map(CompareScope::Unstaged, "text.txt");
    let _ = h.map(CompareScope::Staged, "mode.sh");
    assert_eq!(fingerprint(p).get("worktree"), fp.get("worktree"));
    assert_eq!(fingerprint(p).get("refs"), fp.get("refs"));
    assert_eq!(fingerprint(p).get("config"), fp.get("config"));
    assert_eq!(index_entries(p), index_before);
}

#[test]
fn b15_conflict_and_submodule_are_disabled() {
    let dir = init();
    let p = dir.path();
    write(p, "c.txt", b"base\n");
    commit_all(p);
    git_raw(p, &["switch", "-q", "-c", "other"]);
    write(p, "c.txt", b"theirs\n");
    git_raw(p, &["commit", "-qam", "theirs"]);
    git_raw(p, &["switch", "-q", "main"]);
    write(p, "c.txt", b"ours\n");
    git_raw(p, &["commit", "-qam", "ours"]);
    let _ = Command::new("git").arg("-C").arg(p).args(["merge", "-q", "other"]).output();
    let h = Harness::new(p);
    assert!(h.map(CompareScope::Unstaged, "c.txt").blocked.unwrap().contains("冲突"));

    let sub = init();
    write(sub.path(), "s.txt", b"1\n");
    commit_all(sub.path());
    let first = String::from_utf8(git_raw(sub.path(), &["rev-parse", "HEAD"])).unwrap().trim().to_owned();
    write(sub.path(), "s.txt", b"2\n");
    git_raw(sub.path(), &["commit", "-qam", "2"]);
    let second = String::from_utf8(git_raw(sub.path(), &["rev-parse", "HEAD"])).unwrap().trim().to_owned();
    let dir = init();
    let q = dir.path();
    write(q, "r.txt", b"r\n");
    git_raw(q, &["add", "r.txt"]);
    git_raw(q, &["update-index", "--add", "--cacheinfo", &format!("160000,{first},mod")]);
    git_raw(q, &["commit", "-qm", "gitlink"]);
    git_raw(q, &["update-index", "--cacheinfo", &format!("160000,{second},mod")]);
    let h = Harness::new(q);
    assert!(h.map(CompareScope::Staged, "mod").blocked.unwrap().contains("子模块"));
}

#[test]
fn b16_external_index_lock_blocks_hunk_ops_without_retry_or_removal() {
    let dir = init();
    let p = dir.path();
    write(p, "a.txt", b"1\n2\n3\n");
    commit_all(p);
    write(p, "a.txt", b"1\nX\n3\n");
    let h = Harness::new(p);
    let map = h.map(CompareScope::Unstaged, "a.txt");
    fs::write(p.join(".git/index.lock"), b"").unwrap();
    let fp = fingerprint(p);
    let result = h.run(OperationRequest::HunkStage { path_id: id("a.txt"), content_ids: map.content_ids.clone(), hunk: hunk_ref(&map, 0) }, CompareScope::Unstaged);
    assert!(matches!(result, Err(GitError::ExternalLock(_))), "{result:?}");
    assert!(p.join(".git/index.lock").exists(), "不删除外部锁");
    assert_eq!(fingerprint(p), fp, "没有任何改动（也没有重试）");
    fs::remove_file(p.join(".git/index.lock")).unwrap();
}
