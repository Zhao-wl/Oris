//! 拓展 02：真实 Git 验收；所有对象、工作区、index、refs 在只读查询前后逐字节核验。
use super::*;
use crate::git::{
    blame::{BlameQuery, LineQuery},
    history_search::{Direction, SearchQuery},
    line_history::{LineHistoryQuery, Range},
};
use std::time::Instant;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .env("GIT_AUTHOR_NAME", "Trace Author")
        .env("GIT_AUTHOR_EMAIL", "trace@example.invalid")
        .env("GIT_COMMITTER_NAME", "Trace Author")
        .env("GIT_COMMITTER_EMAIL", "trace@example.invalid")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn init() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    dir
}
fn commit(root: &Path, path: &str, text: &str, title: &str) -> String {
    fs::write(root.join(path), text).unwrap();
    git(root, &["add", "--", path]);
    git(root, &["commit", "-qm", title]);
    git(root, &["rev-parse", "HEAD"])
}
fn adapter(root: &Path) -> GitAdapter {
    GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap()
}
fn source(oid: &str, path: &str, line: usize) -> LineQuery {
    LineQuery {
        path_id: URL_SAFE_NO_PAD.encode(path),
        revision: Some(oid.into()),
        contents: None,
        line,
    }
}
fn identity(text: &str) -> Option<Identity> {
    Some(Identity {
        content_id: Some(hash_bytes(text.as_bytes())),
        snapshot_revision: Some("reader-snapshot".into()),
        side: "b".into(),
    })
}
fn query(oid: &str, path: &str, line: usize) -> LineHistoryQuery {
    LineHistoryQuery {
        source: source(oid, path, line),
        identity: None,
        end_line: line,
        page_size: 20,
    }
}
fn search(text: &str) -> SearchQuery {
    SearchQuery {
        refs: vec!["refs/heads/main".into()],
        path_id: None,
        text: text.into(),
        direction: Direction::Both,
        page_size: 20,
        scan_budget: 30,
    }
}
fn state(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(root: &Path, path: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, files);
            } else {
                files.push((
                    path.strip_prefix(root).unwrap().into(),
                    fs::read(path).unwrap(),
                ));
            }
        }
    }
    let mut files = vec![];
    walk(root, root, &mut files);
    files.sort();
    files
}

#[test]
fn blame_matches_git_porcelain_pages_renames_and_snapshot_without_writes() {
    let dir = init();
    let root = dir.path();
    let original = commit(root, "源 文件.txt", "one\nold\nthree\nfour\n", "origin");
    git(root, &["mv", "源 文件.txt", "新 文件.txt"]);
    git(root, &["commit", "-qm", "rename"]);
    let head = commit(root, "新 文件.txt", "one\nnew\nthree\nfour\n", "modify");
    let adapter = adapter(root);
    let before = state(root);
    let q = BlameQuery {
        source: source(&head, "新 文件.txt", 1),
        identity: None,
        start: 1,
        page_size: 2,
    };
    let first = adapter.file_blame(&q, &|| false).unwrap();
    let expected = git(
        root,
        &[
            "blame",
            "--line-porcelain",
            "--root",
            &head,
            "--",
            "新 文件.txt",
        ],
    );
    let headers: Vec<_> = expected
        .lines()
        .filter_map(|l| {
            let f: Vec<_> = l.split_whitespace().collect();
            (f.len() >= 3 && f[0].len() == 40).then(|| {
                (
                    f[0].to_string(),
                    f[1].parse::<usize>().unwrap(),
                    f[2].parse::<usize>().unwrap(),
                )
            })
        })
        .collect();
    assert_eq!(first.next, Some(3));
    assert_eq!(first.rows[0].oid.as_deref(), Some(original.as_str()));
    assert_eq!(first.rows[0].path, "源 文件.txt");
    let second = adapter
        .file_blame(
            &BlameQuery {
                start: 3,
                ..q.clone()
            },
            &|| false,
        )
        .unwrap();
    let actual: Vec<_> = first
        .rows
        .iter()
        .chain(&second.rows)
        .map(|r| (r.oid.clone().unwrap(), r.original_line, r.line))
        .collect();
    assert_eq!(actual, headers);
    let text = "one\nuncommitted\nnew\nthree\nfour\n";
    let local = BlameQuery {
        source: LineQuery {
            contents: Some(text.into()),
            ..q.source.clone()
        },
        identity: identity(text),
        start: 1,
        page_size: 10,
    };
    let page = adapter.file_blame(&local, &|| false).unwrap();
    assert!(page.rows[1].oid.is_none());
    assert_eq!(page.rows[2].oid.as_deref(), Some(head.as_str()));
    assert_eq!(page.rows[2].original_line, 2);
    let new = BlameQuery {
        source: LineQuery {
            path_id: URL_SAFE_NO_PAD.encode("untracked.txt"),
            ..local.source.clone()
        },
        ..local.clone()
    };
    assert!(adapter
        .file_blame(&new, &|| false)
        .unwrap()
        .rows
        .iter()
        .all(|row| row.oid.is_none()));
    let mut wrong = local.clone();
    wrong.identity.as_mut().unwrap().content_id = Some("other snapshot".into());
    assert!(matches!(
        adapter.file_blame(&wrong, &|| false),
        Err(GitError::StaleRequest)
    ));
    assert_eq!(state(root), before);
}

#[test]
fn line_history_tracks_replacements_renames_deleted_versions_and_pagination() {
    let dir = init();
    let root = dir.path();
    let original = commit(
        root,
        "old.txt",
        "one\ntarget old\nthree\nfour\nfive\nsix\n",
        "origin",
    );
    git(root, &["mv", "old.txt", "new.txt"]);
    git(root, &["commit", "-qm", "rename"]);
    let rename = git(root, &["rev-parse", "HEAD"]);
    let modify = commit(
        root,
        "new.txt",
        "one\ntarget new\nthree\nfour\nfive\nsix\n",
        "modify",
    );
    let adapter = adapter(root);
    let before = state(root);
    let mut q = query(&modify, "new.txt", 2);
    q.page_size = 1;
    let first = adapter.line_history(&q, None, &|| false).unwrap();
    assert_eq!(first.entries[0].oid.as_deref(), Some(modify.as_str()));
    assert!(first.entries[0].inferred);
    assert_eq!(first.entries[0].old_range, Some(Range { start: 2, end: 2 }));
    let second = adapter
        .line_history(&q, first.next.as_ref(), &|| false)
        .unwrap();
    assert_eq!(second.entries[0].oid.as_deref(), Some(rename.as_str()));
    assert_eq!(second.entries[0].old_path, "old.txt");
    let third = adapter
        .line_history(&q, second.next.as_ref(), &|| false)
        .unwrap();
    assert_eq!(third.entries[0].oid.as_deref(), Some(original.as_str()));
    assert!(third.next.is_none());
    assert_eq!(state(root), before);
    git(root, &["rm", "new.txt"]);
    git(root, &["commit", "-qm", "delete"]);
    let deletion = git(root, &["rev-parse", "HEAD"]);
    let before = state(root);
    let result = adapter
        .line_history(&query(&deletion, "new.txt", 2), None, &|| false)
        .unwrap();
    assert_eq!(result.entries[0].status, "deleted");
    assert_eq!(result.entries[0].parent.as_deref(), Some(modify.as_str()));
    assert!(result
        .entries
        .iter()
        .any(|e| e.oid.as_deref() == Some(original.as_str())));
    assert_eq!(state(root), before);
    let mut changed = q.clone();
    changed.end_line = 3;
    assert!(matches!(
        adapter.line_history(&changed, first.next.as_ref(), &|| false),
        Err(GitError::StaleRequest)
    ));
    let other = init();
    commit(other.path(), "new.txt", "other\n", "other");
    assert!(matches!(
        self::adapter(other.path()).line_history(&q, first.next.as_ref(), &|| false),
        Err(GitError::StaleRequest)
    ));
}

#[test]
fn local_line_history_maps_snapshots_and_stops_at_uncommitted_origin_or_moved_head() {
    let dir = init();
    let root = dir.path();
    let head = commit(root, "f", "one\ntwo\nthree\n", "origin");
    let adapter = adapter(root);
    let before = state(root);
    let text = "one\nnew local\ntwo\nthree\n";
    let mut q = query(&head, "f", 3);
    q.source.contents = Some(text.into());
    q.identity = identity(text);
    let page = adapter.line_history(&q, None, &|| false).unwrap();
    assert_eq!(page.entries[0].old_range, Some(Range { start: 2, end: 2 }));
    assert_eq!(page.entries[1].oid.as_deref(), Some(head.as_str()));
    q.source.line = 2;
    q.end_line = 2;
    let local = adapter.line_history(&q, None, &|| false).unwrap();
    assert_eq!(local.reason, "uncommitted");
    assert_eq!(local.entries.len(), 1);
    assert_eq!(state(root), before);
    commit(root, "f", "moved\n", "moved");
    assert!(matches!(
        adapter.line_history(&q, None, &|| false),
        Err(GitError::StaleRequest)
    ));
}

#[test]
fn content_search_proves_introduction_deletion_not_titles_and_freezes_refs() {
    let dir = init();
    let root = dir.path();
    let introduced = commit(root, "f", "needle actual\nother\n", "origin");
    let deleted = commit(root, "f", "other\n", "remove");
    let decoy = commit(
        root,
        "decoy",
        "not matching\n",
        "needle actual only in title",
    );
    let adapter = adapter(root);
    let before = state(root);
    let mut q = search("needle actual");
    q.scan_budget = 1;
    let first = adapter.search_history(&q, None, &|| false).unwrap();
    assert!(first.entries.is_empty());
    assert_eq!(first.reason, "scanBudget");
    let cursor = first.next.unwrap();
    assert_eq!(state(root), before);
    commit(root, "f", "needle actual new tip\n", "move main");
    let second = adapter
        .search_history(&q, Some(&cursor), &|| false)
        .unwrap();
    assert_eq!(second.entries[0].oid, deleted);
    assert_eq!(second.entries[0].hits[0].direction, Direction::Deleted);
    assert_eq!(second.entries[0].hits[0].line, 1);
    assert_eq!(second.tips, vec![decoy]);
    let third = adapter
        .search_history(&q, second.next.as_ref(), &|| false)
        .unwrap();
    assert_eq!(third.entries[0].oid, introduced);
    assert_eq!(third.entries[0].hits[0].direction, Direction::Added);
    assert!(third.next.is_none());
    let mut changed = q.clone();
    changed.text = "other".into();
    assert!(matches!(
        adapter.search_history(&changed, Some(&cursor), &|| false),
        Err(GitError::StaleRequest)
    ));
    q.direction = Direction::Added;
    q.scan_budget = 30;
    q.refs = vec![introduced.clone()];
    let result = adapter.search_history(&q, None, &|| false).unwrap();
    assert_eq!(result.entries.len(), 1);
    assert_eq!(result.entries[0].oid, introduced);
}

#[test]
fn merges_use_first_parent_for_lines_but_all_parent_diffs_for_content() {
    let dir = init();
    let root = dir.path();
    commit(root, "f", "start\n", "root");
    git(root, &["checkout", "-qb", "topic"]);
    let topic = commit(root, "f", "start\nmerge needle\n", "topic");
    git(root, &["checkout", "-q", "main"]);
    commit(root, "separate", "main\n", "main");
    git(root, &["merge", "--no-ff", "-qm", "merge", "topic"]);
    let merge = git(root, &["rev-parse", "HEAD"]);
    let adapter = adapter(root);
    let before = state(root);
    let lines = adapter
        .line_history(&query(&merge, "f", 2), None, &|| false)
        .unwrap();
    assert_eq!(lines.entries[0].oid.as_deref(), Some(merge.as_str()));
    assert!(lines.entries[0].merge);
    assert_eq!(lines.entries.len(), 1);
    let found = adapter
        .search_history(&search("merge needle"), None, &|| false)
        .unwrap();
    assert!(found.entries.iter().any(|e| e.oid == merge));
    assert!(found.entries.iter().any(|e| e.oid == topic));
    assert_eq!(state(root), before);
}

#[test]
fn shallow_and_missing_objects_are_explicit_and_never_fake_origins() {
    let dir = init();
    let root = dir.path();
    let old = commit(root, "f", "needle\n", "root");
    commit(root, "other", "other\n", "tip");
    let shallow = tempfile::tempdir().unwrap();
    git(
        shallow.path(),
        &[
            "clone",
            "-q",
            "--depth=1",
            &format!("file://{}", root.display()),
            "repo",
        ],
    );
    let work = shallow.path().join("repo");
    let adapter = adapter(&work);
    let head = git(&work, &["rev-parse", "HEAD"]);
    let before = state(&work);
    let lines = adapter
        .line_history(&query(&head, "f", 1), None, &|| false)
        .unwrap();
    assert_eq!(lines.reason, "shallow");
    assert!(lines.entries.is_empty());
    let found = adapter
        .search_history(&search("needle"), None, &|| false)
        .unwrap();
    assert!(found.shallow);
    assert!(found.entries.is_empty());
    assert!(found.note.contains("边界"));
    assert_eq!(state(&work), before);
    let object = root.join(".git/objects").join(&old[..2]).join(&old[2..]);
    fs::remove_file(object).unwrap();
    let broken = self::adapter(root);
    let before = state(root);
    let lines = broken
        .line_history(
            &query(&git(root, &["rev-parse", "HEAD"]), "f", 1),
            None,
            &|| false,
        )
        .unwrap();
    assert_eq!(lines.reason, "untraceable");
    assert!(lines.note.contains("缺对象"));
    let search = broken
        .search_history(&search("needle"), None, &|| false)
        .unwrap();
    assert_eq!(search.reason, "untraceable");
    assert_eq!(state(root), before);
}

#[test]
fn cancellation_and_output_budget_terminate_only_owned_processes() {
    let dir = init();
    let root = dir.path();
    let head = commit(root, "f", "text\n", "root");
    let adapter = adapter(root);
    let before = state(root);
    assert!(matches!(
        adapter.file_blame(
            &BlameQuery {
                source: source(&head, "f", 1),
                identity: None,
                start: 1,
                page_size: 10
            },
            &|| true
        ),
        Err(GitError::StaleRequest)
    ));
    assert!(matches!(
        adapter.line_history(&query(&head, "f", 1), None, &|| true),
        Err(GitError::StaleRequest)
    ));
    assert!(matches!(
        adapter.search_history(&search("text"), None, &|| true),
        Err(GitError::StaleRequest)
    ));
    assert_eq!(state(root), before);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 定点测试进程：PID 从本轮创建的脚本直接获得；不按名称查找或结束其他应用。
        let script = root.join("owned-git");
        let pid = root.join("owned.pid");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s' $$ > '{}'\nexec sleep 30\n",
                pid.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let mut owned = adapter.clone();
        owned.git = script.clone();
        let started = Instant::now();
        let stale = || started.elapsed().as_millis() > 100;
        let mut budget = Budget::new(&stale);
        assert!(matches!(
            budget.run(&owned, &["status"]),
            Err(Failure::Cancelled)
        ));
        assert!(started.elapsed().as_secs() < 2);
        let process = fs::read_to_string(&pid).unwrap();
        assert!(!Path::new(&format!("/proc/{process}")).exists());
        let mut timeout = Budget::new(&|| false);
        timeout.started = Instant::now() - Duration::from_millis(9900);
        assert!(matches!(
            timeout.run(&owned, &["status"]),
            Err(Failure::Budget)
        ));
        let process = fs::read_to_string(&pid).unwrap();
        assert!(!Path::new(&format!("/proc/{process}")).exists());
        fs::write(&script, "#!/bin/sh\nexec yes x\n").unwrap();
        let mut budget = Budget::new(&|| false);
        let started = Instant::now();
        assert!(matches!(
            budget.run(&owned, &["status"]),
            Err(Failure::Budget)
        ));
        assert!(started.elapsed().as_secs() < 2);
    }
}

#[test]
fn trace_performance_and_existing_log_regression_record() {
    let dir = init();
    let root = dir.path();
    let text = (1..=1000)
        .map(|n| format!("line {n}\n"))
        .collect::<String>();
    commit(root, "f", &text, "origin");
    for n in 0..25 {
        commit(root, "other", &format!("{n}\n"), "unrelated");
    }
    let head = git(root, &["rev-parse", "HEAD"]);
    let adapter = adapter(root);
    let before = state(root);
    let started = Instant::now();
    let baseline = adapter
        .history_log(
            &log::LogQuery {
                refs: vec!["refs/heads/main".into()],
                search: None,
                page_size: 200,
            },
            None,
        )
        .unwrap();
    let log_ms = started.elapsed().as_millis();
    let blame = adapter
        .file_blame(
            &BlameQuery {
                source: source(&head, "f", 1),
                identity: None,
                start: 1,
                page_size: 200,
            },
            &|| false,
        )
        .unwrap();
    let lines = adapter
        .line_history(&query(&head, "f", 500), None, &|| false)
        .unwrap();
    let found = adapter
        .search_history(&search("line 500"), None, &|| false)
        .unwrap();
    let started = Instant::now();
    let after = adapter
        .history_log(
            &log::LogQuery {
                refs: vec!["refs/heads/main".into()],
                search: None,
                page_size: 200,
            },
            None,
        )
        .unwrap();
    let after_ms = started.elapsed().as_millis();
    assert_eq!(baseline, after);
    assert_eq!(state(root), before);
    assert_eq!(blame.rows.len(), 200);
    assert_eq!(lines.entries.len(), 1);
    assert_eq!(found.entries.len(), 1);
    eprintln!("TRACE_METRICS log_before={log_ms}ms log_after={after_ms}ms blame={}ms/{}bytes lines={}ms/{}bytes search={}ms/{}bytes", blame.elapsed_ms, blame.output_bytes, lines.elapsed_ms, lines.output_bytes, found.elapsed_ms, found.output_bytes);
}
