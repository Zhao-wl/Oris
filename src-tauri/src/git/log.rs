//! 任务 04 预制模块：提交历史读取（R-HISTORY / R-COMPARE / R-FILEHISTORY）。
//!
//! 全部走只读通道（`run_required` 带 `--no-optional-locks`、禁用 external diff / textconv），
//! 另加 `--no-show-signature` 避免 `log.showSignature` 配置触发 GPG 等外部程序。
//! 起点 ref 在第一页解析为 OID 并固定在游标里，后续分页不受 ref 移动影响，已显示提交的身份不变。
#![cfg_attr(not(test), allow(dead_code))]
use super::{run_required, GitError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::Path;

const FIELDS: usize = 10;
const FORMAT: &str = "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x00%D";
/// 单页上限，防止前端请求无界数量。
pub const MAX_PAGE: usize = 1000;
/// 单文件历史累计加载上限。
pub const MAX_FILE_HISTORY: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Head,
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    /// 完整引用名（HEAD 为 "HEAD"）。
    pub name: String,
    pub kind: RefKind,
    /// HEAD 指向的当前分支。
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub subject: String,
    pub body: String,
    pub refs: Vec<RefLabel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "text")]
pub enum SearchQuery {
    Author(String),
    Message(String),
    Sha(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    /// 要浏览的引用（完整名，如 `refs/heads/main`）；为空表示所有本地与远端跟踪分支及 HEAD。
    pub refs: Vec<String>,
    pub search: Option<SearchQuery>,
    pub page_size: usize,
}

/// 分页游标：起点已解析为 OID 并固定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCursor {
    pub tips: Vec<String>,
    pub skip: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<CommitInfo>,
    /// 还有更多提交时给出下一页游标。
    pub next: Option<LogCursor>,
    pub tips: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    /// 原始路径字节的 base64url（与本地变化的 pathId 相同编码），供按提交读取内容。
    pub path_id: String,
    pub old_path_id: Option<String>,
    pub status: ChangeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChanges {
    pub oid: String,
    /// 比较所用的父节点；根提交为 None（相对空树）。
    pub parent: Option<String>,
    pub parents: Vec<String>,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// 请求时的引用名与解析后固定的 OID。
    pub left_ref: String,
    pub right_ref: String,
    pub left: String,
    pub right: String,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub commit: CommitInfo,
    /// 该提交中文件的路径。
    pub path: String,
    pub path_id: String,
    pub status: ChangeStatus,
    /// 此提交把文件从该路径改名而来（rename 跟随边界）。
    pub renamed_from: Option<String>,
    pub renamed_from_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    pub entries: Vec<FileHistoryEntry>,
    pub next: Option<LogCursor>,
    /// 已到达文件的起点（新增提交）；为 false 且没有下一页时说明记录不连续（例如被 Git rename 检测阈值截断）。
    pub reached_origin: bool,
}

fn is_hex_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 把用户提供的引用或 OID 解析为提交 OID；拒绝以 `-` 开头的值，防止被当作选项。
pub fn resolve_commit(git: &Path, worktree: &Path, reference: &str) -> Result<String, GitError> {
    if reference.is_empty() || reference.starts_with('-') || reference.contains(['\0', '\n']) {
        return Err(GitError::CommandFailed(format!("无效的引用：{reference}")));
    }
    let spec = format!("{reference}^{{commit}}");
    let output = run_required(git, worktree, &["rev-parse", "--verify", "--quiet", "--end-of-options", &spec])
        .map_err(|_| GitError::CommandFailed(format!("无法解析引用：{reference}")))?;
    let oid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !is_hex_oid(&oid) {
        return Err(GitError::CommandFailed(format!("无法解析引用：{reference}")));
    }
    Ok(oid)
}

fn default_tips(git: &Path, worktree: &Path) -> Result<Vec<String>, GitError> {
    let output = run_required(git, worktree, &["for-each-ref", "--format=%(objectname) %(objecttype)", "refs/heads", "refs/remotes"])?;
    let mut tips: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter(|(_, kind)| *kind == "commit")
        .map(|(oid, _)| oid.to_owned())
        .collect();
    if let Ok(head) = resolve_commit(git, worktree, "HEAD") {
        tips.push(head);
    }
    tips.sort();
    tips.dedup();
    Ok(tips)
}

fn parse_refs(decoration: &str) -> Vec<RefLabel> {
    let mut labels = Vec::new();
    for part in decoration.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        if let Some(target) = part.strip_prefix("HEAD -> ") {
            labels.push(RefLabel { name: "HEAD".into(), kind: RefKind::Head, current: false });
            labels.push(RefLabel { name: target.into(), kind: RefKind::Local, current: true });
        } else if part == "HEAD" {
            labels.push(RefLabel { name: "HEAD".into(), kind: RefKind::Head, current: false });
        } else if let Some(tag) = part.strip_prefix("tag: ") {
            labels.push(RefLabel { name: tag.into(), kind: RefKind::Tag, current: false });
        } else if part.starts_with("refs/remotes/") {
            labels.push(RefLabel { name: part.into(), kind: RefKind::Remote, current: false });
        } else if part.starts_with("refs/heads/") {
            labels.push(RefLabel { name: part.into(), kind: RefKind::Local, current: false });
        } else if part.starts_with("refs/tags/") {
            labels.push(RefLabel { name: part.into(), kind: RefKind::Tag, current: false });
        }
    }
    labels
}

fn parse_commit(fields: &[&[u8]]) -> Result<CommitInfo, GitError> {
    let text = |i: usize| String::from_utf8_lossy(fields[i]).into_owned();
    let time = |i: usize| text(i).trim().parse::<i64>().unwrap_or(0);
    let message = text(8);
    let message = message.trim_end_matches('\n');
    let (subject, body) = match message.split_once('\n') {
        Some((subject, body)) => (subject.to_owned(), body.trim_start_matches('\n').to_owned()),
        None => (message.to_owned(), String::new()),
    };
    let oid = text(0);
    if !is_hex_oid(&oid) {
        return Err(GitError::CommandFailed("无法解析提交记录".into()));
    }
    Ok(CommitInfo {
        oid,
        parents: text(1).split_whitespace().map(str::to_owned).collect(),
        author_name: text(2),
        author_email: text(3),
        author_time: time(4),
        committer_name: text(5),
        committer_email: text(6),
        committer_time: time(7),
        subject,
        body,
        refs: parse_refs(&text(9)),
    })
}

/// 解析 `%x1e` 起始的记录：前 FIELDS 个 NUL 分隔字段是提交信息，其后（若有）为 `--name-status -z` 的条目。
fn parse_records(raw: &[u8]) -> Result<Vec<(CommitInfo, Vec<ChangedFile>)>, GitError> {
    let mut records = Vec::new();
    for record in raw.split(|b| *b == 0x1e).filter(|r| !r.is_empty()) {
        let parts: Vec<&[u8]> = record.split(|b| *b == 0).collect();
        if parts.len() < FIELDS {
            return Err(GitError::CommandFailed("提交记录字段不完整".into()));
        }
        let mut commit_fields = parts[..FIELDS].to_vec();
        // 装饰字段之后紧跟换行或名称状态，去掉末尾换行。
        let last = commit_fields[FIELDS - 1];
        let trimmed_len = last.iter().rposition(|b| *b != b'\n').map_or(0, |p| p + 1);
        commit_fields[FIELDS - 1] = &last[..trimmed_len];
        let commit = parse_commit(&commit_fields)?;
        let files = parse_name_status(&parts[FIELDS..])?;
        records.push((commit, files));
    }
    Ok(records)
}

fn status_of(code: &[u8]) -> Option<ChangeStatus> {
    Some(match code.first()? {
        b'A' => ChangeStatus::Added,
        b'M' => ChangeStatus::Modified,
        b'D' => ChangeStatus::Deleted,
        b'R' => ChangeStatus::Renamed,
        b'C' => ChangeStatus::Copied,
        b'T' => ChangeStatus::TypeChanged,
        b'U' => ChangeStatus::Unmerged,
        _ => return None,
    })
}

fn parse_name_status(tokens: &[&[u8]]) -> Result<Vec<ChangedFile>, GitError> {
    let tokens: Vec<&[u8]> = tokens
        .iter()
        .map(|t| {
            let start = t.iter().position(|b| *b != b'\n').unwrap_or(t.len());
            &t[start..]
        })
        .filter(|t| !t.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let Some(status) = status_of(tokens[i]) else {
            return Err(GitError::CommandFailed("无法解析变化文件列表".into()));
        };
        let paired = matches!(status, ChangeStatus::Renamed | ChangeStatus::Copied);
        let needed = if paired { 2 } else { 1 };
        if i + needed >= tokens.len() {
            return Err(GitError::CommandFailed("变化文件列表截断".into()));
        }
        let path_at = |j: usize| String::from_utf8_lossy(tokens[j]).into_owned();
        let id_at = |j: usize| URL_SAFE_NO_PAD.encode(tokens[j]);
        if paired {
            files.push(ChangedFile { old_path: Some(path_at(i + 1)), path: path_at(i + 2), old_path_id: Some(id_at(i + 1)), path_id: id_at(i + 2), status });
        } else {
            files.push(ChangedFile { old_path: None, path: path_at(i + 1), old_path_id: None, path_id: id_at(i + 1), status });
        }
        i += needed + 1;
    }
    Ok(files)
}

const LOG_BASE: [&str; 5] = ["log", "--no-show-signature", "--no-color", "--decorate=full", "--topo-order"];

/// 读取一页提交。第一页（cursor 为 None）按 query 解析起点并固定；之后传回上一页的游标。
pub fn read_log(git: &Path, worktree: &Path, query: &LogQuery, cursor: Option<&LogCursor>) -> Result<LogPage, GitError> {
    let page_size = query.page_size.clamp(1, MAX_PAGE);
    if let Some(SearchQuery::Sha(prefix)) = &query.search {
        let prefix = prefix.trim();
        if prefix.len() < 4 || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::CommandFailed("SHA 搜索至少需要 4 位十六进制字符".into()));
        }
        let oid = resolve_commit(git, worktree, prefix)?;
        let mut args: Vec<&str> = LOG_BASE.to_vec();
        args.extend_from_slice(&["-z", "-1", FORMAT, oid.as_str(), "--"]);
        let raw = run_required(git, worktree, &args)?.stdout;
        let commits = parse_records(&raw)?.into_iter().map(|(c, _)| c).collect();
        return Ok(LogPage { commits, next: None, tips: vec![oid] });
    }
    let (tips, skip) = match cursor {
        Some(cursor) => {
            if cursor.tips.iter().any(|t| !is_hex_oid(t)) {
                return Err(GitError::CommandFailed("游标无效".into()));
            }
            (cursor.tips.clone(), cursor.skip)
        }
        None if query.refs.is_empty() => (default_tips(git, worktree)?, 0),
        None => {
            let mut tips = query.refs.iter().map(|r| resolve_commit(git, worktree, r)).collect::<Result<Vec<_>, _>>()?;
            tips.sort();
            tips.dedup();
            (tips, 0)
        }
    };
    if tips.is_empty() {
        return Ok(LogPage { commits: Vec::new(), next: None, tips });
    }
    let skip_arg = format!("--skip={skip}");
    let count_arg = format!("--max-count={}", page_size + 1);
    let mut args: Vec<String> = LOG_BASE.iter().map(|s| s.to_string()).collect();
    args.extend(["-z".into(), FORMAT.into(), skip_arg, count_arg]);
    match &query.search {
        Some(SearchQuery::Author(text)) => {
            args.extend(["--regexp-ignore-case".into(), "--fixed-strings".into(), format!("--author={text}")]);
        }
        Some(SearchQuery::Message(text)) => {
            args.extend(["--regexp-ignore-case".into(), "--fixed-strings".into(), format!("--grep={text}")]);
        }
        _ => {}
    }
    args.extend(tips.iter().cloned());
    args.push("--".into());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = run_required(git, worktree, &refs)?.stdout;
    let mut commits: Vec<CommitInfo> = parse_records(&raw)?.into_iter().map(|(c, _)| c).collect();
    let more = commits.len() > page_size;
    commits.truncate(page_size);
    let next = more.then(|| LogCursor { tips: tips.clone(), skip: skip + page_size });
    Ok(LogPage { commits, next, tips })
}

pub(super) fn diff_tree(git: &Path, worktree: &Path, args: &[&str]) -> Result<Vec<ChangedFile>, GitError> {
    let mut all = vec!["diff-tree", "-r", "-z", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--name-status", "-M"];
    all.extend_from_slice(args);
    let raw = run_required(git, worktree, &all)?.stdout;
    let tokens: Vec<&[u8]> = raw.split(|b| *b == 0).collect();
    parse_name_status(&tokens)
}

/// 提交的变化文件：根提交相对空树；合并提交需要选择父节点（默认第一个父节点，调用方可指定任一父节点）。
pub fn commit_changes(git: &Path, worktree: &Path, commit: &str, parent: Option<&str>) -> Result<CommitChanges, GitError> {
    let oid = resolve_commit(git, worktree, commit)?;
    let raw = run_required(git, worktree, &["show", "--no-show-signature", "-s", "--format=%P", &oid, "--"])?.stdout;
    let parents: Vec<String> = String::from_utf8_lossy(&raw).split_whitespace().map(str::to_owned).collect();
    let chosen = match parent {
        Some(p) => {
            let p = resolve_commit(git, worktree, p)?;
            if !parents.contains(&p) {
                return Err(GitError::CommandFailed("所选父节点不属于该提交".into()));
            }
            Some(p)
        }
        None => parents.first().cloned(),
    };
    let files = match &chosen {
        Some(parent) => diff_tree(git, worktree, &[parent.as_str(), oid.as_str()])?,
        None => diff_tree(git, worktree, &["--root", oid.as_str()])?,
    };
    Ok(CommitChanges { oid, parent: chosen, parents, files })
}

/// 两个端点直接比较（非共同基线）：先解析并固定 OID，之后 ref 移动不影响本次结果。
pub fn compare(git: &Path, worktree: &Path, left: &str, right: &str) -> Result<Comparison, GitError> {
    let left_oid = resolve_commit(git, worktree, left)?;
    let right_oid = resolve_commit(git, worktree, right)?;
    let files = diff_tree(git, worktree, &[left_oid.as_str(), right_oid.as_str()])?;
    Ok(Comparison { left_ref: left.to_owned(), right_ref: right.to_owned(), left: left_oid, right: right_oid, files })
}

impl Comparison {
    /// 交换方向：重新计算 B → A 的变化（端点仍是已固定的 OID）。
    pub fn swapped(&self, git: &Path, worktree: &Path) -> Result<Comparison, GitError> {
        let files = diff_tree(git, worktree, &[self.right.as_str(), self.left.as_str()])?;
        Ok(Comparison { left_ref: self.right_ref.clone(), right_ref: self.left_ref.clone(), left: self.right.clone(), right: self.left.clone(), files })
    }
}

/// 单文件历史（`--follow`）。每条记录给出该提交中的路径；发生 rename 的提交标注原路径（跟随边界）。
pub fn file_history(git: &Path, worktree: &Path, start: &str, path: &str, page_size: usize, cursor: Option<&LogCursor>) -> Result<FileHistory, GitError> {
    super::validate_relative(path)?;
    let page_size = page_size.clamp(1, MAX_PAGE);
    let (tip, skip) = match cursor {
        Some(c) if c.tips.len() == 1 && is_hex_oid(&c.tips[0]) => (c.tips[0].clone(), c.skip),
        Some(_) => return Err(GitError::CommandFailed("游标无效".into())),
        None => (resolve_commit(git, worktree, start)?, 0),
    };
    // `--follow` 与 `--skip` 组合时 Git 的跳过计数不可靠（改名提交会重复出现），
    // 因此从固定起点读取 skip + page_size + 1 条后丢弃前 skip 条。总量受 MAX_FILE_HISTORY 限制。
    if skip + page_size > MAX_FILE_HISTORY {
        return Err(GitError::CommandFailed(format!("单文件历史最多加载 {MAX_FILE_HISTORY} 条")));
    }
    let count_arg = format!("--max-count={}", skip + page_size + 1);
    let mut args: Vec<&str> = LOG_BASE.to_vec();
    // 合并提交与第一个父节点比较（Git ≥ 2.31）：合并中解决冲突改动了该文件时也出现在历史中。
    args.extend_from_slice(&["-z", "--follow", "--diff-merges=first-parent", "--name-status", "-M", FORMAT, &count_arg, &tip, "--", path]);
    let raw = run_required(git, worktree, &args)?.stdout;
    let mut entries = Vec::new();
    for (commit, files) in parse_records(&raw)?.into_iter().skip(skip) {
        let Some(file) = files.into_iter().next() else { continue };
        let renamed = matches!(file.status, ChangeStatus::Renamed);
        let renamed_from = renamed.then(|| file.old_path.clone()).flatten();
        let renamed_from_id = renamed.then(|| file.old_path_id.clone()).flatten();
        entries.push(FileHistoryEntry { commit, path: file.path, path_id: file.path_id, status: file.status, renamed_from, renamed_from_id });
    }
    let more = entries.len() > page_size;
    entries.truncate(page_size);
    let reached_origin = !more && entries.last().is_some_and(|e| matches!(e.status, ChangeStatus::Added));
    let next = more.then(|| LogCursor { tips: vec![tip], skip: skip + page_size });
    Ok(FileHistory { entries, next, reached_origin })
}
