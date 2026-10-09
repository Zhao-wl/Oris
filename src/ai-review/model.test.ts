import { describe, expect, it } from "vitest";
import { locationMatches, parseReview } from "./model";
import { context } from "./fixtures";

const finding = { title: "空集合越界", sourceId: "source", line: 9, evidence: "items[0].name", trigger: "items 为空", impact: "抛出异常", suggestion: "检查长度" };
describe("review evidence", () => {
  it("binds verified references to trusted identity instead of model paths", () => {
    const result = parseReview({ summary: "summary", findings: [{ ...finding, pathId: "evil", side: "left", contentId: "fake" }], commits: [] }, context);
    expect(result.findings[0].source).toBe(context.sources[0]); expect(result.findings[0].invalid).toBeUndefined();
  });
  it.each([{ sourceId: "fake" }, { line: 10 }, { line: "9" }, { evidence: "not read" }, { evidence: "" }, { trigger: "" }])("rejects invalid references %j", patch => {
    const result = parseReview({ summary: "s", findings: [{ ...finding, ...patch }], commits: [] }, context);
    expect(result.findings[0].invalid).toBeTruthy(); expect(result.findings[0].source).toBeUndefined();
  });
  it("only accepts commit suggestions about changed files that were actually read", () => {
    const result = parseReview({ summary: "s", findings: [], commits: [{ title: "a", paths: ["file.ts"], reason: "r" }, { title: "b", paths: ["not-read.ts"] }] }, context);
    expect(result.commits).toHaveLength(1);
  });
  it("checks repo, path, side and content identity on navigation", () => {
    const pair = { repoId: "repo", pathId: "path", left: { contentId: "old" }, right: { contentId: "content" } };
    expect(locationMatches(context.sources[0], pair, "repo")).toBe(true);
    expect(locationMatches(context.sources[0], { ...pair, pathId: "other" }, "repo")).toBe(false);
    expect(locationMatches(context.sources[0], { ...pair, right: { contentId: "changed" } }, "repo")).toBe(false);
    expect(locationMatches(context.sources[0], pair, "different-repo")).toBe(false);
  });
  it("fails rather than treating malformed model output as a successful review", () => {
    expect(() => parseReview({ summary: "fine" }, context)).toThrow("结构化");
  });
  it("binds each related file reference and invalidates the entire issue on fabricated evidence", () => {
    const related = { ...context.sources[0], id: "test", file: { ...context.sources[0].file, path: "test.ts" }, lines: [{ line: 3, text: "expect(result).toBe(4);" }] };
    const references = [{ sourceId: "test", line: 3, evidence: "toBe(4)" }];
    const ctx = { ...context, sources: [...context.sources, related] };
    const valid = parseReview({ summary: "s", findings: [{ ...finding, references }], commits: [] }, ctx).findings[0];
    expect(valid.references?.[0].source).toBe(related); expect(valid.invalid).toBeUndefined();
    const bad = parseReview({ summary: "s", findings: [{ ...finding, references: [{ ...references[0], line: "3" }] }], commits: [] }, ctx).findings[0];
    expect(bad.invalid).toContain("关联引用"); expect(bad.source).toBeUndefined(); expect(bad.references?.[0].source).toBeUndefined();
  });
});
