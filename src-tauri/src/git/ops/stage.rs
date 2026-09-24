//! R-STAGE 文件级：stage（`add -A`）、unstage（`restore --staged`；空 HEAD 为 `rm --cached`）、
//! 冲突文件“标记已解决”（stage 的变体，先检查冲突标记）。
use super::*;

/// 冲突标记（行首）：`<<<<<<< `、`=======`、`>>>>>>> `。
fn has_conflict_markers(bytes: &[u8]) -> bool {
    bytes.split(|b| *b == b'\n').any(|line| {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        line.starts_with(b"<<<<<<< ") || line == b"<<<<<<<" || line == b"=======" || line.starts_with(b">>>>>>> ") || line == b">>>>>>>"
    })
}

impl GitAdapter {
    pub(super) fn op_stage(&self, path_ids: &[String], resolve: bool, confirmed: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let paths = path_ids.iter().map(|id| decode_path_id(id)).collect::<Result<Vec<_>, _>>()?;
        if paths.is_empty() {
            return Ok(Step::failed("没有选择文件"));
        }
        if resolve && !confirmed {
            let marked: Vec<String> = paths
                .iter()
                .filter(|path| {
                    std::str::from_utf8(path)
                        .ok()
                        .and_then(|relative| self.read_worktree(relative, MAX_TEXT_BYTES).ok())
                        .is_some_and(|bytes| has_conflict_markers(&bytes))
                })
                .map(|path| display(path))
                .collect();
            if !marked.is_empty() {
                return Ok(Step::confirm(
                    "conflictMarkers",
                    format!("{} 个文件中仍有冲突标记（<<<<<<< / ======= / >>>>>>>）。确认已解决后再标记", marked.len()),
                    marked,
                ));
            }
        }
        // `-A` 让已删除的路径也被暂存为删除；路径为字面量（GIT_LITERAL_PATHSPECS）。
        let result = self.write_git(&["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(nul_list(&paths)), true, ctx)?;
        let what = if resolve { "标记已解决" } else { "暂存" };
        Ok(if result.cancelled {
            Step::cancelled(format!("{what}已取消"))
        } else if result.success {
            Step::ok(format!("已{what} {} 个文件", paths.len()))
        } else {
            Step::failed(Self::failure_message(&result, what))
        })
    }

    pub(super) fn op_unstage(&self, path_ids: &[String], ctx: &OpContext) -> Result<Step, GitError> {
        let paths = path_ids.iter().map(|id| decode_path_id(id)).collect::<Result<Vec<_>, _>>()?;
        if paths.is_empty() {
            return Ok(Step::failed("没有选择文件"));
        }
        let has_head = self.head_oid()?.is_some();
        // 空 HEAD（首次提交前）没有可恢复的来源：从 index 移除即取消暂存，工作区不变。
        let args: &[&str] = if has_head {
            &["restore", "--staged", "--pathspec-from-file=-", "--pathspec-file-nul"]
        } else {
            &["rm", "--cached", "-f", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"]
        };
        let result = self.write_git(args, Some(nul_list(&paths)), true, ctx)?;
        Ok(if result.cancelled {
            Step::cancelled("取消暂存已取消")
        } else if result.success {
            Step::ok(format!("已取消暂存 {} 个文件", paths.len()))
        } else {
            Step::failed(Self::failure_message(&result, "取消暂存"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::has_conflict_markers;

    #[test]
    fn conflict_marker_detection_is_line_based() {
        assert!(has_conflict_markers(b"a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> theirs\n"));
        assert!(has_conflict_markers(b"a\r\n=======\r\n"));
        assert!(!has_conflict_markers(b"a <<<<<<< in text\n== not a marker\n"));
    }
}
