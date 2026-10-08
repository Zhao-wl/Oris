//! 应用自动更新：检查 GitHub Releases 上的 latest.json → 后台下载并校验签名 → 用户点击后安装并重启。
//! 网络请求与签名校验都在 Rust 端完成，前端只拿到版本信息与进度。
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::Update;
#[cfg(not(target_os = "macos"))]
use tauri_plugin_updater::UpdaterExt;

/// Release 页面：不能自动安装（免安装版 / 开发构建）时引导用户手动下载。
pub const RELEASES_PAGE: &str = "https://github.com/Zhao-wl/Oris/releases/latest";

#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<(String, Vec<u8>)>>,
    /// macOS 手动更新须打开检查到的具体版本，releases/latest 可能仍指向 Windows 版本。
    manual_release_page: Mutex<Option<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current_version: String,
    /// 支持原地更新的安装实例才能自动安装；macOS 当前只提供手动 DMG。
    pub installable: bool,
    pub available: Option<UpdateInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

/// NSIS 安装目录中带有 uninstall.exe；直接运行的 target\release\oris.exe 没有，替换它会装出第二份副本。
#[cfg(not(target_os = "macos"))]
fn installed_copy() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else { return false };
    exe.parent().is_some_and(|dir| dir.join("uninstall.exe").is_file())
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, UpdaterState>) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    #[cfg(target_os = "macos")]
    {
        let update = crate::release_updates::check_macos_release(&app.package_info().version, std::env::consts::ARCH)
            .await.map_err(|e| format!("检查更新失败：{e}"))?;
        let available = update.as_ref().map(|u| UpdateInfo {
            version: u.version.to_string(), notes: u.notes.clone(), date: u.date.clone(),
        });
        *state.manual_release_page.lock().map_err(|_| "更新状态不可用")? = update.map(|u| u.release_page);
        *state.pending.lock().map_err(|_| "更新状态不可用")? = None;
        *state.downloaded.lock().map_err(|_| "更新状态不可用")? = None;
        Ok(UpdateCheck { current_version, installable: false, available })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let update = app
            .updater()
            .map_err(|e| format!("更新组件不可用：{e}"))?
            .check()
            .await
            .map_err(|e| format!("检查更新失败：{e}"))?;
        let available = update.as_ref().map(|u| UpdateInfo {
            version: u.version.clone(),
            notes: u.body.clone().filter(|s| !s.trim().is_empty()),
            date: u.date.map(|d| d.date().to_string()),
        });
        let mut pending = state.pending.lock().map_err(|_| "更新状态不可用")?;
        // 新检查到的版本与已下载的不同，丢弃旧的下载。
        if let Ok(mut downloaded) = state.downloaded.lock() {
            if downloaded.as_ref().map(|(v, _)| v) != update.as_ref().map(|u| &u.version) {
                *downloaded = None;
            }
        }
        *pending = update;
        Ok(UpdateCheck { current_version, installable: installed_copy(), available })
    }
}

/// 下载最近一次检查到的版本；进度通过 `update-progress` 事件推送。签名在下载完成时由插件校验。
#[tauri::command]
pub async fn download_update(app: AppHandle, state: State<'_, UpdaterState>) -> Result<String, String> {
    let update = state.pending.lock().map_err(|_| "更新状态不可用")?.clone().ok_or("没有可下载的更新，请重新检查")?;
    if state.downloaded.lock().map_err(|_| "更新状态不可用")?.as_ref().is_some_and(|(v, _)| *v == update.version) {
        return Ok(update.version);
    }
    let version = update.version.clone();
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // 约每 256 KiB 推送一次，避免事件风暴。
                if downloaded - last_emit >= 256 * 1024 || total == Some(downloaded) {
                    last_emit = downloaded;
                    let _ = app.emit("update-progress", DownloadProgress { version: version.clone(), downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载更新失败：{e}"))?;
    *state.downloaded.lock().map_err(|_| "更新状态不可用")? = Some((version.clone(), bytes));
    Ok(version)
}

/// 安装已下载的更新并重启。Windows 上插件以 passive 模式启动 NSIS 安装器后直接退出进程，安装器完成后重新启动 Oris。
#[tauri::command]
pub fn install_update(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let update = state.pending.lock().map_err(|_| "更新状态不可用")?.clone().ok_or("没有可安装的更新")?;
    // 保留下载内容：安装器启动失败时可直接重试。
    let bytes = match state.downloaded.lock().map_err(|_| "更新状态不可用")?.as_ref() {
        Some((version, bytes)) if *version == update.version => bytes.clone(),
        _ => return Err("更新尚未下载完成".into()),
    };
    update.install(bytes).map_err(|e| format!("安装更新失败：{e}"))?;
    app.restart()
}

/// 用系统默认浏览器打开 Release 页面（地址由后端固定仓库生成，不接受前端传入的 URL）。
#[tauri::command]
pub fn open_releases_page(state: State<'_, UpdaterState>) -> Result<(), String> {
    let release_page = state.manual_release_page.lock().map_err(|_| "更新状态不可用")?
        .clone().unwrap_or_else(|| RELEASES_PAGE.into());
    #[cfg(windows)]
    let result = std::process::Command::new("explorer").arg(&release_page).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&release_page).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&release_page).spawn();
    result.map(|_| ()).map_err(|e| format!("无法打开浏览器：{e}"))
}
