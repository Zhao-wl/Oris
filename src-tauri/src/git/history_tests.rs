//! 任务 04 预制模块测试：全部在真实临时仓库中进行，并断言读取前后仓库不变。
use super::log::{self, ChangeStatus, LogQuery, SearchQuery};
use super::refs::{self, Tracking};
use super::*;

fn git_env(root: &Path, args: &[&str], date: Option<&str>) -> Vec<u8> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
        .args(args)
        .env("GIT_AUTHOR_NAME", "Alice")
        .env("GIT_AUTHOR_EMAIL", "alice@example.invalid")
        .env("GIT_COMMITTER_NAME", "Alice")
        .env("GIT_COMMITTER_EMAIL", "alice@example.invalid");
    if let Some(date) = date {
        command.env("GIT_AUTHOR_DATE", date).env("GIT_COMMITTER_DATE", date);
    }
    let output = command.output().unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    output.stdout
}
fn git(root: &Path, args: &[&str]) -> String {
    String::from_utf8(git_env(root, args, None)).unwrap().trim().to_owned()
}
fn init() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    dir
}
fn commit(root: &Path, file: &str, content: &str, message: &str, n: usize) -> String {
    let path = root.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    git(root, &["add", "-A"]);
    git_env(root, &["commit", "-qm", message], Some(&format!("{} +0000", 1_700_000_000 + n * 60)));
    git(root, &["rev-parse", "HEAD"])
}
fn gp() -> &'static Path {
    Path::new("git")
}
fn state(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_path_buf();
            if rel.starts_with(".git/objects") || rel.starts_with(".git/logs") {
                continue;
            }
            if entry.file_type().unwrap().is_dir() {
                stack.push(path);
            } else {
                entries.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    entries.sort();
    entries
}

#[test]
fn linear_history_pages_keep_identity_when_refs_move() {
    let dir = init();
    let p = dir.path();
    let mut oids = Vec::new();
    for n in 0..25 {
        oids.push(commit(p, "file.txt", &format!("{n}\n"), &format!("commit {n}\n\nbody line {n}"), n));
    }
    oids.reverse();
    let before = state(p);
    let query = LogQuery { refs: vec!["refs/heads/main".into()], search: None, page_size: 10 };
    let first = log::read_log(gp(), p, &query, None).unwrap();
    assert_eq!(first.commits.iter().map(|c| c.oid.clone()).collect::<Vec<_>>(), oids[..10]);
    assert_eq!(first.commits[0].subject, "commit 24");
    assert_eq!(first.commits[0].body, "body line 24");
    assert_eq!(first.commits[0].author_name, "Alice");
    assert_eq!(first.commits[0].parents, vec![oids[1].clone()]);
    assert!(first.commits[0].refs.iter().any(|r| r.name == "refs/heads/main" && r.current));
    let cursor = first.next.clone().unwrap();
    // 分页期间分支前进：后续页仍基于第一页固定的 OID，已显示提交的身份不变。
    let after_state = state(p);
    assert_eq!(before, after_state);
    commit(p, "file.txt", "moved\n", "moved on", 99);
    let second = log::read_log(gp(), p, &query, Some(&cursor)).unwrap();
    assert_eq!(second.commits.iter().map(|c| c.oid.clone()).collect::<Vec<_>>(), oids[10..20]);
    let third = log::read_log(gp(), p, &query, second.next.as_ref()).unwrap();
    assert_eq!(third.commits.len(), 5);
    assert!(third.next.is_none());
    assert!(third.commits.last().unwrap().parents.is_empty(), "最后一条是根提交");
    let fresh = log::read_log(gp(), p, &query, None).unwrap();
    assert_eq!(fresh.commits[0].subject, "moved on");
}

#[test]
fn fork_merge_root_changes_and_parent_selection() {
    let dir = init();
    let p = dir.path();
    let root = commit(p, "base.txt", "base\n", "root", 0);
    git(p, &["switch", "-qc", "topic"]);
    commit(p, "topic.txt", "topic\n", "topic work", 1);
    git(p, &["switch", "-q", "main"]);
    commit(p, "main.txt", "main\n", "main work", 2);
    git_env(p, &["merge", "--no-ff", "-q", "-m", "merge topic", "topic"], Some("1700000300 +0000"));
    let merge = git(p, &["rev-parse", "HEAD"]);
    let first_parent = git(p, &["rev-parse", "HEAD^1"]);
    let second_parent = git(p, &["rev-parse", "HEAD^2"]);
    let before = state(p);
    let page = log::read_log(gp(), p, &LogQuery { refs: vec![], search: None, page_size: 50 }, None).unwrap();
    assert_eq!(page.commits.len(), 4);
    let merge_info = page.commits.iter().find(|c| c.oid == merge).unwrap();
    assert_eq!(merge_info.parents, vec![first_parent.clone(), second_parent.clone()]);
    // 拓扑顺序：子提交总在父提交之前。
    let position = |oid: &str| page.commits.iter().position(|c| c.oid == oid).unwrap();
    for c in &page.commits {
        for parent in &c.parents {
            assert!(position(&c.oid) < position(parent));
        }
    }
    let against_first = log::commit_changes(gp(), p, &merge, None).unwrap();
    assert_eq!(against_first.parent.as_deref(), Some(first_parent.as_str()));
    assert_eq!(against_first.files.iter().map(|f| (f.path.as_str(), f.status.clone())).collect::<Vec<_>>(), vec![("topic.txt", ChangeStatus::Added)]);
    let against_second = log::commit_changes(gp(), p, &merge, Some(&second_parent)).unwrap();
    assert_eq!(against_second.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["main.txt"]);
    assert!(log::commit_changes(gp(), p, &merge, Some(&root)).is_err(), "非父节点必须拒绝");
    let root_changes = log::commit_changes(gp(), p, &root, None).unwrap();
    assert_eq!(root_changes.parent, None);
    assert_eq!(root_changes.files.iter().map(|f| (f.path.as_str(), f.status.clone())).collect::<Vec<_>>(), vec![("base.txt", ChangeStatus::Added)]);
    assert!(log::resolve_commit(gp(), p, "--output=x").is_err());
    assert_eq!(before, state(p));
}

#[test]
fn search_by_author_message_sha_and_branch_filter() {
    let dir = init();
    let p = dir.path();
    commit(p, "a.txt", "1\n", "feat: first", 0);
    fs::write(p.join("b.txt"), "2\n").unwrap();
    git(p, &["add", "-A"]);
    let bob = Command::new("git")
        .arg("-C")
        .arg(p)
        .args(["-c", "commit.gpgsign=false", "commit", "-qm", "fix(ui): Bob [brackets] and *stars*"])
        .env("GIT_AUTHOR_NAME", "Bob Builder")
        .env("GIT_AUTHOR_EMAIL", "bob@example.invalid")
        .env("GIT_COMMITTER_NAME", "Bob Builder")
        .env("GIT_COMMITTER_EMAIL", "bob@example.invalid")
        .output()
        .unwrap();
    assert!(bob.status.success());
    let bob_oid = git(p, &["rev-parse", "HEAD"]);
    git(p, &["tag", "v1.0"]);
    git(p, &["switch", "-qc", "side"]);
    let side = commit(p, "c.txt", "3\n", "side only", 2);
    git(p, &["switch", "-q", "main"]);
    let search = |q: SearchQuery| log::read_log(gp(), p, &LogQuery { refs: vec![], search: Some(q), page_size: 20 }, None).unwrap();
    assert_eq!(search(SearchQuery::Author("bob".into())).commits.iter().map(|c| c.oid.clone()).collect::<Vec<_>>(), vec![bob_oid.clone()]);
    let message = search(SearchQuery::Message("fix(ui): bob [brackets]".into()));
    assert_eq!(message.commits.len(), 1, "按字面量匹配，不把括号当正则");
    assert!(message.commits[0].refs.iter().any(|r| r.name == "refs/tags/v1.0"));
    assert_eq!(search(SearchQuery::Sha(bob_oid[..8].into())).commits[0].oid, bob_oid);
    assert!(log::read_log(gp(), p, &LogQuery { refs: vec![], search: Some(SearchQuery::Sha("xyz".into())), page_size: 5 }, None).is_err());
    let main_only = log::read_log(gp(), p, &LogQuery { refs: vec!["refs/heads/main".into()], search: None, page_size: 20 }, None).unwrap();
    assert!(!main_only.commits.iter().any(|c| c.oid == side));
    let side_only = log::read_log(gp(), p, &LogQuery { refs: vec!["refs/heads/side".into()], search: None, page_size: 20 }, None).unwrap();
    assert_eq!(side_only.commits[0].oid, side);
    // 选择分支只筛选历史，不切换工作分支。
    assert_eq!(git(p, &["branch", "--show-current"]), "main");
}

#[test]
fn file_history_marks_rename_boundaries_and_origin() {
    let dir = init();
    let p = dir.path();
    let body = "line one\nline two\nline three\nline four\nline five\n";
    commit(p, "docs/a.txt", body, "add a", 0);
    commit(p, "docs/a.txt", &format!("{body}six\n"), "edit a", 1);
    git(p, &["mv", "docs/a.txt", "docs/b.txt"]);
    git_env(p, &["commit", "-qm", "rename a to b"], Some("1700000200 +0000"));
    commit(p, "docs/b.txt", &format!("{body}six\nseven\n"), "edit b", 3);
    commit(p, "other.txt", "x\n", "unrelated", 4);
    let history = log::file_history(gp(), p, "HEAD", "docs/b.txt", 50, None).unwrap();
    let rows: Vec<_> = history.entries.iter().map(|e| (e.commit.subject.as_str(), e.path.as_str(), e.renamed_from.as_deref())).collect();
    assert_eq!(rows, vec![("edit b", "docs/b.txt", None), ("rename a to b", "docs/b.txt", Some("docs/a.txt")), ("edit a", "docs/a.txt", None), ("add a", "docs/a.txt", None)]);
    assert!(history.reached_origin);
    let first = log::file_history(gp(), p, "HEAD", "docs/b.txt", 2, None).unwrap();
    assert_eq!(first.entries.len(), 2);
    assert!(!first.reached_origin && first.next.is_some());
    let rest = log::file_history(gp(), p, "HEAD", "docs/b.txt", 2, first.next.as_ref()).unwrap();
    assert_eq!(rest.entries.iter().map(|e| e.commit.subject.as_str()).collect::<Vec<_>>(), vec!["edit a", "add a"]);
    assert!(rest.reached_origin);
    assert!(log::file_history(gp(), p, "HEAD", "../outside", 5, None).is_err());
}

#[test]
fn compare_pins_endpoints_and_swaps_direction() {
    let dir = init();
    let p = dir.path();
    commit(p, "shared.txt", "shared\n", "base", 0);
    git(p, &["switch", "-qc", "topic"]);
    commit(p, "topic.txt", "topic\n", "topic", 1);
    let topic_before = git(p, &["rev-parse", "topic"]);
    git(p, &["switch", "-q", "main"]);
    commit(p, "main.txt", "main\n", "main", 2);
    let comparison = log::compare(gp(), p, "refs/heads/main", "refs/heads/topic").unwrap();
    assert_eq!(comparison.right, topic_before);
    let mut files: Vec<_> = comparison.files.iter().map(|f| (f.path.clone(), f.status.clone())).collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(files, vec![("main.txt".into(), ChangeStatus::Deleted), ("topic.txt".into(), ChangeStatus::Added)]);
    git(p, &["switch", "-q", "topic"]);
    commit(p, "later.txt", "later\n", "topic moved", 3);
    git(p, &["switch", "-q", "main"]);
    let swapped = comparison.swapped(gp(), p).unwrap();
    assert_eq!(swapped.left, topic_before, "交换方向仍使用已固定的 OID，不读取移动后的 ref");
    assert!(swapped.files.iter().any(|f| f.path == "main.txt" && f.status == ChangeStatus::Added));
    assert!(!swapped.files.iter().any(|f| f.path == "later.txt"));
    assert_ne!(log::compare(gp(), p, "refs/heads/main", "refs/heads/topic").unwrap().right, topic_before);
}

#[test]
fn upstream_states_use_real_reachability_and_never_fake_zero() {
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = remote_dir.path().join("remote.git");
    git(remote_dir.path(), &["init", "-q", "--bare", "-b", "main", &remote.to_string_lossy()]);
    let dir = init();
    let p = dir.path();
    commit(p, "a.txt", "a\n", "base", 0);
    git(p, &["remote", "add", "origin", &remote.to_string_lossy()]);
    git(p, &["push", "-q", "-u", "origin", "main"]);
    for branch in ["ahead", "behind", "diverged", "feature"] {
        git(p, &["switch", "-qc", branch]);
        git(p, &["push", "-q", "-u", "origin", branch]);
    }
    git(p, &["switch", "-qc", "local-only"]);
    // ahead：本地多一个提交。
    git(p, &["switch", "-q", "ahead"]);
    commit(p, "ahead.txt", "1\n", "ahead", 1);
    // behind / diverged：通过另一个克隆推进远端。
    let other = tempfile::tempdir().unwrap();
    let clone = other.path().join("clone");
    git(other.path(), &["clone", "-q", &remote.to_string_lossy(), &clone.to_string_lossy()]);
    for branch in ["behind", "diverged"] {
        git(&clone, &["switch", "-q", branch]);
        commit(&clone, &format!("{branch}-remote.txt"), "r\n", "remote work", 2);
        commit(&clone, &format!("{branch}-remote2.txt"), "r\n", "remote work 2", 3);
        git(&clone, &["push", "-q", "origin", branch]);
    }
    git(&clone, &["push", "-q", "origin", "--delete", "feature"]);
    git(p, &["switch", "-q", "diverged"]);
    commit(p, "diverged-local.txt", "l\n", "local work", 4);
    git(p, &["fetch", "-q", "--prune", "origin"]);
    git(p, &["switch", "-q", "main"]);
    let before = state(p);
    let snapshot = refs::read_refs(gp(), p).unwrap();
    assert_eq!(before, state(p), "读取引用不改变仓库");
    let tracking = |name: &str| snapshot.local.iter().find(|b| b.name == name).unwrap().tracking.clone().unwrap();
    let counts = |name: &str| {
        let text = git(p, &["rev-list", "--left-right", "--count", &format!("{name}...{name}@{{u}}")]);
        let mut parts = text.split_whitespace().map(|n| n.parse::<u64>().unwrap());
        (parts.next().unwrap(), parts.next().unwrap())
    };
    assert_eq!(tracking("main"), Tracking::Known { upstream: "refs/remotes/origin/main".into(), ahead: 0, behind: 0 });
    for name in ["ahead", "behind", "diverged"] {
        let (ahead, behind) = counts(name);
        assert_eq!(tracking(name), Tracking::Known { upstream: format!("refs/remotes/origin/{name}"), ahead, behind });
    }
    assert_eq!(counts("ahead"), (1, 0));
    assert_eq!(counts("behind"), (0, 2));
    assert_eq!(counts("diverged"), (1, 2));
    assert_eq!(tracking("feature"), Tracking::Gone { upstream: "refs/remotes/origin/feature".into() });
    assert_eq!(tracking("local-only"), Tracking::NoUpstream);
    assert!(snapshot.local.iter().find(|b| b.name == "main").unwrap().current);
    assert!(snapshot.remote.iter().any(|b| b.name == "origin/main"));
    assert!(!snapshot.remote.iter().any(|b| b.name == "origin/HEAD"));
    assert!(!snapshot.head.detached && !snapshot.head.unborn);
    assert_eq!(refs::parse_track(""), Some(Ok((0, 0))));
    assert_eq!(refs::parse_track("gone"), None);
    assert_eq!(refs::parse_track("ahead 3, behind 4"), Some(Ok((3, 4))));
    assert_eq!(refs::parse_track("weird"), None);
    // detached 与空仓库。
    git(p, &["switch", "-q", "--detach", "HEAD"]);
    let detached = refs::read_refs(gp(), p).unwrap();
    assert!(detached.head.detached && detached.head.branch.is_none());
    let empty = init();
    let unborn = refs::read_refs(gp(), empty.path()).unwrap();
    assert!(unborn.head.unborn && unborn.local.is_empty());
    // 浅克隆：领先 / 落后记为未知而不是数字。
    let shallow_dir = tempfile::tempdir().unwrap();
    let shallow = shallow_dir.path().join("shallow");
    git(shallow_dir.path(), &["clone", "-q", "--depth", "1", &format!("file://{}", remote.to_string_lossy().replace('\\', "/")), &shallow.to_string_lossy()]);
    let shallow_refs = refs::read_refs(gp(), &shallow).unwrap();
    assert!(shallow_refs.shallow);
    assert!(matches!(shallow_refs.local[0].tracking, Some(Tracking::Unknown { .. })));
}

#[test]
fn read_refs_lists_tags_peeled_to_commits() {
    let dir = init();
    let p = dir.path();
    let first = commit(p, "a.txt", "a
", "one", 0);
    let second = commit(p, "a.txt", "b
", "two", 1);
    git(p, &["tag", "light", &first]);
    git_env(p, &["tag", "-a", "-m", "release", "v1.0"], Some("1700000600 +0000"));
    let tree = git(p, &["rev-parse", "HEAD^{tree}"]);
    git(p, &["tag", "tree-tag", &tree]);
    let before = state(p);
    let snapshot = refs::read_refs(gp(), p).unwrap();
    assert_eq!(before, state(p));
    let tag = |name: &str| snapshot.tags.iter().find(|t| t.name == name).cloned();
    let light = tag("light").unwrap();
    assert_eq!((light.full_name.as_str(), light.oid.as_str(), light.annotated), ("refs/tags/light", first.as_str(), false));
    let annotated = tag("v1.0").unwrap();
    assert_eq!((annotated.oid.as_str(), annotated.annotated), (second.as_str(), true), "附注标签解引用到提交");
    assert!(tag("tree-tag").is_none(), "不指向提交的标签不列出");
    assert!(snapshot.local.iter().all(|b| !b.full_name.starts_with("refs/tags/")));
}

#[test]
fn history_reads_never_run_signature_programs_or_change_the_repository() {
    let dir = init();
    let p = dir.path();
    commit(p, "a.txt", "a\n", "one", 0);
    commit(p, "a.txt", "b\n", "two", 1);
    let marker = p.join("gpg-marker.txt");
    let script = p.join(if cfg!(windows) { "gpg.cmd" } else { "gpg.sh" });
    if cfg!(windows) {
        fs::write(&script, format!("@echo off\r\necho ran> \"{}\"\r\n", marker.display())).unwrap();
    } else {
        fs::write(&script, format!("#!/bin/sh\necho ran > '{}'\n", marker.display())).unwrap();
        let _ = Command::new("chmod").arg("+x").arg(&script).status();
    }
    git(p, &["config", "log.showSignature", "true"]);
    git(p, &["config", "gpg.program", &script.to_string_lossy()]);
    git(p, &["config", "diff.external", &script.to_string_lossy()]);
    let before = state(p);
    let page = log::read_log(gp(), p, &LogQuery { refs: vec![], search: None, page_size: 10 }, None).unwrap();
    log::commit_changes(gp(), p, &page.commits[0].oid, None).unwrap();
    log::file_history(gp(), p, "HEAD", "a.txt", 10, None).unwrap();
    log::compare(gp(), p, "HEAD~1", "HEAD").unwrap();
    refs::read_refs(gp(), p).unwrap();
    assert!(!marker.exists(), "签名 / 外部 diff 程序被执行");
    assert_eq!(before, state(p));
}

// ------------------------------ 任务 04 接入：按提交读取两端内容（A09） ------------------------------

fn pid(path: &str) -> String {
    URL_SAFE_NO_PAD.encode(path.as_bytes())
}

fn open_adapter(p: &Path) -> GitAdapter {
    GitAdapter::open(p.to_string_lossy().into_owned(), None).unwrap()
}

#[test]
fn tree_entry_maps_commit_and_path_to_the_object_oid() {
    let dir = init();
    let p = dir.path();
    let first = commit(p, "dir/中文 name.txt", "one\n", "one", 0);
    let second = commit(p, "dir/中文 name.txt", "two\n", "two", 1);
    let adapter = open_adapter(p);
    for oid in [&first, &second] {
        let entry = adapter.tree_entry(oid, "dir/中文 name.txt").unwrap().unwrap();
        assert_eq!(entry.oid, git(p, &["rev-parse", &format!("{oid}:dir/中文 name.txt")]));
        assert_eq!(entry.mode, "100644");
    }
    assert!(adapter.tree_entry(&second, "missing.txt").unwrap().is_none());
    assert!(adapter.tree_entry(&second, "dir").unwrap().is_some_and(|e| e.mode == "040000"), "目录不是可读取的文件");
    assert!(adapter.tree_entry("HEAD", "dir/中文 name.txt").is_err(), "只接受已固定的 OID");
    assert!(adapter.tree_entry(&second, "../x").is_err());
}

#[test]
fn revision_pairs_cover_root_parents_rename_and_images_without_touching_index_stages() {
    use image::{DynamicImage, ImageFormat, RgbaImage};
    let png = |w: u32| {
        let mut output = std::io::Cursor::new(vec![]);
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, 2, image::Rgba([w as u8, 9, 9, 255]))).write_to(&mut output, ImageFormat::Png).unwrap();
        output.into_inner()
    };
    let dir = init();
    let p = dir.path();
    fs::write(p.join("pic.png"), png(2)).unwrap();
    let root = commit(p, "shared.txt", "base\n", "root", 0);
    git(p, &["switch", "-qc", "topic"]);
    fs::write(p.join("pic.png"), png(5)).unwrap();
    commit(p, "shared.txt", "topic side\n", "topic", 1);
    git(p, &["switch", "-q", "main"]);
    commit(p, "shared.txt", "main side\n", "main", 2);
    let merged = Command::new("git").arg("-C").arg(p).args(["-c", "commit.gpgsign=false", "merge", "-q", "topic"]).output().unwrap();
    assert!(!merged.status.success(), "夹具需要冲突");
    fs::write(p.join("shared.txt"), "resolved\n").unwrap();
    git(p, &["add", "-A"]);
    git_env(p, &["commit", "-qm", "merge topic"], Some("1700000300 +0000"));
    let merge = git(p, &["rev-parse", "HEAD"]);
    let (first, second) = (git(p, &["rev-parse", "HEAD^1"]), git(p, &["rev-parse", "HEAD^2"]));
    git(p, &["mv", "shared.txt", "renamed.txt"]);
    let renamed = commit(p, "renamed.txt", "resolved\n", "rename", 4);
    // 当前 index 再制造一个 shared.txt / renamed.txt 的冲突：历史读取不得用这些 stage 冒充。
    git(p, &["switch", "-qc", "later", &first]);
    commit(p, "renamed.txt", "conflict A\n", "later", 5);
    git(p, &["switch", "-q", "main"]);
    let conflicted = Command::new("git").arg("-C").arg(p).args(["-c", "commit.gpgsign=false", "merge", "-q", "later"]).output().unwrap();
    assert!(!conflicted.status.success());
    assert!(!git(p, &["ls-files", "-u"]).is_empty(), "index 中应有冲突 stage");
    let before = state(p);
    let adapter = open_adapter(p);
    let read = |left: Option<&str>, right: &str, path: &str, old: Option<&str>| {
        adapter.read_revision_pair("r".into(), left, right, &pid(path), old.map(pid).as_deref(), || false).unwrap()
    };
    // 根提交相对空树。
    let root_pair = read(None, &root, "shared.txt", None);
    assert_eq!((root_pair.left.endpoint, root_pair.left.encoding), ("emptyTree", "missing"));
    assert_eq!(root_pair.right.text.as_deref(), Some("base\n"));
    // 合并提交：分别相对两个父节点。
    let against_first = read(Some(&first), &merge, "shared.txt", None);
    assert_eq!((against_first.left.text.as_deref(), against_first.right.text.as_deref()), (Some("main side\n"), Some("resolved\n")));
    let against_second = read(Some(&second), &merge, "shared.txt", None);
    assert_eq!(against_second.left.text.as_deref(), Some("topic side\n"));
    assert_eq!(against_second.right.details.as_ref().and_then(|d| d.oid.clone()), Some(git(p, &["rev-parse", &format!("{merge}:shared.txt")])));
    // rename：左侧按原路径读取。
    let rename_pair = read(Some(&merge), &renamed, "renamed.txt", Some("shared.txt"));
    assert_eq!((rename_pair.left.text.as_deref(), rename_pair.right.text.as_deref()), (Some("resolved\n"), Some("resolved\n")));
    // 右侧提交中不存在（删除）：记为缺失，不伪造空文件。
    let deleted = read(Some(&merge), &renamed, "shared.txt", None);
    assert_eq!((deleted.left.encoding, deleted.right.encoding), ("utf-8", "missing"));
    // 图片走图片阅读器：两端都带解码后的尺寸。
    let image = read(Some(&first), &merge, "pic.png", None);
    let size = |side: &TextSide| side.details.as_ref().and_then(|d| d.image.as_ref()).map(|i| (i.width, i.height));
    assert_eq!((size(&image.left), size(&image.right)), (Some((2, 2)), Some((5, 2))));
    // 当前 index 的冲突 stage 与历史读取无关：内容来自提交树。
    let theirs = git(p, &["rev-parse", ":3:renamed.txt"]);
    let history_right = read(Some(&merge), &renamed, "renamed.txt", Some("shared.txt"));
    let oid = history_right.right.details.as_ref().and_then(|d| d.oid.clone()).unwrap();
    assert_eq!(oid, git(p, &["rev-parse", &format!("{renamed}:renamed.txt")]), "历史内容必须来自提交树");
    for pair in [&history_right, &against_first, &against_second] {
        for side in [&pair.left, &pair.right] {
            assert_ne!(side.details.as_ref().and_then(|d| d.oid.clone()), Some(theirs.clone()), "不得读取当前 index 的冲突 stage");
        }
    }
    assert_eq!(before, state(p), "历史读取不改变仓库");
}

#[test]
fn history_entry_points_accept_only_typed_references() {
    use super::history::validate_reference;
    for good in ["HEAD", "refs/heads/main", "refs/remotes/origin/feature/x", "refs/tags/v1.0", &"a".repeat(40)] {
        assert!(validate_reference(good).is_ok(), "{good}");
    }
    for bad in ["main", "--all", "-n1", "HEAD~1", "HEAD^2", "refs/heads/a..b", "refs/heads/", "a b", "HEAD:path", "refs/heads/x\nHEAD", "@{u}", &"a".repeat(39)] {
        assert!(validate_reference(bad).is_err(), "{bad}");
    }
    let dir = init();
    let p = dir.path();
    commit(p, "a.txt", "1\n", "one", 0);
    let adapter = open_adapter(p);
    assert!(adapter.history_log(&LogQuery { refs: vec!["--all".into()], search: None, page_size: 5 }, None).is_err());
    assert!(adapter.history_compare("HEAD", "--output=x").is_err());
    assert!(adapter.history_file("HEAD", &pid("../a.txt"), 5, None).is_err());
    let refs = adapter.history_refs().unwrap();
    assert_eq!(refs.default_remote, None, "无上游时不指定默认 remote");
    assert!(refs.refs.remotes.is_empty());
}

#[test]
fn file_history_includes_merges_that_changed_the_file_against_the_first_parent() {
    let dir = init();
    let p = dir.path();
    commit(p, "f.txt", "base\n", "base", 0);
    git(p, &["switch", "-qc", "topic"]);
    commit(p, "f.txt", "topic\n", "topic edit", 1);
    git(p, &["switch", "-q", "main"]);
    commit(p, "f.txt", "main\n", "main edit", 2);
    let merged = Command::new("git").arg("-C").arg(p).args(["-c", "commit.gpgsign=false", "merge", "-q", "topic"]).output().unwrap();
    assert!(!merged.status.success());
    fs::write(p.join("f.txt"), "resolved\n").unwrap();
    git(p, &["add", "-A"]);
    git_env(p, &["commit", "-qm", "merge topic"], Some("1700000300 +0000"));
    let history = log::file_history(gp(), p, "HEAD", "f.txt", 50, None).unwrap();
    let subjects: Vec<_> = history.entries.iter().map(|e| e.commit.subject.as_str()).collect();
    assert_eq!(subjects[0], "merge topic", "合并时解决冲突改动了文件，应出现在文件历史中：{subjects:?}");
    assert!(subjects.contains(&"topic edit") && subjects.contains(&"main edit") && subjects.contains(&"base"));
    assert!(history.reached_origin);
}
