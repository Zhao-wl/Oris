use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
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
    status: FileStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum FileStatus {
    Modified,
    Deleted,
    TypeChanged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    request_id: String,
    pub repo: RepositoryInfo,
    pub revision: String,
    files: Vec<FileChange>,
    git: GitInfo,
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
                "--abbrev-ref",
                "HEAD",
            ],
        )?;
        let repository_text = String::from_utf8(repository_output.stdout)
            .map_err(|_| GitError::UnsupportedPathEncoding)?;
        let mut repository_lines = repository_text.lines();
        let worktree = canonical_output_path(repository_lines.next())?;
        let git_dir = canonical_output_path(repository_lines.next())?;
        let common_dir = canonical_output_path(repository_lines.next())?;
        let branch_name = repository_lines
            .next()
            .ok_or_else(|| GitError::InvalidRepository("Git 未返回分支信息".into()))?;
        if repository_lines.next().is_some() {
            return Err(GitError::InvalidRepository(
                "Git 返回了意外的仓库信息".into(),
            ));
        }
        let branch = if branch_name == "HEAD" {
            let oid = run_required(&git, &worktree, &["rev-parse", "--short", "HEAD"])?;
            format!("detached @ {}", String::from_utf8_lossy(&oid.stdout).trim())
        } else {
            branch_name.to_owned()
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
        })
    }

    pub fn git_executable_display(&self) -> String {
        self.git.to_string_lossy().into_owned()
    }

    pub fn snapshot(&self, request_id: String) -> Result<RepositorySnapshot, GitError> {
        let (files, raw) = self.list_unstaged()?;
        let revision = self.revision(&raw, &files)?;
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
                branch: self.branch.clone(),
            },
            revision,
            files,
            git: GitInfo {
                executable: self.git_executable_display(),
                version: self.version.clone(),
                supported: true,
                minimum_version: MINIMUM_GIT_VERSION.into(),
            },
        })
    }

    pub fn read_content_pair(
        &self,
        request_id: String,
        requested_revision: String,
        path_id: String,
    ) -> Result<ContentPair, GitError> {
        let path_bytes = URL_SAFE_NO_PAD
            .decode(&path_id)
            .map_err(|_| GitError::UnsafePath)?;
        let relative =
            String::from_utf8(path_bytes).map_err(|_| GitError::UnsupportedPathEncoding)?;
        validate_relative(&relative)?;

        let index_spec = format!(":{relative}");
        let left_output = run_readonly(
            &self.git,
            &self.worktree,
            &["show", "--no-textconv", &index_spec],
        )?;
        let left_bytes = if left_output.status.success() {
            left_output.stdout
        } else {
            return Err(GitError::CommandFailed(stderr_summary(&left_output)));
        };
        let working_path = self.worktree.join(Path::new(&relative));
        let resolved_working_path = match dunce::canonicalize(&working_path) {
            Ok(path) if path.starts_with(&self.worktree) => Some(path),
            Ok(_) => return Err(GitError::UnsafePath),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(GitError::Io(error.to_string())),
        };
        let right_bytes = match resolved_working_path.as_deref().map(fs::symlink_metadata) {
            Some(Ok(metadata)) if metadata.file_type().is_symlink() => {
                return Err(GitError::UnsafePath)
            }
            Some(Ok(metadata)) if metadata.is_file() => {
                fs::read(resolved_working_path.as_ref().unwrap())
                    .map_err(|error| GitError::Io(error.to_string()))?
            }
            Some(Ok(_)) => return Err(GitError::UnsafePath),
            Some(Err(error)) => return Err(GitError::Io(error.to_string())),
            None => Vec::new(),
        };
        let (current_files, current_raw) = self.list_unstaged()?;
        let current_revision = self.revision(&current_raw, &current_files)?;
        if requested_revision != current_revision {
            return Err(GitError::StaleRequest);
        }
        let change = current_files
            .iter()
            .find(|file| file.path_id == path_id)
            .ok_or(GitError::StaleRequest)?;
        let deleted = matches!(change.status, FileStatus::Deleted);
        let display_path = change.display_path.clone();
        let (left, left_reason) = text_side("index", left_bytes, false);
        let (right, right_reason) = text_side("workingTree", right_bytes, deleted);
        let degradation = [left_reason, right_reason].into_iter().flatten().next();
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

    fn list_unstaged(&self) -> Result<(Vec<FileChange>, Vec<u8>), GitError> {
        let output = run_required(
            &self.git,
            &self.worktree,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--name-status",
                "-z",
                "--",
            ],
        )?;
        let raw = output.stdout;
        let fields: Vec<&[u8]> = raw
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
            .collect();
        if !fields.len().is_multiple_of(2) {
            return Err(GitError::CommandFailed("无法解析 Git NUL 分隔输出".into()));
        }
        let mut files = Vec::with_capacity(fields.len() / 2);
        for pair in fields.chunks_exact(2) {
            let status = match pair[0].first().copied() {
                Some(b'M') => FileStatus::Modified,
                Some(b'D') => FileStatus::Deleted,
                Some(b'T') => FileStatus::TypeChanged,
                _ => continue,
            };
            files.push(FileChange {
                path_id: URL_SAFE_NO_PAD.encode(pair[1]),
                display_path: String::from_utf8_lossy(pair[1]).into_owned(),
                status,
            });
        }
        Ok((files, raw))
    }

    fn revision(&self, status_bytes: &[u8], files: &[FileChange]) -> Result<String, GitError> {
        let mut digest = Sha256::new();
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

fn update_modified(digest: &mut Sha256, metadata: &fs::Metadata) {
    if let Ok(modified) = metadata.modified() {
        if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
            digest.update(duration.as_nanos().to_le_bytes());
        }
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
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            PageFaultCount: 0,
            PeakWorkingSetSize: 0,
            WorkingSetSize: 0,
            QuotaPeakPagedPoolUsage: 0,
            QuotaPagedPoolUsage: 0,
            QuotaPeakNonPagedPoolUsage: 0,
            QuotaNonPagedPoolUsage: 0,
            PagefileUsage: 0,
            PeakPagefileUsage: 0,
        };
        let ok = unsafe {
            GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        };
        if ok == 0 {
            0.0
        } else {
            counters.WorkingSetSize as f64 / 1024.0 / 1024.0
        }
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
