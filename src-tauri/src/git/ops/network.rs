//! 网络写操作的公共部分与显式 fetch（R-REMOTE、技术方案 §4）：进度（`--progress`）、取消（整个进程树）、
//! 无输出超时、认证失败的可操作提示；失败或取消后重新读取远端跟踪引用并如实报告，不承诺回滚。
//! 凭据只依赖用户已有的 credential helper 与 ssh-agent，不做 askpass（V2-D12）；终端提示保持关闭。
use super::*;
use std::collections::BTreeMap;
use std::time::Duration;

/// 网络操作的初始无输出超时（技术方案 §4）。`ORIS_NETWORK_IDLE_TIMEOUT_MS` 只供测试缩短。
pub const NETWORK_IDLE: Duration = Duration::from_secs(60);

pub(super) fn network_idle() -> Duration {
    std::env::var("ORIS_NETWORK_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms >= 100)
        .map(Duration::from_millis)
        .unwrap_or(NETWORK_IDLE)
}

/// 认证类失败的提示：Oris 不弹出凭据输入，只使用本机已有的凭据设施。
pub(super) fn auth_hint(summary: &str) -> Option<&'static str> {
    let lower = summary.to_ascii_lowercase();
    let auth = [
        "authentication failed",
        "permission denied",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "invalid username or password",
        "host key verification failed",
        "repository not found",
        "access denied",
        "returned error: 401",
        "returned error: 403",
    ];
    auth.iter().any(|needle| lower.contains(needle)).then_some(
        "可能是认证失败或没有访问权限。Oris 只使用本机已有的凭据（Git Credential Manager / 钥匙串、ssh-agent），不会弹出密码输入；请先在终端对该远端完成一次认证（例如 git fetch），确认账号有权限后再试",
    )
}

impl GitAdapter {
    /// 已配置的 remote（只读）。
    pub(super) fn remote_names(&self) -> Result<Vec<String>, GitError> {
        let output = run_required(&self.git, &self.worktree, &["remote"])?;
        Ok(String::from_utf8_lossy(&output.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
    }

    pub(super) fn require_remote(&self, remote: &str) -> Result<(), GitError> {
        if remote.is_empty() || remote.starts_with('-') || !self.remote_names()?.iter().any(|r| r == remote) {
            return Err(GitError::WriteBlocked(format!("没有名为 {remote} 的 remote；Oris 不会新增或修改 remote")));
        }
        Ok(())
    }

    /// 远端跟踪引用与标签的快照（只读），用于操作前后对比。
    pub(super) fn tracking_refs(&self) -> BTreeMap<String, String> {
        run_readonly(&self.git, &self.worktree, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/tags"])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|l| l.split_once(' '))
                    .map(|(name, oid)| (name.to_owned(), oid.to_owned()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 在写通道上运行网络命令（带无输出超时）。
    pub(super) fn network_git(&self, args: &[&str], ctx: &OpContext) -> Result<process::CallResult, GitError> {
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        process::run_with(&self.git, &self.worktree, &args, None, true, &ctx.cancel, &ctx.log, &ctx.processes, process::RunOptions { idle: Some(ctx.network_idle), literal_pathspecs: true, index_file: None })
    }

    /// 网络命令结束后的说明：取消 / 超时 / 失败（附认证提示）。成功时返回 None。
    pub(super) fn network_failure(result: &process::CallResult, what: &str, ctx: &OpContext) -> Option<Step> {
        if result.cancelled {
            return Some(Step::cancelled(format!("已取消{what}")));
        }
        if result.timed_out {
            return Some(Step::failed(format!(
                "{what}超过 {:.0} 秒没有任何输出，已终止。可能需要先在终端完成首次主机认证（SSH 主机指纹）或凭据配置；Oris 不会弹出凭据输入",
                ctx.network_idle.as_secs_f32()
            )));
        }
        if !result.success {
            let summary = result.summary();
            let mut message = Self::failure_message(result, what);
            if let Some(hint) = auth_hint(&summary) {
                message.push_str("\n");
                message.push_str(hint);
            }
            return Some(Step::failed(message));
        }
        None
    }

    /// 显式 fetch：不 prune、不递归子模块、不触发自动维护，不附带 pull / push / checkout。
    pub(super) fn op_fetch(&self, remote: &str, ctx: &OpContext) -> Result<Step, GitError> {
        self.require_remote(remote)?;
        let before = self.tracking_refs();
        let result = self.network_git(
            &[
                "fetch",
                "--progress",
                "--no-prune",
                "--no-recurse-submodules",
                "--no-auto-maintenance",
                "--no-write-commit-graph",
                "--end-of-options",
                remote,
            ],
            ctx,
        )?;
        let after = self.tracking_refs();
        let changed = after.iter().filter(|(name, oid)| before.get(*name) != Some(oid)).count() + before.keys().filter(|name| !after.contains_key(*name)).count();
        let what = format!("获取 {remote}");
        if let Some(mut step) = Self::network_failure(&result, &what, ctx) {
            // 失败或取消后已重新读取实际引用：如实说明，不承诺回滚。
            step.message.push_str(&if changed > 0 {
                format!("。已重新读取实际引用：结束前已有 {changed} 个远端跟踪引用 / 标签被更新，Oris 不会回滚")
            } else {
                "。已重新读取实际引用：远端跟踪引用没有变化".to_owned()
            });
            return Ok(step);
        }
        Ok(Step::ok(if changed > 0 {
            format!("已获取 {remote}：{changed} 个远端跟踪引用 / 标签有更新（工作区与暂存区未改动）")
        } else {
            format!("已获取 {remote}：没有新的变化（工作区与暂存区未改动）")
        }))
    }
}
