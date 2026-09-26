//! OperationRunner（技术方案 §4）：写操作的仓库级写锁、前置检查（进行中状态、外部锁）、
//! 固定命令模板、结束后按影响维度的一次精确刷新（同时回写 index stat 缓存，V2-D09）。
//!
//! 前端只能提交 [`OperationRequest`] 这样的操作描述；参数由这里构造，路径一律校验后经
//! `--pathspec-from-file=- --pathspec-file-nul` 传递。任何写操作都不自动重试。
mod branch;
mod commit;
mod discard;
mod hunk;
mod network;
pub mod process;
mod stage;
mod stash;
mod sync;
#[cfg_attr(not(feature = "desktop"), allow(unused_imports))]
pub use sync::PullMode;
#[cfg(test)]
mod branch_tests;
#[cfg(test)]
mod network_tests;
#[cfg(test)]
mod sync_tests;
#[cfg(test)]
mod tests;

#[cfg_attr(not(feature = "desktop"), allow(unused_imports))]
pub use commit::HeadCommitInfo;
#[cfg_attr(not(feature = "desktop"), allow(unused_imports))]
pub use discard::{BackupStore, BackupSummary, DiscardPlan};
#[cfg_attr(not(feature = "desktop"), allow(unused_imports))]
pub use hunk::HunkMap;
use hunk::HunkAction;
#[cfg(test)]
mod hunk_tests;

use super::*;
use process::{CancelHandle, OutputLog};
use std::sync::atomic::AtomicU32;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OperationRequest {
    /// 暂存（未暂存范围）。
    Stage { path_ids: Vec<String> },
    /// 取消暂存（已暂存范围）；rename 需同时给出原路径。
    Unstage { path_ids: Vec<String> },
    /// 冲突文件“标记已解决”：暂存的变体，文件仍含冲突标记时先要求确认。
    MarkResolved {
        path_ids: Vec<String>,
        #[serde(default)]
        confirmed: bool,
    },
    Discard {
        scope: CompareScope,
        path_ids: Vec<String>,
        #[serde(default)]
        confirmed_unrecoverable: bool,
    },
    UndoDiscard {
        backup_id: String,
        #[serde(default)]
        overwrite: bool,
    },
    /// 暂存一个差异块（未暂存范围，V2-05）。`content_ids` 为界面显示时的两侧内容标识，`hunk` 为该块的行范围与摘要。
    HunkStage { path_id: String, content_ids: [String; 2], hunk: hunk::HunkRef },
    /// 取消暂存一个差异块（已暂存范围）。
    HunkUnstage { path_id: String, content_ids: [String; 2], hunk: hunk::HunkRef },
    /// 丢弃一个差异块（未暂存范围）：先备份整个工作区文件，可撤销。
    HunkDiscard {
        path_id: String,
        content_ids: [String; 2],
        hunk: hunk::HunkRef,
        #[serde(default)]
        confirmed_unrecoverable: bool,
    },
    Commit { message: String },
    UndoCommit { expected_head: String },
    /// 显式获取远端状态（R-REMOTE）：只更新远端跟踪引用等 Git 元数据。
    Fetch { remote: String },
    /// 储藏（R-STASH）：可填说明、包含未跟踪文件、只储藏选中的路径。
    StashPush {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        include_untracked: bool,
        #[serde(default)]
        path_ids: Option<Vec<String>>,
    },
    /// 应用 / 弹出 stash@{index}；执行前核对它仍指向 oid。
    StashApply {
        index: u32,
        oid: String,
        #[serde(default)]
        pop: bool,
    },
    StashDrop { index: u32, oid: String },
    /// 新建分支（R-BRANCHOP）：起点为 HEAD、完整分支名或提交 OID。
    BranchCreate {
        name: String,
        start: String,
        #[serde(default)]
        switch: bool,
        #[serde(default)]
        stash_first: bool,
        #[serde(default)]
        stash_untracked: bool,
    },
    /// 切换到本地分支（完整名 refs/heads/…）。
    BranchSwitch {
        name: String,
        #[serde(default)]
        stash_first: bool,
        #[serde(default)]
        stash_untracked: bool,
    },
    /// 从远端跟踪分支（refs/remotes/…）建立本地跟踪分支并切换；`local_name` 为空时使用同名。
    BranchTrack {
        remote: String,
        #[serde(default)]
        local_name: Option<String>,
        #[serde(default)]
        stash_first: bool,
        #[serde(default)]
        stash_untracked: bool,
    },
    /// 检出指定提交（分离 HEAD）。
    Checkout {
        commit: String,
        #[serde(default)]
        stash_first: bool,
        #[serde(default)]
        stash_untracked: bool,
    },
    BranchRename { name: String, new_name: String },
    BranchDelete {
        name: String,
        #[serde(default)]
        force: bool,
    },
    SetUpstream { name: String, upstream: String },
    /// 拉取当前分支的上游（R-SYNC）：仅快进（默认）或合并，始终不 rebase；可先储藏。
    Pull {
        mode: PullMode,
        #[serde(default)]
        stash_first: bool,
        #[serde(default)]
        stash_untracked: bool,
    },
    /// 推送当前分支；没有上游时推送到所选 remote 并设为上游。
    Push {
        #[serde(default)]
        remote: Option<String>,
    },
    /// 把分支或提交合并到当前分支（R-MERGE）；`expected` 为界面显示的目标 OID。
    Merge {
        target: String,
        expected: String,
        #[serde(default)]
        no_ff: bool,
    },
    MergeAbort,
    /// 所有冲突标记已解决后完成合并。
    MergeCommit { message: String },
}

impl OperationRequest {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Stage { .. } => "stage",
            Self::Unstage { .. } => "unstage",
            Self::MarkResolved { .. } => "markResolved",
            Self::Discard { .. } => "discard",
            Self::UndoDiscard { .. } => "undoDiscard",
            Self::HunkStage { .. } => "hunkStage",
            Self::HunkUnstage { .. } => "hunkUnstage",
            Self::HunkDiscard { .. } => "hunkDiscard",
            Self::Commit { .. } => "commit",
            Self::UndoCommit { .. } => "undoCommit",
            Self::Fetch { .. } => "fetch",
            Self::StashPush { .. } => "stashPush",
            Self::StashApply { pop: false, .. } => "stashApply",
            Self::StashApply { pop: true, .. } => "stashPop",
            Self::StashDrop { .. } => "stashDrop",
            Self::BranchCreate { .. } => "branchCreate",
            Self::BranchSwitch { .. } => "branchSwitch",
            Self::BranchTrack { .. } => "branchTrack",
            Self::Checkout { .. } => "checkout",
            Self::BranchRename { .. } => "branchRename",
            Self::BranchDelete { .. } => "branchDelete",
            Self::SetUpstream { .. } => "setUpstream",
            Self::Pull { .. } => "pull",
            Self::Push { .. } => "push",
            Self::Merge { .. } => "merge",
            Self::MergeAbort => "mergeAbort",
            Self::MergeCommit { .. } => "mergeCommit",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpStatus {
    Succeeded,
    Failed,
    Cancelled,
    /// 未执行任何改动：需要用户再次确认（冲突标记、不可撤销、丢弃后又被修改）。
    NeedsConfirmation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub reason: &'static str,
    pub message: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationOutcome {
    pub op_id: String,
    pub repo_id: String,
    pub kind: &'static str,
    pub status: OpStatus,
    pub message: String,
    pub output: String,
    pub output_truncated: bool,
    pub snapshot: Option<RepositorySnapshot>,
    pub confirmation: Option<Confirmation>,
    pub backup: Option<BackupSummary>,
    /// 操作结束后仍存在本次之前没有的 `index.lock`（通常是被取消的进程留下）；不会自动删除。
    pub lock_left: bool,
    /// 本次操作启动的写通道 Git 进程数（不含结束后的刷新 status）。
    pub git_processes: u32,
    pub elapsed_ms: u64,
    /// 操作改动的工作区相对路径，用于 watcher 尾窗口过滤回声事件。
    #[serde(skip)]
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub touched: Vec<String>,
}

/// 单个步骤的结果（由各操作实现返回）。
pub(super) struct Step {
    pub status: OpStatus,
    pub message: String,
    pub confirmation: Option<Confirmation>,
    pub backup: Option<BackupSummary>,
    pub touched: Vec<String>,
}

impl Step {
    fn ok(message: impl Into<String>) -> Self {
        Self { status: OpStatus::Succeeded, message: message.into(), confirmation: None, backup: None, touched: Vec::new() }
    }
    fn failed(message: impl Into<String>) -> Self {
        Self { status: OpStatus::Failed, message: message.into(), confirmation: None, backup: None, touched: Vec::new() }
    }
    fn cancelled(message: impl Into<String>) -> Self {
        Self { status: OpStatus::Cancelled, message: message.into(), confirmation: None, backup: None, touched: Vec::new() }
    }
    fn confirm(reason: &'static str, message: impl Into<String>, paths: Vec<String>) -> Self {
        let message = message.into();
        Self { status: OpStatus::NeedsConfirmation, message: message.clone(), confirmation: Some(Confirmation { reason, message, paths }), backup: None, touched: Vec::new() }
    }
}

/// 一次操作的执行上下文。
pub struct OpContext<'a> {
    pub op_id: String,
    pub cancel: Arc<CancelHandle>,
    pub log: OutputLog<'a>,
    pub backups: &'a BackupStore,
    pub processes: AtomicU32,
    /// 网络操作的无输出超时（默认 60 s，见 `network.rs`）。
    pub network_idle: std::time::Duration,
}

impl<'a> OpContext<'a> {
    pub fn new(op_id: String, cancel: Arc<CancelHandle>, backups: &'a BackupStore, sink: &'a (dyn Fn(&str) + Sync)) -> Self {
        Self { op_id, cancel, log: OutputLog::new(sink), backups, processes: AtomicU32::new(0), network_idle: network::network_idle() }
    }
}

/// 仓库级写锁：同一仓库同时只允许一个写操作，另一个请求直接拒绝（不排队）。
#[derive(Default, Clone)]
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub struct Runner {
    active: Arc<Mutex<HashMap<String, Arc<CancelHandle>>>>,
    last: Arc<Mutex<HashMap<String, LastOperation>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastOperation {
    pub op_id: String,
    pub kind: &'static str,
    pub status: OpStatus,
    pub message: String,
    pub output: String,
    pub output_truncated: bool,
    pub finished_at: u64,
}

#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub struct RunGuard {
    runner: Runner,
    repo_id: String,
    pub cancel: Arc<CancelHandle>,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.runner.active.lock() {
            active.remove(&self.repo_id);
        }
    }
}

#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
impl Runner {
    pub fn begin(&self, repo_id: &str) -> Result<RunGuard, GitError> {
        let mut active = self.active.lock().map_err(|_| GitError::Io("写锁不可用".into()))?;
        if active.contains_key(repo_id) {
            return Err(GitError::OperationBusy);
        }
        let cancel = Arc::new(CancelHandle::default());
        active.insert(repo_id.to_owned(), cancel.clone());
        Ok(RunGuard { runner: self.clone(), repo_id: repo_id.to_owned(), cancel })
    }

    /// 取消该仓库正在运行的写操作（终止整个进程树）；没有运行中的操作时返回 false。
    pub fn cancel(&self, repo_id: &str) -> bool {
        let handle = self.active.lock().ok().and_then(|a| a.get(repo_id).cloned());
        match handle {
            Some(handle) => {
                handle.cancel();
                true
            }
            None => false,
        }
    }

    pub fn record(&self, outcome: &OperationOutcome) {
        let entry = LastOperation {
            op_id: outcome.op_id.clone(),
            kind: outcome.kind,
            status: outcome.status,
            message: outcome.message.clone(),
            output: outcome.output.clone(),
            output_truncated: outcome.output_truncated,
            finished_at: now_ms(),
        };
        if let Ok(mut last) = self.last.lock() {
            last.insert(outcome.repo_id.clone(), entry);
        }
    }

    pub fn last(&self, repo_id: &str) -> Option<LastOperation> {
        self.last.lock().ok()?.get(repo_id).cloned()
    }
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// 解码并校验前端传来的 pathId（base64url 原始路径字节）。
pub(super) fn decode_path_id(id: &str) -> Result<Vec<u8>, GitError> {
    let bytes = URL_SAFE_NO_PAD.decode(id).map_err(|_| GitError::UnsafePath)?;
    if bytes.is_empty() || bytes.contains(&0) {
        return Err(GitError::UnsafePath);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| GitError::UnsupportedPathEncoding)?;
    validate_relative(text)?;
    Ok(bytes)
}

pub(super) fn nul_list(paths: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend_from_slice(path);
        out.push(0);
    }
    out
}

pub(super) fn display(path: &[u8]) -> String {
    String::from_utf8_lossy(path).into_owned()
}

impl GitAdapter {
    /// 执行一个写操作：前置检查 → 操作 → 一次精确刷新（允许回写 stat 缓存）。
    /// 前置检查失败（进行中状态、外部锁、已推送保护）以错误返回，仓库未被改动。
    pub fn run_operation(&self, request: OperationRequest, view_scope: CompareScope, ctx: &OpContext) -> Result<OperationOutcome, GitError> {
        let started = std::time::Instant::now();
        self.preflight(&request)?;
        let lock_before = self.index_lock_exists();
        let step = match &request {
            OperationRequest::Stage { path_ids } => self.op_stage(path_ids, false, true, ctx),
            OperationRequest::MarkResolved { path_ids, confirmed } => self.op_stage(path_ids, true, *confirmed, ctx),
            OperationRequest::Unstage { path_ids } => self.op_unstage(path_ids, ctx),
            OperationRequest::Discard { scope, path_ids, confirmed_unrecoverable } => self.op_discard(*scope, path_ids, *confirmed_unrecoverable, ctx),
            OperationRequest::UndoDiscard { backup_id, overwrite } => self.op_undo_discard(backup_id, *overwrite, ctx),
            OperationRequest::HunkStage { path_id, content_ids, hunk } => self.op_hunk(HunkAction::Stage, path_id, content_ids, hunk, false, ctx),
            OperationRequest::HunkUnstage { path_id, content_ids, hunk } => self.op_hunk(HunkAction::Unstage, path_id, content_ids, hunk, false, ctx),
            OperationRequest::HunkDiscard { path_id, content_ids, hunk, confirmed_unrecoverable } => self.op_hunk(HunkAction::Discard, path_id, content_ids, hunk, *confirmed_unrecoverable, ctx),
            OperationRequest::Commit { message } => self.op_commit(message, ctx),
            OperationRequest::UndoCommit { expected_head } => self.op_undo_commit(expected_head, ctx),
            OperationRequest::Fetch { remote } => self.op_fetch(remote, ctx),
            OperationRequest::StashPush { message, include_untracked, path_ids } => self.op_stash_push(message.as_deref(), *include_untracked, path_ids.as_deref(), ctx),
            OperationRequest::StashApply { index, oid, pop } => self.op_stash_apply(*index, oid, *pop, ctx),
            OperationRequest::StashDrop { index, oid } => self.op_stash_drop(*index, oid, ctx),
            OperationRequest::BranchCreate { name, start, switch, stash_first, stash_untracked } => self.op_branch_create(name, start, *switch, *stash_first, *stash_untracked, ctx),
            OperationRequest::BranchSwitch { name, stash_first, stash_untracked } => self.op_branch_switch(name, *stash_first, *stash_untracked, ctx),
            OperationRequest::BranchTrack { remote, local_name, stash_first, stash_untracked } => self.op_branch_track(remote, local_name.as_deref(), *stash_first, *stash_untracked, ctx),
            OperationRequest::Checkout { commit, stash_first, stash_untracked } => self.op_checkout(commit, *stash_first, *stash_untracked, ctx),
            OperationRequest::BranchRename { name, new_name } => self.op_branch_rename(name, new_name, ctx),
            OperationRequest::BranchDelete { name, force } => self.op_branch_delete(name, *force, ctx),
            OperationRequest::SetUpstream { name, upstream } => self.op_set_upstream(name, upstream, ctx),
            OperationRequest::Pull { mode, stash_first, stash_untracked } => self.op_pull(*mode, *stash_first, *stash_untracked, ctx),
            OperationRequest::Push { remote } => self.op_push(remote.as_deref(), ctx),
            OperationRequest::Merge { target, expected, no_ff } => self.op_merge(target, expected, *no_ff, ctx),
            OperationRequest::MergeAbort => self.op_merge_abort(ctx),
            OperationRequest::MergeCommit { message } => self.op_merge_commit(message, ctx),
        }?;
        let git_processes = ctx.processes.load(std::sync::atomic::Ordering::SeqCst);
        // 需要确认时没有任何改动，不必刷新；其余结局（含失败与取消）都重新读取实际状态并如实报告。
        let snapshot = if step.status == OpStatus::NeedsConfirmation {
            None
        } else {
            self.snapshot_v2(ctx.op_id.clone(), view_scope, true)
                .or_else(|_| self.snapshot_v2(ctx.op_id.clone(), view_scope, false))
                .ok()
        };
        let lock_left = !lock_before && self.index_lock_exists();
        let mut message = step.message;
        if lock_left {
            message.push_str("。检测到遗留的 .git/index.lock（通常是被终止的 Git 进程留下）；Oris 不会删除它，请确认没有其他 Git 进程后手动处理");
        }
        let (output, output_truncated) = ctx.log.snapshot();
        Ok(OperationOutcome {
            op_id: ctx.op_id.clone(),
            repo_id: self.repo_id.clone(),
            kind: request.kind(),
            status: step.status,
            message,
            output,
            output_truncated,
            snapshot,
            confirmation: step.confirmation,
            backup: step.backup,
            lock_left,
            git_processes,
            elapsed_ms: started.elapsed().as_millis() as u64,
            touched: step.touched,
        })
    }

    fn index_lock_exists(&self) -> bool {
        self.git_dir.join("index.lock").exists()
    }

    /// 进行中状态与外部锁（技术方案 §4）。只读取文件，不启动进程。
    fn preflight(&self, request: &OperationRequest) -> Result<(), GitError> {
        let state = status_v2::detect_in_progress(&self.git_dir);
        let blocked = [(state.rebase, "rebase"), (state.cherry_pick, "cherry-pick"), (state.revert, "revert"), (state.bisect, "bisect")];
        if let Some((_, name)) = blocked.iter().find(|(on, _)| *on) {
            return Err(GitError::WriteBlocked(format!("仓库处于 {name} 进行中，Oris 已禁用写操作；请回到命令行完成或中止后再操作")));
        }
        if state.merge && matches!(request, OperationRequest::UndoCommit { .. }) {
            return Err(GitError::WriteBlocked("合并进行中不能撤销提交".into()));
        }
        // 合并进行中：会改动工作区的切换、检出、储藏与拉取提前拦下，给出中文说明（V2-D45）；
        // 新建（不切换）、重命名、删除其他分支、设置上游、删除 stash 不影响工作区，照常允许。
        let moves_worktree = matches!(
            request,
            OperationRequest::BranchSwitch { .. }
                | OperationRequest::BranchTrack { .. }
                | OperationRequest::Checkout { .. }
                | OperationRequest::StashPush { .. }
                | OperationRequest::StashApply { .. }
                | OperationRequest::Pull { .. }
                | OperationRequest::BranchCreate { switch: true, .. }
        );
        if state.merge && moves_worktree {
            return Err(GitError::WriteBlocked("合并进行中：请先完成或中止当前合并，再切换分支、检出、储藏或拉取".into()));
        }
        // fetch 只写远端跟踪引用与 FETCH_HEAD，不碰 index：外部持有 index.lock 时照常允许（V2-D38）。
        if self.index_lock_exists() && !matches!(request, OperationRequest::Fetch { .. }) {
            return Err(GitError::ExternalLock(format!(
                "另一个 Git 进程正在使用该仓库（存在 {}）。Oris 不会删除锁文件；请等待外部操作结束，或确认没有 Git 进程后手动处理",
                self.git_dir.join("index.lock").display()
            )));
        }
        Ok(())
    }

    /// 在写通道上运行命令；失败输出中的锁冲突转换为明确说明。
    pub(super) fn write_git(&self, args: &[&str], stdin: Option<Vec<u8>>, log_stdout: bool, ctx: &OpContext) -> Result<process::CallResult, GitError> {
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        process::run(&self.git, &self.worktree, &args, stdin, log_stdout, &ctx.cancel, &ctx.log, &ctx.processes)
    }

    /// 不带用户路径、需要 Git 内部魔术路径的写命令（`GIT_LITERAL_PATHSPECS` 关闭，见 [`process::RunOptions`]）。
    pub(super) fn write_git_pathless(&self, args: &[&str], ctx: &OpContext) -> Result<process::CallResult, GitError> {
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        process::run_with(&self.git, &self.worktree, &args, None, true, &ctx.cancel, &ctx.log, &ctx.processes, process::RunOptions { idle: None, literal_pathspecs: false })
    }

    /// 本次操作到目前为止的全部输出（已脱敏，最多 256 KiB）。Git 的提示可能被很长的文件列表挤出错误尾部，识别时用它。
    pub(super) fn full_output(ctx: &OpContext, result: &process::CallResult) -> String {
        format!("{}\n{}", ctx.log.snapshot().0, result.stderr_tail)
    }

    /// Git 在拒绝时以制表符开头列出的路径（去重，最多 200 个）。
    pub(super) fn listed_paths(text: &str) -> Vec<String> {
        let mut paths: Vec<String> = Vec::new();
        for line in text.lines().filter_map(|l| l.strip_prefix('\t')).map(str::trim).filter(|l| !l.is_empty()) {
            if paths.len() >= 200 {
                break;
            }
            if !paths.iter().any(|p| p == line) {
                paths.push(line.to_owned());
            }
        }
        paths
    }

    /// 失败摘要：外部锁冲突给出固定说明。
    pub(super) fn failure_message(result: &process::CallResult, what: &str) -> String {
        let summary = result.summary();
        if summary.contains(".lock") && (summary.contains("File exists") || summary.contains("Unable to create")) {
            format!("{what}失败：另一个 Git 进程正在使用该仓库（锁文件已存在）。Oris 不会删除锁文件，也不会自动重试。\n{summary}")
        } else {
            format!("{what}失败：{summary}")
        }
    }

    /// 快速解析 HEAD 指向的 OID（读取本地 ref 文件，不启动进程）；unborn 返回 Some(None)，无法判断返回 None。
    pub(super) fn head_oid_fast(&self) -> Option<Option<String>> {
        if self.common_dir.join("reftable").exists() {
            return None;
        }
        let mut reference = "HEAD".to_owned();
        for _ in 0..8 {
            validate_relative(&reference).ok()?;
            let bytes = fs::read(self.git_dir.join(&reference)).or_else(|_| fs::read(self.common_dir.join(&reference)));
            match bytes {
                Ok(bytes) => {
                    let value = String::from_utf8_lossy(&bytes).trim().to_owned();
                    if let Some(next) = value.strip_prefix("ref: ") {
                        reference = next.to_owned();
                    } else {
                        return Some(Some(value));
                    }
                }
                Err(_) => {
                    // 只在 packed-refs 中的分支；都没有则为 unborn。
                    let packed = fs::read_to_string(self.common_dir.join("packed-refs")).unwrap_or_default();
                    let found = packed.lines().find_map(|line| {
                        let (oid, name) = line.split_once(' ')?;
                        (name == reference && !oid.starts_with('#') && !oid.starts_with('^')).then(|| oid.to_owned())
                    });
                    return Some(found);
                }
            }
        }
        None
    }

    /// HEAD 的 OID：优先读文件，否则用只读通道 rev-parse。
    pub(super) fn head_oid(&self) -> Result<Option<String>, GitError> {
        if let Some(value) = self.head_oid_fast() {
            return Ok(value);
        }
        let output = run_readonly(&self.git, &self.worktree, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
        Ok(output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned()))
    }
}
