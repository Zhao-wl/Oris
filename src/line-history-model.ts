import type { ContentPair, FileChange } from "./types";
import type { HistoryFileOpen } from "./HistoryPanel";
import type { DiffLineSelection } from "./diff-line-selection";
import type { LineQuery } from "./history-api";
import type { TraceSource } from "./trace-api";

export interface LineHistoryContext { pair: ContentPair; file: FileChange; history: HistoryFileOpen | null; head: string | null }
export function lineHistoryKey(context: LineHistoryContext) {
  const { pair, history, head } = context;
  return JSON.stringify([pair.repoId, pair.pathId, pair.left.contentId, pair.right.contentId, history?.left.oid, history?.right.oid, head]);
}

export function lineQuery(context: LineHistoryContext, selection: DiffLineSelection): LineQuery | string {
  const { pair, file, history, head } = context;
  const side = selection.side === "a" ? pair.left : pair.right;
  if (side.text === null || side.encoding === "missing" || side.endpoint === "emptyTree") return "此版本没有可追溯的文本行";
  if (side.encoding !== "utf-8") return "此编码暂不支持行提交信息";
  if (side.kind && side.kind !== "text") return "此文件类型不支持行提交信息";
  if (/\r(?!\n)/.test(side.text)) return "此文件的换行格式暂不支持行提交信息";
  const lines = side.text.split(/\r?\n/);
  if (selection.line < 1 || selection.line > lines.length || (selection.line === lines.length && lines.at(-1) === "")) return "文件末尾占位行没有提交记录";
  const pathId = selection.side === "a" ? file.oldPathId ?? file.pathId : file.pathId;
  if (history && side.endpoint === "commit") return { pathId, revision: selection.side === "a" ? history.left.oid : history.right.oid, contents: null, line: selection.line };
  if (side.endpoint === "head") return { pathId: file.oldPathId ?? pathId, revision: head, contents: null, line: selection.line };
  if (side.endpoint === "index" || side.endpoint === "workingTree") return { pathId: file.oldPathId ?? file.pathId, revision: head, contents: `${side.bom ? "\uFEFF" : ""}${side.text}`, line: selection.line };
  return "冲突阶段版本暂不支持行提交信息";
}

export function relativeCommitTime(seconds: number, now = Date.now()) {
  const days = Math.floor(Math.max(0, now - seconds * 1000) / 86_400_000);
  if (days >= 365) return `${Math.floor(days / 365)} 年前`;
  if (days >= 30) return `${Math.floor(days / 30)} 个月前`;
  if (days >= 7) return `${Math.floor(days / 7)} 周前`;
  if (days > 0) return `${days} 天前`;
  const minutes = Math.floor(Math.max(0, now - seconds * 1000) / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时前` : minutes > 0 ? `${minutes} 分钟前` : "刚刚";
}

/** 只消费阅读器既有的单行选区；连续行段由追溯面板显式选择，不改动 DiffViewer 选区。 */
export function traceSource(context: LineHistoryContext, selection: DiffLineSelection): TraceSource | string {
  const query = lineQuery(context, selection);
  if (typeof query === "string") return query;
  const side = selection.side === "a" ? context.pair.left : context.pair.right;
  return { query, endLine: selection.line, repoId: context.pair.repoId, contentId: side.contentId, snapshotRevision: context.pair.revision, side: selection.side };
}
