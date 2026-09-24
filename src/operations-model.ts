import type { CompareScope, FileChange, RepositorySnapshot } from "./types";
import type { OperationKind } from "./operations-api";

/**
 * 乐观更新（技术方案 §4）：stage / unstage 立即在两个范围之间移动条目并标记“确认中”；
 * revision 不变，后台统计与内容缓存继续可用。Git 确认后由真实快照替换，失败时恢复原快照。
 */
export function optimisticMove(snapshot: RepositorySnapshot, kind: "stage" | "unstage", files: FileChange[]): RepositorySnapshot {
  if (!snapshot.scopes) return snapshot;
  const ids = new Set(files.map((file) => file.pathId));
  const { unstaged, staged, all } = snapshot.scopes;
  const pending = (file: FileChange, status: FileChange["status"] = file.status): FileChange => ({ ...file, status, pending: true });
  let nextUnstaged = unstaged;
  let nextStaged = staged;
  if (kind === "stage") {
    const moved = unstaged.filter((file) => ids.has(file.pathId));
    nextUnstaged = unstaged.filter((file) => !ids.has(file.pathId) || file.status === "conflicted");
    const byId = new Map(staged.map((file) => [file.pathId, file]));
    for (const file of moved) {
      if (file.status === "conflicted") continue;
      const existing = byId.get(file.pathId);
      byId.set(file.pathId, pending(existing ?? file, existing?.status ?? (file.status === "untracked" ? "added" : file.status)));
    }
    nextStaged = [...byId.values()].sort(byPath);
  } else {
    const moved = staged.filter((file) => ids.has(file.pathId));
    nextStaged = staged.filter((file) => !ids.has(file.pathId));
    const byId = new Map(unstaged.map((file) => [file.pathId, file]));
    for (const file of moved) {
      if (file.status === "renamed") {
        // 取消暂存 rename：未暂存视角为原路径删除 + 新路径未跟踪。
        if (file.oldPathId && file.oldDisplayPath) byId.set(file.oldPathId, pending({ ...file, pathId: file.oldPathId, displayPath: file.oldDisplayPath, oldPathId: null, oldDisplayPath: null, additions: null, deletions: null }, "deleted"));
        byId.set(file.pathId, pending({ ...file, oldPathId: null, oldDisplayPath: null, additions: null, deletions: null }, "untracked"));
        continue;
      }
      if (!byId.has(file.pathId)) byId.set(file.pathId, pending(file, file.status === "added" ? "untracked" : file.status));
      else byId.set(file.pathId, pending(byId.get(file.pathId)!));
    }
    nextUnstaged = [...byId.values()].sort(byPath);
  }
  return { ...snapshot, scopes: { unstaged: nextUnstaged, staged: nextStaged, all }, files: snapshot.scope === "staged" ? nextStaged : snapshot.scope === "unstaged" ? nextUnstaged : snapshot.files };
}

const byPath = (a: FileChange, b: FileChange) => (a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0);

/** 发给后端的路径：取消暂存 rename 与“全部”范围丢弃 rename 时需要带上原路径。 */
export function pathIdsFor(files: FileChange[], includeOldPaths: boolean): string[] {
  const ids: string[] = [];
  for (const file of files) {
    if (!ids.includes(file.pathId)) ids.push(file.pathId);
    if (includeOldPaths && file.oldPathId && !ids.includes(file.oldPathId)) ids.push(file.oldPathId);
  }
  return ids;
}

/** 某范围内文件行可用的写操作（R-STAGE、R-DISCARD；冲突文件为“标记已解决”）。 */
export function rowActions(scope: CompareScope, file: FileChange): { primary: "stage" | "unstage" | "markResolved" | null; discard: boolean; discardBlocked: string | null } {
  if (file.status === "conflicted") return { primary: "markResolved", discard: false, discardBlocked: "冲突文件不能丢弃；请在合并流程中处理" };
  const discardBlocked = file.gitlink ? "子模块条目（gitlink）不提供丢弃" : null;
  if (scope === "unstaged") return { primary: "stage", discard: !discardBlocked, discardBlocked };
  if (scope === "staged") return { primary: "unstage", discard: false, discardBlocked: "已暂存范围不提供丢弃，请先取消暂存" };
  return { primary: null, discard: !discardBlocked, discardBlocked };
}

export const operationLabels: Record<OperationKind, string> = {
  stage: "暂存", unstage: "取消暂存", markResolved: "标记已解决", discard: "丢弃", undoDiscard: "撤销丢弃",
  commit: "提交", amend: "修订提交", undoCommit: "撤销最近提交", fetch: "获取远端状态",
  stashPush: "储藏", stashApply: "应用 stash", stashPop: "弹出 stash", stashDrop: "删除 stash",
  branchCreate: "新建分支", branchSwitch: "切换分支", branchTrack: "检出远端分支", checkout: "检出提交", branchRename: "重命名分支", branchDelete: "删除分支", setUpstream: "设置上游"
};

/** 影响维度（技术方案 §4）：会改变 HEAD / 分支 / 远端跟踪引用的操作结束后重读分支列表与日志；会改变 refs/stash 的操作重读 stash 列表。 */
export const refsKinds: ReadonlySet<OperationKind> = new Set(["commit", "amend", "undoCommit", "fetch", "branchCreate", "branchSwitch", "branchTrack", "checkout", "branchRename", "branchDelete", "setUpstream"]);
export const stashKinds: ReadonlySet<OperationKind> = new Set(["stashPush", "stashApply", "stashPop", "stashDrop", "branchCreate", "branchSwitch", "branchTrack", "checkout"]);

/** 会移动 HEAD 或改写工作区的分支类操作：结束后阅读位置按“文件仍在则保留，否则回到合法入口并提示”处理。 */
export const switchKinds: ReadonlySet<OperationKind> = new Set(["branchCreate", "branchSwitch", "branchTrack", "checkout", "stashApply", "stashPop", "stashPush"]);

/** 仓库处于 Oris 不支持的进行中状态时的说明（写操作全部禁用，阅读正常）。 */
export function unsupportedInProgress(snapshot: RepositorySnapshot | null | undefined): string | null {
  const state = snapshot?.inProgress;
  if (!state) return null;
  const name = state.rebase ? "rebase" : state.cherryPick ? "cherry-pick" : state.revert ? "revert" : state.bisect ? "bisect" : null;
  return name ? `仓库处于 ${name} 进行中：Oris 已禁用写操作，请回到命令行完成或中止；刷新与阅读不受影响` : null;
}

/** 写入口不可用的原因；null 表示可用。 */
export function writeBlockedReason({ snapshot, verifying, running, stale }: { snapshot: RepositorySnapshot | null | undefined; verifying: boolean; running: string | null; stale?: boolean }): string | null {
  if (!snapshot) return "尚未载入项目";
  if (verifying) return "正在校验上次保存的快照，校验完成前写操作不可用";
  if (running) return `正在执行“${running}”，完成前其他写操作不可用`;
  if (stale) return "当前显示的是旧快照，请先刷新";
  return unsupportedInProgress(snapshot);
}

/** 写操作后的选中项：原文件仍在列表中则保留；否则选同一位置的下一个文件（不提示“阅读位置已调整”）。 */
export function selectionAfterOperation(before: FileChange[], after: FileChange[], selectedPathId: string | null): string | null {
  if (selectedPathId && after.some((file) => file.pathId === selectedPathId)) return selectedPathId;
  if (!after.length) return null;
  const index = Math.max(0, before.findIndex((file) => file.pathId === selectedPathId));
  const remaining = new Set(after.map((file) => file.pathId));
  for (const file of before.slice(index + 1)) if (remaining.has(file.pathId)) return file.pathId;
  for (const file of before.slice(0, index).reverse()) if (remaining.has(file.pathId)) return file.pathId;
  return after[Math.min(index, after.length - 1)].pathId;
}

// ---------- 提交草稿（按项目保存，重启后恢复） ----------
export const DRAFTS_KEY = "oris.commitDrafts.v1";

export function loadDraft(storage: Pick<Storage, "getItem">, repoId: string): string {
  try {
    const value = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, unknown>;
    return typeof value[repoId] === "string" ? value[repoId] as string : "";
  } catch {
    return "";
  }
}

export function saveDraft(storage: Pick<Storage, "getItem" | "setItem">, repoId: string, text: string) {
  let value: Record<string, string> = {};
  try { value = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, string>; } catch { /* 损坏时重建 */ }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  if (text) value[repoId] = text; else delete value[repoId];
  storage.setItem(DRAFTS_KEY, JSON.stringify(value));
}

/** 撤销最近提交的确认文案（普通 / 合并 / 根提交）。 */
export function undoCommitText(head: { subject: string; parents: string[]; oid: string }): string {
  if (head.parents.length === 0) return `HEAD（${head.oid.slice(0, 8)} ${head.subject}）是根提交。撤销后仓库回到没有提交的状态，所有文件保留在暂存区，工作区不变。`;
  if (head.parents.length > 1) return `HEAD（${head.oid.slice(0, 8)} ${head.subject}）是合并提交。撤销后 HEAD 回到第一个父提交 ${head.parents[0].slice(0, 8)}，合并带来的改动回到暂存区，工作区不变；被合并的提交之后只能通过 reflog 找回。`;
  return `HEAD 回退一个提交（${head.oid.slice(0, 8)} ${head.subject}），这次提交的改动回到暂存区，工作区不变。`;
}
