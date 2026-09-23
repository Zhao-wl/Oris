import { expect, it } from "vitest";
import { compareFiles } from "./FileTree";
import type { FileChange } from "./types";
it("keeps existing changes and conflicts before deletes and additions, deterministically", () => {
  const statuses: FileChange["status"][] = ["untracked", "added", "deleted", "modified", "renamed", "conflicted", "typeChanged"];
  const files = statuses.map((status, i) => ({ status, displayPath: `${i}.txt` } as FileChange));
  expect(files.sort(compareFiles).map(f => f.status)).toEqual(["modified", "renamed", "conflicted", "typeChanged", "deleted", "untracked", "added"]);
});
