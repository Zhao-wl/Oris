/**
 * 设置与外观的应用级接线（V2-06）：一个 SettingsStore、一个 AppearanceRuntime，
 * 当前生效的配色方案放在小型 store 里供 DiffViewer 等订阅。
 */
import { createStore } from "./store";
import { createSettingsRegistry, SettingsStore } from "./settings";
import { AppearanceRuntime, applyBootAppearance, schemeIndex, type Scheme } from "./themes/runtime";

const storage: Pick<Storage, "getItem" | "setItem"> = typeof localStorage === "undefined"
  ? { getItem: () => null, setItem: () => {} }
  : localStorage;
const matchMediaFn = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined;

// 默认 Oris 配色（V2-D32）；19 套 VS Code 方案全部可选（V2-D31）。
export const registry = createSettingsRegistry({ schemes: schemeIndex });
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
