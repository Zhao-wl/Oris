import { beforeEach, expect, it, vi } from "vitest";
import { explainAttachments } from "./explain";
import { context } from "../ai-review/fixtures";
import type { Attachment } from "./model";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const files = Array.from({ length: 59 }, (_, i) => ({ ...context.sources[0].file, pathId: `p${i}`, path: `Football/Player${i}.ts` }));
const attachments: Attachment[] = files.map(file => ({ id: file.pathId, repoId: "repo", kind: "files", label: file.path,
  request: { range: { kind: "unstaged" }, identity: "identity", pathIds: [file.pathId], contextPaths: [] } }));
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command, args) => command === "review_inventory" ? { ...context.inventory, files } : {
    ...context, truncated: false, sources: [{ ...context.sources[0], truncated: false, file: files.find(f => f.pathId === args.request.pathIds[0]), lines: [{ line: 9, text: `changed ${args.request.pathIds[0]}` }] }], nextOffset: null
  });
});
it("bare explain proactively sends every selected file's original text before any answer, including 59 attachments", async () => {
  const seen: string[] = [];
  const answer = vi.fn(async (wire: any) => {
    expect(wire.sources.length).toBeGreaterThan(0);
    for (const source of wire.sources) { seen.push(source.file.path); expect(source.lines[0].text).toMatch(/^changed p/); }
    return { kind: "answer", message: "改动解释" };
  });
  const result = await explainAttachments("repo", attachments, () => true, answer, "@解释");
  expect(new Set(seen)).toEqual(new Set(files.map(f => f.path)));
  expect(result.message).toContain("已遍历 59 项"); expect(result.message).toContain("附件遍历完成");
  expect(invoke.mock.calls.filter(c => c[0] === "review_context_page")).toHaveLength(118);
});
it("reads continuation text and discards answers if evidence becomes stale during inference", async () => {
  let stale = false;
  invoke.mockImplementation(async (command, args) => command === "review_inventory" ? { ...context.inventory, files } : {
    ...context, sources: [{ ...context.sources[0], file: files[0], contentId: stale ? "changed" : "content", lines: [{ line: args.offset + 1, text: args.offset ? "late change" : "early change" }] }], nextOffset: args.offset ? null : 90
  });
  const answer = vi.fn(async (wire: any) => {
    expect(wire.sources.some((s: any) => s.lines[0].text === "late change")).toBe(true);
    stale = true; return { kind: "answer", message: "不能发布" };
  });
  await expect(explainAttachments("repo", [attachments[0]], () => true, answer, "@解释")).rejects.toThrow("仓库发生变化");
});
it("reports empty and budget-limited ranges without inventing analysis, rejects cancellation and operation answers", async () => {
  const answer = vi.fn(async () => ({ kind: "answer", message: "已解释" }));
  expect((await explainAttachments("repo", [], () => true, answer, "")).message).toContain("没有可解释"); expect(answer).not.toHaveBeenCalled();
  const result = await explainAttachments("repo", attachments, () => true, answer, "", { contextWindowTokens: 4000, contextTaskTokens: 5000 });
  expect(result.message).toContain("剩余内容未解释");
  await expect(explainAttachments("repo", attachments, () => false, answer, "")).rejects.toThrow("取消");
  await expect(explainAttachments("repo", [attachments[0]], () => true, async () => ({ kind: "git", message: "write" }), "")).rejects.toThrow();
});
