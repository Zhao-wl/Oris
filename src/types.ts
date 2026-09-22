export type Endpoint = "index" | "workingTree";

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
  status: "modified" | "deleted" | "typeChanged";
}

export interface RepositorySnapshot {
  requestId: string;
  repo: RepositoryInfo;
  revision: string;
  files: FileChange[];
  git: GitInfo;
}

export interface TextSide {
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
