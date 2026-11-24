//! Saving a conflict result changes only the worktree. MarkResolved remains a separate operation.
use super::*;
use std::io::Write;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictIdentity {
    pub repo_id: String,
    pub revision: String,
    pub stages: [Option<ExpectedStage>; 3],
    pub worktree_content_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExpectedStage {
    pub oid: String,
    pub mode: String,
}

pub(super) struct ConflictBackup {
    pub stages: [Option<ExpectedStage>; 3],
    pub saved_sha256: String,
    pub original: Vec<u8>,
}

impl GitAdapter {
    pub(super) fn op_conflict_mark_resolved(&self, path_id: &str, expected: &ConflictIdentity, confirmed: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let path = decode_path_id(path_id)?;
        let relative = std::str::from_utf8(&path).map_err(|_| GitError::UnsupportedPathEncoding)?;
        self.check_conflict_identity(path_id, relative, expected, true)?;
        self.op_stage(&[path_id.to_owned()], true, confirmed, ctx)
    }

    pub(super) fn op_conflict_save(
        &self, path_id: &str, expected: &ConflictIdentity, result: &str, ctx: &OpContext,
    ) -> Result<Step, GitError> {
        let path = decode_path_id(path_id)?;
        let relative = std::str::from_utf8(&path).map_err(|_| GitError::UnsupportedPathEncoding)?;
        let before = self.check_conflict_identity(path_id, relative, expected, true)?;
        let bytes = encode_result(&before, result)?;
        if bytes == before {
            return Ok(Step::ok(format!("{relative} 的冲突结果未变化")));
        }

        let backup = ConflictBackup { stages: expected.stages.clone(), saved_sha256: hash_bytes(&bytes), original: before };
        self.with_worktree_backup(&path, path_id, false, Some(backup), ctx, |_| {
            let write: Result<Step, GitError> = (|| {
                self.check_conflict_identity(path_id, relative, expected, true)?;
                self.replace_conflict_worktree(relative, &bytes, || {
                    // The sibling temporary file can change the repository-wide revision.
                    self.check_conflict_identity(path_id, relative, expected, false)?;
                    if ctx.cancel.is_cancelled() { return Err(GitError::WriteBlocked("已取消保存".into())); }
                    Ok(())
                })?;
                let mut step = Step::ok(format!("已保存 {relative} 的冲突结果"));
                step.touched.push(relative.to_owned());
                Ok(step)
            })();
            Ok(write.unwrap_or_else(|error| if ctx.cancel.is_cancelled() { Step::cancelled("已取消保存；工作区未改动") }
                else { Step::failed(format!("无法保存冲突结果：{error}")) }))
        })
    }

    pub(super) fn replace_conflict_worktree(&self, relative: &str, bytes: &[u8], verify: impl FnOnce() -> Result<(), GitError>) -> Result<(), GitError> {
        validate_relative(relative)?;
        let full = self.checked_worktree_path(relative)?;
        let meta = fs::symlink_metadata(&full).map_err(io_error)?;
        if !meta.file_type().is_file() { return Err(GitError::UnsafePath); }
        let parent = full.parent().ok_or(GitError::UnsafePath)?;
        let mut temporary = tempfile::Builder::new().prefix(".oris-conflict-").tempfile_in(parent).map_err(io_error)?;
        temporary.write_all(bytes).map_err(io_error)?;
        temporary.as_file().set_permissions(meta.permissions()).map_err(io_error)?;
        temporary.as_file().sync_all().map_err(io_error)?;
        verify()?;
        if self.index_lock_path().exists() { return Err(GitError::StaleRequest); }
        if self.checked_worktree_path(relative)? != full { return Err(GitError::UnsafePath); }
        temporary.persist(&full).map_err(|error| io_error(error.error))?;
        Ok(())
    }

    fn check_conflict_identity(
        &self, path_id: &str, relative: &str, expected: &ConflictIdentity, check_revision: bool,
    ) -> Result<Vec<u8>, GitError> {
        let scan = self.scan(false)?;
        if expected.repo_id != self.repo_id || !scan.in_progress.merge || (check_revision && scan.revision != expected.revision) {
            return Err(GitError::StaleRequest);
        }
        Self::verify_conflict_stages(&scan, path_id, &expected.stages)?;
        let bytes = self.read_worktree(relative, MAX_TEXT_BYTES)?;
        if bytes.len() > MAX_TEXT_BYTES || hash_bytes(&bytes) != expected.worktree_content_id { return Err(GitError::StaleRequest); }
        Ok(bytes)
    }

    pub(super) fn verify_conflict_stages(scan: &scan::ScanState, path_id: &str, expected: &[Option<ExpectedStage>; 3]) -> Result<(), GitError> {
        let stages = scan.entries.get(path_id)
            .and_then(|row| row.conflict.as_ref()).ok_or(GitError::StaleRequest)?;
        for (actual, expected_stage) in stages.iter().zip(expected) {
            if actual.as_ref().map(|entry| (&entry.oid, &entry.mode)) != expected_stage.as_ref().map(|entry| (&entry.oid, &entry.mode)) {
                return Err(GitError::StaleRequest);
            }
            if actual.as_ref().is_some_and(|entry| !matches!(entry.mode.as_str(), "100644" | "100755")) {
                return Err(GitError::WriteBlocked("仅支持编辑普通文本文件的冲突".into()));
            }
        }
        Ok(())
    }
}

fn io_error(error: std::io::Error) -> GitError { GitError::Io(error.to_string()) }

fn encode_result(original: &[u8], result: &str) -> Result<Vec<u8>, GitError> {
    let bom = original.starts_with(&[0xEF, 0xBB, 0xBF]);
    let original = original.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(original);
    if std::str::from_utf8(original).is_err() || original.contains(&0) || result.contains(['\0', '\r']) {
        return Err(GitError::WriteBlocked("冲突编辑器支持 UTF-8 文本".into()));
    }
    let crlf = original.windows(2).any(|pair| pair == b"\r\n");
    if original.iter().enumerate().any(|(index, byte)| match byte {
        b'\r' => original.get(index + 1) != Some(&b'\n'),
        b'\n' if crlf => index == 0 || original[index - 1] != b'\r',
        _ => false,
    }) {
        return Err(GitError::WriteBlocked("混合或旧式换行需要在外部编辑器中解决".into()));
    }
    if result.len() > MAX_TEXT_BYTES { return Err(GitError::WriteBlocked("冲突结果超过文本保存预算".into())); }
    if result.lines().count() > MAX_TEXT_LINES || result.lines().any(|line| line.chars().count() > MAX_LINE_CHARS) {
        return Err(GitError::WriteBlocked(format!("冲突结果超过文本显示预算（{MAX_TEXT_LINES} 行 / 单行 {MAX_LINE_CHARS} 字符）")));
    }
    let result = if crlf { result.replace('\n', "\r\n").into_bytes() } else { result.as_bytes().to_vec() };
    if result.len() + if bom { 3 } else { 0 } > MAX_TEXT_BYTES {
        return Err(GitError::WriteBlocked("冲突结果超过文本保存预算".into()));
    }
    Ok(if bom { [&[0xEF, 0xBB, 0xBF], result.as_slice()].concat() } else { result })
}
