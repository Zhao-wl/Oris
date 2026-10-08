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
    /// 影响拉取的配置：当前分支的 `branch.<name>.rebase`，没有时为 `pull.rebase`。Oris 始终以 `--no-rebase` 执行。
    pub pull_rebase: Option<String>,
    /// `merge.ff`（合并时遵循）。
    pub merge_ff: Option<String>,
}

/// 标题栏“获取 ▾”所需的最小信息：不列出分支、不计算领先 / 落后（`read_refs` 在大仓库上较慢）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotesView {
    pub remotes: Vec<String>,
    /// 当前分支上游所属的 remote（仍存在时）；与一键获取的默认目标一致。
    pub default_remote: Option<String>,
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
    pub fn history_locate(&self, query: &LogQuery, commit: &str, stale: &dyn Fn() -> bool) -> Result<LogPage, GitError> {
        validate_reference(commit)?;
        if query.refs.len() > MAX_FILTER_REFS { return Err(GitError::CommandFailed("筛选引用过多".into())); }
        for reference in &query.refs { validate_reference(reference)?; }
        log::locate_log(&self.git, &self.worktree, query, commit, stale)
    }

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

    /// remote 列表与默认 remote：`git remote` 加一次只读当前分支上游的 `for-each-ref`，共两个进程。
    pub fn history_remotes(&self) -> Result<RemotesView, GitError> {
        let output = run_required(&self.git, &self.worktree, &["remote"])?;
        let remotes: Vec<String> = String::from_utf8_lossy(&output.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect();
        // %(HEAD) 为 “*” 的那一行是当前分支；分离 HEAD 时没有这一行。
        let default_remote = run_readonly(&self.git, &self.worktree, &["for-each-ref", "--format=%(HEAD)%00%(upstream:remotename)", "refs/heads"])
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().find_map(|line| line.strip_prefix("*\0").map(str::to_owned)))
            .filter(|remote| remotes.contains(remote));
        Ok(RemotesView { remotes, default_remote, fetch_head_at: self.fetch_head_at() })
    }

    fn fetch_head_at(&self) -> Option<u64> {
        [self.git_dir.join("FETCH_HEAD"), self.common_dir.join("FETCH_HEAD")]
            .iter()
            .filter_map(|path| fs::metadata(path).ok()?.modified().ok())
            .max()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
    }

    /// 共两个 Git 进程：一次 `config --get-regexp`（remote 列表与拉取相关配置）与一次 `for-each-ref`；
    /// 浅克隆由 shallow 文件判断。原为另外的 `rev-parse --is-shallow-repository` 与 `git remote`，
    /// Windows 上每个 Git 进程启动约 55 ms，负载高时可达数百毫秒。
    pub fn history_refs(&self) -> Result<RefsView, GitError> {
        // 取值规则与 `--get` 相同：同一键取最后一个值。remote 的取值（URL 等）只用于得到名称，不返回。
        let values = run_readonly(&self.git, &self.worktree, &["config", "-z", "--get-regexp", REFS_CONFIG_KEYS])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| parse_config_values(&o.stdout))
            .unwrap_or_default();
        let context = refs::RefsContext { shallow: refs::is_shallow(&self.common_dir), remotes: refs::remote_names(values.iter().map(|(k, _)| k.as_str())) };
        let refs = refs::read_refs_in(&self.git, &self.worktree, context)?;
        let default_remote = refs
            .local
            .iter()
            .find(|branch| branch.current)
            .filter(|branch| matches!(branch.tracking, Some(Tracking::Known { .. } | Tracking::Unknown { .. })))
            .and_then(|branch| branch.remote.clone())
            .filter(|remote| refs.remotes.contains(remote));
        let fetch_head_at = self.fetch_head_at();
        let config = |key: &str| values.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.trim().to_owned());
        let current = refs.head.branch.as_deref().and_then(|b| b.strip_prefix("refs/heads/")).map(str::to_owned);
        let pull_rebase = current.as_deref().and_then(|b| config(&format!("branch.{b}.rebase"))).or_else(|| config("pull.rebase"));
        let merge_ff = config("merge.ff");
        Ok(RefsView { refs, default_remote, fetch_head_at, pull_rebase, merge_ff })
    }
}

/// 所有 `remote.<name>.*`（得到 remote 列表），以及 `pull.rebase`、`merge.ff` 与各分支的 `branch.<name>.rebase`
/// （V2-D60 起一次读出）。Git 输出的键：节名与变量名为小写，子节保持原样。
const REFS_CONFIG_KEYS: &str = r"^(remote\..*|pull\.rebase|merge\.ff|branch\..*\.rebase)$";

/// 解析 `git config -z --get-regexp` 的输出：每条为 `键\n值\0`，没有值的键（隐式 true）为 `键\0`，与 `--get` 一样记为空字符串。
fn parse_config_values(raw: &[u8]) -> Vec<(String, String)> {
    raw.split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let text = String::from_utf8_lossy(entry);
            match text.split_once('\n') {
                Some((key, value)) => (key.to_owned(), value.to_owned()),
                None => (text.into_owned(), String::new()),
            }
        })
        .collect()
}
