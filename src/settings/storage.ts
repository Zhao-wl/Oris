import { SETTINGS_VERSION, toSettings, type Settings } from "./model";
import type { SettingsRegistry } from "./registry";

/** 与项目列表相同的持久化机制（localStorage）；键名带版本。 */
export const SETTINGS_KEY = "oris.settings.v1";
const WORKSPACE_KEY = "oris.workspace.v2";
const LEGACY_RECENT_KEY = "oris.recentRepository.v1";

/**
 * 读取结果的提示标志：
 * - `corrupted`：内容无法解析，已回退默认值；
 * - `incompatible`：版本不兼容，已回退默认值（原内容保留，直到用户修改设置）；
 * - `corrected`：部分字段非法，已逐项回退默认值；
 * - `migrated`：首次启动新版本，已从旧入口迁移。
 */
export type SettingsNotice = "corrupted" | "incompatible" | "corrected" | "migrated" | null;

export interface LoadedSettings {
  settings: Settings;
  notice: SettingsNotice;
  corrected: string[];
  /** 迁移得到的 Git 路径（没有迁移时为 null）。 */
  migratedGitExecutable: string | null;
}

/**
 * 迁移“最近一次成功打开的项目所用的非空 Git 路径”（V2-D24）。项目记录的 lastOpenedAt
 * 只在项目成功打开时更新，因此取其中最大的一个；都为空时再看旧版单项目记录。
 * 只读取项目列表，不修改它。
 */
export function migrateGitExecutable(storage: Pick<Storage, "getItem">): string | null {
  try {
    const workspace = JSON.parse(storage.getItem(WORKSPACE_KEY) ?? "null") as { projects?: unknown } | null;
    const projects = Array.isArray(workspace?.projects) ? workspace.projects : [];
    let best: { at: number; executable: string } | null = null;
    for (const project of projects) {
      if (!project || typeof project !== "object") continue;
      const { gitExecutable, lastOpenedAt } = project as { gitExecutable?: unknown; lastOpenedAt?: unknown };
      if (typeof gitExecutable !== "string" || !gitExecutable.trim()) continue;
      const at = typeof lastOpenedAt === "number" && Number.isFinite(lastOpenedAt) ? lastOpenedAt : 0;
      if (!best || at > best.at) best = { at, executable: gitExecutable.trim() };
    }
    if (best) return best.executable;
  } catch { /* 项目列表损坏不影响设置迁移 */ }
  try {
    const legacy = JSON.parse(storage.getItem(LEGACY_RECENT_KEY) ?? "null") as { gitExecutable?: unknown } | null;
    if (legacy && typeof legacy.gitExecutable === "string" && legacy.gitExecutable.trim()) return legacy.gitExecutable.trim();
  } catch { /* 忽略旧记录 */ }
  return null;
}

export function loadSettings(storage: Pick<Storage, "getItem">, registry: SettingsRegistry): LoadedSettings {
  const defaults = () => toSettings(registry.defaults());
  let text: string | null = null;
  try {
    text = storage.getItem(SETTINGS_KEY);
  } catch {
    return { settings: defaults(), notice: "corrupted", corrected: [], migratedGitExecutable: null };
  }
  if (text === null) {
    const settings = defaults();
    const executable = migrateGitExecutable(storage);
    if (executable !== null && registry.definition("git", "executable")?.validate(executable) !== undefined) settings.git.executable = executable;
    return { settings, notice: "migrated", corrected: [], migratedGitExecutable: executable };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings: defaults(), notice: "corrupted", corrected: [], migratedGitExecutable: null };
  }
  if (!raw || typeof raw !== "object") return { settings: defaults(), notice: "corrupted", corrected: [], migratedGitExecutable: null };
  if ((raw as { version?: unknown }).version !== SETTINGS_VERSION) {
    return { settings: defaults(), notice: "incompatible", corrected: [], migratedGitExecutable: null };
  }
  const { values, corrected } = registry.normalize(raw);
  if (values.ai?.shortcut === "CtrlOrMeta+Shift+M") values.ai.shortcut = "CtrlOrMeta+P";
  return { settings: toSettings(values), notice: corrected.length ? "corrected" : null, corrected, migratedGitExecutable: null };
}

export function saveSettings(storage: Pick<Storage, "setItem">, settings: Settings) {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
