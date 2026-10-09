import { describe, expect, it } from "vitest";
import { applyFileIgnoreOperation, createFileIgnoreMatcher, filterReadableFiles, parseFileIgnoreOperation, validateFileIgnoreRules, type FileIgnoreRule } from "./file-ignore";

const rule = (pattern: string, extra: Partial<FileIgnoreRule> = {}): FileIgnoreRule => ({ id: "test", pattern, kind: "glob", repoId: null, enabled: true, caseSensitive: true, ...extra });
describe("变更文件阅读忽略规则", () => {
  it("匹配根目录和任意深度 .DS_Store，并保留其他文件", () => {
    const matches = createFileIgnoreMatcher([rule("**/.DS_Store")], "repo");
    for (const path of [".DS_Store", "config-tool/.DS_Store", "gdconfig_tools/.DS_Store", "json/.DS_Store", "a/b/.DS_Store"]) expect(matches(path)).toBe(true);
    for (const path of [".DS_Store.txt", "json/data.json", "a/.ds_store"]) expect(matches(path)).toBe(false);
  });
  it("区分精确路径、任意目录文件名与 glob，支持 Windows 路径和 Unicode", () => {
    const exact = createFileIgnoreMatcher([rule("logs/debug.log", { kind: "path" })], "r");
    expect(exact("logs\\debug.log")).toBe(true); expect(exact("a/logs/debug.log")).toBe(false);
    const name = createFileIgnoreMatcher([rule("a[1].log", { kind: "name" })], "r");
    expect(name("深层/a[1].log")).toBe(true); expect(name("a1.log")).toBe(false);
    const glob = createFileIgnoreMatcher([rule("*.log")], "r");
    expect(glob("deep/error.log")).toBe(true); expect(glob("error.log.txt")).toBe(false);
    const rooted = createFileIgnoreMatcher([rule("logs/**")], "r");
    expect(rooted("logs/a/b.log")).toBe(true); expect(rooted("a/logs/b.log")).toBe(false);
    const unicode = createFileIgnoreMatcher([rule("**/😀?.json")], "r");
    expect(unicode("目录/😀球.json")).toBe(true); expect(unicode("😀球场.json")).toBe(false);
  });
  it("全局与仓库规则叠加，停用与大小写选项明确，成员仓库互不串用", () => {
    const rules = [rule("*.log"), rule("*.tmp", { id: "local", repoId: "client", caseSensitive: false }), rule("*.json", { id: "off", enabled: false })];
    expect(createFileIgnoreMatcher(rules, "client")("a/X.TMP")).toBe(true);
    expect(createFileIgnoreMatcher(rules, "battle")("a/X.TMP")).toBe(false);
    expect(createFileIgnoreMatcher(rules, "battle")("a/file.log")).toBe(true);
    expect(createFileIgnoreMatcher(rules, "client")("a/file.json")).toBe(false);
  });
  it("搜索与临时显示叠加，不修改输入文件或状态", () => {
    const files = [{ displayPath: "json/.DS_Store", status: "untracked" }, { displayPath: "json/data.json", status: "modified" }, { displayPath: "other.ts", status: "added" }];
    const before = JSON.stringify(files), matches = createFileIgnoreMatcher([rule("**/.DS_Store")], "r");
    expect(filterReadableFiles(files, matches, "json", false)).toEqual([files[1]]);
    expect(filterReadableFiles(files, matches, "json", true)).toEqual(files.slice(0, 2));
    expect(JSON.stringify(files)).toBe(before);
  });
  it("拒绝绝对路径、上溯、无效模式、重复 ID 和过量规则", () => {
    for (const pattern of ["", "/tmp/file", "C:\\temp\\file", "../file", "a/../file", "a//b", "a/**b", "[ab]", "!a", "{a,b}", "x\n"]) expect(validateFileIgnoreRules([rule(pattern)])).toBeUndefined();
    expect(validateFileIgnoreRules([rule("a"), rule("b")])).toBeUndefined();
    expect(validateFileIgnoreRules(Array.from({ length: 257 }, (_, i) => rule("a", { id: String(i) })))).toBeUndefined();
    expect(parseFileIgnoreOperation({ action: "add", rule: rule("logs\\**") })).toMatchObject({ rule: { pattern: "logs/**" } });
  });
  it("添加、编辑、停用和删除共用原子校验，拒绝过期范围", () => {
    let rules = applyFileIgnoreOperation([], { action: "add", rule: rule("*.log", { repoId: "r" }) }, "r");
    const before = JSON.stringify(rules);
    expect(() => applyFileIgnoreOperation(rules, { action: "delete", id: "test", repoId: "r" }, "other")).toThrow(/仓库/);
    expect(() => applyFileIgnoreOperation(rules, { action: "update", rule: rule("bad/**x", { repoId: "r" }) }, "r")).toThrow(/无效/);
    expect(() => applyFileIgnoreOperation(rules, { action: "delete", id: "test", repoId: null }, "r")).toThrow(/范围/);
    expect(JSON.stringify(rules)).toBe(before);
    rules = applyFileIgnoreOperation(rules, { action: "update", rule: rule("*.tmp", { repoId: "r" }) }, "r");
    rules = applyFileIgnoreOperation(rules, { action: "setEnabled", id: "test", repoId: "r", enabled: false }, "r");
    expect(rules[0]).toMatchObject({ pattern: "*.tmp", enabled: false });
    expect(applyFileIgnoreOperation(rules, { action: "delete", id: "test", repoId: "r" }, "r")).toEqual([]);
  });
});
