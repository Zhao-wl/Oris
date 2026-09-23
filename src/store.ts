import { useSyncExternalStore } from "react";

/** 最小外部 store：供 useSyncExternalStore 订阅，不引入状态管理库（技术方案 §5.7）。 */
export interface Store<T> {
  get(): T;
  set(next: T | ((previous: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
}

/**
 * 订阅 store 的一个切片。选择器必须返回 store 中已有的引用（或原始值），
 * 以便只有该切片变化时组件才重新渲染。
 */
export function useStore<T, S>(store: Store<T>, selector: (value: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}
