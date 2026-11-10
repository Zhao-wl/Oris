//! R-STASH 写操作：`stash push [-u] [-m] [-- <paths>]`、apply / pop / drop（技术方案 §6）。
//! 操作前核对 `stash@{n}` 仍指向列表中的 OID，列表在外部被修改时拒绝执行。
//! pop 为“按 OID apply，成功且没有冲突后再核对并 drop”：出现冲突时 stash 保留（R-STASH）。
use super::*;

struct StashIndexLock {
    path: PathBuf,
    published: bool,
}

impl StashIndexLock {
    fn acquire(path: PathBuf) -> Result<(Self, fs::File), GitError> {
        let file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                GitError::ExternalLock(format!("暂存区被其他 Git 进程锁定：{}", path.display()))
            } else {
                GitError::Io(error.to_string())
            }
        })?;
        Ok((Self { path, published: false }, file))
    }

    fn publish(mut self, file: fs::File, index: &Path) -> std::io::Result<()> {
        drop(file);
        fs::rename(&self.path, index)?;
        self.published = true;
        Ok(())
    }
}

impl Drop for StashIndexLock {
    fn drop(&mut self) {
        if !self.published { let _ = fs::remove_file(&self.path); }
    }
}

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

    pub(super) fn unmerged_paths(&self) -> Vec<String> {
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
        let result = if let Some(paths) = paths.as_ref() {
            args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
            return self.stash_selected(&args, paths, include_untracked, before.as_deref(), ctx);
        } else {
            // 不带路径时 Git 内部用 `:/` 清理已储藏的文件，不能开启字面量路径。
            self.write_git_pathless(&args, ctx)?
        };
        Ok(self.finish_stash_push(result, before.as_deref(), None, include_untracked))
    }

    fn stash_selected(&self, args: &[&str], paths: &[Vec<u8>], include_untracked: bool, before: Option<&str>, ctx: &OpContext) -> Result<Step, GitError> {
        let io_error = |error: std::io::Error| GitError::Io(error.to_string());
        let index = self.git_dir.join("index");
        let (lock, mut lock_file) = StashIndexLock::acquire(self.index_lock_path())?;
        let temp = tempfile::tempdir().map_err(io_error)?;
        let stash_index = temp.path().join("stash-index");
        let final_index = temp.path().join("final-index");
        if index.exists() { fs::copy(&index, &stash_index).map_err(io_error)?; }

        let selected: std::collections::HashSet<_> = paths.iter().map(Vec::as_slice).collect();
        let state = self.scan(false)?;
        let unrelated = state.lists.staged.iter()
            .flat_map(|file| std::iter::once(&file.path_id).chain(file.old_path_id.iter()))
            .map(|id| decode_path_id(id))
            .collect::<Result<Vec<_>, _>>()?;
        let unrelated: Vec<_> = unrelated.into_iter().filter(|path| !selected.contains(path.as_slice())).collect();

        let run = |index: &Path, args: &[&str], paths: &[Vec<u8>]| {
            let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
            process::run_with(&self.git, &self.worktree, &args, Some(nul_list(paths)), true,
                &ctx.cancel, &ctx.log, &ctx.processes, process::RunOptions { index_file: Some(index.to_path_buf()), ..Default::default() })
        };
        let copy_index = |path: &Path, destination: &mut fs::File| {
            std::io::copy(&mut fs::File::open(path)?, destination).map(|_| ())
        };

        if !unrelated.is_empty() {
            if self.head_oid()?.is_none() { return Ok(Step::failed("首次提交之前无法储藏")); }
            // Git 的路径储藏仍会把整个暂存区写入 stash。先从临时 index 去掉未选中的改动，
            // 另从原 index 准备只重置所选路径的结果，在储藏成功后原子写回。
            fs::copy(&index, &final_index).map_err(io_error)?;
            let reset = ["reset", "--quiet", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"];
            for (path, files) in [(&stash_index, unrelated.as_slice()), (&final_index, paths)] {
                let result = run(path, &reset, files)?;
                if result.cancelled { return Ok(Step::cancelled("储藏已取消")); }
                if !result.success { return Ok(Step::failed(Self::failure_message(&result, "准备储藏范围"))); }
            }
            copy_index(&final_index, &mut lock_file).map_err(io_error)?;
        }

        let result = run(&stash_index, args, paths)?;
        let mut step = self.finish_stash_push(result, before, Some(paths), include_untracked);
        if step.status == OpStatus::Succeeded {
            let publish = (|| {
                if unrelated.is_empty() { copy_index(&stash_index, &mut lock_file)?; }
                lock.publish(lock_file, &index)
            })();
            if let Err(error) = publish {
                step.status = OpStatus::Failed;
                step.message = format!("储藏已创建，但写回暂存区失败：{error}");
            }
        }
        Ok(step)
    }

    fn finish_stash_push(&self, result: process::CallResult, before: Option<&str>, paths: Option<&[Vec<u8>]>, include_untracked: bool) -> Step {
        if result.cancelled {
            return Step::cancelled("储藏已取消");
        }
        if !result.success {
            return Step::failed(Self::failure_message(&result, "储藏"));
        }
        let after = self.stash_top();
        if after.is_none() || after.as_deref() == before {
            return Step::failed("没有可储藏的改动（Git 未创建新的 stash）");
        }
        let mut step = Step::ok(format!(
            "已储藏为 stash@{{0}}{}{}",
            paths.as_ref().map(|p| format!("（{} 个选中的路径）", p.len())).unwrap_or_default(),
            if include_untracked { "，包含未跟踪文件" } else { "" }
        ));
        step.stash_oid = after;
        step.touched = paths.map(|p| p.iter().map(|x| display(x)).collect()).unwrap_or_default();
        step
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
