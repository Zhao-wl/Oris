import { invoke } from "@tauri-apps/api/core";
import type { LineQuery, ChangeStatus } from "./history-api";

export interface TraceSource { query: LineQuery; endLine: number; repoId: string; contentId: string | null; snapshotRevision: string | null; side: "a" | "b" }
export interface LineRange { start: number; end: number }
export interface BlameRow { line: number; originalLine: number; oid: string | null; path: string; pathId: string; author: string; summary: string; text: string }
export interface Stats { elapsedMs: number; outputBytes: number; shallow: boolean }
export interface BlamePage extends Stats { rows: BlameRow[]; next: number | null; totalLines: number }
export interface TraceEntry { oid: string | null; parent: string | null; path: string; pathId: string; oldPath: string; oldPathId: string; newRange: LineRange | null; oldRange: LineRange | null; status: string; inferred: boolean; merge: boolean; patch: string[] }
export interface LineCursor { binding: string; oid: string; pathId: string; range: LineRange; scanned: number }
export interface TraceIdentity { contentId: string | null; snapshotRevision: string | null; side: "a" | "b" }
export interface LineHistoryQuery { source: LineQuery; identity: TraceIdentity; endLine: number; pageSize: number }
export interface LineHistoryPage extends Stats { entries: TraceEntry[]; next: LineCursor | null; reason: string; note: string; scanned: number }
export type Direction = "added" | "deleted" | "both";
export interface ContentSearchQuery { refs: string[]; pathId: string | null; text: string; direction: Direction; pageSize: number; scanBudget: number }
export interface SearchCursor { binding: string; tips: string[]; skip: number }
export interface SearchEntry { oid: string; parent: string | null; path: string; pathId: string; oldPath: string; oldPathId: string; status: ChangeStatus; newRange: LineRange | null; oldRange: LineRange | null; hits: { direction: Direction; line: number; text: string }[]; matchCount: number }
export interface ContentSearchPage extends Stats { entries: SearchEntry[]; next: SearchCursor | null; tips: string[]; reason: string; note: string; scanned: number }
export const readFileBlame = (repoId: string, requestId: string, source: LineQuery, identity: TraceIdentity, start: number) => invoke<BlamePage>("read_file_blame", { repoId, requestId, query: { source, identity, start, pageSize: 200 } });
export const readLineHistory = (repoId: string, requestId: string, query: LineHistoryQuery, cursor: LineCursor | null) => invoke<LineHistoryPage>("read_line_history", { repoId, requestId, query, cursor });
export const searchHistoryContent = (repoId: string, requestId: string, query: ContentSearchQuery, cursor: SearchCursor | null) => invoke<ContentSearchPage>("search_history_content", { repoId, requestId, query, cursor });
export const cancelTraceQuery = (repoId: string, requestId: string) => invoke<void>("cancel_trace_query", { repoId, requestId });

/** 同一会话同时只接受一页；主动取消立即拒绝响应，取消旧 ID 不影响新请求。 */
export class TraceGate {
  private current: string | null = null;
  begin(id: string) { this.current = id; }
  accepts(id: string) { return this.current === id; }
  cancel() { const id = this.current; this.current = null; return id; }
  finish(id: string) { if (this.current === id) this.current = null; }
}
