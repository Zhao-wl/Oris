import type { ReviewContext } from "./model";
export const context: ReviewContext = {
  inventory: { repoId: "repo", range: { kind: "staged" }, identity: "identity", revision: "rev", left: "base", right: "index", files: [], totalFiles: 1 },
  sources: [{ id: "source", file: { path: "file.ts", pathId: "path", oldPath: null, oldPathId: null, status: "modified" }, side: "right", endpoint: "index", contentId: "content",
    lines: [{ line: 9, text: "return items[0].name;" }], truncated: true, supplemental: false }], diff: "actual diff", budget: 40000, used: 20, truncated: true, warnings: []
};
