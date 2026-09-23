import { enumSetting, integerSetting, SettingsRegistry, stringSetting, type SettingsValues } from "./registry";

/** 设置模型版本；读取到其他版本时回退默认值并提示（不覆盖原文件，直到用户修改）。 */
export const SETTINGS_VERSION = 1;

export type ThemeMode = "light" | "dark" | "system";
/** diff 颜色语义：oris =“修改蓝、新增绿、删除灰”；vscode =“新增绿、删除红”。取舍见 P-V2-05（待用户决定）。 */
export type DiffColorMode = "oris" | "vscode";

export interface AppearanceSettings {
  themeMode: ThemeMode;
  lightScheme: string;
  darkScheme: string;
  fontSize: number;
  diffColorMode: DiffColorMode;
}

export interface GitSettings {
  /** 空字符串表示自动发现。 */
  executable: string;
}

export interface Settings {
  version: typeof SETTINGS_VERSION;
  appearance: AppearanceSettings;
  git: GitSettings;
}

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 18;
export const FONT_SIZE_DEFAULT = 13;

/**
 * 默认配色的两个候选（P-V2-07 待用户决定）。框架不内置取舍：
 * 调用方在接入时按决定传入其中一组（或其他合法 id）。
 */
export const DEFAULT_SCHEME_OPTIONS = {
  /** 保留 V1 已确认的 Oris 配色为默认。 */
  oris: { lightScheme: "oris-light", darkScheme: "oris-dark" },
  /** 以 VS Code 的 Light 2026 / Dark 2026 为默认。 */
  vscode2026: { lightScheme: "light-2026", darkScheme: "dark-2026" }
} as const;

export interface RegistryOptions {
  /** 可选方案：id 与类型（light / dark / hcLight / hcDark），通常来自 src/themes/generated/index.json。 */
  schemes: { id: string; name: string; type: string }[];
  defaults: { lightScheme: string; darkScheme: string };
  /** V1 的主题默认为深色；接入时可按需要调整。 */
  defaultThemeMode?: ThemeMode;
}

const isLightType = (type: string) => type === "light" || type === "hcLight";
const isDarkType = (type: string) => type === "dark" || type === "hcDark";

/** 创建含“外观”“Git”两个分类的注册表。以后新增分类时调用 `registry.register(...)` 即可。 */
export function createSettingsRegistry({ schemes, defaults, defaultThemeMode = "dark" }: RegistryOptions): SettingsRegistry {
  const lightIds = schemes.filter((s) => isLightType(s.type)).map((s) => s.id);
  const darkIds = schemes.filter((s) => isDarkType(s.type)).map((s) => s.id);
  const label = (id: string) => schemes.find((s) => s.id === id)?.name ?? id;
  const schemeOptions = (ids: string[]) => ids.map((id) => ({ value: id, label: label(id) }));
  if (!lightIds.includes(defaults.lightScheme)) throw new Error(`默认浅色方案不存在：${defaults.lightScheme}`);
  if (!darkIds.includes(defaults.darkScheme)) throw new Error(`默认深色方案不存在：${defaults.darkScheme}`);
  return new SettingsRegistry()
    .register({
      id: "appearance",
      label: "外观",
      order: 10,
      settings: [
        enumSetting<ThemeMode>("themeMode", ["light", "dark", "system"], defaultThemeMode, {
          label: "主题模式",
          control: "segmented",
          options: [{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" }]
        }),
        enumSetting("lightScheme", lightIds, defaults.lightScheme, { label: "浅色方案", control: "scheme-list", options: schemeOptions(lightIds) }),
        enumSetting("darkScheme", darkIds, defaults.darkScheme, { label: "深色方案", control: "scheme-list", options: schemeOptions(darkIds) }),
        integerSetting("fontSize", FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT, { label: "Diff 字号", control: "slider", description: "Ctrl/Cmd + = / - / 0 快捷调整" }),
        enumSetting<DiffColorMode>("diffColorMode", ["oris", "vscode"], "oris", {
          label: "Diff 颜色语义",
          control: "segmented",
          options: [{ value: "oris", label: "修改蓝 · 新增绿 · 删除灰" }, { value: "vscode", label: "新增绿 · 删除红" }],
          pendingDecision: "P-V2-05"
        })
      ]
    })
    .register({
      id: "git",
      label: "Git",
      order: 20,
      settings: [
        // 路径的真实校验（执行 git --version）由后端在修改时完成；这里只拒绝控制字符与超长值。
        stringSetting("executable", "", { label: "Git 可执行文件", control: "text", description: "留空时自动发现" }, (value) => value.length <= 4096 && !/[\u0000-\u001f]/.test(value))
      ]
    });
}

export function toSettings(values: SettingsValues): Settings {
  return { version: SETTINGS_VERSION, appearance: values.appearance as unknown as AppearanceSettings, git: values.git as unknown as GitSettings };
}
