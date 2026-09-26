// 块操作映射（任务 V2-05）：显示的差异块（同一个 DiffDocument）与 Rust 按 `git diff -U0` 原始字节得到的块逐一对应。
// 对应规则只用行范围：两侧起止行完全相同才可以操作；对应不上的块不显示操作按钮，并说明原因。
import { Text } from "@codemirror/state";
import type { HunkMap, HunkRef } from "./operations-api";
import type { CompareScope, ContentPair, DiffDocument } from "./types";

/** pending：块映射尚未读取（按钮照常显示，点击时先读取并核对）；unmatched：对应不上，不显示按钮。 */
export type HunkItemState = "ready" | "unmatched" | "pending";

export interface HunkItem {
  index: number;
  state: HunkItemState;
  ref?: HunkRef;
  reason?: string;
}

/** 某个字符区间覆盖的行（0 起、左闭右开）。空区间为该位置之前的行数（插入 / 删除点）。 */
export function lineRange(doc: Text, from: number, to: number): [number, number] {
  const start = doc.lineAt(Math.min(from, doc.length)).number - 1;
  if (to <= from) return [start, start];
  const endLine = doc.lineAt(Math.min(to, doc.length));
  return [start, to === endLine.from ? endLine.number - 1 : endLine.number];
}

export const UNMATCHED_REASON = "与 Git 计算的差异块对应不上（两边的对齐方式不同），请使用文件级操作";

/** 显示的每个差异块对应的 Git 块。`map` 为 null 表示尚未读取。 */
export function matchHunks(document: DiffDocument, left: string, right: string, map: HunkMap | null): HunkItem[] {
  const a = Text.of(left.split("\n"));
  const b = Text.of(right.split("\n"));
  const byRange = new Map<string, HunkRef>();
  for (const hunk of map?.hunks ?? []) byRange.set(`${hunk.oldStart}:${hunk.oldEnd}:${hunk.newStart}:${hunk.newEnd}`, hunk);
  return document.hunks.map((chunk, index) => {
    if (!map) return { index, state: "pending" };
    const [oldStart, oldEnd] = lineRange(a, chunk.fromA, chunk.toA);
    const [newStart, newEnd] = lineRange(b, chunk.fromB, chunk.toB);
    const ref = byRange.get(`${oldStart}:${oldEnd}:${newStart}:${newEnd}`);
    return ref ? { index, state: "ready", ref } : { index, state: "unmatched", reason: UNMATCHED_REASON };
  });
}

/** 整个文件不能做块操作的原因（前端可判断的部分）；返回 null 表示需要读取 Git 的块映射。 */
export function fileLevelBlock(options: { scope: CompareScope; history: boolean; whitespace: string; readable: boolean; partial: boolean; single: boolean; conflicted: boolean; pair: ContentPair | null }): string | null {
  if (options.history) return null;
  if (options.scope === "all") return "“全部”范围同时跨越暂存区与工作区，不提供块操作；请切换到“未暂存”或“已暂存”";
  if (options.conflicted) return "冲突文件不提供块操作；请在外部解决后使用“标记已解决”";
  if (!options.pair) return null;
  if (options.partial) return "只有一侧可以按文本读取，不提供块操作";
  if (!options.readable) return "二进制、编码不支持、超出内容预算或特殊条目（子模块、符号链接）不提供块操作";
  if (options.single) return "新增、删除或未跟踪的文件不提供块操作；请使用文件级操作";
  if (options.whitespace === "ignore") return "忽略空白模式下不提供块操作：显示的差异块与实际改动不一致；请切回“保留空白”";
  return null;
}

/** 块映射的缓存键：同一范围、同一两侧内容。 */
export const hunkMapKey = (repoId: string, scope: CompareScope, pair: ContentPair) => `${repoId}:${scope}:${pair.pathId}:${pair.left.contentId}:${pair.right.contentId}`;

/** 把 UTF-8 文本还原为原始字节后按单字节（Latin-1）逐字节显示；UTF-16 等无法还原的返回 null。 */
export function latin1View(side: ContentPair["left"]): string | null {
  if (side.latin1 !== undefined) return side.latin1;
  if (side.encoding === "missing") return "";
  if (side.text === null || side.encoding !== "utf-8") return null;
  const bytes = new TextEncoder().encode(side.text);
  let out = side.bom ? "ï»¿" : "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}
