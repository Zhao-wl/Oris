// @vitest-environment jsdom
// lc5 阶段 3：已缓存文件切换时，差异装饰随编辑器状态一起创建，切换过程中左侧不派发事务、右侧只派发一次块标题行
// （每次派发都会让 CodeMirror 读取 DOM 选区并强制同步布局）。jsdom 没有布局，只核对状态与派发次数。
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";
import { Change } from "@codemirror/merge";
import DiffViewer, { buildSideDecorations, type DiffViewerHandle, type HunkHeaders } from "./DiffViewer";
import { computeDiff } from "./diff-core";
import type { DiffDocument } from "./types";

const lines = (count: number, edit: (index: number, line: string) => string = (_, line) => line) =>
  Array.from({ length: count }, (_, i) => edit(i, `const item${i} = load(${i});`)).join("\n") + "\n";

function documentFor(left: string, right: string, id: string): DiffDocument {
  const { changes, hunks } = computeDiff(left, right);
  return { requestId: id, contentIds: [`${id}-a`, `${id}-b`], changes, hunks, elapsedMs: 0 };
}

const fileA = { left: lines(80), right: lines(80, (i, l) => (i % 10 === 3 ? `${l} // a` : l)) };
const fileB = { left: lines(60), right: lines(60, (i, l) => (i % 15 === 7 ? `${l} // b` : l)) };
const docA = documentFor(fileA.left, fileA.right, "a");
const docB = documentFor(fileB.left, fileB.right, "b");

function headersFor(document: DiffDocument, state: "pending" | "ready"): HunkHeaders {
  return {
    items: document.hunks.map((_, index) => ({ index, state })),
    actions: [{ action: "stage", label: "暂存此块" }],
    disabledReason: null,
    onAction: vi.fn(),
    onIntent: vi.fn()
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // jsdom 的 Range 没有布局接口；CodeMirror 测量时会调用。
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(file: { left: string; right: string }, document: DiffDocument, readingKey: string, hunkHeaders: HunkHeaders | null) {
  const ref = createRef<DiffViewerHandle>();
  act(() => root.render(
    <DiffViewer ref={ref} readingKey={readingKey} presentation={{ kind: "compare" }} left={file.left} right={file.right} document={document}
      mode="split" highlight="words" collapsed={false} wrap={false} alignChanges={false} hunkHeaders={hunkHeaders}
      onPositionChange={onPositionChange} onSplitLayoutChange={onSplitLayoutChange} />
  ));
  return ref;
}
const onPositionChange = () => {};
const onSplitLayoutChange = () => {};
const editors = () => [...host.querySelectorAll<HTMLElement>(".cm-editor")].map((dom) => EditorView.findFromDOM(dom)!);

describe("DiffViewer 已缓存文件切换", () => {
  it("切到另一个文件时装饰随状态创建：左侧不派发事务，右侧只派发一次块标题行", () => {
    render(fileA, docA, "repo:unstaged:a", headersFor(docA, "pending"));
    const [left, right] = editors();
    expect(right.state.doc.toString()).toBe(fileA.right);
    // CodeMirror 在构造时把 dispatch 绑定为实例属性：监视两个复用的实例本身
    const dispatchLeft = vi.spyOn(left, "dispatch");
    const dispatchRight = vi.spyOn(right, "dispatch");
    render(fileB, docB, "repo:unstaged:b", headersFor(docB, "pending"));
    // 编辑器实例复用（技术方案 §5.7），只换状态
    expect(editors()).toEqual([left, right]);
    expect(right.state.doc.toString()).toBe(fileB.right);
    expect(dispatchLeft).not.toHaveBeenCalled();
    expect(dispatchRight).toHaveBeenCalledTimes(1);
    // 修改行装饰已在状态中，块标题行已派发
    const modified = [...host.querySelectorAll(".oris-split-pane.right .cm-line.oris-modified-line")].map((n) => n.textContent);
    expect(modified).toContain(fileB.right.split("\n")[7]);
    // jsdom 中只渲染视口内的行：已渲染的块标题行都属于新文件（块总数为新文件的块数）
    const titles = [...host.querySelectorAll(".oris-split-pane.right .hunk-title")];
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((n) => n.classList.contains("pending") && n.textContent!.includes(`/ ${docB.hunks.length}`))).toBe(true);
    expect(host.querySelectorAll(".oris-split-pane.left .hunk-title").length).toBe(0);
    expect(host.querySelectorAll(".oris-split-pane.left .cm-line.oris-modified-line").length).toBeGreaterThan(0);
  });

  it("块标题行变化（块映射读取完成）时仍然更新右侧编辑器", () => {
    render(fileB, docB, "repo:unstaged:b", headersFor(docB, "pending"));
    expect(host.querySelectorAll(".hunk-title.ready").length).toBe(0);
    render(fileB, docB, "repo:unstaged:b", headersFor(docB, "ready"));
    const titles = [...host.querySelectorAll(".oris-split-pane.right .hunk-title")];
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((n) => n.classList.contains("ready"))).toBe(true);
    // 去掉标题行（例如切到“全部”范围）
    render(fileB, docB, "repo:unstaged:b", null);
    expect(host.querySelectorAll(".hunk-title").length).toBe(0);
  });

  it("切回同一文件时编辑器滚动从顶部开始、块导航正常", () => {
    render(fileA, docA, "repo:unstaged:a", null);
    render(fileB, docB, "repo:unstaged:b", null);
    const ref = render(fileA, docA, "repo:unstaged:a", null);
    for (const view of editors()) expect(view.scrollDOM.scrollTop).toBe(0);
    act(() => ref.current!.navigate(1));
    expect(editors()[1].state.selection.main.head).toBe(docA.hunks[1].fromB);
  });

  it("反复切换文件时文档样式表不增长（固定主题只创建一次）", () => {
    const ruleCount = () => {
      let rules = 0;
      for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) { try { rules += sheet.cssRules.length; } catch { /* 跨域样式表 */ } }
      return rules;
    };
    render(fileA, docA, "repo:unstaged:a", null);
    render(fileB, docB, "repo:unstaged:b", null);
    const before = ruleCount();
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      render(fileA, docA, "repo:unstaged:a", null);
      render(fileB, docB, "repo:unstaged:b", null);
    }
    expect(ruleCount()).toBe(before);
  });

  it("概览轨道：标记整层重建、点击由标记层委托，跳到对应的块；切换文件后指向新文件的块", async () => {
    // jsdom 没有布局：给轨道一个高度，每块才有各自的标记
    const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get() { return (this as Element).classList.contains("diff-overview-rail") ? 600 : 0; } });
    try {
      const frame = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      render(fileA, docA, "repo:unstaged:a", null);
      await frame();
      const rightMarkers = () => [...host.querySelectorAll<HTMLElement>(".diff-overview-rail.right .diff-overview-marker-list > .diff-overview-marker")];
      expect(rightMarkers().length).toBe(docA.hunks.length);
      // 视口框仍在外层，不在标记层内
      expect(host.querySelector(".diff-overview-rail.right .diff-overview-markers > .diff-overview-viewport")).not.toBeNull();
      act(() => rightMarkers()[3].click());
      expect(editors()[1].state.selection.main.head).toBe(docA.hunks[3].fromB);
      render(fileB, docB, "repo:unstaged:b", null);
      await frame();
      expect(rightMarkers().length).toBe(docB.hunks.length);
      act(() => rightMarkers()[2].click());
      expect(editors()[1].state.selection.main.head).toBe(docB.hunks[2].fromB);
    } finally {
      Object.defineProperty(Element.prototype, "clientHeight", clientHeight);
    }
  });
});

describe("buildSideDecorations", () => {
  it("按 Text 计算两侧的修改行与词级范围，CRLF 与 LF 的行号一致", () => {
    const left = "a\r\nb\r\nc\r\n";
    const right = "a\r\nB\r\nc\r\n";
    const chunk = new Change(3, 5, 3, 5);
    const toText = (value: string) => Text.of(value.split(/\r\n?|\n/));
    const decorations = (value: string, side: "a" | "b") => {
      const set = buildSideDecorations(toText(value), [chunk], [{ fromA: 3, toA: 4, fromB: 3, toB: 4 }], side, "words");
      const found: { from: number; to: number; cls: string }[] = [];
      set.between(0, 100, (from, to, deco) => { found.push({ from, to, cls: String(deco.spec.class ?? deco.spec.attributes?.class ?? "") }); });
      return found;
    };
    // CRLF 在 Text 中按一个换行计：第 2 行从位置 2 开始
    expect(decorations(left.replace(/\r\n/g, "\n"), "a")).toEqual(decorations(left, "a"));
    expect(decorations(right, "b").map((d) => d.cls)).toEqual(expect.arrayContaining(["oris-modified-line", "oris-changed-text"]));
  });
});
