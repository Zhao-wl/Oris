mod git;
mod snapshot_store;
#[cfg(any(test, feature = "desktop"))]
mod watch;

#[cfg(feature = "desktop")]
use git::{CompareScope, ConflictVersion, GitAdapter, GitError, RepositoryDetails, RepositorySnapshot};
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
}

#[cfg(feature = "desktop")]
#[derive(Default)]
struct RepositoryRegistry(Mutex<HashMap<String, OpenRepository>>);

#[cfg(feature = "desktop")]
#[derive(Default)]
struct WatcherRegistry(Mutex<watch::WatchLru>);

#[cfg(feature = "desktop")]
struct Snapshots(snapshot_store::SnapshotStore);

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
            OpenRepository { adapter: adapter.clone(), generation: Arc::default(), slots: Arc::default() },
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
        .setup(|app| {
            // ORIS_APP_CACHE_DIR 仅供隔离测试实例使用；未设置时用系统应用缓存目录。
            let base = std::env::var_os("ORIS_APP_CACHE_DIR")
                .map(std::path::PathBuf::from)
                .or_else(|| app.path().app_cache_dir().ok())
                .unwrap_or_else(std::env::temp_dir);
            app.manage(Snapshots(snapshot_store::SnapshotStore::new(base.join("snapshots"))));
            Ok(())
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
            remove_snapshot
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
