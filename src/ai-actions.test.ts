import { expect, it } from "vitest";
import { aiActionCatalogue, parseAiAction } from "./ai-actions";

it("AI 忽略动作使用类型化规则，拒绝越界模式及无效动作", () => {
  const rule = { id: "ds", kind: "glob", pattern: "**/.DS_Store", repoId: "client", enabled: true, caseSensitive: true };
  const { id: _id, ...fields } = rule;
  expect(parseAiAction({ kind: "fileIgnore", operation: { action: "add", rule } })).toMatchObject({ kind: "fileIgnore", operation: { action: "add", rule: fields } });
  expect(parseAiAction({ kind: "fileIgnore", operation: { action: "delete", id: "ds", repoId: "client" } })).toMatchObject({ operation: { action: "delete", id: "ds" } });
  expect(() => parseAiAction({ kind: "fileIgnore", operation: { action: "add", rule: { ...rule, pattern: "../bad" } } })).toThrow();
  expect(() => parseAiAction({ kind: "fileIgnore", operation: { action: "setEnabled", id: "ds", repoId: "client", enabled: "false" } })).toThrow();
  expect(() => parseAiAction({ kind: "fileIgnore", operation: { action: "shell", command: "git config" } })).toThrow();
  expect(aiActionCatalogue().fileIgnore.kind).toBe("fileIgnore");
});

it("AI 新增只需模式，应用生成 ID、绑定当前仓库并补齐默认值", () => {
  const action = parseAiAction({ kind: "fileIgnore", operation: { action: "add", rule: { id: ".DS_Store", pattern: ".DS_Store" } } }, { repoId: "client", rules: [] });
  expect(action).toMatchObject({ operation: { action: "add", rule: { kind: "name", pattern: ".DS_Store", repoId: "client", enabled: true, caseSensitive: true } } });
  if (action.kind !== "fileIgnore" || action.operation.action !== "add") throw new Error("wrong action");
  expect(action.operation.rule.id).toMatch(/^[\w-]{1,80}$/);
  expect(action.operation.rule.id).not.toBe(".DS_Store");
  expect(parseAiAction(aiActionCatalogue().fileIgnore.addExample, { repoId: "client", rules: [] })).toMatchObject({ operation: { rule: { repoId: "client", kind: "name" } } });
});

it("AI 规则保留显式范围和布尔值；不接受未知范围、非法模式或类型", () => {
  const plan = (rule: object, scope?: string) => ({ kind: "fileIgnore", operation: { action: "add", scope, rule } });
  const context = { repoId: "client", rules: [] };
  expect(parseAiAction(plan({ pattern: "**/.DS_Store", enabled: false, caseSensitive: false }, "global"), context)).toMatchObject({ operation: { rule: { repoId: null, enabled: false, caseSensitive: false, kind: "glob" } } });
  for (const rule of [{ pattern: "../bad" }, { pattern: "C:/bad" }, { pattern: ".DS_Store", enabled: "true" }, { pattern: ".DS_Store", caseSensitive: null }, { pattern: ".DS_Store", kind: null }]) expect(() => parseAiAction(plan(rule), context)).toThrow();
  expect(() => parseAiAction(plan({ pattern: ".DS_Store" }, "elsewhere"), context)).toThrow(/作用范围/);
  expect(() => parseAiAction(plan({ pattern: ".DS_Store" }), { repoId: null, rules: [] })).toThrow();
  expect(() => parseAiAction(plan({ pattern: ".DS_Store", repoId: "battle" }), context)).toThrow(/目标仓库/);
});

it("AI 局部更新与启停从现有规则取范围，保留未修改的属性", () => {
  const rule = { id: "ds", kind: "name" as const, pattern: ".DS_Store", repoId: null, enabled: false, caseSensitive: false };
  const context = { repoId: "client", rules: [rule] };
  expect(parseAiAction({ kind: "fileIgnore", operation: { action: "update", rule: { id: "ds", pattern: ".cache" } } }, context)).toMatchObject({ operation: { rule: { ...rule, pattern: ".cache" } } });
  expect(parseAiAction({ kind: "fileIgnore", operation: { action: "setEnabled", id: "ds", enabled: true } }, context)).toMatchObject({ operation: { repoId: null, enabled: true } });
});

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

it("V2-D67：不接受修改 Git 可执行文件路径的设置计划，能力清单中也不列出", () => {
  expect(() => parseAiAction({ kind: "settings", setting: "gitExecutable", value: "C:/evil/git.exe" })).toThrow(/Git 可执行文件路径/);
  expect(() => parseAiAction({ kind: "settings", setting: "git.executable", value: "" })).toThrow(/Git 可执行文件路径/);
  expect(Object.keys(aiActionCatalogue().settings)).not.toContain("gitExecutable");
});
