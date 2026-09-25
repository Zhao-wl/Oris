//! R-STASH 写操作：`stash push [-u] [-m] [-- <paths>]`、apply / pop / drop（技术方案 §6）。
//! 操作前核对 `stash@{n}` 仍指向列表中的 OID，列表在外部被修改时拒绝执行。
//! pop 为“按 OID apply，成功且没有冲突后再核对并 drop”：出现冲突时 stash 保留（R-STASH）。
use super::*;

impl GitAdapter {
    fn stash_top(&self) -> Option<String> {
        self.stash_oid(0).ok().flatten()
    }

    /// 核对 `stash@{n}` 仍是列表中的那一条；否则拒绝（前端刷新列表）。
    fn verify_stash(&self, index: u32, oid: &str) -> Result<(), GitError> {
        match self.stash_oid(index)? {
            Some(current) if current == oid => Ok(()),
            _ => Err(GitError::WriteBlocked(format!("stash@{{{index}}} 已不是列表中的那一条（stash 列表在外部被修改），已拒绝执行；请刷新列表后重试"))),
        }
    }

    fn unmerged_paths(&self) -> Vec<String> {
        run_readonly(&self.git, &self.worktree, &["ls-files", "-u", "-z"])
            .ok()
            .map(|o| {
                let mut paths: Vec<String> = o.stdout.split(|b| *b == 0).filter_map(|record| {
                    let tab = record.iter().position(|b| *b == b'\t')?;
                    Some(String::from_utf8_lossy(&record[tab + 1..]).into_owned())
                }).collect();
                paths.dedup();
                paths
            })
            .unwrap_or_default()
    }

    /// 储藏：`message` 为空时使用 Git 默认说明；`path_ids` 为 Some 时只储藏这些路径。
    pub(super) fn op_stash_push(&self, message: Option<&str>, include_untracked: bool, path_ids: Option<&[String]>, ctx: &OpContext) -> Result<Step, GitError> {
        if message.is_some_and(|m| m.contains('\0')) {
            return Err(GitError::WriteBlocked("说明中不能包含 NUL 字符".into()));
        }
        let paths = match path_ids {
            Some(ids) => {
                let paths = ids.iter().map(|id| decode_path_id(id)).collect::<Result<Vec<_>, _>>()?;
                if paths.is_empty() {
                    return Ok(Step::failed("没有选择文件"));
                }
                Some(paths)
            }
            None => None,
        };
        let before = self.stash_top();
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        let message = message.map(str::trim).filter(|m| !m.is_empty());
        if let Some(message) = message {
            args.extend(["-m", message]);
        }
        let stdin = paths.as_ref().map(|paths| nul_list(paths));
        if stdin.is_some() {
            args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
        }
        // 带路径时路径按字面量传递；不带路径时 Git 内部用 `:/` 清理已储藏的文件，不能开启字面量路径。
        let result = if stdin.is_some() { self.write_git(&args, stdin, true, ctx)? } else { self.write_git_pathless(&args, ctx)? };
        if result.cancelled {
            return Ok(Step::cancelled("储藏已取消"));
        }
        if !result.success {
            return Ok(Step::failed(Self::failure_message(&result, "储藏")));
        }
        let after = self.stash_top();
        if after.is_none() || after == before {
            return Ok(Step::failed("没有可储藏的改动（Git 未创建新的 stash）"));
        }
        let mut step = Step::ok(format!(
            "已储藏为 stash@{{0}}{}{}",
            paths.as_ref().map(|p| format!("（{} 个选中的路径）", p.len())).unwrap_or_default(),
            if include_untracked { "，包含未跟踪文件" } else { "" }
        ));
        step.touched = paths.map(|p| p.iter().map(|x| display(x)).collect()).unwrap_or_default();
        Ok(step)
    }

    /// apply / pop。`pop` 在 apply 成功且没有冲突后再核对身份并 drop。
    pub(super) fn op_stash_apply(&self, index: u32, oid: &str, pop: bool, ctx: &OpContext) -> Result<Step, GitError> {
        self.verify_stash(index, oid)?;
        let what = if pop { "弹出" } else { "应用" };
        let result = self.write_git(&["stash", "apply", "--end-of-options", oid], None, true, ctx)?;
        if result.cancelled {
            return Ok(Step::cancelled(format!("{what} stash 已取消；工作区可能已部分改动，已重新读取实际状态")));
        }
        let conflicts = self.unmerged_paths();
        if !conflicts.is_empty() {
            return Ok(Step::failed(format!(
                "{what} stash@{{{index}}} 时出现 {} 个冲突：stash 已保留在列表中。冲突文件可在“未暂存”范围只读查看，在外部解决后“标记已解决”；是否删除这条 stash 由你决定",
                conflicts.len()
            )));
        }
        if !result.success {
            return Ok(Step::failed(format!("{}；stash 已保留", Self::failure_message(&result, &format!("{what} stash")))));
        }
        if !pop {
            return Ok(Step::ok(format!("已应用 stash@{{{index}}}（stash 保留在列表中）")));
        }
        // 应用期间列表若在外部被修改，不 drop 另一条 stash。
        if self.stash_oid(index)?.as_deref() != Some(oid) {
            return Ok(Step::failed(format!("已应用该 stash，但 stash@{{{index}}} 在此期间已被外部修改，未删除任何 stash；请刷新列表后自行处理")));
        }
        let spec = format!("stash@{{{index}}}");
        let dropped = self.write_git(&["stash", "drop", "-q", &spec], None, true, ctx)?;
        Ok(if dropped.success {
            Step::ok(format!("已弹出 stash@{{{index}}}（应用后已从列表删除）"))
        } else {
            Step::failed(format!("已应用该 stash，但删除失败，stash 仍在列表中：{}", dropped.summary()))
        })
    }

    pub(super) fn op_stash_drop(&self, index: u32, oid: &str, ctx: &OpContext) -> Result<Step, GitError> {
        self.verify_stash(index, oid)?;
        let spec = format!("stash@{{{index}}}");
        let result = self.write_git(&["stash", "drop", "-q", &spec], None, true, ctx)?;
        Ok(if result.cancelled {
            Step::cancelled("删除 stash 已取消")
        } else if result.success {
            // 不做备份（V2-D42）：给出找回命令，悬空对象被 gc 清理前有效。
            Step::ok(format!("已删除 stash@{{{index}}}（{}）。需要找回时可在终端执行：git stash store -m \"Oris 找回的 stash\" {oid}（悬空对象被 git gc 清理前有效）", &oid[..oid.len().min(8)]))
        } else {
            Step::failed(Self::failure_message(&result, "删除 stash"))
        })
    }
}
