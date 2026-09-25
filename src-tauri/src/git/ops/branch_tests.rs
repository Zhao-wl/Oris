//! V2-03 验收测试：B09（stash）、B10（分支与检出）、B16（外部锁）、B17（只读查询不改仓库）。
//! 全部在临时仓库中进行，每个写操作比较操作前后的 index、HEAD 与本地分支、stash、config、工作区。
use super::process::CancelHandle;
use super::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

fn git_in(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_AUTHOR_NAME", "Br")
        .env("GIT_AUTHOR_EMAIL", "br@example.invalid")
        .env("GIT_COMMITTER_NAME", "Br")
        .env("GIT_COMMITTER_EMAIL", "br@example.invalid")
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    output.stdout
}

fn text(root: &Path, args: &[&str]) -> String {
    String::from_utf8_lossy(&git_in(root, args)).trim().to_owned()
}

fn try_text(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn commit(root: &Path, rel: &str, content: &str, message: &str) -> String {
    write(root, rel, content);
    git_in(root, &["add", "-A"]);
    git_in(root, &["commit", "-qm", message]);
    text(root, &["rev-parse", "HEAD"])
}

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git_in(p, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.name", "Br"), ("user.email", "br@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        git_in(p, &["config", key, value]);
    }
    commit(p, "a.txt", "a\n", "base");
    dir
}

fn id(path: &str) -> String {
    URL_SAFE_NO_PAD.encode(path.as_bytes())
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
    fn try_run(&self, request: OperationRequest) -> Result<OperationOutcome, GitError> {
        let sink = |_: &str| {};
        let ctx = OpContext::new(format!("br-{}-{}", std::process::id(), OPS.fetch_add(1, Ordering::SeqCst)), Arc::new(CancelHandle::default()), &self.store, &sink);
        self.adapter.run_operation(request, CompareScope::Unstaged, &ctx)
    }
    fn run(&self, request: OperationRequest) -> OperationOutcome {
        self.try_run(request).unwrap()
    }
}

/// 指纹（不含 objects / logs / hooks）。
fn fingerprint(root: &Path) -> BTreeMap<String, String> {
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
            } else if !matches!(rel.as_str(), ".git/ORIG_HEAD" | ".git/COMMIT_EDITMSG") {
                entries.insert(rel, hash_bytes(&fs::read(&path).unwrap()));
            }
        }
    }
    entries
}

/// 类别：index / head（HEAD 与 refs/heads）/ stash（refs/stash）/ remote-refs / config / worktree / 其他。
fn changed(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> Vec<String> {
    let mut kinds = std::collections::BTreeSet::new();
    for key in before.keys().chain(after.keys()) {
        if before.get(key) == after.get(key) {
            continue;
        }
        kinds.insert(match key.as_str() {
            ".git/index" => "index".to_owned(),
            ".git/HEAD" => "head".to_owned(),
            ".git/refs/stash" => "stash".to_owned(),
            ".git/config" => "config".to_owned(),
            k if k.starts_with(".git/refs/heads/") => "head".to_owned(),
            k if k.starts_with(".git/refs/remotes/") || k == ".git/packed-refs" => "remote-refs".to_owned(),
            k if k.starts_with(".git/") => format!("git:{}", &k[5..]),
            _ => "worktree".to_owned(),
        });
    }
    kinds.into_iter().collect()
}

fn stash_count(root: &Path) -> usize {
    try_text(root, &["stash", "list"]).map(|t| t.lines().filter(|l| !l.is_empty()).count()).unwrap_or(0)
}

// ------------------------------ B09 stash ------------------------------

#[test]
fn b09_stash_push_with_message_untracked_and_selected_paths() {
    let dir = repo();
    let p = dir.path();
    commit(p, "b.txt", "b\n", "b");
    write(p, "a.txt", "a changed\n");
    write(p, "b.txt", "b staged\n");
    git_in(p, &["add", "b.txt"]);
    write(p, "u.txt", "untracked\n");
    let h = Harness::new(p);
    // 不含未跟踪：a、b 回到 HEAD，u.txt 保留。
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::StashPush { message: Some("wip a b".into()), include_untracked: false, path_ids: None });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let kinds = changed(&before, &fingerprint(p));
    assert_eq!(kinds, vec!["index", "stash", "worktree"], "{kinds:?}");
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "a\n");
    assert!(p.join("u.txt").exists());
    let list = h.adapter.stash_list().unwrap();
    assert_eq!((list.len(), list[0].index, list[0].message.as_str(), list[0].branch.as_str()), (1, 0, "wip a b", "main"));
    assert!(list[0].untracked.is_none());
    let content = h.adapter.stash_changes(&list[0].oid).unwrap();
    let mut tracked: Vec<_> = content.tracked.iter().map(|f| f.path.clone()).collect();
    tracked.sort();
    assert_eq!(tracked, vec!["a.txt", "b.txt"]);
    assert!(content.untracked.is_empty());
    // 含未跟踪、只储藏选中的路径 u.txt。
    write(p, "a.txt", "a again\n");
    let outcome = h.run(OperationRequest::StashPush { message: None, include_untracked: true, path_ids: Some(vec![id("u.txt")]) });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(!p.join("u.txt").exists() && fs::read_to_string(p.join("a.txt")).unwrap() == "a again\n", "只储藏选中的路径");
    let list = h.adapter.stash_list().unwrap();
    assert_eq!(list.len(), 2);
    let content = h.adapter.stash_changes(&list[0].oid).unwrap();
    assert!(list[0].untracked.is_some() && content.untracked.iter().any(|f| f.path == "u.txt") && content.tracked.is_empty(), "{content:?}");
    // 只储藏选中的已跟踪文件。
    write(p, "b.txt", "b edited\n");
    let outcome = h.run(OperationRequest::StashPush { message: Some("only a".into()), include_untracked: false, path_ids: Some(vec![id("a.txt")]) });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!((fs::read_to_string(p.join("a.txt")).unwrap().as_str(), fs::read_to_string(p.join("b.txt")).unwrap().as_str()), ("a\n", "b edited\n"));
    // 没有改动：不创建 stash。
    git_in(p, &["checkout", "--", "b.txt"]);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::StashPush { message: None, include_untracked: false, path_ids: None });
    assert_eq!(outcome.status, OpStatus::Failed);
    assert!(outcome.message.contains("没有可储藏的改动"), "{}", outcome.message);
    assert!(changed(&before, &fingerprint(p)).iter().all(|k| k == "index"));
    assert_eq!(stash_count(p), 3);
}

#[test]
fn b09_apply_pop_drop_check_identity_and_keep_stash_on_conflict() {
    let dir = repo();
    let p = dir.path();
    let h = Harness::new(p);
    write(p, "a.txt", "stashed change\n");
    assert_eq!(h.run(OperationRequest::StashPush { message: Some("one".into()), include_untracked: false, path_ids: None }).status, OpStatus::Succeeded);
    let first = h.adapter.stash_list().unwrap()[0].clone();
    // apply：内容恢复，stash 保留。
    let outcome = h.run(OperationRequest::StashApply { index: 0, oid: first.oid.clone(), pop: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "stashed change\n");
    assert_eq!(stash_count(p), 1);
    git_in(p, &["checkout", "--", "a.txt"]);
    // 外部又储藏了一条：stash@{0} 已不是列表中的那一条，拒绝 drop，什么也不删。
    write(p, "a.txt", "external\n");
    git_in(p, &["stash", "push", "-q", "-m", "external"]);
    let before = fingerprint(p);
    let error = h.try_run(OperationRequest::StashDrop { index: 0, oid: first.oid.clone() }).unwrap_err();
    assert!(matches!(error, GitError::WriteBlocked(_)), "{error}");
    let error = h.try_run(OperationRequest::StashApply { index: 0, oid: first.oid.clone(), pop: true }).unwrap_err();
    assert!(matches!(error, GitError::WriteBlocked(_)), "{error}");
    assert_eq!(fingerprint(p), before);
    assert_eq!(stash_count(p), 2);
    // 刷新后按新位置 stash@{1} 弹出：应用并删除。
    let outcome = h.run(OperationRequest::StashApply { index: 1, oid: first.oid.clone(), pop: true });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(stash_count(p), 1);
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "stashed change\n");
    // 冲突：stash@{0}（external）改的是同一行，HEAD 上又提交了不同内容。
    commit(p, "a.txt", "committed differently\n", "diverge");
    let external = h.adapter.stash_list().unwrap()[0].clone();
    let outcome = h.run(OperationRequest::StashApply { index: 0, oid: external.oid.clone(), pop: true });
    assert_eq!(outcome.status, OpStatus::Failed, "{}", outcome.message);
    assert!(outcome.message.contains("冲突") && outcome.message.contains("stash 已保留"), "{}", outcome.message);
    assert_eq!(stash_count(p), 1, "冲突时 stash 保留");
    assert!(!text(p, &["ls-files", "-u"]).is_empty(), "进入只读冲突查看");
    let snapshot = outcome.snapshot.expect("冲突后重新读取状态");
    assert!(serde_json::to_string(&snapshot).unwrap().contains("\"conflicted\""));
    // drop（身份一致）。
    git_in(p, &["reset", "-q", "--hard"]);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::StashDrop { index: 0, oid: external.oid.clone() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(stash_count(p), 0);
    assert_eq!(changed(&before, &fingerprint(p)), vec!["stash"]);
}

// ------------------------------ B10 分支 ------------------------------

fn with_remote() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let seed = root.join("seed");
    fs::create_dir_all(&seed).unwrap();
    git_in(&seed, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.name", "Br"), ("user.email", "br@example.invalid")] {
        git_in(&seed, &["config", key, value]);
    }
    commit(&seed, "a.txt", "a\n", "base");
    git_in(&seed, &["switch", "-qc", "feature"]);
    commit(&seed, "f.txt", "feature\n", "feature work");
    git_in(&seed, &["switch", "-q", "main"]);
    let bare = root.join("remote.git");
    git_in(root, &["clone", "-q", "--bare", seed.to_str().unwrap(), bare.to_str().unwrap()]);
    let local = root.join("local");
    git_in(root, &["clone", "-q", bare.to_str().unwrap(), local.to_str().unwrap()]);
    for (key, value) in [("user.name", "Br"), ("user.email", "br@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        git_in(&local, &["config", key, value]);
    }
    (dir, local)
}

#[test]
fn b10_branch_names_are_validated_with_git_rules() {
    let dir = repo();
    let h = Harness::new(dir.path());
    for good in ["feature/x", "fix-1", "中文分支"] {
        assert!(h.adapter.check_branch_name(good).is_ok(), "{good}");
    }
    for bad in ["", "bad name", "-x", "a..b", "@{-1}", "x.lock", "a~1", "HEAD", "x:y", "tab\tname"] {
        assert!(h.adapter.check_branch_name(bad).is_err(), "{bad}");
    }
    let before = fingerprint(dir.path());
    let error = h.try_run(OperationRequest::BranchCreate { name: "bad name".into(), start: "HEAD".into(), switch: false, stash_first: false, stash_untracked: false }).unwrap_err();
    assert!(matches!(error, GitError::WriteBlocked(_)));
    assert_eq!(fingerprint(dir.path()), before, "校验失败时不启动写进程");
}

#[test]
fn b10_create_switch_track_rename_delete_and_set_upstream() {
    let (_dir, p) = with_remote();
    let p = p.as_path();
    let h = Harness::new(p);
    let base = text(p, &["rev-parse", "HEAD"]);
    // 从 HEAD 新建，不切换。
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::BranchCreate { name: "topic".into(), start: "HEAD".into(), switch: false, stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(changed(&before, &fingerprint(p)), vec!["head"], "只新增 refs/heads/topic");
    assert_eq!(text(p, &["branch", "--show-current"]), "main");
    assert_eq!(text(p, &["rev-parse", "topic"]), base);
    assert!(try_text(p, &["config", "branch.topic.merge"]).is_none(), "--no-track");
    // 从远端跟踪分支的提交新建并立即切换。
    let feature_tip = text(p, &["rev-parse", "origin/feature"]);
    let outcome = h.run(OperationRequest::BranchCreate { name: "from-commit".into(), start: feature_tip.clone(), switch: true, stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!((text(p, &["branch", "--show-current"]), text(p, &["rev-parse", "HEAD"])), ("from-commit".to_owned(), feature_tip.clone()));
    // 切换本地分支。
    let outcome = h.run(OperationRequest::BranchSwitch { name: "refs/heads/main".into(), stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(text(p, &["branch", "--show-current"]), "main");
    // 远端分支：建立同名本地跟踪分支。
    let outcome = h.run(OperationRequest::BranchTrack { remote: "refs/remotes/origin/feature".into(), local_name: None, stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(text(p, &["branch", "--show-current"]), "feature");
    assert_eq!(text(p, &["rev-parse", "--abbrev-ref", "feature@{u}"]), "origin/feature");
    git_in(p, &["switch", "-q", "main"]);
    // 同名本地分支已存在：要求选择，不改仓库；指定新名称后建立。
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::BranchTrack { remote: "refs/remotes/origin/feature".into(), local_name: None, stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation);
    assert_eq!(outcome.confirmation.as_ref().unwrap().reason, "localExists");
    assert_eq!(fingerprint(p), before);
    let outcome = h.run(OperationRequest::BranchTrack { remote: "refs/remotes/origin/feature".into(), local_name: Some("feature-2".into()), stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(text(p, &["rev-parse", "--abbrev-ref", "feature-2@{u}"]), "origin/feature");
    git_in(p, &["switch", "-q", "main"]);
    // 重命名（上游配置随分支移动）。
    let outcome = h.run(OperationRequest::BranchRename { name: "refs/heads/feature-2".into(), new_name: "feature-renamed".into() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(text(p, &["rev-parse", "--abbrev-ref", "feature-renamed@{u}"]), "origin/feature");
    assert!(try_text(p, &["rev-parse", "-q", "--verify", "refs/heads/feature-2"]).is_none());
    // 设置 / 更换上游。
    let outcome = h.run(OperationRequest::SetUpstream { name: "refs/heads/topic".into(), upstream: "refs/remotes/origin/main".into() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(text(p, &["rev-parse", "--abbrev-ref", "topic@{u}"]), "origin/main");
    let outcome = h.run(OperationRequest::SetUpstream { name: "refs/heads/topic".into(), upstream: "refs/remotes/origin/feature".into() });
    assert_eq!(outcome.status, OpStatus::Succeeded);
    assert_eq!(text(p, &["rev-parse", "--abbrev-ref", "topic@{u}"]), "origin/feature");
    // 删除：已合并直接删除；未合并先强确认，确认后删除；当前分支不能删除。
    let outcome = h.run(OperationRequest::BranchDelete { name: "refs/heads/topic".into(), force: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "topic 与 main 同一提交（已合并）：{}", outcome.message);
    git_in(p, &["switch", "-q", "from-commit"]);
    commit(p, "unmerged.txt", "x\n", "unmerged work");
    let unmerged_tip = text(p, &["rev-parse", "HEAD"]);
    git_in(p, &["switch", "-q", "main"]);
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::BranchDelete { name: "refs/heads/from-commit".into(), force: false });
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation, "{}", outcome.message);
    let confirmation = outcome.confirmation.unwrap();
    assert!(confirmation.reason == "unmerged" && confirmation.message.contains("reflog") && confirmation.message.contains(&unmerged_tip[..8]), "{}", confirmation.message);
    assert_eq!(fingerprint(p), before, "未确认时不删除");
    let outcome = h.run(OperationRequest::BranchDelete { name: "refs/heads/from-commit".into(), force: true });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(try_text(p, &["rev-parse", "-q", "--verify", "refs/heads/from-commit"]).is_none());
    let error = h.try_run(OperationRequest::BranchDelete { name: "refs/heads/main".into(), force: true }).unwrap_err();
    assert!(matches!(error, GitError::WriteBlocked(_)), "不能删除当前分支：{error}");
    // 类型化参数：不接受短名或任意参数。
    for bad in ["main", "--all", "refs/heads/../x"] {
        assert!(h.try_run(OperationRequest::BranchSwitch { name: bad.into(), stash_first: false, stash_untracked: false }).is_err(), "{bad}");
    }
}

#[test]
fn b10_detached_checkout_and_stash_then_switch_without_auto_restore() {
    let (_dir, p) = with_remote();
    let p = p.as_path();
    let h = Harness::new(p);
    let base = text(p, &["rev-parse", "HEAD"]);
    git_in(p, &["branch", "-q", "--track", "feature", "origin/feature"]);
    // 检出指定提交：分离 HEAD。
    let outcome = h.run(OperationRequest::Checkout { commit: base.clone(), stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(try_text(p, &["symbolic-ref", "-q", "HEAD"]).is_none());
    assert_eq!(text(p, &["rev-parse", "HEAD"]), base);
    // 从分离 HEAD 新建分支。
    let outcome = h.run(OperationRequest::BranchCreate { name: "from-detached".into(), start: "HEAD".into(), switch: true, stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(text(p, &["branch", "--show-current"]), "from-detached");
    // 工作区改动会被覆盖：返回“stash 后切换”，不改仓库。
    git_in(p, &["switch", "-q", "feature"]);
    commit(p, "a.txt", "feature edits a\n", "feature edits a");
    git_in(p, &["switch", "-q", "main"]);
    write(p, "a.txt", "local change\n");
    let before = fingerprint(p);
    let outcome = h.run(OperationRequest::BranchSwitch { name: "refs/heads/feature".into(), stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation, "{}", outcome.message);
    let confirmation = outcome.confirmation.unwrap();
    assert_eq!(confirmation.reason, "localChanges");
    assert_eq!(confirmation.paths, vec!["a.txt"]);
    assert_eq!(changed(&before, &fingerprint(p)), Vec::<String>::new());
    let outcome = h.run(OperationRequest::BranchSwitch { name: "refs/heads/feature".into(), stash_first: true, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("没有自动恢复") && outcome.message.contains("stash@{0}"), "{}", outcome.message);
    assert_eq!(text(p, &["branch", "--show-current"]), "feature");
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "feature edits a\n", "切换后不自动恢复");
    assert!(h.adapter.stash_list().unwrap()[0].message.contains("切换到 feature 前储藏"));
    // 未跟踪文件会被覆盖：原因不同，确认后含未跟踪一并储藏。
    git_in(p, &["switch", "-q", "main"]);
    git_in(p, &["switch", "-qc", "adds-file"]);
    commit(p, "new.txt", "tracked on branch\n", "add new");
    git_in(p, &["switch", "-q", "main"]);
    write(p, "new.txt", "untracked local\n");
    let outcome = h.run(OperationRequest::BranchSwitch { name: "refs/heads/adds-file".into(), stash_first: false, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation, "{}", outcome.message);
    assert_eq!(outcome.confirmation.unwrap().reason, "untrackedOverwritten");
    let outcome = h.run(OperationRequest::BranchSwitch { name: "refs/heads/adds-file".into(), stash_first: true, stash_untracked: true });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(fs::read_to_string(p.join("new.txt")).unwrap(), "tracked on branch\n");
    assert!(h.adapter.stash_list().unwrap()[0].untracked.is_some());
}

// ------------------------------ B16 / B17 ------------------------------

#[test]
fn b16_external_index_lock_blocks_stash_and_branch_writes_without_touching_the_lock() {
    let dir = repo();
    let p = dir.path();
    write(p, "a.txt", "changed\n");
    let lock = p.join(".git/index.lock");
    fs::write(&lock, "held").unwrap();
    let before = fingerprint(p);
    let h = Harness::new(p);
    for request in [
        OperationRequest::StashPush { message: None, include_untracked: false, path_ids: None },
        OperationRequest::BranchCreate { name: "x".into(), start: "HEAD".into(), switch: true, stash_first: false, stash_untracked: false },
        OperationRequest::Checkout { commit: "HEAD".into(), stash_first: false, stash_untracked: false },
    ] {
        let error = h.try_run(request).unwrap_err();
        assert!(matches!(error, GitError::ExternalLock(_)), "{error}");
    }
    assert_eq!(fs::read_to_string(&lock).unwrap(), "held");
    assert_eq!(fingerprint(p), before);
}

#[test]
fn b17_stash_and_branch_queries_do_not_touch_the_repository() {
    let dir = repo();
    let p = dir.path();
    write(p, "a.txt", "changed\n");
    write(p, "u.txt", "u\n");
    git_in(p, &["stash", "push", "-q", "-u", "-m", "q"]);
    // stat 信息过期：只读查询若回写 index 会被发现。
    let content = fs::read(p.join("a.txt")).unwrap();
    fs::write(p.join("a.txt"), content).unwrap();
    let before = fingerprint(p);
    let h = Harness::new(p);
    let list = h.adapter.stash_list().unwrap();
    let changes = h.adapter.stash_changes(&list[0].oid).unwrap();
    assert!(changes.untracked.iter().any(|f| f.path == "u.txt"));
    let _ = h.adapter.stash_oid(0).unwrap();
    let _ = h.adapter.check_branch_name("feature/x");
    let _ = h.adapter.check_branch_name("bad name");
    let pair = h.adapter.read_revision_pair("r".into(), None, changes.untracked_commit.as_deref().unwrap(), &id("u.txt"), None, || false).unwrap();
    assert_eq!(pair.right.text.as_deref(), Some("u\n"));
    assert_eq!(fingerprint(p), before);
}

#[test]
fn b09_stash_with_untracked_and_no_paths_removes_and_restores_untracked_files() {
    // 回归：写通道默认 GIT_LITERAL_PATHSPECS=1 时，Git 内部用 `:/` 清理已储藏的未跟踪文件会匹配不到任何文件。
    let dir = repo();
    let p = dir.path();
    write(p, "a.txt", "tracked change\n");
    write(p, "dir/u.txt", "untracked\n");
    let h = Harness::new(p);
    let outcome = h.run(OperationRequest::StashPush { message: Some("all".into()), include_untracked: true, path_ids: None });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(!p.join("dir/u.txt").exists(), "未跟踪文件应随 stash 移走");
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "a\n");
    let entry = h.adapter.stash_list().unwrap()[0].clone();
    let outcome = h.run(OperationRequest::StashApply { index: 0, oid: entry.oid, pop: true });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(fs::read_to_string(p.join("dir/u.txt")).unwrap(), "untracked\n");
    assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "tracked change\n");
    assert_eq!(stash_count(p), 0);
}

#[test]
fn v2_d42_stash_drop_reports_a_restore_command_that_works() {
    let dir = repo();
    let p = dir.path();
    write(p, "a.txt", "stashed\n");
    let h = Harness::new(p);
    assert_eq!(h.run(OperationRequest::StashPush { message: Some("keep me".into()), include_untracked: false, path_ids: None }).status, OpStatus::Succeeded);
    let entry = h.adapter.stash_list().unwrap()[0].clone();
    let outcome = h.run(OperationRequest::StashDrop { index: 0, oid: entry.oid.clone() });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("git stash store") && outcome.message.contains(&entry.oid), "{}", outcome.message);
    assert_eq!(stash_count(p), 0);
    git_in(p, &["stash", "store", "-m", "Oris 找回的 stash", &entry.oid]);
    assert_eq!(h.adapter.stash_list().unwrap()[0].oid, entry.oid, "按提示的命令可以找回");
}
