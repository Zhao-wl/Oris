import { computeDiff } from "./diff-core";
import type { DiffDocument } from "./types";

interface DiffRequest {
  requestId: string;
  contentIds: [string, string];
  left: string;
  right: string;
}

self.onmessage = ({ data }: MessageEvent<DiffRequest>) => {
  const started = performance.now();
  const { changes, hunks } = computeDiff(data.left, data.right);
  const document: DiffDocument = {
    requestId: data.requestId,
    contentIds: data.contentIds,
    changes,
    hunks,
    elapsedMs: performance.now() - started
  };
  self.postMessage(document);
};
