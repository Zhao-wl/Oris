import { expect, it } from "vitest";
import { parseAiAction } from "./ai-actions";

it("accepts a typed Git plan but discards model supplied authority flags", () => {
  const action = parseAiAction({ kind: "git", summary: "合并功能分支", operation: { kind: "merge", target: "refs/heads/feature", expected: "stale", noFf: true, force: true } });
  expect(action).toEqual({ kind: "git", summary: "合并功能分支", operation: { kind: "merge", target: "refs/heads/feature", noFf: true } });
  expect(() => parseAiAction({ kind: "git", operation: { kind: "toString" } })).toThrow();
  expect(() => parseAiAction({ kind: "git", operation: { kind: "stage", pathIds: ["file", 2] } })).toThrow();
});

it("accepts a scope-wide file selector as a typed operation", () => {
  expect(parseAiAction({ kind: "git", operation: { kind: "stage", pathIds: "all" } })).toMatchObject({ kind: "git", operation: { kind: "stage", pathIds: "all" } });
  expect(parseAiAction({ kind: "git", operation: { kind: "unstage", pathIds: "all" } })).toMatchObject({ kind: "git", operation: { kind: "unstage", pathIds: "all" } });
  expect(() => parseAiAction({ kind: "git", operation: { kind: "discard", pathIds: "all", scope: "unstaged" } })).toThrow();
});

it("accepts settings and view plans only from the whitelist", () => {
  expect(parseAiAction({ kind: "settings", setting: "fontSize", value: 16 })).toMatchObject({ kind: "settings", setting: "fontSize", value: 16 });
  expect(parseAiAction({ kind: "view", view: { action: "openHistory" } })).toMatchObject({ kind: "view", view: { action: "openHistory" } });
  expect(() => parseAiAction({ kind: "settings", setting: "fontSize", value: 100 })).toThrow();
  expect(() => parseAiAction({ kind: "view", view: { action: "runShell", value: "rm -rf" } })).toThrow();
});
