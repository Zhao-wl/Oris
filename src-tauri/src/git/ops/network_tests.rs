//! 网络写操作测试（任务 04 A10 的 fetch；V2-04 的 pull / push 也放在这里）。全部使用临时目录中的本地 bare remote，
//! 每个用例比较操作前后的 index、HEAD 与 refs、config、工作区；认证失败用本地 HTTP 401 服务模拟，不访问外网。
use super::process::CancelHandle;
use super::*;
use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

fn git_in(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"])
        .args(args)
        .env("GIT_AUTHOR_NAME", "Net")
        .env("GIT_AUTHOR_EMAIL", "net@example.invalid")
        .env("GIT_COMMITTER_NAME", "Net")
        .env("GIT_COMMITTER_EMAIL", "net@example.invalid")
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    output.stdout
}

fn text(root: &Path, args: &[&str]) -> String {
    String::from_utf8_lossy(&git_in(root, args)).trim().to_owned()
}

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn commit(root: &Path, rel: &str, content: &str, message: &str) -> String {
    write(root, rel, content.as_bytes());
    git_in(root, &["add", "-A"]);
    git_in(root, &["commit", "-qm", message]);
    text(root, &["rev-parse", "HEAD"])
}

fn configure(root: &Path) {
    for (key, value) in [("user.name", "Net"), ("user.email", "net@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
        git_in(root, &["config", key, value]);
    }
}

/// 本地 bare remote + 两个克隆：`local` 交给 Oris，`other` 模拟另一位协作者。
struct Remote {
    _dir: tempfile::TempDir,
    bare: PathBuf,
    local: PathBuf,
    other: PathBuf,
}

fn remote_setup() -> Remote {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let bare = root.join("remote.git");
    let seed = root.join("seed");
    fs::create_dir_all(&seed).unwrap();
    git_in(&seed, &["init", "-q", "-b", "main"]);
    configure(&seed);
    commit(&seed, "a.txt", "base\n", "base");
    git_in(root, &["clone", "-q", "--bare", seed.to_str().unwrap(), bare.to_str().unwrap()]);
    let local = root.join("local");
    let other = root.join("other");
    for clone in [&local, &other] {
        git_in(root, &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
        configure(clone);
    }
    Remote { _dir: dir, bare, local, other }
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
        let mut ctx = OpContext::new(format!("net-{}-{}", std::process::id(), OPS.fetch_add(1, Ordering::SeqCst)), cancel, &self.store, &sink);
        if let Some(idle) = idle {
            ctx.network_idle = idle;
        }
        self.adapter.run_operation(request, CompareScope::Unstaged, &ctx)
    }
    fn run(&self, request: OperationRequest) -> OperationOutcome {
        self.run_with(request, Arc::new(CancelHandle::default()), None).unwrap()
    }
}

fn fetch(remote: &str) -> OperationRequest {
    OperationRequest::Fetch { remote: remote.into() }
}

/// 仓库指纹（不含 objects / logs / hooks）：键为相对路径。
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

/// 变化的类别：index / head（HEAD 与 refs/heads）/ remote-refs（refs/remotes、refs/tags、packed-refs）/ config / worktree / 其他 .git 文件。
fn changed(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> Vec<String> {
    let mut kinds = std::collections::BTreeSet::new();
    for key in before.keys().chain(after.keys()) {
        if before.get(key) == after.get(key) {
            continue;
        }
        kinds.insert(if key == ".git/index" {
            "index".to_owned()
        } else if key == ".git/HEAD" || key.starts_with(".git/refs/heads/") {
            "head".to_owned()
        } else if key.starts_with(".git/refs/remotes/") || key.starts_with(".git/refs/tags/") || key == ".git/packed-refs" {
            "remote-refs".to_owned()
        } else if key == ".git/config" {
            "config".to_owned()
        } else if let Some(rest) = key.strip_prefix(".git/") {
            format!("git:{rest}")
        } else {
            "worktree".to_owned()
        });
    }
    kinds.into_iter().collect()
}

// ------------------------------ A10：显式 fetch ------------------------------

#[test]
fn a10_fetch_updates_remote_tracking_refs_only_and_never_prunes() {
    let r = remote_setup();
    // 远端先有一个分支，本地获取到 origin/gone；之后远端删除它、main 前进。
    git_in(&r.other, &["push", "-q", "origin", "HEAD:refs/heads/gone"]);
    git_in(&r.local, &["fetch", "-q"]);
    let new_main = commit(&r.other, "b.txt", "remote work\n", "remote work");
    git_in(&r.other, &["push", "-q", "origin", "main", ":gone"]);
    // 用户配置要求 prune：Oris 仍以 --no-prune 执行。
    git_in(&r.local, &["config", "fetch.prune", "true"]);
    git_in(&r.local, &["config", "remote.origin.prune", "true"]);
    let head_before = text(&r.local, &["rev-parse", "HEAD"]);
    let before = fingerprint(&r.local);
    let h = Harness::new(&r.local);
    let outcome = h.run(fetch("origin"));
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(outcome.message.contains("有更新"), "{}", outcome.message);
    assert_eq!(outcome.git_processes, 1);
    let after = fingerprint(&r.local);
    let kinds = changed(&before, &after);
    assert!(kinds.iter().all(|k| k == "remote-refs" || k == "git:FETCH_HEAD"), "{kinds:?}");
    assert!(kinds.contains(&"remote-refs".to_owned()));
    assert_eq!(text(&r.local, &["rev-parse", "refs/remotes/origin/main"]), new_main);
    assert!(text(&r.local, &["for-each-ref", "refs/remotes/origin/gone"]).contains("gone"), "不应 prune");
    assert_eq!(text(&r.local, &["rev-parse", "HEAD"]), head_before, "fetch 不改 HEAD / 工作分支");
    // 再次获取：没有变化，也如实说明。
    let again = h.run(fetch("origin"));
    assert_eq!(again.status, OpStatus::Succeeded);
    assert!(again.message.contains("没有新的变化"), "{}", again.message);
}

#[test]
fn a10_fetch_does_not_recurse_into_submodules() {
    let r = remote_setup();
    let sub_seed = r.bare.parent().unwrap().join("sub-seed");
    fs::create_dir_all(&sub_seed).unwrap();
    git_in(&sub_seed, &["init", "-q", "-b", "main"]);
    configure(&sub_seed);
    commit(&sub_seed, "s.txt", "s\n", "s");
    git_in(&r.local, &["submodule", "add", "-q", sub_seed.to_str().unwrap(), "sub"]);
    git_in(&r.local, &["commit", "-qm", "add sub"]);
    // 子模块的 remote 指向不存在的位置：若 fetch 递归进子模块，会看到 “Fetching submodule” 并失败。
    git_in(&r.local.join("sub"), &["remote", "set-url", "origin", r.bare.parent().unwrap().join("missing.git").to_str().unwrap()]);
    git_in(&r.local, &["config", "fetch.recurseSubmodules", "true"]);
    let plain = Command::new("git").arg("-C").arg(&r.local).args(["fetch", "origin"]).output().unwrap();
    assert!(String::from_utf8_lossy(&plain.stderr).contains("Fetching submodule"), "夹具应能触发递归：{}", String::from_utf8_lossy(&plain.stderr));
    let before = fingerprint(&r.local);
    let outcome = Harness::new(&r.local).run(fetch("origin"));
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert!(!outcome.output.contains("Fetching submodule"), "{}", outcome.output);
    let kinds = changed(&before, &fingerprint(&r.local));
    assert!(kinds.iter().all(|k| k == "remote-refs" || k.starts_with("git:FETCH_HEAD")), "{kinds:?}");
}

#[test]
fn a10_unknown_remote_is_rejected_before_any_git_process() {
    let r = remote_setup();
    let before = fingerprint(&r.local);
    let h = Harness::new(&r.local);
    for bad in ["upstream", "--upload-pack=touch", ""] {
        let error = h.run_with(fetch(bad), Arc::new(CancelHandle::default()), None).unwrap_err();
        assert!(matches!(error, GitError::WriteBlocked(_)), "{bad}: {error}");
    }
    assert_eq!(fingerprint(&r.local), before);
}

/// 让 upload-pack 先静默 `seconds` 秒再写标记文件：用于超时与取消（标记不存在说明整棵进程树已被结束）。
fn slow_upload_pack(r: &Remote, seconds: u32) -> PathBuf {
    let marker = r.bare.parent().unwrap().join(format!("upload-pack-finished-{seconds}"));
    let script = r.bare.parent().unwrap().join(format!("slow-upload-pack-{seconds}.sh"));
    let marker_text = marker.to_string_lossy().replace('\\', "/");
    fs::write(&script, format!("#!/bin/sh\nsleep {seconds}\necho done > '{marker_text}'\nexec git-upload-pack \"$@\"\n")).unwrap();
    git_in(&r.local, &["config", "remote.origin.uploadpack", &script.to_string_lossy().replace('\\', "/")]);
    marker
}

#[test]
fn a10_no_output_timeout_ends_the_process_tree_and_reports_refs() {
    let r = remote_setup();
    commit(&r.other, "b.txt", "x\n", "x");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    let marker = slow_upload_pack(&r, 6);
    let before = fingerprint(&r.local);
    let started = Instant::now();
    let outcome = Harness::new(&r.local).run_with(fetch("origin"), Arc::new(CancelHandle::default()), Some(Duration::from_millis(1500))).unwrap();
    assert_eq!(outcome.status, OpStatus::Failed, "{}", outcome.message);
    assert!(outcome.message.contains("没有任何输出") && outcome.message.contains("远端跟踪引用没有变化"), "{}", outcome.message);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    std::thread::sleep(Duration::from_secs(7));
    assert!(!marker.exists(), "超时后 upload-pack 进程应已被结束");
    let kinds = changed(&before, &fingerprint(&r.local));
    assert!(kinds.iter().all(|k| k.starts_with("git:")), "{kinds:?}");
}

#[test]
fn a10_cancel_ends_the_process_tree_and_reports_refs() {
    let r = remote_setup();
    let marker = slow_upload_pack(&r, 6);
    let before = fingerprint(&r.local);
    let cancel = Arc::new(CancelHandle::default());
    let trigger = cancel.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        trigger.cancel();
    });
    let started = Instant::now();
    let outcome = Harness::new(&r.local).run_with(fetch("origin"), cancel, None).unwrap();
    canceller.join().unwrap();
    assert_eq!(outcome.status, OpStatus::Cancelled, "{}", outcome.message);
    assert!(outcome.message.contains("已取消获取 origin") && outcome.message.contains("已重新读取实际引用"), "{}", outcome.message);
    assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
    assert!(outcome.snapshot.is_some(), "取消后应重新读取状态");
    std::thread::sleep(Duration::from_secs(7));
    assert!(!marker.exists(), "取消后 upload-pack 进程应已被结束");
    let kinds = changed(&before, &fingerprint(&r.local));
    assert!(kinds.iter().all(|k| k.starts_with("git:")), "{kinds:?}");
}

/// 本地 HTTP 服务：对每个请求都回 401（要求 Basic 认证），用于模拟认证失败；只监听 127.0.0.1。
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
fn a10_authentication_failure_is_explained_without_prompting_and_credentials_are_redacted() {
    let r = remote_setup();
    let (base, stop) = unauthorized_server();
    // 清空凭据助手（空值重置上层配置的助手列表），避免测试调用本机 GCM / store。
    git_in(&r.local, &["config", "credential.helper", ""]);
    let before = fingerprint(&r.local);
    for (url, secret) in [(format!("{base}/repo.git"), None), (format!("{}/repo.git", base.replacen("http://", "http://alice:s3cret-token@", 1)), Some("s3cret-token"))] {
        git_in(&r.local, &["remote", "set-url", "origin", &url]);
        let before_url = fingerprint(&r.local);
        let started = Instant::now();
        let outcome = Harness::new(&r.local).run(fetch("origin"));
        assert_eq!(outcome.status, OpStatus::Failed, "{}", outcome.message);
        assert!(outcome.message.contains("认证失败") || outcome.message.contains("没有访问权限"), "{}", outcome.message);
        assert!(started.elapsed() < Duration::from_secs(20), "不应等待交互输入：{:?}", started.elapsed());
        if let Some(secret) = secret {
            assert!(!outcome.message.contains(secret) && !outcome.output.contains(secret), "凭据应脱敏：{}\n{}", outcome.message, outcome.output);
        }
        let kinds = changed(&before_url, &fingerprint(&r.local));
        assert!(kinds.iter().all(|k| k.starts_with("git:")), "{kinds:?}");
    }
    stop.store(true, Ordering::SeqCst);
    let _ = before;
}

#[test]
fn auth_hints_match_common_git_messages_only() {
    for message in [
        "fatal: Authentication failed for 'https://github.com/x/y.git/'",
        "git@github.com: Permission denied (publickey).",
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "Host key verification failed.",
        "remote: Repository not found.",
        "error: The requested URL returned error: 403",
    ] {
        assert!(network::auth_hint(message).is_some(), "{message}");
    }
    for message in ["Receiving objects: 100% (401/401), done.", "fatal: couldn't find remote ref main", "error: 4030 bytes"] {
        assert!(network::auth_hint(message).is_none(), "{message}");
    }
}

#[test]
fn v2_d38_fetch_is_allowed_while_an_external_index_lock_exists() {
    let r = remote_setup();
    let new_main = commit(&r.other, "b.txt", "remote\n", "remote work");
    git_in(&r.other, &["push", "-q", "origin", "main"]);
    let lock = r.local.join(".git/index.lock");
    fs::write(&lock, "held by test").unwrap();
    let outcome = Harness::new(&r.local).run(fetch("origin"));
    assert_eq!(outcome.status, OpStatus::Succeeded, "{}", outcome.message);
    assert_eq!(text(&r.local, &["rev-parse", "refs/remotes/origin/main"]), new_main);
    assert_eq!(fs::read_to_string(&lock).unwrap(), "held by test", "不删除、不改动外部锁");
}
