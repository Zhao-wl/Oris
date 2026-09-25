import type { GraphRow } from "./history-graph";
import type { Branch, ChangeStatus, RefsView } from "./history-api";
import type { FileChange } from "./types";

/** 提交图单行的几何：泳道宽 12 px，行高与列表行高一致。 */
export const LANE_WIDTH = 12;
export const ROW_HEIGHT = 24;

export interface GraphSegment { x1: number; y1: number; x2: number; y2: number; lane: number; dashed: boolean }

const laneX = (lane: number) => LANE_WIDTH / 2 + lane * LANE_WIDTH;

/**
 * 由 layoutGraph 的一行生成连线：上半行画进入本行的泳道（汇入本提交的线落到节点），
 * 下半行画离开本行的连线。目标父提交不在已加载集合中（分页边缘、筛选结果之外）时画成虚线“延续”。
 */
export function rowSegments(row: GraphRow, loaded: ReadonlySet<string>): GraphSegment[] {
  const mid = ROW_HEIGHT / 2;
  const segments: GraphSegment[] = [];
  row.lanesBefore.forEach((expected, lane) => {
    if (!expected) return;
    if (expected === row.oid) segments.push({ x1: laneX(lane), y1: 0, x2: laneX(row.lane), y2: mid, lane, dashed: false });
    else segments.push({ x1: laneX(lane), y1: 0, x2: laneX(lane), y2: mid, lane, dashed: false });
  });
  for (const edge of row.edges) {
    segments.push({ x1: laneX(edge.fromLane), y1: mid, x2: laneX(edge.toLane), y2: ROW_HEIGHT, lane: edge.toLane, dashed: !loaded.has(edge.target) });
  }
  return segments;
}

export const nodeX = (row: GraphRow) => laneX(row.lane);

/** 比较端点：请求时的引用（完整名或 OID）与解析后固定的 OID。 */
export interface PinnedEndpoint { ref: string; oid: string; label: string }

/** 端点引用已移动（ref 现在指向别的提交）：返回提示文字；OID 端点与未移动的引用返回 null。 */
export function movedEndpoint(endpoint: PinnedEndpoint, refs: RefsView | null): string | null {
  if (!refs || endpoint.ref === endpoint.oid) return null;
  if (endpoint.ref === "HEAD") return refs.head.oid && refs.head.oid !== endpoint.oid ? `HEAD 已移动到 ${refs.head.oid.slice(0, 8)}` : null;
  const oid = refOid(endpoint.ref, refs);
  if (!oid) return `${endpoint.label} 已不存在`;
  return oid !== endpoint.oid ? `${endpoint.label} 已移动到 ${oid.slice(0, 8)}` : null;
}

/** 引用（HEAD、分支或标签完整名）当前指向的提交；不存在时为 null。 */
export function refOid(ref: string, refs: RefsView | null): string | null {
  if (!refs) return null;
  if (ref === "HEAD") return refs.head.oid;
  const branch: Branch | undefined = [...refs.local, ...refs.remote].find((b) => b.fullName === ref);
  return branch?.oid ?? refs.tags?.find((t) => t.fullName === ref)?.oid ?? null;
}

/** Oris 记录的最近一次成功获取（按工作区路径保存在 localStorage）。 */
export const FETCH_LOG_KEY = "oris.fetchLog.v1";
export interface FetchRecord { remote: string; at: number }

export function loadFetchRecord(storage: Pick<Storage, "getItem">, worktree: string): FetchRecord | null {
  try {
    const value = (JSON.parse(storage.getItem(FETCH_LOG_KEY) ?? "{}") as Record<string, FetchRecord>)[worktree];
    return value && typeof value.remote === "string" && typeof value.at === "number" ? value : null;
  } catch { return null; }
}

export function saveFetchRecord(storage: Pick<Storage, "getItem" | "setItem">, worktree: string, record: FetchRecord) {
  let value: Record<string, FetchRecord> = {};
  try { value = JSON.parse(storage.getItem(FETCH_LOG_KEY) ?? "{}") as Record<string, FetchRecord>; } catch { /* 损坏时重建 */ }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  value[worktree] = record;
  storage.setItem(FETCH_LOG_KEY, JSON.stringify(value));
}

/**
 * 获取时间的说明：只有 Oris 本次（或之前）成功获取的时间是确切的；FETCH_HEAD 在其后又被改写，
 * 说明外部工具获取过，确切成功时间未知（R-REMOTE）。
 */
export function fetchTimeText(record: FetchRecord | null, fetchHeadAt: number | null, now = Date.now()): string {
  const time = (at: number) => new Date(at).toLocaleString();
  if (record && (fetchHeadAt === null || fetchHeadAt <= record.at + 5000)) return `上次由 Oris 获取 ${record.remote}：${time(record.at)}${now - record.at > 86_400_000 ? "（超过一天）" : ""}`;
  if (record) return `最近一次获取时间未知：外部工具在 Oris 获取（${time(record.at)}）之后又获取过`;
  return fetchHeadAt === null ? "尚未获取过远端状态（远端跟踪分支来自克隆或外部工具）" : "最近一次获取时间未知（由外部工具获取）";
}

/** 解析 `--progress` 输出的最后一行进度，例如 “Receiving objects:  45% (9/20)”。 */
export function parseProgress(lines: readonly string[]): { phase: string; percent: number | null; text: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^remote:\s*/, "").trim();
    const match = /^([A-Za-z][A-Za-z ]+?):\s+(\d{1,3})%/.exec(line);
    if (match) return { phase: match[1], percent: Math.min(100, Number(match[2])), text: line };
  }
  const last = lines.at(-1)?.trim();
  return last ? { phase: "", percent: null, text: last } : null;
}

/** 历史中的变化状态映射到本地文件状态，用于复用 diff 阅读器的单侧 / 双侧呈现判断。 */
export function historyStatus(status: ChangeStatus): FileChange["status"] {
  switch (status) {
    case "added": case "copied": return "added";
    case "deleted": return "deleted";
    case "renamed": return "renamed";
    case "typeChanged": return "typeChanged";
    default: return "modified";
  }
}

export const isStale = (error: unknown) => !!error && typeof error === "object" && (error as { kind?: unknown }).kind === "staleRequest";
