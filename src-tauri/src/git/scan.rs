//! V2 StatusScanner：一次 `status --porcelain=v2` 覆盖三个比较范围（技术方案 §5.1）。
//!
//! 只读约束：列表来自带 `--no-optional-locks` 的 status；统计与“全部”范围修正只用
//! `diff-files` / `diff-index` 这类 plumbing 命令。porcelain `git diff` 即使带
//! `--no-optional-locks` 也会在 stat 过期时回写 index（Git 2.44 实测），因此不在浏览路径上使用。
use super::status_v2::{self, BranchInfo, Entry, InProgress};
use super::*;
use std::collections::HashSet;
use std::sync::OnceLock;

/// 工作区文件的快速变化判断依据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WtStat {
    pub exists: bool,
    pub len: u64,
    pub modified: u128,
}

pub(super) fn wt_stat(path: &Path) -> WtStat {
    match fs::symlink_metadata(path) {
        Ok(meta) => WtStat {
            exists: true,
            len: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        },
        Err(_) => WtStat { exists: false, len: 0, modified: 0 },
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeLists {
    pub unstaged: Vec<FileChange>,
    pub staged: Vec<FileChange>,
    pub all: Vec<FileChange>,
}

impl ScopeLists {
    pub fn get(&self, scope: CompareScope) -> &Vec<FileChange> {
        match scope {
            CompareScope::Unstaged => &self.unstaged,
            CompareScope::Staged => &self.staged,
            CompareScope::All => &self.all,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummary {
    pub head: Option<String>,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgressSummary {
    pub merge: bool,
    pub rebase: bool,
    pub cherry_pick: bool,
    pub revert: bool,
    pub bisect: bool,
}

/// 后台补齐的次要信息：增删统计与“全部”范围修正后的列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDetails {
    pub revision: String,
    /// `[pathId, additions, deletions]`；缺失表示二进制或不可统计。
    pub stats: ScopeStats,
    /// 修正后的“全部”范围（工作区 rename 配对、HEAD 与工作区相同的双层修改已剔除）。
    pub all: Vec<FileChange>,
    /// status 报告修改但 numstat 无输出（规范化后内容一致）的文件；只可能出现在未暂存与“全部”范围。
    pub content_unchanged: ScopeUnchanged,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeUnchanged {
    pub unstaged: Vec<(String, UnchangedReason)>,
    pub all: Vec<(String, UnchangedReason)>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeStats {
    pub unstaged: Vec<(String, Option<u64>, Option<u64>)>,
    pub staged: Vec<(String, Option<u64>, Option<u64>)>,
    pub all: Vec<(String, Option<u64>, Option<u64>)>,
}

/// 一次扫描的完整状态，按 revision 保存最近几份，供内容读取按 OID 取对象。
pub(super) struct ScanState {
    pub revision: String,
    pub entries: HashMap<String, Entry>,
    pub lists: ScopeLists,
    pub has_head: bool,
    pub branch: BranchInfo,
    pub in_progress: InProgress,
    pub index_stat: Option<WtStat>,
    pub refs_digest: Vec<u8>,
    pub wt: HashMap<String, WtStat>,
    pub details: OnceLock<Arc<RepositoryDetails>>,
    pub details_lock: Mutex<()>,
}

impl ScanState {
    /// 选中范围内的文件记录；“全部”范围优先使用已修正的列表。
    pub fn change(&self, scope: CompareScope, path_id: &str) -> Option<FileChange> {
        if scope == CompareScope::All {
            if let Some(details) = self.details.get() {
                return details.all.iter().find(|f| f.path_id == path_id).cloned();
            }
        }
        self.lists.get(scope).iter().find(|f| f.path_id == path_id).cloned()
    }
}

fn file(entry: &Entry, status: FileStatus, old: Option<(&Vec<u8>, &String)>) -> FileChange {
    FileChange {
        path_id: entry.path_id.clone(),
        display_path: String::from_utf8_lossy(&entry.path).into_owned(),
        old_path_id: old.map(|(_, id)| id.clone()),
        old_display_path: old.map(|(path, _)| String::from_utf8_lossy(path).into_owned()),
        status,
        additions: None,
        deletions: None,
        content_unchanged: None,
    }
}

fn code_status(code: u8) -> Option<FileStatus> {
    match code {
        b'M' => Some(FileStatus::Modified),
        b'A' => Some(FileStatus::Added),
        b'D' => Some(FileStatus::Deleted),
        b'T' => Some(FileStatus::TypeChanged),
        b'R' => Some(FileStatus::Renamed),
        b'C' => Some(FileStatus::Added),
        _ => None,
    }
}

/// 把 porcelain v2 条目映射为与 V1 逐命令结果一致的三个范围（“全部”范围尚未做工作区 rename 修正）。
pub(super) fn scope_lists(entries: &[Entry], has_head: bool) -> ScopeLists {
    let mut lists = ScopeLists::default();
    let untracked: HashSet<&[u8]> = entries
        .iter()
        .filter(|e| e.x == b'?')
        .map(|e| e.path.as_slice())
        .collect();
    for entry in entries {
        if entry.conflict.is_some() {
            for list in [&mut lists.unstaged, &mut lists.staged, &mut lists.all] {
                list.push(file(entry, FileStatus::Conflicted, None));
            }
            continue;
        }
        if entry.x == b'?' {
            lists.unstaged.push(file(entry, FileStatus::Untracked, None));
            lists.all.push(file(entry, FileStatus::Untracked, None));
            continue;
        }
        let old = entry.old_path.as_ref().zip(entry.old_path_id.as_ref());
        // 未暂存：index → 工作区。
        if let Some(status) = code_status(entry.y) {
            let status = if matches!(status, FileStatus::Renamed) { FileStatus::Added } else { status };
            lists.unstaged.push(file(entry, status, None));
        }
        // 已暂存：HEAD → index。
        if let Some(status) = code_status(entry.x) {
            let renamed = matches!(status, FileStatus::Renamed);
            lists.staged.push(file(entry, status, if renamed { old } else { None }));
        }
        // 全部：HEAD → 工作区。
        if !has_head {
            // 与 V1 list_unborn_all 一致：index 中的每个条目都是新增。
            if !untracked.contains(entry.path.as_slice()) {
                lists.all.push(file(entry, FileStatus::Added, None));
            }
            continue;
        }
        let status = match (entry.x, entry.y) {
            (b'.', y) => code_status(y),
            (b'A' | b'C', b'D') => None,
            (b'A' | b'C', _) => Some(FileStatus::Added),
            (b'R', b'D') => {
                // 暂存 rename 后工作区又删除了新路径：HEAD 视角只剩原路径被删除。
                if let Some((path, id)) = old {
                    lists.all.push(FileChange {
                        path_id: id.clone(),
                        display_path: String::from_utf8_lossy(path).into_owned(),
                        old_path_id: None,
                        old_display_path: None,
                        status: FileStatus::Deleted,
                        additions: None,
                        deletions: None,
                        content_unchanged: None,
                    });
                }
                None
            }
            (b'R', _) => Some(FileStatus::Renamed),
            (_, b'D') => Some(FileStatus::Deleted),
            (b'D', _) => Some(FileStatus::Deleted),
            (b'T', _) | (_, b'T') => Some(FileStatus::TypeChanged),
            _ => Some(FileStatus::Modified),
        };
        if let Some(status) = status {
            // 同一路径的未跟踪文件在 V1 中覆盖删除记录（index 已移除、工作区仍在）。
            if matches!(status, FileStatus::Deleted) && untracked.contains(entry.path.as_slice()) {
                continue;
            }
            let renamed = matches!(status, FileStatus::Renamed);
            lists.all.push(file(entry, status, if renamed { old } else { None }));
        }
    }
    for list in [&mut lists.unstaged, &mut lists.staged, &mut lists.all] {
        list.sort_by(|a, b| a.display_path.cmp(&b.display_path));
    }
    lists
}

impl GitAdapter {
    /// 读取本地 ref 存储（HEAD 链与 packed-refs），不启动进程。
    pub(super) fn refs_digest(&self) -> Result<Vec<u8>, GitError> {
        let mut digest = Sha256::new();
        for directory in [&self.git_dir, &self.common_dir] {
            if let Ok(packed) = fs::read(directory.join("packed-refs")) {
                digest.update((packed.len() as u64).to_le_bytes());
                digest.update(packed);
            }
        }
        if self.common_dir.join("reftable").exists() {
            digest.update(
                run_readonly(&self.git, &self.worktree, &["rev-parse", "--verify", "HEAD"])?.stdout,
            );
            digest.update(self.current_branch()?.as_bytes());
        }
        let mut reference = "HEAD".to_owned();
        for _ in 0..8 {
            validate_relative(&reference)?;
            let bytes = fs::read(self.git_dir.join(&reference))
                .or_else(|_| fs::read(self.common_dir.join(&reference)))
                .unwrap_or_default();
            digest.update(reference.as_bytes());
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(&bytes);
            let value = String::from_utf8_lossy(&bytes);
            if let Some(next) = value.trim().strip_prefix("ref: ") {
                reference = next.to_owned();
            } else {
                break;
            }
        }
        Ok(digest.finalize().to_vec())
    }

    pub(super) fn index_stat(&self) -> Option<WtStat> {
        let stat = wt_stat(&self.git_dir.join("index"));
        stat.exists.then_some(stat)
    }

    fn worktree_stat(&self, path: &[u8]) -> WtStat {
        match std::str::from_utf8(path) {
            Ok(relative) if validate_relative(relative).is_ok() => wt_stat(&self.worktree.join(relative)),
            _ => WtStat { exists: false, len: 0, modified: 0 },
        }
    }

    /// 执行一次 status 扫描。`refresh_index` 为 true 时（仅手动刷新）允许 Git 回写 index 的 stat 缓存（V2-D09）。
    pub(super) fn scan(&self, refresh_index: bool) -> Result<Arc<ScanState>, GitError> {
        let refs_digest = self.refs_digest()?;
        let args = [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--find-renames",
        ];
        let output = if refresh_index {
            let output = index_refresh_command(&self.git, &self.worktree, &args)
                .output()
                .map_err(|error| GitError::GitUnavailable(error.to_string()))?;
            if !output.status.success() {
                return Err(GitError::CommandFailed(stderr_summary(&output)));
            }
            output
        } else {
            run_required(&self.git, &self.worktree, &args)?
        };
        let raw = output.stdout;
        let (branch, files) = status_v2::parse(&raw)?;
        let has_head = branch.oid.is_some();
        let lists = scope_lists(&files.all, has_head);
        let mut wt = HashMap::new();
        let mut revision = Sha256::new();
        revision.update(b"oris-v2-scan-1");
        revision.update((raw.len() as u64).to_le_bytes());
        revision.update(&raw);
        revision.update(&refs_digest);
        let mut paths: Vec<&Entry> = files.all.iter().collect();
        paths.sort_by(|a, b| a.path.cmp(&b.path));
        for entry in &paths {
            for path in std::iter::once(&entry.path).chain(entry.old_path.iter()) {
                let id = URL_SAFE_NO_PAD.encode(path);
                if wt.contains_key(&id) {
                    continue;
                }
                let stat = self.worktree_stat(path);
                revision.update(path);
                revision.update([u8::from(stat.exists)]);
                revision.update(stat.len.to_le_bytes());
                revision.update(stat.modified.to_le_bytes());
                wt.insert(id, stat);
            }
        }
        let revision = hex::encode(revision.finalize());
        let in_progress = status_v2::detect_in_progress(&self.git_dir);
        let entries = files
            .all
            .into_iter()
            .map(|entry| (entry.path_id.clone(), entry))
            .collect();
        let state = Arc::new(ScanState {
            revision,
            entries,
            lists,
            has_head,
            branch,
            in_progress,
            index_stat: self.index_stat(),
            refs_digest,
            wt,
            details: OnceLock::new(),
            details_lock: Mutex::new(()),
        });
        let mut history = self.scans.lock().map_err(|e| GitError::Io(e.to_string()))?;
        if let Some(existing) = history.iter().find(|s| s.revision == state.revision) {
            // 同一 revision 复用已有状态，保留已算好的详情。
            if existing.details.get().is_some() {
                return Ok(existing.clone());
            }
        }
        history.retain(|s| s.revision != state.revision);
        history.push(state.clone());
        while history.len() > SCAN_HISTORY {
            history.remove(0);
        }
        Ok(state)
    }

    pub(super) fn scan_state(&self, revision: &str) -> Option<Arc<ScanState>> {
        self.scans
            .lock()
            .ok()?
            .iter()
            .find(|s| s.revision == revision)
            .cloned()
    }

    pub(super) fn branch_label(branch: &BranchInfo) -> String {
        match (&branch.head, &branch.oid) {
            (Some(head), _) => head.clone(),
            (None, Some(oid)) => format!("detached @ {}", &oid[..oid.len().min(7)]),
            (None, None) => "unborn HEAD".into(),
        }
    }

    /// 后台详情：增删统计与“全部”范围修正。每个 revision 只计算一次。
    pub(super) fn details_for(&self, state: &ScanState) -> Result<Arc<RepositoryDetails>, GitError> {
        if let Some(details) = state.details.get() {
            return Ok(details.clone());
        }
        let _guard = state.details_lock.lock().map_err(|e| GitError::Io(e.to_string()))?;
        if let Some(details) = state.details.get() {
            return Ok(details.clone());
        }
        let started = std::time::Instant::now();
        let base = if state.has_head { "HEAD".to_owned() } else { self.empty_tree()? };
        let numstat = |args: Vec<&str>| -> Result<HashMap<String, (Option<u64>, Option<u64>)>, GitError> {
            let output = run_required(&self.git, &self.worktree, &args)?;
            let mut stats = HashMap::new();
            for field in output.stdout.split(|b| *b == 0).filter(|f| !f.is_empty()) {
                let mut parts = field.splitn(3, |b| *b == b'\t');
                let additions = parts.next().and_then(parse_stat);
                let deletions = parts.next().and_then(parse_stat);
                if let Some(path) = parts.next() {
                    stats.insert(URL_SAFE_NO_PAD.encode(path), (additions, deletions));
                }
            }
            Ok(stats)
        };
        let diff_opts = ["--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z"];
        let (unstaged, staged, all, renames) = std::thread::scope(|scope| {
            let unstaged = scope.spawn(|| {
                let mut args = vec!["diff-files"];
                args.extend_from_slice(&diff_opts);
                args.push("--");
                numstat(args)
            });
            let staged = scope.spawn(|| {
                let mut args = vec!["diff-index", "--cached"];
                args.extend_from_slice(&diff_opts);
                args.extend_from_slice(&[base.as_str(), "--"]);
                numstat(args)
            });
            let all = scope.spawn(|| {
                if !state.has_head {
                    return Ok(None);
                }
                let mut args = vec!["diff-index"];
                args.extend_from_slice(&diff_opts);
                args.extend_from_slice(&["HEAD", "--"]);
                numstat(args).map(Some)
            });
            let renames = scope.spawn(|| {
                if !state.has_head {
                    return Ok(Vec::new());
                }
                let raw = run_required(
                    &self.git,
                    &self.worktree,
                    &["diff-index", "--no-ext-diff", "--no-textconv", "-M", "--name-status", "-z", "HEAD", "--"],
                )?
                .stdout;
                let fields: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|f| !f.is_empty()).collect();
                let mut pairs = Vec::new();
                let mut i = 0;
                while i < fields.len() {
                    let code = fields[i];
                    i += 1;
                    if code.starts_with(b"R") || code.starts_with(b"C") {
                        if i + 1 >= fields.len() {
                            return Err(GitError::CommandFailed("无法解析 diff-index rename 输出".into()));
                        }
                        if code.starts_with(b"R") {
                            pairs.push((fields[i].to_vec(), fields[i + 1].to_vec()));
                        }
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                Ok(pairs)
            });
            (unstaged.join(), staged.join(), all.join(), renames.join())
        });
        let unstaged = joined(unstaged)?;
        let staged = joined(staged)?;
        let all_stats = joined(all)?.unwrap_or_else(|| staged.clone());
        let renames: Vec<(Vec<u8>, Vec<u8>)> = joined(renames)?;

        // “全部”范围修正。
        let mut all = state.lists.all.clone();
        for (old, new) in renames {
            let old_id = URL_SAFE_NO_PAD.encode(&old);
            let new_id = URL_SAFE_NO_PAD.encode(&new);
            let old_deleted = all.iter().any(|f| f.path_id == old_id && matches!(f.status, FileStatus::Deleted));
            let new_added = all.iter().position(|f| f.path_id == new_id && matches!(f.status, FileStatus::Added));
            if let (true, Some(position)) = (old_deleted, new_added) {
                all.retain(|f| f.path_id != old_id);
                let position = all.iter().position(|f| f.path_id == new_id).unwrap_or(position);
                all[position].status = FileStatus::Renamed;
                all[position].old_path_id = Some(old_id);
                all[position].old_display_path = Some(String::from_utf8_lossy(&old).into_owned());
            }
        }
        // 双层修改（index 与工作区都改过）且工作区内容回到 HEAD：HEAD → 工作区没有变化。
        all.retain(|f| {
            let Some(entry) = state.entries.get(&f.path_id) else { return true };
            if !matches!(f.status, FileStatus::Modified) || entry.x == b'.' || entry.y == b'.' {
                return true;
            }
            let Some(head) = &entry.head else { return true };
            let Ok(relative) = std::str::from_utf8(&entry.path) else { return true };
            let Ok(worktree) = self.read_worktree(relative, MAX_TEXT_BYTES) else { return true };
            if worktree.len() > MAX_TEXT_BYTES {
                return true;
            }
            match self.reader.with(|r| r.read_blob_limited(&head.oid, MAX_TEXT_BYTES)) {
                Ok(object_reader::BlobRead::Bytes(bytes)) => *bytes != *worktree,
                _ => true,
            }
        });
        let untracked_stats = self.untracked_line_counts(&state.lists.unstaged);
        let collect = |list: &Vec<FileChange>, stats: &HashMap<String, (Option<u64>, Option<u64>)>| {
            list.iter()
                .filter(|f| !matches!(f.status, FileStatus::Conflicted))
                .filter_map(|f| {
                    stats
                        .get(&f.path_id)
                        .or_else(|| untracked_stats.get(&f.path_id))
                        .map(|(a, d)| (f.path_id.clone(), *a, *d))
                })
                .collect::<Vec<_>>()
        };
        let stats = ScopeStats {
            unstaged: collect(&state.lists.unstaged, &unstaged),
            staged: collect(&state.lists.staged, &staged),
            all: collect(&all, &all_stats),
        };
        let content_unchanged = ScopeUnchanged {
            unstaged: self.unchanged_files(state, &state.lists.unstaged, &unstaged, false),
            all: if state.has_head { self.unchanged_files(state, &all, &all_stats, true) } else { Vec::new() },
        };
        let details = Arc::new(RepositoryDetails {
            revision: state.revision.clone(),
            stats,
            all,
            content_unchanged,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
        let _ = state.details.set(details.clone());
        Ok(details)
    }

    /// 工作区相对 index 的修改只由 stat 缓存判定（常见于 autocrlf 下编辑器改写行尾，文件大小变化），
    /// 而 numstat 按规范化内容比较后没有输出：这类文件在列表中标注，而不是显示成无法解释的修改。
    /// `head_scope` 为 true 时比较基准是 HEAD，只接受 index 与 HEAD 相同（X 为 `.`）的条目。
    fn unchanged_files(
        &self,
        state: &ScanState,
        list: &[FileChange],
        stats: &HashMap<String, (Option<u64>, Option<u64>)>,
        head_scope: bool,
    ) -> Vec<(String, UnchangedReason)> {
        list.iter()
            .filter(|f| matches!(f.status, FileStatus::Modified) && !stats.contains_key(&f.path_id))
            .filter_map(|f| {
                let entry = state.entries.get(&f.path_id)?;
                let index = entry.index.as_ref()?;
                let same_mode = entry.worktree_mode.as_deref() == Some(index.mode.as_str());
                if entry.conflict.is_some() || entry.y != b'M' || (head_scope && entry.x != b'.') || !same_mode || index.mode == "160000" {
                    return None;
                }
                Some((f.path_id.clone(), self.unchanged_reason(&entry.path, &index.oid)))
            })
            .collect()
    }

    /// 两侧统一为 LF 后字节一致即为仅行尾变化；读取失败或超出上限时保守归为其他规范化。
    fn unchanged_reason(&self, path: &[u8], oid: &str) -> UnchangedReason {
        let lf = |bytes: &[u8]| -> Vec<u8> {
            let mut out = Vec::with_capacity(bytes.len());
            for (i, b) in bytes.iter().enumerate() {
                if !(*b == b'\r' && bytes.get(i + 1) == Some(&b'\n')) {
                    out.push(*b);
                }
            }
            out
        };
        let Ok(relative) = std::str::from_utf8(path) else { return UnchangedReason::Normalized };
        let Ok(worktree) = self.read_worktree(relative, MAX_TEXT_BYTES) else { return UnchangedReason::Normalized };
        if worktree.len() > MAX_TEXT_BYTES {
            return UnchangedReason::Normalized;
        }
        match self.reader.with(|r| r.read_blob_limited(oid, MAX_TEXT_BYTES)) {
            Ok(object_reader::BlobRead::Bytes(blob)) if lf(&blob) == lf(&worktree) => UnchangedReason::Eol,
            _ => UnchangedReason::Normalized,
        }
    }

    fn empty_tree(&self) -> Result<String, GitError> {
        // hash-object 不带 -w：只计算空树 ID（兼容 SHA-1 / SHA-256 仓库），不写对象库。
        let mut child = readonly_command(&self.git, &self.worktree, &["hash-object", "-t", "tree", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| GitError::GitUnavailable(e.to_string()))?;
        drop(child.stdin.take());
        let output = child.wait_with_output().map_err(|e| GitError::Io(e.to_string()))?;
        if !output.status.success() {
            return Err(GitError::CommandFailed(stderr_summary(&output)));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    /// 与 V1 相同的有界未跟踪文件行数统计：最多 64 个、合计 1 MiB。
    fn untracked_line_counts(&self, files: &[FileChange]) -> HashMap<String, (Option<u64>, Option<u64>)> {
        let mut result = HashMap::new();
        let mut remaining = 1024 * 1024usize;
        for file in files.iter().filter(|f| matches!(f.status, FileStatus::Untracked)).take(64) {
            let Ok(bytes) = URL_SAFE_NO_PAD.decode(&file.path_id) else { continue };
            let Ok(relative) = String::from_utf8(bytes) else { continue };
            let Ok(meta) = fs::symlink_metadata(self.worktree.join(&relative)) else { continue };
            if !meta.is_file() || meta.len() > remaining as u64 {
                continue;
            }
            let Ok(content) = self.read_worktree(&relative, remaining) else { continue };
            if content.len() > remaining {
                break;
            }
            remaining -= content.len();
            if content.len() <= MAX_TEXT_BYTES && !content.contains(&0) {
                let lines = content.iter().filter(|b| **b == b'\n').count() as u64
                    + u64::from(!content.is_empty() && !content.ends_with(b"\n"));
                result.insert(file.path_id.clone(), (Some(lines), Some(0)));
            }
        }
        result
    }
}

/// 允许回写 index stat 缓存的 status 命令：只去掉 `--no-optional-locks`，其余只读参数保持不变。
fn index_refresh_command(git: &Path, cwd: &Path, args: &[&str]) -> Command {
    let mut command = git_command(git);
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("diff.external=")
        .arg("-c")
        .arg("diff.trustExitCode=false")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_EXTERNAL_DIFF", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_LITERAL_PATHSPECS", "1");
    command
}

pub(super) const SCAN_HISTORY: usize = 3;

fn joined<T>(result: std::thread::Result<Result<T, GitError>>) -> Result<T, GitError> {
    result.map_err(|_| GitError::Io("统计线程失败".into()))?
}

impl From<&BranchInfo> for BranchSummary {
    fn from(branch: &BranchInfo) -> Self {
        Self {
            head: branch.head.clone(),
            oid: branch.oid.clone(),
            upstream: branch.upstream.clone(),
            ahead: branch.ahead,
            behind: branch.behind,
        }
    }
}

impl From<&InProgress> for InProgressSummary {
    fn from(state: &InProgress) -> Self {
        Self {
            merge: state.merge,
            rebase: state.rebase,
            cherry_pick: state.cherry_pick,
            revert: state.revert,
            bisect: state.bisect,
        }
    }
}
