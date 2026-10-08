import { createStore, type Store } from "./store";
import * as api from "./update-api";
import type { UpdateInfo } from "./update-api";

/**
 * 更新状态机（参考 VS Code）：检查 → 后台下载 → 常驻「重启以更新」→ 安装并重启。
 * 自动检查失败时保持静默，只有手动检查或下载 / 安装失败才显示错误。
 */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  /** 有新版本但需要手动安装（macOS DMG / 免安装版 / 开发构建），打开对应下载页。 */
  | { kind: "manual"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; downloaded: number; total: number | null }
  | { kind: "ready"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "failed"; stage: "check" | "download" | "install"; info: UpdateInfo | null; message: string };

export interface UpdateState {
  currentVersion: string | null;
  /** 最近一次成功检查的时间（毫秒）。 */
  checkedAt: number | null;
  /** 最近一次检查结果为“已是最新”。 */
  upToDate: boolean;
  phase: UpdatePhase;
}

export type UpdateApi = Pick<typeof api, "checkUpdate" | "downloadUpdate" | "installUpdate" | "openReleasesPage" | "onUpdateProgress">;

export const AUTO_CHECK_DELAY_MS = 5_000;
export const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createUpdater(bridge: UpdateApi = api, now: () => number = Date.now) {
  const store: Store<UpdateState> = createStore<UpdateState>({ currentVersion: null, checkedAt: null, upToDate: false, phase: { kind: "idle" } });
  const setPhase = (phase: UpdatePhase) => store.set((state) => ({ ...state, phase }));
  let listening: Promise<unknown> | null = null;

  const listenProgress = () => {
    listening ??= bridge.onUpdateProgress(({ version, downloaded, total }) => {
      const phase = store.get().phase;
      if (phase.kind === "downloading" && phase.info.version === version) setPhase({ ...phase, downloaded, total });
    }).catch(() => { listening = null; });
  };

  async function download(info: UpdateInfo) {
    listenProgress();
    setPhase({ kind: "downloading", info, downloaded: 0, total: null });
    try {
      await bridge.downloadUpdate();
      setPhase({ kind: "ready", info });
    } catch (error) {
      setPhase({ kind: "failed", stage: "download", info, message: message(error) });
    }
  }

  /** 检查更新；有可安装的新版本时直接开始后台下载。下载中 / 待重启时不重复检查。 */
  async function check({ manual = false } = {}) {
    const before = store.get().phase;
    if (["checking", "downloading", "ready", "installing"].includes(before.kind)) return;
    if (manual) setPhase({ kind: "checking" });
    try {
      const result = await bridge.checkUpdate();
      store.set((state) => ({ ...state, currentVersion: result.currentVersion, checkedAt: now(), upToDate: !result.available }));
      if (!result.available) setPhase({ kind: "idle" });
      else if (!result.installable) setPhase({ kind: "manual", info: result.available });
      else await download(result.available);
    } catch (error) {
      setPhase(manual ? { kind: "failed", stage: "check", info: null, message: message(error) } : before);
    }
  }

  async function install() {
    const phase = store.get().phase;
    const info = phase.kind === "ready" || (phase.kind === "failed" && phase.stage === "install") ? phase.info : null;
    if (!info) return;
    setPhase({ kind: "installing", info });
    try {
      await bridge.installUpdate();
    } catch (error) {
      setPhase({ kind: "failed", stage: "install", info, message: message(error) });
    }
  }

  /** 失败后重试对应的阶段。 */
  function retry() {
    const phase = store.get().phase;
    if (phase.kind !== "failed") return;
    if (phase.stage === "install") void install();
    else if (phase.stage === "download" && phase.info) void download(phase.info);
    else void check({ manual: true });
  }

  const openDownloadPage = () => bridge.openReleasesPage();

  return { store, check, install, retry, openDownloadPage };
}

export type Updater = ReturnType<typeof createUpdater>;

/** 应用内唯一的更新器：标题栏按钮与设置页共享同一状态。 */
export const updater = createUpdater();
