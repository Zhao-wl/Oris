import { invoke } from "@tauri-apps/api/core";
import { decodeContentFrame } from "./api";

/** 任务 04：历史、分支、比较、文件历史的只读接口。参数为类型化结构，后端只接受完整引用名或 OID。 */
export type RefKind = "head" | "local" | "remote" | "tag";
export interface RefLabel { name: string; kind: RefKind; current: boolean }

export interface CommitInfo {
  oid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  subject: string;
  body: string;
  refs: RefLabel[];
}

export type SearchKind = "message" | "author" | "sha";
export interface LogQuery { refs: string[]; search: { kind: SearchKind; text: string } | null; pageSize: number }
export interface LogCursor { tips: string[]; skip: number }
export interface LogPage { commits: CommitInfo[]; next: LogCursor | null; tips: string[] }

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged" | "unmerged";
export interface ChangedFile { path: string; oldPath: string | null; pathId: string; oldPathId: string | null; status: ChangeStatus }
export interface CommitChanges { oid: string; parent: string | null; parents: string[]; files: ChangedFile[] }
export interface Comparison { leftRef: string; rightRef: string; left: string; right: string; files: ChangedFile[] }

export interface FileHistoryEntry { commit: CommitInfo; path: string; pathId: string; status: ChangeStatus; renamedFrom: string | null; renamedFromId: string | null }
export interface FileHistory { entries: FileHistoryEntry[]; next: LogCursor | null; reachedOrigin: boolean }

export type Tracking =
  | { state: "noUpstream" }
  | { state: "gone"; upstream: string }
  | { state: "known"; upstream: string; ahead: number; behind: number }
  | { state: "unknown"; upstream: string; reason: string };
export interface Branch { fullName: string; name: string; kind: "local" | "remote"; oid: string; current: boolean; tracking: Tracking | null; remote: string | null }
export interface HeadState { branch: string | null; oid: string | null; detached: boolean; unborn: boolean }
export interface RefsView {
  head: HeadState;
  local: Branch[];
  remote: Branch[];
  shallow: boolean;
  remotes: string[];
  /** 显式获取的默认目标（当前分支有效上游所属的 remote）；为 null 时需要用户选择。 */
  defaultRemote: string | null;
  /** FETCH_HEAD 的修改时间，只用于判断外部工具是否在 Oris 记录之后又获取过。 */
  fetchHeadAt: number | null;
  /** 影响拉取的配置（branch.<name>.rebase 或 pull.rebase）；Oris 始终以 --no-rebase 执行。 */
  pullRebase?: string | null;
  mergeFf?: string | null;
}

export const readLog = (repoId: string, query: LogQuery, cursor: LogCursor | null) => invoke<LogPage>("read_log", { repoId, query, cursor });
export const commitChanges = (repoId: string, commit: string, parent: string | null) => invoke<CommitChanges>("commit_changes", { repoId, commit, parent });
export const compareRevisions = (repoId: string, left: string, right: string) => invoke<Comparison>("compare_revisions", { repoId, left, right });
export const fileHistory = (repoId: string, start: string, pathId: string, pageSize: number, cursor: LogCursor | null) => invoke<FileHistory>("file_history", { repoId, start, pathId, pageSize, cursor });
export const readRefs = (repoId: string) => invoke<RefsView>("read_refs", { repoId });
export const readRevisionPair = async (repoId: string, left: string | null, right: string, pathId: string, oldPathId: string | null, requestId: string) =>
  decodeContentFrame(await invoke<ArrayBuffer>("read_revision_pair", { repoId, left, right, pathId, oldPathId, requestId }));

export const shortOid = (oid: string | null | undefined) => (oid ? oid.slice(0, 8) : "—");
export const shortRef = (name: string) => name.replace(/^refs\/(heads|remotes|tags)\//, "");

/** 上游状态的文字：无上游、上游已消失、未知分别表达，不显示伪 0/0（R-BRANCH）。 */
export function trackingText(tracking: Tracking | null): { short: string; title: string } {
  if (!tracking || tracking.state === "noUpstream") return { short: "无上游", title: "没有配置上游分支" };
  if (tracking.state === "gone") return { short: "上游已消失", title: `上游 ${shortRef(tracking.upstream)} 已不存在（远端分支可能已被删除）` };
  if (tracking.state === "unknown") return { short: "未知", title: `相对 ${shortRef(tracking.upstream)}：${tracking.reason}` };
  const { ahead, behind, upstream } = tracking;
  return {
    short: ahead === 0 && behind === 0 ? "已同步" : `↑${ahead} ↓${behind}`,
    title: `相对上游 ${shortRef(upstream)}：领先 ${ahead}、落后 ${behind}（基于本地引用快照，不代表服务器实时状态）`
  };
}

export const statusLetter: Record<ChangeStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typeChanged: "T", unmerged: "U" };

// ---------- V2-03：stash 与分支名校验（只读） ----------
export interface StashEntry { index: number; oid: string; message: string; branch: string; time: number; base: string; untracked: string | null }
export interface StashChanges { oid: string; base: string; tracked: ChangedFile[]; untrackedCommit: string | null; untracked: ChangedFile[] }
export const stashList = (repoId: string) => invoke<StashEntry[]>("stash_list", { repoId });
export const stashChanges = (repoId: string, oid: string) => invoke<StashChanges>("stash_changes", { repoId, oid });
/** 分支名校验（`check-ref-format --branch`）；无效时抛出带原因的错误。 */
export const checkBranchName = (repoId: string, name: string) => invoke<void>("check_branch_name", { repoId, name });

// ---------- V2-04：合并进行中的默认合并信息（只读） ----------
export const mergeMessage = (repoId: string) => invoke<string | null>("merge_message", { repoId });
