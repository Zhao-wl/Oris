// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReviewResults from "./ReviewResults";
import { parseReview } from "./model";
import { context } from "./fixtures";
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
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
