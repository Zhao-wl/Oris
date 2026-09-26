//! R-DISCARD 文件级：未暂存范围（已跟踪恢复到 index；未跟踪删除）与“全部”范围（index 与工作区恢复到 HEAD）。
//!
//! 安全网（V2-D13、技术方案 §6“discard 备份”）：丢弃前把工作区内容以 `hash-object -w --no-filters`
//! 写入对象库（原始字节，不经过 filter），暂存内容只记录 OID 与 mode；备份记录写入应用数据目录，
//! 每个仓库最多 20 次。单文件超过 50 MiB 不备份，需明确确认“不可撤销”。gitlink 与冲突文件不丢弃。
use super::*;

pub const BACKUP_FILE_LIMIT: u64 = 50 * 1024 * 1024;
pub const BACKUP_RECORDS_PER_REPO: usize = 20;
/// 撤销时一次 `cat-file --batch` 读取的对象总量上限（受写通道 stdout 捕获上限约束）。
const RESTORE_BATCH_BYTES: u64 = 60 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BlobRef {
    oid: String,
    mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
enum IndexState {
    /// 未暂存范围：不触及 index。
    Untouched,
    /// 丢弃前不在 index 中。
    Absent,
    Present { oid: String, mode: String },
}

/// 文件的可比较状态：用于判断撤销前文件是否在丢弃之后又被修改。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Fingerprint {
    exists: bool,
    sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupEntry {
    path_id: String,
    display_path: String,
    /// 丢弃前的工作区内容；None 表示丢弃前文件不存在。
    worktree: Option<BlobRef>,
    /// 超出单文件备份预算，未备份（不可撤销）。
    unrecoverable: bool,
    index: IndexState,
    /// 丢弃完成后的文件状态。
    after: Option<Fingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRecord {
    id: String,
    created_at: u64,
    scope: CompareScope,
    entries: Vec<BackupEntry>,
    /// 丢弃命令全部执行完成；未完成的记录仍可用于撤销已执行的部分。
    complete: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    version: u32,
    worktree_path: String,
    records: Vec<BackupRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub id: String,
    pub created_at: u64,
    pub scope: CompareScope,
    pub files: usize,
    pub unrecoverable: usize,
    pub paths: Vec<String>,
}

impl From<&BackupRecord> for BackupSummary {
    fn from(record: &BackupRecord) -> Self {
        Self {
            id: record.id.clone(),
            created_at: record.created_at,
            scope: record.scope,
            files: record.entries.len(),
            unrecoverable: record.entries.iter().filter(|e| e.unrecoverable).count(),
            paths: record.entries.iter().take(8).map(|e| e.display_path.clone()).collect(),
        }
    }
}

/// 备份记录存储：应用数据目录下每个仓库一个 JSON 文件，原子替换写入。
pub struct BackupStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl BackupStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, lock: Mutex::new(()) }
    }

    fn file(&self, repo_id: &str) -> PathBuf {
        self.dir.join(format!("{repo_id}.json"))
    }

    fn load(&self, repo_id: &str) -> BackupFile {
        fs::read(self.file(repo_id))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BackupFile>(&bytes).ok())
            .filter(|file| file.version == 1)
            .unwrap_or_default()
    }

    fn store(&self, repo_id: &str, file: &BackupFile) -> Result<(), GitError> {
        fs::create_dir_all(&self.dir).map_err(|e| GitError::Io(format!("无法创建备份目录：{e}")))?;
        let target = self.file(repo_id);
        let temporary = target.with_extension("json.tmp");
        let bytes = serde_json::to_vec(file).map_err(|e| GitError::Io(e.to_string()))?;
        fs::write(&temporary, bytes).map_err(|e| GitError::Io(format!("无法写入备份记录：{e}")))?;
        fs::rename(&temporary, &target).map_err(|e| GitError::Io(format!("无法写入备份记录：{e}")))
    }

    fn upsert(&self, repo_id: &str, worktree: &Path, record: BackupRecord) -> Result<(), GitError> {
        let _guard = self.lock.lock().map_err(|_| GitError::Io("备份记录不可用".into()))?;
        let mut file = self.load(repo_id);
        file.version = 1;
        file.worktree_path = worktree.to_string_lossy().into_owned();
        file.records.retain(|r| r.id != record.id);
        file.records.push(record);
        while file.records.len() > BACKUP_RECORDS_PER_REPO {
            file.records.remove(0);
        }
        self.store(repo_id, &file)
    }

    fn get(&self, repo_id: &str, id: &str) -> Option<BackupRecord> {
        let _guard = self.lock.lock().ok()?;
        self.load(repo_id).records.into_iter().find(|r| r.id == id)
    }

    fn remove(&self, repo_id: &str, id: &str) -> Result<(), GitError> {
        let _guard = self.lock.lock().map_err(|_| GitError::Io("备份记录不可用".into()))?;
        let mut file = self.load(repo_id);
        file.records.retain(|r| r.id != id);
        self.store(repo_id, &file)
    }

    /// 最近的备份记录（新 → 旧）。
    pub fn list(&self, repo_id: &str) -> Vec<BackupSummary> {
        let _guard = self.lock.lock();
        self.load(repo_id).records.iter().rev().map(BackupSummary::from).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    /// 未暂存范围：工作区恢复到 index。
    RestoreWorktree,
    /// “全部”范围：index 与工作区恢复到 HEAD。
    RestoreFromHead,
    /// “全部”范围：HEAD 中没有（index 新增）→ 从 index 移除并删除工作区文件。
    RemoveFromIndex,
    /// 未跟踪文件：删除。
    DeleteUntracked,
}

struct Planned {
    path: Vec<u8>,
    path_id: String,
    action: Action,
    index: IndexState,
    worktree_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedPath {
    pub path: String,
    pub reason: String,
}

/// 丢弃确认框的数据（只读计算）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardPlan {
    pub scope: CompareScope,
    pub files: usize,
    pub untracked: usize,
    pub paths: Vec<String>,
    /// 超出 50 MiB 备份预算、丢弃后不可撤销的文件。
    pub unrecoverable: Vec<String>,
    /// 不能丢弃的条目（gitlink、冲突）及原因。
    pub blocked: Vec<BlockedPath>,
}

impl GitAdapter {
    fn plan_discard(&self, state: &scan::ScanState, scope: CompareScope, path_ids: &[String]) -> Result<(Vec<Planned>, Vec<BlockedPath>), GitError> {
        if scope == CompareScope::Staged {
            return Err(GitError::WriteBlocked("已暂存范围不提供丢弃，请使用取消暂存".into()));
        }
        let rename_sources: HashMap<&str, &status_v2::Entry> = state
            .entries
            .values()
            .filter(|e| matches!(e.x, b'R' | b'C'))
            .filter_map(|e| e.old_path_id.as_deref().map(|id| (id, e)))
            .collect();
        let mut planned: Vec<Planned> = Vec::new();
        let mut blocked = Vec::new();
        let push = |planned: &mut Vec<Planned>, item: Planned| {
            if !planned.iter().any(|p| p.path == item.path) {
                planned.push(item);
            }
        };
        let blob = |stage: &Option<status_v2::Stage>| match stage {
            Some(s) => IndexState::Present { oid: s.oid.clone(), mode: s.mode.clone() },
            None => IndexState::Absent,
        };
        for id in path_ids {
            let path = decode_path_id(id)?;
            if let Some(entry) = state.entries.get(id) {
                let gitlink = [entry.head.as_ref(), entry.index.as_ref()].iter().flatten().any(|s| s.mode == "160000") || entry.worktree_mode.as_deref() == Some("160000");
                if entry.conflict.is_some() {
                    blocked.push(BlockedPath { path: display(&path), reason: "冲突文件不能丢弃；请在合并流程中处理".into() });
                    continue;
                }
                if gitlink {
                    blocked.push(BlockedPath { path: display(&path), reason: "子模块条目（gitlink）不提供丢弃，请在子模块中用命令行处理".into() });
                    continue;
                }
                let mode = entry.worktree_mode.clone().filter(|m| m != "000000");
                if entry.x == b'?' {
                    push(&mut planned, Planned { path, path_id: id.clone(), action: Action::DeleteUntracked, index: IndexState::Untouched, worktree_mode: None });
                    continue;
                }
                match scope {
                    CompareScope::Unstaged => {
                        if entry.y != b'.' {
                            push(&mut planned, Planned { path, path_id: id.clone(), action: Action::RestoreWorktree, index: IndexState::Untouched, worktree_mode: mode });
                        }
                    }
                    _ => {
                        let renamed = matches!(entry.x, b'R' | b'C');
                        if renamed || entry.head.is_none() {
                            push(&mut planned, Planned { path, path_id: id.clone(), action: Action::RemoveFromIndex, index: blob(&entry.index), worktree_mode: mode });
                        } else {
                            push(&mut planned, Planned { path, path_id: id.clone(), action: Action::RestoreFromHead, index: blob(&entry.index), worktree_mode: mode });
                        }
                        // 暂存的 rename：原路径一并恢复到 HEAD（原路径不在 index 中）。
                        if entry.x == b'R' {
                            if let (Some(old), Some(old_id)) = (&entry.old_path, &entry.old_path_id) {
                                push(&mut planned, Planned { path: old.clone(), path_id: old_id.clone(), action: Action::RestoreFromHead, index: IndexState::Absent, worktree_mode: None });
                            }
                        }
                    }
                }
            } else if let (Some(entry), CompareScope::All) = (rename_sources.get(id.as_str()), scope) {
                if entry.x == b'R' {
                    push(&mut planned, Planned { path, path_id: id.clone(), action: Action::RestoreFromHead, index: IndexState::Absent, worktree_mode: None });
                }
            }
            // 其余情况：文件在最新状态中已没有可丢弃的改动，跳过。
        }
        Ok((planned, blocked))
    }

    fn worktree_size(&self, path: &[u8]) -> Option<u64> {
        let relative = std::str::from_utf8(path).ok()?;
        let meta = fs::symlink_metadata(self.worktree.join(relative)).ok()?;
        (meta.is_file() || meta.file_type().is_symlink()).then(|| meta.len())
    }

    /// 丢弃确认框数据：受影响文件数、未跟踪数、不可撤销与不可丢弃的条目。只读（status 使用只读通道）。
    pub fn prepare_discard(&self, scope: CompareScope, path_ids: &[String]) -> Result<DiscardPlan, GitError> {
        let state = self.scan(false)?;
        let (planned, blocked) = self.plan_discard(&state, scope, path_ids)?;
        Ok(DiscardPlan {
            scope,
            files: planned.len(),
            untracked: planned.iter().filter(|p| p.action == Action::DeleteUntracked).count(),
            paths: planned.iter().map(|p| display(&p.path)).collect(),
            unrecoverable: planned.iter().filter(|p| self.worktree_size(&p.path).is_some_and(|size| size > BACKUP_FILE_LIMIT)).map(|p| display(&p.path)).collect(),
            blocked,
        })
    }

    pub fn discard_backups(&self, store: &BackupStore) -> Vec<BackupSummary> {
        store.list(&self.repo_id)
    }

    fn fingerprint(&self, path: &[u8]) -> Fingerprint {
        let Ok(relative) = std::str::from_utf8(path) else { return Fingerprint { exists: false, sha256: None } };
        let full = self.worktree.join(relative);
        let Ok(meta) = fs::symlink_metadata(&full) else { return Fingerprint { exists: false, sha256: None } };
        let sha256 = if meta.file_type().is_symlink() {
            fs::read_link(&full).ok().map(|target| hash_bytes(target.to_string_lossy().as_bytes()))
        } else if meta.is_file() && meta.len() <= BACKUP_FILE_LIMIT {
            fs::read(&full).ok().map(|bytes| hash_bytes(&bytes))
        } else {
            Some(format!("size:{}", meta.len()))
        };
        Fingerprint { exists: true, sha256 }
    }

    /// 把工作区文件（原始字节）写入对象库，返回每个路径的 OID。
    fn backup_worktree(&self, paths: &[&[u8]], ctx: &OpContext) -> Result<Result<Vec<String>, String>, GitError> {
        let mut oids = vec![String::new(); paths.len()];
        let mut batch_index = Vec::new();
        let mut batch_input = Vec::new();
        for (i, path) in paths.iter().enumerate() {
            let relative = std::str::from_utf8(path).map_err(|_| GitError::UnsupportedPathEncoding)?;
            let full = self.worktree.join(relative);
            let meta = fs::symlink_metadata(&full).map_err(|e| GitError::Io(e.to_string()))?;
            if meta.file_type().is_symlink() || path.contains(&b'\n') || path.ends_with(b"\r") {
                // 符号链接备份链接目标本身；含换行的路径不能走 --stdin-paths。
                let bytes = if meta.file_type().is_symlink() {
                    fs::read_link(&full).map_err(|e| GitError::Io(e.to_string()))?.to_string_lossy().into_owned().into_bytes()
                } else {
                    fs::read(&full).map_err(|e| GitError::Io(e.to_string()))?
                };
                let result = self.write_git(&["hash-object", "-w", "--no-filters", "--stdin"], Some(bytes), false, ctx)?;
                if !result.success {
                    return Ok(Err(Self::failure_message(&result, "备份")));
                }
                oids[i] = String::from_utf8_lossy(&result.stdout).trim().to_owned();
            } else {
                batch_index.push(i);
                batch_input.extend_from_slice(path);
                batch_input.push(b'\n');
            }
        }
        if !batch_index.is_empty() {
            let result = self.write_git(&["hash-object", "-w", "--no-filters", "--stdin-paths"], Some(batch_input), false, ctx)?;
            if !result.success {
                return Ok(Err(Self::failure_message(&result, "备份")));
            }
            let lines: Vec<String> = String::from_utf8_lossy(&result.stdout).lines().map(|l| l.trim().to_owned()).collect();
            if lines.len() != batch_index.len() {
                return Ok(Err("备份失败：hash-object 输出与文件数不一致".into()));
            }
            for (slot, oid) in batch_index.into_iter().zip(lines) {
                oids[slot] = oid;
            }
        }
        Ok(Ok(oids))
    }

    /// 删除工作区中的一个路径：不跟随上级目录中的符号链接，符号链接只删除链接本身；随后清理因此变空的上级目录。
    fn remove_worktree_path(&self, path: &[u8]) -> Result<(), GitError> {
        let relative = std::str::from_utf8(path).map_err(|_| GitError::UnsupportedPathEncoding)?;
        validate_relative(relative)?;
        let full = self.checked_worktree_path(relative)?;
        let meta = match fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(_) => return Ok(()),
        };
        if meta.file_type().is_symlink() {
            fs::remove_file(&full).or_else(|_| fs::remove_dir(&full)).map_err(|e| GitError::Io(e.to_string()))?;
        } else if meta.is_file() {
            fs::remove_file(&full).map_err(|e| GitError::Io(format!("无法删除 {relative}：{e}")))?;
        } else {
            return Err(GitError::Io(format!("{relative} 是目录，未删除")));
        }
        let mut parent = full.parent();
        while let Some(dir) = parent {
            if dir == self.worktree || !dir.starts_with(&self.worktree) || fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
        Ok(())
    }

    /// 工作区内的绝对路径；上级目录中不允许出现符号链接（防止越过仓库边界）。
    fn checked_worktree_path(&self, relative: &str) -> Result<PathBuf, GitError> {
        let mut path = self.worktree.clone();
        let components: Vec<_> = Path::new(relative).components().collect();
        for (i, component) in components.iter().enumerate() {
            path.push(component);
            if i + 1 < components.len() {
                if let Ok(meta) = fs::symlink_metadata(&path) {
                    if meta.file_type().is_symlink() {
                        return Err(GitError::UnsafePath);
                    }
                }
            }
        }
        Ok(path)
    }

    pub(super) fn op_discard(&self, scope: CompareScope, path_ids: &[String], confirmed_unrecoverable: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let state = self.scan(false)?;
        let (planned, blocked) = self.plan_discard(&state, scope, path_ids)?;
        if !blocked.is_empty() {
            return Ok(Step::failed(format!(
                "以下条目不能丢弃：{}",
                blocked.iter().map(|b| format!("{}（{}）", b.path, b.reason)).collect::<Vec<_>>().join("；")
            )));
        }
        if planned.is_empty() {
            return Ok(Step::failed("所选文件已没有可丢弃的改动"));
        }
        let sizes: Vec<Option<u64>> = planned.iter().map(|p| self.worktree_size(&p.path)).collect();
        let over: Vec<String> = planned.iter().zip(&sizes).filter(|(_, s)| s.is_some_and(|s| s > BACKUP_FILE_LIMIT)).map(|(p, _)| display(&p.path)).collect();
        if !over.is_empty() && !confirmed_unrecoverable {
            return Ok(Step::confirm("unrecoverable", format!("{} 个文件超过 50 MiB 备份预算，丢弃后不可撤销", over.len()), over));
        }
        // 1. 备份：工作区原始字节写入对象库。
        let to_backup: Vec<usize> = (0..planned.len()).filter(|&i| sizes[i].is_some_and(|s| s <= BACKUP_FILE_LIMIT)).collect();
        let paths: Vec<&[u8]> = to_backup.iter().map(|&i| planned[i].path.as_slice()).collect();
        let oids = match self.backup_worktree(&paths, ctx)? {
            Ok(oids) => oids,
            Err(message) => return Ok(Step::failed(format!("{message}；未丢弃任何文件"))),
        };
        if ctx.cancel.is_cancelled() {
            return Ok(Step::cancelled("丢弃已取消；未丢弃任何文件"));
        }
        let mut entries: Vec<BackupEntry> = planned
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let worktree = to_backup.iter().position(|&j| j == i).map(|k| {
                    let symlink = std::str::from_utf8(&p.path).ok().and_then(|r| fs::symlink_metadata(self.worktree.join(r)).ok()).is_some_and(|m| m.file_type().is_symlink());
                    let mode = if symlink { "120000".to_owned() } else { p.worktree_mode.clone().filter(|m| m == "100755").unwrap_or_else(|| executable_mode(&self.worktree, &p.path)) };
                    BlobRef { oid: oids[k].clone(), mode }
                });
                BackupEntry {
                    path_id: p.path_id.clone(),
                    display_path: display(&p.path),
                    worktree,
                    unrecoverable: sizes[i].is_some_and(|s| s > BACKUP_FILE_LIMIT),
                    index: p.index.clone(),
                    after: None,
                }
            })
            .collect();
        let record_id = ctx.op_id.clone();
        let mut record = BackupRecord { id: record_id, created_at: now_ms(), scope, entries: entries.clone(), complete: false };
        // 2. 先落盘备份记录，再执行破坏性命令。
        ctx.backups.upsert(&self.repo_id, &self.worktree, record.clone())?;
        // 3. 丢弃。
        let group = |action: Action| planned.iter().filter(|p| p.action == action).map(|p| p.path.clone()).collect::<Vec<_>>();
        let mut failure: Option<String> = None;
        let mut cancelled = false;
        let restore_worktree = group(Action::RestoreWorktree);
        let restore_head = group(Action::RestoreFromHead);
        let remove_index = group(Action::RemoveFromIndex);
        let commands: [(&[&str], &Vec<Vec<u8>>); 3] = [
            (&["restore", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], &restore_worktree),
            (&["restore", "--source=HEAD", "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], &restore_head),
            (&["rm", "--cached", "-f", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], &remove_index),
        ];
        for (args, paths) in commands {
            if paths.is_empty() || failure.is_some() || cancelled {
                continue;
            }
            let result = self.write_git(args, Some(nul_list(paths)), true, ctx)?;
            if result.cancelled {
                cancelled = true;
            } else if !result.success {
                failure = Some(Self::failure_message(&result, "丢弃"));
            }
        }
        if failure.is_none() && !cancelled {
            for p in planned.iter().filter(|p| matches!(p.action, Action::RemoveFromIndex | Action::DeleteUntracked)) {
                if let Err(error) = self.remove_worktree_path(&p.path) {
                    failure = Some(format!("丢弃失败：{error}"));
                    break;
                }
            }
        }
        // 4. 记录丢弃后的状态（撤销时据此判断文件是否又被修改）。
        for (entry, p) in entries.iter_mut().zip(&planned) {
            entry.after = Some(self.fingerprint(&p.path));
        }
        record.entries = entries;
        record.complete = failure.is_none() && !cancelled;
        ctx.backups.upsert(&self.repo_id, &self.worktree, record.clone())?;
        let mut step = if cancelled {
            Step::cancelled("丢弃已取消；已执行的部分可以撤销")
        } else if let Some(message) = failure {
            Step::failed(format!("{message}；已执行的部分可以撤销"))
        } else {
            let unrecoverable = record.entries.iter().filter(|e| e.unrecoverable).count();
            Step::ok(if unrecoverable > 0 {
                format!("已丢弃 {} 个文件（其中 {unrecoverable} 个不可撤销）", planned.len())
            } else {
                format!("已丢弃 {} 个文件，可撤销", planned.len())
            })
        };
        step.backup = Some(BackupSummary::from(&record));
        step.touched = planned.iter().map(|p| display(&p.path)).collect();
        Ok(step)
    }

    /// 块级丢弃（V2-05）的安全网：先把整个工作区文件（原始字节）写入对象库并记录，再执行 `run`；
    /// 撤销时与文件级丢弃相同，恢复整个文件。超过 50 MiB 备份预算时需要明确确认“不可撤销”。
    pub(super) fn with_worktree_backup(&self, path: &[u8], path_id: &str, confirmed_unrecoverable: bool, ctx: &OpContext, run: impl FnOnce(&OpContext) -> Result<Step, GitError>) -> Result<Step, GitError> {
        let size = self.worktree_size(path);
        let unrecoverable = size.is_some_and(|s| s > BACKUP_FILE_LIMIT);
        if unrecoverable && !confirmed_unrecoverable {
            return Ok(Step::confirm("unrecoverable", "文件超过 50 MiB 备份预算，丢弃这一块后不可撤销", vec![display(path)]));
        }
        let worktree = if unrecoverable {
            None
        } else {
            let oids = match self.backup_worktree(&[path], ctx)? {
                Ok(oids) => oids,
                Err(message) => return Ok(Step::failed(format!("{message}；未丢弃"))),
            };
            let mode = std::str::from_utf8(path).ok().and_then(|r| fs::symlink_metadata(self.worktree.join(r)).ok()).filter(|m| m.file_type().is_symlink()).map(|_| "120000".to_owned()).unwrap_or_else(|| executable_mode(&self.worktree, path));
            Some(BlobRef { oid: oids[0].clone(), mode })
        };
        if ctx.cancel.is_cancelled() {
            return Ok(Step::cancelled("丢弃已取消；未改动文件"));
        }
        let mut record = BackupRecord {
            id: ctx.op_id.clone(),
            created_at: now_ms(),
            scope: CompareScope::Unstaged,
            entries: vec![BackupEntry { path_id: path_id.to_owned(), display_path: display(path), worktree, unrecoverable, index: IndexState::Untouched, after: None }],
            complete: false,
        };
        ctx.backups.upsert(&self.repo_id, &self.worktree, record.clone())?;
        let mut step = run(ctx)?;
        if step.status == OpStatus::Succeeded {
            record.entries[0].after = Some(self.fingerprint(path));
            record.complete = true;
            ctx.backups.upsert(&self.repo_id, &self.worktree, record.clone())?;
            step.message.push_str(if unrecoverable { "（不可撤销）" } else { "，可撤销" });
            step.backup = Some(BackupSummary::from(&record));
        } else {
            // git apply 要么整体成功、要么不改动文件：没有成功时删除这条备份记录，避免出现无意义的“撤销丢弃”。
            ctx.backups.remove(&self.repo_id, &record.id)?;
        }
        Ok(step)
    }

    pub(super) fn op_undo_discard(&self, backup_id: &str, overwrite: bool, ctx: &OpContext) -> Result<Step, GitError> {
        let Some(record) = ctx.backups.get(&self.repo_id, backup_id) else {
            return Ok(Step::failed("找不到该丢弃记录（可能已撤销或超出保留数量）"));
        };
        let paths: Vec<Vec<u8>> = record.entries.iter().map(|e| decode_path_id(&e.path_id)).collect::<Result<_, _>>()?;
        // 丢弃之后又被修改的文件：再次确认覆盖。
        if !overwrite {
            let modified: Vec<String> = record
                .entries
                .iter()
                .zip(&paths)
                .filter(|(e, p)| e.after.as_ref().is_some_and(|after| *after != self.fingerprint(p)))
                .map(|(e, _)| e.display_path.clone())
                .collect();
            if !modified.is_empty() {
                return Ok(Step::confirm("modifiedSinceDiscard", format!("{} 个文件在丢弃之后又被修改，撤销会覆盖这些修改", modified.len()), modified));
            }
        }
        // 对象仍然存在（未被 gc 清理）。
        let mut wanted: Vec<String> = Vec::new();
        for entry in &record.entries {
            if let Some(blob) = entry.worktree.as_ref().filter(|_| !entry.unrecoverable) {
                wanted.push(blob.oid.clone());
            }
            if let IndexState::Present { oid, .. } = &entry.index {
                wanted.push(oid.clone());
            }
        }
        wanted.sort();
        wanted.dedup();
        let mut sizes: HashMap<String, u64> = HashMap::new();
        if !wanted.is_empty() {
            let input = wanted.iter().flat_map(|o| format!("{o}\n").into_bytes()).collect();
            let check = self.write_git(&["cat-file", "--batch-check"], Some(input), false, ctx)?;
            if !check.success {
                return Ok(Step::failed(Self::failure_message(&check, "检查备份对象")));
            }
            let mut missing = Vec::new();
            for line in String::from_utf8_lossy(&check.stdout).lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                match parts.as_slice() {
                    [oid, "blob", size] => {
                        sizes.insert((*oid).to_owned(), size.parse().unwrap_or(0));
                    }
                    [oid, ..] => missing.push((*oid).to_owned()),
                    _ => {}
                }
            }
            if !missing.is_empty() || sizes.len() != wanted.len() {
                let lost: Vec<String> = record
                    .entries
                    .iter()
                    .filter(|e| e.worktree.as_ref().is_some_and(|b| !sizes.contains_key(&b.oid)) || matches!(&e.index, IndexState::Present { oid, .. } if !sizes.contains_key(oid)))
                    .map(|e| e.display_path.clone())
                    .collect();
                return Ok(Step::failed(format!("备份对象已不存在（可能已被 git gc 清理），无法撤销：{}", lost.join("、"))));
            }
        }
        // 读取备份内容（分批，避免超出捕获上限）。
        let mut contents: HashMap<String, Vec<u8>> = HashMap::new();
        let worktree_oids: Vec<String> = {
            let mut list: Vec<String> = record.entries.iter().filter(|e| !e.unrecoverable).filter_map(|e| e.worktree.as_ref().map(|b| b.oid.clone())).collect();
            list.sort();
            list.dedup();
            list
        };
        let mut batch: Vec<String> = Vec::new();
        let mut batch_bytes = 0u64;
        let flush = |batch: &mut Vec<String>, contents: &mut HashMap<String, Vec<u8>>| -> Result<Option<String>, GitError> {
            if batch.is_empty() {
                return Ok(None);
            }
            let input = batch.iter().flat_map(|o| format!("{o}\n").into_bytes()).collect();
            let result = self.write_git(&["cat-file", "--batch"], Some(input), false, ctx)?;
            if !result.success {
                return Ok(Some(Self::failure_message(&result, "读取备份")));
            }
            let mut rest = result.stdout.as_slice();
            for oid in batch.drain(..) {
                let Some(newline) = rest.iter().position(|b| *b == b'\n') else { return Ok(Some("读取备份失败：输出不完整".into())) };
                let header = String::from_utf8_lossy(&rest[..newline]).into_owned();
                let size: usize = header.rsplit(' ').next().and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
                rest = &rest[newline + 1..];
                if rest.len() < size + 1 {
                    return Ok(Some("读取备份失败：输出不完整".into()));
                }
                contents.insert(oid, rest[..size].to_vec());
                rest = &rest[size + 1..];
            }
            Ok(None)
        };
        for oid in worktree_oids {
            let size = sizes.get(&oid).copied().unwrap_or(0);
            if batch_bytes + size > RESTORE_BATCH_BYTES {
                if let Some(message) = flush(&mut batch, &mut contents)? {
                    return Ok(Step::failed(message));
                }
                batch_bytes = 0;
            }
            batch_bytes += size;
            batch.push(oid);
        }
        if let Some(message) = flush(&mut batch, &mut contents)? {
            return Ok(Step::failed(message));
        }
        if ctx.cancel.is_cancelled() {
            return Ok(Step::cancelled("撤销丢弃已取消；未改动任何文件"));
        }
        // 1. 恢复暂存内容（“全部”范围）：update-index --index-info，mode 0 表示从 index 移除。
        let zero = "0".repeat(self.head_oid().ok().flatten().map(|o| o.len()).unwrap_or(40));
        let mut index_info = Vec::new();
        for (entry, path) in record.entries.iter().zip(&paths) {
            match &entry.index {
                IndexState::Untouched => {}
                IndexState::Absent => index_info.extend_from_slice(format!("0 {zero}\t").as_bytes()),
                IndexState::Present { oid, mode } => index_info.extend_from_slice(format!("{mode} {oid}\t").as_bytes()),
            }
            if !matches!(entry.index, IndexState::Untouched) {
                index_info.extend_from_slice(path);
                index_info.push(0);
            }
        }
        if !index_info.is_empty() {
            let result = self.write_git(&["update-index", "-z", "--index-info"], Some(index_info), true, ctx)?;
            if result.cancelled {
                return Ok(Step::cancelled("撤销丢弃已取消"));
            }
            if !result.success {
                return Ok(Step::failed(Self::failure_message(&result, "恢复暂存内容")));
            }
        }
        // 2. 恢复工作区内容（原始字节）。
        let mut skipped = Vec::new();
        for (entry, path) in record.entries.iter().zip(&paths) {
            if entry.unrecoverable {
                skipped.push(entry.display_path.clone());
                continue;
            }
            let relative = std::str::from_utf8(path).map_err(|_| GitError::UnsupportedPathEncoding)?;
            match &entry.worktree {
                None => self.remove_worktree_path(path)?,
                Some(blob) => {
                    let bytes = contents.get(&blob.oid).ok_or_else(|| GitError::Io("备份内容缺失".into()))?;
                    self.write_worktree_file(relative, bytes, &blob.mode)?;
                }
            }
        }
        ctx.backups.remove(&self.repo_id, backup_id)?;
        let mut step = Step::ok(if skipped.is_empty() {
            format!("已撤销丢弃，恢复 {} 个文件", record.entries.len())
        } else {
            format!("已撤销丢弃；{} 个文件超出备份预算未能恢复：{}", skipped.len(), skipped.join("、"))
        });
        step.touched = record.entries.iter().map(|e| e.display_path.clone()).collect();
        Ok(step)
    }

    fn write_worktree_file(&self, relative: &str, bytes: &[u8], mode: &str) -> Result<(), GitError> {
        validate_relative(relative)?;
        let full = self.checked_worktree_path(relative)?;
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| GitError::Io(format!("无法创建目录：{e}")))?;
        }
        if let Ok(meta) = fs::symlink_metadata(&full) {
            if meta.file_type().is_symlink() {
                fs::remove_file(&full).or_else(|_| fs::remove_dir(&full)).map_err(|e| GitError::Io(e.to_string()))?;
            } else if meta.is_dir() {
                return Err(GitError::Io(format!("{relative} 现在是目录，无法恢复")));
            }
        }
        #[cfg(unix)]
        if mode == "120000" {
            let target = std::ffi::OsStr::new(std::str::from_utf8(bytes).unwrap_or_default());
            return std::os::unix::fs::symlink(target, &full).map_err(|e| GitError::Io(e.to_string()));
        }
        fs::write(&full, bytes).map_err(|e| GitError::Io(format!("无法写入 {relative}：{e}")))?;
        #[cfg(unix)]
        if mode == "100755" {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&full, fs::Permissions::from_mode(0o755));
        }
        #[cfg(not(unix))]
        let _ = mode;
        Ok(())
    }
}

fn executable_mode(worktree: &Path, path: &[u8]) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(relative) = std::str::from_utf8(path) {
            if let Ok(meta) = fs::metadata(worktree.join(relative)) {
                if meta.permissions().mode() & 0o111 != 0 {
                    return "100755".into();
                }
            }
        }
    }
    let _ = (worktree, path);
    "100644".into()
}
