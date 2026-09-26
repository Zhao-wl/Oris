import { Text } from "@codemirror/state";
import { Change, Chunk, diff } from "@codemirror/merge";
import type { DiffHunk, WhitespaceMode } from "./types";

/** 行内空白（空格、制表符等，不含换行）。 */
const INLINE_WHITESPACE = /^[^\S\n]*$/u;

/**
 * 计算阅读用的差异。`ignore` 与 `git diff -w` 一致：两侧都只是行内空白的差异（增删或替换空格、制表符）
 * 被略去；空行的增删仍然显示（涉及换行）。计数、高亮、导航都来自同一份结果（R-DIFF）。
 * 只影响显示，不改变仓库状态。
 */
export function computeDiff(left: string, right: string, whitespace: WhitespaceMode = "keep"): { changes: DiffHunk[]; hunks: DiffHunk[]; ignoredWhitespace: number } {
  let raw = diff(left, right, { scanLimit: 5000 });
  let ignoredWhitespace = 0;
  if (whitespace === "ignore") {
    raw = raw.filter((change) => {
      const ignorable = INLINE_WHITESPACE.test(left.slice(change.fromA, change.toA)) && INLINE_WHITESPACE.test(right.slice(change.fromB, change.toB));
      if (ignorable) ignoredWhitespace += 1;
      return !ignorable;
    });
  }
  const changes = raw.map((change) => ({
    fromA: change.fromA,
    toA: change.toA,
    fromB: change.fromB,
    toB: change.toB
  }));
  const asChanges = () => changes.map((change) => new Change(change.fromA, change.toA, change.fromB, change.toB));
  const hunks = Chunk.build(Text.of(left.split("\n")), Text.of(right.split("\n")), {
    override: asChanges
  }).map((chunk) => ({
    fromA: Math.min(left.length, chunk.fromA),
    toA: Math.min(left.length, chunk.toA),
    fromB: Math.min(right.length, chunk.fromB),
    toB: Math.min(right.length, chunk.toB)
  }));
  return { changes, hunks, ignoredWhitespace };
}
