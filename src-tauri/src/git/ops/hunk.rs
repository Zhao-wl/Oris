//! R-STAGE / R-DISCARD hunk 级（任务 V2-05）：逐块暂存、取消暂存、丢弃。
//!
//! - 差异块来自 `git diff -U0` 的原始字节（只读通道），不使用前端解码后的文本计算边界；
//!   前端只用行范围与摘要指明“哪一块”，Rust 重新计算并核对后才构造 patch。
//! - 每次只应用一块：patch 的上下文取自被应用的一侧（暂存取 index，取消暂存与丢弃取新一侧），
//!   因此相邻块互不影响；执行前先 `git apply --check`，与显示时的内容不一致时拒绝执行（不自动重试）。
//! - 丢弃先把整个工作区文件写入对象库并记录（R-DISCARD 备份，可撤销）。
use super::*;

/// 某一块在两侧的行范围（0 起、左闭右开）与内容摘要。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HunkRef {
    pub old_start: usize,
    pub old_end: usize,
    pub new_start: usize,
    pub new_end: usize,
    pub digest: String,
}

/// 只读的块映射：界面据此决定哪些显示的差异块可以操作。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkMap {
    pub scope: CompareScope,
    pub path_id: String,
    /// 两侧原始字节的内容标识（与读取内容时的 contentId 相同）；与显示的内容不一致时界面不提供操作。
    pub content_ids: [String; 2],
    pub hunks: Vec<HunkRef>,
    /// 整个文件不能做块操作的原因。
    pub blocked: Option<String>,
    /// 额外说明（例如文件模式变化不随块操作）。
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkAction {
    Stage,
    Unstage,
    Discard,
}

impl HunkAction {
    fn scope(self) -> CompareScope {
        match self {
            Self::Unstage => CompareScope::Staged,
            Self::Stage | Self::Discard => CompareScope::Unstaged,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Stage => "暂存此块",
            Self::Unstage => "取消暂存此块",
            Self::Discard => "丢弃此块",
        }
    }
}

/// `git diff -U0` 中的一块：删除行与新增行（均含行尾 `\n`，文件末尾无换行的那一行除外）。
#[derive(Debug, Clone)]
struct RawHunk {
    range: (usize, usize, usize, usize),
    removed: Vec<Vec<u8>>,
    added: Vec<Vec<u8>>,
}

impl RawHunk {
    fn digest(&self) -> String {
        let mut bytes = Vec::new();
        for line in &self.removed {
            bytes.extend_from_slice(b"-");
            bytes.extend_from_slice(line);
            bytes.push(0);
        }
        for line in &self.added {
            bytes.extend_from_slice(b"+");
            bytes.extend_from_slice(line);
            bytes.push(0);
        }
        hash_bytes(&bytes)
    }
    fn reference(&self) -> HunkRef {
        let (old_start, old_end, new_start, new_end) = self.range;
        HunkRef { old_start, old_end, new_start, new_end, digest: self.digest() }
    }
}

/// 按行切分并保留行尾：最后一行可能没有 `\n`。
fn split_lines(bytes: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            lines.push(&bytes[start..=i]);
            start = i + 1;
        }
    }
    if start < bytes.len() {
        lines.push(&bytes[start..]);
    }
    lines
}

fn parse_count(text: &str) -> Option<(usize, usize)> {
    let (start, count) = match text.split_once(',') {
        Some((s, c)) => (s.parse().ok()?, c.parse().ok()?),
        None => (text.parse().ok()?, 1),
    };
    Some((start, count))
}

/// `@@ -a[,b] +c[,d] @@` → 0 起的左闭右开范围。count 为 0 时 git 给出的是“之后插入的那一行”，即范围起点等于 a。
fn header_range(line: &[u8]) -> Option<(usize, usize, usize, usize)> {
    let text = std::str::from_utf8(line).ok()?;
    let inner = text.strip_prefix("@@ ")?;
    let end = inner.find(" @@")?;
    let mut parts = inner[..end].split(' ');
    let (a, b) = parse_count(parts.next()?.strip_prefix('-')?)?;
    let (c, d) = parse_count(parts.next()?.strip_prefix('+')?)?;
    let old_start = if b == 0 { a } else { a.checked_sub(1)? };
    let new_start = if d == 0 { c } else { c.checked_sub(1)? };
    Some((old_start, old_start + b, new_start, new_start + d))
}

enum Parsed {
    Hunks(Vec<RawHunk>),
    Binary,
}

/// 解析 `git diff -U0` 输出（原始字节，路径与内容都不解码）。
fn parse_unified_zero(raw: &[u8]) -> Result<Parsed, String> {
    let mut hunks: Vec<RawHunk> = Vec::new();
    let mut in_body = false;
    let mut lines = raw.split(|b| *b == b'\n').peekable();
    while let Some(line) = lines.next() {
        if line.starts_with(b"@@ ") {
            let range = header_range(line).ok_or("无法解析差异块标题")?;
            hunks.push(RawHunk { range, removed: Vec::new(), added: Vec::new() });
            in_body = true;
            continue;
        }
        if !in_body {
            if line.starts_with(b"Binary files ") || line.starts_with(b"GIT binary patch") {
                return Ok(Parsed::Binary);
            }
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        match line.first() {
            Some(b'-') => {
                let mut content = line[1..].to_vec();
                content.push(b'\n');
                hunk.removed.push(content);
            }
            Some(b'+') => {
                let mut content = line[1..].to_vec();
                content.push(b'\n');
                hunk.added.push(content);
            }
            Some(b'\\') => {
                // “\ No newline at end of file”：紧挨着的上一行没有行尾换行。
                let target = if hunk.added.is_empty() { hunk.removed.last_mut() } else { hunk.added.last_mut() };
                if let Some(last) = target {
                    if last.last() == Some(&b'\n') {
                        last.pop();
                    }
                }
            }
            Some(b'd') if line.starts_with(b"diff --git ") => in_body = false,
            _ => {}
        }
    }
    // 输出末尾的空行（最后一个 `\n` 之后）不是内容。
    Ok(Parsed::Hunks(hunks))
}

/// 由旧一侧与全部块重建新一侧（Git 视角的内容，即经过 clean 转换后的工作区 / index）。
fn reconstruct<'a>(old: &[&'a [u8]], hunks: &'a [RawHunk]) -> Result<Vec<Vec<u8>>, String> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut cursor = 0usize;
    for hunk in hunks {
        let (old_start, old_end, _, _) = hunk.range;
        if old_start < cursor || old_end > old.len() {
            return Err("差异块范围超出旧内容".into());
        }
        out.extend(old[cursor..old_start].iter().map(|l| l.to_vec()));
        if old[old_start..old_end].iter().map(|l| l.to_vec()).ne(hunk.removed.iter().cloned()) {
            return Err("差异块的删除行与旧内容不一致".into());
        }
        out.extend(hunk.added.iter().cloned());
        cursor = old_end;
    }
    out.extend(old[cursor..].iter().map(|l| l.to_vec()));
    Ok(out)
}

/// C 风格加引号的 patch 路径（始终加引号：空格、非 ASCII、控制字符都安全）。
fn quoted(prefix: &str, path: &[u8]) -> Vec<u8> {
    let mut out = vec![b'"'];
    out.extend_from_slice(prefix.as_bytes());
    for &b in path {
        match b {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            0x20..=0x7e => out.push(b),
            _ => out.extend_from_slice(format!("\\{b:03o}").as_bytes()),
        }
    }
    out.push(b'"');
    out
}

fn push_line(patch: &mut Vec<u8>, prefix: u8, line: &[u8]) {
    patch.push(prefix);
    patch.extend_from_slice(line);
    if line.last() != Some(&b'\n') {
        patch.extend_from_slice(b"\n\\ No newline at end of file\n");
    }
}

/// 只包含一块的 patch。`target` 为将被应用的一侧（正向应用取旧一侧，反向应用取新一侧），上下文从它取。
fn single_hunk_patch(path: &[u8], hunk: &RawHunk, target: &[Vec<u8>], reverse: bool) -> Vec<u8> {
    let (old_start, old_end, new_start, new_end) = hunk.range;
    let (t_start, t_end) = if reverse { (new_start, new_end) } else { (old_start, old_end) };
    let before = t_start.min(3);
    let after = (target.len() - t_end).min(3);
    let old_len = before + (old_end - old_start) + after;
    let new_len = before + (new_end - new_start) + after;
    let origin = t_start - before;
    let start = |len: usize| if len == 0 { origin } else { origin + 1 };
    let mut patch = Vec::new();
    patch.extend_from_slice(b"diff --git ");
    patch.extend_from_slice(&quoted("a/", path));
    patch.push(b' ');
    patch.extend_from_slice(&quoted("b/", path));
    patch.extend_from_slice(b"\n--- ");
    patch.extend_from_slice(&quoted("a/", path));
    patch.extend_from_slice(b"\n+++ ");
    patch.extend_from_slice(&quoted("b/", path));
    patch.push(b'\n');
    patch.extend_from_slice(format!("@@ -{},{} +{},{} @@\n", start(old_len), old_len, start(new_len), new_len).as_bytes());
    for line in &target[origin..t_start] {
        push_line(&mut patch, b' ', line);
    }
    for line in &hunk.removed {
        push_line(&mut patch, b'-', line);
    }
    for line in &hunk.added {
        push_line(&mut patch, b'+', line);
    }
    for line in &target[t_end..t_end + after] {
        push_line(&mut patch, b' ', line);
    }
    patch
}

/// 计算块映射所需的内容：两侧原始字节与 `git diff -U0` 的解析结果。
struct HunkSource {
    path: Vec<u8>,
    content_ids: [String; 2],
    old: Vec<u8>,
    hunks: Vec<RawHunk>,
    mode_changed: bool,
}

impl GitAdapter {
    /// 只读：读取两侧原始字节并运行一次 `git diff -U0`。返回 Err(说明) 表示整个文件不能做块操作。
    fn hunk_source(&self, state: &scan::ScanState, scope: CompareScope, path_id: &str) -> Result<Result<HunkSource, String>, GitError> {
        if scope == CompareScope::All {
            return Ok(Err("“全部”范围同时跨越暂存区与工作区，不提供块操作；请切换到“未暂存”或“已暂存”".into()));
        }
        let Some(change) = state.change(scope, path_id) else { return Err(GitError::StaleRequest) };
        let path = decode_path_id(path_id)?;
        let entry = state.entries.get(path_id);
        let refuse = |reason: &str| Ok(Err(reason.to_owned()));
        if matches!(change.status, FileStatus::Conflicted) || entry.is_some_and(|e| e.conflict.is_some()) {
            return refuse("冲突文件不提供块操作；请在外部解决后使用“标记已解决”");
        }
        if !matches!(change.status, FileStatus::Modified) {
            return refuse("新增、删除、重命名、未跟踪或类型变化的文件不提供块操作；请使用文件级操作");
        }
        let Some(entry) = entry else { return Err(GitError::StaleRequest) };
        let modes = [entry.head.as_ref().map(|s| s.mode.as_str()), entry.index.as_ref().map(|s| s.mode.as_str()), entry.worktree_mode.as_deref()];
        if modes.iter().flatten().any(|m| *m == "160000") {
            return refuse("子模块不提供块操作");
        }
        if modes.iter().flatten().any(|m| *m == "120000") {
            return refuse("符号链接不提供块操作");
        }
        // 两侧原始字节（与读取内容时计算 contentId 的字节相同）。
        let blob = |stage: Option<&status_v2::Stage>| -> Result<Option<Vec<u8>>, GitError> {
            let Some(stage) = stage else { return Ok(None) };
            Ok(match self.reader.with(|r| r.read_blob_limited(&stage.oid, MAX_TEXT_BYTES))? {
                object_reader::BlobRead::Bytes(bytes) => Some(bytes.to_vec()),
                _ => None,
            })
        };
        let (left, right) = match scope {
            CompareScope::Unstaged => (blob(entry.index.as_ref())?, {
                let relative = std::str::from_utf8(&path).map_err(|_| GitError::UnsupportedPathEncoding)?;
                self.read_worktree(relative, MAX_TEXT_BYTES + 1).ok().filter(|b| b.len() <= MAX_TEXT_BYTES)
            }),
            _ => (blob(entry.head.as_ref())?, blob(entry.index.as_ref())?),
        };
        let (Some(left), Some(right)) = (left, right) else {
            return refuse("超出内容预算（每侧 5 MiB），不提供块操作");
        };
        let mode_changed = match scope {
            CompareScope::Unstaged => entry.index.as_ref().map(|s| s.mode.as_str()) != entry.worktree_mode.as_deref(),
            _ => entry.head.as_ref().map(|s| &s.mode) != entry.index.as_ref().map(|s| &s.mode),
        };
        let relative = std::str::from_utf8(&path).map_err(|_| GitError::UnsupportedPathEncoding)?;
        let mut args = vec![
            "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "color.diff=false",
            "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--diff-algorithm=myers", "--no-indent-heuristic", "-U0",
        ];
        if scope == CompareScope::Staged {
            args.push("--cached");
        }
        args.extend(["--", relative]);
        let output = run_required(&self.git, &self.worktree, &args)?;
        let hunks = match parse_unified_zero(&output.stdout) {
            Ok(Parsed::Binary) => return refuse("二进制文件不提供块操作"),
            Ok(Parsed::Hunks(hunks)) => hunks,
            Err(reason) => return Ok(Err(format!("无法解析 Git 的差异输出：{reason}"))),
        };
        let lines = split_lines(&left);
        if lines.len() > MAX_TEXT_LINES {
            return refuse("超出内容预算（100,000 行），不提供块操作");
        }
        if let Err(reason) = reconstruct(&lines, &hunks) {
            return Ok(Err(format!("Git 的差异与读取到的内容不一致（{reason}），请刷新")));
        }
        Ok(Ok(HunkSource { path, content_ids: [hash_bytes(&left), hash_bytes(&right)], old: left, hunks, mode_changed }))
    }

    /// 只读 IPC：某文件在当前范围内可操作的差异块。
    pub fn hunk_map(&self, scope: CompareScope, revision: &str, path_id: &str) -> Result<HunkMap, GitError> {
        let state = self.scan_state(revision).ok_or(GitError::StaleRequest)?;
        let mut map = HunkMap { scope, path_id: path_id.to_owned(), content_ids: [String::new(), String::new()], hunks: Vec::new(), blocked: None, note: None };
        match self.hunk_source(&state, scope, path_id)? {
            Err(reason) => map.blocked = Some(reason),
            Ok(source) => {
                map.content_ids = source.content_ids;
                map.hunks = source.hunks.iter().map(RawHunk::reference).collect();
                if source.hunks.is_empty() {
                    map.blocked = Some(if source.mode_changed { "只有文件模式变化，没有可操作的差异块；请使用文件级操作".into() } else { "Git 没有报告内容差异".into() });
                } else if source.mode_changed {
                    map.note = Some("文件模式变化不随块操作一起暂存或丢弃；需要时请使用文件级操作".into());
                }
            }
        }
        Ok(map)
    }

    /// 执行一块的暂存 / 取消暂存 / 丢弃。`content_ids` 为界面显示时的两侧内容标识。
    pub(super) fn op_hunk(&self, action: HunkAction, path_id: &str, content_ids: &[String; 2], hunk: &HunkRef, confirmed_unrecoverable: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let scope = action.scope();
        let state = self.scan(false)?;
        let source = match self.hunk_source(&state, scope, path_id) {
            Ok(Ok(source)) => source,
            Ok(Err(reason)) => return Ok(Step::failed(format!("{}：{reason}", action.label()))),
            Err(GitError::StaleRequest) => return Ok(Step::failed(format!("{}：文件已不在该范围中，请查看刷新后的差异", action.label()))),
            Err(error) => return Err(error),
        };
        if &source.content_ids != content_ids {
            return Ok(Step::failed(format!("{}：文件在显示之后已被修改，已拒绝执行；请查看刷新后的差异再操作", action.label())));
        }
        let Some(raw) = source.hunks.iter().find(|h| h.reference() == *hunk) else {
            return Ok(Step::failed(format!("{}：没有找到与显示一致的差异块，已拒绝执行；请刷新后重试", action.label())));
        };
        let old = split_lines(&source.old);
        let old_owned: Vec<Vec<u8>> = old.iter().map(|l| l.to_vec()).collect();
        let new = reconstruct(&old, &source.hunks).map_err(GitError::CommandFailed)?;
        let (reverse, target, cached) = match action {
            HunkAction::Stage => (false, &old_owned, true),
            HunkAction::Unstage => (true, &new, true),
            HunkAction::Discard => (true, &new, false),
        };
        let patch = single_hunk_patch(&source.path, raw, target, reverse);
        let mut args = vec!["apply", "--whitespace=nowarn"];
        if cached {
            args.push("--cached");
        }
        if reverse {
            args.push("--reverse");
        }
        let mut check = args.clone();
        check.push("--check");
        let checked = self.write_git(&check, Some(patch.clone()), true, ctx)?;
        if checked.cancelled {
            return Ok(Step::cancelled(format!("{}已取消", action.label())));
        }
        if !checked.success {
            return Ok(Step::failed(format!("{}：git apply --check 拒绝了这块改动（内容已与显示时不同），仓库未改动；请刷新后重试。\n{}", action.label(), checked.summary())));
        }
        let display_path = display(&source.path);
        let apply = |ctx: &OpContext| -> Result<Step, GitError> {
            let result = self.write_git(&args, Some(patch.clone()), true, ctx)?;
            Ok(if result.cancelled {
                Step::cancelled(format!("{}已取消", action.label()))
            } else if result.success {
                Step::ok(match action {
                    HunkAction::Stage => format!("已暂存 {display_path} 的 1 个差异块"),
                    HunkAction::Unstage => format!("已取消暂存 {display_path} 的 1 个差异块"),
                    HunkAction::Discard => format!("已丢弃 {display_path} 的 1 个差异块"),
                })
            } else {
                Step::failed(Self::failure_message(&result, action.label()))
            })
        };
        let mut step = if action == HunkAction::Discard {
            self.with_worktree_backup(&source.path, path_id, confirmed_unrecoverable, ctx, apply)?
        } else {
            apply(ctx)?
        };
        step.touched = vec![display_path];
        Ok(step)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zero_context_hunks_with_missing_final_newline() {
        let raw = b"diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -2 +2 @@\n-b\n\\ No newline at end of file\n+b\n@@ -4,0 +5,2 @@\n+x\n+y\n@@ -7,2 +8,0 @@\n-p\n-q\n";
        let Parsed::Hunks(hunks) = parse_unified_zero(raw).unwrap() else { panic!() };
        assert_eq!(hunks.len(), 3);
        assert_eq!(hunks[0].range, (1, 2, 1, 2));
        assert_eq!(hunks[0].removed, vec![b"b".to_vec()]);
        assert_eq!(hunks[0].added, vec![b"b\n".to_vec()]);
        assert_eq!(hunks[1].range, (4, 4, 4, 6));
        assert_eq!(hunks[2].range, (6, 8, 8, 8), "count 为 0 时起点就是插入 / 删除位置之前的行数");
        assert!(matches!(parse_unified_zero(b"diff --git a/x b/x\nBinary files a/x and b/x differ\n").unwrap(), Parsed::Binary));
    }

    /// B15：patch 生成之后目标一侧（index）被外部改动，`git apply --check` 拒绝，仓库不变。
    #[test]
    fn apply_check_rejects_a_patch_whose_target_changed() {
        let run = |root: &Path, args: &[&str], input: Option<&[u8]>| {
            use std::io::Write;
            let mut child = Command::new("git").arg("-C").arg(root).args(["-c", "core.autocrlf=false"]).args(args)
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
            if let Some(input) = input { child.stdin.take().unwrap().write_all(input).unwrap(); }
            drop(child.stdin.take());
            child.wait_with_output().unwrap()
        };
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.name", "T"], &["config", "user.email", "t@example.invalid"], &["config", "core.autocrlf", "false"]] {
            assert!(run(p, args, None).status.success());
        }
        fs::write(p.join("a.txt"), b"1\n2\n3\n4\n5\n").unwrap();
        assert!(run(p, &["add", "-A"], None).status.success());
        assert!(run(p, &["commit", "-qm", "base"], None).status.success());
        fs::write(p.join("a.txt"), b"1\n2\n3\nFOUR\n5\n").unwrap();
        let adapter = GitAdapter::open(p.to_string_lossy().into_owned(), None).unwrap();
        let state = adapter.scan(false).unwrap();
        let path_id = URL_SAFE_NO_PAD.encode("a.txt");
        let Ok(source) = adapter.hunk_source(&state, CompareScope::Unstaged, &path_id).unwrap() else { panic!() };
        let old: Vec<Vec<u8>> = split_lines(&source.old).iter().map(|l| l.to_vec()).collect();
        let patch = single_hunk_patch(&source.path, &source.hunks[0], &old, false);
        // 生成 patch 之后，外部把 index 中该文件的第 3 行改掉（上下文不再匹配）
        let blob = run(p, &["hash-object", "-w", "--stdin"], Some(b"1\n2\nthree\n4\n5\n"));
        let oid = String::from_utf8(blob.stdout).unwrap().trim().to_owned();
        assert!(run(p, &["update-index", "--cacheinfo", &format!("100644,{oid},a.txt")], None).status.success());
        let index_before = run(p, &["ls-files", "-s"], None).stdout;
        let checked = run(p, &["apply", "--cached", "--whitespace=nowarn", "--check"], Some(&patch));
        assert!(!checked.status.success(), "上下文不匹配时 --check 必须拒绝");
        assert_eq!(run(p, &["ls-files", "-s"], None).stdout, index_before, "--check 不改 index");
        // 目标未变时同一个 patch 可以通过 --check
        assert!(run(p, &["update-index", "--cacheinfo", &format!("100644,{},a.txt", String::from_utf8(run(p, &["rev-parse", "HEAD:a.txt"], None).stdout).unwrap().trim())], None).status.success());
        assert!(run(p, &["apply", "--cached", "--whitespace=nowarn", "--check"], Some(&patch)).status.success());
    }

    #[test]
    fn quotes_every_path_c_style() {
        assert_eq!(quoted("a/", "中 文/a b\"c".as_bytes()), b"\"a/\\344\\270\\255 \\346\\226\\207/a b\\\"c\"".to_vec());
    }

    #[test]
    fn single_hunk_patch_takes_context_from_the_target_side() {
        let old: Vec<&[u8]> = vec![b"1\n", b"2\n", b"3\n", b"4\n", b"5\n"];
        let hunks = vec![
            RawHunk { range: (1, 2, 1, 2), removed: vec![b"2\n".to_vec()], added: vec![b"two\n".to_vec()] },
            RawHunk { range: (3, 4, 3, 4), removed: vec![b"4\n".to_vec()], added: vec![b"four\n".to_vec()] },
        ];
        let new = reconstruct(&old, &hunks).unwrap();
        assert_eq!(new.concat(), b"1\ntwo\n3\nfour\n5\n");
        let old_owned: Vec<Vec<u8>> = old.iter().map(|l| l.to_vec()).collect();
        // 正向（暂存第 2 块）：上下文来自旧一侧，第 1 块仍是旧内容 “2”
        let forward = String::from_utf8(single_hunk_patch(b"f", &hunks[1], &old_owned, false)).unwrap();
        assert!(forward.contains("@@ -1,5 +1,5 @@\n 1\n 2\n 3\n-4\n+four\n 5\n"), "{forward}");
        // 反向（丢弃第 1 块）：上下文来自新一侧，第 2 块已是新内容 “four”
        let reverse = String::from_utf8(single_hunk_patch(b"f", &hunks[0], &new, true)).unwrap();
        assert!(reverse.contains("@@ -1,5 +1,5 @@\n 1\n-2\n+two\n 3\n four\n 5\n"), "{reverse}");
    }
}
