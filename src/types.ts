export type CompareScope = "unstaged" | "staged" | "all";
export type ConflictVersion = "stage1" | "stage2" | "stage3" | "workingTree";
export type Endpoint = ConflictVersion | "head" | "index" | "workingTree" | "emptyTree" | "commit" | "unavailable";

export interface GitInfo {
  executable: string;
  version: string;
  supported: boolean;
  minimumVersion: string;
}

export interface RepositoryInfo {
  repoId: string;
  displayName: string;
  worktreePath: string;
  gitDir: string;
  commonDir: string;
  branch: string;
}

export interface FileChange {
  pathId: string;
  displayPath: string;
  oldPathId: string | null;
  oldDisplayPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted" | "typeChanged";
  additions: number | null;
  deletions: number | null;
  /** status 报告修改，但 Git 规范化后内容与比较基准一致：eol 为仅行尾不同，normalized 为其他规范化（如 clean filter）。 */
  contentUnchanged?: ContentUnchanged;
  /** 子模块条目（gitlink）：不提供丢弃。 */
  gitlink?: boolean;
  /** 乐观更新中、等待 Git 确认（仅前端）。 */
  pending?: boolean;
}

export type ContentUnchanged = "eol" | "normalized";

export interface ScopeLists {
  unstaged: FileChange[];
  staged: FileChange[];
  all: FileChange[];
}

export interface BranchSummary {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface InProgressSummary {
  merge: boolean;
  rebase: boolean;
  cherryPick: boolean;
  revert: boolean;
  bisect: boolean;
}

export interface RepositorySnapshot {
  requestId: string;
  repo: RepositoryInfo;
  scope: CompareScope;
  revision: string;
  files: FileChange[];
  git: GitInfo;
  scannedAt: number;
  /** V2：一次 status 得到的三个范围，切换范围时直接使用，不再请求后端。 */
  scopes?: ScopeLists | null;
  /** 为 false 时增删统计仍在后台补齐，界面显示占位而不是 0。 */
  statsReady?: boolean;
  branchInfo?: BranchSummary | null;
  inProgress?: InProgressSummary | null;
}

/** 后台补齐的次要信息（按 revision 缓存）。 */
export interface RepositoryDetails {
  revision: string;
  stats: Record<CompareScope, [string, number | null, number | null][]>;
  /** 仅未暂存与“全部”范围可能出现；旧缓存可能缺失。 */
  contentUnchanged?: Partial<Record<CompareScope, [string, ContentUnchanged][]>>;
  all: FileChange[];
  elapsedMs: number;
}

export interface ImagePayload {
  mime: string; base64: string; width: number; height: number;
  /** V2 二进制帧中的原始图片字节；存在时优先于 base64。 */
  bytes?: Uint8Array;
  displayWidth: number; displayHeight: number; orientation: number;
}
export interface SideDetails {
  sizeKnown?: boolean;
  state: "ready" | "missing" | "unavailable" | "unsupported" | "overBudget";
  reason: string | null; oid: string | null; mode: string | null; image: ImagePayload | null;
  /** SHA-256 of the LFS entity when the side is stored as an LFS pointer. */
  lfsOid?: string | null;
}
export interface TextSide {
  details?: SideDetails | null;
  endpoint: Endpoint;
  text: string | null;
  byteLength: number;
  encoding: "utf-8" | "binary-or-unsupported" | "missing";
  eol: "lf" | "crlf" | "mixed" | "none";
  hasFinalNewline: boolean | null;
  contentId: string;
}

export interface ContentPair {
  requestId: string;
  repoId: string;
  revision: string;
  pathId: string;
  displayPath: string;
  left: TextSide;
  right: TextSide;
  stale: boolean;
  degradation: string | null;
}

export interface DiffHunk {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export interface DiffDocument {
  requestId: string;
  contentIds: [string, string];
  changes: DiffHunk[];
  hunks: DiffHunk[];
  elapsedMs: number;
}
