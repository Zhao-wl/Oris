#![cfg_attr(not(feature = "desktop"), allow(dead_code))]
//! 任务 04：提交历史、分支、版本比较与文件历史的仓库级入口（R-HISTORY / R-BRANCH / R-COMPARE / R-FILEHISTORY）。
//!
//! 全部走只读通道；参数是类型化的查询结构，引用名只接受完整的本地 / 远端分支、标签、HEAD 或提交 OID，
//! 不接受任意 Git 参数。两端内容按固定的提交 OID 读取（见 `content.rs` 的 `read_revision_pair`）。
use super::content::decode_path;
use super::log::{self, CommitChanges, Comparison, FileHistory, LogCursor, LogPage, LogQuery};
use super::refs::{self, RefsSnapshot, Tracking};
use super::*;

/// 按分支筛选时最多同时指定的引用数。
const MAX_FILTER_REFS: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsView {
    #[serde(flatten)]
    pub refs: RefsSnapshot,
    /// 显式 fetch 的默认目标：当前分支上游所属的 remote（上游有效且 remote 仍存在时）；否则需要用户选择。
    pub default_remote: Option<String>,
    /// `FETCH_HEAD` 的修改时间（毫秒）。只用于判断外部工具是否在 Oris 记录的获取之后又获取过；
    /// 它不等于某次获取的确切成功时间。
    pub fetch_head_at: Option<u64>,
}

fn is_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 允许的引用：HEAD、完整分支 / 标签名或提交 OID。其余一律拒绝（包括以 `-` 开头、含换行或 `..` 的值）。
pub fn validate_reference(reference: &str) -> Result<(), GitError> {
    let allowed = reference == "HEAD"
        || is_oid(reference)
        || ["refs/heads/", "refs/remotes/", "refs/tags/"].iter().any(|prefix| reference.len() > prefix.len() && reference.starts_with(prefix));
    if !allowed || reference.contains("..") || reference.contains(['\0', '\n', '\r', ' ', '~', '^', ':', '\\']) {
        return Err(GitError::CommandFailed(format!("不支持的引用：{reference}")));
    }
    Ok(())
}

impl GitAdapter {
    pub fn history_log(&self, query: &LogQuery, cursor: Option<&LogCursor>) -> Result<LogPage, GitError> {
        if query.refs.len() > MAX_FILTER_REFS {
            return Err(GitError::CommandFailed(format!("一次最多筛选 {MAX_FILTER_REFS} 个引用")));
        }
        for reference in &query.refs {
            validate_reference(reference)?;
        }
        log::read_log(&self.git, &self.worktree, query, cursor)
    }

    pub fn history_commit(&self, commit: &str, parent: Option<&str>) -> Result<CommitChanges, GitError> {
        validate_reference(commit)?;
        if let Some(parent) = parent {
            validate_reference(parent)?;
        }
        log::commit_changes(&self.git, &self.worktree, commit, parent)
    }

    pub fn history_compare(&self, left: &str, right: &str) -> Result<Comparison, GitError> {
        validate_reference(left)?;
        validate_reference(right)?;
        log::compare(&self.git, &self.worktree, left, right)
    }

    pub fn history_file(&self, start: &str, path_id: &str, page_size: usize, cursor: Option<&LogCursor>) -> Result<FileHistory, GitError> {
        validate_reference(start)?;
        let path = decode_path(path_id)?;
        log::file_history(&self.git, &self.worktree, start, &path, page_size, cursor)
    }

    pub fn history_refs(&self) -> Result<RefsView, GitError> {
        let refs = refs::read_refs(&self.git, &self.worktree)?;
        let default_remote = refs
            .local
            .iter()
            .find(|branch| branch.current)
            .filter(|branch| matches!(branch.tracking, Some(Tracking::Known { .. } | Tracking::Unknown { .. })))
            .and_then(|branch| branch.remote.clone())
            .filter(|remote| refs.remotes.contains(remote));
        let fetch_head_at = [self.git_dir.join("FETCH_HEAD"), self.common_dir.join("FETCH_HEAD")]
            .iter()
            .filter_map(|path| fs::metadata(path).ok()?.modified().ok())
            .max()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        Ok(RefsView { refs, default_remote, fetch_head_at })
    }
}
