mod git;
#[cfg(feature = "desktop")]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryInvalidation<'a> {
    repo_id: &'a str,
    paths: Vec<String>,
    global: bool,
}

#[cfg(feature = "desktop")]
static READ_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(feature = "desktop")]
static READ_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(feature = "desktop")]
use git::{CompareScope, ConflictVersion, ContentPair, GitAdapter, GitError, RepositorySnapshot};
#[cfg(feature = "desktop")]
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(feature = "desktop")]
use std::{collections::HashMap, sync::Mutex};
#[cfg(feature = "desktop")]
use tauri::{Emitter, State};

#[cfg(feature = "desktop")]
#[derive(Clone)]
struct OpenRepository {
    adapter: GitAdapter,
    revisions: HashMap<CompareScope, String>,
}

#[cfg(feature = "desktop")]
#[derive(Default)]
struct RepositoryRegistry(Mutex<HashMap<String, OpenRepository>>);

#[cfg(feature = "desktop")]
#[derive(Default)]
struct WatcherRegistry(Mutex<HashMap<String, RecommendedWatcher>>);

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
        let snapshot = adapter.snapshot_for_scope(request_id, scope)?;
        Ok::<_, GitError>((adapter, snapshot))
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))??;
    let repo_id = snapshot.repo.repo_id.clone();
    let watch_paths = adapter.watch_paths();
    let event_repo_id = repo_id.clone();
    let event_app = app.clone();
    let filter = adapter.change_filter();
    let event_root = std::path::PathBuf::from(&snapshot.repo.worktree_path);
    let event_git_dirs = vec![
        std::path::PathBuf::from(&snapshot.repo.git_dir),
        std::path::PathBuf::from(&snapshot.repo.common_dir),
    ];
    let (sender, receiver) = std::sync::mpsc::channel::<Vec<std::path::PathBuf>>();
    // Batch events and drop ignored/noise paths so editors that rewrite ignored
    // caches (Unity Library/Temp) do not keep invalidating the displayed content.
    // The thread ends when the watcher (and its sender) is dropped.
    std::thread::spawn(move || {
        while let Ok(mut paths) = receiver.recv() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
            let mut closed = false;
            while let Some(wait) = deadline.checked_duration_since(std::time::Instant::now()) {
                match receiver.recv_timeout(wait) {
                    Ok(more) => paths.extend(more),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        closed = true;
                        break;
                    }
                }
            }
            if closed {
                break;
            }
            if filter.relevant(&paths) {
                let global = paths.iter().any(|p| {
                    p.as_os_str().is_empty()
                        || event_git_dirs.iter().any(|d| p.starts_with(d))
                        || !p.starts_with(&event_root)
                });
                let relative = paths
                    .iter()
                    .filter_map(|p| p.strip_prefix(&event_root).ok())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .collect::<Vec<_>>();
                let _ = event_app.emit(
                    "repository-invalidated",
                    RepositoryInvalidation {
                        repo_id: &event_repo_id,
                        paths: relative,
                        global,
                    },
                );
            }
        }
    });
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Some(paths) = invalidating_paths(event) {
            let _ = sender.send(paths);
        }
    })
    .map_err(|error| GitError::Runtime(format!("无法启动文件监听：{error}")))?;
    for watch_path in watch_paths {
        watcher
            .watch(&watch_path, RecursiveMode::Recursive)
            .map_err(|error| {
                GitError::Runtime(format!("无法监听 {}：{error}", watch_path.display()))
            })?;
    }
    registry.0.lock().map_err(|_| GitError::Registry)?.insert(
        repo_id.clone(),
        OpenRepository {
            adapter,
            revisions: HashMap::from([(scope, snapshot.revision.clone())]),
        },
    );
    watchers
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .insert(repo_id, watcher);
    Ok(snapshot)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn refresh_repository(
    repo_id: String,
    scope: CompareScope,
    request_id: String,
    registry: State<'_, RepositoryRegistry>,
) -> Result<RepositorySnapshot, GitError> {
    let adapter = registry
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .get(&repo_id)
        .map(|opened| opened.adapter.clone())
        .ok_or(GitError::UnknownRepository)?;
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || adapter.snapshot_for_scope(request_id, scope))
            .await
            .map_err(|error| GitError::Runtime(error.to_string()))??;
    if let Some(opened) = registry
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .get_mut(&repo_id)
    {
        opened.revisions.insert(scope, snapshot.revision.clone());
    }
    Ok(snapshot)
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn close_repository(
    repo_id: String,
    registry: State<'_, RepositoryRegistry>,
    watchers: State<'_, WatcherRegistry>,
) -> Result<(), GitError> {
    registry
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .remove(&repo_id);
    watchers
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .remove(&repo_id);
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn read_content_pair(
    repo_id: String,
    scope: CompareScope,
    revision: String,
    path_id: String,
    git_executable: Option<String>,
    request_id: String,
    versions: Option<[ConflictVersion; 2]>,
    registry: State<'_, RepositoryRegistry>,
) -> Result<ContentPair, GitError> {
    let generation = READ_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let opened = registry
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .get(&repo_id)
        .cloned()
        .ok_or(GitError::UnknownRepository)?;
    // The adapter validates a bounded retained snapshot and the selected endpoints.
    // A newer unrelated list refresh must not invalidate an in-flight read.
    if let Some(requested) = git_executable {
        if requested != opened.adapter.git_executable_display() {
            return Err(GitError::GitChanged);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _serial = READ_SERIAL.lock().map_err(|_| GitError::Registry)?;
        if READ_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return Err(GitError::StaleRequest);
        }
        let result = opened.adapter.read_content_pair_cancellable(
            request_id,
            scope,
            revision,
            path_id,
            versions,
            || READ_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation,
        );
        if READ_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return Err(GitError::StaleRequest);
        }
        result
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn cancel_content_read() {
    READ_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
        .invoke_handler(tauri::generate_handler![
            open_repository,
            refresh_repository,
            close_repository,
            read_content_pair,
            cancel_content_read
        ])
        .run(application_context())
        .expect("failed to run Oris");
}

#[cfg(any(test, feature = "desktop"))]
fn invalidating_paths(event: notify::Result<notify::Event>) -> Option<Vec<std::path::PathBuf>> {
    match event {
        Ok(event)
            if !event.need_rescan()
                && matches!(
                    event.kind,
                    notify::EventKind::Access(_)
                        | notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
                            notify::event::MetadataKind::AccessTime
                        ))
                ) =>
        {
            None
        }
        Ok(event) if !event.need_rescan() && !event.paths.is_empty() => Some(event.paths),
        _ => Some(vec![std::path::PathBuf::new()]),
    }
}

#[cfg(test)]
mod watcher_tests {
    use super::*;
    use notify::{RecursiveMode, Watcher};
    #[test]
    fn access_is_noise_but_overflow_remains_dirty() {
        let access = notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Read));
        assert!(invalidating_paths(Ok(access.clone())).is_none());
        assert!(invalidating_paths(Ok(access.set_flag(notify::event::Flag::Rescan))).is_some());
        let atime = notify::Event::new(notify::EventKind::Modify(
            notify::event::ModifyKind::Metadata(notify::event::MetadataKind::AccessTime),
        ));
        assert!(invalidating_paths(Ok(atime)).is_none());
    }
    #[test]
    fn native_filesystem_watch_reads_do_not_dirty_but_writes_do() {
        use std::{
            fs,
            time::{Duration, Instant},
        };
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("selected.json");
        fs::write(&file, b"{\"a\":1}").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        watcher.watch(dir.path(), RecursiveMode::Recursive).unwrap();
        for _ in 0..20 {
            let _ = fs::metadata(&file).unwrap();
            let _ = fs::read(&file).unwrap();
        }
        let mut read_events = 0;
        let mut read_invalidations = 0;
        let until = Instant::now() + Duration::from_millis(500);
        while let Some(wait) = until.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(wait) {
                Ok(event) => {
                    read_events += 1;
                    if invalidating_paths(event).is_some() {
                        read_invalidations += 1;
                    }
                }
                Err(_) => break,
            }
        }
        fs::write(&file, b"{\"a\":222}").unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        let mut write_invalidations = 0;
        while let Some(wait) = until.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(wait) {
                Ok(event) => {
                    if invalidating_paths(event).is_some() {
                        write_invalidations += 1;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        drop(watcher);
        println!("FILESYSTEM_WATCH read_events={read_events} read_invalidations={read_invalidations} write_invalidations={write_invalidations}");
        assert_eq!(read_invalidations, 0);
        assert!(write_invalidations > 0);
    }
}
