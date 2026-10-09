use super::*;
use std::process::Command;
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().into()
}
fn fixture() -> (tempfile::TempDir, GitAdapter, String, String) {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-b", "main"]);
    git(dir.path(), &["config", "user.email", "test@example.com"]);
    git(dir.path(), &["config", "user.name", "Test"]);
    fs::write(
        dir.path().join("callee.ts"),
        "export function price(n: number) { return n * 2; }\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("caller.ts"),
        "import {price} from './callee';\nprice(2);\n",
    )
    .unwrap();
    fs::write(dir.path().join("config.json"), "{\"factor\":2}\n").unwrap();
    fs::write(
        dir.path().join("price.test.ts"),
        "expect(price(2)).toBe(4);\n",
    )
    .unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-m", "base"]);
    let base = git(dir.path(), &["rev-parse", "HEAD"]);
    fs::write(
        dir.path().join("callee.ts"),
        "export function price(n: number) { return n / 2; }\n",
    )
    .unwrap();
    git(dir.path(), &["add", "callee.ts"]);
    git(dir.path(), &["commit", "-m", "change"]);
    let tip = git(dir.path(), &["rev-parse", "HEAD"]);
    git(dir.path(), &["branch", "base", &base]);
    fs::write(
        dir.path().join("caller.ts"),
        "import {price} from './callee';\nprice(8); // staged\n",
    )
    .unwrap();
    git(dir.path(), &["add", "caller.ts"]);
    fs::write(
        dir.path().join("caller.ts"),
        "import {price} from './callee';\nprice(9); // unstaged\n",
    )
    .unwrap();
    fs::write(dir.path().join("new.txt"), "untracked\n").unwrap();
    let adapter = GitAdapter::open(dir.path().to_string_lossy().into(), None).unwrap();
    (dir, adapter, base, tip)
}
fn request(inv: &Inventory, extra: Vec<String>) -> ReviewRequest {
    ReviewRequest {
        range: inv.range.clone(),
        identity: inv.identity.clone(),
        path_ids: inv.files.iter().map(|f| f.path_id.clone()).collect(),
        context_paths: extra,
    }
}
#[test]
fn four_ranges_are_isolated_and_sources_are_real_without_git_writes() {
    let (dir, a, base, tip) = fixture();
    let before_index = fs::read(a.git_dir.join("index")).unwrap();
    let status = git(dir.path(), &["status", "--porcelain"]);
    let refs = git(dir.path(), &["show-ref"]);
    for (range, expected) in [
        (ReviewRange::Workspace, "unstaged"),
        (ReviewRange::Staged, "staged"),
        (
            ReviewRange::Commit {
                commit: tip.clone(),
            },
            "n / 2",
        ),
        (
            ReviewRange::Branch {
                left: "refs/heads/base".into(),
                right: "refs/heads/main".into(),
            },
            "n / 2",
        ),
    ] {
        let inv = a.review_inventory(range).unwrap();
        let result = a
            .review_context(request(
                &inv,
                vec!["config.json".into(), "price.test.ts".into()],
            ))
            .unwrap();
        assert!(result.diff.contains(expected), "{}", result.diff);
        if expected == "staged" {
            assert!(!result.diff.contains("unstaged"));
            assert!(!result.diff.contains("untracked"));
        }
        if expected == "n / 2" {
            assert_eq!(inv.left.as_deref(), Some(base.as_str()));
            assert_eq!(inv.right, tip);
            assert!(!result.diff.contains("staged"));
        }
        assert!(result.sources.iter().any(|s| s.file.path == "price.test.ts"
            && s.lines.iter().any(|l| l.text.contains("toBe(4)"))));
        assert!(result.sources.iter().any(|s| s.file.path == "config.json"));
        assert!(result.used <= BUDGET);
    }
    assert_eq!(before_index, fs::read(a.git_dir.join("index")).unwrap());
    assert_eq!(status, git(dir.path(), &["status", "--porcelain"]));
    assert_eq!(refs, git(dir.path(), &["show-ref"]));
}
#[test]
fn stale_revision_moved_ref_and_unsafe_paths_fail_closed() {
    let (dir, a, _, _) = fixture();
    let inv = a.review_inventory(ReviewRange::Workspace).unwrap();
    let mut r = request(&inv, vec![]);
    r.path_ids.push("invalid".into());
    assert!(a.review_context(r).is_err());
    assert!(a
        .review_context(request(&inv, vec!["../outside".into()]))
        .is_err());
    assert!(a
        .review_context(request(&inv, vec![".git/config".into()]))
        .is_err());
    fs::write(dir.path().join("caller.ts"), "changed again, longer\n").unwrap();
    assert!(matches!(
        a.review_context(request(&inv, vec![])),
        Err(GitError::StaleRequest)
    ));
    let branch = a
        .review_inventory(ReviewRange::Branch {
            left: "refs/heads/base".into(),
            right: "refs/heads/main".into(),
        })
        .unwrap();
    git(dir.path(), &["branch", "-f", "base", "main"]);
    assert!(matches!(
        a.review_context(request(&branch, vec![])),
        Err(GitError::StaleRequest)
    ));
}
#[test]
fn budget_missing_and_unreadable_context_are_reported() {
    let (dir, a, _, _) = fixture();
    fs::write(
        dir.path().join("large.txt"),
        (0..5000)
            .map(|i| format!("line {i} {}\n", "字".repeat(100)))
            .collect::<String>(),
    )
    .unwrap();
    let inv = a.review_inventory(ReviewRange::Workspace).unwrap();
    let result = a
        .review_context(request(&inv, vec!["absent.txt".into()]))
        .unwrap();
    assert!(result.truncated);
    assert!(result.used <= BUDGET);
    assert!(result.warnings.iter().any(|w| w.contains("absent.txt")));
    assert!(result
        .sources
        .iter()
        .all(|s| s.lines.iter().all(|l| !l.text.ends_with('�'))));
}
#[test]
fn root_commit_and_renamed_paths_keep_endpoints() {
    let (dir, a, base, _) = fixture();
    let root = a
        .review_inventory(ReviewRange::Commit { commit: base })
        .unwrap();
    assert!(root.left.is_none());
    assert!(a
        .review_context(request(&root, vec![]))
        .unwrap()
        .diff
        .contains("price"));
    git(dir.path(), &["mv", "config.json", "renamed.json"]);
    fs::write(dir.path().join("renamed.json"), "{\"factor\":3}\n").unwrap();
    git(dir.path(), &["add", "renamed.json"]);
    let inv = a.review_inventory(ReviewRange::Staged).unwrap();
    assert!(a.review_context(request(&inv, vec![])).is_ok());
}
#[test]
fn navigation_rechecks_exact_pair_and_bounded_requests() {
    let (dir, a, _, _) = fixture();
    let inv = a.review_inventory(ReviewRange::Staged).unwrap();
    let result = a
        .review_context(request(&inv, vec!["config.json".into()]))
        .unwrap();
    for source in &result.sources {
        let pair = a
            .review_location(
                request(&inv, vec!["config.json".into()]),
                source.file.path_id.clone(),
            )
            .unwrap();
        let side = if source.side == "left" {
            pair.left
        } else {
            pair.right
        };
        assert_eq!(side.content_id, source.content_id);
    }
    assert!(a
        .review_location(request(&inv, vec![]), URL_SAFE_NO_PAD.encode(".git/config"))
        .is_err());
    let mut too_many = request(&inv, vec![]);
    too_many.context_paths = (0..16).map(|n| format!("extra{n}")).collect();
    assert!(a
        .review_context(too_many)
        .unwrap_err()
        .to_string()
        .contains("16"));
    let mut duplicate = request(&inv, vec![]);
    duplicate.path_ids.push(duplicate.path_ids[0].clone());
    assert!(a.review_context(duplicate).is_err());
    fs::write(
        dir.path().join("config.json"),
        "changed supplemental context\n",
    )
    .unwrap();
    // 补充文件变化同样使旧快照失效。
    assert!(matches!(
        a.review_context(request(&inv, vec!["config.json".into()])),
        Err(GitError::StaleRequest)
    ));
}
#[test]
fn oversized_index_objects_and_primary_files_never_generate_unbounded_patches() {
    let (dir, a, _, _) = fixture();
    fs::write(
        dir.path().join("oversized.txt"),
        vec![b'x'; 6 * 1024 * 1024],
    )
    .unwrap();
    git(dir.path(), &["add", "oversized.txt"]);
    let inv = a.review_inventory(ReviewRange::Staged).unwrap();
    let mut r = request(&inv, vec!["oversized.txt".into()]);
    r.path_ids
        .retain(|id| *id == URL_SAFE_NO_PAD.encode("caller.ts"));
    let supplement = a.review_context(r).unwrap();
    assert!(supplement.truncated);
    assert!(supplement.used <= BUDGET);
    assert!(supplement
        .warnings
        .iter()
        .any(|w| w.contains("oversized.txt")));
    let primary = a.review_context(request(&inv, vec![])).unwrap();
    assert!(primary.truncated);
    assert!(primary.used <= BUDGET);
    assert!(!primary.diff.contains("xxxxxxxx"));
}
