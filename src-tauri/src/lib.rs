mod git;
mod snapshot_store;
#[cfg(any(test, feature = "desktop"))]
mod watch;

#[cfg(feature = "desktop")]
use git::{ops, CompareScope, ConflictVersion, GitAdapter, GitError, RepositoryDetails, RepositorySnapshot};
#[cfg(feature = "desktop")]
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager, State};

/// 每仓库的工作区读取并发上限（技术方案 §5.2）。
#[cfg(any(test, feature = "desktop"))]
const WORKTREE_READ_CONCURRENCY: usize = 2;

/// 简单计数信号量：限制同一仓库同时进行的内容读取数。
#[cfg(any(test, feature = "desktop"))]
#[derive(Default)]
struct ReadSlots {
    used: std::sync::Mutex<usize>,
    freed: std::sync::Condvar,
}
#[cfg(any(test, feature = "desktop"))]
impl ReadSlots {
    fn acquire(&self) -> SlotGuard<'_> {
        let mut used = self.used.lock().unwrap_or_else(|p| p.into_inner());
        while *used >= WORKTREE_READ_CONCURRENCY {
            used = self.freed.wait(used).unwrap_or_else(|p| p.into_inner());
        }
        *used += 1;
        SlotGuard(self)
    }
}
#[cfg(any(test, feature = "desktop"))]
struct SlotGuard<'a>(&'a ReadSlots);
#[cfg(any(test, feature = "desktop"))]
impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        *self.0.used.lock().unwrap_or_else(|p| p.into_inner()) -= 1;
        self.0.freed.notify_one();
    }
}

#[cfg(feature = "desktop")]
#[derive(Clone)]
struct OpenRepository {
    adapter: GitAdapter,
    /// 每仓库独立的读取代次：新的（非预取）读取使同仓库的旧读取失效，不影响其他仓库。
    generation: Arc<AtomicU64>,
    slots: Arc<ReadSlots>,
    /// 历史类读取（任务 04）按种类各自的代次：同种类的新请求使旧请求过期，不影响本地变化的读取。
    history: Arc<[AtomicU64; HISTORY_KINDS]>,
}

#[cfg(feature = "desktop")]
const HISTORY_KINDS: usize = 8;

/// 历史类只读请求的种类（各自独立的代次）。
#[cfg(feature = "desktop")]
#[derive(Clone, Copy)]
enum HistoryKind {
    Log = 0,
    Commit = 1,
    Compare = 2,
    FileHistory = 3,
    Refs = 4,
    Content = 5,
    StashList = 6,
    StashChanges = 7,
}

/// 在后台线程执行一个历史类读取；`fresh` 为 true 时使同种类的旧请求过期（分页续读传 false，沿用当前代次）。
#[cfg(feature = "desktop")]
async fn history_call<T: Send + 'static>(
    opened: OpenRepository,
    kind: HistoryKind,
    fresh: bool,
    work: impl FnOnce(&GitAdapter, &dyn Fn() -> bool) -> Result<T, GitError> + Send + 'static,
) -> Result<T, GitError> {
    let index = kind as usize;
    let generation = if fresh { opened.history[index].fetch_add(1, Ordering::SeqCst) + 1 } else { opened.history[index].load(Ordering::SeqCst) };
    tauri::async_runtime::spawn_blocking(move || {
        let stale = || opened.history[index].load(Ordering::SeqCst) != generation;
        if stale() {
            return Err(GitError::StaleRequest);
        }
        let result = work(&opened.adapter, &stale)?;
        if stale() {
            return Err(GitError::StaleRequest);
        }
        Ok(result)
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))?
}

#[cfg(feature = "desktop")]
#[derive(Default)]
struct RepositoryRegistry(Mutex<HashMap<String, OpenRepository>>);

#[cfg(feature = "desktop")]
#[derive(Default)]
struct WatcherRegistry(Mutex<watch::WatchLru>);

#[cfg(feature = "desktop")]
struct Snapshots(snapshot_store::SnapshotStore);

/// discard 备份记录（应用数据目录，技术方案 §6）。
#[cfg(feature = "desktop")]
struct Backups(ops::BackupStore);

/// 写操作结束后识别自身回声事件的尾窗口（覆盖 200 ms 合并窗口内迟到的事件）；窗口内只跳过修改时间不晚于操作结束的事件。
#[cfg(feature = "desktop")]
const OPERATION_ECHO_TAIL: std::time::Duration = std::time::Duration::from_millis(1500);

#[cfg(feature = "desktop")]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationLine {
    repo_id: String,
    op_id: String,
    line: String,
}

#[cfg(feature = "desktop")]
fn start_watcher(app: &tauri::AppHandle, adapter: &GitAdapter) -> Result<watch::RepoWatcher, GitError> {
    let (git_dir, common_dir) = adapter.git_dirs();
    let emitter = app.clone();
    watch::watch(
        watch::WatchTarget {
            repo_id: adapter.repo_id().to_owned(),
            worktree: adapter.worktree().to_path_buf(),
            git_dir,
            common_dir,
            tracked_ignored: {
                let adapter = adapter.clone();
                Box::new(move || adapter.tracked_ignored_paths())
            },
        },
        watch::DEBOUNCE,
        move |change| {
            let _ = emitter.emit("repository-invalidated", change);
        },
    )
    .map_err(GitError::Runtime)
}

/// 确保项目有 watcher（LRU 最多 5 个）；返回调用前 watcher 是否仍在。
#[cfg(feature = "desktop")]
fn ensure_watcher(app: &tauri::AppHandle, watchers: &WatcherRegistry, adapter: &GitAdapter) -> Result<bool, GitError> {
    let mut lru = watchers.0.lock().map_err(|_| GitError::Registry)?;
    if lru.touch(adapter.repo_id()) {
        return Ok(true);
    }
    drop(lru);
    let watcher = start_watcher(app, adapter)?;
    watchers.0.lock().map_err(|_| GitError::Registry)?.insert(adapter.repo_id(), watcher);
    Ok(false)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn open_repository(
    path: String,
    scope: CompareScope,
    git_executable: Option<String>,
    request_id: String,
    registry: State<'_, RepositoryRegistry>,
    watchers: State<'_, WatcherRegistry>,
    app: tauri::AppHandle,
) -> Result<RepositorySnapshot, GitError> {
    let (adapter, snapshot) = tauri::async_runtime::spawn_blocking(move || {
        let adapter = GitAdapter::open(path, git_executable)?;
        let snapshot = adapter.snapshot_v2(request_id, scope, false)?;
        Ok::<_, GitError>((adapter, snapshot))
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))??;
    let repo_id = snapshot.repo.repo_id.clone();
    {
        let mut repositories = registry.0.lock().map_err(|_| GitError::Registry)?;
        if let Some(previous) = repositories.remove(&repo_id) {
            previous.adapter.close();
            previous.generation.fetch_add(1, Ordering::SeqCst);
        }
        repositories.insert(
            repo_id.clone(),
            OpenRepository { adapter: adapter.clone(), generation: Arc::default(), slots: Arc::default(), history: Arc::default() },
        );
    }
    watchers.0.lock().map_err(|_| GitError::Registry)?.remove(&repo_id);
    ensure_watcher(&app, &watchers, &adapter)?;
    Ok(snapshot)
}

#[cfg(feature = "desktop")]
fn opened(registry: &RepositoryRegistry, repo_id: &str) -> Result<OpenRepository, GitError> {
    registry
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .get(repo_id)
        .cloned()
        .ok_or(GitError::UnknownRepository)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn refresh_repository(
    repo_id: String,
    scope: CompareScope,
    request_id: String,
    manual: Option<bool>,
    registry: State<'_, RepositoryRegistry>,
    watchers: State<'_, WatcherRegistry>,
) -> Result<RepositorySnapshot, GitError> {
    let opened = opened(&registry, &repo_id)?;
    let manual = manual.unwrap_or(false);
    if manual {
        // 手动刷新允许 status 回写 index stat 缓存（V2-D09）；由此产生的 index 事件在短窗口内跳过。
        if let Some(watcher) = watchers.0.lock().map_err(|_| GitError::Registry)?.get(&repo_id) {
            watcher.suppression.index_for(std::time::Duration::from_millis(2500));
        }
    }
    tauri::async_runtime::spawn_blocking(move || opened.adapter.snapshot_v2(request_id, scope, manual))
        .await
        .map_err(|error| GitError::Runtime(error.to_string()))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn repository_details(
    repo_id: String,
    revision: String,
    registry: State<'_, RepositoryRegistry>,
) -> Result<RepositoryDetails, GitError> {
    let opened = opened(&registry, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || opened.adapter.details(&revision))
        .await
        .map_err(|error| GitError::Runtime(error.to_string()))?
}

/// 切到前台的项目：刷新 watcher 的 LRU 顺序；watcher 已被淘汰时重建并返回 false（前端需完整刷新）。
#[cfg(feature = "desktop")]
#[tauri::command]
fn activate_repository(
    repo_id: String,
    registry: State<'_, RepositoryRegistry>,
    watchers: State<'_, WatcherRegistry>,
    app: tauri::AppHandle,
) -> Result<bool, GitError> {
    let opened = opened(&registry, &repo_id)?;
    ensure_watcher(&app, &watchers, &opened.adapter)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn close_repository(
    repo_id: String,
    registry: State<'_, RepositoryRegistry>,
    watchers: State<'_, WatcherRegistry>,
) -> Result<(), GitError> {
    if let Some(opened) = registry.0.lock().map_err(|_| GitError::Registry)?.remove(&repo_id) {
        opened.generation.fetch_add(1, Ordering::SeqCst);
        opened.adapter.close();
    }
    watchers.0.lock().map_err(|_| GitError::Registry)?.remove(&repo_id);
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn read_content_pair(
    repo_id: String,
    scope: CompareScope,
    revision: String,
    path_id: String,
    git_executable: Option<String>,
    request_id: String,
    versions: Option<[ConflictVersion; 2]>,
    prefetch: Option<bool>,
    registry: State<'_, RepositoryRegistry>,
) -> Result<tauri::ipc::Response, GitError> {
    let opened = opened(&registry, &repo_id)?;
    if let Some(requested) = git_executable {
        if requested != opened.adapter.git_executable_display() {
            return Err(GitError::GitChanged);
        }
    }
    let prefetch = prefetch.unwrap_or(false);
    // 预取不使正在进行的读取失效；用户选择的新读取会让同仓库的旧读取与预取停止。
    let generation = if prefetch {
        opened.generation.load(Ordering::SeqCst)
    } else {
        opened.generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = opened.slots.acquire();
        let current = || opened.generation.load(Ordering::SeqCst) != generation;
        if current() {
            return Err(GitError::StaleRequest);
        }
        if prefetch && !opened.adapter.prefetch_allowed(scope, &revision, &path_id, git::PREFETCH_LIMIT)? {
            return Err(GitError::Skipped("超过预取上限或不是文本".into()));
        }
        let pair = opened
            .adapter
            .read_content_pair_cancellable(request_id, scope, revision, path_id, versions, current)?;
        if current() {
            return Err(GitError::StaleRequest);
        }
        Ok(tauri::ipc::Response::new(pair.encode_frame()))
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn cancel_content_read(repo_id: Option<String>, registry: State<'_, RepositoryRegistry>) -> Result<(), GitError> {
    let repositories = registry.0.lock().map_err(|_| GitError::Registry)?;
    for (id, opened) in repositories.iter() {
        if repo_id.as_deref().is_none_or(|wanted| wanted == id) {
            opened.generation.fetch_add(1, Ordering::SeqCst);
        }
    }
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn validate_git(executable: Option<String>) -> Result<git::GitValidation, GitError> {
    tauri::async_runtime::spawn_blocking(move || git::validate_git(executable))
        .await
        .map_err(|error| GitError::Runtime(error.to_string()))
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn save_snapshot(worktree_path: String, json: String, store: State<'_, Snapshots>) -> Result<bool, GitError> {
    store
        .0
        .save(&worktree_path, json.as_bytes())
        .map(|outcome| outcome == snapshot_store::SaveOutcome::Saved)
        .map_err(|error| GitError::Io(error.to_string()))
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn load_snapshot(worktree_path: String, store: State<'_, Snapshots>) -> Option<String> {
    store.0.load(&worktree_path).and_then(|bytes| String::from_utf8(bytes).ok())
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn remove_snapshot(worktree_path: String, store: State<'_, Snapshots>) {
    store.0.remove(&worktree_path);
}

/// 执行一个写操作（R-OPSAFE）：仓库级写锁（忙时直接拒绝）、watcher 屏蔽窗口、输出逐行推送、结束后精确刷新。
#[cfg(feature = "desktop")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_operation(
    repo_id: String,
    scope: CompareScope,
    op_id: String,
    request: ops::OperationRequest,
    registry: State<'_, RepositoryRegistry>,
    watchers: State<'_, WatcherRegistry>,
    runner: State<'_, ops::Runner>,
    app: tauri::AppHandle,
) -> Result<ops::OperationOutcome, GitError> {
    let opened = opened(&registry, &repo_id)?;
    let guard = runner.begin(&repo_id)?;
    let suppression = watchers.0.lock().map_err(|_| GitError::Registry)?.get(&repo_id).map(|w| w.suppression.clone());
    if let Some(suppression) = &suppression {
        suppression.begin_operation();
    }
    let runner = runner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let backups = app.state::<Backups>();
        let emitter = app.clone();
        let (line_repo, line_op) = (repo_id.clone(), op_id.clone());
        let sink = move |line: &str| {
            let _ = emitter.emit("operation-output", OperationLine { repo_id: line_repo.clone(), op_id: line_op.clone(), line: line.to_owned() });
        };
        let ctx = ops::OpContext::new(op_id, guard.cancel.clone(), &backups.0, &sink);
        let outcome = opened.adapter.run_operation(request, scope, &ctx);
        if let Some(suppression) = &suppression {
            let touched = outcome.as_ref().map(|o| o.touched.clone()).unwrap_or_default();
            suppression.end_operation(opened.adapter.worktree(), touched, OPERATION_ECHO_TAIL);
        }
        drop(guard);
        if let Ok(outcome) = &outcome {
            runner.record(outcome);
        }
        outcome
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))?
}

/// 取消该仓库正在运行的写操作（终止整个进程树）；返回是否有操作被取消。
#[cfg(feature = "desktop")]
#[tauri::command]
fn cancel_operation(repo_id: String, runner: State<'_, ops::Runner>) -> bool {
    runner.cancel(&repo_id)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn last_operation(repo_id: String, runner: State<'_, ops::Runner>) -> Option<ops::LastOperation> {
    runner.last(&repo_id)
}

/// 提交历史的一页（R-HISTORY）：第一页按查询固定起点 OID，续读传回上一页的游标。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn read_log(repo_id: String, query: git::log::LogQuery, cursor: Option<git::log::LogCursor>, registry: State<'_, RepositoryRegistry>) -> Result<git::log::LogPage, GitError> {
    let opened = opened(&registry, &repo_id)?;
    let fresh = cursor.is_none();
    history_call(opened, HistoryKind::Log, fresh, move |adapter, _| adapter.history_log(&query, cursor.as_ref())).await
}

/// 某个提交相对所选父节点（默认第一个；根提交相对空树）的变化文件。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn commit_changes(repo_id: String, commit: String, parent: Option<String>, registry: State<'_, RepositoryRegistry>) -> Result<git::log::CommitChanges, GitError> {
    let opened = opened(&registry, &repo_id)?;
    history_call(opened, HistoryKind::Commit, true, move |adapter, _| adapter.history_commit(&commit, parent.as_deref())).await
}

/// 两个端点直接比较（非共同基线），端点解析为 OID 后固定。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn compare_revisions(repo_id: String, left: String, right: String, registry: State<'_, RepositoryRegistry>) -> Result<git::log::Comparison, GitError> {
    let opened = opened(&registry, &repo_id)?;
    history_call(opened, HistoryKind::Compare, true, move |adapter, _| adapter.history_compare(&left, &right)).await
}

/// 单文件历史（`--follow`），标注 rename 跟随边界。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn file_history(repo_id: String, start: String, path_id: String, page_size: usize, cursor: Option<git::log::LogCursor>, registry: State<'_, RepositoryRegistry>) -> Result<git::log::FileHistory, GitError> {
    let opened = opened(&registry, &repo_id)?;
    let fresh = cursor.is_none();
    history_call(opened, HistoryKind::FileHistory, fresh, move |adapter, _| adapter.history_file(&start, &path_id, page_size, cursor.as_ref())).await
}

/// 本地 / 远端跟踪分支、上游状态、remote 列表与默认获取目标（R-BRANCH）。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn read_refs(repo_id: String, registry: State<'_, RepositoryRegistry>) -> Result<git::history::RefsView, GitError> {
    let opened = opened(&registry, &repo_id)?;
    // 分支弹层、日志页、获取确认框可能同时读取 refs：读取廉价且结果相同，彼此不取消（fresh = false）。
    history_call(opened, HistoryKind::Refs, false, move |adapter, _| adapter.history_refs()).await
}

/// 历史版本的两端内容：`left` 为 None 表示空树；两端都是已固定的提交 OID（不读取 index 或工作区）。
#[cfg(feature = "desktop")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn read_revision_pair(
    repo_id: String,
    left: Option<String>,
    right: String,
    path_id: String,
    old_path_id: Option<String>,
    request_id: String,
    registry: State<'_, RepositoryRegistry>,
) -> Result<tauri::ipc::Response, GitError> {
    let opened = opened(&registry, &repo_id)?;
    let slots = opened.slots.clone();
    history_call(opened, HistoryKind::Content, true, move |adapter, stale| {
        let _slot = slots.acquire();
        let pair = adapter.read_revision_pair(request_id, left.as_deref(), &right, &path_id, old_path_id.as_deref(), stale)?;
        Ok(tauri::ipc::Response::new(pair.encode_frame()))
    })
    .await
}

/// stash 列表（R-STASH，只读）。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn stash_list(repo_id: String, registry: State<'_, RepositoryRegistry>) -> Result<Vec<git::stash::StashEntry>, GitError> {
    let opened = opened(&registry, &repo_id)?;
    history_call(opened, HistoryKind::StashList, true, move |adapter, _| adapter.stash_list()).await
}

/// 某条 stash 的内容：已跟踪部分与未跟踪部分（只读）。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn stash_changes(repo_id: String, oid: String, registry: State<'_, RepositoryRegistry>) -> Result<git::stash::StashChanges, GitError> {
    let opened = opened(&registry, &repo_id)?;
    history_call(opened, HistoryKind::StashChanges, true, move |adapter, _| adapter.stash_changes(&oid)).await
}

/// 分支名校验（`check-ref-format --branch`，只读）：新建、重命名对话框在提交前使用。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn check_branch_name(repo_id: String, name: String, registry: State<'_, RepositoryRegistry>) -> Result<(), GitError> {
    let opened = opened(&registry, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || opened.adapter.check_branch_name(&name))
        .await
        .map_err(|error| GitError::Runtime(error.to_string()))?
}

/// 合并进行中的默认合并信息（`.git/MERGE_MSG`，只读）；没有进行中的合并时为 None。
#[cfg(feature = "desktop")]
#[tauri::command]
fn merge_message(repo_id: String, registry: State<'_, RepositoryRegistry>) -> Result<Option<String>, GitError> {
    Ok(opened(&registry, &repo_id)?.adapter.merge_message())
}

/// 丢弃确认框的数据（只读）。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn prepare_discard(repo_id: String, scope: CompareScope, path_ids: Vec<String>, registry: State<'_, RepositoryRegistry>) -> Result<ops::DiscardPlan, GitError> {
    let opened = opened(&registry, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || opened.adapter.prepare_discard(scope, &path_ids))
        .await
        .map_err(|error| GitError::Runtime(error.to_string()))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn discard_backups(repo_id: String, registry: State<'_, RepositoryRegistry>, backups: State<'_, Backups>) -> Result<Vec<ops::BackupSummary>, GitError> {
    Ok(opened(&registry, &repo_id)?.adapter.discard_backups(&backups.0))
}

/// 提交面板的 HEAD 信息与已推送判断（只读）。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn head_commit_info(repo_id: String, registry: State<'_, RepositoryRegistry>) -> Result<Option<ops::HeadCommitInfo>, GitError> {
    let opened = opened(&registry, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || opened.adapter.head_commit_info())
        .await
        .map_err(|error| GitError::Runtime(error.to_string()))?
}

/// WebView2 内存目标级别（技术方案 §7 / V2-D28）：窗口失焦或最小化时设为 Low，WebView2 主动回收缓存；
/// 获得焦点时恢复 Normal。`ORIS_WEBVIEW_MEMORY_TARGET=low|normal` 只用于测量时固定级别。
#[cfg(all(feature = "desktop", windows))]
mod webview_memory {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    pub fn forced() -> Option<bool> {
        match std::env::var("ORIS_WEBVIEW_MEMORY_TARGET").ok()?.as_str() {
            "low" => Some(true),
            "normal" => Some(false),
            _ => None,
        }
    }

    pub fn apply<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str, low: bool) {
        let Some(window) = app.get_webview_window(label) else { return };
        let _ = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            // 旧版 WebView2 Runtime 不支持该接口时静默跳过。
            if let Ok(core) = core.cast::<ICoreWebView2_19>() {
                let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                let _ = core.SetMemoryUsageTargetLevel(level);
            }
        });
    }
}

#[cfg(feature = "desktop")]
pub fn application_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg(feature = "desktop")]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RepositoryRegistry::default())
        .manage(WatcherRegistry::default())
        .manage(ops::Runner::default())
        .setup(|app| {
            // ORIS_APP_CACHE_DIR 仅供隔离测试实例使用；未设置时用系统应用缓存目录。
            let base = std::env::var_os("ORIS_APP_CACHE_DIR")
                .map(std::path::PathBuf::from)
                .or_else(|| app.path().app_cache_dir().ok())
                .unwrap_or_else(std::env::temp_dir);
            app.manage(Snapshots(snapshot_store::SnapshotStore::new(base.join("snapshots"))));
            // discard 备份写入应用数据目录；ORIS_APP_DATA_DIR（或隔离测试用的 ORIS_APP_CACHE_DIR）可覆盖。
            let data = std::env::var_os("ORIS_APP_DATA_DIR")
                .or_else(|| std::env::var_os("ORIS_APP_CACHE_DIR"))
                .map(std::path::PathBuf::from)
                .or_else(|| app.path().app_data_dir().ok())
                .unwrap_or_else(std::env::temp_dir);
            app.manage(Backups(ops::BackupStore::new(data.join("discard-backups"))));
            #[cfg(windows)]
            if let Some(low) = webview_memory::forced() {
                webview_memory::apply(app.handle(), "main", low);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if webview_memory::forced().is_none() {
                use tauri::Manager;
                if let tauri::WindowEvent::Focused(focused) = event {
                    webview_memory::apply(window.app_handle(), window.label(), !*focused);
                }
            }
            #[cfg(not(windows))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            open_repository,
            refresh_repository,
            repository_details,
            activate_repository,
            close_repository,
            read_content_pair,
            cancel_content_read,
            save_snapshot,
            load_snapshot,
            remove_snapshot,
            validate_git,
            run_operation,
            cancel_operation,
            last_operation,
            prepare_discard,
            discard_backups,
            head_commit_info,
            read_log,
            commit_changes,
            compare_revisions,
            file_history,
            read_refs,
            read_revision_pair,
            stash_list,
            stash_changes,
            check_branch_name,
            merge_message
        ])
        .run(application_context())
        .expect("failed to run Oris");
}

#[cfg(test)]
mod slot_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn at_most_two_reads_run_concurrently_per_repository() {
        let slots = Arc::new(ReadSlots::default());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (slots, active, peak) = (slots.clone(), active.clone(), peak.clone());
                std::thread::spawn(move || {
                    let _slot = slots.acquire();
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    active.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(peak.load(Ordering::SeqCst), WORKTREE_READ_CONCURRENCY);
    }
}
