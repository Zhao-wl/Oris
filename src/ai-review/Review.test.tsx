// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReviewSelector from "./ReviewSelector";
import ReviewResults from "./ReviewResults";
import { parseReview } from "./model";
import { context } from "./fixtures";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const set = async (element: HTMLInputElement | HTMLSelectElement, value: string) => { await act(async () => {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}); };
it("distinguishes all four ranges and invalidates editable endpoints before refresh", async () => {
  invoke.mockImplementation(async (_, { range }) => ({ ...context.inventory, range, files: [context.sources[0].file] }));
  const change = vi.fn();
  await act(async () => root.render(<ReviewSelector repoId="repo" disabled={false} onChange={change}/>));
  expect(change.mock.calls.at(-1)![0].range).toEqual({ kind: "workspace" });
  const select = host.querySelector<HTMLSelectElement>("select")!;
  await set(select, "staged"); expect(change.mock.calls.at(-1)![0].range).toEqual({ kind: "staged" });
  await set(select, "commit"); await set(host.querySelector<HTMLInputElement>('[aria-label="审查提交"]')!, "refs/heads/topic");
  expect(change.mock.calls.at(-1)![0]).toBeUndefined();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(change.mock.calls.at(-1)![0].range).toEqual({ kind: "commit", commit: "refs/heads/topic" });
  await set(select, "branch"); expect(change.mock.calls.at(-1)![0].range).toEqual({ kind: "branch", left: "refs/heads/main", right: "HEAD" });
});
it("shows truncation and disables fabricated references while valid findings emit trusted source", async () => {
  const base = { title: "Bug", trigger: "Empty", impact: "Crash", suggestion: "Guard", evidence: "items[0]", sourceId: "source", line: 9 };
  const result = parseReview({ summary: "Summary", findings: [base, { ...base, sourceId: "fake" }], commits: [] }, context);
  const locate = vi.fn();
  await act(async () => root.render(<ReviewResults result={result} onLocate={locate}/>));
  expect(host.textContent).toContain("已截断"); expect(host.textContent).toContain("未核实");
  const buttons = host.querySelectorAll<HTMLButtonElement>("button"); expect(buttons[1].disabled).toBe(true);
  await act(async () => buttons[0].click()); expect(locate).toHaveBeenCalledWith(result, result.findings[0]);
});
it("locates each related source at its own original line", async () => {
  const related = { ...context.sources[0], id: "related", file: { ...context.sources[0].file, path: "test.ts" }, lines: [{ line: 2, text: "expect(result).toBe(4);" }] };
  const result = parseReview({ summary: "s", findings: [{ title: "Bug", trigger: "t", impact: "i", suggestion: "s", sourceId: "source", line: 9, evidence: "items[0]", references: [{ sourceId: "related", line: 2, evidence: "toBe(4)" }] }], commits: [] }, { ...context, sources: [...context.sources, related] });
  const locate = vi.fn(); await act(async () => root.render(<ReviewResults result={result} onLocate={locate}/>));
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "定位关联原文")!.click());
  expect(locate.mock.calls[0][1]).toMatchObject({ source: related, line: 2, evidence: "toBe(4)" });
});
