//! 选中行段按真实 first-parent diff 回溯。替换块没有唯一逐行对应关系，返回扩展范围并明确标记推断。
use super::{
    blame::LineQuery,
    trace::{self, Budget, Failure},
    *,
};
use std::io::Write;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: usize,
    pub end: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryQuery {
    pub source: LineQuery,
    pub identity: Option<trace::Identity>,
    pub end_line: usize,
    pub page_size: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineCursor {
    pub binding: String,
    pub oid: String,
    pub path_id: String,
    pub range: Range,
    pub scanned: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEntry {
    pub oid: Option<String>,
    pub parent: Option<String>,
    pub path: String,
    pub path_id: String,
    pub old_path: String,
    pub old_path_id: String,
    pub new_range: Option<Range>,
    pub old_range: Option<Range>,
    pub status: String,
    pub inferred: bool,
    pub merge: bool,
    pub patch: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryPage {
    pub entries: Vec<LineEntry>,
    pub next: Option<LineCursor>,
    pub reason: String,
    pub note: String,
    pub shallow: bool,
    pub scanned: usize,
    pub elapsed_ms: u128,
    pub output_bytes: usize,
}

#[derive(Debug)]
pub(super) struct Hunk {
    pub old: usize,
    pub old_count: usize,
    pub new: usize,
    pub new_count: usize,
    pub lines: Vec<String>,
}
pub(super) fn hunks(patch: &str) -> Result<Vec<Hunk>, GitError> {
    let mut result: Vec<Hunk> = Vec::new();
    if patch
        .lines()
        .filter(|line| line.starts_with("diff --git "))
        .count()
        > 1
    {
        return Err(GitError::CommandFailed(
            "无法唯一定位历史路径，停止推断".into(),
        ));
    }
    for line in patch.lines() {
        if line.starts_with("@@ ") {
            let fields: Vec<_> = line.split_whitespace().collect();
            let parse = |field: Option<&&str>| -> Result<(usize, usize), GitError> {
                let value = field
                    .and_then(|v| v.get(1..))
                    .ok_or_else(|| GitError::CommandFailed("无法解析历史行段".into()))?;
                let (start, count) = value.split_once(',').unwrap_or((value, "1"));
                Ok((
                    start
                        .parse()
                        .map_err(|_| GitError::CommandFailed("无效行段".into()))?,
                    count
                        .parse()
                        .map_err(|_| GitError::CommandFailed("无效行段".into()))?,
                ))
            };
            let (old, old_count) = parse(fields.get(1))?;
            let (new, new_count) = parse(fields.get(2))?;
            result.push(Hunk {
                old,
                old_count,
                new,
                new_count,
                lines: vec![line.into()],
            });
        } else if let Some(hunk) = result.last_mut() {
            hunk.lines.push(line.into());
        }
    }
    Ok(result)
}
// 非重叠行是精确平移；替换块使用整个旧块，不声称存在唯一的语义行对应。
fn map_range(range: Range, hunks: &[Hunk]) -> (Option<Range>, bool, bool, Vec<String>) {
    let mut mapped = Vec::new();
    let mut changed = false;
    let mut inferred = false;
    let mut excerpt = Vec::new();
    for hunk in hunks {
        let overlap = if hunk.new_count == 0 {
            hunk.new >= range.start && hunk.new < range.end
        } else {
            hunk.new <= range.end && hunk.new + hunk.new_count > range.start
        };
        if overlap {
            changed = true;
            if hunk.old_count > 0 {
                mapped.extend([hunk.old, hunk.old + hunk.old_count - 1]);
                inferred = true;
            }
            for line in hunk.lines.iter().take(80) {
                excerpt.push(line.chars().take(500).collect());
            }
            if hunk.lines.len() > 80 {
                excerpt.push("…片段超过 80 行；请打开完整版本差异".into());
            }
        }
    }
    for line in range.start..=range.end {
        let mut shift = 0isize;
        let mut covered = false;
        for hunk in hunks {
            if hunk.new_count > 0 && line >= hunk.new && line < hunk.new + hunk.new_count {
                covered = true;
                break;
            }
            let boundary = if hunk.new_count == 0 {
                hunk.new + 1
            } else {
                hunk.new + hunk.new_count
            };
            if line >= boundary {
                shift += hunk.old_count as isize - hunk.new_count as isize;
            }
        }
        if !covered {
            let old = line as isize + shift;
            if old > 0 {
                mapped.push(old as usize);
            }
        }
    }
    let old = mapped
        .iter()
        .min()
        .zip(mapped.iter().max())
        .map(|(start, end)| Range {
            start: *start,
            end: *end,
        });
    if excerpt.len() > 160 {
        excerpt.truncate(160);
        excerpt.push("…片段超过 160 行；请打开完整版本差异".into());
    }
    (old, changed, inferred, excerpt)
}
fn validate_range(range: Range) -> Result<(), GitError> {
    if range.start == 0
        || range.end < range.start
        || range.end > MAX_TEXT_LINES
        || range.end - range.start >= 1000
    {
        Err(GitError::CommandFailed(
            "一次追踪 1–1000 行，扩展替换块超过预算时停止".into(),
        ))
    } else {
        Ok(())
    }
}
impl GitAdapter {
    pub fn line_history(
        &self,
        query: &LineHistoryQuery,
        cursor: Option<&LineCursor>,
        stale: &dyn Fn() -> bool,
    ) -> Result<LineHistoryPage, GitError> {
        let path = content::decode_path(&query.source.path_id)?;
        let range = Range {
            start: query.source.line,
            end: query.end_line,
        };
        validate_range(range)?;
        if query.page_size == 0 || query.page_size > 50 {
            return Err(GitError::CommandFailed("行历史每页 1–50 个变化".into()));
        }
        if let Some(oid) = &query.source.revision {
            trace::oid(oid)?;
        }
        let binding = trace::binding(&(&self.repo_id, query));
        let mut budget = Budget::new(stale);
        let shallow = refs::is_shallow(&self.common_dir);
        let mut page = LineHistoryPage { entries: vec![], next: None, reason: "origin".into(), note: "沿第一父节点追踪；合并的其他父节点可在内容搜索中查看。替换块范围为推断，重命名采用 Git -M 相似度检测。".into(), shallow, scanned: 0, elapsed_ms: 0, output_bytes: 0 };
        let initial = LineCursor {
            binding: binding.clone(),
            oid: query.source.revision.clone().unwrap_or_default(),
            path_id: query.source.path_id.clone(),
            range,
            scanned: 0,
        };
        let mut state = cursor.cloned().unwrap_or(initial);
        if state.binding != binding {
            return Err(GitError::StaleRequest);
        }
        validate_range(state.range)?;
        content::decode_path(&state.path_id)?;
        if cursor.is_some() {
            trace::oid(&state.oid)?;
        }
        let work = (|| -> Result<(), Failure> {
            if cursor.is_none() {
                if let Some(contents) = &query.source.contents {
                    trace::verify_identity(query.identity.as_ref(), contents.as_bytes(), true)?;
                    if range.end > contents.lines().count()
                        || contents.replace("\r\n", "").contains('\r')
                    {
                        return Err(GitError::CommandFailed(
                            "选中行段不在快照文本中或换行格式不支持".into(),
                        )
                        .into());
                    }
                    if contents.len() > MAX_TEXT_BYTES || contents.contains('\0') {
                        return Err(GitError::CommandFailed("追踪快照超过文本预算".into()).into());
                    }
                    let mut mapped = None;
                    let mut inferred = false;
                    let mut patch = vec![];
                    if !state.oid.is_empty() {
                        let head = String::from_utf8_lossy(
                            &budget.run(self, &["rev-parse", "--verify", "HEAD^{commit}"])?,
                        )
                        .trim()
                        .to_owned();
                        if head != state.oid {
                            return Err(GitError::StaleRequest.into());
                        }
                        if !budget
                            .run(self, &["ls-tree", "-z", &state.oid, "--", &path])?
                            .is_empty()
                        {
                            let old =
                                budget.run(self, &["show", &format!("{}:{path}", state.oid)])?;
                            if old.contains(&0) || std::str::from_utf8(&old).is_err() {
                                return Err(GitError::CommandFailed(
                                    "父版本不是 UTF-8 文本，无法将快照映射到历史".into(),
                                )
                                .into());
                            }
                            let mut a = tempfile::NamedTempFile::new()
                                .map_err(|e| GitError::Io(e.to_string()))?;
                            let mut b = tempfile::NamedTempFile::new()
                                .map_err(|e| GitError::Io(e.to_string()))?;
                            a.write_all(&old).map_err(|e| GitError::Io(e.to_string()))?;
                            b.write_all(contents.as_bytes())
                                .map_err(|e| GitError::Io(e.to_string()))?;
                            let raw = budget.run_status(
                                self,
                                &[
                                    "diff",
                                    "--no-index",
                                    "--no-ext-diff",
                                    "--no-textconv",
                                    "--no-color",
                                    "--unified=0",
                                    "--",
                                    &a.path().to_string_lossy(),
                                    &b.path().to_string_lossy(),
                                ],
                                true,
                            )?;
                            (mapped, _, inferred, patch) =
                                map_range(range, &hunks(&String::from_utf8_lossy(&raw))?);
                        }
                        let head = String::from_utf8_lossy(
                            &budget.run(self, &["rev-parse", "--verify", "HEAD^{commit}"])?,
                        )
                        .trim()
                        .to_owned();
                        if head != state.oid {
                            return Err(GitError::StaleRequest.into());
                        }
                    }
                    page.entries.push(LineEntry {
                        oid: None,
                        parent: (!state.oid.is_empty()).then(|| state.oid.clone()),
                        path: path.clone(),
                        path_id: state.path_id.clone(),
                        old_path: path.clone(),
                        old_path_id: state.path_id.clone(),
                        new_range: Some(range),
                        old_range: mapped,
                        status: "snapshot".into(),
                        inferred,
                        merge: false,
                        patch,
                    });
                    if let Some(mapped) = mapped {
                        state.range = mapped;
                        validate_range(mapped)?;
                    } else {
                        page.reason = "uncommitted".into();
                        page.note
                            .push_str(" 选中行是未提交引入，无法沿提交历史继续。");
                        return Ok(());
                    }
                } else {
                    trace::oid(&state.oid)?;
                    let present = !budget
                        .run(self, &["ls-tree", "-z", &state.oid, "--", &path])?
                        .is_empty();
                    if present {
                        let raw = budget.run(self, &["show", &format!("{}:{path}", state.oid)])?;
                        trace::verify_identity(query.identity.as_ref(), &raw, false)?;
                        let text = std::str::from_utf8(&raw).map_err(|_| {
                            GitError::CommandFailed("历史行追踪仅支持 UTF-8 文本".into())
                        })?;
                        if text.contains('\0') || range.end > text.lines().count() {
                            return Err(
                                GitError::CommandFailed("选中行不在版本文本中".into()).into()
                            );
                        }
                    } else {
                        let parents = trace::parents(self, &state.oid, &mut budget)?;
                        let parent = parents.first().map(String::as_str);
                        let file = trace::changes(self, &state.oid, parent, &mut budget)?
                            .into_iter()
                            .find(|f| {
                                f.path_id == state.path_id && f.status == log::ChangeStatus::Deleted
                            });
                        let Some(file) = file else {
                            page.reason = "untraceable".into();
                            page.note
                                .push_str(" 此版本路径不存在且并非本次删除，无法继续。");
                            return Ok(());
                        };
                        let Some(parent) = parent else {
                            return Err(GitError::CommandFailed("删除提交缺少父节点".into()).into());
                        };
                        let old = budget.run(self, &["show", &format!("{parent}:{path}")])?;
                        let text = std::str::from_utf8(&old).map_err(|_| {
                            GitError::CommandFailed("删除前版本不是 UTF-8 文本".into())
                        })?;
                        if text.contains('\0') || range.end > text.lines().count() {
                            return Err(GitError::CommandFailed("删除前行段不存在".into()).into());
                        }
                        page.entries.push(LineEntry {
                            oid: Some(state.oid.clone()),
                            parent: Some(parent.into()),
                            path: path.clone(),
                            path_id: file.path_id.clone(),
                            old_path: path.clone(),
                            old_path_id: file.path_id,
                            new_range: None,
                            old_range: Some(range),
                            status: "deleted".into(),
                            inferred: false,
                            merge: parents.len() > 1,
                            patch: vec!["文件已删除；行段来自父版本".into()],
                        });
                        state.oid = parent.into();
                    }
                }
            }
            while page.entries.len() < query.page_size && page.scanned < 100 && state.scanned < 2000
            {
                budget.check()?;
                validate_range(state.range)?;
                let path = content::decode_path(&state.path_id)?;
                let parents = trace::parents(self, &state.oid, &mut budget)?;
                let parent = parents.first().map(String::as_str);
                if shallow
                    && parent.is_some()
                    && fs::read_to_string(self.common_dir.join("shallow"))
                        .unwrap_or_default()
                        .lines()
                        .any(|o| o == state.oid)
                {
                    page.reason = "shallow".into();
                    page.note
                        .push_str(" 到达浅克隆边界，未将边界提交当作代码起源。");
                    return Ok(());
                }
                let files = trace::changes(self, &state.oid, parent, &mut budget)?;
                let file = files.into_iter().find(|f| f.path_id == state.path_id);
                let mut old_range = Some(state.range);
                let mut old_path_id = state.path_id.clone();
                if let Some(file) = file {
                    if file.submodule.is_some() {
                        page.reason = "untraceable".into();
                        page.note.push_str(" 子模块指针不支持行追踪。");
                        return Ok(());
                    }
                    let patch = trace::patch(self, &state.oid, parent, &file, &mut budget)?;
                    if patch.contains("Binary files ") || patch.contains("GIT binary patch") {
                        page.reason = "untraceable".into();
                        page.note.push_str(" 遇到二进制历史版本，停止追踪。");
                        return Ok(());
                    }
                    let (mapped, changed, inferred, excerpt) =
                        map_range(state.range, &hunks(&patch)?);
                    old_range = mapped;
                    old_path_id = file
                        .old_path_id
                        .clone()
                        .unwrap_or_else(|| file.path_id.clone());
                    if changed || file.status == log::ChangeStatus::Renamed {
                        page.entries.push(LineEntry {
                            oid: Some(state.oid.clone()),
                            parent: parent.map(str::to_owned),
                            path: path.clone(),
                            path_id: state.path_id.clone(),
                            old_path: content::decode_path(&old_path_id)?,
                            old_path_id: old_path_id.clone(),
                            new_range: Some(state.range),
                            old_range,
                            status: if file.status == log::ChangeStatus::Renamed {
                                "renamed"
                            } else if file.status == log::ChangeStatus::Added {
                                "added"
                            } else {
                                "modified"
                            }
                            .into(),
                            inferred,
                            merge: parents.len() > 1,
                            patch: excerpt,
                        });
                    }
                }
                page.scanned += 1;
                state.scanned += 1;
                let (Some(parent), Some(mapped)) = (parent, old_range) else {
                    return Ok(());
                };
                state.oid = parent.into();
                state.range = mapped;
                state.path_id = old_path_id;
            }
            if state.scanned >= 2000 {
                page.reason = "limit".into();
                page.note
                    .push_str(" 达到累计 2000 提交上限，请从更早版本重新追踪。");
            } else {
                page.reason = "page".into();
                page.next = Some(state.clone());
            }
            Ok(())
        })();
        match work {
            Ok(()) => (),
            Err(Failure::Cancelled) => return Err(GitError::StaleRequest),
            Err(Failure::Git(GitError::StaleRequest)) => return Err(GitError::StaleRequest),
            Err(Failure::Budget) => {
                page.reason = "budget".into();
                page.note.push_str(
                    " 达到 10 秒 / 8 MiB 输出预算，结果不完整；缩小行段或从更早版本重试。",
                );
            }
            Err(Failure::Git(e)) => {
                page.reason = "untraceable".into();
                page.note
                    .push_str(&format!(" 无法继续（缺对象、路径或格式）：{e}"));
            }
        }
        if stale() {
            return Err(GitError::StaleRequest);
        }
        page.elapsed_ms = budget.elapsed_ms();
        page.output_bytes = budget.bytes();
        Ok(page)
    }
}
