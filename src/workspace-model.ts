import type { CompareScope, ContentPair, DiffDocument, RepositoryInfo } from "./types";

export const WORKSPACE_KEY = "oris.workspace.v2";
export const CONTENT_CACHE_BUDGET = 16 * 1024 * 1024;
export const CONTENT_CACHE_ENTRIES = 12;

export interface ReadingAnchor {
  scope: CompareScope;
  selectedPathId: string | null;
  filter: string;
  fileView: "flat" | "tree";
  hunk: number;
}

export interface ProjectRecord {
  repo: RepositoryInfo;
  gitExecutable: string;
  pinned: boolean;
  customName?: string;
  lastOpenedAt: number;
  anchor: ReadingAnchor;
}

export interface WorkspaceState {
  version: 2;
  activeRepoId: string | null;
  projects: ProjectRecord[];
}

export const defaultAnchor = (): ReadingAnchor => ({
  scope: "unstaged",
  selectedPathId: null,
  filter: "",
  fileView: "flat",
  hunk: 0
});

export const emptyWorkspace = (): WorkspaceState => ({ version: 2, activeRepoId: null, projects: [] });

export function resolveReadingSelection<T extends { pathId: string }>(files: T[], selectedPathId: string | null) {
  const restored = selectedPathId ? files.find((file) => file.pathId === selectedPathId) : undefined;
  return {
    selected: restored ?? files[0] ?? null,
    invalidated: selectedPathId !== null && !restored
  };
}

export function upsertProject(state: WorkspaceState, project: ProjectRecord): WorkspaceState {
  const existing = state.projects.find((entry) => entry.repo.repoId === project.repo.repoId);
  const merged = existing ? { ...existing, ...project, anchor: project.anchor ?? existing.anchor } : project;
  // Array order is the user's order, including when migrating existing v2 storage.
  const projects = existing
    ? state.projects.map((entry) => entry.repo.repoId === project.repo.repoId ? merged : entry)
    : [...state.projects, merged];
  return { version: 2, activeRepoId: project.repo.repoId, projects };
}

export function removeProject(state: WorkspaceState, repoId: string): WorkspaceState {
  const projects = state.projects.filter((project) => project.repo.repoId !== repoId);
  return {
    version: 2,
    projects,
    activeRepoId: state.activeRepoId === repoId ? projects[0]?.repo.repoId ?? null : state.activeRepoId
  };
}

function validAnchor(value: unknown): ReadingAnchor {
  if (!value || typeof value !== "object") return defaultAnchor();
  const candidate = value as Partial<ReadingAnchor>;
  return {
    scope: candidate.scope === "staged" || candidate.scope === "all" ? candidate.scope : "unstaged",
    selectedPathId: typeof candidate.selectedPathId === "string" ? candidate.selectedPathId : null,
    filter: typeof candidate.filter === "string" ? candidate.filter : "",
    fileView: candidate.fileView === "tree" ? "tree" : "flat",
    hunk: typeof candidate.hunk === "number" && Number.isFinite(candidate.hunk) && candidate.hunk >= 0
      ? Math.floor(candidate.hunk)
      : 0
  };
}

export function loadWorkspace(storage: Pick<Storage, "getItem">): WorkspaceState {
  try {
    const value = JSON.parse(storage.getItem(WORKSPACE_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return emptyWorkspace();
    const candidate = value as { version?: unknown; activeRepoId?: unknown; projects?: unknown };
    if (candidate.version !== 2 || !Array.isArray(candidate.projects)) return emptyWorkspace();
    const seen = new Set<string>();
    const projects: ProjectRecord[] = [];
    for (const raw of candidate.projects) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Partial<ProjectRecord>;
      const repo = entry.repo as Partial<RepositoryInfo> | undefined;
      if (!repo || typeof repo.repoId !== "string" || !repo.repoId || seen.has(repo.repoId)) continue;
      if ([repo.displayName, repo.worktreePath, repo.gitDir, repo.commonDir, repo.branch].some((item) => typeof item !== "string")) continue;
      seen.add(repo.repoId);
      projects.push({
        repo: repo as RepositoryInfo,
        gitExecutable: typeof entry.gitExecutable === "string" ? entry.gitExecutable : "",
        pinned: entry.pinned === true,
        customName: typeof entry.customName === "string" ? entry.customName.trim() : undefined,
        lastOpenedAt: typeof entry.lastOpenedAt === "number" && Number.isFinite(entry.lastOpenedAt) ? entry.lastOpenedAt : 0,
        anchor: validAnchor(entry.anchor)
      });
    }

    const requested = typeof candidate.activeRepoId === "string" ? candidate.activeRepoId : null;
    return {
      version: 2,
      projects,
      activeRepoId: projects.some((project) => project.repo.repoId === requested) ? requested : projects[0]?.repo.repoId ?? null
    };
  } catch {
    return emptyWorkspace();
  }
}

export function saveWorkspace(storage: Pick<Storage, "setItem">, state: WorkspaceState) {
  storage.setItem(WORKSPACE_KEY, JSON.stringify(state));
}

export class ContentCache {
  private entries = new Map<string, { value: ContentPair; bytes: number; document?: DiffDocument; documentBytes?: number }>();
  private bytes = 0;

  constructor(private readonly budget = CONTENT_CACHE_BUDGET, private readonly maximum = CONTENT_CACHE_ENTRIES) {}

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: ContentPair) {
    const bytes = value.left.byteLength + value.right.byteLength;
    const prior = this.entries.get(key);
    if (prior) this.bytes -= prior.bytes;
    this.entries.delete(key);
    if (bytes > this.budget) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maximum || this.bytes > this.budget) {
      const oldest = this.entries.entries().next().value as [string, { value: ContentPair; bytes: number; document?: DiffDocument; documentBytes?: number }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
  }

  getDocument(key: string) { return this.entries.get(key)?.document; }

  setDocument(key: string, document: DiffDocument) {
    const entry = this.entries.get(key);
    if (!entry) return;
    const bytes = 128 + (document.changes.length + document.hunks.length) * 48;
    this.bytes += bytes - (entry.documentBytes ?? 0);
    entry.bytes += bytes - (entry.documentBytes ?? 0);
    entry.document = document; entry.documentBytes = bytes;
    while (this.bytes > this.budget) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  clearRepo(repoId: string) {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${repoId}:`)) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes, budget: this.budget };
  }
}

export const contentCacheKey = (repoId: string, scope: CompareScope, revision: string, pathId: string) =>
  `${repoId}:${scope}:${revision}:${pathId}`;

export class RequestGate {
  private active = "";
  private automatic = false;
  private pending = false;
  activate(requestId: string, automatic = false) { this.active = requestId; this.automatic = automatic; this.pending = true; }
  accepts(requestId: string) { return this.active === requestId; }
  finish(requestId: string) { if (this.accepts(requestId)) this.pending = false; }
  hasRequiredPending() { return this.pending && !this.automatic; }
  cancelAutomatic() {
    if (!this.pending || !this.automatic) return false;
    this.active = ""; this.pending = false;
    return true;
  }
}

export const projectName = (project: ProjectRecord) => project.customName?.trim() || project.repo.displayName;
export function moveProject(state: WorkspaceState, from: string, to: string): WorkspaceState {
  const projects = [...state.projects];
  const source = projects.findIndex(p => p.repo.repoId === from);
  const target = projects.findIndex(p => p.repo.repoId === to);
  if (source < 0 || target < 0 || source === target) return state;
  projects.splice(target, 0, projects.splice(source, 1)[0]);
  return { ...state, projects };
}
