/**
 * 设置与外观的应用级接线（V2-06 体验版）：一个 SettingsStore、一个 AppearanceRuntime，
 * 当前生效的配色方案放在小型 store 里供 DiffViewer 等订阅。
 */
import { createStore } from "./store";
import { createSettingsRegistry, DEFAULT_SCHEME_OPTIONS, SettingsStore } from "./settings";
import { AppearanceRuntime, applyBootAppearance, schemeIndex, type Scheme } from "./themes/runtime";

/** P-V2-06 体验：首批建议移植的 VS Code 默认主题系列（其余为第二批）。Oris 自有方案单列。 */
export const FIRST_BATCH = new Set(["dark-2026", "light-2026", "dark-modern", "light-modern", "dark-plus", "light-plus", "dark-vs", "light-vs", "hc-dark", "hc-light"]);
export const schemeBatch = (id: string) => (id.startsWith("oris-") ? "oris" : FIRST_BATCH.has(id) ? "first" : "second");

const storage: Pick<Storage, "getItem" | "setItem"> = typeof localStorage === "undefined"
  ? { getItem: () => null, setItem: () => {} }
  : localStorage;
const matchMediaFn = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined;

// P-V2-07 尚未决定：体验版以 Oris 配色为初始默认，设置窗口里可一键切到 VS Code 2026 候选对比。
export const registry = createSettingsRegistry({ schemes: schemeIndex, defaults: DEFAULT_SCHEME_OPTIONS.oris });
export const settings = new SettingsStore(storage, registry);
export const activeScheme = createStore<Scheme | null>(null);

export const appearanceRuntime = new AppearanceRuntime({
  storage,
  matchMedia: matchMediaFn,
  onApplied: (scheme) => activeScheme.set(scheme)
});

let started = false;
/** 在 React 挂载前调用：先同步套用上次的首屏颜色，再异步加载完整方案并订阅设置变化。 */
export function startAppearance() {
  if (started || typeof document === "undefined") return;
  started = true;
  applyBootAppearance(storage, document.documentElement, matchMediaFn);
  const apply = () => { void appearanceRuntime.apply(settings.get().appearance).catch(() => {}); };
  apply();
  let previous = settings.get().appearance;
  settings.subscribe(() => {
    const next = settings.get().appearance;
    if (next !== previous) { previous = next; apply(); }
  });
}
