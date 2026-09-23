mod git;

#[cfg(feature = "desktop")]
use git::{CompareScope, ContentPair, GitAdapter, GitError, RepositorySnapshot};
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
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event
            .as_ref()
            .is_ok_and(|event| !matches!(event.kind, notify::EventKind::Access(_)))
        {
            let _ = event_app.emit("repository-invalidated", &event_repo_id);
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
    registry: State<'_, RepositoryRegistry>,
) -> Result<ContentPair, GitError> {
    let opened = registry
        .0
        .lock()
        .map_err(|_| GitError::Registry)?
        .get(&repo_id)
        .cloned()
        .ok_or(GitError::UnknownRepository)?;
    if opened.revisions.get(&scope) != Some(&revision) {
        return Err(GitError::StaleRequest);
    }
    if let Some(requested) = git_executable {
        if requested != opened.adapter.git_executable_display() {
            return Err(GitError::GitChanged);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        opened
            .adapter
            .read_content_pair_for_scope(request_id, scope, revision, path_id)
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))?
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
            read_content_pair
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Oris");
}
