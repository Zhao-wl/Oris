use super::*;

fn git(root: &Path, args: &[&str]) {
    let output = git_command(Path::new("git"))
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
const DEEP_PATH: &str = "artifacts/task-03/build/debug/.fingerprint/block-buffer-6d3323bfb37c0008/lib-block_buffer.json";
const JSON: &str = "{\"rustc\":15970602626502035367,\"features\":\"[]\",\"local\":[{\"CheckDepInfo\":{\"dep_info\":\"debug\\\\.fingerprint\\\\block-buffer\\\\dep-lib-block_buffer\",\"checksum\":false}}]}";
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    git(dir.path(), &["config", "user.name", "Oris JSON regression"]);
    git(
        dir.path(),
        &["config", "user.email", "json@example.invalid"],
    );
    fs::write(dir.path().join("sibling.txt"), "base\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-qm", "base"]);
    let file = dir.path().join(DEEP_PATH);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, JSON).unwrap();
    dir
}
#[test]
fn deep_untracked_json_survives_unrelated_sibling_changes() {
    let dir = fixture();
    let root = dir.path();
    let adapter = GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap();
    fs::write(root.join("sibling.txt"), "first change\n").unwrap();
    let snapshot = adapter
        .snapshot_for_scope("s".into(), CompareScope::Unstaged)
        .unwrap();
    let selected = snapshot
        .files
        .iter()
        .find(|file| file.display_path == DEEP_PATH)
        .unwrap();
    let pair = adapter
        .read_content_pair_for_scope(
            "read".into(),
            CompareScope::Unstaged,
            snapshot.revision.clone(),
            selected.path_id.clone(),
        )
        .unwrap();
    assert_eq!(pair.left.encoding, "missing");
    assert_eq!(pair.right.text.as_deref(), Some(JSON));
    assert!(pair.degradation.is_none());
    fs::write(
        root.join("sibling.txt"),
        "a different longer build output\n",
    )
    .unwrap();
    let unchanged = adapter
        .read_content_pair_for_scope(
            "old".into(),
            CompareScope::Unstaged,
            snapshot.revision,
            selected.path_id.clone(),
        )
        .unwrap();
    assert_eq!(unchanged.right.text.as_deref(), Some(JSON));
    let fresh = adapter
        .snapshot_for_scope("refreshed".into(), CompareScope::Unstaged)
        .unwrap();
    let file = fresh
        .files
        .iter()
        .find(|file| file.display_path == DEEP_PATH)
        .unwrap();
    let recovered = adapter
        .read_content_pair_for_scope(
            "retry".into(),
            CompareScope::Unstaged,
            fresh.revision,
            file.path_id.clone(),
        )
        .unwrap();
    assert_eq!(recovered.right.text.as_deref(), Some(JSON));
}
#[test]
#[ignore = "explicit read-only probe of reported existing repository/file"]
fn reported_existing_json_readonly_probe() {
    let root = std::env::var("ORIS_JSON_REPRO_REPO").unwrap();
    let relative = std::env::var("ORIS_JSON_REPRO_FILE").unwrap();
    let expected = fs::read(Path::new(&root).join(&relative)).unwrap();
    let _: serde_json::Value = serde_json::from_slice(&expected).unwrap();
    let adapter = GitAdapter::open(root, None).unwrap();
    let snapshot = adapter
        .snapshot_for_scope("live-snapshot".into(), CompareScope::Unstaged)
        .unwrap();
    let file = snapshot
        .files
        .iter()
        .find(|file| file.display_path == relative)
        .unwrap();
    println!(
        "LIVE_JSON path={} bytes={} sha256={} status={:?} revision={}",
        relative,
        expected.len(),
        hash_bytes(&expected),
        file.status,
        snapshot.revision
    );
    let pair = adapter.read_content_pair_for_scope(
        "live-read".into(),
        CompareScope::Unstaged,
        snapshot.revision,
        file.path_id.clone(),
    );
    match pair {
        Ok(pair) => {
            assert_eq!(pair.right.text.as_ref().unwrap().as_bytes(), expected);
            assert_eq!(pair.left.encoding, "missing");
            println!(
                "LIVE_JSON_READ_PASS rightEncoding={} leftEncoding={}",
                pair.right.encoding, pair.left.encoding
            );
        }
        Err(error) => panic!(
            "LIVE_JSON_READ_FAILED {}",
            serde_json::to_string(&error).unwrap()
        ),
    }
}
#[test]
fn normal_json_untracked_added_and_modified_three_scopes_are_plain_text() {
    let dir = fixture();
    let root = dir.path();
    let adapter = GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap();
    let read = |scope| {
        let snapshot = adapter.snapshot_for_scope("s".into(), scope).unwrap();
        let selected = snapshot
            .files
            .iter()
            .find(|file| file.display_path == DEEP_PATH)
            .unwrap();
        adapter
            .read_content_pair_for_scope(
                "r".into(),
                scope,
                snapshot.revision,
                selected.path_id.clone(),
            )
            .unwrap()
    };
    for scope in [CompareScope::Unstaged, CompareScope::All] {
        let pair = read(scope);
        assert_eq!(pair.left.encoding, "missing");
        assert_eq!(pair.right.text.as_deref(), Some(JSON));
        assert!(pair.degradation.is_none());
    }
    assert!(!adapter
        .snapshot_for_scope("staged".into(), CompareScope::Staged)
        .unwrap()
        .files
        .iter()
        .any(|f| f.display_path == DEEP_PATH));
    git(root, &["add", "--", DEEP_PATH]);
    let added = read(CompareScope::Staged);
    assert_eq!(added.left.encoding, "missing");
    assert_eq!(added.right.text.as_deref(), Some(JSON));
    git(root, &["commit", "-qm", "json base"]);
    let index = "{\"version\":\"index\",\"items\":[1,2],\"name\":\"中文\"}";
    let working = "{\"version\":\"working tree\",\"valid\":true}";
    fs::write(root.join(DEEP_PATH), index).unwrap();
    git(root, &["add", "--", DEEP_PATH]);
    fs::write(root.join(DEEP_PATH), working).unwrap();
    for (scope, left, right) in [
        (CompareScope::Staged, JSON, index),
        (CompareScope::Unstaged, index, working),
        (CompareScope::All, JSON, working),
    ] {
        let pair = read(scope);
        assert_eq!(pair.left.text.as_deref(), Some(left));
        assert_eq!(pair.right.text.as_deref(), Some(right));
        assert!(pair.left.details.unwrap().image.is_none());
        assert!(pair.right.details.unwrap().image.is_none());
        assert!(pair.degradation.is_none());
    }
    let old = adapter
        .snapshot_for_scope("before-remove".into(), CompareScope::Unstaged)
        .unwrap();
    let file = old
        .files
        .iter()
        .find(|f| f.display_path == DEEP_PATH)
        .unwrap();
    fs::remove_file(root.join(DEEP_PATH)).unwrap();
    assert!(matches!(
        adapter.read_content_pair_for_scope(
            "removed".into(),
            CompareScope::Unstaged,
            old.revision,
            file.path_id.clone()
        ),
        Err(GitError::StaleRequest)
    ));
    let removed = read(CompareScope::Unstaged);
    assert_eq!(removed.left.text.as_deref(), Some(index));
    assert_eq!(removed.right.encoding, "missing");
}
#[test]
fn every_git_error_shape_has_string_reason_and_stable_kind() {
    let mut errors = vec![
        GitError::StaleRequest,
        GitError::UnsafePath,
        GitError::UnsupportedPathEncoding,
        GitError::GitUnavailable("not found".into()),
        GitError::UnsupportedGit {
            found: "2.20".into(),
            minimum: "2.31".into(),
        },
        GitError::InvalidRepository("missing".into()),
        GitError::CommandFailed("fatal: missing object".into()),
        GitError::Io("permission denied".into()),
    ];
    #[cfg(feature = "desktop")]
    errors.extend([
        GitError::UnknownRepository,
        GitError::GitChanged,
        GitError::Registry,
        GitError::Runtime("worker".into()),
    ]);
    for error in errors.drain(..) {
        let value = serde_json::to_value(&error).unwrap();
        assert!(value["kind"].is_string());
        assert_eq!(value["message"].as_str(), Some(error.to_string().as_str()));
    }
}

#[test]
fn large_repository_continuous_unrelated_writes_do_not_starve_selected_json() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    let dir = fixture();
    let root = dir.path();
    let generated = root.join("generated");
    fs::create_dir(&generated).unwrap();
    for n in 0..5000 {
        fs::write(generated.join(format!("{n:05}.json")), b"{\"value\":1}\n").unwrap();
    }
    let adapter = GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap();
    let started = Instant::now();
    let snapshot = adapter
        .snapshot_for_scope("large".into(), CompareScope::Unstaged)
        .unwrap();
    let snapshot_ms = started.elapsed().as_millis();
    assert_eq!(snapshot.files.len(), 5001);
    assert!(
        snapshot
            .files
            .iter()
            .filter(|f| f.additions.is_some())
            .count()
            <= 64
    );
    let file = snapshot
        .files
        .iter()
        .find(|f| f.display_path == DEEP_PATH)
        .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = stop.clone();
    let sibling = generated.join("00000.json");
    let writer = std::thread::spawn(move || {
        let mut n = 0;
        while !writer_stop.load(Ordering::SeqCst) {
            fs::write(&sibling, format!("{{\"value\":{n}}}")).unwrap();
            n += 1;
            std::thread::sleep(Duration::from_millis(10));
        }
        n
    });
    std::thread::sleep(Duration::from_millis(30));
    let started = Instant::now();
    let results = (0..5)
        .map(|_| {
            adapter.read_content_pair_for_scope(
                "continuous".into(),
                CompareScope::Unstaged,
                snapshot.revision.clone(),
                file.path_id.clone(),
            )
        })
        .collect::<Vec<_>>();
    stop.store(true, Ordering::SeqCst);
    let writes = writer.join().unwrap();
    let read_ms = started.elapsed().as_millis();
    for result in results {
        assert_eq!(result.unwrap().right.text.as_deref(), Some(JSON));
    }
    // A newer unrelated snapshot also must not retire the visible file's read token.
    adapter
        .snapshot_for_scope("newer".into(), CompareScope::Unstaged)
        .unwrap();
    assert!(adapter
        .read_content_pair_for_scope(
            "retained".into(),
            CompareScope::Unstaged,
            snapshot.revision.clone(),
            file.path_id.clone()
        )
        .is_ok());
    fs::write(root.join(DEEP_PATH), "{\"selectedChanged\":true}").unwrap();
    assert!(matches!(
        adapter.read_content_pair_for_scope(
            "changed".into(),
            CompareScope::Unstaged,
            snapshot.revision,
            file.path_id.clone()
        ),
        Err(GitError::StaleRequest)
    ));
    let fresh = adapter
        .snapshot_for_scope("stopped".into(), CompareScope::Unstaged)
        .unwrap();
    assert!(adapter
        .read_content_pair_for_scope(
            "recovered".into(),
            CompareScope::Unstaged,
            fresh.revision,
            file.path_id.clone()
        )
        .is_ok());
    println!("LARGE_REPOSITORY files=5001 snapshot_ms={snapshot_ms} five_reads_ms={read_ms} concurrent_writes={writes} successes=5 selected_mutation_rejected=true recovered=true");
}

#[test]
fn ignored_path_burst_filters_without_pipe_deadlock_and_keeps_real_changes() {
    let dir = fixture();
    fs::write(dir.path().join(".gitignore"), "cache/\n").unwrap();
    let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
    let filter = adapter.change_filter();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let mut paths = (0..5000)
        .map(|n| root.join(format!("cache/output-{n:05}.json")))
        .collect::<Vec<_>>();
    assert!(!filter.relevant(&paths));
    paths.push(root.join(DEEP_PATH));
    assert!(filter.relevant(&paths));
}
#[test]
fn selected_mutation_during_read_is_rejected_without_retry() {
    let dir = fixture();
    let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
    let snapshot = adapter
        .snapshot_for_scope("s".into(), CompareScope::Unstaged)
        .unwrap();
    let file = snapshot
        .files
        .iter()
        .find(|f| f.display_path == DEEP_PATH)
        .unwrap();
    let checks = std::cell::Cell::new(0);
    let result = adapter.read_content_pair_cancellable(
        "r".into(),
        CompareScope::Unstaged,
        snapshot.revision,
        file.path_id.clone(),
        None,
        || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                fs::write(dir.path().join(DEEP_PATH), "changed during read").unwrap();
            }
            false
        },
    );
    assert!(matches!(result, Err(GitError::StaleRequest)));
    assert_eq!(checks.get(), 2);
}
