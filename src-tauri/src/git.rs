use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
    sync::{Arc, Mutex},
};
use thiserror::Error;

const MINIMUM_GIT_VERSION: &str = "2.31.0";
const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;
const MAX_TEXT_LINES: usize = 100_000;
const MAX_LINE_CHARS: usize = 100_000;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum GitError {
    #[error("找不到或无法启动 Git：{0}")]
    GitUnavailable(String),
    #[error("Git {found} 低于最低支持版本 {minimum}")]
    UnsupportedGit { found: String, minimum: String },
    #[error("路径不是可读取的 Git 工作树：{0}")]
    InvalidRepository(String),
    #[error("Git 命令失败：{0}")]
    CommandFailed(String),
    #[error("仓库路径包含当前原型尚不支持的编码")]
    UnsupportedPathEncoding,
    #[error("文件路径越过了所选仓库边界")]
    UnsafePath,
    #[error("仓库已发生变化，请刷新")]
    StaleRequest,
    #[cfg(feature = "desktop")]
    #[error("仓库尚未打开或已失效")]
    UnknownRepository,
    #[cfg(feature = "desktop")]
    #[error("打开仓库后不能为读取请求更换 Git 可执行文件")]
    GitChanged,
    #[cfg(feature = "desktop")]
    #[error("仓库登记状态不可用")]
    Registry,
    #[cfg(feature = "desktop")]
    #[error("后台任务失败：{0}")]
    Runtime(String),
    #[error("文件读取失败：{0}")]
    Io(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    executable: String,
    version: String,
    supported: bool,
    minimum_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub repo_id: String,
    display_name: String,
    worktree_path: String,
    git_dir: String,
    common_dir: String,
    branch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    path_id: String,
    display_path: String,
    old_path_id: Option<String>,
    old_display_path: Option<String>,
    status: FileStatus,
    additions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum CompareScope {
    Unstaged,
    Staged,
    All,
}

impl CompareScope {
    fn left_endpoint(self) -> &'static str {
        match self {
            Self::Unstaged => "index",
            Self::Staged | Self::All => "head",
        }
    }

    fn right_endpoint(self) -> &'static str {
        match self {
            Self::Staged => "index",
            Self::Unstaged | Self::All => "workingTree",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    TypeChanged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    request_id: String,
    pub repo: RepositoryInfo,
    pub scope: CompareScope,
    pub revision: String,
    files: Vec<FileChange>,
    git: GitInfo,
    scanned_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSide {
    endpoint: &'static str,
    text: Option<String>,
    byte_length: usize,
    encoding: &'static str,
    eol: &'static str,
    has_final_newline: Option<bool>,
    content_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPair {
    request_id: String,
    repo_id: String,
    revision: String,
    path_id: String,
    display_path: String,
    left: TextSide,
    right: TextSide,
    stale: bool,
    degradation: Option<String>,
}

#[derive(Clone)]
pub struct GitAdapter {
    git: PathBuf,
    worktree: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    repo_id: String,
    branch: String,
    version: String,
    snapshots: Arc<Mutex<HashMap<CompareScope, (String, Vec<FileChange>, Vec<u8>)>>>,
}

impl GitAdapter {
    pub fn open(path: String, git_executable: Option<String>) -> Result<Self, GitError> {
        let git = PathBuf::from(git_executable.unwrap_or_else(|| "git".into()));
        let version_output = git_command(&git)
            .arg("--version")
            .output()
            .map_err(|error| GitError::GitUnavailable(error.to_string()))?;
        if !version_output.status.success() {
            return Err(GitError::GitUnavailable(stderr_summary(&version_output)));
        }
        let version_line = String::from_utf8_lossy(&version_output.stdout)
            .trim()
            .to_owned();
        let version = version_line
            .strip_prefix("git version ")
            .unwrap_or(&version_line)
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_owned();
        if !version_at_least(&version, MINIMUM_GIT_VERSION) {
            return Err(GitError::UnsupportedGit {
                found: version,
                minimum: MINIMUM_GIT_VERSION.into(),
            });
        }

        let requested = dunce::canonicalize(&path)
            .map_err(|error| GitError::InvalidRepository(error.to_string()))?;
        let repository_output = run_required(
            &git,
            &requested,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--absolute-git-dir",
                "--git-common-dir",
            ],
        )?;
        let repository_text = String::from_utf8(repository_output.stdout)
            .map_err(|_| GitError::UnsupportedPathEncoding)?;
        let mut repository_lines = repository_text.lines();
        let worktree = canonical_output_path(repository_lines.next())?;
        let git_dir = canonical_output_path(repository_lines.next())?;
        let common_dir = canonical_output_path(repository_lines.next())?;
        if repository_lines.next().is_some() {
            return Err(GitError::InvalidRepository(
                "Git 返回了意外的仓库信息".into(),
            ));
        }
        let symbolic = run_readonly(
            &git,
            &worktree,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )?;
        let branch = if symbolic.status.success() {
            String::from_utf8_lossy(&symbolic.stdout).trim().to_owned()
        } else {
            let oid = run_required(&git, &worktree, &["rev-parse", "--short", "HEAD"])?;
            format!("detached @ {}", String::from_utf8_lossy(&oid.stdout).trim())
        };
        let repo_id = hash_bytes(worktree.to_string_lossy().as_bytes());
        Ok(Self {
            git,
            worktree,
            git_dir,
            common_dir,
            repo_id,
            branch,
            version,
            snapshots: Arc::default(),
        })
    }

    pub fn git_executable_display(&self) -> String {
        self.git.to_string_lossy().into_owned()
    }

    #[cfg(feature = "desktop")]
    pub fn watch_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.worktree.clone()];
        if !self.git_dir.starts_with(&self.worktree) {
            paths.push(self.git_dir.clone());
        }
        if self.common_dir != self.git_dir && !self.common_dir.starts_with(&self.worktree) {
            paths.push(self.common_dir.clone());
        }
        paths
    }

    #[cfg(test)]
    pub fn snapshot(&self, request_id: String) -> Result<RepositorySnapshot, GitError> {
        self.snapshot_for_scope(request_id, CompareScope::Unstaged)
    }

    pub fn snapshot_for_scope(
        &self,
        request_id: String,
        scope: CompareScope,
    ) -> Result<RepositorySnapshot, GitError> {
        let (files, raw) = self.list_changes(scope)?;
        let revision = self.revision(scope, &raw, &files)?;
        self.snapshots
            .lock()
            .map_err(|e| GitError::Io(e.to_string()))?
            .insert(scope, (revision.clone(), files.clone(), raw));
        let display_name = self
            .worktree
            .file_name()
            .unwrap_or_else(|| OsStr::new("repository"))
            .to_string_lossy()
            .into_owned();
        Ok(RepositorySnapshot {
            request_id,
            repo: RepositoryInfo {
                repo_id: self.repo_id.clone(),
                display_name,
                worktree_path: self.worktree.to_string_lossy().into_owned(),
                git_dir: self.git_dir.to_string_lossy().into_owned(),
                common_dir: self.common_dir.to_string_lossy().into_owned(),
                branch: self
                    .current_branch()
                    .unwrap_or_else(|_| self.branch.clone()),
            },
            scope,
            revision,
            files,
            git: GitInfo {
                executable: self.git_executable_display(),
                version: self.version.clone(),
                supported: true,
                minimum_version: MINIMUM_GIT_VERSION.into(),
            },
            scanned_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
    }

    #[cfg(test)]
    pub fn read_content_pair(
        &self,
        request_id: String,
        requested_revision: String,
        path_id: String,
    ) -> Result<ContentPair, GitError> {
        self.read_content_pair_for_scope(
            request_id,
            CompareScope::Unstaged,
            requested_revision,
            path_id,
        )
    }

    pub fn read_content_pair_for_scope(
        &self,
        request_id: String,
        scope: CompareScope,
        requested_revision: String,
        path_id: String,
    ) -> Result<ContentPair, GitError> {
        let path_bytes = URL_SAFE_NO_PAD
            .decode(&path_id)
            .map_err(|_| GitError::UnsafePath)?;
        let relative =
            String::from_utf8(path_bytes).map_err(|_| GitError::UnsupportedPathEncoding)?;
        validate_relative(&relative)?;

        let (_, current_files, current_raw) = self
            .snapshots
            .lock()
            .map_err(|e| GitError::Io(e.to_string()))?
            .get(&scope)
            .cloned()
            .filter(|(revision, _, _)| revision == &requested_revision)
            .ok_or(GitError::StaleRequest)?;
        let current_revision = self.revision(scope, &current_raw, &current_files)?;
        if requested_revision != current_revision {
            return Err(GitError::StaleRequest);
        }
        let change = current_files
            .iter()
            .find(|file| file.path_id == path_id)
            .ok_or(GitError::StaleRequest)?;
        if matches!(change.status, FileStatus::Conflicted) {
            return Ok(ContentPair {
                request_id,
                repo_id: self.repo_id.clone(),
                revision: current_revision,
                path_id,
                display_path: change.display_path.clone(),
                left: unavailable_side(scope.left_endpoint()),
                right: unavailable_side(scope.right_endpoint()),
                stale: false,
                degradation: Some(
                    "文件处于未解决冲突状态，不能生成普通双端差异；Oris 不提供冲突解决操作。"
                        .into(),
                ),
            });
        }
        let old_relative = change
            .old_path_id
            .as_ref()
            .map(|value| {
                URL_SAFE_NO_PAD
                    .decode(value)
                    .map_err(|_| GitError::UnsafePath)
            })
            .transpose()?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| GitError::UnsupportedPathEncoding)?
            .unwrap_or_else(|| relative.clone());
        validate_relative(&old_relative)?;
        let no_left = matches!(change.status, FileStatus::Added | FileStatus::Untracked);
        let left_bytes = if no_left {
            Vec::new()
        } else {
            match scope {
                CompareScope::Unstaged => self.read_index(&old_relative)?,
                CompareScope::Staged | CompareScope::All => self.read_head(&old_relative)?,
            }
        };
        let deleted = matches!(change.status, FileStatus::Deleted);
        let right_bytes = if deleted {
            Vec::new()
        } else {
            match scope {
                CompareScope::Staged => self.read_index(&relative)?,
                CompareScope::Unstaged | CompareScope::All => self.read_worktree(&relative)?,
            }
        };
        let display_path = change.display_path.clone();
        let left_missing = no_left || (scope != CompareScope::Unstaged && !self.has_head());
        let (left, left_reason) = text_side(
            if left_missing {
                "emptyTree"
            } else {
                scope.left_endpoint()
            },
            left_bytes,
            left_missing,
        );
        let (right, right_reason) = text_side(scope.right_endpoint(), right_bytes, deleted);
        let degradation = [left_reason, right_reason].into_iter().flatten().next();
        if self.revision(scope, &current_raw, &current_files)? != current_revision {
            return Err(GitError::StaleRequest);
        }
        Ok(ContentPair {
            request_id,
            repo_id: self.repo_id.clone(),
            revision: current_revision,
            path_id,
            display_path,
            left,
            right,
            stale: false,
            degradation,
        })
    }

    fn list_changes(&self, scope: CompareScope) -> Result<(Vec<FileChange>, Vec<u8>), GitError> {
        if scope == CompareScope::All && !self.has_head() {
            return self.list_unborn_all();
        }
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--name-status",
            "-z",
        ];
        match scope {
            CompareScope::Unstaged => {}
            CompareScope::Staged => args.push("--cached"),
            CompareScope::All => args.push("HEAD"),
        }
        args.push("--");
        let output = run_required(&self.git, &self.worktree, &args)?;
        let mut raw = output.stdout;
        let mut files = parse_name_status(&raw)?;
        if scope != CompareScope::Staged {
            let untracked = run_required(
                &self.git,
                &self.worktree,
                &["ls-files", "--others", "--exclude-standard", "-z", "--"],
            )?;
            raw.extend_from_slice(&untracked.stdout);
            for path in untracked
                .stdout
                .split(|byte| *byte == 0)
                .filter(|field| !field.is_empty())
            {
                upsert_change(&mut files, path, None, FileStatus::Untracked);
            }
        }
        let conflicts = run_required(
            &self.git,
            &self.worktree,
            &["diff", "--name-only", "--diff-filter=U", "-z", "--"],
        )?;
        raw.extend_from_slice(&conflicts.stdout);
        for path in conflicts
            .stdout
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
        {
            upsert_change(&mut files, path, None, FileStatus::Conflicted);
        }
        self.populate_stats(scope, &mut files)?;
        files.sort_by(|left, right| left.display_path.cmp(&right.display_path));
        Ok((files, raw))
    }

    fn list_unborn_all(&self) -> Result<(Vec<FileChange>, Vec<u8>), GitError> {
        let (mut files, mut raw) = self.list_changes(CompareScope::Staged)?;
        let tracked = run_required(&self.git, &self.worktree, &["ls-files", "-z", "--"])?;
        raw.extend_from_slice(&tracked.stdout);
        for path in tracked
            .stdout
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
        {
            upsert_change(&mut files, path, None, FileStatus::Added);
        }
        let untracked = run_required(
            &self.git,
            &self.worktree,
            &["ls-files", "--others", "--exclude-standard", "-z", "--"],
        )?;
        raw.extend_from_slice(&untracked.stdout);
        for path in untracked
            .stdout
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
        {
            upsert_change(&mut files, path, None, FileStatus::Untracked);
        }
        self.populate_stats(CompareScope::Staged, &mut files)?;
        files.sort_by(|left, right| left.display_path.cmp(&right.display_path));
        Ok((files, raw))
    }

    fn populate_stats(
        &self,
        scope: CompareScope,
        files: &mut [FileChange],
    ) -> Result<(), GitError> {
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--numstat",
            "-z",
        ];
        match scope {
            CompareScope::Unstaged => {}
            CompareScope::Staged => args.push("--cached"),
            CompareScope::All if self.has_head() => args.push("HEAD"),
            CompareScope::All => args.push("--cached"),
        }
        args.push("--");
        let output = run_required(&self.git, &self.worktree, &args)?;
        for field in output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
        {
            let mut parts = field.splitn(3, |byte| *byte == b'\t');
            let additions = parts.next().and_then(parse_stat);
            let deletions = parts.next().and_then(parse_stat);
            let Some(path) = parts.next() else { continue };
            let path_id = URL_SAFE_NO_PAD.encode(path);
            if let Some(file) = files.iter_mut().find(|file| file.path_id == path_id) {
                file.additions = additions;
                file.deletions = deletions;
            }
        }
        for file in files
            .iter_mut()
            .filter(|file| matches!(file.status, FileStatus::Untracked))
        {
            let Ok(bytes) = URL_SAFE_NO_PAD.decode(&file.path_id) else {
                continue;
            };
            let Ok(relative) = String::from_utf8(bytes) else {
                continue;
            };
            let Ok(content) = self.read_worktree(&relative) else {
                continue;
            };
            if content.len() <= MAX_TEXT_BYTES && !content.contains(&0) {
                file.additions = Some(
                    content.iter().filter(|byte| **byte == b'\n').count() as u64
                        + u64::from(!content.is_empty() && !content.ends_with(b"\n")),
                );
                file.deletions = Some(0);
            }
        }
        Ok(())
    }

    fn has_head(&self) -> bool {
        run_readonly(
            &self.git,
            &self.worktree,
            &["rev-parse", "--verify", "HEAD"],
        )
        .map(|output| output.status.success())
        .unwrap_or(false)
    }

    fn current_branch(&self) -> Result<String, GitError> {
        let symbolic = run_readonly(
            &self.git,
            &self.worktree,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )?;
        if symbolic.status.success() {
            return Ok(String::from_utf8_lossy(&symbolic.stdout).trim().to_owned());
        }
        let detached = run_readonly(&self.git, &self.worktree, &["rev-parse", "--short", "HEAD"])?;
        if detached.status.success() {
            Ok(format!(
                "detached @ {}",
                String::from_utf8_lossy(&detached.stdout).trim()
            ))
        } else {
            Ok("unborn HEAD".into())
        }
    }

    fn read_index(&self, relative: &str) -> Result<Vec<u8>, GitError> {
        let spec = format!(":{relative}");
        let output = run_readonly(&self.git, &self.worktree, &["show", "--no-textconv", &spec])?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Ok(Vec::new())
        }
    }

    fn read_head(&self, relative: &str) -> Result<Vec<u8>, GitError> {
        if !self.has_head() {
            return Ok(Vec::new());
        }
        let spec = format!("HEAD:{relative}");
        let output = run_readonly(&self.git, &self.worktree, &["show", "--no-textconv", &spec])?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Ok(Vec::new())
        }
    }

    fn read_worktree(&self, relative: &str) -> Result<Vec<u8>, GitError> {
        let working_path = self.worktree.join(Path::new(relative));
        let resolved = match dunce::canonicalize(&working_path) {
            Ok(path) if path.starts_with(&self.worktree) => Some(path),
            Ok(_) => return Err(GitError::UnsafePath),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(GitError::Io(error.to_string())),
        };
        match resolved.as_deref().map(fs::symlink_metadata) {
            Some(Ok(metadata)) if metadata.file_type().is_symlink() => Err(GitError::UnsafePath),
            Some(Ok(metadata)) if metadata.is_file() => {
                fs::read(resolved.unwrap()).map_err(|error| GitError::Io(error.to_string()))
            }
            Some(Ok(_)) => Err(GitError::UnsafePath),
            Some(Err(error)) => Err(GitError::Io(error.to_string())),
            None => Ok(Vec::new()),
        }
    }

    fn revision(
        &self,
        scope: CompareScope,
        status_bytes: &[u8],
        files: &[FileChange],
    ) -> Result<String, GitError> {
        let mut digest = Sha256::new();
        digest.update(format!("{scope:?}").as_bytes());
        // Revision checks run for every content read. Read local ref storage rather
        // than spawning rev-parse + symbolic-ref (twice around each read).
        for directory in [&self.git_dir, &self.common_dir] {
            if let Ok(packed) = fs::read(directory.join("packed-refs")) {
                digest.update(packed);
            }
        }
        // Reftable repositories do not expose loose refs; keep the CLI fallback.
        if self.common_dir.join("reftable").exists() {
            digest.update(
                run_readonly(
                    &self.git,
                    &self.worktree,
                    &["rev-parse", "--verify", "HEAD"],
                )?
                .stdout,
            );
            digest.update(self.current_branch()?.as_bytes());
        }
        let mut reference = "HEAD".to_owned();
        for _ in 0..8 {
            validate_relative(&reference)?;
            let bytes = fs::read(self.git_dir.join(&reference))
                .or_else(|_| fs::read(self.common_dir.join(&reference)))
                .unwrap_or_default();
            digest.update(reference.as_bytes());
            digest.update(&bytes);
            let value = String::from_utf8_lossy(&bytes);
            if let Some(next) = value.trim().strip_prefix("ref: ") {
                reference = next.to_owned();
            } else {
                break;
            }
        }
        digest.update(status_bytes);
        for index in [self.git_dir.join("index"), self.common_dir.join("index")] {
            if let Ok(metadata) = fs::metadata(index) {
                digest.update(metadata.len().to_le_bytes());
                update_modified(&mut digest, &metadata);
            }
        }
        for file in files {
            let bytes = URL_SAFE_NO_PAD
                .decode(&file.path_id)
                .map_err(|_| GitError::UnsafePath)?;
            if let Ok(relative) = String::from_utf8(bytes) {
                if let Ok(metadata) = fs::symlink_metadata(self.worktree.join(relative)) {
                    digest.update(metadata.len().to_le_bytes());
                    update_modified(&mut digest, &metadata);
                }
            }
        }
        Ok(hex::encode(digest.finalize()))
    }
}

fn parse_name_status(raw: &[u8]) -> Result<Vec<FileChange>, GitError> {
    let fields: Vec<&[u8]> = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let code = fields[index];
        index += 1;
        let first = code
            .first()
            .copied()
            .ok_or_else(|| GitError::CommandFailed("Git 返回空状态".into()))?;
        if matches!(first, b'R' | b'C') {
            if index + 1 >= fields.len() {
                return Err(GitError::CommandFailed(
                    "无法解析 Git rename NUL 输出".into(),
                ));
            }
            let old_path = fields[index];
            let new_path = fields[index + 1];
            index += 2;
            upsert_change(&mut files, new_path, Some(old_path), FileStatus::Renamed);
            continue;
        }
        if index >= fields.len() {
            return Err(GitError::CommandFailed("无法解析 Git NUL 分隔输出".into()));
        }
        let path = fields[index];
        index += 1;
        let status = match first {
            b'A' => FileStatus::Added,
            b'M' => FileStatus::Modified,
            b'D' => FileStatus::Deleted,
            b'T' => FileStatus::TypeChanged,
            b'U' => FileStatus::Conflicted,
            _ => continue,
        };
        upsert_change(&mut files, path, None, status);
    }
    Ok(files)
}

fn parse_stat(value: &[u8]) -> Option<u64> {
    if value == b"-" {
        None
    } else {
        std::str::from_utf8(value).ok()?.parse().ok()
    }
}

fn upsert_change(
    files: &mut Vec<FileChange>,
    path: &[u8],
    old_path: Option<&[u8]>,
    status: FileStatus,
) {
    let path_id = URL_SAFE_NO_PAD.encode(path);
    let value = FileChange {
        path_id: path_id.clone(),
        display_path: String::from_utf8_lossy(path).into_owned(),
        old_path_id: old_path.map(|value| URL_SAFE_NO_PAD.encode(value)),
        old_display_path: old_path.map(|value| String::from_utf8_lossy(value).into_owned()),
        status,
        additions: None,
        deletions: None,
    };
    if let Some(existing) = files.iter_mut().find(|file| file.path_id == path_id) {
        *existing = value;
    } else {
        files.push(value);
    }
}

fn update_modified(digest: &mut Sha256, metadata: &fs::Metadata) {
    if let Ok(modified) = metadata.modified() {
        if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
            digest.update(duration.as_nanos().to_le_bytes());
        }
    }
}

fn unavailable_side(endpoint: &'static str) -> TextSide {
    TextSide {
        endpoint,
        text: None,
        byte_length: 0,
        encoding: "missing",
        eol: "none",
        has_final_newline: None,
        content_id: hash_bytes(&[]),
    }
}

fn text_side(endpoint: &'static str, bytes: Vec<u8>, missing: bool) -> (TextSide, Option<String>) {
    let content_id = hash_bytes(&bytes);
    if missing {
        return (
            TextSide {
                endpoint,
                text: Some(String::new()),
                byte_length: 0,
                encoding: "missing",
                eol: "none",
                has_final_newline: None,
                content_id,
            },
            None,
        );
    }
    if bytes.len() > MAX_TEXT_BYTES {
        let reason = format!(
            "内容为 {} 字节，超过 {} 字节全文预算；未静默截断。",
            bytes.len(),
            MAX_TEXT_BYTES
        );
        return (
            TextSide {
                endpoint,
                text: None,
                byte_length: bytes.len(),
                encoding: "binary-or-unsupported",
                eol: "none",
                has_final_newline: None,
                content_id,
            },
            Some(reason),
        );
    }
    let byte_length = bytes.len();
    let text = match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => text,
        _ => {
            let reason = "内容不是受支持的 UTF-8 文本或包含 NUL；未显示为无差异。".to_owned();
            return (
                TextSide {
                    endpoint,
                    text: None,
                    byte_length,
                    encoding: "binary-or-unsupported",
                    eol: "none",
                    has_final_newline: None,
                    content_id,
                },
                Some(reason),
            );
        }
    };
    let lines = text.lines().count();
    let longest = text
        .lines()
        .map(str::chars)
        .map(Iterator::count)
        .max()
        .unwrap_or(0);
    if lines > MAX_TEXT_LINES || longest > MAX_LINE_CHARS {
        let reason =
            format!("内容为 {lines} 行，最长行 {longest} 字符，超过显示预算；未静默截断。");
        return (
            TextSide {
                endpoint,
                text: None,
                byte_length,
                encoding: "utf-8",
                eol: eol(&text),
                has_final_newline: Some(text.ends_with('\n')),
                content_id,
            },
            Some(reason),
        );
    }
    let line_ending = eol(&text);
    let final_newline = text.ends_with('\n');
    (
        TextSide {
            endpoint,
            text: Some(text),
            byte_length,
            encoding: "utf-8",
            eol: line_ending,
            has_final_newline: Some(final_newline),
            content_id,
        },
        None,
    )
}

fn eol(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    if lf == 0 {
        "none"
    } else if crlf == 0 {
        "lf"
    } else if crlf == lf {
        "crlf"
    } else {
        "mixed"
    }
}

fn validate_relative(path: &str) -> Result<(), GitError> {
    let parsed = Path::new(path);
    if parsed.is_absolute()
        || parsed
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(GitError::UnsafePath);
    }
    Ok(())
}

fn canonical_output_path(value: Option<&str>) -> Result<PathBuf, GitError> {
    dunce::canonicalize(
        value.ok_or_else(|| GitError::InvalidRepository("Git 未返回完整仓库路径".into()))?,
    )
    .map_err(|error| GitError::InvalidRepository(error.to_string()))
}

fn git_command(git: &Path) -> Command {
    let mut command = Command::new(git);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn run_required(git: &Path, cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    let output = run_readonly(git, cwd, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(GitError::CommandFailed(stderr_summary(&output)))
    }
}

fn run_readonly(git: &Path, cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    git_command(git)
        .arg("--no-optional-locks")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("diff.external=")
        .arg("-c")
        .arg("diff.trustExitCode=false")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_EXTERNAL_DIFF", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| GitError::GitUnavailable(error.to_string()))
}

fn stderr_summary(output: &Output) -> String {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if message.is_empty() {
        format!("退出码 {}", output.status.code().unwrap_or(-1))
    } else {
        message.chars().take(1000).collect()
    }
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn version_at_least(found: &str, minimum: &str) -> bool {
    let parse = |value: &str| -> Vec<u32> {
        value
            .split('.')
            .take(3)
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let mut found = parse(found);
    let mut minimum = parse(minimum);
    found.resize(3, 0);
    minimum.resize(3, 0);
    found >= minimum
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;
    use tempfile::TempDir;

    fn git(cwd: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap()
    }

    fn fixture() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        assert!(git(dir.path(), &["init", "-q"]).status.success());
        assert!(git(
            dir.path(),
            &["config", "user.email", "fixture@example.invalid"]
        )
        .status
        .success());
        assert!(git(dir.path(), &["config", "user.name", "Oris Fixture"])
            .status
            .success());
        fs::write(
            dir.path().join("hello.ts"),
            "export const value = \"old\";\n",
        )
        .unwrap();
        assert!(git(dir.path(), &["add", "hello.ts"]).status.success());
        assert!(git(dir.path(), &["commit", "-qm", "base"]).status.success());
        fs::write(
            dir.path().join("hello.ts"),
            "export const value = \"new\";\nexport const added = true;\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn reads_real_index_and_worktree_without_writes() {
        let dir = fixture();
        let before_status = git(dir.path(), &["status", "--porcelain=v2", "-z"]).stdout;
        let before_index = fs::read(dir.path().join(".git/index")).unwrap();
        let before_head = git(dir.path(), &["rev-parse", "HEAD"]).stdout;
        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let snapshot = adapter.snapshot("open-1".into()).unwrap();
        assert_eq!(snapshot.files.len(), 1);
        let pair = adapter
            .read_content_pair(
                "read-1".into(),
                snapshot.revision,
                snapshot.files[0].path_id.clone(),
            )
            .unwrap();
        assert_eq!(
            pair.left.text.as_deref(),
            Some("export const value = \"old\";\n")
        );
        assert!(pair.right.text.as_deref().unwrap().contains("added = true"));
        assert!(!pair.stale);
        assert_eq!(
            before_status,
            git(dir.path(), &["status", "--porcelain=v2", "-z"]).stdout
        );
        assert_eq!(
            before_index,
            fs::read(dir.path().join(".git/index")).unwrap()
        );
        assert_eq!(before_head, git(dir.path(), &["rev-parse", "HEAD"]).stdout);
    }

    #[test]
    fn ignores_external_diff_and_fsmonitor() {
        let dir = fixture();
        fs::write(
            dir.path().join(".gitattributes"),
            "*.ts diff=oris-testconv\n",
        )
        .unwrap();
        assert!(git(dir.path(), &["add", ".gitattributes"]).status.success());
        assert!(git(dir.path(), &["commit", "-qm", "add attributes"])
            .status
            .success());

        let extension = if cfg!(windows) { "cmd" } else { "sh" };
        let external_marker = dir.path().join("external-marker.txt");
        let external_script = dir.path().join(format!("external.{extension}"));
        let fsmonitor_marker = dir.path().join("fsmonitor-marker.txt");
        let fsmonitor_script = dir.path().join(format!("fsmonitor.{extension}"));
        let textconv_marker = dir.path().join("textconv-marker.txt");
        let textconv_script = dir.path().join(format!("textconv.{extension}"));
        write_marker_script(&external_script, &external_marker);
        write_marker_script(&fsmonitor_script, &fsmonitor_marker);
        write_marker_script(&textconv_script, &textconv_marker);
        assert!(git(
            dir.path(),
            &[
                "config",
                "diff.external",
                &external_script.to_string_lossy()
            ]
        )
        .status
        .success());
        assert!(git(
            dir.path(),
            &[
                "config",
                "core.fsmonitor",
                &fsmonitor_script.to_string_lossy()
            ]
        )
        .status
        .success());
        assert!(git(
            dir.path(),
            &[
                "config",
                "diff.oris-testconv.textconv",
                &textconv_script.to_string_lossy(),
            ]
        )
        .status
        .success());
        let before_worktree = worktree_manifest(dir.path());
        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let snapshot = adapter.snapshot("safe-1".into()).unwrap();
        let _ = adapter
            .read_content_pair(
                "safe-2".into(),
                snapshot.revision,
                snapshot.files[0].path_id.clone(),
            )
            .unwrap();
        assert!(
            !external_marker.exists(),
            "external diff helper was executed"
        );
        assert!(!fsmonitor_marker.exists(), "fsmonitor helper was executed");
        assert!(!textconv_marker.exists(), "textconv helper was executed");
        assert_eq!(before_worktree, worktree_manifest(dir.path()));
    }

    #[test]
    fn rejects_parent_paths_and_versions_compare_numerically() {
        assert!(validate_relative("../secret").is_err());
        assert!(validate_relative("src/main.rs").is_ok());
        assert!(version_at_least("2.44.0.windows.1", MINIMUM_GIT_VERSION));
        assert!(!version_at_least("2.9.5", MINIMUM_GIT_VERSION));
    }

    #[cfg(windows)]
    #[test]
    fn production_command_factory_creates_no_console_window() {
        let script = "Add-Type -Name Native -Namespace Oris -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();'; [Oris.Native]::GetConsoleWindow().ToInt64()";
        let output = git_command(Path::new("powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", stderr_summary(&output));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    #[test]
    fn rejects_a_result_after_the_worktree_revision_changes() {
        let dir = fixture();
        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let snapshot = adapter.snapshot("stale-open".into()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(
            dir.path().join("hello.ts"),
            "export const value = \"changed-again\";\n",
        )
        .unwrap();
        let result = adapter.read_content_pair(
            "stale-read".into(),
            snapshot.revision,
            snapshot.files[0].path_id.clone(),
        );
        assert!(matches!(result, Err(GitError::StaleRequest)));
    }

    #[test]
    fn degrades_oversized_files_and_lines_without_truncating() {
        let (large, reason) = text_side("workingTree", vec![b'x'; MAX_TEXT_BYTES + 1], false);
        assert!(large.text.is_none());
        assert!(reason.unwrap().contains("未静默截断"));

        let long_line = "x".repeat(MAX_LINE_CHARS + 1).into_bytes();
        let (line, reason) = text_side("workingTree", long_line, false);
        assert!(line.text.is_none());
        assert!(reason.unwrap().contains("最长行"));
    }

    #[test]
    fn reads_staged_unstaged_and_all_as_distinct_endpoint_pairs() {
        let dir = fixture();
        assert!(git(dir.path(), &["add", "hello.ts"]).status.success());
        fs::write(dir.path().join("hello.ts"), "working tree only\n").unwrap();
        fs::write(dir.path().join("未跟踪 # file.txt"), "new text\n").unwrap();
        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();

        let staged = adapter
            .snapshot_for_scope("staged".into(), CompareScope::Staged)
            .unwrap();
        let staged_file = staged
            .files
            .iter()
            .find(|file| file.display_path == "hello.ts")
            .unwrap();
        assert!(staged_file.additions.is_some() && staged_file.deletions.is_some());
        let staged_pair = adapter
            .read_content_pair_for_scope(
                "staged-pair".into(),
                CompareScope::Staged,
                staged.revision.clone(),
                staged_file.path_id.clone(),
            )
            .unwrap();
        assert_eq!(
            staged_pair.left.text.as_deref(),
            Some("export const value = \"old\";\n")
        );
        assert!(staged_pair
            .right
            .text
            .as_deref()
            .unwrap()
            .contains("added = true"));

        let unstaged = adapter
            .snapshot_for_scope("unstaged".into(), CompareScope::Unstaged)
            .unwrap();
        assert!(unstaged
            .files
            .iter()
            .any(|file| matches!(file.status, FileStatus::Untracked)));
        assert_eq!(
            unstaged
                .files
                .iter()
                .find(|file| file.display_path == "未跟踪 # file.txt")
                .and_then(|file| file.additions),
            Some(1)
        );
        let unstaged_file = unstaged
            .files
            .iter()
            .find(|file| file.display_path == "hello.ts")
            .unwrap();
        let unstaged_pair = adapter
            .read_content_pair_for_scope(
                "unstaged-pair".into(),
                CompareScope::Unstaged,
                unstaged.revision.clone(),
                unstaged_file.path_id.clone(),
            )
            .unwrap();
        assert!(unstaged_pair
            .left
            .text
            .as_deref()
            .unwrap()
            .contains("added = true"));
        assert_eq!(
            unstaged_pair.right.text.as_deref(),
            Some("working tree only\n")
        );

        let all = adapter
            .snapshot_for_scope("all".into(), CompareScope::All)
            .unwrap();
        let all_file = all
            .files
            .iter()
            .find(|file| file.display_path == "hello.ts")
            .unwrap();
        let all_pair = adapter
            .read_content_pair_for_scope(
                "all-pair".into(),
                CompareScope::All,
                all.revision.clone(),
                all_file.path_id.clone(),
            )
            .unwrap();
        assert_eq!(
            all_pair.left.text.as_deref(),
            Some("export const value = \"old\";\n")
        );
        assert_eq!(all_pair.right.text.as_deref(), Some("working tree only\n"));
    }

    #[test]
    fn reports_rename_delete_untracked_special_paths_and_conflicts() {
        let dir = fixture();
        fs::write(dir.path().join("rename old.txt"), "rename\n").unwrap();
        fs::write(dir.path().join("delete.txt"), "delete\n").unwrap();
        fs::write(dir.path().join("conflict.txt"), "base\n").unwrap();
        assert!(git(dir.path(), &["add", "--all"]).status.success());
        assert!(git(dir.path(), &["commit", "-qm", "paths"])
            .status
            .success());
        assert!(
            git(dir.path(), &["mv", "rename old.txt", "renamed 中文 #.txt"])
                .status
                .success()
        );
        fs::remove_file(dir.path().join("delete.txt")).unwrap();
        fs::write(dir.path().join("untracked [x].txt"), "new\n").unwrap();
        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let all = adapter
            .snapshot_for_scope("paths".into(), CompareScope::All)
            .unwrap();
        let renamed = all
            .files
            .iter()
            .find(|file| matches!(file.status, FileStatus::Renamed))
            .unwrap();
        assert_eq!(renamed.old_display_path.as_deref(), Some("rename old.txt"));
        assert_eq!(renamed.display_path, "renamed 中文 #.txt");
        assert!(all
            .files
            .iter()
            .any(|file| file.display_path == "delete.txt"
                && matches!(file.status, FileStatus::Deleted)));
        assert!(all
            .files
            .iter()
            .any(|file| file.display_path == "untracked [x].txt"
                && matches!(file.status, FileStatus::Untracked)));

        assert!(git(dir.path(), &["commit", "-am", "main conflict"])
            .status
            .success());
        let main = String::from_utf8_lossy(&git(dir.path(), &["branch", "--show-current"]).stdout)
            .trim()
            .to_owned();
        assert!(git(dir.path(), &["checkout", "-qb", "side", "HEAD~1"])
            .status
            .success());
        fs::write(dir.path().join("conflict.txt"), "side\n").unwrap();
        assert!(git(dir.path(), &["commit", "-am", "side conflict"])
            .status
            .success());
        assert!(git(dir.path(), &["checkout", "-q", &main]).status.success());
        fs::write(dir.path().join("conflict.txt"), "main\n").unwrap();
        assert!(git(dir.path(), &["commit", "-am", "main conflict content"])
            .status
            .success());
        assert!(!git(dir.path(), &["merge", "side"]).status.success());
        let conflict_adapter =
            GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let conflict = conflict_adapter
            .snapshot_for_scope("conflict".into(), CompareScope::All)
            .unwrap();
        let file = conflict
            .files
            .iter()
            .find(|file| file.display_path == "conflict.txt")
            .unwrap();
        assert!(matches!(file.status, FileStatus::Conflicted));
        let pair = conflict_adapter
            .read_content_pair_for_scope(
                "conflict-pair".into(),
                CompareScope::All,
                conflict.revision.clone(),
                file.path_id.clone(),
            )
            .unwrap();
        assert!(pair.degradation.unwrap().contains("未解决冲突"));
    }

    #[test]
    fn supports_unborn_head_and_revision_changes_after_external_git_operations() {
        let empty = tempfile::tempdir().unwrap();
        assert!(git(empty.path(), &["init", "-q"]).status.success());
        fs::write(empty.path().join("first.txt"), "first\n").unwrap();
        assert!(git(empty.path(), &["add", "first.txt"]).status.success());
        let empty_adapter =
            GitAdapter::open(empty.path().to_string_lossy().into_owned(), None).unwrap();
        let empty_snapshot = empty_adapter
            .snapshot_for_scope("empty".into(), CompareScope::All)
            .unwrap();
        assert!(!empty_snapshot.repo.branch.is_empty());
        let empty_file = empty_snapshot
            .files
            .iter()
            .find(|file| file.display_path == "first.txt")
            .unwrap();
        let empty_pair = empty_adapter
            .read_content_pair_for_scope(
                "empty-pair".into(),
                CompareScope::All,
                empty_snapshot.revision.clone(),
                empty_file.path_id.clone(),
            )
            .unwrap();
        assert_eq!(empty_pair.left.endpoint, "emptyTree");
        assert_eq!(empty_pair.right.text.as_deref(), Some("first\n"));

        let dir = fixture();
        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let before = adapter
            .snapshot_for_scope("before".into(), CompareScope::All)
            .unwrap();
        assert!(git(dir.path(), &["add", "hello.ts"]).status.success());
        let after_add = adapter
            .snapshot_for_scope("after-add".into(), CompareScope::All)
            .unwrap();
        assert_ne!(before.revision, after_add.revision);
        assert!(git(dir.path(), &["commit", "-qm", "external commit"])
            .status
            .success());
        let after_commit = adapter
            .snapshot_for_scope("after-commit".into(), CompareScope::All)
            .unwrap();
        assert_ne!(after_add.revision, after_commit.revision);
        assert!(git(dir.path(), &["checkout", "-qb", "external-branch"])
            .status
            .success());
        let after_checkout = adapter
            .snapshot_for_scope("after-checkout".into(), CompareScope::All)
            .unwrap();
        assert_ne!(after_commit.revision, after_checkout.revision);
        assert_eq!(after_checkout.repo.branch, "external-branch");
    }

    #[test]
    fn cached_content_rejects_index_and_packed_head_changes() {
        let dir = fixture();
        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let snapshot = adapter
            .snapshot_for_scope("before".into(), CompareScope::All)
            .unwrap();
        assert!(git(dir.path(), &["add", "hello.ts"]).status.success());
        assert!(matches!(
            adapter.read_content_pair_for_scope(
                "stale".into(),
                CompareScope::All,
                snapshot.revision,
                snapshot.files[0].path_id.clone()
            ),
            Err(GitError::StaleRequest)
        ));
        assert!(git(dir.path(), &["pack-refs", "--all"]).status.success());
        let snapshot = adapter
            .snapshot_for_scope("packed".into(), CompareScope::All)
            .unwrap();
        let pair = adapter
            .read_content_pair_for_scope(
                "fresh".into(),
                CompareScope::All,
                snapshot.revision.clone(),
                snapshot.files[0].path_id.clone(),
            )
            .unwrap();
        assert!(pair.left.text.is_some());
        assert!(git(dir.path(), &["commit", "-qm", "move HEAD"])
            .status
            .success());
        assert!(matches!(
            adapter.read_content_pair_for_scope(
                "moved".into(),
                CompareScope::All,
                snapshot.revision,
                snapshot.files[0].path_id.clone()
            ),
            Err(GitError::StaleRequest)
        ));
    }

    #[test]
    #[ignore = "explicit task-02 five-repository switch probe"]
    fn task02_five_repository_switch_probe() {
        let mut directories = Vec::new();
        let mut adapters = Vec::new();
        for project in 0..5 {
            let dir = tempfile::tempdir().unwrap();
            assert!(git(dir.path(), &["init", "-q"]).status.success());
            assert!(git(
                dir.path(),
                &["config", "user.email", "fixture@example.invalid"]
            )
            .status
            .success());
            assert!(git(dir.path(), &["config", "user.name", "Oris Task02"])
                .status
                .success());
            for file in 0..100 {
                fs::write(
                    dir.path()
                        .join(format!("project-{project}-file-{file:03}.txt")),
                    format!("baseline {file}\n"),
                )
                .unwrap();
            }
            assert!(git(dir.path(), &["add", "--all"]).status.success());
            assert!(git(dir.path(), &["commit", "-qm", "baseline"])
                .status
                .success());
            for file in 0..20 {
                fs::write(
                    dir.path()
                        .join(format!("project-{project}-file-{file:03}.txt")),
                    format!("changed {file}\nsecond\n"),
                )
                .unwrap();
            }
            adapters
                .push(GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap());
            directories.push(dir);
        }
        let mut samples = Vec::new();
        for run in 0..30 {
            let started = Instant::now();
            let snapshot = adapters[run % adapters.len()]
                .snapshot_for_scope(format!("switch-{run}"), CompareScope::All)
                .unwrap();
            assert_eq!(snapshot.files.len(), 20);
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let percentile = |p: f64| {
            samples[((samples.len() as f64 * p).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len() - 1)]
        };
        println!("ORIS_TASK02_PERF {{\"projects\":5,\"runs\":30,\"filesPerProject\":100,\"changedPerProject\":20,\"switchP50Ms\":{:.2},\"switchP95Ms\":{:.2},\"contentCacheBudgetMiB\":16,\"contentCacheEntries\":12,\"workingSetMB\":{:.2}}}", percentile(0.50), percentile(0.95), working_set_mb());
        drop(directories);
    }

    #[test]
    #[ignore = "explicit task-01 S/L performance probe"]
    fn performance_probe_from_environment() {
        let file_count = std::env::var("ORIS_PERF_FILES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(10_000);
        let changed_count = std::env::var("ORIS_PERF_CHANGED")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(100);
        let runs = std::env::var("ORIS_PERF_RUNS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(30);
        assert!(changed_count > 0 && changed_count <= file_count && runs > 0);

        let fixture_started = Instant::now();
        let dir = tempfile::tempdir().unwrap();
        assert!(git(dir.path(), &["init", "-q"]).status.success());
        assert!(git(
            dir.path(),
            &["config", "user.email", "fixture@example.invalid"]
        )
        .status
        .success());
        assert!(git(dir.path(), &["config", "user.name", "Oris Perf"])
            .status
            .success());
        for index in 0..file_count {
            let folder = dir.path().join(format!("files/{:03}", index / 1000));
            if index % 1000 == 0 {
                fs::create_dir_all(&folder).unwrap();
            }
            fs::write(
                folder.join(format!("file-{index:06}.txt")),
                format!("baseline {index}\ncontext\n"),
            )
            .unwrap();
        }
        assert!(git(dir.path(), &["add", "--all"]).status.success());
        assert!(git(
            dir.path(),
            &[
                "-c",
                "gc.auto=0",
                "-c",
                "maintenance.auto=false",
                "commit",
                "-qm",
                "performance baseline",
            ]
        )
        .status
        .success());
        for index in 0..changed_count {
            let file = dir
                .path()
                .join(format!("files/{:03}/file-{index:06}.txt", index / 1000));
            fs::write(
                file,
                format!("changed {index}\ncontext\nadded one\nadded two\n"),
            )
            .unwrap();
        }
        let fixture_ms = fixture_started.elapsed().as_secs_f64() * 1000.0;

        let adapter = GitAdapter::open(dir.path().to_string_lossy().into_owned(), None).unwrap();
        let mut snapshot_ms = Vec::with_capacity(runs);
        let mut content_ms = Vec::with_capacity(runs);
        for run in 0..runs {
            let started = Instant::now();
            let snapshot = adapter.snapshot(format!("snapshot-{run}")).unwrap();
            snapshot_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(snapshot.files.len(), changed_count);
            let started = Instant::now();
            let pair = adapter
                .read_content_pair(
                    format!("content-{run}"),
                    snapshot.revision,
                    snapshot.files[run % snapshot.files.len()].path_id.clone(),
                )
                .unwrap();
            content_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            assert!(!pair.stale);
            assert!(pair.left.text.is_some() && pair.right.text.is_some());
        }
        snapshot_ms.sort_by(f64::total_cmp);
        content_ms.sort_by(f64::total_cmp);
        let percentile = |values: &[f64], percentile: f64| {
            let index = ((values.len() as f64 * percentile).ceil() as usize)
                .saturating_sub(1)
                .min(values.len() - 1);
            values[index]
        };
        println!(
            "ORIS_PERF_RESULT {{\"files\":{file_count},\"changed\":{changed_count},\"runs\":{runs},\"fixtureMs\":{fixture_ms:.2},\"snapshotP50Ms\":{:.2},\"snapshotP95Ms\":{:.2},\"contentP50Ms\":{:.2},\"contentP95Ms\":{:.2},\"workingSetMB\":{:.2}}}",
            percentile(&snapshot_ms, 0.50),
            percentile(&snapshot_ms, 0.95),
            percentile(&content_ms, 0.50),
            percentile(&content_ms, 0.95),
            working_set_mb()
        );
    }

    #[cfg(windows)]
    fn working_set_mb() -> f64 {
        let pid = std::process::id().to_string();
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output();
        let Ok(output) = output else { return 0.0 };
        let text = String::from_utf8_lossy(&output.stdout);
        let memory = text
            .trim()
            .trim_matches('"')
            .split("\",\"")
            .nth(4)
            .unwrap_or("");
        memory
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
            .parse::<f64>()
            .unwrap_or(0.0)
            / 1024.0
    }

    #[cfg(not(windows))]
    fn working_set_mb() -> f64 {
        0.0
    }

    #[cfg(windows)]
    fn write_marker_script(script: &Path, marker: &Path) {
        fs::write(script, format!("@echo touched>{}\r\n", marker.display())).unwrap();
    }

    #[cfg(unix)]
    fn write_marker_script(script: &Path, marker: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(
            script,
            format!("#!/bin/sh\necho touched > '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(script, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn worktree_manifest(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn collect(root: &Path, current: &Path, output: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in fs::read_dir(current).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if path == root.join(".git") {
                    continue;
                }
                let metadata = fs::symlink_metadata(&path).unwrap();
                if metadata.is_dir() {
                    collect(root, &path, output);
                } else if metadata.is_file() {
                    output.push((
                        path.strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(path).unwrap(),
                    ));
                }
            }
        }
        let mut output = Vec::new();
        collect(root, root, &mut output);
        output.sort_by(|left, right| left.0.cmp(&right.0));
        output
    }
}
