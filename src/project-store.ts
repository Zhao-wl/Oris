import { createStore, type Store } from "./store";
import type { CompareScope, FileChange, RepositoryDetails, RepositorySnapshot } from "./types";

/** 每个项目的轻量运行状态（按项目拆分，切换项目时只替换当前项目切片）。 */
export interface ProjectRuntime {
  /** 最近一次扫描（V2 含三个范围）。 */
  snapshot: RepositorySnapshot | null;
  /** 与 snapshot.revision 对应的后台统计 / “全部”范围修正。 */
  details: RepositoryDetails | null;
  /** 显示的是持久化快照，后台校验尚未完成（V2-D08）。 */
  verifying: boolean;
  /** 项目在后台期间收到了变化，切回时需要刷新。 */
  dirty: boolean;
}

export type ProjectMap = Record<string, ProjectRuntime>;

const emptyRuntime = (): ProjectRuntime => ({ snapshot: null, details: null, verifying: false, dirty: false });

export class ProjectStore {
  readonly store: Store<ProjectMap> = createStore<ProjectMap>({});

  get(repoId: string | null | undefined): ProjectRuntime | undefined {
    return repoId ? this.store.get()[repoId] : undefined;
  }

  update(repoId: string, patch: Partial<ProjectRuntime> | ((current: ProjectRuntime) => Partial<ProjectRuntime>)) {
    this.store.set((map) => {
      const current = map[repoId] ?? emptyRuntime();
      const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
      return { ...map, [repoId]: next };
    });
  }

  remove(repoId: string) {
    this.store.set((map) => {
      if (!(repoId in map)) return map;
      const next = { ...map };
      delete next[repoId];
      return next;
    });
  }

  /** 校验完成前禁止写操作（V2-D08）；供 V2-02 的写入口使用。 */
  canWrite(repoId: string | null | undefined): boolean {
    const runtime = this.get(repoId);
    return !!runtime?.snapshot && !runtime.verifying;
  }
}

/** 统计仍在后台补齐（界面显示占位，不能显示为 0）。 */
export function statsPending(snapshot: RepositorySnapshot | null | undefined, details: RepositoryDetails | null | undefined) {
  return !!snapshot && snapshot.statsReady === false && details?.revision !== snapshot.revision;
}

const derived = new WeakMap<RepositorySnapshot, Map<string, FileChange[]>>();

/**
 * 某范围的文件列表：由一次 status 的结果在前端过滤得到，合并后台统计与“全部”范围修正。
 * 结果按 (snapshot, details, scope) 缓存，引用稳定，便于订阅方跳过重渲染。
 */
export function filesForScope(snapshot: RepositorySnapshot, details: RepositoryDetails | null | undefined, scope: CompareScope): FileChange[] {
  if (!snapshot.scopes) return snapshot.files;
  const usable = details && details.revision === snapshot.revision ? details : null;
  const key = `${scope}:${usable ? "d" : "-"}`;
  let perSnapshot = derived.get(snapshot);
  if (!perSnapshot) { perSnapshot = new Map(); derived.set(snapshot, perSnapshot); }
  const cached = perSnapshot.get(key);
  if (cached) return cached;
  const base = scope === "all" && usable ? usable.all : snapshot.scopes[scope];
  let files = base;
  if (usable) {
    const stats = new Map(usable.stats[scope].map(([pathId, additions, deletions]) => [pathId, [additions, deletions] as const]));
    const unchanged = new Map(usable.contentUnchanged?.[scope] ?? []);
    files = base.map((file) => {
      const stat = stats.get(file.pathId);
      const reason = unchanged.get(file.pathId);
      const next = stat ? { ...file, additions: stat[0], deletions: stat[1] } : file;
      return reason ? { ...next, contentUnchanged: reason } : next;
    });
  }
  perSnapshot.set(key, files);
  return files;
}

/** 生成某范围的快照视图（与 V1 的单范围快照同形），供现有阅读流程使用。 */
export function scopeView(snapshot: RepositorySnapshot, details: RepositoryDetails | null | undefined, scope: CompareScope): RepositorySnapshot {
  if (!snapshot.scopes) return snapshot;
  const files = filesForScope(snapshot, details, scope);
  if (snapshot.scope === scope && snapshot.files === files) return snapshot;
  const usable = !!details && details.revision === snapshot.revision;
  return { ...snapshot, scope, files, statsReady: snapshot.statsReady || usable };
}

/** 持久化快照：只保留轻量字段（文件列表、分支、inProgress），不含内容。 */
export function persistableSnapshot(snapshot: RepositorySnapshot, details: RepositoryDetails | null | undefined) {
  const usable = details && details.revision === snapshot.revision ? details : null;
  return JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    snapshot: {
      ...snapshot,
      requestId: "persisted",
      files: [],
      scopes: snapshot.scopes ? {
        unstaged: filesForScope(snapshot, usable, "unstaged"),
        staged: filesForScope(snapshot, usable, "staged"),
        all: filesForScope(snapshot, usable, "all")
      } : null,
      statsReady: !!usable || snapshot.statsReady !== false
    }
  });
}

export function parsePersistedSnapshot(json: string | null | undefined, worktreePath: string): RepositorySnapshot | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as { version?: unknown; snapshot?: RepositorySnapshot };
    const snapshot = value.snapshot;
    if (value.version !== 1 || !snapshot?.scopes || snapshot.repo?.worktreePath !== worktreePath) return null;
    return snapshot;
  } catch {
    return null;
  }
}
