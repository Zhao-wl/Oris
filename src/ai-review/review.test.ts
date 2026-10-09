import { beforeEach, expect, it, vi } from "vitest";
import { reviewAttachments } from "./review";
import { context } from "./fixtures";
import type { Attachment } from "../context-selection/model";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const attachment = (path: string, kind: "unstaged" | "staged" = "unstaged"): Attachment => ({ id: `${kind}:${path}`, kind: "files", repoId: "repo", label: path, path, source: kind,
  request: { range: { kind }, identity: "identity", pathIds: [path], contextPaths: [] } });
const original = (path: string, kind: string) => ({ ...context, truncated: false, inventory: { ...context.inventory, range: { kind }, files: [{ ...context.sources[0].file, pathId: path, path }], right: kind },
  sources: [{ ...context.sources[0], file: { ...context.sources[0].file, pathId: path, path }, contentId: `${kind}:${path}`, endpoint: kind, truncated: false,
    lines: [{ line: 1, text: path === "price.ts" ? "return n / 2;" : "expect(price(2)).toBe(4);" }] }] });
const response = (wire: any) => ({ kind: "answer", review: { summary: "联合摘要", impact: "影响", findings: wire.sources.length > 1 ? [{ title: "接口回归", trigger: "price(2)", impact: "返回 1 而非 4", suggestion: "保持调用契约", ...reference(wire.sources[0]), references: [reference(wire.sources[1])] }] : [], commits: [] } });
const reference = (source: any) => ({ sourceId: source.id, line: source.lines[0].line, evidence: source.lines[0].text });
beforeEach(() => {
  invoke.mockReset(); invoke.mockImplementation(async (cmd, args) => cmd === "review_inventory" ? { ...original("price.ts", args.range.kind).inventory, files: ["price.ts", "price.test.ts"].map(path => ({ ...context.sources[0].file, pathId: path, path })) }
    : original(args.request.pathIds[0], args.request.range.kind));
});
it("jointly transmits real numbered lines from different files and keeps each navigation identity", async () => {
  const answer = vi.fn(async wire => response(wire));
  const { result, coverage } = await reviewAttachments("repo", [attachment("price.ts"), attachment("price.test.ts", "staged")], () => true, answer, "prompt");
  expect(answer).toHaveBeenCalledTimes(1); expect(coverage).toContain("1 个含多个文件");
  const f = result!.findings[0]; expect(f.source?.file.path).toBe("price.ts"); expect(f.references?.[0].source?.file.path).toBe("price.test.ts");
  expect(f.source?.request?.range.kind).toBe("unstaged"); expect(f.references?.[0].source?.request?.range.kind).toBe("staged");
  expect(JSON.stringify(answer.mock.calls[0])).not.toContain("contentId"); expect(f.invalid).toBeUndefined();
});
it("does not discard same-path findings at different endpoint/content identities", async () => {
  const answer = vi.fn(async (wire: any) => ({ ...response(wire), review: { ...response(wire).review, findings: wire.sources.map((s: any) => ({ title: "same", trigger: "t", impact: "i", suggestion: "s", ...reference(s) })) } }));
  const { result } = await reviewAttachments("repo", [attachment("price.ts"), attachment("price.ts", "staged")], () => true, answer, "");
  expect(result?.findings).toHaveLength(2); expect(new Set(result?.context.sources.map(s => s.id)).size).toBe(2);
});
it("discards cancellation but retains verified snapshot results after later content changes", async () => {
  let active = true;
  await expect(reviewAttachments("repo", [attachment("price.ts")], () => active, async wire => { active = false; return response(wire); }, "")).rejects.toThrow("取消");
  active = true; let reads = 0;
  invoke.mockImplementation(async (cmd, args) => cmd === "review_inventory" ? original("price.ts", "unstaged").inventory : { ...original("price.ts", "unstaged"), sources: [{ ...original("price.ts", "unstaged").sources[0], contentId: ++reads > 1 ? "changed" : "original" }] });
  const changed = await reviewAttachments("repo", [attachment("price.ts")], () => true, async wire => response(wire), "");
  expect(changed.result?.context.sources[0].contentId).toBe("original");
  expect(changed.result?.context.warnings.join()).toContain("本轮结论保留");
});
it.each([null, { kind: "git", operation: { kind: "stage" } }])("refuses non-answer output %j", async output => {
  await expect(reviewAttachments("repo", [attachment("price.ts")], () => true, async () => output, "")).rejects.toThrow("只允许回答");
});
it("caps requests at the actual input window and reports cumulative exhaustion", async () => {
  const items = Array.from({ length: 12 }, (_, i) => attachment(`file${i}.ts`));
  invoke.mockImplementation(async (cmd, args) => cmd === "review_inventory" ? { ...context.inventory, files: items.map(i => ({ ...context.sources[0].file, pathId: i.path!, path: i.path! })) }
    : { ...original(args.request.pathIds[0], "unstaged"), sources: [{ ...original(args.request.pathIds[0], "unstaged").sources[0], lines: Array.from({ length: 10 }, (_, i) => ({ line: i + 1, text: "x".repeat(150) })) }] });
  const answer = vi.fn(async wire => { expect(new TextEncoder().encode(JSON.stringify(wire)).length).toBeLessThan(3500); return { kind: "answer", review: { summary: "局部", findings: [], commits: [] } }; });
  const { result, coverage } = await reviewAttachments("repo", items, () => true, answer, "", { contextWindowTokens: 6000, contextTaskTokens: 7000 });
  expect(answer.mock.calls.length).toBeGreaterThan(0); expect(result?.context.truncated).toBe(true); expect(coverage).toContain("剩余内容未审查");
  expect(result?.limitations).toContain("剩余内容未审查");
});
