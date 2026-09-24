// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FileTree, { VIRTUAL_THRESHOLD, compareFiles } from "./FileTree";
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

it("folds content-unchanged files into a collapsed section at the end of the list", async () => {
  const root = createRoot(host);
  const files = make(4);
  files[0] = { ...files[0], contentUnchanged: "eol" };
  files[2] = { ...files[2], contentUnchanged: "eol" };
  await act(async () => root.render(<FileTree files={files} selectedPathId={null} mode="flat" onSelect={() => {}} />));
  const divider = host.querySelector<HTMLButtonElement>(".fold-divider")!;
  expect(divider.getAttribute("aria-expanded")).toBe("false");
  expect(divider.textContent).toBe("▸ 2个折叠内容");
  expect([...host.querySelectorAll(".file")].map((n) => n.getAttribute("aria-label"))).toEqual([files[1].displayPath, files[3].displayPath]);
  await act(async () => divider.click());
  expect(divider.getAttribute("aria-expanded")).toBe("true");
  const folded = [...host.querySelectorAll(".unchanged-fold .file")];
  expect(folded.map((n) => n.getAttribute("aria-label"))).toEqual([files[0].displayPath, files[2].displayPath]);
  expect([...host.querySelectorAll(".line-stat.unchanged")].map((n) => n.textContent)).toEqual(["仅行尾", "仅行尾"]);
  await act(async () => divider.click());
  expect(host.querySelectorAll(".unchanged-fold .file").length).toBe(0);
  // 选中项（如恢复的阅读位置）在折叠区里也保持收起，只高亮分割线；点击仍可正常展开 / 收起。
  await act(async () => root.render(<FileTree files={files} selectedPathId={files[2].pathId} mode="tree" onSelect={() => {}} />));
  expect(divider.getAttribute("aria-expanded")).toBe("false");
  expect(divider.classList.contains("has-selection")).toBe(true);
  expect(host.querySelectorAll(".unchanged-fold .file").length).toBe(0);
  await act(async () => divider.click());
  expect(host.querySelector(".unchanged-fold .file.selected")?.getAttribute("aria-label")).toBe(files[2].displayPath);
  await act(async () => divider.click());
  expect(host.querySelectorAll(".unchanged-fold .file").length).toBe(0);
  await act(async () => root.unmount());
});

it("sorts content-unchanged files after real changes and uses one fold label for every reason", async () => {
  const files = make(3);
  files[0] = { ...files[0], contentUnchanged: "normalized" };
  files[1] = { ...files[1], contentUnchanged: "eol", status: "modified" };
  expect([...files].sort(compareFiles).map((f) => f.pathId)).toEqual(["p2", "p0", "p1"]);
  const root = createRoot(host);
  await act(async () => root.render(<FileTree files={files} selectedPathId={null} mode="flat" onSelect={() => {}} />));
  expect(host.querySelector(".fold-divider")?.textContent).toBe("▸ 2个折叠内容");
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
