//! Porcelain v2 状态快照。路径始终保存 Git 返回的原始字节。
use super::{run_required, GitError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BranchInfo {
    pub oid: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InProgress {
    pub merge: bool,
    pub rebase: bool,
    pub cherry_pick: bool,
    pub revert: bool,
    pub bisect: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stage {
    pub mode: String,
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: Vec<u8>,
    pub path_id: String,
    pub old_path: Option<Vec<u8>>,
    pub old_path_id: Option<String>,
    pub x: u8,
    pub y: u8,
    pub head: Option<Stage>,
    pub index: Option<Stage>,
    pub worktree_mode: Option<String>,
    pub conflict: Option<[Option<Stage>; 3]>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeFiles {
    pub unstaged: Vec<Entry>,
    pub staged: Vec<Entry>,
    pub all: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusSnapshot {
    pub branch: BranchInfo,
    pub files: ScopeFiles,
    pub in_progress: InProgress,
    pub revision: String,
}

fn bad() -> GitError {
    GitError::CommandFailed("无法解析 porcelain v2 输出".into())
}
fn token<'a>(fields: &'a [&'a [u8]], i: usize) -> Result<&'a [u8], GitError> {
    fields.get(i).copied().ok_or_else(bad)
}
fn utf8(bytes: &[u8]) -> Result<String, GitError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| bad())
}
fn stage(mode: &[u8], oid: &[u8]) -> Result<Option<Stage>, GitError> {
    if oid.iter().all(|b| *b == b'0') {
        return Ok(None);
    }
    Ok(Some(Stage {
        mode: utf8(mode)?,
        oid: utf8(oid)?,
    }))
}
fn entry(
    path: &[u8],
    old: Option<&[u8]>,
    xy: &[u8],
    head: Option<Stage>,
    index: Option<Stage>,
    worktree_mode: Option<String>,
    conflict: Option<[Option<Stage>; 3]>,
) -> Result<Entry, GitError> {
    if xy.len() != 2 {
        return Err(bad());
    }
    Ok(Entry {
        path: path.to_vec(),
        path_id: URL_SAFE_NO_PAD.encode(path),
        old_path: old.map(Vec::from),
        old_path_id: old.map(|p| URL_SAFE_NO_PAD.encode(p)),
        x: xy[0],
        y: xy[1],
        head,
        index,
        worktree_mode,
        conflict,
    })
}

/// 原始输出可包含任意非 UTF-8 路径；元数据必须是 Git 的 ASCII 字段。
pub fn parse(raw: &[u8]) -> Result<(BranchInfo, ScopeFiles), GitError> {
    let mut branch = BranchInfo::default();
    let mut files = ScopeFiles::default();
    let mut fields = raw.split(|b| *b == 0).peekable();
    while fields
        .peek()
        .is_some_and(|record| record.starts_with(b"# "))
    {
        let line = fields.next().ok_or_else(bad)?;
        if let Some(v) = line.strip_prefix(b"# branch.oid ") {
            branch.oid = (v != b"(initial)").then(|| utf8(v)).transpose()?;
        } else if let Some(v) = line.strip_prefix(b"# branch.head ") {
            branch.head = (v != b"(detached)").then(|| utf8(v)).transpose()?;
        } else if let Some(v) = line.strip_prefix(b"# branch.upstream ") {
            branch.upstream = Some(utf8(v)?);
        } else if let Some(v) = line.strip_prefix(b"# branch.ab ") {
            let mut it = v.split(|b| *b == b' ');
            let a = it.next().ok_or_else(bad)?;
            let b = it.next().ok_or_else(bad)?;
            branch.ahead = Some(
                utf8(a.strip_prefix(b"+").ok_or_else(bad)?)?
                    .parse()
                    .map_err(|_| bad())?,
            );
            branch.behind = Some(
                utf8(b.strip_prefix(b"-").ok_or_else(bad)?)?
                    .parse()
                    .map_err(|_| bad())?,
            );
        }
    }
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let kind = record[0];
        if kind == b'!' {
            continue;
        }
        let mut parts = record.splitn(
            match kind {
                b'1' => 9,
                b'2' => 10,
                b'u' => 11,
                _ => 2,
            },
            |b| *b == b' ',
        );
        let words: Vec<&[u8]> = parts.by_ref().collect();
        let value = match kind {
            b'1' => entry(
                token(&words, 8)?,
                None,
                token(&words, 1)?,
                stage(token(&words, 3)?, token(&words, 6)?)?,
                stage(token(&words, 4)?, token(&words, 7)?)?,
                Some(utf8(token(&words, 5)?)?),
                None,
            )?,
            b'2' => {
                let old = fields.next().ok_or_else(bad)?;
                // 2 XY sub mH mI mW hH hI Xscore path NUL origPath NUL
                entry(
                    token(&words, 9)?,
                    Some(old),
                    token(&words, 1)?,
                    stage(token(&words, 3)?, token(&words, 6)?)?,
                    stage(token(&words, 4)?, token(&words, 7)?)?,
                    Some(utf8(token(&words, 5)?)?),
                    None,
                )?
            }
            b'u' => {
                let stages = [
                    stage(token(&words, 3)?, token(&words, 7)?)?,
                    stage(token(&words, 4)?, token(&words, 8)?)?,
                    stage(token(&words, 5)?, token(&words, 9)?)?,
                ];
                entry(
                    token(&words, 10)?,
                    None,
                    token(&words, 1)?,
                    stages[0].clone(),
                    None,
                    Some(utf8(token(&words, 6)?)?),
                    Some(stages),
                )?
            }
            b'?' => entry(token(&words, 1)?, None, b"??", None, None, None, None)?,
            _ => return Err(bad()),
        };
        if value.conflict.is_some() || value.y != b'.' || kind == b'?' {
            files.unstaged.push(value.clone());
        }
        if value.conflict.is_some() || value.x != b'.' && kind != b'?' {
            files.staged.push(value.clone());
        }
        files.all.push(value);
    }
    Ok((branch, files))
}

pub fn detect_in_progress(git_dir: &Path) -> InProgress {
    InProgress {
        merge: git_dir.join("MERGE_HEAD").exists(),
        rebase: git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir(),
        cherry_pick: git_dir.join("CHERRY_PICK_HEAD").exists(),
        revert: git_dir.join("REVERT_HEAD").exists(),
        bisect: git_dir.join("BISECT_LOG").exists(),
    }
}

/// HEAD 与 refs 内容由调用方提供；长度前缀消除拼接歧义。
pub fn revision(raw: &[u8], head: &[u8], refs: &[u8]) -> String {
    let mut h = Sha256::new();
    for bytes in [raw, head, refs] {
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(bytes);
    }
    hex::encode(h.finalize())
}

pub fn read(
    git: &Path,
    worktree: &Path,
    git_dir: &Path,
    head: &[u8],
    refs: &[u8],
) -> Result<StatusSnapshot, GitError> {
    let raw = run_required(
        git,
        worktree,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--find-renames",
        ],
    )?
    .stdout;
    let (branch, files) = parse(&raw)?;
    Ok(StatusSnapshot {
        branch,
        files,
        in_progress: detect_in_progress(git_dir),
        revision: revision(&raw, head, refs),
    })
}

/// 首次显示“全部”范围时可调用；只返回 HEAD diff 可见的 rename。
/// 未跟踪的新路径不会出现在该 diff 中，调用方需要按 V1 语义保留为删除 + 未跟踪。
pub fn all_rename_pairs(git: &Path, worktree: &Path) -> Result<Vec<(String, String)>, GitError> {
    let raw = run_required(
        git,
        worktree,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--name-status",
            "-M",
            "-z",
            "--",
        ],
    )?
    .stdout;
    let fields: Vec<_> = raw.split(|b| *b == 0).filter(|f| !f.is_empty()).collect();
    let mut pairs = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let code = fields[i];
        i += 1;
        if code.starts_with(b"R") || code.starts_with(b"C") {
            let old = *fields.get(i).ok_or_else(bad)?;
            let new = *fields.get(i + 1).ok_or_else(bad)?;
            pairs.push((URL_SAFE_NO_PAD.encode(old), URL_SAFE_NO_PAD.encode(new)));
            i += 2;
        } else {
            i += 1;
        }
    }
    Ok(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};
    fn git(dir: &Path, args: &[&str]) -> Vec<u8> {
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
        out.stdout
    }
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        git(dir.path(), &["config", "user.email", "test@example.test"]);
        dir
    }
    fn status(dir: &Path) -> (BranchInfo, ScopeFiles) {
        let raw = run_required(
            Path::new("git"),
            dir,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
                "--find-renames",
            ],
        )
        .unwrap()
        .stdout;
        parse(&raw).unwrap_or_else(|e| panic!("{e}: {:?}", raw))
    }
    #[test]
    fn unborn_and_two_layer_changes() {
        let dir = repo();
        let p = dir.path();
        fs::write(p.join("空 格.txt"), b"first\n").unwrap();
        git(p, &["add", "."]);
        let (branch, f) = status(p);
        assert!(branch.oid.is_none());
        assert_eq!(f.staged.len(), 1);
        assert_eq!(f.all.len(), 1);
        git(p, &["commit", "-qm", "init"]);
        fs::write(p.join("空 格.txt"), b"staged\n").unwrap();
        git(p, &["add", "."]);
        fs::write(p.join("空 格.txt"), b"working\n").unwrap();
        fs::write(p.join("untracked"), b"u").unwrap();
        let (branch, f) = status(p);
        assert!(branch.oid.is_some());
        assert_eq!(f.staged.len(), 1);
        assert_eq!(f.unstaged.len(), 2);
        assert_eq!(f.all.len(), 2);
        let e = &f.staged[0];
        assert_eq!(e.x, b'M');
        assert_eq!(e.y, b'M');
        assert!(e.head.is_some());
        assert!(e.index.is_some());
        assert_eq!(
            URL_SAFE_NO_PAD.decode(&e.path_id).unwrap(),
            "空 格.txt".as_bytes()
        );
        let raw = git(p, &["diff", "--cached", "--name-status", "-z", "--"]);
        assert!(raw
            .windows("空 格.txt".len())
            .any(|w| w == "空 格.txt".as_bytes()));
    }
    #[test]
    fn rename_deletion_and_untracked_match_v1_commands() {
        let dir = repo();
        let p = dir.path();
        fs::write(p.join("old"), b"same\n").unwrap();
        fs::write(p.join("delete"), b"gone\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "init"]);
        fs::rename(p.join("old"), p.join("new")).unwrap();
        fs::remove_file(p.join("delete")).unwrap();
        let (_, f) = status(p);
        assert!(f.unstaged.iter().any(|e| e.path == b"old" && e.y == b'D'));
        assert!(f.unstaged.iter().any(|e| e.path == b"new" && e.x == b'?'));
        assert!(f
            .unstaged
            .iter()
            .any(|e| e.path == b"delete" && e.y == b'D'));
        // 未跟踪的新路径不参与 git diff HEAD；V1 同样显示 D + ?。
        let pairs = all_rename_pairs(Path::new("git"), p).unwrap();
        assert!(pairs.is_empty());
        git(p, &["add", "-A"]);
        let (_, f) = status(p);
        assert!(f
            .staged
            .iter()
            .any(|e| e.path == b"new" && e.old_path.as_deref() == Some(b"old")));
        assert!(all_rename_pairs(Path::new("git"), p).unwrap().contains(&(
            URL_SAFE_NO_PAD.encode(b"old"),
            URL_SAFE_NO_PAD.encode(b"new")
        )));
        let staged = git(p, &["diff", "--cached", "--name-status", "-M", "-z", "--"]);
        assert!(staged.windows(3).any(|w| w == b"old"));
    }
    #[test]
    fn conflict_stages_and_progress() {
        let dir = repo();
        let p = dir.path();
        fs::write(p.join("file"), b"base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "base"]);
        git(p, &["checkout", "-qb", "side"]);
        fs::write(p.join("file"), b"side\n").unwrap();
        git(p, &["commit", "-qam", "side"]);
        git(p, &["checkout", "-q", "main"]);
        fs::write(p.join("file"), b"main\n").unwrap();
        git(p, &["commit", "-qam", "main"]);
        let out = Command::new("git")
            .current_dir(p)
            .args(["merge", "side"])
            .output()
            .unwrap();
        assert!(!out.status.success());
        let (_, f) = status(p);
        let e = &f.all[0];
        let stages = e.conflict.as_ref().unwrap();
        assert!(stages.iter().all(Option::is_some));
        let ls = git(p, &["ls-files", "--unmerged", "-z"]);
        assert!(ls.windows(4).any(|w| w == b"file"));
        let state = detect_in_progress(&p.join(".git"));
        assert!(state.merge);
    }
    #[test]
    fn raw_non_utf8_path_and_revision() {
        let raw = b"# branch.oid (initial)\0# branch.head main\0? odd\xff name\0! ignored\0";
        let (b, f) = parse(raw).unwrap();
        assert_eq!(b.head.as_deref(), Some("main"));
        assert_eq!(f.all.len(), 1);
        assert_eq!(
            URL_SAFE_NO_PAD.decode(&f.all[0].path_id).unwrap(),
            b"odd\xff name"
        );
        assert_ne!(
            revision(raw, b"head", b"refs"),
            revision(raw, b"head2", b"refs")
        );
    }

    #[test]
    fn real_index_non_utf8_path_and_readonly_state() {
        use std::io::Write;
        let dir = repo();
        let p = dir.path();
        let mut hash = Command::new("git")
            .current_dir(p)
            .args(["hash-object", "-w", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        hash.stdin.take().unwrap().write_all(b"content").unwrap();
        let oid = String::from_utf8(hash.wait_with_output().unwrap().stdout)
            .unwrap()
            .trim()
            .to_owned();
        let mut child = Command::new("git")
            .current_dir(p)
            .args(["update-index", "-z", "--index-info"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = format!("100644 {oid} 0\t").into_bytes();
        input.extend_from_slice(b"odd\xff name\0");
        child.stdin.take().unwrap().write_all(&input).unwrap();
        assert!(child.wait().unwrap().success());
        let paths = [".git/index", ".git/HEAD", ".git/config"];
        let before = paths.map(|s| fs::read(p.join(s)).unwrap());
        let (_, files) = status(p);
        assert_eq!(files.all.len(), 1);
        assert_eq!(
            URL_SAFE_NO_PAD.decode(&files.all[0].path_id).unwrap(),
            b"odd\xff name"
        );
        assert_eq!(before, paths.map(|s| fs::read(p.join(s)).unwrap()));
    }

    #[test]
    fn merge_conflict_shapes() {
        for shape in ["UU", "AA", "UD", "DU"] {
            let dir = repo();
            let p = dir.path();
            fs::write(p.join("seed"), b"seed").unwrap();
            if shape != "AA" {
                fs::write(p.join("file"), b"base").unwrap();
            }
            git(p, &["add", "."]);
            git(p, &["commit", "-qm", "base"]);
            git(p, &["checkout", "-qb", "side"]);
            if shape == "UD" {
                git(p, &["rm", "file"]);
            } else {
                fs::write(p.join("file"), b"side").unwrap();
            }
            git(p, &["add", "-A"]);
            git(p, &["commit", "-qm", "side"]);
            git(p, &["checkout", "-q", "main"]);
            if shape == "DU" {
                git(p, &["rm", "file"]);
            } else {
                fs::write(p.join("file"), b"main").unwrap();
            }
            git(p, &["add", "-A"]);
            git(p, &["commit", "-qm", "main"]);
            assert!(!Command::new("git")
                .current_dir(p)
                .args(["merge", "side"])
                .status()
                .unwrap()
                .success());
            let (_, f) = status(p);
            let e = f.all.iter().find(|e| e.path == b"file").unwrap();
            assert_eq!(&[e.x, e.y], shape.as_bytes());
            assert!(e.conflict.is_some());
            assert!(f.unstaged.iter().any(|e| e.path == b"file"));
            assert!(f.staged.iter().any(|e| e.path == b"file"));
        }
    }

    #[test]
    fn controlled_conflict_stage_combinations() {
        use std::io::Write;
        for stages in [&[1][..], &[2], &[3], &[1, 2], &[1, 3], &[2, 3], &[1, 2, 3]] {
            let dir = repo();
            let p = dir.path();
            fs::write(p.join("seed"), b"seed").unwrap();
            git(p, &["add", "."]);
            git(p, &["commit", "-qm", "base"]);
            let mut hash = Command::new("git")
                .current_dir(p)
                .args(["hash-object", "-w", "--stdin"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            hash.stdin.take().unwrap().write_all(b"blob").unwrap();
            let oid = String::from_utf8(hash.wait_with_output().unwrap().stdout)
                .unwrap()
                .trim()
                .to_owned();
            let mut input = Vec::new();
            for stage in stages {
                input.extend_from_slice(format!("100644 {oid} {stage}\tconflict\n").as_bytes());
            }
            let mut child = Command::new("git")
                .current_dir(p)
                .args(["update-index", "--index-info"])
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&input).unwrap();
            assert!(child.wait().unwrap().success());
            fs::write(p.join("conflict"), b"working").unwrap();
            let (_, files) = status(p);
            let e = files.all.iter().find(|e| e.path == b"conflict").unwrap();
            let parsed = e.conflict.as_ref().unwrap();
            for stage in 1..=3 {
                assert_eq!(parsed[stage - 1].is_some(), stages.contains(&stage));
            }
        }
    }

    #[test]
    fn all_scope_can_cancel_across_index_and_worktree() {
        let dir = repo();
        let p = dir.path();
        fs::write(p.join("file"), b"head").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "base"]);
        fs::write(p.join("file"), b"index").unwrap();
        git(p, &["add", "."]);
        fs::write(p.join("file"), b"head").unwrap();
        let (_, files) = status(p);
        assert_eq!(files.staged.len(), 1);
        assert_eq!(files.unstaged.len(), 1);
        assert_eq!(files.all.len(), 1);
        assert!(git(p, &["diff", "HEAD", "--name-status", "-z", "--"]).is_empty());
    }
}
