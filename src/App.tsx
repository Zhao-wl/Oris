import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeRepository, openRepository, readContentPair, refreshRepository } from "./api";
import { calculateDiff } from "./diff";
import { availableDiffModes, resolveDiffPresentation, type DiffPresentation } from "./diff-presentation";
import DiffViewer, { type DiffViewerHandle } from "./DiffViewer";
import FileTree, { compareFiles } from "./FileTree";
import ProjectTab from "./ProjectTab";
import type { CompareScope, ContentPair, DiffDocument, FileChange, RepositorySnapshot } from "./types";
import { ContentCache, RequestGate, projectName, moveProject, contentCacheKey, defaultAnchor, loadWorkspace, removeProject, resolveReadingSelection, saveWorkspace, upsertProject, type ProjectRecord, type ReadingAnchor } from "./workspace-model";

const newRequestId = () => crypto.randomUUID();
const editorText = (text: string) => text.replace(/\r\n?/g, "\n");
const SIDEBAR_MIN_WIDTH = 180;
const DIFF_MIN_WIDTH = 480;
const scopeLabels: Record<CompareScope, { short: string; endpoints: [string, string] }> = {
  unstaged: { short: "未暂存", endpoints: ["Index（暂存区）", "Working Tree（工作区）"] },
  staged: { short: "已暂存", endpoints: ["HEAD（当前提交）", "Index（暂存区）"] },
  all: { short: "全部", endpoints: ["HEAD（当前提交）", "Working Tree（工作区）"] }
};

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "操作失败";
}

function ToggleButton({ label, pressed, disabled = false, onClick }: { label: string; pressed: boolean; disabled?: boolean; onClick(): void }) {
  return <button className={`toggle-button ${pressed ? "active" : "inactive"}`} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{label}</button>;
}

export default function App() {
  const nativeWindowFocused = useRef(false);
  const isForeground = useCallback(() => nativeWindowFocused.current && document.visibilityState === "visible", []);
  const [workspaceState, setWorkspaceState] = useState(() => loadWorkspace(localStorage));
  const refreshBusy = useRef(false);
  const contentPending = useRef(false);
  const refreshPending = useRef(false);
  const lastCheck = useRef(0);
  const currentRead = useRef<{ pair: ContentPair | null; scope: CompareScope; selected: string | null; repo: string | null }>({ pair: null, scope: "unstaged", selected: null, repo: null });
  const [path, setPath] = useState("");
  const [gitExecutable, setGitExecutable] = useState("");
  const [snapshots, setSnapshots] = useState<Record<string, RepositorySnapshot>>({});
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [pair, setPair] = useState<ContentPair | null>(null);
  const [diffDocument, setDiffDocument] = useState<DiffDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [highlight, setHighlight] = useState<"words" | "lines">("words");
  const [collapsed, setCollapsed] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [alignChanges, setAlignChanges] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [dark, setDark] = useState(true);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [fileView, setFileView] = useState<"flat" | "tree">("flat");
  const [scope, setScope] = useState<CompareScope>("unstaged");
  const [position, setPosition] = useState({ current: 0, total: 0 });
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [splitLayout, setSplitLayout] = useState({ ratio: 0.5, leftWidth: 0 });
  const [projectMessages, setProjectMessages] = useState<Record<string, string>>({});
  const repositoryGate = useRef(new RequestGate());
  const contentGate = useRef(new RequestGate());
  const restored = useRef(false);
  const opened = useRef(new Set<string>());
  const cache = useRef(new ContentCache());
  const scopeSnapshots = useRef(new Map<string, RepositorySnapshot>());
  const checkedAt = useRef(new Map<string, number>());
  const repoGeneration = useRef(new Map<string, number>());
  const snapshotGeneration = useRef(new Map<string, number>());
  const viewer = useRef<DiffViewerHandle>(null);
  const workspace = useRef<HTMLElement>(null);
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const activeRepoId = workspaceState.activeRepoId;
  const activeProject = workspaceState.projects.find((project) => project.repo.repoId === activeRepoId) ?? null;
  const snapshot = activeRepoId ? snapshots[activeRepoId] ?? null : null;

  currentRead.current = { pair, scope, selected: selectedPathId, repo: activeRepoId };

  useEffect(() => { try { saveWorkspace(localStorage, workspaceState); } catch { /* storage is optional */ } }, [workspaceState]);

  const updateAnchor = useCallback((patch: Partial<ReadingAnchor>) => {
    setWorkspaceState((current) => ({ ...current, projects: current.projects.map((project) => project.repo.repoId === current.activeRepoId ? { ...project, anchor: { ...project.anchor, ...patch } } : project) }));
  }, []);

  const clampSidebarWidth = useCallback((width: number) => {
    const available = workspace.current?.clientWidth ?? window.innerWidth;
    return Math.round(Math.min(Math.max(SIDEBAR_MIN_WIDTH, available - DIFF_MIN_WIDTH - 6), Math.max(SIDEBAR_MIN_WIDTH, width)));
  }, []);
  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    sidebarResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  };
  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = sidebarResize.current;
    if (active?.pointerId === event.pointerId) setSidebarWidth(clampSidebarWidth(active.startWidth + event.clientX - active.startX));
  };
  const endSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResize.current?.pointerId !== event.pointerId) return;
    sidebarResize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const selectFile = useCallback(async (nextSnapshot: RepositorySnapshot, file: FileChange, effectiveGitExecutable: string, restoreHunk = 0, automatic = false) => {
    if (!automatic && repositoryGate.current.cancelAutomatic()) setRefreshing(false);
    contentPending.current = true;
    const requestId = newRequestId();
    contentGate.current.activate(requestId, automatic);
    setSelectedPathId(file.pathId); updateAnchor({ selectedPathId: file.pathId, hunk: restoreHunk });
    const key = contentCacheKey(nextSnapshot.repo.repoId, nextSnapshot.scope, nextSnapshot.revision, file.pathId);
    const cachedPair = cache.current.get(key);
    const cachedDocument = cache.current.getDocument(key);
    const previous = currentRead.current;
    const sameFile = previous.pair?.repoId === nextSnapshot.repo.repoId && previous.scope === nextSnapshot.scope && previous.pair.pathId === file.pathId;
    if (!sameFile && !cachedDocument) { setPair(null); setDiffDocument(null); }
    setError(null); setNotice(null); setLoading(true);
    try {
      const result = cachedPair ?? await readContentPair(nextSnapshot.repo.repoId, nextSnapshot.scope, nextSnapshot.revision, file.pathId, effectiveGitExecutable || null, requestId);
      if (!contentGate.current.accepts(requestId)) return;
      if (result.stale) throw new Error("仓库内容在读取期间发生变化，请刷新后重试。旧结果未显示。");
      if (!cachedPair) cache.current.set(key, result);
      if (sameFile && previous.pair?.left.contentId === result.left.contentId && previous.pair?.right.contentId === result.right.contentId && previous.pair?.degradation === result.degradation) return;
      if (result.left.text !== null && result.right.text !== null) {
        const computed = cachedDocument ?? await calculateDiff(requestId, [result.left.contentId, result.right.contentId], editorText(result.left.text), editorText(result.right.text));
        if (!contentGate.current.accepts(requestId)) return;
        cache.current.setDocument(key, computed);
        setPair(result); setDiffDocument(computed);
        if (!sameFile && restoreHunk > 0) requestAnimationFrame(() => viewer.current?.navigateTo(restoreHunk));
      } else { setPair(result); setDiffDocument(null); }
    } catch (nextError) { if (contentGate.current.accepts(requestId)) setError(errorText(nextError)); }
    finally { if (contentGate.current.accepts(requestId)) { contentPending.current = false; setLoading(false); contentGate.current.finish(requestId); } }
  }, [updateAnchor]);

  const acceptSnapshot = useCallback(async (result: RepositorySnapshot, project: ProjectRecord, anchor: ReadingAnchor, requestId: string, automatic = false) => {
    if (!repositoryGate.current.accepts(requestId)) return;
    opened.current.add(result.repo.repoId);
    if (scopeSnapshots.current.get(`${result.repo.repoId}:${result.scope}`) !== result) {
      scopeSnapshots.current.set(`${result.repo.repoId}:${result.scope}`, result);
      checkedAt.current.set(`${result.repo.repoId}:${result.scope}`, Date.now());
      snapshotGeneration.current.set(`${result.repo.repoId}:${result.scope}`, repoGeneration.current.get(result.repo.repoId) ?? 0);
    }
    result.files.sort(compareFiles);
    const selection = resolveReadingSelection(result.files, anchor.selectedPathId);
    const nextAnchor = selection.invalidated
      ? { ...anchor, scope: result.scope, selectedPathId: selection.selected?.pathId ?? null, hunk: 0 }
      : { ...anchor, scope: result.scope };
    setSnapshots((current) => ({ ...current, [result.repo.repoId]: result }));
    setWorkspaceState((current) => {
      const latest = current.projects.find(entry => entry.repo.repoId === result.repo.repoId);
      return upsertProject(current, { ...project, customName: latest?.customName ?? project.customName, pinned: latest?.pinned ?? project.pinned, repo: result.repo, lastOpenedAt: Date.now(), anchor: nextAnchor });
    });
    setScope(result.scope); setPath(result.repo.worktreePath); setGitExecutable(project.gitExecutable); setFilter(anchor.filter); setFileView(anchor.fileView); setStale(false);
    const selected = selection.selected;
    if (selected) await selectFile(result, selected, project.gitExecutable, selection.invalidated ? 0 : anchor.hunk, automatic);
    else { contentPending.current = false; setSelectedPathId(null); setPair(null); setDiffDocument(null); updateAnchor({ selectedPathId: null, hunk: 0 }); }
    if (!repositoryGate.current.accepts(requestId)) return;
    if (selection.invalidated) setNotice(selected
      ? `此前选中的文件已不在当前比较范围中，已改为第一个可用变化文件：${selected.displayPath}`
      : "此前选中的文件已不在当前比较范围中；当前范围没有可阅读的变化，已清除阅读位置。");
  }, [selectFile, updateAnchor]);

  const loadProject = useCallback(async (project: ProjectRecord, anchor = project.anchor, restoring = false) => {
    const requestId = newRequestId(); repositoryGate.current.activate(requestId); contentGate.current.activate(requestId);
    setRefreshing(false);
    setLoading(true); setError(null); setNotice(null); setPair(null); setDiffDocument(null); setSelectedPathId(anchor.selectedPathId);
    setProjectMessages((current) => ({ ...current, [project.repo.repoId]: restoring ? "正在恢复" : "正在核对" }));
    try {
      const result = await openRepository(project.repo.worktreePath, anchor.scope, project.gitExecutable || null, requestId);
      if (!repositoryGate.current.accepts(requestId)) return;
      await acceptSnapshot(result, project, anchor, requestId);
      if (!repositoryGate.current.accepts(requestId)) return;
      setProjectMessages((current) => ({ ...current, [result.repo.repoId]: "已同步" }));
    } catch (nextError) {
      if (!repositoryGate.current.accepts(requestId)) return;
      const message = errorText(nextError);
      setError(restoring ? `项目恢复失败：${message}。记录已保留，请修复路径后手动载入。` : message);
      setProjectMessages((current) => ({ ...current, [project.repo.repoId]: "读取失败" }));
    } finally { if (repositoryGate.current.accepts(requestId)) { setLoading(false); repositoryGate.current.finish(requestId); contentGate.current.finish(requestId); } }
  }, [acceptSnapshot]);

  const addRepository = useCallback(async (repositoryPath: string, effectiveGitExecutable = gitExecutable) => {
    if (!repositoryPath.trim()) return;
    const requestId = newRequestId(); repositoryGate.current.activate(requestId); contentGate.current.activate(requestId);
    setRefreshing(false);
    setLoading(true); setError(null);
    try {
      const result = await openRepository(repositoryPath.trim(), "unstaged", effectiveGitExecutable || null, requestId);
      if (!repositoryGate.current.accepts(requestId)) return;
      const existing = workspaceState.projects.find((project) => project.repo.repoId === result.repo.repoId);
      const project: ProjectRecord = existing ?? { repo: result.repo, gitExecutable: effectiveGitExecutable, pinned: false, lastOpenedAt: Date.now(), anchor: defaultAnchor() };
      await acceptSnapshot(result, { ...project, gitExecutable: effectiveGitExecutable }, project.anchor, requestId);
      if (!repositoryGate.current.accepts(requestId)) return;
      setProjectMessages((current) => ({ ...current, [result.repo.repoId]: existing ? "已存在，已切换" : "已添加" }));
    } catch (nextError) { if (repositoryGate.current.accepts(requestId)) setError(errorText(nextError)); }
    finally { if (repositoryGate.current.accepts(requestId)) { setLoading(false); repositoryGate.current.finish(requestId); contentGate.current.finish(requestId); } }
  }, [acceptSnapshot, gitExecutable, workspaceState.projects]);

  const refreshActive = useCallback(async (reason = "手动刷新") => {
    const automatic = reason !== "手动刷新";
    if (automatic && !isForeground()) { refreshPending.current = true; return; }
    if (!activeProject || !activeRepoId) return;
    if (loading || refreshBusy.current || repositoryGate.current.hasRequiredPending() || contentGate.current.hasRequiredPending()) { refreshPending.current = true; return; }
    // Startup/explicit actions own repository opening. Focus events must not
    // restart a failed or still-pending initialization behind the user's back.
    if (!opened.current.has(activeRepoId)) { if (!automatic) await loadProject(activeProject, activeProject.anchor, true); return; }
    if (reason === "前台核对" && Date.now() - lastCheck.current < 3000) return;
    refreshBusy.current = true; lastCheck.current = Date.now();
    const requestId = newRequestId(); repositoryGate.current.activate(requestId, automatic);
    setRefreshing(true); setProjectMessages((current) => ({ ...current, [activeRepoId]: `${reason}中` }));
    try {
      const result = await refreshRepository(activeRepoId, scope, requestId);
      if (!repositoryGate.current.accepts(requestId)) return;
      checkedAt.current.set(`${activeRepoId}:${scope}`, Date.now());
      const priorRevision = snapshots[activeRepoId]?.revision;
      if (priorRevision && priorRevision !== result.revision) cache.current.clearRepo(activeRepoId);
      if (priorRevision !== result.revision || contentPending.current) {
        const live = currentRead.current;
        await acceptSnapshot(result, activeProject, { ...activeProject.anchor, selectedPathId: live.selected }, requestId, automatic);
      }
      if (!repositoryGate.current.accepts(requestId)) return;
      setStale(false); setError(null);
      setProjectMessages((current) => ({ ...current, [activeRepoId]: "已同步" }));
    } catch (nextError) {
      if (!repositoryGate.current.accepts(requestId)) return;
      setStale(true); setError(`${reason}失败：${errorText(nextError)}。保留上一份快照并标为旧。`);
      setProjectMessages((current) => ({ ...current, [activeRepoId]: "旧快照" }));
    } finally {
      refreshBusy.current = false;
      if (repositoryGate.current.accepts(requestId)) { setRefreshing(false); repositoryGate.current.finish(requestId); }
      if (isForeground() && refreshPending.current) { refreshPending.current = false; window.setTimeout(() => void refreshLatest.current("合并变化"), 300); }
    }
  }, [acceptSnapshot, activeProject, activeRepoId, scope, snapshots, loading, loadProject]);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const project = workspaceState.projects.find((entry) => entry.repo.repoId === workspaceState.activeRepoId) ?? workspaceState.projects[0];
    if (project) {
      void loadProject(project, project.anchor, true);
      return;
    }
    try {
      const legacy = JSON.parse(localStorage.getItem("oris.recentRepository.v1") ?? "null") as { path?: unknown; gitExecutable?: unknown } | null;
      if (legacy && typeof legacy.path === "string" && legacy.path.trim()) {
        const executable = typeof legacy.gitExecutable === "string" ? legacy.gitExecutable : "";
        setPath(legacy.path); setGitExecutable(executable);
        void addRepository(legacy.path, executable);
      }
    } catch { /* invalid legacy state is ignored once */ }
  }, [addRepository, loadProject, workspaceState]);

  useEffect(() => {
    if (!activeProject) return;
    setScope(activeProject.anchor.scope); setFilter(activeProject.anchor.filter); setFileView(activeProject.anchor.fileView); setPath(activeProject.repo.worktreePath); setGitExecutable(activeProject.gitExecutable);
  }, [activeProject?.repo.repoId]);

  const refreshLatest = useRef(refreshActive);
  refreshLatest.current = refreshActive;
  useEffect(() => {
    if (isForeground() && !loading && refreshPending.current && !refreshBusy.current) {
      refreshPending.current = false;
      const timer = window.setTimeout(() => void refreshLatest.current("合并变化"), 300);
      return () => window.clearTimeout(timer);
    }
  }, [loading]);
  useEffect(() => {
    let focusTimer = 0;
    let timer = 0;
    const startPolling = () => { window.clearInterval(timer); timer = window.setInterval(() => { if (isForeground()) void refreshLatest.current("前台核对"); }, 30000); };
    const check = () => {
      if (!isForeground()) return;
      window.clearTimeout(focusTimer); startPolling();
      focusTimer = window.setTimeout(() => {
        refreshPending.current = false;
        void refreshLatest.current("回到前台");
      }, 150);
    };
    const blur = () => {
      window.clearTimeout(focusTimer); window.clearInterval(timer);
      refreshPending.current = true;
      // Only automatic updates are cancelled. Required initialization and
      // explicit reads retain their request IDs and complete or report errors.
      const cancelledRepository = repositoryGate.current.cancelAutomatic();
      const cancelledContent = contentGate.current.cancelAutomatic();
      if (cancelledRepository) setRefreshing(false);
      if (cancelledContent) setLoading(false);
    };
    let disposed = false;
    const applyFocus = (focused: boolean) => {
      if (disposed) return;
      nativeWindowFocused.current = focused;
      if (isForeground()) check(); else blur();
    };
    const nativeWindow = getCurrentWindow();
    let focusGeneration = 0;
    const queryFocus = () => {
      const generation = ++focusGeneration;
      void nativeWindow.isFocused().then(focused => {
        if (generation === focusGeneration) applyFocus(focused);
      }, () => { if (generation === focusGeneration) applyFocus(false); });
    };
    const unlistenFocus = nativeWindow.onFocusChanged(event => { focusGeneration++; applyFocus(event.payload); });
    const visibility = () => { if (document.visibilityState === "visible") queryFocus(); else { focusGeneration++; blur(); } };
    document.addEventListener("visibilitychange", visibility);
    queryFocus();
    return () => { disposed = true; window.clearTimeout(focusTimer); document.removeEventListener("visibilitychange", visibility); window.clearInterval(timer); void unlistenFocus.then(dispose => dispose()); };
  }, []);

  useEffect(() => {
    let timer = 0;
    const unlisten = listen<string>("repository-invalidated", (event) => {
      repoGeneration.current.set(event.payload, (repoGeneration.current.get(event.payload) ?? 0) + 1);
      if (event.payload !== currentRead.current.repo) return;
      refreshPending.current = true;
      if (!isForeground()) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { refreshPending.current = false; void refreshLatest.current("外部变化"); }, 300);
    });
    return () => { window.clearTimeout(timer); void unlisten.then((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    const current = workspace.current; if (!current) return;
    const observer = new ResizeObserver(() => setSidebarWidth((width) => clampSidebarWidth(width)));
    observer.observe(current); return () => observer.disconnect();
  }, [clampSidebarWidth]);

  const chooseRepository = async () => {
    const selected = await open({ directory: true, multiple: false, title: "添加已有 Git 仓库" });
    if (typeof selected === "string") await addRepository(selected);
  };
  const switchProject = async (project: ProjectRecord) => {
    if (project.repo.repoId === activeRepoId && snapshot) return;
    const switchingId = newRequestId(); repositoryGate.current.activate(switchingId); contentGate.current.activate(switchingId);
    setWorkspaceState((current) => ({ ...current, activeRepoId: project.repo.repoId })); setError(null); setNotice(null); setStale(false);
    const cached = snapshots[project.repo.repoId];
    if (!cached || cached.scope !== project.anchor.scope || !opened.current.has(project.repo.repoId)) {
      setPair(null); setDiffDocument(null);
      await loadProject(project);
      return;
    }
    setScope(project.anchor.scope); setFilter(project.anchor.filter); setFileView(project.anchor.fileView); setPath(project.repo.worktreePath); setGitExecutable(project.gitExecutable);
    const selection = resolveReadingSelection(cached.files, project.anchor.selectedPathId);
    const selected = selection.selected;
    const nextAnchor = selection.invalidated
      ? { ...project.anchor, selectedPathId: selected?.pathId ?? null, hunk: 0 }
      : project.anchor;
    const cachedInvalidationNotice = selected
      ? `此前选中的文件已不在缓存快照中，已改为第一个可用变化文件：${selected.displayPath}`
      : "此前选中的文件已不在缓存快照中；当前范围没有可阅读的变化，已清除阅读位置。";
    if (selected) await selectFile(cached, selected, project.gitExecutable, selection.invalidated ? 0 : project.anchor.hunk);
    else { setSelectedPathId(null); setPair(null); setDiffDocument(null); updateAnchor({ selectedPathId: null, hunk: 0 }); }
    if (!repositoryGate.current.accepts(switchingId)) return;
    repositoryGate.current.finish(switchingId); contentGate.current.finish(switchingId);
    if (Date.now() - (checkedAt.current.get(`${project.repo.repoId}:${cached.scope}`) ?? cached.scannedAt) < 3000 && snapshotGeneration.current.get(`${project.repo.repoId}:${cached.scope}`) === (repoGeneration.current.get(project.repo.repoId) ?? 0)) return;
    if (selection.invalidated) setNotice(cachedInvalidationNotice);
    const requestId = newRequestId(); repositoryGate.current.activate(requestId);
    setRefreshing(true);
    try {
      const result = await refreshRepository(project.repo.repoId, project.anchor.scope, requestId);
      if (!repositoryGate.current.accepts(requestId)) return;
      checkedAt.current.set(`${project.repo.repoId}:${project.anchor.scope}`, Date.now());
      if (result.revision !== cached.revision) cache.current.clearRepo(project.repo.repoId);
      if (result.revision !== cached.revision) await acceptSnapshot(result, { ...project, anchor: nextAnchor }, { ...nextAnchor, selectedPathId: currentRead.current.selected }, requestId);
      if (selection.invalidated) setNotice(cachedInvalidationNotice);
      setProjectMessages((current) => ({ ...current, [project.repo.repoId]: "已同步" }));
    } catch (nextError) {
      if (repositoryGate.current.accepts(requestId)) {
        setStale(true); setError(`项目核对失败：${errorText(nextError)}。保留上一份快照并标为旧。`);
        setProjectMessages((current) => ({ ...current, [project.repo.repoId]: "旧快照" }));
      }
    } finally { if (repositoryGate.current.accepts(requestId)) { setRefreshing(false); repositoryGate.current.finish(requestId); } }
  };
  const setCompareScope = async (nextScope: CompareScope) => {
    if (!activeProject || nextScope === scope) return;
    const anchor = { ...activeProject.anchor, scope: nextScope, selectedPathId: null, hunk: 0 };
    setScope(nextScope); updateAnchor(anchor); setPair(null); setDiffDocument(null);
    const project = { ...activeProject, anchor };
    if (!opened.current.has(project.repo.repoId)) { await loadProject(project); return; }
    const requestId = newRequestId(); repositoryGate.current.activate(requestId); contentGate.current.activate(requestId); setLoading(true);
    try {
      const cached = scopeSnapshots.current.get(`${project.repo.repoId}:${nextScope}`);
      if (cached) { await acceptSnapshot(cached, project, anchor, requestId); if (!repositoryGate.current.accepts(requestId)) return; setLoading(false);
        if (Date.now() - (checkedAt.current.get(`${project.repo.repoId}:${cached.scope}`) ?? cached.scannedAt) < 3000 && snapshotGeneration.current.get(`${project.repo.repoId}:${nextScope}`) === (repoGeneration.current.get(project.repo.repoId) ?? 0)) return;
      }
      const result = await refreshRepository(project.repo.repoId, nextScope, requestId);
      if (!repositoryGate.current.accepts(requestId)) return;
      checkedAt.current.set(`${project.repo.repoId}:${nextScope}`, Date.now());
      if (!cached || result.revision !== cached.revision) await acceptSnapshot(result, project, { ...anchor, selectedPathId: currentRead.current.selected }, requestId);
    }
    catch (nextError) { if (repositoryGate.current.accepts(requestId)) setError(errorText(nextError)); }
    finally { if (repositoryGate.current.accepts(requestId)) { setLoading(false); repositoryGate.current.finish(requestId); contentGate.current.finish(requestId); } }
  };
  const deleteProject = async (repoId: string) => {
    const nextProject = workspaceState.projects.find((project) => project.repo.repoId !== repoId) ?? null;
    cache.current.clearRepo(repoId); opened.current.delete(repoId);
    for (const key of scopeSnapshots.current.keys()) if (key.startsWith(`${repoId}:`)) scopeSnapshots.current.delete(key);
    setSnapshots((current) => { const next = { ...current }; delete next[repoId]; return next; });
    setWorkspaceState((current) => removeProject(current, repoId));
    try { await closeRepository(repoId); } catch { /* local record removal is complete */ }
    if (repoId === activeRepoId) {
      const requestId = newRequestId(); repositoryGate.current.activate(requestId); contentGate.current.activate(requestId); setPair(null); setDiffDocument(null); setSelectedPathId(null); setError(null);
      setLoading(false); setRefreshing(false); contentPending.current = false;
      repositoryGate.current.finish(requestId); contentGate.current.finish(requestId);
      if (nextProject) await loadProject(nextProject);
    }
  };

  const visibleFiles = useMemo(() => { const query = filter.trim().toLocaleLowerCase(); return snapshot?.files.filter((file) => file.displayPath.toLocaleLowerCase().includes(query)).sort(compareFiles) ?? []; }, [snapshot, filter]);
  const visibleProjects = useMemo(() => { const query = projectFilter.trim().toLocaleLowerCase(); return workspaceState.projects.filter((project) => `${projectName(project)} ${project.repo.worktreePath}`.toLocaleLowerCase().includes(query)); }, [projectFilter, workspaceState.projects]);
  const selectedFile = snapshot?.files.find((file) => file.pathId === selectedPathId);
  const selectedIndex = visibleFiles.findIndex((file) => file.pathId === selectedPathId);
  const readable = pair?.left.text !== null && pair?.right.text !== null;
  const endpoints = scopeLabels[scope].endpoints;
  const presentation = useMemo<DiffPresentation>(() => selectedFile && pair
    ? resolveDiffPresentation(selectedFile.status, pair.left, pair.right)
    : { kind: "compare" }, [selectedFile, pair]);
  const singleFile = presentation.kind === "single";
  const singleTextSide = singleFile && pair ? (presentation.side === "a" ? pair.left : pair.right) : null;
  const singleEndpointLabel = singleFile
    ? presentation.side === "a" ? (pair?.left.endpoint === "emptyTree" ? "空树" : endpoints[0]) : endpoints[1]
    : "";
  const diffModes = availableDiffModes(presentation);
  const navigateFile = (direction: -1 | 1) => {
    if (!snapshot || !visibleFiles.length) return;
    const index = selectedIndex < 0 ? 0 : (selectedIndex + direction + visibleFiles.length) % visibleFiles.length;
    void selectFile(snapshot, visibleFiles[index], activeProject?.gitExecutable ?? "");
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault(); navigateFile(event.key === "ArrowUp" ? -1 : 1); return;
      }
      if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) {
        const project = workspaceState.projects[Number(event.key) - 1];
        if (project) { event.preventDefault(); void switchProject(project); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  const handlePositionChange = useCallback((current: number, total: number) => { setPosition({ current, total }); if (current > 0) updateAnchor({ hunk: current - 1 }); }, [updateAnchor]);
  const handleSplitLayoutChange = useCallback((ratio: number, leftWidth: number) => { setSplitLayout((current) => Math.abs(current.ratio - ratio) < .0001 && current.leftWidth === leftWidth ? current : { ratio, leftWidth }); }, []);

  return <main className={dark ? "app dark" : "app light"}>
    <header className="titlebar"><span className="logo">O</span><strong>{activeProject ? projectName(activeProject) : "Oris"}</strong>{snapshot && <span className="branch">⑂ {snapshot.repo.branch}</span>}{stale && <span className="stale-badge">旧快照</span>}<span className="spacer"/><span className="readonly">▣ 只读</span><button onClick={() => setDark((value) => !value)} aria-label="切换主题">{dark ? "☀" : "☾"}</button></header>
    <section className="projectbar" aria-label="项目切换"><button className="primary" onClick={chooseRepository}>添加项目</button><input value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} placeholder="搜索项目或完整路径" aria-label="搜索项目"/><div className="project-tabs">{visibleProjects.map(project => <ProjectTab key={project.repo.repoId} project={project} active={project.repo.repoId === activeRepoId}
      onSelect={() => void switchProject(project)}
      onRename={customName => setWorkspaceState(current => ({ ...current, projects: current.projects.map(p => p.repo.repoId === project.repo.repoId ? { ...p, customName } : p) }))}
      onRemove={() => void deleteProject(project.repo.repoId)}
      onReorder={target => setWorkspaceState(current => moveProject(current, project.repo.repoId, target))}/>)}{!visibleProjects.length && <span className="project-empty">{workspaceState.projects.length ? "没有匹配项目" : "尚未添加项目"}</span>}</div></section>
    <section className="openbar"><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="仓库绝对路径" aria-label="仓库路径"/><button onClick={() => void addRepository(path)} disabled={loading || !path.trim()}>载入/添加</button><details><summary>Git 设置</summary><input value={gitExecutable} onChange={(event) => setGitExecutable(event.target.value)} placeholder="留空自动发现 Git" aria-label="Git 可执行文件"/></details>{snapshot && <button onClick={() => void refreshActive()} disabled={refreshing}>↻ 本地刷新</button>}{snapshot && <span className="restore-status">{projectMessages[snapshot.repo.repoId] ?? "已同步"} · {new Date(snapshot.scannedAt).toLocaleTimeString()}</span>}</section>
    <section className="workspace" ref={workspace} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className="sidebar"><div className="panel-title"><strong>变更</strong><span>{endpoints[0]} → {endpoints[1]}</span></div><div className="scope-row">{(["unstaged", "staged", "all"] as CompareScope[]).map((value) => <button key={value} className={`scope ${scope === value ? "selected" : ""}`} onClick={() => void setCompareScope(value)}>{scopeLabels[value].short}</button>)}<select className="file-view-select" aria-label="文件显示方式" title={fileView === "flat" ? "平铺显示相对路径" : "树状显示目录"} value={fileView} onChange={(event) => { const value = event.target.value as "flat" | "tree"; setFileView(value); updateAnchor({ fileView: value }); }}><option value="flat">☷</option><option value="tree">⑂</option></select></div><input className="filter" aria-label="按完整相对路径筛选" value={filter} onChange={(event) => { setFilter(event.target.value); updateAnchor({ filter: event.target.value }); }} placeholder="按完整相对路径筛选"/><div className="files" role="listbox" aria-label={`${scopeLabels[scope].short}变更`}>{snapshot && <FileTree files={visibleFiles} selectedPathId={selectedPathId} mode={fileView} onSelect={(file) => void selectFile(snapshot, file, activeProject?.gitExecutable ?? "")}/>} {snapshot && !visibleFiles.length && <div className="empty">{filter ? "筛选无匹配文件" : "当前比较范围没有变化"}</div>}{!snapshot && <div className="empty">添加或选择一个真实 Git 仓库</div>}</div><footer>{snapshot ? `${visibleFiles.length} / ${snapshot.files.length} 个文件 · ${scopeLabels[scope].short}` : error ? "项目读取失败" : loading ? "正在读取项目状态" : "未知项目状态"}</footer></aside>
      <div className="workspace-resizer" role="separator" aria-label="调整文件侧栏宽度" aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={beginSidebarResize} onPointerMove={moveSidebarResize} onPointerUp={endSidebarResize} onPointerCancel={endSidebarResize} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setSidebarWidth((width) => clampSidebarWidth(width + (event.key === "ArrowLeft" ? -16 : 16))); }}/>
      <section className="editor"><div className="tabbar"><strong>{selectedFile?.displayPath ?? "Diff"}</strong>{selectedFile?.oldDisplayPath && <span className="rename-path">← {selectedFile.oldDisplayPath}</span>}<span className="spacer"/>{diffDocument && <span>{diffDocument.hunks.length} 处差异 · Worker {diffDocument.elapsedMs.toFixed(1)} ms</span>}</div><div className="toolbar"><button onClick={() => viewer.current?.navigate(-1)} disabled={!position.total}>↑</button><button onClick={() => viewer.current?.navigate(1)} disabled={!position.total}>↓</button><span>{position.current} / {position.total}</span><select value={singleFile ? "single" : mode} disabled={singleFile} onChange={(event) => { const value = event.target.value; if (value === "split" || value === "unified") setMode(value); }} aria-label="Diff 布局">{diffModes.includes("single") && <option value="single">单文件视图</option>}{diffModes.includes("split") && <option value="split">并排视图</option>}{diffModes.includes("unified") && <option value="unified">统一视图</option>}</select><select value={highlight} disabled={singleFile} onChange={(event) => setHighlight(event.target.value as "words" | "lines")} aria-label="高亮粒度"><option value="words">按词高亮</option><option value="lines">按行高亮</option></select><ToggleButton label="折叠上下文" pressed={collapsed} disabled={singleFile} onClick={() => setCollapsed((value) => !value)}/><ToggleButton label="自动换行" pressed={wrap} onClick={() => setWrap((value) => !value)}/><ToggleButton label="对齐变化" pressed={alignChanges} disabled={singleFile} onClick={() => setAlignChanges((value) => !value)}/><label className="font-control">字号 <input type="range" min="11" max="18" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))}/><output>{fontSize}</output></label></div>
        <div className={singleFile ? "endpoints single" : mode === "split" ? "endpoints split" : "endpoints"} style={{ "--diff-header-left-width": `${splitLayout.leftWidth}px` } as CSSProperties}>{singleFile ? <span className="single-endpoint"><span>▣ {singleEndpointLabel}</span>{singleTextSide && <span className="encoding">{singleTextSide.encoding} · {singleTextSide.eol.toUpperCase()}{singleTextSide.hasFinalNewline === false ? " · 无末尾换行" : ""}</span>}</span> : <><span>▣ {pair?.left.endpoint === "emptyTree" ? "空树" : endpoints[0]}</span>{mode === "split" && <span className="endpoint-gutter" aria-hidden="true"/>}<span className="right-endpoint"><span>▣ {endpoints[1]}</span>{pair && <span className="encoding">{pair.right.encoding} · {pair.right.eol.toUpperCase()}{pair.right.hasFinalNewline === false ? " · 无末尾换行" : ""}</span>}</span></>}</div>
        <div className="content">{notice && <div className="selection-notice" role="status"><strong>阅读位置已调整</strong><span>{notice}</span></div>}{loading && !diffDocument && <div className="state">正在读取真实仓库…</div>}{error && <div className="state error"><strong>无法显示差异</strong><p>{error}</p></div>}{!loading && !error && pair?.degradation && <div className="state warning"><strong>内容已降级</strong><p>{pair.degradation}</p></div>}{!error && readable && pair && diffDocument && <DiffViewer readingKey={`${pair.repoId}:${scope}:${pair.pathId}`} presentation={presentation} ref={viewer} left={editorText(pair.left.text ?? "")} right={editorText(pair.right.text ?? "")} document={diffDocument} mode={mode} highlight={highlight} collapsed={collapsed} wrap={wrap} fontSize={fontSize} dark={dark} alignChanges={alignChanges} onPositionChange={handlePositionChange} onSplitLayoutChange={handleSplitLayoutChange}/>} {!loading && !error && !pair && <div className="state">选择一个变化文件开始阅读</div>}</div><footer className="diff-footer"><span>蓝：修改　绿：新增　灰：删除</span><span className="spacer"/>{snapshot && <span>Git {snapshot.git.version} · revision {snapshot.revision.slice(0, 8)}</span>}</footer></section>
    </section>
    <footer className="statusbar"><span>{snapshot ? `${snapshot.repo.worktreePath} · ${snapshot.repo.branch} · ${scopeLabels[scope].short}` : "多项目 → 本地差异浏览"}</span><span className="spacer"/><span>本机 Git · 刷新不联网 · 缓存 {cache.current.stats().entries}/{cache.current.stats().budget / 1024 / 1024} MiB</span></footer>
  </main>;
}
