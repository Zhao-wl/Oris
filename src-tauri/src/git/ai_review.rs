//! #26：预算内的只读审查快照，复用现有比较、ContentReader 和身份守卫。
use super::log::ChangedFile;
use super::*;
use std::collections::HashSet;

pub const BUDGET: usize = 40_000;
const MAX_FILES: usize = 16;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReviewRange {
    Workspace,
    Unstaged,
    Staged,
    Commit { commit: String },
    Branch { left: String, right: String },
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path_id: String,
    pub path: String,
    pub old_path_id: Option<String>,
    pub old_path: Option<String>,
    pub status: String,
}
impl From<ChangedFile> for ReviewFile {
    fn from(f: ChangedFile) -> Self {
        Self {
            path_id: f.path_id,
            path: f.path,
            old_path_id: f.old_path_id,
            old_path: f.old_path,
            status: serde_json::to_value(f.status)
                .unwrap()
                .as_str()
                .unwrap()
                .into(),
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub repo_id: String,
    pub range: ReviewRange,
    pub revision: String,
    pub identity: String,
    pub left: Option<String>,
    pub right: String,
    pub files: Vec<ReviewFile>,
    pub total_files: usize,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub range: ReviewRange,
    pub identity: String,
    pub path_ids: Vec<String>,
    #[serde(default)]
    pub context_paths: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct SourceLine {
    pub line: usize,
    pub text: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSource {
    pub id: String,
    pub file: ReviewFile,
    pub side: String,
    pub endpoint: String,
    pub content_id: String,
    pub lines: Vec<SourceLine>,
    pub truncated: bool,
    pub supplemental: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewContext {
    pub next_offset: Option<usize>,
    pub inventory: Inventory,
    pub sources: Vec<ReviewSource>,
    pub diff: String,
    pub budget: usize,
    pub used: usize,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

impl GitAdapter {
    pub fn review_inventory(&self, range: ReviewRange) -> Result<Inventory, GitError> {
        let state = self.scan(false)?;
        let (left, right, files): (_, _, Vec<ReviewFile>) = match &range {
            ReviewRange::Workspace | ReviewRange::Staged | ReviewRange::Unstaged => {
                let staged = matches!(range, ReviewRange::Staged);
                let files = if staged {
                    state.lists.staged.clone()
                } else if matches!(range, ReviewRange::Unstaged) {
                    state.lists.unstaged.clone()
                } else {
                    self.details_for(&state)?.all.clone()
                };
                let files = files
                    .into_iter()
                    .map(|f| ReviewFile {
                        path_id: f.path_id,
                        path: f.display_path,
                        old_path_id: f.old_path_id,
                        old_path: f.old_display_path,
                        status: serde_json::to_value(f.status)
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .into(),
                    })
                    .collect();
                let head = state.branch.oid.clone();
                (
                    if matches!(range, ReviewRange::Unstaged) { Some("index".into()) } else { head },
                    if staged { "index" } else { "workingTree" }.into(),
                    files,
                )
            }
            ReviewRange::Commit { commit } => {
                let changes = self.history_commit(commit, None)?;
                (
                    changes.parent,
                    changes.oid,
                    changes.files.into_iter().map(Into::into).collect(),
                )
            }
            ReviewRange::Branch { left, right } => {
                let changes = self.history_compare(left, right)?;
                (
                    Some(changes.left),
                    changes.right,
                    changes.files.into_iter().map(Into::into).collect(),
                )
            }
        };
        let total_files = files.len();
        let identity = hash_bytes(
            &serde_json::to_vec(&(&range, &state.revision, &left, &right, &files)).unwrap(),
        );
        Ok(Inventory {
            repo_id: self.repo_id.clone(),
            range,
            revision: state.revision.clone(),
            identity,
            left,
            right,
            files,
            total_files,
        })
    }

    fn review_pair(
        &self,
        inv: &Inventory,
        file: &ReviewFile,
        supplemental: bool,
    ) -> Result<ContentPair, GitError> {
        match inv.range {
            ReviewRange::Workspace | ReviewRange::Staged | ReviewRange::Unstaged if !supplemental => self
                .read_content_pair_cancellable(
                    "review".into(),
                    if matches!(inv.range, ReviewRange::Staged) {
                        CompareScope::Staged
                    } else if matches!(inv.range, ReviewRange::Unstaged) {
                        CompareScope::Unstaged
                    } else {
                        CompareScope::All
                    },
                    inv.revision.clone(),
                    file.path_id.clone(),
                    None,
                    || false,
                ),
            ReviewRange::Workspace | ReviewRange::Staged | ReviewRange::Unstaged => {
                // 显式补充文件只读，不调用过滤器或跟随符号链接。
                let relative = content::decode_path(&file.path_id)?;
                let mut budget = media::ImageBudget::default();
                let left = if let Some(head) = &inv.left {
                    self.read_revision_pair(
                        "review".into(),
                        Some(head),
                        head,
                        &file.path_id,
                        None,
                        || false,
                    )?
                    .left
                } else {
                    self.read_side_with("emptyTree", &relative, true, &mut budget, |_| Ok(None))
                };
                let right = if matches!(inv.range, ReviewRange::Staged) {
                    let output = run_required(
                        &self.git,
                        &self.worktree,
                        &["ls-files", "--stage", "-z", "--", &relative],
                    )?;
                    let header = std::str::from_utf8(&output.stdout)
                        .map_err(|_| GitError::UnsupportedPathEncoding)?
                        .split('\0')
                        .next()
                        .unwrap_or("")
                        .split('\t')
                        .next()
                        .unwrap_or("");
                    let parts: Vec<_> = header.split_whitespace().collect();
                    if parts.len() != 3 || parts[2] != "0" {
                        return Err(GitError::Io(format!(
                            "暂存区文件缺失或存在冲突：{relative}"
                        )));
                    }
                    // 按 index OID 使用既有有界 BlobReader，不用 git show 收集无界 stdout。
                    self.read_side_with("index", &relative, false, &mut budget, |side| {
                        self.object_bytes(side, parts[1], parts[0])
                    })
                } else {
                    self.read_side_with("workingTree", &relative, false, &mut budget, |_| {
                        self.read_worktree(&relative, MAX_TEXT_BYTES).map(Some)
                    })
                };
                Ok(ContentPair {
                    request_id: "review".into(),
                    repo_id: self.repo_id.clone(),
                    revision: inv.revision.clone(),
                    path_id: file.path_id.clone(),
                    display_path: relative,
                    left,
                    right,
                    stale: false,
                    degradation: None,
                })
            }
            _ => self.read_revision_pair(
                "review".into(),
                inv.left.as_deref(),
                &inv.right,
                &file.path_id,
                file.old_path_id.as_deref(),
                || false,
            ),
        }
    }

    pub fn review_location(
        &self,
        request: ReviewRequest,
        path_id: String,
    ) -> Result<ContentPair, GitError> {
        let inv = self.review_inventory(request.range.clone())?;
        if inv.identity != request.identity {
            return Err(GitError::StaleRequest);
        }
        let pair = if request.path_ids.contains(&path_id) {
            let file = inv
                .files
                .iter()
                .find(|f| f.path_id == path_id)
                .ok_or(GitError::UnsafePath)?;
            self.review_pair(&inv, file, false)?
        } else {
            let path = content::decode_path(&path_id)?;
            if path.len() > 4096
                || !request.context_paths.contains(&path)
                || Path::new(&path)
                    .components()
                    .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
            {
                return Err(GitError::UnsafePath);
            }
            let file = ReviewFile {
                path_id,
                path,
                old_path_id: None,
                old_path: None,
                status: "modified".into(),
            };
            self.review_pair(&inv, &file, true)?
        };
        if self.review_inventory(request.range)?.identity != inv.identity {
            return Err(GitError::StaleRequest);
        }
        Ok(pair)
    }

    pub fn review_context(&self, request: ReviewRequest) -> Result<ReviewContext, GitError> {
        self.review_context_at(request, None, None)
    }
    pub fn review_context_page(&self, request: ReviewRequest, offset: usize) -> Result<ReviewContext, GitError> {
        self.review_context_at(request, Some(offset), None)
    }
    pub fn review_snapshot(&self, request: ReviewRequest, max_bytes: usize) -> Result<ReviewContext, GitError> {
        let mut result = self.review_context_at(request, Some(0), Some(max_bytes.clamp(1000, 96_000)))?;
        if result.next_offset.is_some() {
            result.truncated = true;
            result.warnings.push("本文件超过快照原文预算，后续原文未采集".into());
        }
        result.next_offset = None;
        Ok(result)
    }
    fn review_context_at(&self, request: ReviewRequest, offset: Option<usize>, snapshot_budget: Option<usize>) -> Result<ReviewContext, GitError> {
        if request.path_ids.is_empty()
            || request.path_ids.len() + request.context_paths.len() > MAX_FILES
        {
            return Err(GitError::Io(format!(
                "请选择变化文件；每轮含补充文件最多 {MAX_FILES} 个"
            )));
        }
        let inv = self.review_inventory(request.range.clone())?;
        if snapshot_budget.is_none() && inv.identity != request.identity {
            return Err(GitError::StaleRequest);
        }
        let mut picked = Vec::new();
        let mut seen = HashSet::new();
        for id in &request.path_ids {
            if !seen.insert(id.clone()) {
                return Err(GitError::UnsafePath);
            }
            let file = inv
                .files
                .iter()
                .find(|f| &f.path_id == id)
                .ok_or(GitError::UnsafePath)?;
            picked.push((file.clone(), false));
        }
        for path in &request.context_paths {
            if path.len() > 4096 {
                return Err(GitError::UnsafePath);
            }
            validate_relative(path)?;
            // .git 及任意内部仓库元数据永不进入审查上下文。
            if Path::new(path)
                .components()
                .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
            {
                return Err(GitError::UnsafePath);
            }
            let id = URL_SAFE_NO_PAD.encode(path.as_bytes());
            if seen.insert(id.clone()) {
                picked.push((
                    ReviewFile {
                        path_id: id,
                        path: path.clone(),
                        old_path: None,
                        old_path_id: None,
                        status: "modified".into(),
                    },
                    true,
                ));
            }
        }
        let mut provided = inv.clone();
        provided
            .files
            .retain(|f| request.path_ids.contains(&f.path_id));
        let mut position = 0usize;
        let mut result = ReviewContext {
            next_offset: None,
            inventory: provided,
            sources: vec![],
            diff: String::new(),
            budget: snapshot_budget.unwrap_or(BUDGET),
            used: 0,
            truncated: false,
            warnings: vec![],
        };
        for (file, supplemental) in picked {
            if file.status == "conflicted" || file.status == "unmerged" {
                result
                    .warnings
                    .push(format!("{}：冲突未解决，本轮跳过", file.path));
                continue;
            }
            let pair = match if snapshot_budget.is_some() && !supplemental && matches!(inv.range, ReviewRange::Workspace | ReviewRange::Staged | ReviewRange::Unstaged) {
                self.read_content_pair_snapshot(if matches!(inv.range, ReviewRange::Staged) { CompareScope::Staged } else if matches!(inv.range, ReviewRange::Unstaged) { CompareScope::Unstaged } else { CompareScope::All }, inv.revision.clone(), file.path_id.clone())
            } else { self.review_pair(&inv, &file, supplemental) } {
                Ok(pair) => pair,
                Err(GitError::StaleRequest) => return Err(GitError::StaleRequest),
                Err(e) => {
                    result.warnings.push(format!("{}：{e}", file.path));
                    continue;
                }
            };
            let incomplete = (pair.left.text.is_none() && pair.left.kind != "missing") || (pair.right.text.is_none() && pair.right.kind != "missing");
            result.truncated |= incomplete;
            let patch = if supplemental || incomplete {
                String::new()
            } else {
                if snapshot_budget.is_some() { self.snapshot_patch(&pair)? } else { self.review_patch(&inv, &file, &pair)? }
            };
            // 差异最多占用一半预算，剩余用于可核验的原文及补充上下文。
            let remaining = (BUDGET / 2).saturating_sub(result.diff.len());
            let snippet = if offset.is_some() { "" } else { utf8_prefix(&patch, remaining.min(5000)) };
            if offset.is_none() { result.truncated |= snippet.len() < patch.len(); }
            result.diff.push_str(snippet);
            result.used += snippet.len();
            for (side, data, endpoint) in [
                (
                    "left",
                    &pair.left,
                    inv.left.as_deref().unwrap_or("emptyTree"),
                ),
                ("right", &pair.right, inv.right.as_str()),
            ] {
                let Some(text) = &data.text else {
                    if data.kind != "missing" {
                        result
                            .warnings
                            .push(format!("{} {side}：{}，未读取文本", file.path, data.kind));
                    }
                    continue;
                };
                let ranges = if supplemental || incomplete {
                    vec![(1, usize::MAX)]
                } else {
                    hunk_ranges(&patch, side)
                };
                let mut lines = vec![];
                let mut bytes = 0;
                let limit = if offset.is_some() { snapshot_budget.unwrap_or(6000).saturating_sub(result.used) } else { (BUDGET - result.used).min(5000) };
                let mut truncated = false;
                for (index, line) in text.split('\n').enumerate() {
                    if !ranges
                        .iter()
                        .any(|(start, end)| index + 1 >= *start && index + 1 <= *end)
                    {
                        continue;
                    }
                    // 分页游标按所有差异上下文原文行计数；绝不拆断一行。
                    let current_position = position;
                    position += 1;
                    if offset.is_some_and(|start| current_position < start) { continue; }
                    let size = line.len() + 16;
                    if offset.is_some() && size > snapshot_budget.unwrap_or(6000) {
                        result.truncated = true;
                        result.warnings.push(format!("{} {side}:{} 超长原文行未读取", file.path, index + 1));
                        continue;
                    }
                    if offset.is_some() && result.next_offset.is_some() { continue; }
                    if bytes + size > limit {
                        if offset.is_some() { result.next_offset = Some(current_position); continue; }
                        truncated = true;
                        break;
                    }
                    bytes += size;
                    lines.push(SourceLine {
                        line: index + 1,
                        text: line.into(),
                    });
                }
                result.used += bytes;
                result.truncated |= truncated;
                result.sources.push(ReviewSource {
                    id: hash_bytes(
                        format!("{}:{side}:{}", file.path_id, data.content_id).as_bytes(),
                    ),
                    file: file.clone(),
                    side: side.into(),
                    endpoint: endpoint.into(),
                    content_id: data.content_id.clone(),
                    lines,
                    truncated,
                    supplemental,
                });
            }
        }
        if snapshot_budget.is_none() {
        // 最后再读快照并核对显式补充文件，捕获生成上下文期间的变化。
        if self.review_inventory(request.range)?.identity != inv.identity {
            return Err(GitError::StaleRequest);
        }
        for source in &result.sources {
            let pair = self.review_pair(&inv, &source.file, source.supplemental)?;
            let side = if source.side == "left" {
                pair.left
            } else {
                pair.right
            };
            if side.content_id != source.content_id {
                return Err(GitError::StaleRequest);
            }
        }
        }
        if offset.is_none() && result.sources.iter().all(|s| s.lines.is_empty()) {
            return Err(GitError::Io(
                "所选文件没有预算内可读取的文本，请检查文件类型或缩小范围".into(),
            ));
        }
        Ok(result)
    }

    /// Diff only captured bytes; Git never consults the live index/worktree here.
    fn snapshot_patch(&self, pair: &ContentPair) -> Result<String, GitError> {
        let dir = tempfile::tempdir().map_err(|e| GitError::Io(e.to_string()))?;
        fs::write(dir.path().join("left"), pair.left.text.as_deref().unwrap_or("")).map_err(|e| GitError::Io(e.to_string()))?;
        fs::write(dir.path().join("right"), pair.right.text.as_deref().unwrap_or("")).map_err(|e| GitError::Io(e.to_string()))?;
        let out = run_readonly(&self.git, dir.path(), &["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", "left", "right"])?;
        if !matches!(out.status.code(), Some(0 | 1)) { return Err(GitError::CommandFailed(String::from_utf8_lossy(&out.stderr).into_owned())); }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn review_patch(
        &self,
        inv: &Inventory,
        file: &ReviewFile,
        pair: &ContentPair,
    ) -> Result<String, GitError> {
        if file.status == "untracked"
            || inv.left.is_none() && matches!(inv.range, ReviewRange::Workspace)
        {
            let old = pair.left.text.as_deref().unwrap_or("");
            let new = pair.right.text.as_deref().unwrap_or("");
            return Ok(format!(
                "\n--- {}\n+++ {}\n@@ -1,{} +1,{} @@\n{}{}",
                file.path,
                file.path,
                old.lines().count(),
                new.lines().count(),
                old.lines().map(|l| format!("-{l}\n")).collect::<String>(),
                new.lines().map(|l| format!("+{l}\n")).collect::<String>()
            ));
        }
        let mut args = vec![
            "diff".to_owned(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--no-color".into(),
            "--unified=3".into(),
        ];
        match &inv.range {
            ReviewRange::Staged => args.push("--cached".into()),
            ReviewRange::Unstaged => {},
            ReviewRange::Workspace => args.push(inv.left.clone().unwrap()),
            _ => {
                if let Some(left) = &inv.left {
                    args.push(left.clone());
                    args.push(inv.right.clone());
                } else {
                    args = vec![
                        "show".into(),
                        "--format=".into(),
                        "--root".into(),
                        "--no-ext-diff".into(),
                        "--no-textconv".into(),
                        "--no-color".into(),
                        "--unified=3".into(),
                        inv.right.clone(),
                    ];
                }
            }
        }
        args.push("--".into());
        // run_required 已设置 GIT_LITERAL_PATHSPECS=1，直接传原路径。
        args.push(file.path.clone());
        if let Some(old) = &file.old_path {
            args.push(old.clone());
        }
        let out = run_required(
            &self.git,
            &self.worktree,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        )?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}
fn utf8_prefix(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
fn hunk_ranges(patch: &str, side: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for line in patch.lines().filter(|l| l.starts_with("@@ ")) {
        let token = line
            .split_whitespace()
            .nth(if side == "left" { 1 } else { 2 })
            .unwrap_or("");
        let mut parts = token.get(1..).unwrap_or("").split(',');
        if let Ok(start) = parts.next().unwrap_or("").parse::<usize>() {
            let count = parts.next().unwrap_or("1").parse::<usize>().unwrap_or(0);
            if count > 0 {
                ranges.push((start.max(1), start.saturating_add(count).saturating_sub(1)));
            }
        }
    }
    ranges
}

#[cfg(test)]
mod tests;
