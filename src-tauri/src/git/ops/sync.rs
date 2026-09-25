//! R-SYNC 与 R-MERGE 写操作（技术方案 §6）：
//! - pull：`pull --no-rebase [--ff-only | --no-ff --no-edit] --progress --no-recurse-submodules --no-autostash`，
//!   始终不走 rebase（用户配置 `pull.rebase=true` 也以合并执行，V2-D04）；
//! - push：只推送当前分支，显式 refspec `refs/heads/<b>:<上游>`，`--no-follow-tags`（不推送 tag）、
//!   `--recurse-submodules=no`，首次为 `--set-upstream`；不提供任何强制推送；
//! - merge：`merge --no-edit --no-autostash [--no-ff] <目标>`（其余遵循 `merge.ff`），中止为 `merge --abort`，
//!   完成为 `commit -F -`。
//! 网络命令带进度、取消与无输出超时，失败或取消后重新读取实际引用并如实报告（见 `network.rs`）。
use super::super::history::validate_reference;
use super::super::log::resolve_commit;
use super::*;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// 仅快进（默认）。
    FfOnly,
    /// 合并远端改动（`--no-ff --no-edit`）。
    Merge,
}

/// 当前分支的上游配置：(remote, merge 引用)。
struct Upstream {
    remote: String,
    merge: String,
}

fn short(oid: Option<&str>) -> String {
    oid.map(|o| o.chars().take(8).collect()).unwrap_or_else(|| "（无）".into())
}

impl GitAdapter {
    fn config_value(&self, key: &str) -> Option<String> {
        run_readonly(&self.git, &self.worktree, &["config", "--get", key]).ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    }

    fn upstream_of(&self, branch_short: &str) -> Option<Upstream> {
        let remote = self.config_value(&format!("branch.{branch_short}.remote"))?;
        let merge = self.config_value(&format!("branch.{branch_short}.merge"))?;
        Some(Upstream { remote, merge })
    }

    fn current_branch_short(&self, what: &str) -> Result<String, GitError> {
        let Some(full) = self.current_branch_ref() else {
            return Err(GitError::WriteBlocked(format!("处于分离 HEAD：不能{what}，请先切换到分支或从这里新建分支")));
        };
        full.strip_prefix("refs/heads/").map(str::to_owned).ok_or_else(|| GitError::WriteBlocked(format!("当前 HEAD 不是本地分支，不能{what}")))
    }

    fn merge_in_progress(&self) -> bool {
        self.git_dir.join("MERGE_HEAD").exists()
    }

    fn conflict_count(&self) -> usize {
        run_readonly(&self.git, &self.worktree, &["ls-files", "-u", "-z"])
            .ok()
            .map(|o| {
                let mut paths: Vec<&[u8]> = o.stdout.split(|b| *b == 0).filter_map(|r| r.iter().position(|b| *b == b'\t').map(|t| &r[t + 1..])).collect();
                paths.dedup();
                paths.len()
            })
            .unwrap_or(0)
    }

    /// 拉取当前分支的上游。
    pub(super) fn op_pull(&self, mode: PullMode, stash_first: bool, stash_untracked: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let branch = self.current_branch_short("拉取")?;
        let Some(upstream) = self.upstream_of(&branch) else {
            return Err(GitError::WriteBlocked(format!("分支 {branch} 没有上游：请先在分支弹层为它“设置上游”")));
        };
        if self.merge_in_progress() {
            return Err(GitError::WriteBlocked("合并进行中：请先完成或中止当前合并".into()));
        }
        let upstream_label = format!("{}/{}", upstream.remote, upstream.merge.strip_prefix("refs/heads/").unwrap_or(&upstream.merge));
        let mut stashed = None;
        if stash_first {
            match self.stash_before("拉取", stash_untracked, ctx)? {
                Ok(oid) => stashed = oid,
                Err(step) => return Ok(step),
            }
        }
        let head_before = self.head_oid()?;
        let refs_before = self.tracking_refs();
        let mut args = vec!["pull", "--progress", "--no-rebase", "--no-autostash", "--no-recurse-submodules"];
        match mode {
            PullMode::FfOnly => args.push("--ff-only"),
            PullMode::Merge => args.extend(["--no-ff", "--no-edit"]),
        }
        let result = self.network_git(&args, ctx)?;
        let head_after = self.head_oid()?;
        let refs_changed = self.tracking_refs().iter().filter(|(k, v)| refs_before.get(*k) != Some(v)).count();
        let note = |text: String| match &stashed {
            Some(oid) => format!("{text}。拉取前的改动已储藏为 stash@{{0}}（{}），没有自动恢复，可在“Stash”页应用或弹出", &oid[..8]),
            None => text,
        };
        let what = format!("拉取 {upstream_label}");
        if !result.success && !result.cancelled && !result.timed_out {
            let summary = result.summary();
            if self.merge_in_progress() {
                return Ok(Step::failed(note(format!("{what}时出现 {} 个冲突：已进入“合并进行中”。冲突文件可只读查看，在外部解决后“标记已解决”，再“完成合并”或“中止合并”", self.conflict_count()))));
            }
            if summary.contains("Not possible to fast-forward") || summary.contains("not possible to fast-forward") || summary.contains("Diverging branches") {
                return Ok(Step::confirm("diverged", note(format!("本地分支 {branch} 与 {upstream_label} 已分叉，无法仅快进。可以改用“合并远端改动”（会生成合并提交）；Oris 不做 rebase")), vec![]));
            }
            // 文件列表很长时 Git 的提示头会被挤出错误尾部：在全部输出中识别。
            let full = Self::full_output(ctx, &result);
            let untracked = full.contains("untracked working tree files would be") || full.contains("Please move or remove them before you merge");
            if stashed.is_none() && !stash_first && (untracked || full.contains("would be overwritten by merge") || full.contains("Please commit your changes or stash them")) {
                let reason = if untracked { "untrackedOverwritten" } else { "localChanges" };
                let paths = Self::listed_paths(&full);
                return Ok(Step::confirm(reason, format!("工作区改动会被拉取覆盖，Git 拒绝拉取 {upstream_label}。可以先储藏{}再拉取，拉取后不会自动恢复", if untracked { "（含未跟踪文件）" } else { "" }), paths));
            }
        }
        if let Some(mut step) = Self::network_failure(&result, &what, ctx) {
            let moved = if head_after != head_before { format!("HEAD 已从 {} 变为 {}", short(head_before.as_deref()), short(head_after.as_deref())) } else { "HEAD 未变化".into() };
            step.message = note(format!("{}。已重新读取实际状态：{moved}，{refs_changed} 个远端跟踪引用有更新；Oris 不会回滚", step.message));
            return Ok(step);
        }
        let message = if head_after == head_before {
            format!("{upstream_label} 没有需要拉取的新提交（已是最新）")
        } else {
            let parents = run_readonly(&self.git, &self.worktree, &["rev-list", "--parents", "-n", "1", "HEAD", "--"]).map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().count().saturating_sub(1)).unwrap_or(1);
            if parents > 1 {
                format!("已从 {upstream_label} 拉取并生成合并提交 {}", short(head_after.as_deref()))
            } else {
                format!("已从 {upstream_label} 快进到 {}", short(head_after.as_deref()))
            }
        };
        Ok(Step::ok(note(message)))
    }

    /// 推送当前分支：有上游时推送到上游；没有上游时推送到所选 remote 的同名分支并设为上游。
    pub(super) fn op_push(&self, remote: Option<&str>, ctx: &OpContext) -> Result<Step, GitError> {
        let branch = self.current_branch_short("推送")?;
        let upstream = self.upstream_of(&branch).filter(|u| u.remote != ".");
        let (remote, destination, set_upstream) = match (&upstream, remote) {
            (Some(up), None) => (up.remote.clone(), up.merge.clone(), false),
            (Some(up), Some(chosen)) if chosen == up.remote => (up.remote.clone(), up.merge.clone(), false),
            (_, Some(chosen)) => (chosen.to_owned(), format!("refs/heads/{branch}"), true),
            (None, None) => return Err(GitError::WriteBlocked(format!("分支 {branch} 没有上游：请选择要推送到的 remote"))),
        };
        self.require_remote(&remote)?;
        if !destination.starts_with("refs/heads/") || destination.contains(['+', ':', ' ']) {
            return Err(GitError::WriteBlocked(format!("不支持的推送目标：{destination}")));
        }
        let source = format!("refs/heads/{branch}");
        validate_reference(&source)?;
        let refspec = format!("{source}:{destination}");
        let target = format!("{remote}/{}", destination.trim_start_matches("refs/heads/"));
        let ahead = run_readonly(&self.git, &self.worktree, &["rev-list", "--count", &source, &format!("^refs/remotes/{target}"), "--"])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
        let refs_before = self.tracking_refs();
        let mut args = vec!["push", "--progress", "--no-follow-tags", "--recurse-submodules=no"];
        if set_upstream {
            args.push("--set-upstream");
        }
        args.extend(["--end-of-options", remote.as_str(), refspec.as_str()]);
        let result = self.network_git(&args, ctx)?;
        let what = format!("推送 {branch} 到 {target}");
        if !result.success && !result.cancelled && !result.timed_out {
            let summary = result.summary();
            if summary.contains("[rejected]") || summary.contains("non-fast-forward") || summary.contains("fetch first") || summary.contains("Updates were rejected") {
                return Ok(Step::failed(format!("{what}被拒绝：远端有本地没有的新提交。请先拉取（获取后仅快进或合并），再推送；Oris 不提供强制推送\n{summary}")));
            }
        }
        if let Some(mut step) = Self::network_failure(&result, &what, ctx) {
            let changed = self.tracking_refs().iter().filter(|(k, v)| refs_before.get(*k) != Some(v)).count();
            step.message.push_str(&format!("。已重新读取实际引用：{changed} 个远端跟踪引用有更新；远端是否已收到部分内容以远端为准，Oris 不会回滚"));
            return Ok(step);
        }
        Ok(Step::ok(match (set_upstream, ahead.as_deref()) {
            (true, _) => format!("已推送 {branch} 到 {target}，并设为上游"),
            (false, Some("0")) => format!("{target} 已是最新，没有需要推送的提交"),
            (false, Some(n)) => format!("已推送 {n} 个提交到 {target}"),
            (false, None) => format!("已推送 {branch} 到 {target}"),
        }))
    }

    /// 把本地或远端跟踪分支（或提交）合并到当前分支；`expected` 为界面上显示的目标 OID，已移动时拒绝。
    pub(super) fn op_merge(&self, target: &str, expected: &str, no_ff: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let branch = self.current_branch_short("合并")?;
        validate_reference(target)?;
        if target == "HEAD" {
            return Err(GitError::WriteBlocked("不能把 HEAD 合并到自己".into()));
        }
        if self.merge_in_progress() {
            return Err(GitError::WriteBlocked("已有合并在进行中：请先完成或中止".into()));
        }
        let oid = resolve_commit(&self.git, &self.worktree, target)?;
        if oid != expected {
            return Err(GitError::WriteBlocked(format!("{target} 已移动到 {}（界面显示的是 {}），已拒绝执行；请刷新后重试", short(Some(&oid)), short(Some(expected)))));
        }
        let head_before = self.head_oid()?;
        let label = target.strip_prefix("refs/heads/").or_else(|| target.strip_prefix("refs/remotes/")).or_else(|| target.strip_prefix("refs/tags/")).unwrap_or(&target[..target.len().min(8)]).to_owned();
        // 按已核对的 OID 合并（避免核对与执行之间目标移动），合并信息按 Git 的默认写法给出。
        let message = if target.starts_with("refs/heads/") {
            format!("Merge branch '{label}'")
        } else if target.starts_with("refs/remotes/") {
            format!("Merge remote-tracking branch '{label}'")
        } else if target.starts_with("refs/tags/") {
            format!("Merge tag '{label}'")
        } else {
            format!("Merge commit '{label}'")
        };
        let mut args = vec!["merge", "--no-edit", "--no-autostash", "-m", message.as_str()];
        if no_ff {
            args.push("--no-ff");
        }
        args.extend(["--end-of-options", oid.as_str()]);
        let result = self.write_git(&args, None, true, ctx)?;
        let head_after = self.head_oid()?;
        if result.cancelled {
            return Ok(Step::cancelled(if self.merge_in_progress() { "合并已取消，但仓库处于合并进行中：可以“中止合并”".to_owned() } else { "合并已取消；已重新读取实际状态".to_owned() }));
        }
        if self.merge_in_progress() {
            return Ok(Step::failed(format!("合并 {label} 到 {branch} 出现 {} 个冲突：已进入“合并进行中”。冲突文件可只读查看，在外部解决后“标记已解决”，再“完成合并”；也可以“中止合并”", self.conflict_count())));
        }
        if !result.success {
            return Ok(Step::failed(Self::failure_message(&result, &format!("合并 {label}"))));
        }
        Ok(Step::ok(if head_after == head_before {
            format!("{branch} 已包含 {label}（Already up to date），没有变化")
        } else {
            let parents = run_readonly(&self.git, &self.worktree, &["rev-list", "--parents", "-n", "1", "HEAD", "--"]).map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().count().saturating_sub(1)).unwrap_or(1);
            if parents > 1 {
                format!("已将 {label} 合并到 {branch}（合并提交 {}）", short(head_after.as_deref()))
            } else {
                format!("已将 {branch} 快进到 {label}（{}）", short(head_after.as_deref()))
            }
        }))
    }

    pub(super) fn op_merge_abort(&self, ctx: &OpContext) -> Result<Step, GitError> {
        if !self.merge_in_progress() {
            return Err(GitError::WriteBlocked("当前没有进行中的合并".into()));
        }
        let result = self.write_git(&["merge", "--abort"], None, true, ctx)?;
        Ok(if result.cancelled {
            Step::cancelled("中止合并已取消；已重新读取实际状态")
        } else if result.success {
            Step::ok("已中止合并：HEAD、暂存区与工作区回到合并前的状态")
        } else {
            Step::failed(Self::failure_message(&result, "中止合并"))
        })
    }

    /// 完成合并：所有冲突都已标记解决后，以（可编辑的）合并信息提交。
    pub(super) fn op_merge_commit(&self, message: &str, ctx: &OpContext) -> Result<Step, GitError> {
        if !self.merge_in_progress() {
            return Err(GitError::WriteBlocked("当前没有进行中的合并".into()));
        }
        let conflicts = self.conflict_count();
        if conflicts > 0 {
            return Err(GitError::WriteBlocked(format!("还有 {conflicts} 个冲突文件没有标记已解决")));
        }
        let mut step = self.op_commit(message, ctx)?;
        if step.status == OpStatus::Succeeded {
            step.message = step.message.replacen("已提交", "已完成合并", 1);
        }
        Ok(step)
    }

    /// 合并进行中的默认合并信息（`.git/MERGE_MSG`，只读）。
    pub fn merge_message(&self) -> Option<String> {
        if !self.merge_in_progress() {
            return None;
        }
        let text = fs::read_to_string(self.git_dir.join("MERGE_MSG")).ok()?;
        let lines: Vec<&str> = text.lines().filter(|l| !l.starts_with('#')).collect();
        Some(lines.join("\n").trim().to_owned())
    }
}
