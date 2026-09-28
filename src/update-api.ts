import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface UpdateInfo { version: string; notes: string | null; date: string | null }
export interface UpdateCheck { currentVersion: string; installable: boolean; available: UpdateInfo | null }
export interface UpdateProgress { version: string; downloaded: number; total: number | null }

export const checkUpdate = () => invoke<UpdateCheck>("check_update");
export const downloadUpdate = () => invoke<string>("download_update");
/** 成功时进程会退出并由安装器重启，不会正常返回。 */
export const installUpdate = () => invoke<void>("install_update");
export const openReleasesPage = () => invoke<void>("open_releases_page");
export const onUpdateProgress = (handler: (progress: UpdateProgress) => void) => listen<UpdateProgress>("update-progress", (event) => handler(event.payload));
