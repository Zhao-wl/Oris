import type { DiffLineSelection } from "./diff-line-selection";
import type { HunkMap, LineSelection } from "./operations-api";
import type { DiffDocument } from "./types";

export const lineKey = (line: DiffLineSelection) => `${line.side}:${line.line}`;
export function changeLines(map: HunkMap): DiffLineSelection[] {
  return map.hunks.flatMap(h => [
    ...Array.from({ length: h.oldEnd - h.oldStart }, (_, i) => ({ side: "a" as const, line: h.oldStart + i + 1 })),
    ...Array.from({ length: h.newEnd - h.newStart }, (_, i) => ({ side: "b" as const, line: h.newStart + i + 1 }))
  ]);
}
export function toLineSelections(map: HunkMap, selected: readonly DiffLineSelection[]): LineSelection[] {
  const keys = new Set(selected.map(lineKey));
  return map.hunks.map(hunk => ({ hunk,
    oldLines: Array.from({ length: hunk.oldEnd - hunk.oldStart }, (_, i) => i).filter(i => keys.has(`a:${hunk.oldStart + i + 1}`)),
    newLines: Array.from({ length: hunk.newEnd - hunk.newStart }, (_, i) => i).filter(i => keys.has(`b:${hunk.newStart + i + 1}`))
  })).filter(s => s.oldLines.length || s.newLines.length);
}
/** 块拆分为逐行单元。替换的两侧仅按顺序配对，用户可以独立取消一侧；不推断语义对应。 */
export function splitHunkLines(map: HunkMap, index: number, from = 0, to = Infinity): DiffLineSelection[][] {
  const h = map.hunks[index];
  if (!h) return [];
  return Array.from({ length: Math.max(0, Math.min(to, Math.max(h.oldEnd - h.oldStart, h.newEnd - h.newStart)) - from) }, (_, offset) => { const i = from + offset; return [
    ...(h.oldStart + i < h.oldEnd ? [{ side: "a" as const, line: h.oldStart + i + 1 }] : []),
    ...(h.newStart + i < h.newEnd ? [{ side: "b" as const, line: h.newStart + i + 1 }] : [])
  ]; });
}
export function toggleChangeLines(selected: readonly DiffLineSelection[], candidates: readonly DiffLineSelection[], line: DiffLineSelection, anchor: DiffLineSelection | null, range: boolean): DiffLineSelection[] {
  const side = candidates.filter(c => c.side === line.side);
  const target = range && anchor?.side === line.side ? side.filter(c => c.line >= Math.min(line.line, anchor.line) && c.line <= Math.max(line.line, anchor.line)) : side.filter(c => c.line === line.line);
  const chosen = new Map(selected.map(c => [lineKey(c), c]));
  const remove = !range && chosen.has(lineKey(line));
  for (const c of target) { if (remove) chosen.delete(lineKey(c)); else chosen.set(lineKey(c), c); }
  return [...chosen.values()];
}

export interface FineLineNote { side: "a" | "b"; line: number; move?: number; format?: boolean }
/** 保守的整段移动候选：两行以上、含非空文本、字节解码文本完全一致且两侧唯一；不证明语义等价。 */
export function readingAnnotations(document: DiffDocument, left: string, right: string): FineLineNote[] {
  const notes = new Map<string, FineLineNote>();
  const starts = (text: string) => { const out = [0]; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1); return out; };
  const lineStarts = { a: starts(left), b: starts(right) };
  const annotate = (side: "a" | "b", text: string, from: number, to: number, values: Partial<FineLineNote>) => {
    const starts = lineStarts[side]; let low = 0, high = starts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= from) low = mid + 1; else high = mid; }
    const line = low;
    const count = text.slice(from, to).replace(/\n$/, "").split("\n").length;
    if (to <= from) return;
    for (let i = 0; i < count; i++) { const key = `${side}:${line + i}`; notes.set(key, { ...notes.get(key), side, line: line + i, ...values }); }
  };
  const old = new Map<string, number[]>(), added = new Map<string, number[]>();
  document.hunks.forEach((h, index) => {
    const a = left.slice(h.fromA, h.toA), b = right.slice(h.fromB, h.toB);
    const normalized = (s: string) => s.split("\n").map(l => l.replace(/[^\S\n]/gu, "")).join("\n");
    if (a !== b && a && b && normalized(a) === normalized(b)) {
      annotate("a", left, h.fromA, h.toA, { format: true }); annotate("b", right, h.fromB, h.toB, { format: true });
    }
    for (const [text, list] of [[a, old], [b, added]] as const) {
      if (text.trim().length < 12 || text.replace(/\n$/, "").split("\n").length < 2) continue;
      const indexes = list.get(text) ?? []; indexes.push(index); list.set(text, indexes);
    }
  });
  let move = 0;
  for (const [text, indexes] of old) {
    const targets = added.get(text);
    if (indexes.length !== 1 || targets?.length !== 1 || indexes[0] === targets[0]) continue;
    const a = document.hunks[indexes[0]], b = document.hunks[targets[0]]; move++;
    annotate("a", left, a.fromA, a.toA, { move }); annotate("b", right, b.fromB, b.toB, { move });
  }
  return [...notes.values()];
}
