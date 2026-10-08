//! 在固定引用 tip 的可达提交中搜索实际新增/删除行，绝不使用提交标题匹配代替内容。
use super::{
    line_history::{hunks, Range},
    trace::{self, Budget, Failure},
    *,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Added,
    Deleted,
    Both,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub refs: Vec<String>,
    pub path_id: Option<String>,
    pub text: String,
    pub direction: Direction,
    pub page_size: usize,
    pub scan_budget: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCursor {
    pub binding: String,
    pub tips: Vec<String>,
    pub skip: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub direction: Direction,
    pub line: usize,
    pub text: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntry {
    pub oid: String,
    pub parent: Option<String>,
    pub path: String,
    pub path_id: String,
    pub old_path: String,
    pub old_path_id: String,
    pub status: log::ChangeStatus,
    pub new_range: Option<Range>,
    pub old_range: Option<Range>,
    pub hits: Vec<Hit>,
    pub match_count: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub entries: Vec<SearchEntry>,
    pub next: Option<SearchCursor>,
    pub tips: Vec<String>,
    pub reason: String,
    pub note: String,
    pub shallow: bool,
    pub scanned: usize,
    pub elapsed_ms: u128,
    pub output_bytes: usize,
}
fn range(lines: &[usize]) -> Option<Range> {
    lines
        .iter()
        .min()
        .zip(lines.iter().max())
        .map(|(start, end)| Range {
            start: *start,
            end: *end,
        })
}
impl GitAdapter {
    pub fn search_history(
        &self,
        query: &SearchQuery,
        cursor: Option<&SearchCursor>,
        stale: &dyn Fn() -> bool,
    ) -> Result<SearchPage, GitError> {
        if query.refs.is_empty() || query.refs.len() > 8 {
            return Err(GitError::CommandFailed("内容搜索需指定 1–8 个引用".into()));
        }
        for reference in &query.refs {
            history::validate_reference(reference)?;
        }
        if let Some(path) = &query.path_id {
            content::decode_path(path)?;
        }
        if query.text.is_empty()
            || query.text.len() > 1024
            || query.text.contains(['\0', '\n', '\r'])
        {
            return Err(GitError::CommandFailed(
                "内容搜索需 1–1024 字节的单行字面文本".into(),
            ));
        }
        if query.page_size == 0
            || query.page_size > 50
            || query.scan_budget == 0
            || query.scan_budget > 100
        {
            return Err(GitError::CommandFailed(
                "每页 1–50 个匹配文件，扫描预算 1–100 提交".into(),
            ));
        }
        let binding = trace::binding(&(&self.repo_id, query));
        let mut budget = Budget::new(stale);
        let mut state = cursor.cloned().unwrap_or(SearchCursor {
            binding: binding.clone(),
            tips: vec![],
            skip: 0,
        });
        if state.binding != binding {
            return Err(GitError::StaleRequest);
        }
        if state.skip > 10000
            || (cursor.is_some() && (state.tips.is_empty() || state.tips.len() > 8))
        {
            return Err(GitError::CommandFailed("内容搜索游标超出预算".into()));
        }
        for tip in &state.tips {
            trace::oid(tip)?;
        }
        let shallow = refs::is_shallow(&self.common_dir);
        let mut page = SearchPage { entries: vec![], next: None, tips: vec![], reason: "complete".into(), note: "区分大小写的字面行内容搜索；检查各父节点的增删 patch（合并可能重复）；重命名采用 Git -M 检测；二进制与非 UTF-8 patch 不提供文本匹配。".into(), shallow, scanned: 0, elapsed_ms: 0, output_bytes: 0 };
        if shallow {
            page.note
                .push_str(" 浅克隆仅搜索本地已有历史；边界提交不当作引入证据。");
        }
        let work = (|| -> Result<(), Failure> {
            if cursor.is_none() {
                for reference in &query.refs {
                    let raw = budget.run(
                        self,
                        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
                    )?;
                    let tip = String::from_utf8_lossy(&raw).trim().to_owned();
                    trace::oid(&tip)?;
                    if !state.tips.contains(&tip) {
                        state.tips.push(tip);
                    }
                }
            }
            page.tips = state.tips.clone();
            let count = format!("--max-count={}", query.scan_budget + 1);
            let skip = format!("--skip={}", state.skip);
            let mut args = vec!["rev-list", "--topo-order", &count, &skip];
            args.extend(state.tips.iter().map(String::as_str));
            args.push("--");
            let raw = budget.run(self, &args)?;
            let commits: Vec<_> = String::from_utf8_lossy(&raw)
                .lines()
                .map(str::to_owned)
                .collect();
            for (index, oid) in commits.iter().take(query.scan_budget).enumerate() {
                if state.skip >= 10000 {
                    page.reason = "limit".into();
                    page.note
                        .push_str(" 达到累计 10000 提交上限；请缩小引用范围。");
                    return Ok(());
                }
                budget.check()?;
                trace::oid(oid)?;
                let parents = trace::parents(self, oid, &mut budget)?;
                if shallow
                    && fs::read_to_string(self.common_dir.join("shallow"))
                        .unwrap_or_default()
                        .lines()
                        .any(|value| value == oid)
                {
                    state.skip += 1;
                    page.scanned += 1;
                    continue;
                }
                let comparisons: Vec<Option<&str>> = if parents.is_empty() {
                    vec![None]
                } else {
                    parents.iter().map(|p| Some(p.as_str())).collect()
                };
                for parent in comparisons {
                    let files = trace::changes(self, oid, parent, &mut budget)?;
                    for file in files {
                        if let Some(path) = &query.path_id {
                            if &file.path_id != path && file.old_path_id.as_ref() != Some(path) {
                                continue;
                            }
                        }
                        if file.submodule.is_some() {
                            continue;
                        }
                        let patch = match trace::patch(self, oid, parent, &file, &mut budget) {
                            Err(Failure::Git(GitError::CommandFailed(message)))
                                if message == "历史内容不是 UTF-8 文本，无法继续追溯" =>
                            {
                                continue
                            }
                            result => result?,
                        };
                        let mut hits = Vec::new();
                        let mut count = 0;
                        let mut added = Vec::new();
                        let mut deleted = Vec::new();
                        for hunk in hunks(&patch)? {
                            let mut old = hunk.old;
                            let mut new = hunk.new;
                            for line in hunk.lines.iter().skip(1) {
                                let hit = if let Some(text) = line.strip_prefix('+') {
                                    let hit = (query.direction != Direction::Deleted
                                        && text.contains(&query.text))
                                    .then_some((Direction::Added, new, text));
                                    new += 1;
                                    hit
                                } else if let Some(text) = line.strip_prefix('-') {
                                    let hit = (query.direction != Direction::Added
                                        && text.contains(&query.text))
                                    .then_some((Direction::Deleted, old, text));
                                    old += 1;
                                    hit
                                } else {
                                    if line.starts_with(' ') {
                                        old += 1;
                                        new += 1;
                                    }
                                    None
                                };
                                if let Some((direction, number, text)) = hit {
                                    count += 1;
                                    if direction == Direction::Added {
                                        added.push(number);
                                    } else {
                                        deleted.push(number);
                                    }
                                    if hits.len() < 20 {
                                        hits.push(Hit {
                                            direction,
                                            line: number,
                                            text: text.chars().take(500).collect(),
                                        });
                                    }
                                }
                            }
                        }
                        if count > 0 {
                            let old_path_id = file
                                .old_path_id
                                .clone()
                                .unwrap_or_else(|| file.path_id.clone());
                            page.entries.push(SearchEntry {
                                oid: oid.clone(),
                                parent: parent.map(str::to_owned),
                                path: content::decode_path(&file.path_id)?,
                                path_id: file.path_id,
                                old_path: content::decode_path(&old_path_id)?,
                                old_path_id,
                                status: file.status,
                                new_range: range(&added),
                                old_range: range(&deleted),
                                hits,
                                match_count: count,
                            });
                            if page.entries.len() >= 200 {
                                page.reason = "budget".into();
                                page.note.push_str(" 本页达到 200 匹配文件硬上限，结果不完整；缩小路径或查询文本。");
                                return Ok(());
                            }
                        }
                    }
                }
                state.skip += 1;
                page.scanned += 1;
                if page.entries.len() >= query.page_size {
                    if index + 1 < commits.len() {
                        page.next = Some(state.clone());
                        page.reason = "page".into();
                    }
                    return Ok(());
                }
            }
            if commits.len() > query.scan_budget {
                page.next = Some(state.clone());
                page.reason = "scanBudget".into();
                page.note
                    .push_str(" 本页扫描预算耗尽；可继续下一页，零匹配不代表全历史无结果。");
            }
            Ok(())
        })();
        match work {
            Ok(()) => (),
            Err(Failure::Cancelled) => return Err(GitError::StaleRequest),
            Err(Failure::Budget) => {
                page.reason = "budget".into();
                page.note
                    .push_str(" 达到 10 秒 / 8 MiB 输出预算，结果不完整；缩小范围重试。");
            }
            Err(Failure::Git(GitError::StaleRequest)) => return Err(GitError::StaleRequest),
            Err(Failure::Git(e)) => {
                page.reason = "untraceable".into();
                page.note.push_str(&format!(" 缺对象或无法继续：{e}"));
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
