//! 行选区只携带 Git 块摘要与块内偏移；所有补丁正文由后端原始字节生成。
use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineSelection {
    pub hunk: HunkRef,
    pub old_lines: Vec<usize>,
    pub new_lines: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineSelectionRequest {
    pub path_id: String,
    pub content_ids: [String; 2],
    pub expected_revision: String,
    pub selections: Vec<LineSelection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinePreview {
    pub digest: String,
    pub patch: String,
    pub removed: usize,
    pub added: usize,
    pub note: String,
}

// 补丁描述的是实际 index 写入方向，取消暂存也不依赖前端逆转补丁。
struct PatchLine {
    tag: u8,
    bytes: Vec<u8>,
}

fn selection_patch(path: &[u8], rows: &[PatchLine]) -> Result<Vec<u8>, String> {
    let changed: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, r)| (r.tag != b' ').then_some(i))
        .collect();
    if changed.is_empty() {
        return Err("请选择实际变化行".into());
    }
    // 如果部分选择把无换行的末行放到了文件中间，拒绝，不能悄悄补换行。
    let mut saw_tail = false;
    for row in rows.iter().filter(|r| r.tag != b'-') {
        if saw_tail {
            return Err("部分选择会把无末尾换行的行放到文件中间，请同时选择该替换的两侧".into());
        }
        saw_tail = !row.bytes.ends_with(b"\n");
    }
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for i in changed {
        let start = i.saturating_sub(3);
        let end = (i + 4).min(rows.len());
        if let Some(last) = spans.last_mut().filter(|last| start <= last.1) {
            last.1 = end;
        } else {
            spans.push((start, end));
        }
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"diff --git ");
    out.extend_from_slice(&quoted("a/", path));
    out.push(b' ');
    out.extend_from_slice(&quoted("b/", path));
    out.extend_from_slice(b"\n--- ");
    out.extend_from_slice(&quoted("a/", path));
    out.extend_from_slice(b"\n+++ ");
    out.extend_from_slice(&quoted("b/", path));
    out.push(b'\n');
    let (mut old, mut new, mut cursor) = (0, 0, 0);
    for (start, end) in spans {
        for row in &rows[cursor..start] {
            old += usize::from(row.tag != b'+');
            new += usize::from(row.tag != b'-');
        }
        let old_len = rows[start..end].iter().filter(|r| r.tag != b'+').count();
        let new_len = rows[start..end].iter().filter(|r| r.tag != b'-').count();
        out.extend_from_slice(
            format!(
                "@@ -{},{} +{},{} @@\n",
                old + usize::from(old_len > 0),
                old_len,
                new + usize::from(new_len > 0),
                new_len
            )
            .as_bytes(),
        );
        for row in &rows[start..end] {
            push_line(&mut out, row.tag, &row.bytes);
        }
        old += old_len;
        new += new_len;
        cursor = end;
    }
    Ok(out)
}

/// 在读取映射时就给出禁用原因，不允许先把无法映射的显示行当成可写选区。
pub(super) fn line_mapping_block(old: &[u8], raw_new: &[u8], clean: &[Vec<u8>]) -> Option<String> {
    if clean.len() > MAX_TEXT_LINES {
        return Some("超出内容预算（100,000 行），不提供行操作".into());
    }
    if old.contains(&0) || raw_new.contains(&0) {
        return Some("UTF-16、含 NUL 或二进制内容无法准确映射到 Git 原始行，不提供行操作".into());
    }
    let bare_cr = |bytes: &[u8]| {
        bytes
            .iter()
            .enumerate()
            .any(|(i, b)| *b == b'\r' && bytes.get(i + 1) != Some(&b'\n'))
    };
    if bare_cr(old) || bare_cr(raw_new) {
        return Some("单独 CR 换行无法映射 Git 的 LF 行边界，请使用文件级操作".into());
    }
    if raw_style(&split_lines(raw_new), clean).is_none() {
        return Some(
            "Git clean filter 或外部变化改写了行内容，无法核验显示行与原始差异的映射".into(),
        );
    }
    None
}

impl GitAdapter {
    fn selected_patch(
        &self,
        scope: CompareScope,
        request: &LineSelectionRequest,
    ) -> Result<(Vec<u8>, usize, usize), GitError> {
        if scope == CompareScope::All {
            return Err(GitError::CommandFailed("请切换到未暂存或已暂存范围".into()));
        }
        let state = self.scan(false)?;
        if state.revision != request.expected_revision {
            return Err(GitError::StaleRequest);
        }
        let source = self
            .hunk_source(&state, scope, &request.path_id)?
            .map_err(GitError::CommandFailed)?;
        if source.content_ids != request.content_ids {
            return Err(GitError::StaleRequest);
        }
        let old = split_lines(&source.old);
        let new = reconstruct(&old, &source.hunks).map_err(GitError::CommandFailed)?;
        if let Some(reason) = source.line_blocked {
            return Err(GitError::CommandFailed(reason));
        }
        if scope == CompareScope::Unstaged {
            let relative =
                std::str::from_utf8(&source.path).map_err(|_| GitError::UnsupportedPathEncoding)?;
            let raw = self.read_worktree(relative, MAX_TEXT_BYTES + 1)?;
            if hash_bytes(&raw) != request.content_ids[1] {
                return Err(GitError::StaleRequest);
            }
            if raw_style(&split_lines(&raw), &new).is_none() {
                return Err(GitError::CommandFailed(
                    "Git clean filter 改写了行内容，无法核验显示行与原始差异的映射".into(),
                ));
            }
        }
        if request.selections.len() > source.hunks.len() {
            return Err(GitError::StaleRequest);
        }
        let references: BTreeMap<_, _> = source
            .hunks
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let r = h.reference();
                (
                    (r.old_start, r.old_end, r.new_start, r.new_end, r.digest),
                    i,
                )
            })
            .collect();
        let mut chosen = BTreeMap::new();
        let (mut removed, mut added) = (0, 0);
        for selection in &request.selections {
            let h = &selection.hunk;
            let index = *references
                .get(&(
                    h.old_start,
                    h.old_end,
                    h.new_start,
                    h.new_end,
                    h.digest.clone(),
                ))
                .ok_or(GitError::StaleRequest)?;
            if chosen.contains_key(&index) {
                return Err(GitError::StaleRequest);
            }
            let hunk = &source.hunks[index];
            let a: BTreeSet<_> = selection.old_lines.iter().copied().collect();
            let b: BTreeSet<_> = selection.new_lines.iter().copied().collect();
            if a.len() != selection.old_lines.len()
                || b.len() != selection.new_lines.len()
                || a.iter().any(|i| *i >= hunk.removed.len())
                || b.iter().any(|i| *i >= hunk.added.len())
            {
                return Err(GitError::CommandFailed(
                    "选区包含重复或越界行，已拒绝执行".into(),
                ));
            }
            removed += a.len();
            added += b.len();
            chosen.insert(index, (a, b));
        }
        let target: Vec<Vec<u8>> = if scope == CompareScope::Staged {
            new
        } else {
            old.iter().map(|l| l.to_vec()).collect()
        };
        let mut rows = Vec::new();
        let mut cursor = 0;
        for (index, hunk) in source.hunks.iter().enumerate() {
            let (start, end) = if scope == CompareScope::Staged {
                (hunk.range.2, hunk.range.3)
            } else {
                (hunk.range.0, hunk.range.1)
            };
            for line in &target[cursor..start] {
                rows.push(PatchLine {
                    tag: b' ',
                    bytes: line.clone(),
                });
            }
            if let Some((a, b)) = chosen.get(&index) {
                // 按块内行序组合：成对选中的替换留在原位；独立选侧也有确定的顺序。
                for i in 0..hunk.removed.len().max(hunk.added.len()) {
                    if scope == CompareScope::Staged {
                        if let Some(line) = hunk.removed.get(i).filter(|_| a.contains(&i)) {
                            rows.push(PatchLine {
                                tag: b'+',
                                bytes: line.clone(),
                            });
                        }
                        if let Some(line) = hunk.added.get(i) {
                            rows.push(PatchLine {
                                tag: if b.contains(&i) { b'-' } else { b' ' },
                                bytes: line.clone(),
                            });
                        }
                    } else {
                        if let Some(line) = hunk.removed.get(i) {
                            rows.push(PatchLine {
                                tag: if a.contains(&i) { b'-' } else { b' ' },
                                bytes: line.clone(),
                            });
                        }
                        if let Some(line) = hunk.added.get(i).filter(|_| b.contains(&i)) {
                            rows.push(PatchLine {
                                tag: b'+',
                                bytes: line.clone(),
                            });
                        }
                    }
                }
            } else {
                for line in &target[start..end] {
                    rows.push(PatchLine {
                        tag: b' ',
                        bytes: line.clone(),
                    });
                }
            }
            cursor = end;
        }
        for line in &target[cursor..] {
            rows.push(PatchLine {
                tag: b' ',
                bytes: line.clone(),
            });
        }
        Ok((
            selection_patch(&source.path, &rows).map_err(GitError::CommandFailed)?,
            removed,
            added,
        ))
    }

    pub fn preview_lines(
        &self,
        scope: CompareScope,
        selection: &LineSelectionRequest,
    ) -> Result<LinePreview, GitError> {
        let (patch, removed, added) = self.selected_patch(scope, selection)?;
        // 只读通道预检，既不写 index，也不创建备份或对象。
        let args: Vec<&OsStr> = ["apply", "--cached", "--whitespace=nowarn", "--check"]
            .iter()
            .map(OsStr::new)
            .collect();
        let output = process::run(
            &self.git,
            &self.worktree,
            &args,
            Some(patch.clone()),
            false,
            &CancelHandle::default(),
            &OutputLog::new(&|_| {}),
            &AtomicU32::new(0),
        )?;
        if !output.success {
            return Err(GitError::CommandFailed(format!(
                "选区补丁预检失败：{}",
                output.summary()
            )));
        }
        Ok(LinePreview { digest: hash_bytes(&patch), patch: String::from_utf8_lossy(&patch).into_owned(), removed, added,
            note: "预览为实际 index 写入方向；只选删除行会删除/还原旧行，只选新增行会插入/移除新行，同时选择两侧才构成替换。非 UTF-8 预览可能显示替代字符，写入仍使用原始字节。".into() })
    }

    pub(in crate::git::ops) fn op_lines(
        &self,
        scope: CompareScope,
        selection: &LineSelectionRequest,
        preview_digest: &str,
        ctx: &OpContext,
    ) -> Result<Step, GitError> {
        let (patch, removed, added) = match self.selected_patch(scope, selection) {
            Ok(value) => value,
            Err(GitError::StaleRequest) => {
                return Ok(Step::failed(
                    "行选区的 revision/contentId 或块摘要已过期，已拒绝写入；请刷新并重新预览",
                ))
            }
            Err(error) => return Ok(Step::failed(error.to_string())),
        };
        if hash_bytes(&patch) != preview_digest {
            return Ok(Step::failed("选区与预览补丁不一致，请重新预览"));
        }
        let args = ["apply", "--cached", "--whitespace=nowarn"];
        let checked = self.write_git(
            &["apply", "--cached", "--whitespace=nowarn", "--check"],
            Some(patch.clone()),
            true,
            ctx,
        )?;
        if checked.cancelled {
            return Ok(Step::cancelled("行操作已取消"));
        }
        if !checked.success {
            return Ok(Step::failed(format!(
                "行补丁预检失败，仓库未改动：{}",
                checked.summary()
            )));
        }
        // 预检之后再核对显示端点，外部工作区/HEAD 修改也必须停止。
        let (current, _, _) = match self.selected_patch(scope, selection) {
            Ok(value) => value,
            Err(_) => return Ok(Step::failed("文件在预检之后又被修改，已停止写入；请刷新")),
        };
        if current != patch {
            return Ok(Step::failed("文件在预检之后又被修改，已停止写入"));
        }
        let result = self.write_git(&args, Some(patch), true, ctx)?;
        let mut step = if result.cancelled {
            Step::cancelled("行操作已取消")
        } else if result.success {
            Step::ok(format!(
                "已{}选区（旧行 {removed}、新增行 {added}），工作区保留",
                if scope == CompareScope::Staged {
                    "取消暂存"
                } else {
                    "暂存"
                }
            ))
        } else {
            Step::failed(Self::failure_message(&result, "行操作"))
        };
        step.touched = vec![display(&decode_path_id(&selection.path_id)?)];
        Ok(step)
    }
}
