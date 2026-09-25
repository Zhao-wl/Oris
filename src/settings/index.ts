import { createStore, useStore, type Store } from "../store";
import type { Settings } from "./model";
import type { SettingsRegistry } from "./registry";
import { loadSettings, saveSettings, type LoadedSettings, type SettingsNotice } from "./storage";

export * from "./model";
export * from "./registry";
export * from "./storage";

/**
 * 设置存储：修改即时生效并自动保存（V2-D23），变化通过小型 store 广播给订阅方，
 * 订阅方只按自己关心的切片增量更新（技术方案 §9.1）。
 */
export class SettingsStore {
  readonly store: Store<Settings>;
  readonly notice: SettingsNotice;
  readonly corrected: string[];
  readonly migratedGitExecutable: string | null;

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">, readonly registry: SettingsRegistry, loaded: LoadedSettings = loadSettings(storage, registry)) {
    this.store = createStore(loaded.settings);
    this.notice = loaded.notice;
    this.corrected = loaded.corrected;
    this.migratedGitExecutable = loaded.migratedGitExecutable;
  }

  get(): Settings {
    return this.store.get();
  }

  /**
   * 修改一个设置项。校验失败时保留原值并返回 false；成功时立即广播并保存。
   * 保存失败（例如存储不可用）不回滚内存中的值，界面仍即时生效。
   */
  update<C extends "appearance" | "git" | "ai", K extends keyof Settings[C] & string>(category: C, key: K, value: Settings[C][K]): boolean {
    const definition = this.registry.definition(category, key);
    const valid = definition?.validate(value);
    if (valid === undefined) return false;
    const current = this.store.get();
    if (Object.is(current[category][key], valid)) return true;
    const next: Settings = { ...current, [category]: { ...current[category], [key]: valid } };
    this.store.set(next);
    try { saveSettings(this.storage, next); } catch { /* 持久化可选，不影响即时生效 */ }
    return true;
  }

  subscribe(listener: () => void) {
    return this.store.subscribe(listener);
  }
}

/** 订阅某个设置切片；只有该切片变化时组件才重新渲染。 */
export function useSettings<S>(settings: SettingsStore, selector: (value: Settings) => S): S {
  return useStore(settings.store, selector);
}
