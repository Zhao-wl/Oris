import { invoke } from "@tauri-apps/api/core";
import type { CompareScope, RepositorySnapshot } from "./types";

/** 前端只提交操作描述；参数与路径校验在 Rust 端完成（技术方案 §3、§8）。 */
export type OperationRequest =
  | { kind: "stage"; pathIds: string[] }
  | { kind: "unstage"; pathIds: string[] }
  | { kind: "markResolved"; pathIds: string[]; confirmed?: boolean }
  | { kind: "discard"; scope: CompareScope; pathIds: string[]; confirmedUnrecoverable?: boolean }
  | { kind: "undoDiscard"; backupId: string; overwrite?: boolean }
  | { kind: "commit"; message: string; amend?: boolean; keepMessage?: boolean; expectedHead?: string | null }
  | { kind: "undoCommit"; expectedHead: string }
  | { kind: "fetch"; remote: string }
  | { kind: "stashPush"; message?: string | null; includeUntracked?: boolean; pathIds?: string[] | null }
  | { kind: "stashApply"; index: number; oid: string; pop?: boolean }
  | { kind: "stashDrop"; index: number; oid: string }
  | ({ kind: "branchCreate"; name: string; start: string; switch?: boolean } & StashFirst)
  | ({ kind: "branchSwitch"; name: string } & StashFirst)
  | ({ kind: "branchTrack"; remote: string; localName?: string | null } & StashFirst)
  | ({ kind: "checkout"; commit: string } & StashFirst)
  | { kind: "branchRename"; name: string; newName: string }
  | { kind: "branchDelete"; name: string; force?: boolean }
  | { kind: "setUpstream"; name: string; upstream: string }
  | ({ kind: "pull"; mode: "ffOnly" | "merge" } & StashFirst)
  | { kind: "push"; remote?: string | null }
  | { kind: "merge"; target: string; expected: string; noFf?: boolean }
  | { kind: "mergeAbort" }
  | { kind: "mergeCommit"; message: string };

/** “stash 后切换”：Git 因工作区改动拒绝切换、用户确认后，先储藏（可含未跟踪文件）再切换，切换后不自动恢复。 */
export interface StashFirst { stashFirst?: boolean; stashUntracked?: boolean }

export type OperationKind = "stage" | "unstage" | "markResolved" | "discard" | "undoDiscard" | "commit" | "amend" | "undoCommit" | "fetch"
  | "stashPush" | "stashApply" | "stashPop" | "stashDrop"
  | "branchCreate" | "branchSwitch" | "branchTrack" | "checkout" | "branchRename" | "branchDelete" | "setUpstream"
  | "pull" | "push" | "merge" | "mergeAbort" | "mergeCommit";
export type OperationStatus = "succeeded" | "failed" | "cancelled" | "needsConfirmation";

export interface Confirmation {
  reason: "conflictMarkers" | "unrecoverable" | "modifiedSinceDiscard" | "localChanges" | "untrackedOverwritten" | "localExists" | "unmerged" | "diverged";
  message: string;
  paths: string[];
}

export interface BackupSummary {
  id: string;
  createdAt: number;
  scope: CompareScope;
  files: number;
  unrecoverable: number;
  paths: string[];
}

export interface OperationOutcome {
  opId: string;
  repoId: string;
  kind: OperationKind;
  status: OperationStatus;
  message: string;
  output: string;
  outputTruncated: boolean;
  snapshot: RepositorySnapshot | null;
  confirmation: Confirmation | null;
  backup: BackupSummary | null;
  lockLeft: boolean;
  gitProcesses: number;
  elapsedMs: number;
}

export interface DiscardPlan {
  scope: CompareScope;
  files: number;
  untracked: number;
  paths: string[];
  unrecoverable: string[];
  blocked: { path: string; reason: string }[];
}

export interface HeadCommitInfo {
  oid: string;
  parents: string[];
  message: string;
  subject: string;
  /** null：没有上游，不做已推送限制。 */
  pushed: boolean | null;
  upstream: string | null;
  detached: boolean;
}

export interface LastOperation {
  opId: string;
  kind: OperationKind;
  status: OperationStatus;
  message: string;
  output: string;
  outputTruncated: boolean;
  finishedAt: number;
}

export const runOperation = (repoId: string, scope: CompareScope, opId: string, request: OperationRequest) =>
  invoke<OperationOutcome>("run_operation", { repoId, scope, opId, request });
export const cancelOperation = (repoId: string) => invoke<boolean>("cancel_operation", { repoId });
export const lastOperation = (repoId: string) => invoke<LastOperation | null>("last_operation", { repoId });
export const prepareDiscard = (repoId: string, scope: CompareScope, pathIds: string[]) => invoke<DiscardPlan>("prepare_discard", { repoId, scope, pathIds });
export const discardBackups = (repoId: string) => invoke<BackupSummary[]>("discard_backups", { repoId });
export const headCommitInfo = (repoId: string) => invoke<HeadCommitInfo | null>("head_commit_info", { repoId });
