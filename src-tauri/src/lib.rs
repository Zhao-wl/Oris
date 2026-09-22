mod git;

#[cfg(feature = "desktop")]
use git::{ContentPair, GitAdapter, GitError, RepositorySnapshot};
#[cfg(feature = "desktop")]
use std::{collections::HashMap, sync::Mutex};
#[cfg(feature = "desktop")]
use tauri::State;

#[cfg(feature = "desktop")]
#[derive(Clone)]
struct OpenRepository {
    adapter: GitAdapter,
    revision: String,
}

#[cfg(feature = "desktop")]
#[derive(Default)]
struct RepositoryRegistry(Mutex<HashMap<String, OpenRepository>>);

#[cfg(feature = "desktop")]
#[tauri::command]
async fn open_repository(
    path: String,
    git_executable: Option<String>,
    request_id: String,
    registry: State<'_, RepositoryRegistry>,
) -> Result<RepositorySnapshot, GitError> {
    let (adapter, snapshot) = tauri::async_runtime::spawn_blocking(move || {
        let adapter = GitAdapter::open(path, git_executable)?;
        let snapshot = adapter.snapshot(request_id)?;
        Ok::<_, GitError>((adapter, snapshot))
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))??;
    registry.0.lock().map_err(|_| GitError::Registry)?.insert(
        snapshot.repo.repo_id.clone(),
        OpenRepository {
            adapter,
            revision: snapshot.revision.clone(),
        },
    );
    Ok(snapshot)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn read_content_pair(
    repo_id: String,
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
    if revision != opened.revision {
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
            .read_content_pair(request_id, revision, path_id)
    })
    .await
    .map_err(|error| GitError::Runtime(error.to_string()))?
}

#[cfg(feature = "desktop")]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RepositoryRegistry::default())
        .invoke_handler(tauri::generate_handler![open_repository, read_content_pair])
        .run(tauri::generate_context!())
        .expect("failed to run Oris");
}
