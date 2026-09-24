//! V2-04 验收测试：B11（pull / push）、B12（进度、取消、超时、认证失败）、B13（merge）、B14（不支持的进行中状态）、
//! B18（凭据脱敏）。全部使用临时目录中的本地 bare remote；认证失败用本地 HTTP 401 服务模拟，不访问外网。
//! 每个写操作比较操作前后的 index、HEAD 与本地分支、远端跟踪引用、stash、config、工作区。
use super::process::CancelHandle;
use super::*;
use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

fn run_git(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_AUTHOR_NAME", "Sync")
        .env("GIT_AUTHOR_EMAIL", "sync@example.invalid")
        .env("GIT_COMMITTER_NAME", "Sync")
        .env("GIT_COMMITTER_EMAIL", "sync@example.invalid")
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap()
}

fn git_in(root: &Path, args: &[&str]) -> String {
    let output = run_git(root, args);
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
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
    git_in(root, &["rev-parse", "HEAD"])
}

fn configure(root: &Path) {
    for (key, value) in [("user.name", "Sync"), ("user.email", "sync@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        git_in(root, &["config", key, value]);
    }
}

struct Remote {
    _dir: tempfile::TempDir,
    root: PathBuf,
    bare: PathBuf,
    local: PathBuf,
    other: PathBuf,
}

fn remote_setup() -> Remote {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let seed = root.join("seed");
    fs::create_dir_all(&seed).unwrap();
    git_in(&seed, &["init", "-q", "-b", "main"]);
    configure(&seed);
    commit(&seed, "a.txt", "base\n", "base");
    let bare = root.join("remote.git");
    git_in(&root, &["clone", "-q", "--bare", seed.to_str().unwrap(), bare.to_str().unwrap()]);
    let local = root.join("local");
    let other = root.join("other");
    for clone in [&local, &other] {
        git_in(&root, &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
        configure(clone);
    }
    Remote { _dir: dir, root, bare, local, other }
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
    fn run_with(&self, request: OperationRequest, cancel: Arc<CancelHandle>, idle: Option<Duration>) -> Result<OperationOutcome, GitError> {
        let sink = |_: &str| {};
        let mut ctx = OpContext::new(format!("sync-{}-{}", std::process::id(), OPS.fetch_add(1, Ordering::SeqCst)), cancel, &self.store, &sink);
        if let Some(idle) = idle {
            ctx.network_idle = idle;
        }
        self.adapter.run_operation(request, CompareScope::Unstaged, &ctx)
    }
    fn try_run(&self, request: OperationRequest) -> Result<OperationOutcome, GitError> {
        self.run_with(request, Arc::new(CancelHandle::default()), None)
    }
    fn run(&self, request: OperationRequest) -> OperationOutcome {
        self.try_run(request).unwrap()
    }
}

fn pull(mode: PullMode) -> OperationRequest {
    OperationRequest::Pull { mode, stash_first: false, stash_untracked: false }
}

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
            } else {
                entries.insert(rel, hash_bytes(&fs::read(&path).unwrap()));
            }
        }
    }
    entries
}

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
            k if k.starts_with(".git/refs/remotes/") || k.starts_with(".git/refs/tags/") || k == ".git/packed-refs" => "remote-refs".to_owned(),
            k if k.starts_with(".git/") => format!("git:{}", &k[5..]),
            _ => "worktree".to_owned(),
        });
    }
    kinds.into_iter().collect()
}

fn only(kinds: &[String], allowed: &[&str]) -> bool {
    kinds.iter().all(|k| allowed.contains(&k.as_str()) || matches!(k.as_str(), "git:FETCH_HEAD" | "git:ORIG_HEAD" | "git:AUTO_MERGE"))
}

fn bare_ref(bare: &Path, name: &str) -> Option<String> {
    let output = Command::new("git").arg("--git-dir").arg(bare).args(["rev-parse", "-q", "--verify", name]).output().unwrap();
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn parents(root: &Path, rev: &str) -> usize {
    git_in(root, &["rev-list", "--parents", "-n", "1", rev, "--"]).split_whitespace().count() - 1
}

// ------------------------------ B11 pull ------------------------------

#[test]
fn b11_pull_fast_forward_only_updates_head_to_the_upstream() {
    let r = remote_setup();
    let remote_head = commit(&r.other, "b.txt", "remote\n", "remote work");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    let before = fingerprint(&r.local);
    let outcome = Harness::new(&r.local).run(pull(PullMode::FfOnly));
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("快进"), "{}", outcome.message);
    assert_eq!(git_in(&r.local, &["rev-parse", "HEAD"]), remote_head);
    let kinds = changed(&before, &fingerprint(&r.local));
    assert!(only(&kinds, &["head", "index", "worktree", "remote-refs"]), "{kinds:?}");
    let again = Harness::new(&r.local).run(pull(PullMode::FfOnly));
    assert!(again.message.contains("已是最新"), "{}", again.message);
}

#[test]
fn b11_diverged_ff_only_fails_then_merge_creates_a_merge_commit_even_with_pull_rebase_true() {
    let r = remote_setup();
    commit(&r.other, "b.txt", "remote\n", "remote work");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    let local_commit = commit(&r.local, "c.txt", "local\n", "local work");
    git_in(&r.local, &["config", "pull.rebase", "true"]);
    let h = Harness::new(&r.local);
    let before = fingerprint(&r.local);
    let outcome = h.run(pull(PullMode::FfOnly));
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation, "{}", outcome.message);
    assert_eq!(outcome.confirmation.as_ref().unwrap().reason, "diverged");
    assert!(outcome.message.contains("已分叉") && outcome.message.contains("合并"), "{}", outcome.message);
    assert_eq!(git_in(&r.local, &["rev-parse", "HEAD"]), local_commit, "仅快进失败时 HEAD 不变");
    assert!(only(&changed(&before, &fingerprint(&r.local)), &["remote-refs"]), "只获取了远端跟踪引用");
    let outcome = h.run(pull(PullMode::Merge));
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("合并提交"), "{}", outcome.message);
    assert_eq!(parents(&r.local, "HEAD"), 2, "以合并方式执行，不是 rebase");
    assert_eq!(git_in(&r.local, &["rev-parse", "HEAD^1"]), local_commit, "本地提交没有被改写");
    assert!(!r.local.join(".git/rebase-merge").exists() && !r.local.join(".git/rebase-apply").exists());
}

#[test]
fn b11_pull_needs_an_upstream_and_offers_stash_when_local_changes_block_it() {
    let r = remote_setup();
    let h = Harness::new(&r.local);
    git_in(&r.local, &["switch", "-qc", "solo"]);
    let error = h.try_run(pull(PullMode::FfOnly)).unwrap_err();
    assert!(matches!(&error, GitError::WriteBlocked(m) if m.contains("没有上游")), "{error}");
    git_in(&r.local, &["switch", "-q", "main"]);
    let remote_head = commit(&r.other, "a.txt", "remote edit\n", "remote edit a");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    write(&r.local, "a.txt", "local uncommitted edit\n");
    let outcome = h.run(pull(PullMode::FfOnly));
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation, "{}", outcome.message);
    let confirmation = outcome.confirmation.unwrap();
    assert_eq!((confirmation.reason, confirmation.paths.clone()), ("localChanges", vec!["a.txt".to_owned()]));
    assert_eq!(fs::read_to_string(r.local.join("a.txt")).unwrap(), "local uncommitted edit\n");
    let outcome = h.run(OperationRequest::Pull { mode: PullMode::FfOnly, stash_first: true, stash_untracked: false });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("没有自动恢复") && outcome.message.contains("stash@{0}"), "{}", outcome.message);
    assert_eq!(git_in(&r.local, &["rev-parse", "HEAD"]), remote_head);
    assert_eq!(fs::read_to_string(r.local.join("a.txt")).unwrap(), "remote edit\n", "拉取后不自动恢复");
    assert!(git_in(&r.local, &["stash", "list"]).contains("拉取前储藏"));
}

// ------------------------------ B11 push ------------------------------

#[test]
fn b11_first_push_sets_upstream_rejected_push_offers_no_force_and_tags_stay_local() {
    let r = remote_setup();
    let h = Harness::new(&r.local);
    git_in(&r.local, &["switch", "-qc", "feature"]);
    let feature = commit(&r.local, "f.txt", "feature\n", "feature");
    let error = h.try_run(OperationRequest::Push { remote: None }).unwrap_err();
    assert!(matches!(&error, GitError::WriteBlocked(m) if m.contains("没有上游")), "{error}");
    git_in(&r.local, &["tag", "v-local"]);
    git_in(&r.local, &["config", "push.followTags", "true"]);
    let before = fingerprint(&r.local);
    let outcome = h.run(OperationRequest::Push { remote: Some("origin".into()) });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("设为上游"), "{}", outcome.message);
    assert_eq!(bare_ref(&r.bare, "refs/heads/feature").as_deref(), Some(feature.as_str()));
    assert_eq!(git_in(&r.local, &["rev-parse", "--abbrev-ref", "feature@{u}"]), "origin/feature");
    assert!(bare_ref(&r.bare, "refs/tags/v-local").is_none(), "不推送 tag（即使配置了 push.followTags）");
    let kinds = changed(&before, &fingerprint(&r.local));
    assert!(only(&kinds, &["config", "remote-refs"]), "{kinds:?}");
    // 有上游：推送领先的提交。
    commit(&r.local, "f2.txt", "2\n", "feature 2");
    let outcome = h.run(OperationRequest::Push { remote: None });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("1 个提交"), "{}", outcome.message);
    // 被拒绝：远端 main 有本地没有的提交。
    git_in(&r.local, &["switch", "-q", "main"]);
    let remote_main = commit(&r.other, "b.txt", "remote\n", "remote");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    commit(&r.local, "c.txt", "local\n", "local");
    let before = fingerprint(&r.local);
    let outcome = h.run(OperationRequest::Push { remote: None });
    assert_eq!(outcome.status, OpStatus::Failed, "{}", outcome.message);
    assert!(outcome.message.contains("被拒绝") && outcome.message.contains("先拉取") && outcome.message.contains("不提供强制推送"), "{}", outcome.message);
    assert_eq!(bare_ref(&r.bare, "refs/heads/main").as_deref(), Some(remote_main.as_str()), "远端未被改写");
    assert!(only(&changed(&before, &fingerprint(&r.local)), &["remote-refs"]));
    // 分离 HEAD：拉取与推送都不可用。
    git_in(&r.local, &["switch", "-q", "--detach", "HEAD"]);
    for request in [OperationRequest::Push { remote: Some("origin".into()) }, pull(PullMode::FfOnly)] {
        let error = h.try_run(request).unwrap_err();
        assert!(matches!(&error, GitError::WriteBlocked(m) if m.contains("分离 HEAD")), "{error}");
    }
}

// ------------------------------ B12 进度、取消、超时、认证 ------------------------------

fn slow_script(r: &Remote, name: &str, seconds: u32, exec: &str) -> (PathBuf, PathBuf) {
    let marker = r.root.join(format!("{name}-finished"));
    let script = r.root.join(format!("{name}.sh"));
    let marker_text = marker.to_string_lossy().replace('\\', "/");
    fs::write(&script, format!("#!/bin/sh\nsleep {seconds}\necho done > '{marker_text}'\nexec {exec} \"$@\"\n")).unwrap();
    (script, marker)
}

#[test]
fn b12_pull_times_out_without_output_and_push_can_be_cancelled_ending_the_process_tree() {
    let r = remote_setup();
    commit(&r.other, "b.txt", "x\n", "x");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    let (upload, upload_marker) = slow_script(&r, "slow-upload", 6, "git-upload-pack");
    git_in(&r.local, &["config", "remote.origin.uploadpack", &upload.to_string_lossy().replace('\\', "/")]);
    let head = git_in(&r.local, &["rev-parse", "HEAD"]);
    let h = Harness::new(&r.local);
    let started = Instant::now();
    let outcome = h.run_with(pull(PullMode::FfOnly), Arc::new(CancelHandle::default()), Some(Duration::from_millis(1500))).unwrap();
    assert_eq!(outcome.status, OpStatus::Failed, "{}", outcome.message);
    assert!(outcome.message.contains("没有任何输出") && outcome.message.contains("HEAD 未变化"), "{}", outcome.message);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(git_in(&r.local, &["rev-parse", "HEAD"]), head);
    git_in(&r.local, &["config", "--unset", "remote.origin.uploadpack"]);
    // 推送取消：receive-pack 在远端侧静默，取消后整棵进程树结束，远端没有收到更新。
    let (receive, receive_marker) = slow_script(&r, "slow-receive", 6, "git-receive-pack");
    git_in(&r.local, &["config", "remote.origin.receivepack", &receive.to_string_lossy().replace('\\', "/")]);
    commit(&r.local, "c.txt", "c\n", "local c");
    git_in(&r.local, &["fetch", "-q"]);
    git_in(&r.local, &["merge", "-q", "--no-edit", "origin/main"]);
    let remote_before = bare_ref(&r.bare, "refs/heads/main");
    let cancel = Arc::new(CancelHandle::default());
    let trigger = cancel.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        trigger.cancel();
    });
    let outcome = h.run_with(OperationRequest::Push { remote: None }, cancel, None).unwrap();
    canceller.join().unwrap();
    assert_eq!(outcome.status, OpStatus::Cancelled, "{}", outcome.message);
    assert!(outcome.message.contains("已重新读取实际引用"), "{}", outcome.message);
    std::thread::sleep(Duration::from_secs(7));
    assert!(!receive_marker.exists() && !upload_marker.exists(), "被终止的远端侧进程没有继续运行");
    assert_eq!(bare_ref(&r.bare, "refs/heads/main"), remote_before);
}

fn unauthorized_server() -> (String, Arc<std::sync::atomic::AtomicBool>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let mut buffer = [0u8; 4096];
                    let _ = stream.read(&mut buffer);
                    let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"oris-test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    });
    (format!("http://{address}"), stop)
}

#[test]
fn b12_b18_pull_and_push_authentication_failures_are_explained_and_credentials_redacted() {
    let r = remote_setup();
    let (base, stop) = unauthorized_server();
    git_in(&r.local, &["config", "credential.helper", ""]);
    git_in(&r.local, &["remote", "set-url", "origin", &format!("{}/repo.git", base.replacen("http://", "http://alice:s3cret-token@", 1))]);
    commit(&r.local, "c.txt", "c\n", "local");
    let h = Harness::new(&r.local);
    for request in [pull(PullMode::FfOnly), OperationRequest::Push { remote: None }] {
        let before = fingerprint(&r.local);
        let started = Instant::now();
        let outcome = h.run(request);
        assert_eq!(outcome.status, OpStatus::Failed, "{}", outcome.message);
        assert!(outcome.message.contains("认证失败") || outcome.message.contains("没有访问权限"), "{}", outcome.message);
        assert!(!outcome.message.contains("s3cret") && !outcome.output.contains("s3cret"), "{}\n{}", outcome.message, outcome.output);
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(only(&changed(&before, &fingerprint(&r.local)), &[]));
    }
    stop.store(true, Ordering::SeqCst);
}

// ------------------------------ B13 merge ------------------------------

fn merge(h: &Harness, root: &Path, target: &str, no_ff: bool) -> OperationOutcome {
    let expected = git_in(root, &["rev-parse", target]);
    h.run(OperationRequest::Merge { target: target.into(), expected, no_ff })
}

#[test]
fn b13_fast_forward_non_ff_and_moved_target() {
    let r = remote_setup();
    let p = r.local.as_path();
    let h = Harness::new(p);
    git_in(p, &["switch", "-qc", "topic"]);
    let topic = commit(p, "t.txt", "t\n", "topic");
    git_in(p, &["switch", "-q", "main"]);
    let base = git_in(p, &["rev-parse", "HEAD"]);
    // 目标在界面显示之后移动：拒绝。
    let error = h.try_run(OperationRequest::Merge { target: "refs/heads/topic".into(), expected: base.clone(), no_ff: false }).unwrap_err();
    assert!(matches!(&error, GitError::WriteBlocked(m) if m.contains("已移动")), "{error}");
    let outcome = merge(&h, p, "refs/heads/topic", false);
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("快进"), "{}", outcome.message);
    assert_eq!(git_in(p, &["rev-parse", "HEAD"]), topic);
    git_in(p, &["reset", "-q", "--hard", &base]);
    let outcome = merge(&h, p, "refs/heads/topic", true);
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(parents(p, "HEAD"), 2, "总是创建合并提交");
    assert_eq!(git_in(p, &["log", "-1", "--format=%s"]), "Merge branch 'topic'");
    // 远端跟踪分支也可合并。
    commit(&r.other, "o.txt", "o\n", "remote");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    git_in(p, &["fetch", "-q"]);
    let outcome = merge(&h, p, "refs/remotes/origin/main", false);
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(git_in(p, &["log", "-1", "--format=%s"]).contains("origin/main"));
}

#[test]
fn b13_conflict_read_only_resolve_mark_and_complete_or_abort() {
    let r = remote_setup();
    let p = r.local.as_path();
    let h = Harness::new(p);
    git_in(p, &["switch", "-qc", "topic"]);
    commit(p, "a.txt", "topic side\n", "topic edits a");
    git_in(p, &["switch", "-q", "main"]);
    let main_head = commit(p, "a.txt", "main side\n", "main edits a");
    let before_merge = fingerprint(p);
    let index_before = git_in(p, &["ls-files", "-s"]);
    // 冲突：进入合并进行中。
    let outcome = merge(&h, p, "refs/heads/topic", false);
    assert_eq!(outcome.status, OpStatus::Failed, "{}", outcome.message);
    assert!(outcome.message.contains("1 个冲突") && outcome.message.contains("合并进行中"), "{}", outcome.message);
    assert!(p.join(".git/MERGE_HEAD").exists());
    let snapshot = serde_json::to_string(outcome.snapshot.as_ref().unwrap()).unwrap();
    assert!(snapshot.contains("\"merge\":true") && snapshot.contains("\"conflicted\""));
    assert!(h.adapter.merge_message().unwrap().starts_with("Merge branch 'topic'"), "默认合并信息来自 MERGE_MSG");
    // 中止：回到合并前的状态。
    let outcome = h.run(OperationRequest::MergeAbort);
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    let kinds = changed(&before_merge, &fingerprint(p));
    // merge --abort 会重写 index（stat 与扩展数据），条目与合并前完全一致。
    assert!(only(&kinds, &["index"]) && git_in(p, &["ls-files", "-s"]) == index_before, "中止合并后恢复到合并前：{kinds:?}");
    assert_eq!(git_in(p, &["rev-parse", "HEAD"]), main_head);
    // 再次合并 → 在外部解决 → 标记已解决（残留冲突标记时先警告）→ 完成合并。
    merge(&h, p, "refs/heads/topic", false);
    let error = h.try_run(OperationRequest::MergeCommit { message: "x".into() }).unwrap_err();
    assert!(matches!(&error, GitError::WriteBlocked(m) if m.contains("冲突")), "还有冲突时不能完成：{error}");
    let marked = h.run(OperationRequest::MarkResolved { path_ids: vec![URL_SAFE_NO_PAD.encode("a.txt")], confirmed: false });
    assert_eq!(marked.status, OpStatus::NeedsConfirmation, "文件仍含冲突标记时先警告");
    write(p, "a.txt", "resolved\n");
    let marked = h.run(OperationRequest::MarkResolved { path_ids: vec![URL_SAFE_NO_PAD.encode("a.txt")], confirmed: false });
    assert_eq!(marked.status, OpStatus::Succeeded, "{}", marked.message);
    let message = h.adapter.merge_message().unwrap();
    let outcome = h.run(OperationRequest::MergeCommit { message: format!("{message}\n\n已在外部解决 a.txt") });
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("完成合并"), "{}", outcome.message);
    assert_eq!(parents(p, "HEAD"), 2);
    assert!(!p.join(".git/MERGE_HEAD").exists());
    assert!(git_in(p, &["log", "-1", "--format=%B"]).contains("已在外部解决 a.txt"));
    assert!(h.try_run(OperationRequest::MergeAbort).is_err(), "没有进行中的合并");
}

// ------------------------------ B14 不支持的进行中状态 ------------------------------

#[test]
fn b14_external_rebase_cherry_pick_revert_and_bisect_block_every_new_write() {
    let r = remote_setup();
    let p = r.local.as_path();
    git_in(p, &["switch", "-qc", "topic"]);
    let topic = commit(p, "a.txt", "topic\n", "topic");
    git_in(p, &["switch", "-q", "main"]);
    commit(p, "a.txt", "main\n", "main");
    let h = Harness::new(p);
    let requests = || {
        vec![
            pull(PullMode::FfOnly),
            OperationRequest::Push { remote: Some("origin".into()) },
            OperationRequest::Merge { target: "refs/heads/topic".into(), expected: topic.clone(), no_ff: false },
            OperationRequest::MergeCommit { message: "x".into() },
            OperationRequest::Fetch { remote: "origin".into() },
            OperationRequest::BranchSwitch { name: "refs/heads/topic".into(), stash_first: false, stash_untracked: false },
            OperationRequest::StashPush { message: None, include_untracked: false, path_ids: None },
            OperationRequest::Commit { message: "x".into(), amend: false, keep_message: false, expected_head: None },
        ]
    };
    let states: Vec<(&str, Box<dyn Fn()>, Box<dyn Fn()>)> = vec![
        ("rebase", Box::new(|| { let _ = run_git(p, &["rebase", "topic"]); }), Box::new(|| { git_in(p, &["rebase", "--abort"]); })),
        ("cherry-pick", Box::new(|| { let _ = run_git(p, &["cherry-pick", "topic"]); }), Box::new(|| { git_in(p, &["cherry-pick", "--abort"]); })),
        ("revert", Box::new(|| { let _ = run_git(p, &["revert", "--no-edit", "HEAD"]); commit(p, "a.txt", "conflict\n", "c"); let _ = run_git(p, &["revert", "--no-edit", "HEAD~1"]); }), Box::new(|| { let _ = run_git(p, &["revert", "--abort"]); })),
        ("bisect", Box::new(|| { git_in(p, &["bisect", "start"]); }), Box::new(|| { git_in(p, &["bisect", "reset"]); })),
    ];
    for (name, enter, leave) in states {
        enter();
        let snapshot = h.adapter.snapshot_v2("s".into(), CompareScope::Unstaged, false).unwrap();
        let text = serde_json::to_string(&snapshot).unwrap();
        let key = match name { "cherry-pick" => "\"cherryPick\":true".to_owned(), other => format!("\"{other}\":true") };
        assert!(text.contains(&key), "{name} 应被识别：{text}");
        let before = fingerprint(p);
        for request in requests() {
            let kind = request.kind();
            let error = h.try_run(request).unwrap_err();
            assert!(matches!(&error, GitError::WriteBlocked(m) if m.contains(name)), "{name} / {kind}: {error}");
        }
        assert_eq!(fingerprint(p), before, "{name}：仓库未被改动");
        leave();
    }
}

#[test]
fn b11_long_refusal_lists_are_still_recognised_as_local_changes() {
    // 回归：Git 列出的文件很多时，“Your local changes … would be overwritten”提示被挤出错误尾部（只保留最后 12 行）。
    let r = remote_setup();
    for i in 0..30 {
        write(&r.other, &format!("many/f{i:02}.txt"), "base\n");
    }
    git_in(&r.other, &["add", "-A"]);
    git_in(&r.other, &["commit", "-qm", "many"]);
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    git_in(&r.local, &["pull", "-q", "--no-rebase"]);
    for i in 0..30 {
        write(&r.other, &format!("many/f{i:02}.txt"), "remote\n");
        write(&r.local, &format!("many/f{i:02}.txt"), "local edit\n");
    }
    git_in(&r.other, &["commit", "-qam", "remote edits many"]);
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    let outcome = Harness::new(&r.local).run(pull(PullMode::FfOnly));
    assert_eq!(outcome.status, OpStatus::NeedsConfirmation, "{}", outcome.message);
    let confirmation = outcome.confirmation.unwrap();
    assert_eq!(confirmation.reason, "localChanges");
    assert_eq!(confirmation.paths.len(), 30, "{:?}", confirmation.paths);
}
