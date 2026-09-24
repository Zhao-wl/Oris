//! R-BRANCHOP 写操作（技术方案 §6）：`branch <name> <oid>`、`switch <name>`、`switch -c <name> --track <remote>/<branch>`、
//! `switch --detach <oid>`、`branch -m`、`branch -d`（未合并时经确认后 `-D`）、`branch --set-upstream-to`。
//! 分支名先用 `check-ref-format --branch` 校验，起点解析为 OID 后再使用。Git 因工作区改动拒绝切换时，
//! 返回需要确认的“stash 后切换”；确认后先储藏再切换，切换后不自动恢复。
use super::super::history::validate_reference;
use super::super::log::resolve_commit;
use super::*;

/// 切换目标。
enum Target<'a> {
    Branch(&'a str),
    Detach(&'a str),
    NewTracking { local: &'a str, upstream: &'a str },
}

impl Target<'_> {
    fn label(&self) -> String {
        match self {
            Target::Branch(name) => name.to_string(),
            Target::Detach(oid) => format!("提交 {}（分离 HEAD）", &oid[..oid.len().min(8)]),
            Target::NewTracking { local, upstream } => format!("{local}（跟踪 {upstream}）"),
        }
    }
}

impl GitAdapter {
    /// 分支名校验（只读）：`check-ref-format --branch`，并拒绝会被 Git 展开的写法（`@{-1}` 等）与选项形式。
    pub fn check_branch_name(&self, name: &str) -> Result<(), GitError> {
        let invalid = |reason: &str| Err(GitError::WriteBlocked(format!("分支名“{name}”无效：{reason}")));
        if name.trim().is_empty() {
            return invalid("不能为空");
        }
        if name.starts_with('-') || name.contains("@{") || name == "HEAD" || name.chars().any(|c| c.is_control()) {
            return invalid("不能以 - 开头、不能包含 @{ 或控制字符、不能为 HEAD");
        }
        let output = run_readonly(&self.git, &self.worktree, &["check-ref-format", "--branch", name])?;
        if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != name {
            return invalid("不符合 Git 分支命名规则（例如不能含空格、~ ^ : ? * [ \\、连续的点或以 .lock 结尾）");
        }
        Ok(())
    }

    fn local_branch_short(&self, full: &str) -> Result<String, GitError> {
        let Some(short) = full.strip_prefix("refs/heads/") else {
            return Err(GitError::WriteBlocked(format!("不是本地分支：{full}")));
        };
        validate_reference(full)?;
        let exists = run_readonly(&self.git, &self.worktree, &["rev-parse", "-q", "--verify", "--end-of-options", &format!("{full}^{{commit}}")])?;
        if !exists.status.success() {
            return Err(GitError::WriteBlocked(format!("本地分支 {short} 不存在（可能已在外部被删除或改名），请刷新")));
        }
        Ok(short.to_owned())
    }

    pub(super) fn current_branch_ref(&self) -> Option<String> {
        run_readonly(&self.git, &self.worktree, &["symbolic-ref", "-q", "HEAD"]).ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    }

    /// 操作前储藏（“stash 后切换 / 拉取”）：成功时返回新 stash 的 OID（没有可储藏的改动时为 None）；
    /// 储藏被取消或失败时返回应直接结束操作的 Step。
    pub(super) fn stash_before(&self, purpose: &str, untracked: bool, ctx: &OpContext) -> Result<Result<Option<String>, Step>, GitError> {
        let before = self.stash_oid(0)?;
        let message = format!("Oris：{purpose}前储藏");
        let mut args = vec!["stash", "push", "-m", message.as_str()];
        if untracked {
            args.push("--include-untracked");
        }
        let result = self.write_git_pathless(&args, ctx)?;
        if result.cancelled {
            return Ok(Err(Step::cancelled(format!("储藏已取消，未{purpose}"))));
        }
        if !result.success {
            return Ok(Err(Step::failed(format!("{}，未{purpose}", Self::failure_message(&result, &format!("{purpose}前储藏"))))));
        }
        let after = self.stash_oid(0)?;
        Ok(Ok(after.filter(|oid| Some(oid) != before.as_ref())))
    }

    /// 切换（可先储藏）。Git 因本地改动或会被覆盖的未跟踪文件拒绝时，返回需要确认的“stash 后切换”。
    fn switch_to(&self, target: Target<'_>, stash_first: bool, stash_untracked: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let label = target.label();
        let mut stashed = None;
        if stash_first {
            match self.stash_before(&format!("切换到 {label} "), stash_untracked, ctx)? {
                Ok(oid) => stashed = oid,
                Err(step) => return Ok(step),
            }
        }
        let args: Vec<&str> = match &target {
            Target::Branch(name) => vec!["switch", "--no-guess", name],
            Target::Detach(oid) => vec!["switch", "--detach", oid],
            Target::NewTracking { local, upstream } => vec!["switch", "-c", local, "--track", upstream],
        };
        let result = self.write_git(&args, None, true, ctx)?;
        let stash_note = |text: &str| match &stashed {
            Some(oid) => format!("{text}。切换前的改动已储藏为 stash@{{0}}（{}），没有自动恢复，可在“Stash”页应用或弹出", &oid[..8]),
            None => text.to_owned(),
        };
        if result.cancelled {
            return Ok(Step::cancelled(stash_note("切换已取消；已重新读取实际状态")));
        }
        if result.success {
            return Ok(Step::ok(stash_note(&format!("已切换到 {label}"))));
        }
        // 文件列表很长时 Git 的提示头会被挤出错误尾部：在全部输出中识别。
        let full = Self::full_output(ctx, &result);
        let local_changes = full.contains("would be overwritten by checkout") || full.contains("Please commit your changes or stash them");
        let untracked = full.contains("untracked working tree files would be") || full.contains("Please move or remove them before you switch");
        if !stash_first && (local_changes || untracked) {
            let reason = if untracked { "untrackedOverwritten" } else { "localChanges" };
            let what = if untracked { "未跟踪文件会被覆盖" } else { "工作区改动会被覆盖" };
            return Ok(Step::confirm(reason, format!("Git 拒绝切换到 {label}：{what}。可以先储藏{}再切换，切换后不会自动恢复", if untracked { "（含未跟踪文件）" } else { "" }), Self::listed_paths(&full)));
        }
        Ok(Step::failed(stash_note(&Self::failure_message(&result, &format!("切换到 {label}")))))
    }

    pub(super) fn op_branch_switch(&self, name: &str, stash_first: bool, stash_untracked: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let short = self.local_branch_short(name)?;
        if self.current_branch_ref().as_deref() == Some(name) {
            return Ok(Step::failed(format!("已经在分支 {short} 上")));
        }
        self.switch_to(Target::Branch(&short), stash_first, stash_untracked, ctx)
    }

    /// 从远端跟踪分支建立同名（或指定名称的）本地跟踪分支并切换；同名本地分支已存在且未指定名称时要求用户选择。
    pub(super) fn op_branch_track(&self, remote: &str, local_name: Option<&str>, stash_first: bool, stash_untracked: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let Some(short_remote) = remote.strip_prefix("refs/remotes/") else {
            return Err(GitError::WriteBlocked(format!("不是远端跟踪分支：{remote}")));
        };
        validate_reference(remote)?;
        resolve_commit(&self.git, &self.worktree, remote).map_err(|_| GitError::WriteBlocked(format!("远端跟踪分支 {short_remote} 不存在，请刷新")))?;
        let remotes = self.remote_names()?;
        let Some(owner) = remotes.iter().filter(|r| short_remote.starts_with(&format!("{r}/"))).max_by_key(|r| r.len()) else {
            return Err(GitError::WriteBlocked(format!("找不到 {short_remote} 所属的 remote")));
        };
        let default_name = &short_remote[owner.len() + 1..];
        let local = local_name.unwrap_or(default_name);
        self.check_branch_name(local)?;
        let full = format!("refs/heads/{local}");
        let exists = run_readonly(&self.git, &self.worktree, &["rev-parse", "-q", "--verify", "--end-of-options", &full])?.status.success();
        if exists {
            if local_name.is_none() {
                return Ok(Step::confirm("localExists", format!("已存在同名本地分支 {local}。可以切换到这个已有分支，或用另一个名称新建跟踪 {short_remote} 的分支"), vec![local.to_owned()]));
            }
            return Err(GitError::WriteBlocked(format!("本地分支 {local} 已存在，请换一个名称")));
        }
        self.switch_to(Target::NewTracking { local, upstream: short_remote }, stash_first, stash_untracked, ctx)
    }

    /// 检出指定提交（分离 HEAD）。
    pub(super) fn op_checkout(&self, commit: &str, stash_first: bool, stash_untracked: bool, ctx: &OpContext) -> Result<Step, GitError> {
        validate_reference(commit)?;
        let oid = resolve_commit(&self.git, &self.worktree, commit)?;
        self.switch_to(Target::Detach(&oid), stash_first, stash_untracked, ctx)
    }

    /// 新建分支：起点可为 HEAD、分支或提交（先解析为 OID）；可选创建后立即切换。
    pub(super) fn op_branch_create(&self, name: &str, start: &str, switch: bool, stash_first: bool, stash_untracked: bool, ctx: &OpContext) -> Result<Step, GitError> {
        self.check_branch_name(name)?;
        validate_reference(start)?;
        let oid = resolve_commit(&self.git, &self.worktree, start)?;
        let full = format!("refs/heads/{name}");
        let exists = run_readonly(&self.git, &self.worktree, &["rev-parse", "-q", "--verify", "--end-of-options", &full])?.status.success();
        // 确认“stash 后切换”后的再次请求：第一次已创建且仍指向同一起点时直接切换。
        let created_before = exists && stash_first && resolve_commit(&self.git, &self.worktree, &full).is_ok_and(|tip| tip == oid);
        if !created_before {
            let result = self.write_git(&["branch", "--no-track", name, &oid], None, true, ctx)?;
            if result.cancelled {
                return Ok(Step::cancelled("新建分支已取消"));
            }
            if !result.success {
                return Ok(Step::failed(Self::failure_message(&result, &format!("新建分支 {name}"))));
            }
        }
        if !switch {
            return Ok(Step::ok(format!("已从 {} 新建分支 {name}（未切换）", &oid[..8])));
        }
        let mut step = self.switch_to(Target::Branch(name), stash_first, stash_untracked, ctx)?;
        step.message = match step.status {
            OpStatus::Succeeded => format!("已从 {} 新建分支 {name}；{}", &oid[..8], step.message),
            OpStatus::NeedsConfirmation => format!("分支 {name} 已创建。{}", step.message),
            _ => format!("分支 {name} 已创建，但{}", step.message),
        };
        if let Some(confirmation) = step.confirmation.as_mut() {
            confirmation.message = step.message.clone();
        }
        Ok(step)
    }

    pub(super) fn op_branch_rename(&self, name: &str, new_name: &str, ctx: &OpContext) -> Result<Step, GitError> {
        let short = self.local_branch_short(name)?;
        self.check_branch_name(new_name)?;
        let result = self.write_git(&["branch", "-m", &short, new_name], None, true, ctx)?;
        Ok(if result.cancelled {
            Step::cancelled("重命名已取消")
        } else if result.success {
            Step::ok(format!("已将分支 {short} 重命名为 {new_name}"))
        } else {
            Step::failed(Self::failure_message(&result, &format!("重命名分支 {short}")))
        })
    }

    /// 删除本地分支：不能删除当前分支；未合并时先要求强确认，确认后 `-D`。
    pub(super) fn op_branch_delete(&self, name: &str, force: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let short = self.local_branch_short(name)?;
        if self.current_branch_ref().as_deref() == Some(name) {
            return Err(GitError::WriteBlocked(format!("不能删除当前分支 {short}，请先切换到其他分支")));
        }
        let tip = resolve_commit(&self.git, &self.worktree, name)?;
        let flag = if force { "-D" } else { "-d" };
        let result = self.write_git(&["branch", flag, &short], None, true, ctx)?;
        if result.cancelled {
            return Ok(Step::cancelled("删除分支已取消"));
        }
        if result.success {
            return Ok(Step::ok(format!("已删除分支 {short}（原指向 {}；需要时可用 git branch {short} {} 从 reflog 找回的提交恢复）", &tip[..8], &tip[..8])));
        }
        let summary = result.summary();
        if !force && summary.contains("not fully merged") {
            let not_head = "^HEAD";
            let unmerged = run_readonly(&self.git, &self.worktree, &["rev-list", "--count", &tip, not_head, "--"])
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
            let count = unmerged.map(|n| format!("有 {n} 个提交")).unwrap_or_else(|| "有提交".into());
            return Ok(Step::confirm("unmerged", format!("分支 {short} {count}尚未合并到当前分支或其上游。删除后这些提交只能通过 reflog 找回（原指向 {}）", &tip[..8]), vec![short]));
        }
        Ok(Step::failed(Self::failure_message(&result, &format!("删除分支 {short}"))))
    }

    /// 为本地分支设置或更换上游（远端跟踪分支）。
    pub(super) fn op_set_upstream(&self, name: &str, upstream: &str, ctx: &OpContext) -> Result<Step, GitError> {
        let short = self.local_branch_short(name)?;
        let Some(short_upstream) = upstream.strip_prefix("refs/remotes/") else {
            return Err(GitError::WriteBlocked(format!("上游必须是远端跟踪分支：{upstream}")));
        };
        validate_reference(upstream)?;
        resolve_commit(&self.git, &self.worktree, upstream).map_err(|_| GitError::WriteBlocked(format!("远端跟踪分支 {short_upstream} 不存在，请先获取远端状态")))?;
        let option = format!("--set-upstream-to={short_upstream}");
        let result = self.write_git(&["branch", &option, &short], None, true, ctx)?;
        Ok(if result.cancelled {
            Step::cancelled("设置上游已取消")
        } else if result.success {
            Step::ok(format!("已将 {short} 的上游设为 {short_upstream}"))
        } else {
            Step::failed(Self::failure_message(&result, "设置上游"))
        })
    }
}
