import { compareFiles } from "./FileTree";
import { filterReadableFiles } from "./file-ignore";
import type { OperationKind, OperationOutcome, OperationRequest } from "./operations-api";
import { pathIdsFor, selectionAfterOperation, switchKinds } from "./operations-model";
import { retainStagingPreview, scopeView, type ProjectStore, type StagingPreview } from "./project-store";
import type { CompareScope, FileChange, RepositorySnapshot } from "./types";
import type { ProjectRecord, ReadingAnchor, RequestGate } from "./workspace-model";

export type QueuedStaging = { kind: "stage" | "unstage"; pathIds: string[] };
export type OperationSnapshotOptions = { stagingPreview: StagingPreview | null; keepPreviousDiff: boolean };

interface Reconciliation {
  repoId: string;
  request: OperationRequest;
  kind: OperationKind;
  outcome: OperationOutcome;
  requestId: string;
  viewScope: CompareScope;
  prior: RepositorySnapshot | null;
  optimistic?: RepositorySnapshot;
  beforeFiles: FileChange[];
  selectedBefore: string | null;
  projects: ProjectStore;
  gate: RequestGate;
  currentView(): { active: boolean; scope: CompareScope; selected: string | null };
  findProject(): ProjectRecord | undefined;
  getIgnoreMatcher(): (path: string) => boolean;
  showIgnored(): boolean;
  nextRequestId(): string;
  clearCache(): void;
  clearRefreshPending(): void;
  accept(snapshot: RepositorySnapshot, project: ProjectRecord, anchor: ReadingAnchor, id: string, options: OperationSnapshotOptions): Promise<void>;
  loadDetails(snapshot: RepositorySnapshot): void;
  refresh(): Promise<RepositorySnapshot>;
  isReconciling(): boolean;
  finishReconcile(): QueuedStaging | null | undefined;
  runQueued(kind: QueuedStaging["kind"], files: FileChange[]): void;
  cancelQueued(kind: QueuedStaging["kind"]): void;
  refreshFailed(error: unknown, hadQueued: boolean): void;
}

export function reconcileOperation({
  repoId, request, kind, outcome, requestId, viewScope, prior, optimistic, beforeFiles, selectedBefore,
  projects, gate, currentView, findProject, getIgnoreMatcher, showIgnored, nextRequestId, clearCache,
  clearRefreshPending, accept, loadDetails, refresh, isReconciling, finishReconcile, runQueued,
  cancelQueued, refreshFailed,
}: Reconciliation): Promise<void> | undefined {
  const apply = async (result: RepositorySnapshot) => {
    const previous = projects.get(repoId);
    // Git 已确认，后台统计补齐前沿用未操作文件的显示信息。
    const stagingPreview = outcome.status === "succeeded" && prior && previous?.snapshot?.revision === prior.revision
      && (request.kind === "stage" || request.kind === "unstage" || request.kind === "stageSelected")
      ? retainStagingPreview(previous, result, request.pathIds) : null;
    if (prior?.revision !== result.revision) clearCache();

    const { active, scope, selected } = currentView();
    // 暂存确认后等待读取时，用户可能已经通过本地缓存切换了范围。
    const acceptId = gate.accepts(requestId) ? requestId : active && outcome.snapshotDeferred && scope !== viewScope ? nextRequestId() : null;
    if (!active || !acceptId) {
      projects.update(repoId, { snapshot: result, details: null, stagingPreview, stagingOutOfDate: false, verifying: false, dirty: false });
      loadDetails(result);
      return;
    }

    if (acceptId !== requestId) gate.activate(acceptId);
    clearRefreshPending();
    const project = findProject();
    if (project) {
      const view = scopeView(result, null, scope);
      const query = project.anchor.filter.trim().toLocaleLowerCase();
      const nextVisible = filterReadableFiles(view.files, getIgnoreMatcher(), query, showIgnored()).sort(compareFiles);
      const currentSelection = selected ?? selectedBefore;
      const selectedPathId = switchKinds.has(outcome.kind) ? currentSelection : selectionAfterOperation(beforeFiles, nextVisible, currentSelection);
      const keepPreviousDiff = kind === "stage" || kind === "unstage" || kind === "hunkStage" || kind === "hunkUnstage";
      const hunk = keepPreviousDiff && selectedPathId !== currentSelection ? 0 : project.anchor.hunk;
      await accept(view, project, { ...project.anchor, scope, selectedPathId, hunk }, acceptId, { stagingPreview, keepPreviousDiff });
    }
    gate.finish(acceptId);
  };

  if (outcome.snapshotDeferred) {
    // 写锁已释放。状态读取在后台进行，写操作结果可以立即返回给调用者。
    void refresh().then(result => {
      if (!isReconciling()) return;
      const queued = finishReconcile();
      if (!findProject()) { gate.finish(requestId); return; }
      void apply(result);
      if (!queued) return;
      const targetIds = new Set(queued.pathIds);
      const files = (result.scopes?.[queued.kind === "stage" ? "unstaged" : "staged"] ?? []).filter(file =>
        file.status !== "conflicted" && targetIds.has(file.pathId));
      const actual = pathIdsFor(files, queued.kind === "unstage");
      if (!currentView().active || !actual.length || actual.some(id => !targetIds.has(id))) {
        cancelQueued(queued.kind);
        return;
      }
      runQueued(queued.kind, files);
    }, error => {
      if (!isReconciling()) return;
      const queued = finishReconcile();
      if (findProject()) {
        projects.update(repoId, current => ({
          snapshot: optimistic && current.snapshot?.revision === optimistic.revision ? prior : current.snapshot,
          stagingOutOfDate: true, dirty: true,
        }));
        refreshFailed(error, !!queued);
      }
      gate.finish(requestId);
    });
    return;
  }

  if (outcome.snapshot) return apply(outcome.snapshot);
  if (optimistic && prior) projects.update(repoId, { snapshot: prior });
  gate.finish(requestId);
}
