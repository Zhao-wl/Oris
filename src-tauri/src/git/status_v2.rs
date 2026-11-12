//! Porcelain v2 状态快照。路径始终保存 Git 返回的原始字节。
use super::GitError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
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
    /// porcelain v2 的 `<sub>` 字段：`N...` 或 `S<c><m><u>`（子模块提交已变 / 有已跟踪修改 / 有未跟踪文件）。
    pub sub: Option<String>,
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
    sub: Option<&[u8]>,
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
        sub: sub.map(|s| String::from_utf8_lossy(s).into_owned()),
    })
}

/// 原始输出可包含任意非 UTF-8 路径；元数据必须是 Git 的 ASCII 字段。
pub fn parse(raw: &[u8]) -> Result<(BranchInfo, Vec<Entry>), GitError> {
    let mut branch = BranchInfo::default();
    let mut entries = Vec::new();
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
                Some(token(&words, 2)?),
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
                    Some(token(&words, 2)?),
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
                    Some(token(&words, 2)?),
                )?
            }
            b'?' => entry(token(&words, 1)?, None, b"??", None, None, None, None, None)?,
            _ => return Err(bad()),
        };
        entries.push(value);
    }
    Ok((branch, entries))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{run_required, scan::scope_lists, CompareScope, FileStatus};
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
    fn status(dir: &Path) -> (BranchInfo, Vec<Entry>) {
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
        assert_eq!(f.len(), 1);
        assert_eq!([f[0].x, f[0].y], *b"A.");
        git(p, &["commit", "-qm", "init"]);
        fs::write(p.join("空 格.txt"), b"staged\n").unwrap();
        git(p, &["add", "."]);
        fs::write(p.join("空 格.txt"), b"working\n").unwrap();
        fs::write(p.join("untracked"), b"u").unwrap();
        let (branch, f) = status(p);
        assert!(branch.oid.is_some());
        assert_eq!(f.len(), 2);
        let e = f.iter().find(|entry| entry.path == "空 格.txt".as_bytes()).unwrap();
        assert!(f.iter().any(|entry| entry.path == b"untracked" && [entry.x, entry.y] == *b"??"));
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
    fn raw_non_utf8_path_ignores_excluded_entries() {
        let raw = b"# branch.oid (initial)\0# branch.head main\0? odd\xff name\0! ignored\0";
        let (b, f) = parse(raw).unwrap();
        assert_eq!(b.head.as_deref(), Some("main"));
        assert_eq!(f.len(), 1);
        assert_eq!(
            URL_SAFE_NO_PAD.decode(&f[0].path_id).unwrap(),
            b"odd\xff name"
        );
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
            let e = f.iter().find(|e| e.path == b"file").unwrap();
            assert_eq!(&[e.x, e.y], shape.as_bytes());
            let expected_stages = [shape != "AA", shape != "DU", shape != "UD"];
            assert_eq!(
                e.conflict.as_ref().unwrap().each_ref().map(Option::is_some),
                expected_stages,
                "{shape}"
            );
            assert!(detect_in_progress(&p.join(".git")).merge, "{shape}");
            let scopes = scope_lists(&f, true);
            for scope in [CompareScope::Unstaged, CompareScope::Staged, CompareScope::All] {
                assert!(
                    scopes.get(scope).iter().any(|file| {
                        file.display_path == "file" && file.status == FileStatus::Conflicted
                    }),
                    "{shape} in {scope:?}"
                );
            }
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
            let e = files.iter().find(|e| e.path == b"conflict").unwrap();
            let parsed = e.conflict.as_ref().unwrap();
            for stage in 1..=3 {
                assert_eq!(parsed[stage - 1].is_some(), stages.contains(&stage));
            }
        }
    }
}
