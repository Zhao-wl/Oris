//! 行归属只读查询。历史端固定 OID；本地端只使用阅读器快照，不读取或改写工作区 / index。
use super::content::decode_path;
use super::log::{self, CommitInfo, LogQuery, SearchQuery};
use super::*;
use std::io::Write;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineQuery {
    pub path_id: String,
    pub revision: Option<String>,
    /// None 为提交中的原文；Some 为暂存区 / 工作区的当前阅读快照。
    pub contents: Option<String>,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineAttribution {
    pub commit: Option<CommitInfo>,
    pub original_line: usize,
    pub path: String,
    pub path_id: String,
    pub shallow: bool,
}

impl GitAdapter {
    pub fn line_attribution(&self, query: &LineQuery, stale: &dyn Fn() -> bool) -> Result<LineAttribution, GitError> {
        let path = decode_path(&query.path_id)?;
        if query.line == 0 || query.line > MAX_TEXT_LINES {
            return Err(GitError::CommandFailed("行号超出可查询范围".into()));
        }
        let uncommitted = || LineAttribution { commit: None, original_line: query.line, path: path.clone(), path_id: query.path_id.clone(), shallow: false };
        let Some(revision) = &query.revision else {
            if query.contents.is_some() { return Ok(uncommitted()); }
            return Err(GitError::CommandFailed("行归属缺少提交版本".into()));
        };
        // 只接受固定的提交 OID，不能用随时移动的 ref 冒充阅读快照。
        if !((revision.len() == 40 || revision.len() == 64) && revision.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err(GitError::CommandFailed("行归属需要完整提交 OID".into()));
        }
        let mut temporary = None;
        let range = format!("{},{}", query.line, query.line);
        let mut args = vec!["-c", "blame.ignoreRevsFile=", "-c", "blame.showRoot=true", "blame", "--line-porcelain", "--root", "--no-textconv", "-L", &range];
        if let Some(contents) = &query.contents {
            if contents.len() > MAX_TEXT_BYTES || contents.contains('\0') {
                return Err(GitError::CommandFailed("行归属快照不是受支持的文本".into()));
            }
            // --contents 的最终版本只能是 HEAD。前后核验 HEAD，避免返回其他版本的归属。
            if log::resolve_commit(&self.git, &self.worktree, "HEAD")? != *revision { return Err(GitError::StaleRequest); }
            if self.tree_entry(revision, &path)?.is_none() { return Ok(uncommitted()); }
            let mut file = tempfile::NamedTempFile::new().map_err(|e| GitError::Io(e.to_string()))?;
            file.write_all(contents.as_bytes()).map_err(|e| GitError::Io(e.to_string()))?;
            temporary = Some(file);
        } else {
            args.push(revision);
        }
        let temporary_path = temporary.as_ref().map(|f| f.path().to_string_lossy().into_owned());
        if let Some(name) = &temporary_path { args.extend(["--contents", name]); }
        args.extend(["--", &path]);
        if stale() { return Err(GitError::StaleRequest); }
        let output = run_required(&self.git, &self.worktree, &args)?;
        if query.contents.is_some() && log::resolve_commit(&self.git, &self.worktree, "HEAD")? != *revision { return Err(GitError::StaleRequest); }
        if stale() { return Err(GitError::StaleRequest); }
        let (oid, original_line, original_path) = parse_porcelain(&output.stdout)?;
        if oid.bytes().all(|b| b == b'0') { return Ok(uncommitted()); }
        let page = log::read_log(&self.git, &self.worktree, &LogQuery { refs: vec![], search: Some(SearchQuery::Sha(oid)), page_size: 1 }, None)?;
        let commit = page.commits.into_iter().next().ok_or_else(|| GitError::CommandFailed("找不到该行的提交记录".into()))?;
        let path_id = URL_SAFE_NO_PAD.encode(original_path.as_bytes());
        Ok(LineAttribution { commit: Some(commit), original_line, path: original_path, path_id, shallow: refs::is_shallow(&self.common_dir) })
    }

    /// 悬浮层中的片段来自归属提交相对第一个父节点的真实 patch；根提交相对空树。
    pub fn line_change(&self, commit: &str, path_id: &str, line: usize) -> Result<Vec<String>, GitError> {
        let path = decode_path(path_id)?;
        history::validate_reference(commit)?;
        if line == 0 || line > MAX_TEXT_LINES { return Err(GitError::CommandFailed("行号超出可查询范围".into())); }
        let change = self.history_commit(commit, None)?;
        let mut args = vec!["diff-tree", "-r", "-p", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=2"];
        if let Some(parent) = &change.parent { args.push(parent); } else { args.push("--root"); }
        args.extend([&change.oid, "--", &path]);
        let output = run_required(&self.git, &self.worktree, &args)?;
        Ok(patch_excerpt(&String::from_utf8_lossy(&output.stdout), line))
    }
}

fn parse_porcelain(raw: &[u8]) -> Result<(String, usize, String), GitError> {
    let text = String::from_utf8(raw.to_vec()).map_err(|_| GitError::UnsupportedPathEncoding)?;
    let mut lines = text.lines();
    let fields: Vec<_> = lines.next().unwrap_or_default().split_whitespace().collect();
    if fields.len() < 3 || !((fields[0].len() == 40 || fields[0].len() == 64) && fields[0].bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(GitError::CommandFailed("无法解析行归属".into()));
    }
    let original_line = fields[1].parse::<usize>().ok().filter(|n| *n > 0).ok_or_else(|| GitError::CommandFailed("无法解析原始行号".into()))?;
    let filename = lines.find_map(|line| line.strip_prefix("filename ")).ok_or_else(|| GitError::CommandFailed("行归属缺少来源路径".into()))?;
    let path = unquote_path(filename)?;
    validate_relative(&path)?;
    Ok((fields[0].to_owned(), original_line, path))
}

/// Git 的 C 风格引号，包括非 ASCII 文件名的八进制字节转义。
pub(super) fn unquote_path(value: &str) -> Result<String, GitError> {
    if !value.starts_with('"') { return Ok(value.to_owned()); }
    let bytes = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).ok_or(GitError::UnsupportedPathEncoding)?.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' { out.push(bytes[i]); i += 1; continue; }
        i += 1;
        let Some(&b) = bytes.get(i) else { return Err(GitError::UnsupportedPathEncoding); };
        if (b'0'..=b'7').contains(&b) {
            let mut n = 0u16;
            let mut count = 0;
            while count < 3 && i < bytes.len() && (b'0'..=b'7').contains(&bytes[i]) { n = n * 8 + (bytes[i] - b'0') as u16; i += 1; count += 1; }
            if n > 255 { return Err(GitError::UnsupportedPathEncoding); }
            out.push(n as u8);
        } else {
            out.push(match b { b'n' => b'\n', b't' => b'\t', b'r' => b'\r', b'b' => 8, b'f' => 12, b'v' => 11, b'a' => 7, b'\\' | b'"' => b, _ => return Err(GitError::UnsupportedPathEncoding) });
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| GitError::UnsupportedPathEncoding)
}

/// 整文件按页加载，来源为固定提交或阅读器内容快照；与旧单行 API 相互独立。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameQuery { pub source: LineQuery, pub identity: Option<super::trace::Identity>, pub start: usize, pub page_size: usize }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameRow {
    pub line: usize, pub original_line: usize, pub oid: Option<String>,
    pub path: String, pub path_id: String, pub author: String, pub summary: String, pub text: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlamePage {
    pub rows: Vec<BlameRow>, pub next: Option<usize>, pub total_lines: usize,
    pub shallow: bool, pub elapsed_ms: u128, pub output_bytes: usize,
}
impl GitAdapter {
    pub fn file_blame(&self, query: &BlameQuery, stale: &dyn Fn() -> bool) -> Result<BlamePage, GitError> {
        self.file_blame_inner(query, stale).map_err(super::trace::Failure::error)
    }
    fn file_blame_inner(&self, query: &BlameQuery, stale: &dyn Fn() -> bool) -> Result<BlamePage, super::trace::Failure> {
        use super::trace::Budget;
        let mut budget = Budget::new(stale);
        let source = &query.source;
        let path = decode_path(&source.path_id)?;
        if query.start == 0 || query.start > MAX_TEXT_LINES || query.page_size == 0 || query.page_size > 200 {
            return Err(GitError::CommandFailed("blame 页范围超出预算（每页 1–200 行）".into()).into());
        }
        if let Some(revision) = &source.revision { super::trace::oid(revision)?; }
        if source.contents.is_none() && source.revision.is_none() { return Err(GitError::CommandFailed("缺少 blame 版本".into()).into()); }
        let text = if let Some(text) = &source.contents { text.clone() } else {
            String::from_utf8(budget.run(self, &["show", &format!("{}:{path}", source.revision.as_deref().unwrap())])?)
                .map_err(|_| GitError::CommandFailed("blame 仅支持 UTF-8 文本".into()))?
        };
        if text.len() > MAX_TEXT_BYTES || text.contains('\0') || text.lines().count() > MAX_TEXT_LINES || text.contains('\r') && text.replace("\r\n", "").contains('\r') {
            return Err(GitError::CommandFailed("blame 文本超过 5 MiB / 100000 行预算或格式不受支持".into()).into());
        }
        super::trace::verify_identity(query.identity.as_ref(), text.as_bytes(), source.contents.is_some())?;
        let total_lines = text.lines().count();
        let end = (query.start + query.page_size - 1).min(total_lines);
        let shallow = refs::is_shallow(&self.common_dir);
        if query.start > total_lines { return Ok(BlamePage { rows: vec![], next: None, total_lines, shallow, elapsed_ms: budget.elapsed_ms(), output_bytes: budget.bytes() }); }
        let mut new_file = source.revision.is_none();
        if source.contents.is_some() { if let Some(revision) = &source.revision {
            let head = String::from_utf8_lossy(&budget.run(self, &["rev-parse", "--verify", "HEAD^{commit}"])?) .trim().to_owned();
            if head != *revision { return Err(GitError::StaleRequest.into()); }
            new_file = budget.run(self, &["ls-tree", "-z", revision, "--", &path])?.is_empty();
        } }
        let rows = if new_file {
            text.lines().enumerate().skip(query.start - 1).take(query.page_size).map(|(index, text)| BlameRow {
                line: index + 1, original_line: index + 1, oid: None, path: path.clone(), path_id: source.path_id.clone(),
                author: "未提交".into(), summary: "未提交修改".into(), text: text.into(),
            }).collect()
        } else {
            let range = format!("{},{}", query.start, end);
            let mut args = vec!["-c", "blame.ignoreRevsFile=", "-c", "blame.showRoot=true", "blame", "--line-porcelain", "--root", "--no-textconv", "-L", &range];
            let mut temporary = None;
            if source.contents.is_some() {
                let mut file = tempfile::NamedTempFile::new().map_err(|e| GitError::Io(e.to_string()))?;
                file.write_all(text.as_bytes()).map_err(|e| GitError::Io(e.to_string()))?;
                temporary = Some(file);
            } else { args.push(source.revision.as_deref().unwrap()); }
            let name = temporary.as_ref().map(|f| f.path().to_string_lossy().into_owned());
            if let Some(name) = &name { args.extend(["--contents", name]); }
            args.extend(["--", &path]);
            let raw = budget.run(self, &args)?;
            if source.contents.is_some() {
                let head = String::from_utf8_lossy(&budget.run(self, &["rev-parse", "--verify", "HEAD^{commit}"])?) .trim().to_owned();
                if Some(&head) != source.revision.as_ref() { return Err(GitError::StaleRequest.into()); }
            }
            parse_rows(&raw)?
        };
        budget.check()?;
        Ok(BlamePage { rows, next: (end < total_lines).then_some(end + 1), total_lines, shallow, elapsed_ms: budget.elapsed_ms(), output_bytes: budget.bytes() })
    }
}
fn parse_rows(raw: &[u8]) -> Result<Vec<BlameRow>, GitError> {
    let text = std::str::from_utf8(raw).map_err(|_| GitError::UnsupportedPathEncoding)?;
    let mut result = Vec::new(); let mut lines = text.lines();
    while let Some(header) = lines.next() {
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() < 3 { return Err(GitError::CommandFailed("无法解析 blame 页".into())); }
        super::trace::oid(fields[0])?;
        let number = |field: &str| field.parse::<usize>().map_err(|_| GitError::CommandFailed("无法解析 blame 行号".into()));
        let mut row = BlameRow { line: number(fields[2])?, original_line: number(fields[1])?, oid: (!fields[0].bytes().all(|b| b == b'0')).then(|| fields[0].into()), path: String::new(), path_id: String::new(), author: String::new(), summary: String::new(), text: String::new() };
        let mut content = false;
        for line in lines.by_ref() {
            if let Some(text) = line.strip_prefix('\t') { row.text = text.into(); content = true; break; }
            if let Some(author) = line.strip_prefix("author ") { row.author = author.into(); }
            if let Some(summary) = line.strip_prefix("summary ") { row.summary = summary.into(); }
            if let Some(path) = line.strip_prefix("filename ") { row.path = unquote_path(path)?; validate_relative(&row.path)?; row.path_id = URL_SAFE_NO_PAD.encode(row.path.as_bytes()); }
        }
        if !content || row.path_id.is_empty() { return Err(GitError::CommandFailed("blame 页被截断".into())); }
        result.push(row);
    }
    Ok(result)
}

fn patch_excerpt(patch: &str, target: usize) -> Vec<String> {
    let rows: Vec<&str> = patch.lines().collect();
    for (start, header) in rows.iter().enumerate().filter(|(_, s)| s.starts_with("@@ ")) {
        let Some(range) = header.split_whitespace().nth(2).and_then(|s| s.strip_prefix('+')) else { continue; };
        let mut range = range.split(',');
        let Ok(first) = range.next().unwrap_or_default().parse::<usize>() else { continue; };
        let count = range.next().and_then(|n| n.parse::<usize>().ok()).unwrap_or(1);
        if target < first || target >= first + count { continue; }
        let end = rows[start + 1..].iter().position(|s| s.starts_with("@@ ") || s.starts_with("diff --git ")).map(|i| start + 1 + i).unwrap_or(rows.len());
        let mut line = first;
        let at = (start + 1..end).find(|i| {
            let is_target = line == target && !rows[*i].starts_with('-') && !rows[*i].starts_with('\\');
            if !rows[*i].starts_with('-') && !rows[*i].starts_with('\\') { line += 1; }
            is_target
        }).unwrap_or(start + 1);
        let from = at.saturating_sub(8).max(start + 1);
        let to = (at + 9).min(end);
        let mut excerpt = vec![header.to_string()];
        if from > start + 1 { excerpt.push("…".into()); }
        excerpt.extend(rows[from..to].iter().map(|s| s.chars().take(500).collect()));
        if to < end { excerpt.push("…".into()); }
        return excerpt;
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoted_paths_and_bounded_excerpt() {
        assert_eq!(unquote_path(r#""a\t\"b\"\303\251.txt""#).unwrap(), "a\t\"b\"é.txt");
        let patch = "diff --git a/f b/f\n@@ -1,2 +1,2 @@\n old\n-gone\n+new\n@@ -9 +9 @@\n-other\n+later\n";
        assert_eq!(patch_excerpt(patch, 2), vec!["@@ -1,2 +1,2 @@", " old", "-gone", "+new"]);
        assert!(patch_excerpt(patch, 6).is_empty());
    }
}
