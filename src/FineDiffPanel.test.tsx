// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FineDiffPanel from "./FineDiffPanel";
import type { ContentPair } from "./types";
import type { HunkMap, LinePreview } from "./operations-api";
const bridge = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("./operations-api", () => ({ previewLines: bridge.preview }));
const pair: ContentPair = { repoId: "repo", pathId: "path", revision: "r1", requestId: "c", displayPath: "f", stale: false, degradation: null,
  left: { endpoint: "index", contentId: "a", text: "old\n", encoding: "utf-8", bom: false, byteLength: 4, kind: "text", eol: "lf", hasFinalNewline: true },
  right: { endpoint: "workingTree", contentId: "b", text: "new\n", encoding: "utf-8", bom: false, byteLength: 4, kind: "text", eol: "lf", hasFinalNewline: true } };
const map: HunkMap = { scope: "unstaged", pathId: "path", contentIds: ["a", "b"], blocked: null, note: null, hunks: [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1, digest: "h" }] };
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); bridge.preview.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = async (text: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === text)!.click()); };
it("正在预览时选区改变，迟到的补丁不会变成可确认请求", async () => {
  let resolve!: (value: LinePreview) => void;
  bridge.preview.mockReturnValue(new Promise<LinePreview>(r => { resolve = r; }));
  const onRun = vi.fn(), onSelect = vi.fn(), onClose = vi.fn();
  const render = async (selected: { side: "a" | "b"; line: number }[]) => act(async () => root.render(<FineDiffPanel pair={pair} scope="unstaged" texts={["old\n", "new\n"]} map={map} selected={selected} onSelect={onSelect} blocked={null} onRun={onRun} onClose={onClose}/>));
  await render([{ side: "b", line: 1 }]); await click("预览暂存选区");
  await render([{ side: "a", line: 1 }]);
  await act(async () => resolve({ digest: "stale", patch: "stale", removed: 0, added: 1, note: "old" }));
  expect(host.querySelector('pre')).toBeNull(); expect(onRun).not.toHaveBeenCalled();
});
it("100,000 行块只渲染 200 组，可翻页选择后续行", async () => {
  const largeMap = { ...map, hunks: [{ ...map.hunks[0], oldEnd: 100_000, newEnd: 100_000 }] };
  await act(async () => root.render(<FineDiffPanel pair={pair} scope="unstaged" texts={["old\n", "new\n"]} map={largeMap} selected={[]} onSelect={vi.fn()} blocked={null} onRun={vi.fn()} onClose={vi.fn()}/>));
  expect(host.querySelectorAll('.fine-diff-unit')).toHaveLength(200);
  await click("下一页行组");
  expect(host.querySelector('input[aria-label="旧行 201"]')).not.toBeNull();
  expect(host.querySelectorAll('.fine-diff-unit')).toHaveLength(200);
});
