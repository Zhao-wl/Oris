import { Text } from "@codemirror/state";
import { Change, Chunk, diff } from "@codemirror/merge";
import type { DiffHunk } from "./types";

export function computeDiff(left: string, right: string): { changes: DiffHunk[]; hunks: DiffHunk[] } {
  const changes = diff(left, right, { scanLimit: 5000 }).map((change) => ({
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
  return { changes, hunks };
}
