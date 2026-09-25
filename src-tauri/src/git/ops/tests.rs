//! V2-02 验收测试：B05–B08、B16、B17 与写通道安全。全部在临时仓库中进行，
//! 每个写操作都比较操作前后的 index / HEAD 与 refs / config / 工作区。
use super::process::CancelHandle;
use super::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    output.stdout
}

fn git_text(root: &Path, args: &[&str]) -> String {
    String::from_utf8_lossy(&git(root, args)).trim().to_owned()
}

fn init() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git(p, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.name", "Ops"), ("user.email", "ops@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        git(p, &["config", key, value]);
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

fn adapter(root: &Path) -> GitAdapter {
    GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap()
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
        Self { adapter: adapter(root), store: BackupStore::new(backups.path().join("discard-backups")), _backups: backups }
    }
    fn try_run(&self, request: OperationRequest) -> Result<OperationOutcome, GitError> {
        self.try_run_with(request, Arc::new(CancelHandle::default()), &|_| {})
    }
    fn try_run_with(&self, request: OperationRequest, cancel: Arc<CancelHandle>, sink: &(dyn Fn(&str) + Sync)) -> Result<OperationOutcome, GitError> {
        let ctx = OpContext::new(format!("op-{}-{}", std::process::id(), OPS.fetch_add(1, Ordering::SeqCst)), cancel, &self.store, sink);
        self.adapter.run_operation(request, CompareScope::Unstaged, &ctx)
    }
    fn run(&self, request: OperationRequest) -> OperationOutcome {
        self.try_run(request).unwrap()
    }
}

/// 仓库状态指纹：分为 index、HEAD 与 refs、config、工作区（不含 .git/objects 与 .git/logs）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint(BTreeMap<String, String>);

fn fingerprint(root: &Path) -> Fingerprint {
    let mut entries = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if rel == ".git/objects" || rel == ".git/logs" || rel.starts_with(".git/hooks") {
                continue;
            }
            if entry.file_type().unwrap().is_dir() {
                stack.push(path);
            } else if !matches!(rel.as_str(), ".git/COMMIT_EDITMSG" | ".git/ORIG_HEAD") {
                entries.insert(rel, hash_bytes(&fs::read(&path).unwrap()));
            }
        }
    }
    Fingerprint(entries)
}

/// 变化的类别：index / refs（HEAD、refs/、packed-refs）/ config / worktree。
fn changed(before: &Fingerprint, after: &Fingerprint) -> Vec<&'static str> {
    let mut kinds = std::collections::BTreeSet::new();
    for key in before.0.keys().chain(after.0.keys()) {
        if before.0.get(key) == after.0.get(key) {
            continue;
        }
        kinds.insert(if key == ".git/index" {
            "index"
        } else if key == ".git/HEAD" || key.starts_with(".git/refs/") || key == ".git/packed-refs" {
            "refs"
        } else if key == ".git/config" {
            "config"
        } else if key.starts_with(".git/") {
            "git-other"
        } else {
            "worktree"
        });
    }
    kinds.into_iter().collect()
}

fn staged_names(root: &Path) -> String {
    git_text(root, &["-c", "core.quotepath=false", "diff", "--cached", "--name-status", "-M"])
}

fn base_repo() -> tempfile::TempDir {
    let dir = init();
    let p = dir.path();
    write(p, "a.txt", b"a\n");
    write(p, "del.txt", b"delete me\n");
    write(p, "old-name.txt", b"rename me, with enough shared content to pair\nline 2\nline 3\n");
    write(p, "空 格/中文 #[x].txt", b"special\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    dir
}

#[test]
fn ai_commit_selected_preserves_other_staged_files_and_includes_full_selected_files() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"staged version\n");
    git(p, &["add", "a.txt"]);
    write(p, "a.txt", b"working version\n");
    write(p, "del.txt", b"unrelated staged\n");
    git(p, &["add", "del.txt"]);
    write(p, "new.txt", b"new file\n");
    let h = Harness::new(p);
    let context = h.adapter.ai_context(false).unwrap();
    assert!(context.candidates.iter().any(|file| file.path_id == id("new.txt")));
    assert!(context.text.contains("working version") && context.text.contains("new file"));
    let revision = h.adapter.scan(false).unwrap().revision.clone();
    let result = h.run(OperationRequest::CommitSelected { message: "AI commit".into(), path_ids: vec![id("a.txt"), id("new.txt")], expected_revision: revision });
    assert_eq!(result.status, OpStatus::Succeeded, "{}", result.message);
    assert_eq!(git_text(p, &["show", "HEAD:a.txt"]), "working version");
    assert_eq!(git_text(p, &["show", "HEAD:new.txt"]), "new file");
    assert_eq!(staged_names(p), "M\tdel.txt");
    assert_eq!(git_text(p, &["diff", "--name-only"]), "");
}

#[test]
fn ai_commit_selected_rejects_stale_plan_without_touching_index() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"first\n");
    let h = Harness::new(p);
    let revision = h.adapter.scan(false).unwrap().revision.clone();
    write(p, "a.txt", b"changed after planning\n");
    let before = fingerprint(p);
    let error = h.try_run(OperationRequest::CommitSelected { message: "AI commit".into(), path_ids: vec![id("a.txt")], expected_revision: revision }).unwrap_err();
    assert!(matches!(error, GitError::StaleRequest));
    assert_eq!(fingerprint(p), before);
}

// ------------------------------ B05 ------------------------------

#[test]
fn b05_stage_and_unstage_added_deleted_renamed_untracked_special_paths_in_batches() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"a changed\n");
    fs::remove_file(p.join("del.txt")).unwrap();
    fs::rename(p.join("old-name.txt"), p.join("new-name.txt")).unwrap();
    write(p, "空 格/中文 #[x].txt", b"special changed\n");
    write(p, "untracked file.txt", b"new\n");
    let h = Harness::new(p);
    let before = fingerprint(p);
    // 多选批量暂存：修改、删除、rename 两端（未暂存视角为删除 + 未跟踪）、特殊字符、未跟踪。
    let all = ["a.txt", "del.txt", "old-name.txt", "new-name.txt", "空 格/中文 #[x].txt", "untracked file.txt"];
    let outcome = h.run(OperationRequest::Stage { path_ids: all.iter().map(|p| id(p)).collect() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(outcome.git_processes, 1, "stage 只启动一次 add");
    assert_eq!(changed(&before, &fingerprint(p)), vec!["index"], "stage 只改 index");
    let staged = staged_names(p);
    for expected in ["M\ta.txt", "D\tdel.txt", "M\t空 格/中文 #[x].txt", "A\tuntracked file.txt"] {
        assert!(staged.contains(expected), "{expected} not in {staged}");
    }
    assert!(staged.contains("old-name.txt\tnew-name.txt"), "暂存后应识别为 rename：{staged}");
    let snapshot = outcome.snapshot.expect("操作结束后返回刷新后的快照");
    let lists = snapshot.scopes.unwrap();
    assert!(lists.unstaged.is_empty(), "全部暂存后未暂存范围为空");
    assert!(lists.staged.iter().any(|f| matches!(f.status, FileStatus::Renamed) && f.old_path_id.as_deref() == Some(id("old-name.txt").as_str())));
    // 取消暂存：rename 需同时给出原路径；其余多选。
    let staged_before = fingerprint(p);
    let outcome = h.run(OperationRequest::Unstage { path_ids: vec![id("new-name.txt"), id("old-name.txt"), id("a.txt"), id("空 格/中文 #[x].txt")] });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(changed(&staged_before, &fingerprint(p)), vec!["index"]);
    let staged = staged_names(p);
    assert!(!staged.contains("new-name.txt") && !staged.contains("a.txt") && !staged.contains("空 格"), "{staged}");
    assert!(staged.contains("D\tdel.txt") && staged.contains("A\tuntracked file.txt"));
    // 全部取消后 index 回到 HEAD，工作区内容始终未变。
    let outcome = h.run(OperationRequest::Unstage { path_ids: vec![id("del.txt"), id("untracked file.txt")] });
    assert_eq!(outcome.status, OpStatus::Succeeded);
    assert_eq!(staged_names(p), "");
    let after = fingerprint(p);
    let worktree = |f: &Fingerprint| f.0.iter().filter(|(k, _)| !k.starts_with(".git")).map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
    assert_eq!(worktree(&before), worktree(&after));
}

#[test]
fn b05_unstage_on_empty_head_removes_from_index_only() {
    let dir = init();
    let p = dir.path();
    write(p, "first.txt", b"first\n");
    write(p, "second.txt", b"second\n");
    git(p, &["add", "-A"]);
    write(p, "first.txt", b"first, edited after staging\n");
    let h = Harness::new(p);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::Unstage { path_ids: vec![id("first.txt")] });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(changed(&before, &fingerprint(p)), vec!["index"]);
    assert_eq!(git_text(p, &["ls-files"]), "second.txt");
    assert_eq!(fs::read(p.join("first.txt")).unwrap(), b"first, edited after staging\n");
    let lists = outcome.snapshot.unwrap().scopes.unwrap();
    assert!(lists.unstaged.iter().any(|f| f.display_path == "first.txt" && matches!(f.status, FileStatus::Untracked)));
}

#[test]
fn b05_failed_stage_reports_git_error_and_leaves_repository_unchanged() {
    let dir = base_repo();
    let p = dir.path();
    let h = Harness::new(p);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::Stage { path_ids: vec![id("missing/nowhere.txt")] });
    assert_eq!(outcome.status, OpStatus::Failed);
    assert!(outcome.message.contains("pathspec"), "{}", outcome.message);
    assert_eq!(outcome.git_processes, 1, "失败不重试");
    assert!(changed(&before, &fingerprint(p)).iter().all(|k| *k == "index"), "失败的 stage 最多留下 stat 回写");
    assert_eq!(staged_names(p), "");
    // 前端传入的越界路径被拒绝；形似选项的文件名经 stdin 传递，只作为字面路径，不会成为参数。
    for bad in ["../outside.txt", "C:/abs.txt", "/etc/passwd"] {
        assert!(matches!(h.try_run(OperationRequest::Stage { path_ids: vec![id(bad)] }), Err(GitError::UnsafePath)), "{bad}");
    }
    write(p, "--output=x", b"literal
");
    let outcome = h.run(OperationRequest::Stage { path_ids: vec![id("--output=x")] });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(staged_names(p), "A	--output=x");
}

#[test]
fn mark_resolved_warns_about_conflict_markers_before_staging() {
    let dir = init();
    let p = dir.path();
    write(p, "c.txt", b"base\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    git(p, &["switch", "-q", "-c", "theirs"]);
    write(p, "c.txt", b"theirs\n");
    git(p, &["commit", "-qam", "theirs"]);
    git(p, &["switch", "-q", "main"]);
    write(p, "c.txt", b"ours\n");
    git(p, &["commit", "-qam", "ours"]);
    let merge = Command::new("git").arg("-C").arg(p).args(["merge", "--no-edit", "theirs"]).output().unwrap();
    assert!(!merge.status.success());
    let h = Harness::new(p);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::MarkResolved { path_ids: vec![id("c.txt")], confirmed: false });
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation);
    assert_eq!(outcome.confirmation.as_ref().unwrap().reason, "conflictMarkers");
    assert_eq!(outcome.git_processes, 0);
    assert_eq!(before, fingerprint(p), "需要确认时不改动仓库");
    let outcome = h.run(OperationRequest::MarkResolved { path_ids: vec![id("c.txt")], confirmed: true });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(git_text(p, &["ls-files", "--unmerged"]), "");
    // 已解决（无标记）的文件直接暂存。
    write(p, "c.txt", b"resolved\n");
    let outcome = h.run(OperationRequest::MarkResolved { path_ids: vec![id("c.txt")], confirmed: false });
    assert_eq!(outcome.status, OpStatus::Succeeded);
}

// ------------------------------ B06 ------------------------------

#[test]
fn b06_discard_unstaged_tracked_and_untracked_then_undo_restores_exact_bytes() {
    let dir = base_repo();
    let p = dir.path();
    // 用系统配置的 autocrlf=true：备份与恢复必须是原始字节，不经过 filter。
    git(p, &["config", "core.autocrlf", "true"]);
    write(p, "a.txt", b"worktree edit\r\nwith CRLF\r\n");
    write(p, "fresh/dir/untracked.bin", &[0, 159, 146, 150, 13, 10, 255]);
    fs::remove_file(p.join("del.txt")).unwrap();
    let h = Harness::new(p);
    let plan = h.adapter.prepare_discard(CompareScope::Unstaged, &[id("a.txt"), id("fresh/dir/untracked.bin"), id("del.txt")]).unwrap();
    assert_eq!((plan.files, plan.untracked, plan.unrecoverable.len(), plan.blocked.len()), (3, 1, 0, 0));
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::Discard { scope: CompareScope::Unstaged, path_ids: vec![id("a.txt"), id("fresh/dir/untracked.bin"), id("del.txt")], confirmed_unrecoverable: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let kinds = changed(&before, &fingerprint(p));
    assert!(kinds.contains(&"worktree") && !kinds.contains(&"refs") && !kinds.contains(&"config"), "{kinds:?}");
    assert!(!p.join("fresh").exists(), "未跟踪文件删除后，变空的目录一并清理");
    assert!(p.join("del.txt").exists());
    assert_eq!(git_text(p, &["status", "--porcelain"]), "");
    let backup = outcome.backup.unwrap();
    assert_eq!(backup.files, 3);
    assert_eq!(h.adapter.discard_backups(&h.store).len(), 1);
    // 撤销：工作区逐字节恢复（包括删除状态）。
    let outcome = h.run(OperationRequest::UndoDiscard { backup_id: backup.id.clone(), overwrite: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(fs::read(p.join("a.txt")).unwrap(), b"worktree edit\r\nwith CRLF\r\n");
    assert_eq!(fs::read(p.join("fresh/dir/untracked.bin")).unwrap(), [0, 159, 146, 150, 13, 10, 255]);
    assert!(!p.join("del.txt").exists());
    let restored = fingerprint(p);
    let worktree = |f: &Fingerprint| f.0.iter().filter(|(k, _)| !k.starts_with(".git")).map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
    assert_eq!(worktree(&before), worktree(&restored));
    assert!(h.adapter.discard_backups(&h.store).is_empty(), "撤销后记录移除，不能重复撤销");
}

#[test]
fn b06_discard_all_scope_restores_head_and_undo_restores_index_and_worktree() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"staged\n");
    git(p, &["add", "a.txt"]);
    write(p, "a.txt", b"staged, then edited\n");
    write(p, "added.txt", b"added in index\n");
    git(p, &["add", "added.txt"]);
    git(p, &["mv", "old-name.txt", "moved.txt"]);
    git(p, &["rm", "-q", "del.txt"]);
    write(p, "untracked.txt", b"u\n");
    let h = Harness::new(p);
    let index_before = git(p, &["ls-files", "-s"]);
    let before = fingerprint(p);
    let ids = vec![id("a.txt"), id("added.txt"), id("moved.txt"), id("old-name.txt"), id("del.txt"), id("untracked.txt")];
    let plan = h.adapter.prepare_discard(CompareScope::All, &ids).unwrap();
    assert_eq!((plan.files, plan.untracked), (6, 1), "{plan:?}");
    let outcome = h.run(OperationRequest::Discard { scope: CompareScope::All, path_ids: ids, confirmed_unrecoverable: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(git_text(p, &["status", "--porcelain", "--untracked-files=all"]), "", "“全部”范围丢弃后 index 与工作区都回到 HEAD");
    assert!(!p.join("added.txt").exists() && !p.join("moved.txt").exists() && p.join("old-name.txt").exists());
    let undo = h.run(OperationRequest::UndoDiscard { backup_id: outcome.backup.unwrap().id, overwrite: false });
    assert_eq!(undo.status, OpStatus::Succeeded, "{}", undo.message);
    assert_eq!(git(p, &["ls-files", "-s"]), index_before, "暂存内容恢复");
    let after = fingerprint(p);
    let worktree = |f: &Fingerprint| f.0.iter().filter(|(k, _)| !k.starts_with(".git")).map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
    assert_eq!(worktree(&before), worktree(&after), "工作区恢复");
    assert!(!changed(&before, &after).contains(&"refs"));
}

#[test]
fn b06_undo_asks_again_when_file_changed_after_discard() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"precious edit\n");
    let h = Harness::new(p);
    let outcome = h.run(OperationRequest::Discard { scope: CompareScope::Unstaged, path_ids: vec![id("a.txt")], confirmed_unrecoverable: false });
    let backup = outcome.backup.unwrap().id;
    write(p, "a.txt", b"edited again after discard\n");
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::UndoDiscard { backup_id: backup.clone(), overwrite: false });
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation);
    assert_eq!(outcome.confirmation.unwrap().reason, "modifiedSinceDiscard");
    assert_eq!(before, fingerprint(p));
    let outcome = h.run(OperationRequest::UndoDiscard { backup_id: backup, overwrite: true });
    assert_eq!(outcome.status, OpStatus::Succeeded);
    assert_eq!(fs::read(p.join("a.txt")).unwrap(), b"precious edit\n");
}

#[test]
fn b06_file_over_backup_budget_requires_unrecoverable_confirmation() {
    let dir = base_repo();
    let p = dir.path();
    let big = vec![b'x'; (discard::BACKUP_FILE_LIMIT + 1) as usize];
    write(p, "big.log.txt", &big);
    write(p, "small.txt", b"small\n");
    let h = Harness::new(p);
    let ids = vec![id("big.log.txt"), id("small.txt")];
    let plan = h.adapter.prepare_discard(CompareScope::Unstaged, &ids).unwrap();
    assert_eq!(plan.unrecoverable, vec!["big.log.txt".to_owned()]);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::Discard { scope: CompareScope::Unstaged, path_ids: ids.clone(), confirmed_unrecoverable: false });
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation);
    assert_eq!(outcome.confirmation.as_ref().unwrap().reason, "unrecoverable");
    assert_eq!(before, fingerprint(p));
    let outcome = h.run(OperationRequest::Discard { scope: CompareScope::Unstaged, path_ids: ids, confirmed_unrecoverable: true });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let backup = outcome.backup.unwrap();
    assert_eq!(backup.unrecoverable, 1);
    assert!(!p.join("big.log.txt").exists());
    let undo = h.run(OperationRequest::UndoDiscard { backup_id: backup.id, overwrite: false });
    assert_eq!(undo.status, OpStatus::Succeeded);
    assert!(undo.message.contains("big.log.txt"), "{}", undo.message);
    assert_eq!(fs::read(p.join("small.txt")).unwrap(), b"small\n");
    assert!(!p.join("big.log.txt").exists());
}

#[test]
fn b06_gitlink_and_conflicts_cannot_be_discarded() {
    let dir = base_repo();
    let p = dir.path();
    let sub = p.join("sub");
    fs::create_dir_all(&sub).unwrap();
    git(&sub, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.name", "Sub"), ("user.email", "sub@example.invalid"), ("commit.gpgsign", "false")] {
        git(&sub, &["config", key, value]);
    }
    write(&sub, "s.txt", b"1\n");
    git(&sub, &["add", "-A"]);
    git(&sub, &["commit", "-qm", "s1"]);
    git(p, &["add", "sub"]);
    git(p, &["commit", "-qm", "gitlink"]);
    write(&sub, "s.txt", b"2\n");
    git(&sub, &["commit", "-qam", "s2"]);
    let h = Harness::new(p);
    let snapshot = h.adapter.snapshot_v2("s".into(), CompareScope::Unstaged, false).unwrap();
    assert!(snapshot.files.iter().any(|f| f.display_path == "sub" && f.gitlink), "列表把 gitlink 标出来，界面据此禁用丢弃");
    let plan = h.adapter.prepare_discard(CompareScope::Unstaged, &[id("sub")]).unwrap();
    assert_eq!(plan.files, 0);
    assert!(plan.blocked[0].reason.contains("gitlink"));
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::Discard { scope: CompareScope::Unstaged, path_ids: vec![id("sub")], confirmed_unrecoverable: false });
    assert_eq!(outcome.status, OpStatus::Failed);
    assert_eq!(outcome.git_processes, 0);
    assert!(changed(&before, &fingerprint(p)).iter().all(|k| *k == "index"));
    assert!(matches!(h.try_run(OperationRequest::Discard { scope: CompareScope::Staged, path_ids: vec![id("a.txt")], confirmed_unrecoverable: false }), Err(GitError::WriteBlocked(_))), "已暂存范围不提供丢弃");
}

#[test]
fn b06_undo_reports_pruned_backup_objects_clearly() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "scratch.txt", b"unique scratch content 8c1f\n");
    let h = Harness::new(p);
    let outcome = h.run(OperationRequest::Discard { scope: CompareScope::Unstaged, path_ids: vec![id("scratch.txt")], confirmed_unrecoverable: false });
    let backup = outcome.backup.unwrap().id;
    git(p, &["prune", "--expire=now"]);
    let outcome = h.run(OperationRequest::UndoDiscard { backup_id: backup, overwrite: false });
    assert_eq!(outcome.status, OpStatus::Failed);
    assert!(outcome.message.contains("gc") && outcome.message.contains("scratch.txt"), "{}", outcome.message);
    assert!(!p.join("scratch.txt").exists());
}

// ------------------------------ B07 ------------------------------

#[test]
fn b07_commit_and_undo_normal_merge_root() {
    let dir = init();
    let p = dir.path();
    write(p, "root.txt", b"root\n");
    git(p, &["add", "-A"]);
    let h = Harness::new(p);
    // 根提交：多行信息、Unicode 与特殊字符原样写入。
    let message = "初始提交: \"quotes\" & $dollar\n\n正文第一行\n- 列表项";
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::Commit { message: message.into() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let kinds = changed(&before, &fingerprint(p));
    assert!(kinds.contains(&"refs") && !kinds.contains(&"worktree") && !kinds.contains(&"config"), "{kinds:?}");
    assert_eq!(git_text(p, &["log", "-1", "--format=%B"]), message);
    let root = git_text(p, &["rev-parse", "HEAD"]);
    let branch = outcome.snapshot.as_ref().unwrap().branch_info.clone().unwrap();
    assert_eq!(branch.oid.as_deref(), Some(root.as_str()), "快照中的分支状态已刷新");
    // 没有暂存内容时 commit 失败且不生成提交。
    let outcome = h.run(OperationRequest::Commit { message: "empty".into() });
    assert_eq!(outcome.status, OpStatus::Failed);
    assert_eq!(git_text(p, &["rev-parse", "HEAD"]), root);
    // 第二个提交；提交信息为空时拒绝且不生成提交。
    write(p, "two.txt", b"two
");
    write(p, "three.txt", b"three
");
    git(p, &["add", "-A"]);
    let outcome = h.run(OperationRequest::Commit { message: "  
".into() });
    assert_eq!(outcome.status, OpStatus::Failed);
    assert_eq!(git_text(p, &["rev-parse", "HEAD"]), root);
    h.run(OperationRequest::Commit { message: "second".into() });
    let info = h.adapter.head_commit_info().unwrap().unwrap();
    assert_eq!((info.message.as_str(), info.parents.len(), info.pushed), ("second", 1, None));
    // 撤销普通提交：HEAD 回到父提交，改动回到暂存区，工作区不变。
    let head = git_text(p, &["rev-parse", "HEAD"]);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::UndoCommit { expected_head: head.clone() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(git_text(p, &["rev-parse", "HEAD"]), root);
    assert!(staged_names(p).contains("two.txt") && staged_names(p).contains("three.txt"));
    let kinds = changed(&before, &fingerprint(p));
    assert!(kinds.contains(&"refs") && !kinds.contains(&"worktree"), "{kinds:?}");
    // 合并提交：回到第一个父提交。
    git(p, &["-c", "commit.gpgsign=false", "commit", "-qm", "main work"]);
    let first_parent = git_text(p, &["rev-parse", "HEAD"]);
    git(p, &["switch", "-q", "-c", "side", "HEAD~1"]);
    write(p, "side.txt", b"side\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "side"]);
    git(p, &["switch", "-q", "main"]);
    git(p, &["merge", "-q", "--no-ff", "--no-edit", "side"]);
    let merge = git_text(p, &["rev-parse", "HEAD"]);
    assert_eq!(h.adapter.head_commit_info().unwrap().unwrap().parents.len(), 2);
    let outcome = h.run(OperationRequest::UndoCommit { expected_head: merge });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("第一个父提交"));
    assert_eq!(git_text(p, &["rev-parse", "HEAD"]), first_parent);
    assert!(staged_names(p).contains("side.txt"));
    // 根提交：仓库回到无提交状态，文件保留在暂存区。
    git(p, &["reset", "-q", "--hard", &root]);
    let outcome = h.run(OperationRequest::UndoCommit { expected_head: root });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(h.adapter.head_oid().unwrap().is_none(), "HEAD 变为 unborn");
    assert_eq!(git_text(p, &["ls-files"]), "root.txt");
    assert!(p.join("root.txt").exists());
}

#[test]
fn b07_pushed_head_blocks_undo() {
    let dir = base_repo();
    let p = dir.path();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
    git(p, &["push", "-q", "-u", "origin", "main"]);
    let h = Harness::new(p);
    let head = git_text(p, &["rev-parse", "HEAD"]);
    let info = h.adapter.head_commit_info().unwrap().unwrap();
    assert_eq!(info.pushed, Some(true));
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    let before = fingerprint(p);
    assert!(matches!(h.try_run(OperationRequest::UndoCommit { expected_head: head }), Err(GitError::WriteBlocked(m)) if m.contains("origin/main")));
    assert_eq!(before, fingerprint(p), "被拒绝的操作不改动仓库");
    // 本地新提交（领先 1）可以撤销。
    write(p, "local.txt", b"local\n");
    git(p, &["add", "-A"]);
    let outcome = h.run(OperationRequest::Commit { message: "local".into() });
    assert_eq!(outcome.snapshot.unwrap().branch_info.unwrap().ahead, Some(1), "领先计数刷新");
    assert_eq!(h.adapter.head_commit_info().unwrap().unwrap().pushed, Some(false));
    let head = git_text(p, &["rev-parse", "HEAD"]);
    assert_eq!(h.run(OperationRequest::UndoCommit { expected_head: head }).status, OpStatus::Succeeded);
}

// ------------------------------ B08 ------------------------------

fn hook(root: &Path, name: &str, body: &str) {
    let path = root.join(".git/hooks").join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn b08_failing_pre_commit_hook_output_is_shown_and_no_commit_is_created() {
    let dir = base_repo();
    let p = dir.path();
    hook(p, "pre-commit", "echo 'HOOK-FAIL-MARKER: lint failed' >&2\necho 'second line'\nexit 1");
    write(p, "a.txt", b"change\n");
    git(p, &["add", "a.txt"]);
    let h = Harness::new(p);
    let head = git_text(p, &["rev-parse", "HEAD"]);
    let lines = Mutex::new(Vec::new());
    let sink = |line: &str| lines.lock().unwrap().push(line.to_owned());
    let outcome = h.try_run_with(OperationRequest::Commit { message: "blocked".into() }, Arc::new(CancelHandle::default()), &sink).unwrap();
    assert_eq!(outcome.status, OpStatus::Failed);
    assert!(outcome.output.contains("HOOK-FAIL-MARKER") && outcome.output.contains("second line"), "{}", outcome.output);
    assert!(outcome.message.contains("没有生成提交"), "{}", outcome.message);
    assert!(lines.lock().unwrap().iter().any(|l| l.contains("HOOK-FAIL-MARKER")), "输出实时转发给界面");
    assert_eq!(git_text(p, &["rev-parse", "HEAD"]), head);
    assert!(staged_names(p).contains("a.txt"), "暂存内容保留");
}

#[test]
fn b08_cancel_running_hook_terminates_the_whole_process_tree() {
    let dir = base_repo();
    let p = dir.path();
    let marker = p.join(".git/hook-finished");
    let started = p.join(".git/hook-started");
    hook(p, "pre-commit", &format!("echo started > '{}'\nsleep 4\necho finished > '{}'", started.to_string_lossy().replace('\\', "/"), marker.to_string_lossy().replace('\\', "/")));
    write(p, "a.txt", b"change\n");
    git(p, &["add", "a.txt"]);
    let head = git_text(p, &["rev-parse", "HEAD"]);
    let h = Harness::new(p);
    let cancel = Arc::new(CancelHandle::default());
    let canceller = {
        let cancel = cancel.clone();
        let started = started.clone();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while !started.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            std::thread::sleep(Duration::from_millis(200));
            let at = std::time::Instant::now();
            cancel.cancel();
            at
        })
    };
    let outcome = h.try_run_with(OperationRequest::Commit { message: "cancel me".into() }, cancel, &|_| {}).unwrap();
    let cancelled_at = canceller.join().unwrap();
    let returned_after = cancelled_at.elapsed();
    assert_eq!(outcome.status, OpStatus::Cancelled, "{}", outcome.message);
    assert!(outcome.message.contains("没有生成提交"), "{}", outcome.message);
    assert!(returned_after < Duration::from_secs(3), "取消后应很快返回（实际 {returned_after:?}）");
    std::thread::sleep(Duration::from_secs(5));
    assert!(!marker.exists(), "hook 的子进程（sleep 之后的写入）在取消后没有继续运行");
    assert_eq!(git_text(p, &["rev-parse", "HEAD"]), head);
    println!("B08_CANCEL returned_after_ms={}", returned_after.as_millis());
}

#[test]
fn b08_signing_follows_git_config_or_fails_with_clear_error() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"signed change\n");
    git(p, &["add", "a.txt"]);
    let h = Harness::new(p);
    let head = git_text(p, &["rev-parse", "HEAD"]);
    git(p, &["config", "commit.gpgsign", "true"]);
    git(p, &["config", "gpg.program", &p.join("no-such-gpg.exe").to_string_lossy()]);
    let outcome = h.run(OperationRequest::Commit { message: "needs signature".into() });
    assert_eq!(outcome.status, OpStatus::Failed);
    assert!(outcome.message.contains("gpg") || outcome.output.contains("gpg"), "{} / {}", outcome.message, outcome.output);
    assert_eq!(git_text(p, &["rev-parse", "HEAD"]), head);
    // 可用的签名程序（测试替身，输出 SIG_CREATED 状态行）：提交带签名头。
    let fake = p.join(".git/fake-gpg.sh");
    fs::write(&fake, "#!/bin/sh\ncat >/dev/null\necho >&2\necho '[GNUPG:] SIG_CREATED D 1 8 00 1700000000 FAKE' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(p, &["config", "gpg.program", &fake.to_string_lossy().replace('\\', "/")]);
    let outcome = h.run(OperationRequest::Commit { message: "signed".into() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{} / {}", outcome.message, outcome.output);
    assert!(git_text(p, &["cat-file", "commit", "HEAD"]).contains("gpgsig -----BEGIN PGP SIGNATURE-----"));
}

// ------------------------------ B16 ------------------------------

#[test]
fn b16_one_write_per_repository_external_lock_is_reported_not_removed_and_no_retry() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"change\n");
    let h = Harness::new(p);
    let runner = Runner::default();
    let first = runner.begin(&h.adapter.repo_id).unwrap();
    assert!(matches!(runner.begin(&h.adapter.repo_id), Err(GitError::OperationBusy)), "同仓库第二个写操作被直接拒绝");
    assert!(runner.begin("another-repo").is_ok(), "不同仓库互不影响");
    drop(first);
    assert!(runner.begin(&h.adapter.repo_id).is_ok(), "结束后写锁释放");
    // 外部 index.lock：报错、不删除、不启动任何写进程。
    let lock = p.join(".git/index.lock");
    fs::write(&lock, b"held by another tool").unwrap();
    let before = fingerprint(p);
    for request in [
        OperationRequest::Stage { path_ids: vec![id("a.txt")] },
        OperationRequest::Discard { scope: CompareScope::Unstaged, path_ids: vec![id("a.txt")], confirmed_unrecoverable: false },
        OperationRequest::Commit { message: "x".into() },
    ] {
        let error = h.try_run(request).unwrap_err();
        assert!(matches!(&error, GitError::ExternalLock(m) if m.contains("index.lock")), "{error}");
    }
    assert!(lock.exists(), "锁文件保留");
    assert_eq!(fs::read(&lock).unwrap(), b"held by another tool");
    assert_eq!(before, fingerprint(p));
    fs::remove_file(&lock).unwrap();
    // 失败的命令只执行一次（没有自动重试）。
    let outcome = h.run(OperationRequest::Stage { path_ids: vec![id("missing-file.txt")] });
    assert_eq!((outcome.status, outcome.git_processes), (OpStatus::Failed, 1));
    // 进行中状态（rebase）禁用全部写操作。
    fs::create_dir_all(p.join(".git/rebase-merge")).unwrap();
    assert!(matches!(h.try_run(OperationRequest::Stage { path_ids: vec![id("a.txt")] }), Err(GitError::WriteBlocked(m)) if m.contains("rebase")));
    fs::remove_dir_all(p.join(".git/rebase-merge")).unwrap();
}

#[test]
fn b16_lock_failure_during_command_is_explained() {
    let result = process::CallResult { success: false, code: Some(128), stdout: Vec::new(), stderr_tail: "fatal: Unable to create 'C:/r/.git/index.lock': File exists.".into(), cancelled: false, timed_out: false };
    let message = GitAdapter::failure_message(&result, "暂存");
    assert!(message.contains("锁文件已存在") && message.contains("不会自动重试"), "{message}");
}

// ------------------------------ B17 / 安全 ------------------------------

#[test]
fn b17_readonly_queries_for_write_ui_do_not_touch_the_repository() {
    let dir = base_repo();
    let p = dir.path();
    write(p, "a.txt", b"change\n");
    write(p, "u.txt", b"untracked\n");
    std::thread::sleep(Duration::from_millis(1100));
    // 只改 mtime：index 的 stat 信息过期，porcelain 读取容易顺手回写。
    let bytes = fs::read(p.join("del.txt")).unwrap();
    fs::write(p.join("del.txt"), bytes).unwrap();
    let h = Harness::new(p);
    let before = fingerprint(p);
    let index_before = fs::read(p.join(".git/index")).unwrap();
    let _ = h.adapter.prepare_discard(CompareScope::Unstaged, &[id("a.txt"), id("u.txt")]).unwrap();
    let _ = h.adapter.prepare_discard(CompareScope::All, &[id("a.txt")]).unwrap();
    let _ = h.adapter.head_commit_info().unwrap();
    let _ = h.adapter.discard_backups(&h.store);
    assert_eq!(before, fingerprint(p));
    assert_eq!(index_before, fs::read(p.join(".git/index")).unwrap(), ".git/index 逐字节不变");
}

#[test]
fn write_channel_does_not_run_fsmonitor_or_external_diff_commands() {
    let dir = base_repo();
    let p = dir.path();
    let marker = p.join(".git/fsmonitor-ran");
    let script = p.join(".git/fsmonitor.sh");
    fs::write(&script, format!("#!/bin/sh\necho ran > '{}'\n", marker.to_string_lossy().replace('\\', "/"))).unwrap();
    git(p, &["config", "core.fsmonitor", &script.to_string_lossy().replace('\\', "/")]);
    git(p, &["config", "diff.external", &script.to_string_lossy().replace('\\', "/")]);
    write(p, "a.txt", b"change\n");
    let h = Harness::new(p);
    assert_eq!(h.run(OperationRequest::Stage { path_ids: vec![id("a.txt")] }).status, OpStatus::Succeeded);
    assert_eq!(h.run(OperationRequest::Commit { message: "m".into() }).status, OpStatus::Succeeded);
    assert!(!marker.exists());
}

/// 外部开始 rebase 时 status 输出可能不变：扫描仍要报告进行中状态（写操作据此全部禁用）。
#[test]
fn in_progress_state_changes_the_revision_even_when_status_output_is_identical() {
    let dir = base_repo();
    let p = dir.path();
    let a = adapter(p);
    let first = a.snapshot_v2("1".into(), CompareScope::Unstaged, false).unwrap();
    let _ = a.details(&first.revision).unwrap();
    fs::create_dir_all(p.join(".git/rebase-merge")).unwrap();
    let second = a.snapshot_v2("2".into(), CompareScope::Unstaged, false).unwrap();
    assert_ne!(first.revision, second.revision);
    assert!(second.in_progress.as_ref().unwrap().rebase);
}
