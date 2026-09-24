#![cfg_attr(not(feature = "desktop"), allow(dead_code))]
//! 任务 V2-03 R-STASH 的只读部分：stash 列表与某条 stash 的内容。全部走只读通道。
//!
//! stash 提交的结构：第一个父节点是储藏时的 HEAD，第二个是 index，第三个（可选）是未跟踪文件（根提交）。
//! 查看内容时，已跟踪部分为“储藏时的 HEAD → stash 提交的树”，未跟踪部分为“空树 → 第三个父节点”，
//! 两端都是固定的 OID，经 `read_revision_pair` 读取。
use super::log::{self, ChangedFile};
use super::*;

/// 列表上限（技术方案 §5.7：stash 列表虚拟化之前先设上限）。
pub const MAX_STASHES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// `stash@{n}` 中的 n。
    pub index: u32,
    pub oid: String,
    /// 储藏说明（`WIP on <分支>: …` / `On <分支>: <说明>` 去掉前缀后的部分）。
    pub message: String,
    /// 储藏时所在分支；分离 HEAD 时为 `(no branch)`。
    pub branch: String,
    pub time: i64,
    /// 储藏时的 HEAD。
    pub base: String,
    /// 包含未跟踪文件时为第三个父节点。
    pub untracked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashChanges {
    pub oid: String,
    pub base: String,
    pub tracked: Vec<ChangedFile>,
    pub untracked_commit: Option<String>,
    pub untracked: Vec<ChangedFile>,
}

fn is_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 解析 `%gs`：`WIP on main: abc123 subject` 或 `On main: message`。
fn parse_subject(subject: &str) -> (String, String) {
    let rest = subject.strip_prefix("WIP on ").or_else(|| subject.strip_prefix("On ")).unwrap_or(subject);
    match rest.split_once(": ") {
        Some((branch, message)) => (branch.to_owned(), message.to_owned()),
        None => (String::new(), rest.to_owned()),
    }
}

impl GitAdapter {
    /// stash 列表（`refs/stash` 的 reflog，最新在前）。没有 stash 时为空列表。
    pub fn stash_list(&self) -> Result<Vec<StashEntry>, GitError> {
        let exists = run_readonly(&self.git, &self.worktree, &["rev-parse", "-q", "--verify", "refs/stash"])?;
        if !exists.status.success() {
            return Ok(Vec::new());
        }
        let count = format!("--max-count={MAX_STASHES}");
        let output = run_required(
            &self.git,
            &self.worktree,
            &["log", "-g", "--no-show-signature", "--no-color", &count, "--format=%H%x00%gd%x00%gs%x00%ct%x00%P%x1e", "refs/stash", "--"],
        )?;
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        let mut entries = Vec::new();
        for record in text.split('\x1e').map(|r| r.trim_start_matches('\n')).filter(|r| !r.is_empty()) {
            let fields: Vec<&str> = record.split('\0').collect();
            if fields.len() < 5 || !is_oid(fields[0]) {
                return Err(GitError::CommandFailed("无法解析 stash 列表".into()));
            }
            let index = fields[1].rsplit_once("@{").and_then(|(_, n)| n.strip_suffix('}')).and_then(|n| n.parse::<u32>().ok());
            let Some(index) = index else { return Err(GitError::CommandFailed("无法解析 stash 序号".into())) };
            let parents: Vec<&str> = fields[4].split_whitespace().collect();
            let (branch, message) = parse_subject(fields[2]);
            entries.push(StashEntry {
                index,
                oid: fields[0].to_owned(),
                message,
                branch,
                time: fields[3].trim().parse().unwrap_or(0),
                base: parents.first().map(|p| p.to_string()).unwrap_or_default(),
                untracked: parents.get(2).map(|p| p.to_string()),
            });
        }
        Ok(entries)
    }

    /// `stash@{n}` 当前指向的 OID（只读），用于写操作前核对身份。
    pub fn stash_oid(&self, index: u32) -> Result<Option<String>, GitError> {
        let spec = format!("refs/stash@{{{index}}}");
        let output = run_readonly(&self.git, &self.worktree, &["rev-parse", "-q", "--verify", "--end-of-options", &spec])?;
        Ok(output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned()).filter(|o| is_oid(o)))
    }

    /// 某条 stash 的内容：已跟踪部分（储藏时 HEAD → stash 树）与未跟踪部分（空树 → 第三个父节点）。
    pub fn stash_changes(&self, oid: &str) -> Result<StashChanges, GitError> {
        if !is_oid(oid) {
            return Err(GitError::CommandFailed(format!("无效的 stash OID：{oid}")));
        }
        let raw = run_required(&self.git, &self.worktree, &["show", "--no-show-signature", "-s", "--format=%P", oid, "--"])?.stdout;
        let parents: Vec<String> = String::from_utf8_lossy(&raw).split_whitespace().map(str::to_owned).collect();
        let Some(base) = parents.first().cloned() else {
            return Err(GitError::CommandFailed("不是有效的 stash 提交".into()));
        };
        let tracked = log::diff_tree(&self.git, &self.worktree, &[base.as_str(), oid])?;
        let untracked_commit = parents.get(2).cloned();
        let untracked = match &untracked_commit {
            Some(commit) => log::diff_tree(&self.git, &self.worktree, &["--root", commit.as_str()])?,
            None => Vec::new(),
        };
        Ok(StashChanges { oid: oid.to_owned(), base, tracked, untracked_commit, untracked })
    }
}
