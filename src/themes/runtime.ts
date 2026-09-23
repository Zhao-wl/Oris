/**
 * 配色运行时（技术方案 §9.2–§9.4）：按 id 懒加载方案数据，把方案应用为 CSS 变量，
 * 构造 CodeMirror 高亮与编辑器主题（可放进 Compartment 并 reconfigure），跟随系统浅深色，
 * 以及首屏无闪烁所需的同步应用函数。运行时不解析 VS Code 格式，只读取离线生成的数据。
 */
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { Tag, tags } from "@lezer/highlight";
import schemeIndexData from "./generated/index.json";

export type SchemeType = "light" | "dark" | "hcLight" | "hcDark";
export type ThemeMode = "light" | "dark" | "system";
export type DiffColorMode = "oris" | "vscode";

export interface SchemeIndexEntry {
  id: string;
  name: string;
  type: SchemeType;
  source: { kind: string; commit?: string; path?: string };
  preview: string[];
}

export interface DiffTone {
  marker: string;
  line: string;
  word: string;
}

export interface HighlightRule {
  tag: string;
  color?: string;
  fontStyle?: string;
}

export interface Scheme {
  id: string;
  name: string;
  type: SchemeType;
  source: SchemeIndexEntry["source"];
  variables: Record<string, string | null>;
  diff: {
    oris: { modified: DiffTone; added: DiffTone; deleted: DiffTone };
    vscode: { added: DiffTone; deleted: DiffTone };
  };
  highlight: HighlightRule[];
}

export interface AppearanceInput {
  themeMode: ThemeMode;
  lightScheme: string;
  darkScheme: string;
  fontSize: number;
  diffColorMode: DiffColorMode;
}

export const schemeIndex = schemeIndexData as SchemeIndexEntry[];

// 每套方案一个独立 chunk，只在用到时加载（技术方案 §7：只加载当前使用的方案；跟随系统时预加载另一套）。
const loaders = import.meta.glob<{ default: Scheme }>(["./generated/*.json", "!./generated/index.json"]);
const loaded = new Map<string, Promise<Scheme>>();

export function isHighContrast(type: SchemeType) {
  return type === "hcDark" || type === "hcLight";
}

export function isDarkType(type: SchemeType) {
  return type === "dark" || type === "hcDark";
}

/** 按 id 懒加载方案数据；同一 id 只加载一次。 */
export function loadScheme(id: string): Promise<Scheme> {
  const cached = loaded.get(id);
  if (cached) return cached;
  const loader = loaders[`./generated/${id}.json`];
  if (!loader || !schemeIndex.some((entry) => entry.id === id)) return Promise.reject(new Error(`未知配色方案：${id}`));
  const promise = loader().then((module) => module.default);
  loaded.set(id, promise);
  promise.catch(() => loaded.delete(id));
  return promise;
}

/** 已触发加载的方案 id（用于资源断言与诊断）。 */
export function loadedSchemeIds(): string[] {
  return [...loaded.keys()];
}

/** 仅供测试：清空已加载记录。 */
export function resetSchemeCacheForTest() {
  loaded.clear();
}

export function resolveMode(themeMode: ThemeMode, systemDark: boolean): "light" | "dark" {
  return themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;
}

export function activeSchemeId(appearance: Pick<AppearanceInput, "themeMode" | "lightScheme" | "darkScheme">, systemDark: boolean) {
  return resolveMode(appearance.themeMode, systemDark) === "dark" ? appearance.darkScheme : appearance.lightScheme;
}

/**
 * 两组 diff 颜色（P-V2-05 待用户决定，两种都提供）：
 * - `oris`：修改蓝、新增绿、删除灰；修改块左右两侧都用“修改”色；
 * - `vscode`：新增绿、删除红；修改块左侧按删除、右侧按新增着色。
 */
export function diffColors(scheme: Scheme, mode: DiffColorMode) {
  if (mode === "oris") {
    const { modified, added, deleted } = scheme.diff.oris;
    return { added, deleted, modifiedLeft: modified, modifiedRight: modified };
  }
  const { added, deleted } = scheme.diff.vscode;
  return { added, deleted, modifiedLeft: deleted, modifiedRight: added };
}

/** 方案应用为根元素上的 CSS 变量（含 diff 颜色变量）；高对比方案额外加类名，界面切换到描边样式分支。 */
export function schemeVariables(scheme: Scheme, mode: DiffColorMode): Record<string, string | null> {
  const variables: Record<string, string | null> = { ...scheme.variables };
  const colors = diffColors(scheme, mode);
  for (const [name, tone] of Object.entries(colors)) {
    const prefix = `--diff-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    variables[`${prefix}-marker`] = tone.marker;
    variables[`${prefix}-line`] = tone.line;
    variables[`${prefix}-word`] = tone.word;
  }
  return variables;
}

export const HIGH_CONTRAST_CLASS = "theme-high-contrast";

export function applyScheme(scheme: Scheme, mode: DiffColorMode, root: HTMLElement = document.documentElement) {
  const variables = schemeVariables(scheme, mode);
  for (const [name, value] of Object.entries(variables)) {
    if (value === null || value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  const dark = isDarkType(scheme.type);
  root.classList.toggle(HIGH_CONTRAST_CLASS, isHighContrast(scheme.type));
  root.classList.toggle("theme-dark", dark);
  root.classList.toggle("theme-light", !dark);
  root.dataset.scheme = scheme.id;
  root.dataset.schemeType = scheme.type;
  root.dataset.diffColorMode = mode;
  root.style.colorScheme = dark ? "dark" : "light";
}

const tagCache = new Map<string, Tag | null>();

/** 生成数据中的 tag 名（如 `keyword`、`function(variableName)`）解析为 Lezer Tag；无法识别时返回 null。 */
export function resolveTag(name: string): Tag | null {
  if (tagCache.has(name)) return tagCache.get(name)!;
  const table = tags as unknown as Record<string, unknown>;
  let result: Tag | null = null;
  const modified = /^(\w+)\((\w+)\)$/.exec(name);
  if (modified) {
    const modifier = table[modified[1]];
    const base = table[modified[2]];
    if (typeof modifier === "function" && base instanceof Tag) result = (modifier as (tag: Tag) => Tag)(base);
  } else if (table[name] instanceof Tag) {
    result = table[name] as Tag;
  }
  tagCache.set(name, result);
  return result;
}

/**
 * 由方案的 scope→tag 规则生成 CodeMirror HighlightStyle（替代 theme-one-dark 的语法配色）。
 * Oris 自有方案没有移植的语法规则：沿用 V1 的高亮（深色 one-dark，浅色 CodeMirror 默认）。
 */
export function highlightStyleFor(scheme: Scheme): HighlightStyle {
  if (!scheme.highlight.length) return isDarkType(scheme.type) ? oneDarkHighlightStyle : defaultHighlightStyle;
  const specs = scheme.highlight.flatMap((rule) => {
    const tag = resolveTag(rule.tag);
    if (!tag) return [];
    const style = rule.fontStyle ?? "";
    return [{
      tag,
      ...(rule.color ? { color: rule.color } : {}),
      ...(style.includes("italic") ? { fontStyle: "italic" } : {}),
      ...(style.includes("bold") ? { fontWeight: "bold" } : {}),
      ...(style.includes("underline") ? { textDecoration: "underline" } : style.includes("strikethrough") ? { textDecoration: "line-through" } : {})
    }];
  });
  return HighlightStyle.define(specs, { themeType: isDarkType(scheme.type) ? "dark" : "light" });
}

/** 编辑器主题：颜色引用根元素上的 CSS 变量，因此方案切换只需重新配置 dark 标志与高亮。 */
export function editorThemeFor(scheme: Scheme): Extension {
  const highContrast = isHighContrast(scheme.type);
  return EditorView.theme({
    "&": { backgroundColor: "var(--bg)", color: "var(--text)" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--line-number)", borderRight: highContrast ? "1px solid var(--border)" : "none" },
    ".cm-activeLine": { backgroundColor: "var(--hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--text-selection)" },
    ".cm-cursor": { borderLeftColor: "var(--text)" }
  }, { dark: isDarkType(scheme.type) });
}

export function fontSizeTheme(fontSize: number): Extension {
  return EditorView.theme({ "&": { fontSize: `${fontSize}px` } });
}

/** diff 阅读器的外观配置分三个 Compartment：主题、语法高亮、字号。切换时 reconfigure，不重建编辑器。 */
export interface AppearanceCompartments {
  theme: Compartment;
  highlight: Compartment;
  fontSize: Compartment;
}

export function createAppearanceCompartments(): AppearanceCompartments {
  return { theme: new Compartment(), highlight: new Compartment(), fontSize: new Compartment() };
}

export function appearanceExtensions(compartments: AppearanceCompartments, scheme: Scheme, fontSize: number): Extension[] {
  return [
    compartments.theme.of(editorThemeFor(scheme)),
    compartments.highlight.of(syntaxHighlighting(highlightStyleFor(scheme))),
    compartments.fontSize.of(fontSizeTheme(fontSize))
  ];
}

/** 同一 EditorView 上切换配色与字号：只派发 reconfigure effect，文档、选区、滚动、搜索状态保留。 */
export function reconfigureAppearance(views: EditorView[], compartments: AppearanceCompartments, scheme: Scheme | null, fontSize: number | null) {
  const effects = [
    ...(scheme ? [compartments.theme.reconfigure(editorThemeFor(scheme)), compartments.highlight.reconfigure(syntaxHighlighting(highlightStyleFor(scheme)))] : []),
    ...(fontSize !== null ? [compartments.fontSize.reconfigure(fontSizeTheme(fontSize))] : [])
  ];
  if (!effects.length) return;
  for (const view of views) view.dispatch({ effects });
}

// ---------------- 首屏无闪烁 ----------------

export const BOOT_KEY = "oris.appearance.boot.v1";
/** 首屏需要的最小变量集合；完整方案随后懒加载并应用。 */
export const CRITICAL_VARIABLES = ["--bg", "--panel", "--chrome", "--text", "--dim", "--border", "--line-number", "--hover", "--status-bg", "--status-text"] as const;

interface BootEntry {
  id: string;
  type: SchemeType;
  variables: Record<string, string>;
}

export interface BootCache {
  version: 1;
  themeMode: ThemeMode;
  light: BootEntry | null;
  dark: BootEntry | null;
}

function bootEntry(scheme: Scheme): BootEntry {
  const variables: Record<string, string> = {};
  for (const name of CRITICAL_VARIABLES) {
    const value = scheme.variables[name];
    if (typeof value === "string") variables[name] = value;
  }
  return { id: scheme.id, type: scheme.type, variables };
}

export function readBootCache(storage: Pick<Storage, "getItem">): BootCache | null {
  try {
    const value = JSON.parse(storage.getItem(BOOT_KEY) ?? "null") as BootCache | null;
    return value && value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

/** 记录当前浅色 / 深色方案的首屏变量；另一模式的记录在未加载时保留上一次的值。 */
export function writeBootCache(storage: Pick<Storage, "getItem" | "setItem">, themeMode: ThemeMode, schemes: Scheme[]) {
  const previous = readBootCache(storage);
  const cache: BootCache = { version: 1, themeMode, light: previous?.light ?? null, dark: previous?.dark ?? null };
  for (const scheme of schemes) {
    if (isDarkType(scheme.type)) cache.dark = bootEntry(scheme);
    else cache.light = bootEntry(scheme);
  }
  try { storage.setItem(BOOT_KEY, JSON.stringify(cache)); } catch { /* 可选 */ }
}

/**
 * React 挂载前同步调用：读取上次保存的方案首屏变量并写入根元素（跟随系统时读取 prefers-color-scheme）。
 * 返回应用的方案 id；没有记录时返回 null（沿用样式表中的默认配色）。
 */
export function applyBootAppearance(storage: Pick<Storage, "getItem">, root: HTMLElement, matchMedia?: (query: string) => { matches: boolean }): string | null {
  const cache = readBootCache(storage);
  if (!cache) return null;
  const systemDark = matchMedia ? matchMedia("(prefers-color-scheme: dark)").matches : true;
  const entry = resolveMode(cache.themeMode, systemDark) === "dark" ? cache.dark : cache.light;
  if (!entry) return null;
  for (const [name, value] of Object.entries(entry.variables)) root.style.setProperty(name, value);
  const dark = isDarkType(entry.type);
  root.classList.toggle(HIGH_CONTRAST_CLASS, isHighContrast(entry.type));
  root.classList.toggle("theme-dark", dark);
  root.classList.toggle("theme-light", !dark);
  root.dataset.scheme = entry.id;
  root.style.colorScheme = dark ? "dark" : "light";
  return entry.id;
}

// ---------------- 运行时编排 ----------------

type MediaQuery = { matches: boolean; addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void; removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void };

export interface AppearanceRuntimeOptions {
  root?: HTMLElement;
  storage?: Pick<Storage, "getItem" | "setItem">;
  matchMedia?: (query: string) => MediaQuery;
  /** 方案应用后回调（例如 reconfigure 编辑器）。 */
  onApplied?(scheme: Scheme, appearance: AppearanceInput): void;
}

/**
 * 外观运行时：应用设置中的主题模式 / 方案 / diff 颜色；跟随系统时监听 prefers-color-scheme，
 * 并预加载另一套方案以便系统切换时立即生效。
 */
export class AppearanceRuntime {
  private appearance: AppearanceInput | null = null;
  private media: MediaQuery | null = null;
  private generation = 0;
  private readonly listener = (event: { matches: boolean }) => { void this.render(event.matches); };

  constructor(private readonly options: AppearanceRuntimeOptions = {}) {}

  private systemDark() {
    return this.media ? this.media.matches : this.options.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  }

  async apply(appearance: AppearanceInput): Promise<Scheme> {
    this.appearance = appearance;
    const wantsSystem = appearance.themeMode === "system";
    if (wantsSystem && !this.media && this.options.matchMedia) {
      this.media = this.options.matchMedia("(prefers-color-scheme: dark)");
      this.media.addEventListener("change", this.listener);
    } else if (!wantsSystem && this.media) {
      this.media.removeEventListener("change", this.listener);
      this.media = null;
    }
    const scheme = await this.render(this.systemDark());
    if (wantsSystem) {
      // 预加载另一套，系统切换时无需等待加载。
      const other = activeSchemeId(appearance, !this.systemDark());
      void loadScheme(other).catch(() => {});
    }
    return scheme;
  }

  private async render(systemDark: boolean): Promise<Scheme> {
    const appearance = this.appearance;
    if (!appearance) throw new Error("尚未设置外观");
    const generation = ++this.generation;
    const scheme = await loadScheme(activeSchemeId(appearance, systemDark));
    if (generation !== this.generation) return scheme;
    applyScheme(scheme, appearance.diffColorMode, this.options.root);
    if (this.options.storage) writeBootCache(this.options.storage, appearance.themeMode, [scheme]);
    this.options.onApplied?.(scheme, appearance);
    return scheme;
  }

  dispose() {
    this.media?.removeEventListener("change", this.listener);
    this.media = null;
  }
}
