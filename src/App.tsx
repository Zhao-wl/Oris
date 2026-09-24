import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activateRepository, cancelContentRead, closeRepository, loadSnapshot, openRepository, readContentPair, refreshRepository, removeSnapshot, repositoryDetails, saveSnapshot } from "./api";
import { errorText } from "./error-message";
import { calculateDiff } from "./diff";
import { availableDiffModes, resolveDiffPresentation, type DiffPresentation } from "./diff-presentation";
import DiffViewer, { type DiffViewerHandle } from "./DiffViewer";
import ImageViewer from "./ImageViewer";
import FileTree, { compareFiles, contentUnchangedLabels, type FileAction, type FileActions } from "./FileTree";
import ProjectTab from "./ProjectTab";
import { ProjectStore, parsePersistedSnapshot, persistableSnapshot, scopeView, statsPending } from "./project-store";
import { createStore, useStore } from "./store";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import GitPanel, { type GitTab, type OperationRecord, type RunningOperation } from "./GitPanel";
import { cancelOperation, discardBackups, prepareDiscard, runOperation, type BackupSummary, type HeadCommitInfo, type OperationOutcome, type OperationRequest } from "./operations-api";
import { operationLabels, optimisticMove, pathIdsFor, refsKinds, selectionAfterOperation, stashKinds, switchKinds, undoCommitText, unsupportedInProgress, writeBlockedReason } from "./operations-model";
import SettingsDialog from "./SettingsDialog";
import HistoryPanel, { type FileHistoryRequest, type HistoryFileOpen } from "./HistoryPanel";
import FetchDialog from "./FetchDialog";
import { readRefs, readRevisionPair, type Branch, type RefsView, type StashEntry } from "./history-api";
import BranchPopover, { type BranchActions } from "./BranchPopover";
import { NewBranchDialog, RenameBranchDialog, TrackChoiceDialog, UpstreamDialog, type NewBranchRequest } from "./BranchDialogs";
import StashPanel, { type StashPushOptions } from "./StashPanel";
import { fetchTimeText, historyStatus, isStale as isStaleError, loadFetchRecord, parseProgress, saveFetchRecord } from "./history-model";
import SelectionNotice from "./SelectionNotice";
import { activeScheme, settings } from "./appearance";
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, useSettings } from "./settings";
import { isDarkType } from "./themes/runtime";
import type { CompareScope, ConflictVersion, ContentPair, DiffDocument, FileChange, RepositorySnapshot } from "./types";
import { ContentCache, DiffCache, RequestGate, projectName, moveProject, contentCacheKey, defaultAnchor, loadWorkspace, removeProject, resolveReadingSelection, saveWorkspace, upsertProject, type ProjectRecord, type ReadingAnchor } from "./workspace-model";

const newRequestId = () => crypto.randomUUID();
/** 连续切换文件的判定间隔与内容请求延迟（技术方案 §5.7）。 */
const BURST_WINDOW_MS = 150;
const BURST_DELAY_MS = 80;
const isImagePath = (path: string) => /\.(png|jpe?g|webp)$/i.test(path);
const editorText = (text: string) => text.replace(/\r\n?/g, "\n");
const SIDEBAR_MIN_WIDTH = 180;
const DIFF_MIN_WIDTH = 480;
const versionLabels: Record<ConflictVersion, string> = { stage1: "Base · stage 1", stage2: "stage 2", stage3: "stage 3", workingTree: "当前 Working Tree" };
const scopeLabels: Record<CompareScope, { short: string; endpoints: [string, string] }> = {
  unstaged: { short: "未暂存", endpoints: ["Index（暂存区）", "Working Tree（工作区）"] },
  staged: { short: "已暂存", endpoints: ["HEAD（当前提交）", "Index（暂存区）"] },
  all: { short: "全部", endpoints: ["HEAD（当前提交）", "Working Tree（工作区）"] }
};

function ToggleButton({ label, pressed, disabled = false, onClick }: { label: string; pressed: boolean; disabled?: boolean; onClick(): void }) {
  return <button className={`toggle-button ${pressed ? "active" : "inactive"}`} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{label}</button>;
}

export default function App() {
  const nativeWindowFocused = useRef(false);
  const isForeground = useCallback(() => nativeWindowFocused.current && document.visibilityState === "visible", []);
  const [workspaceState, setWorkspaceState] = useState(() => loadWorkspace(localStorage));
  const refreshBusy = useRef(false);
  const manualPending = useRef<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const selectedGeneration = useRef(0);
  const readingPath = useRef<string | null>(null);
  const autoNotBefore = useRef(0);
  const completionTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(completionTimer.current), []);
  const contentPending = useRef(false);
  const contentReadFailed = useRef(false);
  const refreshPending = useRef(false);
  const lastCheck = useRef(0);
  const currentRead = useRef<{ pair: ContentPair | null; scope: CompareScope; selected: string | null; repo: string | null; versions: [ConflictVersion, ConflictVersion] }>({ pair: null, scope: "unstaged", selected: null, repo: null, versions: ["stage2", "stage3"] });
  const [path, setPath] = useState("");
  const [gitExecutable, setGitExecutable] = useState("");
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [versions, setVersions] = useState<[ConflictVersion, ConflictVersion]>(["stage2", "stage3"]);
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
  // 字号、浅深色与配色来自全局设置（V2-06）；Git 路径改为全局设置（V2-D24）。
  const fontSize = useSettings(settings, (value) => value.appearance.fontSize);
  const gitSetting = useSettings(settings, (value) => value.git.executable);
  const scheme = useStore(activeScheme, (value) => value);
  const dark = scheme ? isDarkType(scheme.type) : true;
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const diffCache = useRef(new DiffCache());
  const projects = useRef(new ProjectStore()).current;
  const lastSelectAt = useRef(Number.NEGATIVE_INFINITY);
  const burstSelect = useRef(false);
  const prefetchTimer = useRef(0);
  const persistTimer = useRef(0);
  const visibleFilesRef = useRef<FileChange[]>([]);
  useEffect(() => () => { window.clearTimeout(prefetchTimer.current); window.clearTimeout(persistTimer.current); }, []);
  const scopeSnapshots = useRef(new Map<string, RepositorySnapshot>());
  const checkedAt = useRef(new Map<string, number>());
  const repoGeneration = useRef(new Map<string, number>());
  const snapshotGeneration = useRef(new Map<string, number>());
  const viewer = useRef<DiffViewerHandle>(null);
  const workspace = useRef<HTMLElement>(null);
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const activeRepoId = workspaceState.activeRepoId;
  const activeProject = workspaceState.projects.find((project) => project.repo.repoId === activeRepoId) ?? null;
  const runtime = useStore(projects.store, (map) => (activeRepoId ? map[activeRepoId] : undefined));
  const snapshot = useMemo(() => (runtime?.snapshot ? scopeView(runtime.snapshot, runtime.details, scope) : null), [runtime, scope]);
  const pendingStats = statsPending(runtime?.snapshot, runtime?.details);

  // ---------- 写操作（V2-02）：每个仓库的运行中操作、实时输出、最近结果与可撤销的丢弃 ----------
  interface RepoOps { running: RunningOperation | null; lines: string[]; last: OperationRecord | null; lastCommit: OperationRecord | null; backups: BackupSummary[]; lastBackup: BackupSummary | null }
  const opStore = useRef(createStore<Record<string, RepoOps>>({})).current;
  const repoOps = useStore(opStore, (map) => (activeRepoId ? map[activeRepoId] : undefined));
  const updateOps = useCallback((repoId: string, patch: Partial<RepoOps> | ((current: RepoOps) => Partial<RepoOps>)) => {
    opStore.set((map) => {
      const current = map[repoId] ?? { running: null, lines: [], last: null, lastCommit: null, backups: [], lastBackup: null };
      return { ...map, [repoId]: { ...current, ...(typeof patch === "function" ? patch(current) : patch) } };
    });
  }, [opStore]);
  /** 写操作进行中的仓库：期间不发起自动刷新（watcher 事件在后端屏蔽，结束时返回精确刷新的快照）。 */
  const opRunning = useRef(new Set<string>());
  const [gitTab, setGitTab] = useState<GitTab | null>(null);
  // ---------- 历史阅读（任务 04）：主阅读器显示按提交 OID 读取的版本，本地阅读位置保留以便返回 ----------
  const [historyReading, setHistoryReading] = useState<(HistoryFileOpen & { returnTo: { pathId: string | null; hunk: number } }) | null>(null);
  const historyRef = useRef(historyReading);
  historyRef.current = historyReading;
  const [logMounted, setLogMounted] = useState<string | null>(null);
  const [refsVersion, setRefsVersion] = useState(0);
  const [fileHistoryRequest, setFileHistoryRequest] = useState<FileHistoryRequest | null>(null);
  const [refsView, setRefsView] = useState<RefsView | null>(null);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetchRecordVersion, setFetchRecordVersion] = useState(0);
  // ---------- 分支与 stash（V2-03） ----------
  const [branchOpen, setBranchOpen] = useState(false);
  const [newBranch, setNewBranch] = useState<{ initial: { ref: string; label: string } | null } | null>(null);
  const [renameBranch, setRenameBranch] = useState<Branch | null>(null);
  const [upstreamBranch, setUpstreamBranch] = useState<Branch | null>(null);
  const [trackChoice, setTrackChoice] = useState<{ remote: Branch; existing: string } | null>(null);
  const [stashVersion, setStashVersion] = useState(0);
  const [stashMounted, setStashMounted] = useState<string | null>(null);
  const [stashCount, setStashCount] = useState<number | null>(null);
  const [multiSelection, setMultiSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmState, setConfirmState] = useState<(ConfirmRequest & { resolve(ok: boolean): void }) | null>(null);
  const askConfirm = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => setConfirmState({ ...request, resolve })), []);
  const workspaceRef = useRef(workspaceState);
  workspaceRef.current = workspaceState;

  currentRead.current = { pair, scope, selected: selectedPathId, repo: activeRepoId, versions };

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

  /** 后台补齐统计与“全部”范围修正；完成后保存轻量快照。 */
  const loadDetails = useRef((_snapshot: RepositorySnapshot) => {});
  loadDetails.current = (next: RepositorySnapshot) => {
    const repoId = next.repo.repoId;
    const persist = () => {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        const current = projects.get(repoId);
        if (!current?.snapshot?.scopes || current.verifying) return;
        void saveSnapshot(current.snapshot.repo.worktreePath, persistableSnapshot(current.snapshot, current.details)).catch(() => {});
      }, 1000);
    };
    if (!next.scopes) return;
    if (next.statsReady !== false || projects.get(repoId)?.details?.revision === next.revision) { persist(); return; }
    void repositoryDetails(repoId, next.revision).then((details) => {
      if (!details || projects.get(repoId)?.snapshot?.revision !== details.revision) return;
      projects.update(repoId, { details });
      persist();
    }, () => {});
  };
  /** 空闲时预取列表中上下相邻各 1 个 ≤256 KiB 的文本文件（后端做大小检查）。 */
  const schedulePrefetch = useRef((_snapshot: RepositorySnapshot, _file: FileChange, _git: string) => {});
  schedulePrefetch.current = (nextSnapshot: RepositorySnapshot, file: FileChange, effectiveGitExecutable: string) => {
    window.clearTimeout(prefetchTimer.current);
    if (!nextSnapshot.scopes) return;
    prefetchTimer.current = window.setTimeout(() => {
      const list = visibleFilesRef.current;
      const index = list.findIndex((entry) => entry.pathId === file.pathId);
      if (index < 0 || list.length < 2) return;
      const neighbours = [list[(index + 1) % list.length], list[(index - 1 + list.length) % list.length]];
      for (const neighbour of new Set(neighbours)) {
        if (neighbour.pathId === file.pathId || neighbour.status === "conflicted" || isImagePath(neighbour.displayPath)) continue;
        const key = contentCacheKey(nextSnapshot.repo.repoId, nextSnapshot.scope, nextSnapshot.revision, neighbour.pathId);
        if (cache.current.get(key)) continue;
        void readContentPair(nextSnapshot.repo.repoId, nextSnapshot.scope, nextSnapshot.revision, neighbour.pathId, null, newRequestId(), undefined, true).then(async (result) => {
          if (!result || result.stale || result.left.text === null || result.right.text === null) return;
          cache.current.set(key, result);
          if (!diffCache.current.get(result.left.contentId, result.right.contentId)) {
            const document = await calculateDiff(`prefetch-${key}`, [result.left.contentId, result.right.contentId], editorText(result.left.text), editorText(result.right.text));
            diffCache.current.set(result.left.contentId, result.right.contentId, document, result.left.byteLength + result.right.byteLength);
          }
        }, () => {});
      }
    }, 150);
  };

  const selectFile = useCallback(async (nextSnapshot: RepositorySnapshot, file: FileChange, effectiveGitExecutable: string, restoreHunk = 0, automatic = false, requestedVersions?: [ConflictVersion, ConflictVersion]) => {
    readingPath.current = file.displayPath;
    const prior = currentRead.current;
    requestedVersions ??= prior.repo === nextSnapshot.repo.repoId && prior.selected === file.pathId ? prior.versions : ["stage2", "stage3"];
    setVersions(requestedVersions);
    if (!automatic && repositoryGate.current.cancelAutomatic()) setRefreshing(false);
    contentPending.current = true;
    const requestId = newRequestId();
    contentGate.current.activate(requestId, automatic);
    setSelectedPathId(file.pathId); updateAnchor({ selectedPathId: file.pathId, hunk: restoreHunk });
    const readGeneration = selectedGeneration.current;
    const key = contentCacheKey(nextSnapshot.repo.repoId, nextSnapshot.scope, nextSnapshot.revision, file.pathId);
    const cachedPair = file.status === "conflicted" ? undefined : cache.current.get(key);
    const cachedDocument = file.status === "conflicted" ? undefined : cache.current.getDocument(key) ?? (cachedPair ? diffCache.current.get(cachedPair.left.contentId, cachedPair.right.contentId) : undefined);
    const burst = !automatic && burstSelect.current;
    burstSelect.current = false;
    const previous = currentRead.current;
    const sameFile = previous.pair?.repoId === nextSnapshot.repo.repoId && previous.scope === nextSnapshot.scope && previous.pair.pathId === file.pathId;
    // Re-reading the same file keeps the displayed image until the new result lands; switching releases it.
    if (file.status === "conflicted" || (!sameFile && (previous.pair?.left.details?.image || previous.pair?.right.details?.image || !cachedDocument))) { setPair(null); setDiffDocument(null); }
    contentReadFailed.current = false;
    setError(null); setNotice(null); setLoading(true);
    try {
      // 连续快速切换：只立即更新选中高亮，内容请求延迟发出，被更新的选择取代时不再发出。
      if (!cachedPair && burst) {
        await new Promise((resolve) => window.setTimeout(resolve, BURST_DELAY_MS));
        if (!contentGate.current.accepts(requestId)) return;
      }
      const result = cachedPair ?? await readContentPair(nextSnapshot.repo.repoId, nextSnapshot.scope, nextSnapshot.revision, file.pathId, null, requestId, file.status === "conflicted" ? requestedVersions : undefined);
      if (!contentGate.current.accepts(requestId)) return;
      if (file.status === "conflicted" && readGeneration !== selectedGeneration.current) throw new Error("读取期间收到外部变化，旧内容已丢弃，请刷新。");
      if (result.stale) throw new Error("仓库内容在读取期间发生变化，请刷新后重试。旧结果未显示。");
      if (!cachedPair && file.status !== "conflicted") cache.current.set(key, result);
      if (file.status !== "conflicted" && sameFile && previous.pair?.left.contentId === result.left.contentId && previous.pair?.right.contentId === result.right.contentId && previous.pair?.degradation === result.degradation) return;
      if (result.left.text !== null && result.right.text !== null && (result.left.encoding !== "missing" || result.right.encoding !== "missing")) {
        const computed = cachedDocument ?? diffCache.current.get(result.left.contentId, result.right.contentId) ?? await calculateDiff(requestId, [result.left.contentId, result.right.contentId], editorText(result.left.text), editorText(result.right.text));
        if (!contentGate.current.accepts(requestId)) return;
        diffCache.current.set(result.left.contentId, result.right.contentId, computed, result.left.byteLength + result.right.byteLength);
        if (file.status === "conflicted" && readGeneration !== selectedGeneration.current) throw new Error("计算期间收到外部变化，旧内容已丢弃，请刷新。");
        if (file.status !== "conflicted") cache.current.setDocument(key, computed);
        setPair(result); setDiffDocument(computed);
        if (!sameFile && restoreHunk > 0) requestAnimationFrame(() => viewer.current?.navigateTo(restoreHunk));
        if (file.status !== "conflicted") schedulePrefetch.current(nextSnapshot, file, effectiveGitExecutable);
      } else { setPair(result); setDiffDocument(null); }
    } catch (nextError) { if (contentGate.current.accepts(requestId)) { contentReadFailed.current = true; setError(errorText(nextError)); } }
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
    projects.update(result.repo.repoId, (current) => ({
      snapshot: result,
      details: current.details?.revision === result.revision ? current.details : null,
      verifying: false,
      dirty: false
    }));
    loadDetails.current(result);
    setWorkspaceState((current) => {
      const latest = current.projects.find(entry => entry.repo.repoId === result.repo.repoId);
      return upsertProject(current, { ...project, customName: latest?.customName ?? project.customName, pinned: latest?.pinned ?? project.pinned, repo: result.repo, lastOpenedAt: Date.now(), anchor: nextAnchor });
    });
    setScope(result.scope); setPath(result.repo.worktreePath); setGitExecutable(project.gitExecutable); setFilter(anchor.filter); setFileView(anchor.fileView); setStale(false);
    const selected = selection.selected;
    // 主阅读器正在显示历史版本（任务 04）：刷新只更新本地列表与阅读位置，不替换正在阅读的历史内容。
    if (historyRef.current && result.repo.repoId === currentRead.current.repo) { setSelectedPathId(selected?.pathId ?? null); updateAnchor({ selectedPathId: selected?.pathId ?? null }); return; }
    if (historyRef.current) { historyRef.current = null; setHistoryReading(null); }
    if (selected) await selectFile(result, selected, project.gitExecutable, selection.invalidated ? 0 : anchor.hunk, automatic);
    else { contentReadFailed.current = false; setError(null); contentPending.current = false; setSelectedPathId(null); setPair(null); setDiffDocument(null); updateAnchor({ selectedPathId: null, hunk: 0 }); }
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
    if (restoring && !projects.get(project.repo.repoId)?.snapshot) {
      // 再次打开：先显示上次保存的快照并标“校验中”；校验完成前写入口不可用（V2-D08）。
      const persisted = parsePersistedSnapshot(await loadSnapshot(project.repo.worktreePath).catch(() => null), project.repo.worktreePath);
      if (persisted && repositoryGate.current.accepts(requestId)) {
        projects.update(project.repo.repoId, { snapshot: persisted, details: null, verifying: true, dirty: false });
        setScope(anchor.scope); setPath(project.repo.worktreePath); setFilter(anchor.filter); setFileView(anchor.fileView);
        setProjectMessages((current) => ({ ...current, [project.repo.repoId]: "校验中" }));
      }
    }
    try {
      const result = await openRepository(project.repo.worktreePath, anchor.scope, settings.get().git.executable || null, requestId);
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

  const addRepository = useCallback(async (repositoryPath: string, effectiveGitExecutable = settings.get().git.executable) => {
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
  }, [acceptSnapshot, workspaceState.projects]);

  const refreshActive = useCallback(async (reason = "手动刷新") => {
    const automatic = reason !== "手动刷新";
    if (automatic && !isForeground()) { refreshPending.current = true; return; }
    if (!activeProject || !activeRepoId) return;
    if (loading || refreshBusy.current || repositoryGate.current.hasRequiredPending() || contentGate.current.hasRequiredPending()) {
      refreshPending.current = true;
      if (!automatic) { manualPending.current = activeRepoId; setManualRefreshing(true); }
      return;
    }
    if (automatic && Date.now() < autoNotBefore.current) { refreshPending.current = true; return; }
    if (opRunning.current.has(activeRepoId)) { refreshPending.current = true; if (!automatic) setManualRefreshing(false); return; }
    refreshPending.current = false;
    if (!automatic) { manualPending.current = null; setManualRefreshing(true); }
    // Startup/explicit actions own repository opening. Focus events must not
    // restart a failed or still-pending initialization behind the user's back.
    if (!opened.current.has(activeRepoId)) { if (!automatic) { try { await loadProject(activeProject, activeProject.anchor, true); } finally { setManualRefreshing(false); } } return; }
    if (reason === "前台核对" && Date.now() - lastCheck.current < 3000) return;
    refreshBusy.current = true; lastCheck.current = Date.now();
    const requestId = newRequestId(); repositoryGate.current.activate(requestId, automatic);
    setRefreshing(true); if (!contentReadFailed.current) setError(null); setProjectMessages((current) => ({ ...current, [activeRepoId]: `${reason}中` }));
    try {
      const result = await refreshRepository(activeRepoId, scope, requestId, !automatic);
      if (!repositoryGate.current.accepts(requestId)) return;
      checkedAt.current.set(`${activeRepoId}:${scope}`, Date.now());
      const priorRevision = projects.get(activeRepoId)?.snapshot?.revision;
      // Manual refresh re-reads content, e.g. LFS objects fetched after a pointer was shown.
      if (!automatic || (priorRevision && priorRevision !== result.revision)) cache.current.clearRepo(activeRepoId);
      if (!automatic || priorRevision !== result.revision || contentPending.current) {
        const live = currentRead.current;
        await acceptSnapshot(result, activeProject, { ...activeProject.anchor, selectedPathId: live.selected }, requestId, automatic);
      }
      if (!repositoryGate.current.accepts(requestId)) return;
      setStale(false);
      setProjectMessages((current) => ({ ...current, [activeRepoId]: "已同步" }));
    } catch (nextError) {
      if (!repositoryGate.current.accepts(requestId)) return;
      setStale(true); setError(`${reason}失败：${errorText(nextError)}。保留上一份快照并标为旧。`);
      setProjectMessages((current) => ({ ...current, [activeRepoId]: "旧快照" }));
    } finally {
      refreshBusy.current = false;
      if (!automatic) setManualRefreshing(false);
      autoNotBefore.current = Date.now() + 1500;
      if (repositoryGate.current.accepts(requestId)) { setRefreshing(false); repositoryGate.current.finish(requestId); }
      window.clearTimeout(completionTimer.current);
      if (manualPending.current === currentRead.current.repo) { completionTimer.current = window.setTimeout(() => void refreshLatest.current("手动刷新"), 0); }
      else if (isForeground() && refreshPending.current) { completionTimer.current = window.setTimeout(() => void refreshLatest.current("合并变化"), 1500); }
    }
  }, [acceptSnapshot, activeProject, activeRepoId, scope, loading, loadProject, projects]);

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
    manualPending.current = null; setManualRefreshing(false);
    if (!activeProject) return;
    setScope(activeProject.anchor.scope); setFilter(activeProject.anchor.filter); setFileView(activeProject.anchor.fileView); setPath(activeProject.repo.worktreePath); setGitExecutable(activeProject.gitExecutable);
  }, [activeProject?.repo.repoId]);

  const appliedGit = useRef(gitSetting);
  useEffect(() => {
    if (appliedGit.current === gitSetting) return;
    appliedGit.current = gitSetting;
    if (activeProject) void loadProject(activeProject);
  }, [gitSetting, activeProject, loadProject]);

  const refreshLatest = useRef(refreshActive);
  refreshLatest.current = refreshActive;
  useEffect(() => {
    if ((isForeground() || manualPending.current === currentRead.current.repo) && !loading && refreshPending.current && !refreshBusy.current) {
      refreshPending.current = false;
      const timer = window.setTimeout(() => void refreshLatest.current(manualPending.current === currentRead.current.repo ? "手动刷新" : "合并变化"), Math.max(300, autoNotBefore.current - Date.now()));
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
    let timer = 0, firstEventAt = 0;
    const unlisten = listen<string | { repoId: string; paths: string[]; global: boolean; kinds?: string[] }>("repository-invalidated", (event) => {
      const change = typeof event.payload === "string" ? { repoId: event.payload, paths: [], global: true, kinds: [] } : event.payload;
      // refs 类事件（分支、HEAD、packed-refs）：分支列表与日志重读（任务 04）。
      if (change.repoId === currentRead.current.repo && (change.global || change.kinds?.includes("refs"))) setRefsVersion((value) => value + 1);
      if (change.repoId === currentRead.current.repo && (change.global || change.kinds?.includes("stash"))) setStashVersion((value) => value + 1);
      repoGeneration.current.set(change.repoId, (repoGeneration.current.get(change.repoId) ?? 0) + 1);
      cache.current.clearRepo(change.repoId);
      if (change.repoId !== currentRead.current.repo) { if (projects.get(change.repoId)) projects.update(change.repoId, { dirty: true }); return; }
      const selectedPath = readingPath.current;
      const touchesSelection = change.global || !selectedPath || change.paths.some(path => selectedPath === path || selectedPath.startsWith(`${path}/`));
      if (touchesSelection) selectedGeneration.current++;
      // Images stay visible: the revision covers worktree size/mtime, so the
      // debounced refresh re-reads them only when they actually changed.
      const displayed = currentRead.current.pair;
      if (touchesSelection && displayed && (displayed.left.endpoint.startsWith("stage") || displayed.right.endpoint.startsWith("stage"))) {
        setPair(null); setDiffDocument(null); setStale(true); contentPending.current = true;
      }
      refreshPending.current = true;
      if (!isForeground()) return;
      // Debounce bursts, but never postpone the refresh beyond 1 s after the first event.
      const now = Date.now();
      if (!timer) firstEventAt = now;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = 0; refreshPending.current = false; void refreshLatest.current("外部变化"); }, Math.max(0, autoNotBefore.current - now, Math.min(300, firstEventAt + 1000 - now)));
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
    historyRef.current = null; setHistoryReading(null);
    setWorkspaceState((current) => ({ ...current, activeRepoId: project.repo.repoId })); setError(null); setNotice(null); setStale(false);
    const stored = projects.get(project.repo.repoId);
    const cached = stored?.snapshot ? scopeView(stored.snapshot, stored.details, project.anchor.scope) : undefined;
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
    const unchangedSinceScan = snapshotGeneration.current.get(`${project.repo.repoId}:${cached.scope}`) === (repoGeneration.current.get(project.repo.repoId) ?? 0);
    if (cached.scopes) {
      // V2：watcher 持续监听最近 5 个项目；没有变化且 watcher 未被淘汰时不需要重新扫描。
      const watched = await activateRepository(project.repo.repoId).catch(() => false);
      if (currentRead.current.repo !== project.repo.repoId) return;
      if (watched && unchangedSinceScan && !stored?.dirty) return;
    } else if (Date.now() - (checkedAt.current.get(`${project.repo.repoId}:${cached.scope}`) ?? cached.scannedAt) < 3000 && unchangedSinceScan) return;
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
    historyRef.current = null; setHistoryReading(null);
    setScope(nextScope); updateAnchor(anchor); setPair(null); setDiffDocument(null);
    const project = { ...activeProject, anchor };
    if (!opened.current.has(project.repo.repoId)) { await loadProject(project); return; }
    const stored = projects.get(project.repo.repoId)?.snapshot;
    if (stored?.scopes) {
      // V2：三个范围共享一次 status 的结果，切换范围只在前端过滤，不启动 Git 进程。
      const requestId = newRequestId(); repositoryGate.current.activate(requestId); contentGate.current.activate(requestId);
      try { await acceptSnapshot(scopeView(stored, projects.get(project.repo.repoId)?.details, nextScope), project, anchor, requestId); }
      catch (nextError) { if (repositoryGate.current.accepts(requestId)) setError(errorText(nextError)); }
      finally { if (repositoryGate.current.accepts(requestId)) { repositoryGate.current.finish(requestId); contentGate.current.finish(requestId); } }
      return;
    }
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
    const removedPath = projects.get(repoId)?.snapshot?.repo.worktreePath;
    projects.remove(repoId);
    if (removedPath) void removeSnapshot(removedPath).catch(() => {});
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
  visibleFilesRef.current = visibleFiles;
  const visibleProjects = useMemo(() => { const query = projectFilter.trim().toLocaleLowerCase(); return workspaceState.projects.filter((project) => `${projectName(project)} ${project.repo.worktreePath}`.toLocaleLowerCase().includes(query)); }, [projectFilter, workspaceState.projects]);
  const historyFile = useMemo<FileChange | undefined>(() => historyReading ? { pathId: historyReading.file.pathId, displayPath: historyReading.file.path, oldPathId: historyReading.file.oldPathId, oldDisplayPath: historyReading.file.oldPath, status: historyStatus(historyReading.file.status), additions: null, deletions: null } : undefined, [historyReading]);
  const localSelectedFile = snapshot?.files.find((file) => file.pathId === selectedPathId);
  const selectedFile = historyFile ?? localSelectedFile;
  const selectedIndex = visibleFiles.findIndex((file) => file.pathId === selectedPathId);
  const readable = !!pair && pair.left.text !== null && pair.right.text !== null && (pair.left.encoding !== "missing" || pair.right.encoding !== "missing");
  const availableText = !readable && pair ? [pair.left, pair.right].find(side => side.text !== null && side.encoding !== "missing") : undefined;
  const endpoints = historyReading ? [historyReading.left.label, historyReading.right.label] : selectedFile?.status === "conflicted" ? versions.map(version => versionLabels[version]) : scopeLabels[scope].endpoints;
  const presentation = useMemo<DiffPresentation>(() => selectedFile && pair
    ? resolveDiffPresentation(selectedFile.status, pair.left, pair.right)
    : { kind: "compare" }, [selectedFile, pair]);
  const singleFile = presentation.kind === "single";
  const singleTextSide = singleFile && pair ? (presentation.side === "a" ? pair.left : pair.right) : null;
  const singleEndpointLabel = singleFile
    ? presentation.side === "a" ? (pair?.left.endpoint === "emptyTree" ? "空树" : endpoints[0]) : endpoints[1]
    : "";
  const diffModes = availableDiffModes(presentation);
  useEffect(() => { if (gitTab === "log" && activeRepoId) setLogMounted(activeRepoId); }, [gitTab, activeRepoId]);
  useEffect(() => { setRefsView(null); setFileHistoryRequest(null); setBranchOpen(false); setStashCount(null); }, [activeRepoId]);
  useEffect(() => { if (gitTab === "stash" && activeRepoId) setStashMounted(activeRepoId); }, [gitTab, activeRepoId]);
  const detachedOid = snapshot?.branchInfo && !snapshot.branchInfo.head ? snapshot.branchInfo.oid : null;
  const worktreePath = snapshot?.repo.worktreePath ?? null;
  const fetchText = useMemo(() => refsView && !refsView.remotes.length ? "该仓库没有配置 remote" : fetchTimeText(worktreePath ? loadFetchRecord(localStorage, worktreePath) : null, refsView?.fetchHeadAt ?? null), [worktreePath, refsView, fetchRecordVersion]);
  const noRemote = !!refsView && !refsView.remotes.length;
  const fetchRunning = repoOps?.running?.kind === "fetch";
  const fetchProgress = fetchRunning ? parseProgress(repoOps?.lines ?? []) : null;

  // ---------- 写操作入口 ----------
  const runningLabel = repoOps?.running ? operationLabels[repoOps.running.kind] : null;
  const writeBlocked = writeBlockedReason({ snapshot, verifying: !!runtime?.verifying, running: runningLabel });
  const inProgressNotice = unsupportedInProgress(snapshot);
  const stagedCount = runtime?.snapshot?.scopes?.staged.filter((file) => file.status !== "conflicted").length ?? 0;
  // 切换项目 / 范围时清空批量选择；已为空时保持同一引用，避免多余的重渲染。
  useEffect(() => { setMultiSelection((current) => (current.size ? new Set() : current)); }, [activeRepoId, scope]);
  // 丢弃记录只在打开“操作输出”页时读取（丢弃 / 撤销后另行刷新），不在每次切换项目时读取。
  useEffect(() => {
    if (!activeRepoId || gitTab !== "output") return;
    void discardBackups(activeRepoId).then((backups) => updateOps(activeRepoId, { backups }), () => {});
  }, [activeRepoId, gitTab, updateOps]);

  const record = (outcome: OperationOutcome): OperationRecord => ({ kind: outcome.kind, status: outcome.status, message: outcome.message, output: outcome.output, outputTruncated: outcome.outputTruncated, at: Date.now() });

  /** 执行一个写操作：可选乐观更新 → IPC → 用返回的精确刷新快照替换（失败时即恢复实际状态）。 */
  const runOp = async (request: OperationRequest, optimistic?: RepositorySnapshot): Promise<OperationOutcome | null> => {
    const repoId = currentRead.current.repo;
    if (!repoId) return null;
    const runtimeNow = projects.get(repoId);
    const blocked = writeBlockedReason({ snapshot: runtimeNow?.snapshot, verifying: !!runtimeNow?.verifying, running: opStore.get()[repoId]?.running ? operationLabels[opStore.get()[repoId]!.running!.kind] : null });
    if (blocked) { updateOps(repoId, { last: { kind: request.kind === "commit" && request.amend ? "amend" : request.kind, status: "failed", message: blocked, output: "", at: Date.now() } }); return null; }
    const kind = request.kind === "commit" && request.amend ? "amend" : request.kind;
    const opId = newRequestId();
    const prior = runtimeNow?.snapshot ?? null;
    const viewScope = currentRead.current.scope;
    const beforeFiles = visibleFilesRef.current;
    const selectedBefore = currentRead.current.selected;
    opRunning.current.add(repoId);
    updateOps(repoId, { running: { opId, kind }, lines: [] });
    if (optimistic) projects.update(repoId, { snapshot: optimistic });
    const requestId = newRequestId(); repositoryGate.current.activate(requestId);
    let outcome: OperationOutcome;
    try {
      outcome = await runOperation(repoId, viewScope, opId, request);
    } catch (error) {
      // 前置检查失败（外部锁、进行中状态、已推送保护、写锁被占用）：仓库未被改动，恢复乐观更新前的显示。
      if (optimistic && prior) projects.update(repoId, { snapshot: prior });
      opRunning.current.delete(repoId);
      // 前置检查失败（例如 stash 列表在外部被修改）：重读 stash 列表。
      if (currentRead.current.repo === repoId && stashKinds.has(kind)) setStashVersion((value) => value + 1);
      updateOps(repoId, (current) => ({ running: null, last: { kind, status: "failed", message: errorText(error), output: "", at: Date.now() }, ...(["commit", "amend", "undoCommit"].includes(kind) ? { lastCommit: { kind, status: "failed", message: errorText(error), output: "", at: Date.now() } } : {}), lines: current.lines }));
      if (repositoryGate.current.accepts(requestId)) repositoryGate.current.finish(requestId);
      return null;
    }
    opRunning.current.delete(repoId);
    // 写操作期间 watcher 屏蔽了 refs 事件：结束后由这里触发分支列表与日志重读。
    if (currentRead.current.repo === repoId) {
      if (refsKinds.has(outcome.kind)) setRefsVersion((value) => value + 1);
      if (stashKinds.has(outcome.kind)) setStashVersion((value) => value + 1);
    }
    const commitKind = ["commit", "amend", "undoCommit"].includes(outcome.kind);
    // 状态栏的“撤销丢弃”只针对本次丢弃返回的备份，不依赖异步刷新的备份列表。
    const succeeded = outcome.status === "succeeded";
    const backupPatch = outcome.kind === "discard" && succeeded ? { lastBackup: outcome.backup } : request.kind === "undoDiscard" && succeeded && opStore.get()[repoId]?.lastBackup?.id === request.backupId ? { lastBackup: null } : {};
    updateOps(repoId, { running: null, last: record(outcome), ...backupPatch, ...(commitKind ? { lastCommit: record(outcome) } : {}) });
    if (outcome.kind === "discard" || outcome.kind === "undoDiscard") void discardBackups(repoId).then((backups) => updateOps(repoId, { backups }), () => {});
    if (outcome.snapshot) {
      const result = outcome.snapshot;
      if (prior?.revision !== result.revision) cache.current.clearRepo(repoId);
      if (currentRead.current.repo === repoId && repositoryGate.current.accepts(requestId)) {
        refreshPending.current = false;
        const project = workspaceRef.current.projects.find((entry) => entry.repo.repoId === repoId);
        const scopeNow = currentRead.current.scope;
        const view = scopeView(result, null, scopeNow);
        const query = (project?.anchor.filter ?? "").trim().toLocaleLowerCase();
        const nextVisible = view.files.filter((file) => file.displayPath.toLocaleLowerCase().includes(query)).sort(compareFiles);
        // 切换分支、检出、stash 等会整体改变工作区的操作：文件仍在时保持阅读位置，否则回到合法入口并提示（V2-03 M4）。
        const selected = switchKinds.has(outcome.kind) ? currentRead.current.selected ?? selectedBefore : selectionAfterOperation(beforeFiles, nextVisible, currentRead.current.selected ?? selectedBefore);
        if (project) await acceptSnapshot(view, project, { ...project.anchor, scope: scopeNow, selectedPathId: selected }, requestId);
        if (repositoryGate.current.accepts(requestId)) repositoryGate.current.finish(requestId);
      } else {
        projects.update(repoId, { snapshot: result, details: null, verifying: false, dirty: false });
        loadDetails.current(result);
      }
    } else {
      if (optimistic && prior) projects.update(repoId, { snapshot: prior });
      if (repositoryGate.current.accepts(requestId)) repositoryGate.current.finish(requestId);
    }
    return outcome;
  };

  const stageFiles = (kind: "stage" | "unstage", files: FileChange[]) => {
    const current = runtime?.snapshot;
    setMultiSelection(new Set());
    void runOp({ kind, pathIds: pathIdsFor(files, kind === "unstage") }, current ? optimisticMove(current, kind, files) : undefined);
  };
  const resolveFiles = async (files: FileChange[], confirmed = false): Promise<void> => {
    setMultiSelection(new Set());
    const outcome = await runOp({ kind: "markResolved", pathIds: pathIdsFor(files, false), confirmed });
    if (outcome?.status === "needsConfirmation" && outcome.confirmation) {
      const ok = await askConfirm({ title: "标记已解决", message: outcome.confirmation.message, items: outcome.confirmation.paths, warning: "文件中仍有冲突标记", confirmLabel: "仍然标记已解决", danger: true });
      if (ok) await resolveFiles(files, true);
    }
  };
  const discardFiles = async (files: FileChange[]) => {
    const repoId = activeRepoId;
    if (!repoId || writeBlocked) return;
    const discardScope = scope;
    let plan;
    try { plan = await prepareDiscard(repoId, discardScope, pathIdsFor(files, discardScope === "all")); }
    catch (error) { updateOps(repoId, { last: { kind: "discard", status: "failed", message: errorText(error), output: "", at: Date.now() } }); return; }
    if (!plan.files) {
      updateOps(repoId, { last: { kind: "discard", status: "failed", message: plan.blocked.length ? plan.blocked.map((b) => `${b.path}：${b.reason}`).join("；") : "所选文件已没有可丢弃的改动", output: "", at: Date.now() } });
      return;
    }
    const blocked = new Set(plan.blocked.map((b) => b.path));
    const unrecoverable = plan.unrecoverable.length > 0;
    const ok = await askConfirm({
      title: `丢弃 ${plan.files} 个文件的改动`,
      message: discardScope === "all" ? "暂存区与工作区都会恢复到 HEAD（当前提交）；未跟踪文件会被删除。" : "工作区文件恢复到暂存区（Index）中的版本；未跟踪文件会被删除。暂存区不变。",
      items: plan.paths,
      notes: [
        plan.untracked ? `其中 ${plan.untracked} 个是未跟踪文件，将被删除` : "不包含未跟踪文件",
        unrecoverable ? `以下 ${plan.unrecoverable.length} 个文件超过 50 MiB 备份预算，不会备份：${plan.unrecoverable.join("、")}` : "丢弃前会备份，之后可在状态栏或“操作输出”中撤销丢弃",
        ...plan.blocked.map((b) => `不会丢弃 ${b.path}：${b.reason}`)
      ],
      warning: unrecoverable ? `不可撤销：${plan.unrecoverable.length} 个文件丢弃后无法恢复` : undefined,
      confirmLabel: unrecoverable ? "丢弃（含不可撤销）" : "丢弃",
      danger: true
    });
    if (!ok) return;
    setMultiSelection(new Set());
    const targets = files.filter((file) => !blocked.has(file.displayPath));
    let outcome = await runOp({ kind: "discard", scope: discardScope, pathIds: pathIdsFor(targets, discardScope === "all"), confirmedUnrecoverable: unrecoverable });
    if (outcome?.status === "needsConfirmation" && outcome.confirmation) {
      // 确认框之后文件变大、超出预算：再次确认。
      const again = await askConfirm({ title: "丢弃不可撤销", message: outcome.confirmation.message, items: outcome.confirmation.paths, warning: "不可撤销", confirmLabel: "仍然丢弃", danger: true });
      if (again) outcome = await runOp({ kind: "discard", scope: discardScope, pathIds: pathIdsFor(targets, discardScope === "all"), confirmedUnrecoverable: true });
    }
  };
  const undoDiscard = async (backupId: string, overwrite = false): Promise<void> => {
    const outcome = await runOp({ kind: "undoDiscard", backupId, overwrite });
    if (outcome?.status === "needsConfirmation" && outcome.confirmation) {
      const ok = await askConfirm({ title: "撤销丢弃", message: `${outcome.confirmation.message}。确认用丢弃前的内容覆盖？`, items: outcome.confirmation.paths, confirmLabel: "覆盖并撤销", danger: true });
      if (ok) await undoDiscard(backupId, true);
    }
  };
  const commit = (message: string, amend: boolean, keepMessage: boolean, expectedHead: string | null) => runOp({ kind: "commit", message, amend, keepMessage, expectedHead });
  /** 显式获取远端状态（R-REMOTE）：确认框选择 remote 后执行；成功时记录完成时间。 */
  const startFetch = async (remote: string) => {
    setFetchOpen(false);
    const worktree = snapshot?.repo.worktreePath;
    const outcome = await runOp({ kind: "fetch", remote });
    if (outcome?.status === "succeeded" && worktree) {
      try { saveFetchRecord(localStorage, worktree, { remote, at: Date.now() }); } catch { /* 存储可选 */ }
      setFetchRecordVersion((value) => value + 1);
    }
  };
  const openFetch = () => {
    // 默认目标取决于当前分支与已有 remote：打开时总是重新读取，不沿用之前的读取结果。
    setRefsView(null);
    setFetchOpen(true);
    if (activeRepoId) void readRefs(activeRepoId).then(setRefsView, () => {});
  };
  const loadRefsView = () => { if (activeRepoId) void readRefs(activeRepoId).then(setRefsView, () => {}); };
  /** 切换类操作：Git 因工作区改动拒绝时询问“stash 后切换”；切换后不自动恢复。 */
  const runSwitch = async (request: OperationRequest) => {
    let outcome = await runOp(request);
    const confirmation = outcome?.status === "needsConfirmation" ? outcome.confirmation : null;
    if (confirmation && (confirmation.reason === "localChanges" || confirmation.reason === "untrackedOverwritten")) {
      const untracked = confirmation.reason === "untrackedOverwritten";
      const ok = await askConfirm({
        title: "stash 后切换",
        message: confirmation.message,
        items: confirmation.paths,
        notes: [untracked ? "将储藏全部本地改动，包含未跟踪文件" : "将储藏已跟踪文件的全部改动（不含未跟踪文件）", "储藏为新的 stash@{0}；切换后不会自动恢复，之后可在底部“Stash”页应用或弹出"],
        confirmLabel: "stash 后切换"
      });
      if (ok) outcome = await runOp({ ...request, stashFirst: true, stashUntracked: untracked } as OperationRequest);
    }
    return outcome;
  };
  const deleteBranch = async (branch: Branch) => {
    const ok = await askConfirm({ title: `删除分支 ${branch.name}`, message: `删除本地分支 ${branch.name}（指向 ${branch.oid.slice(0, 8)}）。远端分支不受影响。`, confirmLabel: "删除", danger: true });
    if (!ok) return;
    const outcome = await runOp({ kind: "branchDelete", name: branch.fullName });
    if (outcome?.status === "needsConfirmation" && outcome.confirmation?.reason === "unmerged") {
      const again = await askConfirm({ title: `删除未合并的分支 ${branch.name}`, message: outcome.confirmation.message, warning: "未合并：删除后这些提交只能通过 reflog 找回", confirmLabel: "仍然删除", danger: true });
      if (again) await runOp({ kind: "branchDelete", name: branch.fullName, force: true });
    }
  };
  const branchActions: BranchActions = {
    onSwitch: (branch) => { setBranchOpen(false); void runSwitch({ kind: "branchSwitch", name: branch.fullName }); },
    onTrack: (branch) => {
      setBranchOpen(false);
      void runSwitch({ kind: "branchTrack", remote: branch.fullName }).then((outcome) => {
        if (outcome?.status === "needsConfirmation" && outcome.confirmation?.reason === "localExists") { loadRefsView(); setTrackChoice({ remote: branch, existing: outcome.confirmation.paths[0] }); }
      });
    },
    onNew: (start) => { setBranchOpen(false); loadRefsView(); setNewBranch({ initial: start }); },
    onRename: (branch) => { setBranchOpen(false); loadRefsView(); setRenameBranch(branch); },
    onDelete: (branch) => { setBranchOpen(false); void deleteBranch(branch); },
    onSetUpstream: (branch) => { setBranchOpen(false); loadRefsView(); setUpstreamBranch(branch); }
  };
  const createBranch = (request: NewBranchRequest) => { setNewBranch(null); void runSwitch({ kind: "branchCreate", name: request.name, start: request.start, switch: request.switch }); };
  const stashPush = async (options: StashPushOptions) => {
    const outcome = await runOp({ kind: "stashPush", message: options.message.trim() || null, includeUntracked: options.includeUntracked, pathIds: options.pathIds });
    return outcome?.status === "succeeded";
  };
  const stashDrop = async (entry: StashEntry) => {
    const ok = await askConfirm({ title: `删除 stash@{${entry.index}}`, message: `${entry.message || "（无说明）"} · ${entry.branch || "—"} · ${entry.oid.slice(0, 8)}`, warning: "删除后 Oris 无法撤销（只能用 git fsck 等方式从悬空对象中找回）", confirmLabel: "删除 stash", danger: true });
    if (ok) await runOp({ kind: "stashDrop", index: entry.index, oid: entry.oid });
  };
  const undoCommit = async (head: HeadCommitInfo) => {
    const ok = await askConfirm({ title: "撤销最近提交", message: undoCommitText(head), confirmLabel: "撤销提交", danger: true, notes: ["只移动 HEAD（reset --soft），不改动工作区；撤销的提交仍可通过 reflog 找回"] });
    if (ok) await runOp({ kind: "undoCommit", expectedHead: head.oid });
  };
  const onFileAction = (action: FileAction, files: FileChange[]) => {
    if (!files.length) return;
    if (action === "stage" || action === "unstage") stageFiles(action, files);
    else if (action === "markResolved") void resolveFiles(files);
    else void discardFiles(files);
  };
  const fileActions = useMemo<FileActions>(() => ({
    scope,
    disabledReason: writeBlocked,
    selection: multiSelection,
    onSelection: (pathIds, focus) => { setMultiSelection(pathIds.length > 1 ? new Set(pathIds) : new Set()); if (focus) userSelectRef.current(focus); },
    onAction: (action, files) => onFileActionRef.current(action, files)
  }), [scope, writeBlocked, multiSelection]);
  const onFileActionRef = useRef(onFileAction);
  onFileActionRef.current = onFileAction;
  const selectedCount = multiSelection.size > 1 ? visibleFiles.filter((file) => multiSelection.has(file.pathId)).length : 0;
  const stashSelection = useMemo(() => multiSelection.size > 1 ? visibleFiles.filter((file) => multiSelection.has(file.pathId)) : localSelectedFile ? [localSelectedFile] : [], [multiSelection, visibleFiles, localSelectedFile]);

  // 写操作输出逐行推送（后端已脱敏）；合并到下一帧再更新界面。
  useEffect(() => {
    const buffer = new Map<string, string[]>();
    let timer = 0;
    const flushLines = () => {
      timer = 0;
      for (const [repoId, lines] of buffer) updateOps(repoId, (current) => ({ lines: [...current.lines, ...lines].slice(-500) }));
      buffer.clear();
    };
    const unlisten = listen<{ repoId: string; opId: string; line: string }>("operation-output", (event) => {
      const { repoId, opId, line } = event.payload;
      if (opStore.get()[repoId]?.running?.opId !== opId) return;
      buffer.set(repoId, [...(buffer.get(repoId) ?? []), line]);
      if (!timer) timer = window.setTimeout(flushLines, 50);
    });
    return () => { window.clearTimeout(timer); void unlisten.then((dispose) => dispose()); };
  }, [opStore, updateOps]);
  const leaveHistory = () => {
    if (!historyRef.current) return;
    historyRef.current = null; setHistoryReading(null);
    // 历史版本的内容不参与本地文件的“同一文件”判断。
    currentRead.current = { ...currentRead.current, pair: null }; setPair(null); setDiffDocument(null);
  };
  const userSelect = (file: FileChange) => {
    leaveHistory();
    if (snapshot) void selectFile(snapshot, file, activeProject?.gitExecutable ?? "");
  };
  /** 在主阅读器中打开历史版本（两端为固定的提交 OID）；本地阅读位置保留，可随时返回。 */
  const openHistoryFile = async (open: HistoryFileOpen) => {
    const repoId = currentRead.current.repo;
    if (!repoId) return;
    const returnTo = historyRef.current?.returnTo ?? { pathId: currentRead.current.selected, hunk: activeProject?.anchor.hunk ?? 0 };
    const next = { ...open, returnTo };
    historyRef.current = next; setHistoryReading(next);
    readingPath.current = open.file.path;
    const requestId = newRequestId();
    contentGate.current.activate(requestId);
    contentPending.current = true; contentReadFailed.current = false;
    currentRead.current = { ...currentRead.current, pair: null };
    setPair(null); setDiffDocument(null); setError(null); setNotice(null); setLoading(true);
    try {
      const result = await readRevisionPair(repoId, open.left.oid, open.right.oid, open.file.pathId, open.file.oldPathId, requestId);
      if (!contentGate.current.accepts(requestId)) return;
      if (result.left.text !== null && result.right.text !== null && (result.left.encoding !== "missing" || result.right.encoding !== "missing")) {
        const computed = diffCache.current.get(result.left.contentId, result.right.contentId) ?? await calculateDiff(requestId, [result.left.contentId, result.right.contentId], editorText(result.left.text), editorText(result.right.text));
        if (!contentGate.current.accepts(requestId)) return;
        diffCache.current.set(result.left.contentId, result.right.contentId, computed, result.left.byteLength + result.right.byteLength);
        setPair(result); setDiffDocument(computed);
      } else { setPair(result); setDiffDocument(null); }
    } catch (nextError) { if (contentGate.current.accepts(requestId) && !isStaleError(nextError)) { contentReadFailed.current = true; setError(errorText(nextError)); } }
    finally { if (contentGate.current.accepts(requestId)) { contentPending.current = false; setLoading(false); contentGate.current.finish(requestId); } }
  };
  /** 返回进入历史之前的本地阅读位置（文件与差异位置）。 */
  const returnToLocal = () => {
    const reading = historyRef.current;
    leaveHistory();
    if (!snapshot) return;
    const back = reading?.returnTo.pathId ? snapshot.files.find((file) => file.pathId === reading.returnTo.pathId) : undefined;
    const target = back ?? visibleFiles[0];
    if (target) void selectFile(snapshot, target, activeProject?.gitExecutable ?? "", back ? reading!.returnTo.hunk : 0);
    else setNotice("进入历史前阅读的文件已不在当前比较范围中，当前范围没有可阅读的变化。");
    if (reading?.returnTo.pathId && !back && target) setNotice(`进入历史前阅读的文件已不在当前比较范围中，已改为 ${target.displayPath}`);
  };
  const openFileHistory = (file: FileChange) => {
    // 暂存区中的 rename：HEAD 里只有原路径。
    const renamed = file.status === "renamed" && file.oldPathId && file.oldDisplayPath;
    setFileHistoryRequest({ pathId: renamed ? file.oldPathId! : file.pathId, path: renamed ? file.oldDisplayPath! : file.displayPath, start: "HEAD", nonce: Date.now() });
    setGitTab("log");
  };
  const userSelectRef = useRef(userSelect);
  userSelectRef.current = userSelect;
  /** 键盘连续切换文件（按住方向键）：只立即更新选中高亮，内容请求延迟发出，被下一次切换取代时不再发出。 */
  const navigateFile = (direction: -1 | 1) => {
    if (!snapshot || !visibleFiles.length) return;
    leaveHistory();
    setMultiSelection((current) => (current.size ? new Set() : current));
    const index = selectedIndex < 0 ? 0 : (selectedIndex + direction + visibleFiles.length) % visibleFiles.length;
    const now = performance.now();
    burstSelect.current = now - lastSelectAt.current < BURST_WINDOW_MS;
    lastSelectAt.current = now;
    void selectFile(snapshot, visibleFiles[index], activeProject?.gitExecutable ?? "");
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 设置与字号快捷键不与文字输入冲突，焦点在输入框（如 diff 搜索框）时也生效（V2-D25）。
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === ",") { event.preventDefault(); setSettingsOpen(true); return; }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["=", "+", "-", "0"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "0" ? FONT_SIZE_DEFAULT : Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + (event.key === "-" ? -1 : 1)));
        settings.update("appearance", "fontSize", next);
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.matches("input, textarea, select, [contenteditable=true]")) return;
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

  return <main className="app">
    <header className="titlebar"><span className="logo">O</span><strong>{activeProject ? projectName(activeProject) : "Oris"}</strong>{snapshot && <span className="branch-anchor"><button type="button" className="branch branch-button" aria-expanded={branchOpen} title="分支：搜索、切换、新建与管理" onClick={() => setBranchOpen((value) => !value)}>⑂ {snapshot.repo.branch} ▾</button>{branchOpen && activeRepoId && <BranchPopover repoId={activeRepoId} refsVersion={refsVersion} blocked={writeBlocked} actions={branchActions} onClose={() => setBranchOpen(false)}/>}</span>}{snapshot?.branchInfo?.upstream && <span className="branch-counts" title={`相对上游 ${snapshot.branchInfo.upstream}：领先 ${snapshot.branchInfo.ahead ?? "?"}、落后 ${snapshot.branchInfo.behind ?? "?"}`}>↑{snapshot.branchInfo.ahead ?? "?"} ↓{snapshot.branchInfo.behind ?? "?"}</span>}{stale && <span className="stale-badge">旧快照</span>}{runtime?.verifying && <span className="stale-badge verifying" title="显示上次保存的快照，正在后台校验；校验完成前写操作不可用">校验中</span>}{snapshot && <button type="button" className="fetch-entry" disabled={!!writeBlocked} title={writeBlocked ?? `获取远端状态：只更新远端跟踪分支等 Git 元数据，不修改工作区。${fetchText}`} onClick={openFetch}>{fetchRunning ? "⇣ 获取中…" : "⇣ 获取…"}</button>}<span className="spacer"/>{snapshot && <button className="commit-entry" onClick={() => setGitTab("commit")} title="打开底部“提交”页">提交 · {stagedCount}</button>}<button className="settings-button" onClick={() => setSettingsOpen(true)} aria-label="设置" title="设置（Ctrl+,）">⚙ 设置</button></header>
    <section className="projectbar" aria-label="项目切换"><button className="primary" onClick={chooseRepository}>添加项目</button><input value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} placeholder="搜索项目或完整路径" aria-label="搜索项目"/><div className="project-tabs">{visibleProjects.map(project => <ProjectTab key={project.repo.repoId} project={project} active={project.repo.repoId === activeRepoId}
      onSelect={() => void switchProject(project)}
      onRename={customName => setWorkspaceState(current => ({ ...current, projects: current.projects.map(p => p.repo.repoId === project.repo.repoId ? { ...p, customName } : p) }))}
      onRemove={() => void deleteProject(project.repo.repoId)}
      onReorder={target => setWorkspaceState(current => moveProject(current, project.repo.repoId, target))}/>)}{!visibleProjects.length && <span className="project-empty">{workspaceState.projects.length ? "没有匹配项目" : "尚未添加项目"}</span>}</div></section>
    <section className="openbar"><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="仓库绝对路径" aria-label="仓库路径"/><button onClick={() => void addRepository(path)} disabled={loading || !path.trim()}>载入/添加</button>{snapshot && <button onClick={() => void refreshActive()} disabled={manualRefreshing}>↻ 本地刷新</button>}{snapshot && <span className="restore-status">{projectMessages[snapshot.repo.repoId] ?? "已同步"} · {new Date(snapshot.scannedAt).toLocaleTimeString()}</span>}</section>
    <section className="workspace" ref={workspace} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className="sidebar"><div className="panel-title"><strong>变更</strong><span>{scopeLabels[scope].endpoints[0]} → {scopeLabels[scope].endpoints[1]}</span></div><div className="scope-row">{(["unstaged", "staged", "all"] as CompareScope[]).map((value) => <button key={value} className={`scope ${scope === value ? "selected" : ""}`} onClick={() => void setCompareScope(value)}>{scopeLabels[value].short}</button>)}<select className="file-view-select" aria-label="文件显示方式" title={fileView === "flat" ? "平铺显示相对路径" : "树状显示目录"} value={fileView} onChange={(event) => { const value = event.target.value as "flat" | "tree"; setFileView(value); updateAnchor({ fileView: value }); }}><option value="flat">☷</option><option value="tree">⑂</option></select></div><input className="filter" aria-label="按完整相对路径筛选" value={filter} onChange={(event) => { setFilter(event.target.value); updateAnchor({ filter: event.target.value }); }} placeholder="按完整相对路径筛选"/><div className="files" role="listbox" aria-label={`${scopeLabels[scope].short}变更`}>{snapshot && <FileTree files={visibleFiles} selectedPathId={historyReading ? null : selectedPathId} mode={fileView} statsPending={pendingStats} onSelect={userSelect} actions={fileActions}/>} {snapshot && !visibleFiles.length && <div className="empty">{filter ? "筛选无匹配文件" : "当前比较范围没有变化"}</div>}{!snapshot && <div className="empty">添加或选择一个真实 Git 仓库</div>}</div><footer>{selectedCount > 1 ? <div className="batch-bar"><span>已选 {selectedCount} 个 · 右键批量操作</span><button type="button" className="quiet" onClick={() => setMultiSelection(new Set())}>清除</button></div>
        : snapshot ? `${visibleFiles.length} / ${snapshot.files.length} 个文件 · ${scopeLabels[scope].short}` : error ? "项目读取失败" : loading ? "正在读取项目状态" : "未知项目状态"}</footer></aside>
      <div className="workspace-resizer" role="separator" aria-label="调整文件侧栏宽度" aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={beginSidebarResize} onPointerMove={moveSidebarResize} onPointerUp={endSidebarResize} onPointerCancel={endSidebarResize} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setSidebarWidth((width) => clampSidebarWidth(width + (event.key === "ArrowLeft" ? -16 : 16))); }}/>
      <section className="editor">{inProgressNotice && <div className="op-banner" role="status">{inProgressNotice}</div>}{detachedOid && <div className="op-banner detached-banner" role="status"><span>分离 HEAD：当前检出提交 {detachedOid.slice(0, 8)}，不在任何分支上；在此提交会不属于任何分支。</span><button type="button" disabled={!!writeBlocked} title={writeBlocked ?? undefined} onClick={() => { loadRefsView(); setNewBranch({ initial: { ref: "HEAD", label: `当前 HEAD ${detachedOid.slice(0, 8)}` } }); }}>从这里新建分支…</button></div>}<div className="tabbar"><strong>{selectedFile?.displayPath ?? "Diff"}</strong>{selectedFile?.oldDisplayPath && <span className="rename-path">← {selectedFile.oldDisplayPath}</span>}{historyReading && <span className="history-badge" title="主阅读器正在显示历史版本：两端为固定的提交 OID，只读">历史 · {historyReading.source}</span>}<span className="spacer"/>{historyReading ? <button type="button" onClick={returnToLocal} title="回到进入历史之前的本地文件与阅读位置">← 返回本地变化</button> : localSelectedFile && localSelectedFile.status !== "untracked" && <button type="button" className="quiet" onClick={() => openFileHistory(localSelectedFile)} title="在底部“日志”页查看该文件的提交历史（从 HEAD 开始）">文件历史</button>}{selectedFile?.contentUnchanged && <span className="unchanged-note" title={contentUnchangedLabels[selectedFile.contentUnchanged].detail}>{contentUnchangedLabels[selectedFile.contentUnchanged].short}：Git 规范化后内容一致</span>}{loading && contentPending.current && <button onClick={() => { const cancelled = newRequestId(); contentGate.current.activate(cancelled); contentGate.current.finish(cancelled); contentPending.current = false; setLoading(false); setPair(null); setDiffDocument(null); void cancelContentRead().catch(() => {}); }}>取消读取</button>}{diffDocument && <span>{diffDocument.hunks.length} 处差异 · Worker {diffDocument.elapsedMs.toFixed(1)} ms</span>}</div>{readable && <div className="toolbar"><button onClick={() => viewer.current?.navigate(-1)} disabled={!position.total}>↑</button><button onClick={() => viewer.current?.navigate(1)} disabled={!position.total}>↓</button><span>{position.current} / {position.total}</span><select value={singleFile ? "single" : mode} disabled={singleFile} onChange={(event) => { const value = event.target.value; if (value === "split" || value === "unified") setMode(value); }} aria-label="Diff 布局">{diffModes.includes("single") && <option value="single">单文件视图</option>}{diffModes.includes("split") && <option value="split">并排视图</option>}{diffModes.includes("unified") && <option value="unified">统一视图</option>}</select><select value={highlight} disabled={singleFile} onChange={(event) => setHighlight(event.target.value as "words" | "lines")} aria-label="高亮粒度"><option value="words">按词高亮</option><option value="lines">按行高亮</option></select><ToggleButton label="折叠上下文" pressed={collapsed} disabled={singleFile} onClick={() => setCollapsed((value) => !value)}/><ToggleButton label="自动换行" pressed={wrap} onClick={() => setWrap((value) => !value)}/><ToggleButton label="对齐变化" pressed={alignChanges} disabled={singleFile} onClick={() => setAlignChanges((value) => !value)}/></div>}
        {selectedFile?.status === "conflicted" && <div className="conflict-toolbar"><strong>未合并 index · 只读版本查看（替代普通范围比较）</strong>{versions.map((value, index) => <select key={index} aria-label={index === 0 ? "冲突左版本" : "冲突右版本"} value={value} onChange={event => { const next: [ConflictVersion, ConflictVersion] = [...versions]; next[index] = event.target.value as ConflictVersion; if (snapshot) void selectFile(snapshot, selectedFile, activeProject?.gitExecutable ?? "", 0, false, next); }}>{Object.entries(versionLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>)}{pair && <div className="conflict-identities">{[pair.left, pair.right].map((side,index) => <div key={index}>{endpoints[index]} · {side.encoding === "missing" ? "缺失 / 删除" : side.details?.sizeKnown === false ? "字节数未知" : `${side.byteLength} 字节`} · mode {side.details?.mode ?? "—"} · OID {side.details?.oid ?? "—"}{side.details?.reason && <p>{side.details.reason}</p>}</div>)}</div>}</div>}
        <div className={singleFile ? "endpoints single" : mode === "split" ? "endpoints split" : "endpoints"} style={{ "--diff-header-left-width": `${splitLayout.leftWidth}px` } as CSSProperties}>{singleFile ? <span className="single-endpoint"><span>▣ {singleEndpointLabel}</span>{singleTextSide && <span className="encoding">{singleTextSide.encoding} · {singleTextSide.eol.toUpperCase()}{singleTextSide.hasFinalNewline === false ? " · 无末尾换行" : ""}</span>}</span> : <><span>▣ {pair?.left.endpoint === "emptyTree" ? "空树" : endpoints[0]}</span>{mode === "split" && <span className="endpoint-gutter" aria-hidden="true"/>}<span className="right-endpoint"><span>▣ {endpoints[1]}</span>{pair && <span className="encoding">{pair.right.encoding} · {pair.right.eol.toUpperCase()}{pair.right.hasFinalNewline === false ? " · 无末尾换行" : ""}</span>}</span></>}</div>
        <div className="content">{notice && <SelectionNotice message={notice} onDismiss={() => setNotice(null)}/>}{loading && !diffDocument && <div className="state">正在读取真实仓库…</div>}{error && <div className="state error"><strong>无法显示差异</strong><p>{error}</p></div>}{!loading && !error && pair?.left.encoding === "missing" && pair.right.encoding === "missing" && <div className="state">所选两端均缺失，没有可比较内容。</div>}{!loading && !error && pair?.degradation && <div className="state warning"><strong>内容已降级</strong><p>{pair.degradation}</p></div>}{!loading && !error && pair && (pair.left.details?.image || pair.right.details?.image || /\.(png|jpe?g|webp)$/i.test(pair.displayPath)) && <ImageViewer key={`${pair.repoId}:${pair.pathId}:${pair.left.contentId}:${pair.right.contentId}`} left={pair.left} right={pair.right} labels={endpoints}/>} {!loading && !error && availableText && pair && <><div className="partial-notice">仅显示可用文本端；另一侧不可用，跨侧差异计数与导航不可计算。{pair.degradation}</div><DiffViewer readingKey={`${pair.repoId}:${pair.pathId}:${availableText.endpoint}`} presentation={{kind:"compare"}} left={editorText(availableText.text!)} right={editorText(availableText.text!)} document={{requestId:pair.requestId,contentIds:[availableText.contentId,availableText.contentId],changes:[],hunks:[],elapsedMs:0}} mode="unified" highlight={highlight} collapsed={false} wrap={wrap} fontSize={fontSize} scheme={scheme} alignChanges={false} onPositionChange={() => {}} onSplitLayoutChange={() => {}}/></>} {!error && readable && pair && diffDocument && <DiffViewer readingKey={historyReading ? `${pair.repoId}:history:${historyReading.key}` : `${pair.repoId}:${scope}:${pair.pathId}`} presentation={presentation} ref={viewer} left={editorText(pair.left.text ?? "")} right={editorText(pair.right.text ?? "")} document={diffDocument} mode={mode} highlight={highlight} collapsed={collapsed} wrap={wrap} fontSize={fontSize} scheme={scheme} alignChanges={alignChanges} onPositionChange={handlePositionChange} onSplitLayoutChange={handleSplitLayoutChange}/>} {!loading && !error && !pair && <div className="state">选择一个变化文件开始阅读</div>}</div><footer className="diff-footer"><span>蓝：修改　绿：新增　灰：删除</span><span className="spacer"/>{snapshot && <span>Git {snapshot.git.version} · revision {snapshot.revision.slice(0, 8)}</span>}</footer></section>
    </section>
    <GitPanel repoId={activeRepoId} tab={gitTab} onTab={setGitTab} stagedCount={stagedCount} headOid={runtime?.snapshot?.branchInfo?.oid ?? null} headKey={`${snapshot?.branchInfo?.oid ?? ""}:${snapshot?.branchInfo?.upstream ?? ""}:${snapshot?.branchInfo?.ahead ?? ""}:${snapshot?.branchInfo?.behind ?? ""}`}
      mergeInProgress={!!snapshot?.inProgress?.merge} blockedReason={writeBlocked && !repoOps?.running ? writeBlocked : null} running={repoOps?.running ?? null} lines={repoOps?.lines ?? []} last={repoOps?.last ?? null} lastCommit={repoOps?.lastCommit ?? null} backups={repoOps?.backups ?? []}
      onCommit={commit} onUndoCommit={(head) => void undoCommit(head)} onUndoDiscard={(id) => void undoDiscard(id)} onCancel={() => { if (activeRepoId) void cancelOperation(activeRepoId); }}
      logContent={activeRepoId && logMounted === activeRepoId ? <HistoryPanel key={activeRepoId} repoId={activeRepoId} refsVersion={refsVersion} hidden={gitTab !== "log"} fileHistoryRequest={fileHistoryRequest} activeKey={historyReading?.key ?? null} onOpenFile={(open) => void openHistoryFile(open)} onFetch={openFetch} fetchBlocked={writeBlocked ?? (noRemote ? "该仓库没有配置 remote；Oris 不会新增 remote" : null)} fetchText={fetchText} onRefs={setRefsView}
        writeBlocked={writeBlocked} onCheckout={(oid) => void runSwitch({ kind: "checkout", commit: oid })} onNewBranch={(start) => { loadRefsView(); setNewBranch({ initial: start }); }}/> : null}
      stashCount={stashCount}
      stashContent={activeRepoId && stashMounted === activeRepoId ? <StashPanel key={activeRepoId} repoId={activeRepoId} version={stashVersion} hidden={gitTab !== "stash"} selectedFiles={stashSelection} blocked={writeBlocked} activeKey={historyReading?.key ?? null}
        onPush={stashPush} onApply={(entry, pop) => void runOp({ kind: "stashApply", index: entry.index, oid: entry.oid, pop })} onDrop={(entry) => void stashDrop(entry)} onOpenFile={(open) => void openHistoryFile(open)} onCount={setStashCount}/> : null}/>
    {newBranch && activeRepoId && <NewBranchDialog repoId={activeRepoId} refs={refsView} initial={newBranch.initial} blocked={writeBlocked} onConfirm={createBranch} onCancel={() => setNewBranch(null)}/>}
    {renameBranch && activeRepoId && <RenameBranchDialog repoId={activeRepoId} branch={renameBranch} refs={refsView} blocked={writeBlocked} onConfirm={(newName) => { const branch = renameBranch; setRenameBranch(null); void runOp({ kind: "branchRename", name: branch.fullName, newName }); }} onCancel={() => setRenameBranch(null)}/>}
    {upstreamBranch && <UpstreamDialog branch={upstreamBranch} refs={refsView} blocked={writeBlocked} onConfirm={(upstream) => { const branch = upstreamBranch; setUpstreamBranch(null); void runOp({ kind: "setUpstream", name: branch.fullName, upstream }); }} onCancel={() => setUpstreamBranch(null)}/>}
    {trackChoice && activeRepoId && <TrackChoiceDialog repoId={activeRepoId} remote={trackChoice.remote} existing={trackChoice.existing} refs={refsView} onCancel={() => setTrackChoice(null)}
      onSwitchExisting={() => { const choice = trackChoice; setTrackChoice(null); void runSwitch({ kind: "branchSwitch", name: `refs/heads/${choice.existing}` }); }}
      onTrackAs={(name) => { const choice = trackChoice; setTrackChoice(null); void runSwitch({ kind: "branchTrack", remote: choice.remote.fullName, localName: name }); }}/>}
    {fetchOpen && <FetchDialog refs={refsView} fetchText={fetchText} blocked={writeBlocked} onConfirm={(remote) => void startFetch(remote)} onCancel={() => setFetchOpen(false)}/>}
    {confirmState && <ConfirmDialog request={confirmState} onConfirm={() => { confirmState.resolve(true); setConfirmState(null); }} onCancel={() => { confirmState.resolve(false); setConfirmState(null); }}/>}
    {settingsOpen && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} gitInUse={snapshot ? { executable: snapshot.git.executable, version: snapshot.git.version, minimumVersion: snapshot.git.minimumVersion } : null}/>}
    <footer className="statusbar"><span>{snapshot ? `${snapshot.repo.worktreePath} · ${snapshot.repo.branch} · ${scopeLabels[scope].short}` : "多项目 → 本地差异浏览"}</span><span className="spacer"/>{repoOps?.running ? <><span className="op-status running" role="status">⟳ 正在{operationLabels[repoOps.running.kind]}…{fetchProgress ? ` ${fetchProgress.text}` : ""}</span>{fetchRunning && <button type="button" className="op-undo" onClick={() => { if (activeRepoId) void cancelOperation(activeRepoId); }}>取消</button>}</> : repoOps?.last && <button type="button" className={`op-status ${repoOps.last.status}`} title="查看最近一次操作的 Git 输出" onClick={() => setGitTab("output")}>{repoOps.last.status === "succeeded" ? "✓" : repoOps.last.status === "cancelled" ? "■" : repoOps.last.status === "needsConfirmation" ? "?" : "✗"} {repoOps.last.message}</button>}{!repoOps?.running && repoOps?.lastBackup && <button type="button" className="op-undo" disabled={!!writeBlocked} title={`撤销刚才丢弃的 ${repoOps.lastBackup.files} 个文件`} onClick={() => void undoDiscard(repoOps.lastBackup!.id)}>撤销丢弃</button>}<span>本机 Git · 缓存 {cache.current.stats().entries}/{cache.current.stats().budget / 1024 / 1024} MiB</span></footer>
  </main>;
}
