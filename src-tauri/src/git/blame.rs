//! 行归属只读查询。历史端固定 OID；本地端只使用阅读器快照，不读取或改写工作区 / index。
use super::content::decode_path;
use super::log::{self, CommitInfo, LogQuery, SearchQuery};
use super::*;
use std::io::Write;

#[derive(Debug, Clone, Deserialize)]
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
fn unquote_path(value: &str) -> Result<String, GitError> {
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
