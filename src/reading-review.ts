import type { CompareScope, ContentPair } from "./types";

export interface ReadingMark {
  revision: string;
  version: string;
}

export function readingMarkKey(repoId: string, scope: CompareScope, pathId: string) {
  return JSON.stringify([repoId, scope, pathId]);
}

/** A diff includes both sides and their modes. Missing sides of additions/deletions are valid. */
export function readingVersion(pair: ContentPair | null) {
  if (!pair || pair.stale || [pair.left, pair.right].some(side =>
    !side.contentId || (side.details && !["ready", "missing"].includes(side.details.state)))) return null;
  return JSON.stringify([pair.left, pair.right].map(side => [side.endpoint, side.contentId, side.details?.mode ?? null]));
}
