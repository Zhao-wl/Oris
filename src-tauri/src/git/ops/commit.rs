//! R-COMMIT：commit（`commit -F -`）、撤销最近提交（`reset --soft <第一个父提交>`；根提交为 `update-ref -d HEAD <oid>`）。
//! hooks 与签名按用户仓库配置执行，不提供 `--no-verify`（V2-D14）。已推送的 HEAD 禁止撤销（V2-D11）；不提供 amend。
use super::*;

/// 提交面板需要的 HEAD 信息（只读通道）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadCommitInfo {
    pub oid: String,
    pub parents: Vec<String>,
    pub message: String,
    pub subject: String,
    /// HEAD 已包含在上游分支中；无上游时为 None（不做已推送限制）。
    pub pushed: Option<bool>,
    pub upstream: Option<String>,
    /// HEAD 为分离状态（撤销根提交在分离状态下不提供）。
    pub detached: bool,
}

impl GitAdapter {
    /// 在临时 index 中只暂存选中的整文件并提交，用户原有的其他暂存内容始终保留。
    pub(super) fn op_commit_selected(
        &self,
        message: &str,
        path_ids: &[String],
        expected_revision: &str,
        ctx: &OpContext,
    ) -> Result<Step, GitError> {
        if status_v2::detect_in_progress(&self.git_dir).merge {
            return Err(GitError::WriteBlocked(
                "合并进行中不能使用 AI 选择文件提交".into(),
            ));
        }
        if message.trim().is_empty() || path_ids.is_empty() {
            return Ok(Step::failed("请选择文件并填写提交信息"));
        }
        let scan = self.scan(false)?;
        if scan.revision != expected_revision {
            return Err(GitError::StaleRequest);
        }
        let changes = self.details_for(&scan)?.all.clone();
        let selected: std::collections::HashSet<&str> =
            path_ids.iter().map(String::as_str).collect();
        if selected.len() != path_ids.len()
            || changes
                .iter()
                .filter(|change| selected.contains(change.path_id.as_str()))
                .count()
                != selected.len()
        {
            return Err(GitError::StaleRequest);
        }
        let mut paths = Vec::new();
        for change in &changes {
            if selected.contains(change.path_id.as_str()) {
                paths.push(decode_path_id(&change.path_id)?);
                if let Some(old) = &change.old_path_id {
                    paths.push(decode_path_id(old)?);
                }
            }
        }
        let listed = nul_list(&paths);
        let temp = tempfile::tempdir().map_err(|error| GitError::Io(error.to_string()))?;
        let index = temp.path().join("index");
        let run_temp = |args: &[&str], stdin: Option<Vec<u8>>| {
            let args: Vec<&std::ffi::OsStr> = args.iter().map(std::ffi::OsStr::new).collect();
            process::run_with(
                &self.git,
                &self.worktree,
                &args,
                stdin,
                true,
                &ctx.cancel,
                &ctx.log,
                &ctx.processes,
                process::RunOptions {
                    idle: None,
                    literal_pathspecs: true,
                    index_file: Some(index.clone()),
                },
            )
        };
        let initial = if self.head_oid()?.is_some() {
            vec!["read-tree", "HEAD"]
        } else {
            vec!["read-tree", "--empty"]
        };
        let result = run_temp(&initial, None)?;
        if !result.success {
            return Ok(Step::failed(Self::failure_message(
                &result,
                "准备独立暂存区",
            )));
        }
        let result = run_temp(
            &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
            Some(listed.clone()),
        )?;
        if !result.success {
            return Ok(Step::failed(Self::failure_message(&result, "选择提交文件")));
        }
        let head_before = self.head_oid()?;
        let result = run_temp(&["commit", "-F", "-"], Some(message.as_bytes().to_vec()))?;
        let head_after = self.head_oid()?;
        if head_after != head_before {
            // 仅把已提交路径在真实 index 中更新至新 HEAD，其他预先暂存的文件保持原样。
            // 即使提交被取消或 post-commit hook 报错，只要 HEAD 已变化也必须修复 index。
            let args: Vec<&std::ffi::OsStr> = [
                "restore",
                "--staged",
                "--source=HEAD",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
            .iter()
            .map(std::ffi::OsStr::new)
            .collect();
            let repair_cancel = process::CancelHandle::default();
            let repair = process::run(
                &self.git,
                &self.worktree,
                &args,
                Some(listed),
                true,
                &repair_cancel,
                &ctx.log,
                &ctx.processes,
            )?;
            if !repair.success {
                return Ok(Step::failed(format!(
                    "提交已生成（HEAD 为 {}），但原暂存区同步失败：{}",
                    short(head_after.as_deref()),
                    repair.summary()
                )));
            }
        }
        Ok(if result.cancelled {
            Step::cancelled(if head_after != head_before {
                format!(
                    "提交已生成（HEAD 为 {}），但操作已取消",
                    short(head_after.as_deref())
                )
            } else {
                "已取消；没有生成提交".into()
            })
        } else if result.success {
            Step::ok(format!(
                "已提交 {} 个文件：{}",
                selected.len(),
                short(head_after.as_deref())
            ))
        } else if head_after != head_before {
            Step::failed(format!(
                "{}；提交已生成（HEAD 为 {}）",
                Self::failure_message(&result, "提交"),
                short(head_after.as_deref())
            ))
        } else {
            Step::failed(format!(
                "{}；没有生成提交",
                Self::failure_message(&result, "提交")
            ))
        })
    }

    /// 读取 HEAD 提交信息与已推送判断：`log -1` 与 `merge-base --is-ancestor HEAD @{u}`，都走只读通道。
    pub fn head_commit_info(&self) -> Result<Option<HeadCommitInfo>, GitError> {
        let output = run_readonly(
            &self.git,
            &self.worktree,
            &[
                "log",
                "-1",
                "--no-show-signature",
                "--format=%H%x00%P%x00%B",
                "HEAD",
                "--",
            ],
        )?;
        if !output.status.success() {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        let mut parts = text.splitn(3, '\0');
        let oid = parts.next().unwrap_or("").trim().to_owned();
        if oid.is_empty() {
            return Ok(None);
        }
        let parents = parts
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        let message = parts.next().unwrap_or("").trim_end().to_owned();
        let subject = message.lines().next().unwrap_or("").to_owned();
        let (pushed, upstream) = self.pushed_state()?;
        let detached = run_readonly(&self.git, &self.worktree, &["symbolic-ref", "-q", "HEAD"])
            .map(|o| !o.status.success())
            .unwrap_or(false);
        Ok(Some(HeadCommitInfo {
            oid,
            parents,
            message,
            subject,
            pushed,
            upstream,
            detached,
        }))
    }

    /// HEAD 是否已包含在上游分支中（只读）。无上游或上游不存在时返回 (None, None)。
    fn pushed_state(&self) -> Result<(Option<bool>, Option<String>), GitError> {
        let upstream = run_readonly(
            &self.git,
            &self.worktree,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )?;
        if !upstream.status.success() {
            return Ok((None, None));
        }
        let name = String::from_utf8_lossy(&upstream.stdout).trim().to_owned();
        let ancestor = run_readonly(
            &self.git,
            &self.worktree,
            &["merge-base", "--is-ancestor", "HEAD", "@{u}"],
        )?;
        Ok(match ancestor.status.code() {
            Some(0) => (Some(true), Some(name)),
            Some(1) => (Some(false), Some(name)),
            _ => (None, Some(name)),
        })
    }

    fn ensure_not_pushed(&self, what: &str) -> Result<(), GitError> {
        if let (Some(true), Some(upstream)) = self.pushed_state()? {
            return Err(GitError::WriteBlocked(format!(
                "HEAD 已包含在上游 {upstream} 中，{what}需要强制推送，Oris 不支持；请在命令行处理"
            )));
        }
        Ok(())
    }

    pub(super) fn op_commit(&self, message: &str, ctx: &OpContext) -> Result<Step, GitError> {
        let head_before = self.head_oid()?;
        if message.trim().is_empty() {
            return Ok(Step::failed("提交信息不能为空"));
        }
        let result = self.write_git(
            &["commit", "-F", "-"],
            Some(message.as_bytes().to_vec()),
            true,
            ctx,
        )?;
        let head_after = self.head_oid()?;
        let what = "提交";
        Ok(if result.cancelled {
            if head_after != head_before {
                Step::cancelled(format!(
                    "{what}已取消，但提交在取消前已经生成（HEAD 为 {}）",
                    short(head_after.as_deref())
                ))
            } else {
                Step::cancelled(format!("{what}已取消；没有生成提交，HEAD 未变化"))
            }
        } else if result.success {
            Step::ok(format!("已{what}：{}", short(head_after.as_deref())))
        } else if head_after != head_before {
            // 例如 post-commit hook 失败：提交已生成。
            Step::failed(format!(
                "{}；提交已生成（HEAD 为 {}）",
                Self::failure_message(&result, what),
                short(head_after.as_deref())
            ))
        } else {
            Step::failed(format!(
                "{}；没有生成提交",
                Self::failure_message(&result, what)
            ))
        })
    }

    pub(super) fn op_undo_commit(
        &self,
        expected_head: &str,
        ctx: &OpContext,
    ) -> Result<Step, GitError> {
        let head = self
            .head_oid()?
            .ok_or_else(|| GitError::WriteBlocked("还没有提交，无法撤销".into()))?;
        if head != expected_head {
            return Err(GitError::StaleRequest);
        }
        self.ensure_not_pushed("撤销提交")?;
        let parents = run_required(
            &self.git,
            &self.worktree,
            &["rev-list", "--parents", "-n", "1", "HEAD", "--"],
        )?;
        let line = String::from_utf8_lossy(&parents.stdout).trim().to_owned();
        let parents: Vec<&str> = line.split_whitespace().skip(1).collect();
        let result = match parents.first() {
            Some(first) => self.write_git(&["reset", "-q", "--soft", first], None, true, ctx)?,
            None => {
                let symbolic =
                    run_readonly(&self.git, &self.worktree, &["symbolic-ref", "-q", "HEAD"])?;
                if !symbolic.status.success() {
                    return Err(GitError::WriteBlocked(
                        "分离 HEAD 上的根提交不能撤销".into(),
                    ));
                }
                // 带旧值校验：HEAD 在此期间变化则 Git 拒绝。
                self.write_git(&["update-ref", "-d", "HEAD", &head], None, true, ctx)?
            }
        };
        Ok(if result.cancelled {
            Step::cancelled("撤销提交已取消")
        } else if result.success {
            Step::ok(match parents.len() {
                0 => "已撤销根提交：仓库回到无提交状态，文件保留在暂存区".to_owned(),
                1 => format!("已撤销提交 {}：改动回到暂存区", short(Some(&head))),
                _ => format!(
                    "已撤销合并提交 {}：HEAD 回到第一个父提交 {}",
                    short(Some(&head)),
                    short(parents.first().copied())
                ),
            })
        } else {
            Step::failed(Self::failure_message(&result, "撤销提交"))
        })
    }
}

fn short(oid: Option<&str>) -> String {
    oid.map(|o| o.chars().take(8).collect())
        .unwrap_or_else(|| "（无）".into())
}
