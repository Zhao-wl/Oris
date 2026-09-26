import { computeDiff } from "./diff-core";
import type { DiffDocument, WhitespaceMode } from "./types";

interface DiffRequest {
  requestId: string;
  contentIds: [string, string];
  left: string;
  right: string;
  whitespace?: WhitespaceMode;
}

self.onmessage = ({ data }: MessageEvent<DiffRequest>) => {
  const started = performance.now();
  const whitespace = data.whitespace ?? "keep";
  const { changes, hunks, ignoredWhitespace } = computeDiff(data.left, data.right, whitespace);
  const document: DiffDocument = {
    requestId: data.requestId,
    contentIds: data.contentIds,
    whitespace,
    ignoredWhitespace,
    changes,
    hunks,
    elapsedMs: performance.now() - started
  };
  self.postMessage(document);
};
