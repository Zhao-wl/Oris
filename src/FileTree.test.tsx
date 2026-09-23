// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FileTree, { VIRTUAL_THRESHOLD } from "./FileTree";
import type { FileChange } from "./types";

const make = (count: number): FileChange[] => Array.from({ length: count }, (_, i) => ({
  pathId: `p${i}`, displayPath: `dir${i % 10}/file-${String(i).padStart(5, "0")}.txt`, oldPathId: null, oldDisplayPath: null,
  status: "modified", additions: null, deletions: null
}));

let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // jsdom 没有 canvas 2D 上下文；TailPath 只需要 measureText。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  host = document.createElement("div");
  host.className = "files";
  document.body.append(host);
});
afterEach(() => { host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("renders only a window of rows above the virtual threshold, in flat and tree modes", async () => {
  const root = createRoot(host);
  await act(async () => root.render(<FileTree files={make(VIRTUAL_THRESHOLD + 1500)} selectedPathId={null} mode="flat" onSelect={() => {}} />));
  const flatRows = host.querySelectorAll(".file").length;
  expect(host.querySelector("[data-virtual-count]")?.getAttribute("data-virtual-count")).toBe(String(VIRTUAL_THRESHOLD + 1500));
  expect(flatRows).toBeGreaterThan(0);
  expect(flatRows).toBeLessThan(200);
  await act(async () => root.render(<FileTree files={make(VIRTUAL_THRESHOLD + 1500)} selectedPathId={null} mode="tree" onSelect={() => {}} />));
  expect(host.querySelectorAll(".tree-row").length).toBeGreaterThan(0);
  expect(host.querySelectorAll(".file, .tree-row").length).toBeLessThan(200);
  await act(async () => root.render(<FileTree files={make(50)} selectedPathId={null} mode="flat" onSelect={() => {}} />));
  expect(host.querySelector("[data-virtual-count]")).toBeNull();
  expect(host.querySelectorAll(".file").length).toBe(50);
  await act(async () => root.unmount());
});

it("shows a placeholder, never 0, while background stats are pending", async () => {
  const root = createRoot(host);
  const files = make(2);
  files[1] = { ...files[1], additions: 3, deletions: 0 };
  await act(async () => root.render(<FileTree files={files} selectedPathId={null} mode="flat" statsPending onSelect={() => {}} />));
  const stats = [...host.querySelectorAll(".line-stat")].map((node) => node.textContent);
  expect(stats).toContain("…");
  expect(stats).toContain("+3 −0");
  expect(stats).not.toContain("+0 −0");
  await act(async () => root.render(<FileTree files={files} selectedPathId={null} mode="flat" onSelect={() => {}} />));
  expect([...host.querySelectorAll(".line-stat")].map((node) => node.textContent)).toEqual(["+3 −0"]);
  await act(async () => root.unmount());
});
