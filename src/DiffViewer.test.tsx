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
import { installLineSelection, lineAtNode } from "./diff-line-selection";
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

function render(file: { left: string; right: string }, document: DiffDocument, readingKey: string, hunkHeaders: HunkHeaders | null, mode: "split" | "unified" = "split", collapsed = false) {
  const ref = createRef<DiffViewerHandle>();
  act(() => root.render(
    <DiffViewer ref={ref} readingKey={readingKey} presentation={{ kind: "compare" }} left={file.left} right={file.right} document={document}
      mode={mode} highlight="words" collapsed={collapsed} wrap={false} alignChanges={false} hunkHeaders={hunkHeaders}
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

  it("切回同一文件时恢复阅读位置、块导航正常（jsdom 无真实布局）", () => {
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

describe("DiffViewer 新文件默认定位", () => {
  let frames: Map<number, FrameRequestCallback>;
  beforeEach(() => {
    frames = new Map();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  const flushFrames = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
  const mockGeometry = () => {
    // 只验证定位请求与滚动计算；这些模拟尺寸不代表真实 Windows GUI 验证。
    for (const view of editors()) {
      Object.defineProperty(view.scrollDOM, "scrollHeight", { configurable: true, value: 5000 });
      Object.defineProperty(view.scrollDOM, "clientHeight", { configurable: true, value: 300 });
      const original = view.lineBlockAt.bind(view);
      vi.spyOn(view, "lineBlockAt").mockImplementation(pos => {
        const block = original(pos);
        const top = (view.state.doc.lineAt(pos).number - 1) * 20;
        return Object.create(block, { top: { value: top }, height: { value: 20 } });
      });
      vi.spyOn(view, "lineBlockAtHeight").mockImplementation(height => {
        const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, Math.floor(height / 20) + 1)));
        return view.lineBlockAt(line.from);
      });
    }
  };
  const distant = { left: lines(200), right: lines(200, (i, l) => i === 150 || i === 180 ? `${l} // changed` : l) };
  const distantDoc = documentFor(distant.left, distant.right, "distant");

  it("首次打开及切到另一个新文件时，两侧滚到第一处差异且不改变 DOM 焦点", () => {
    const button = document.createElement("button");
    render(distant, distantDoc, "repo:distant", null);
    host.append(button);
    button.focus();
    mockGeometry();
    flushFrames();
    for (const view of editors()) expect(view.scrollDOM.scrollTop).toBe(3000 + view.documentPadding.top - 100);
    expect(document.activeElement).toBe(button);
    render(fileB, docB, "repo:b", null);
    flushFrames();
    for (const view of editors()) expect(view.scrollDOM.scrollTop).toBe(140 + view.documentPadding.top - 100);
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("统一视图请求滚到第一个差异，包含右侧无对应内容的纯删除", () => {
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    const deleted = { left: lines(200), right: lines(200).split("\n").filter((_, i) => i < 150).join("\n") + "\n" };
    const doc = documentFor(deleted.left, deleted.right, "deleted");
    render(deleted, doc, "repo:deleted", null, "unified");
    flushFrames();
    expect(scroll).toHaveBeenCalledWith(Math.min(doc.hunks[0].fromB, editors()[0].state.doc.length), { y: "center" });
  });

  it("无差异文件不发起导航", () => {
    const file = { left: lines(200), right: lines(200) };
    const doc = documentFor(file.left, file.right, "unchanged");
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    render(file, doc, "repo:unchanged", null, "unified");
    flushFrames();
    expect(scroll).not.toHaveBeenCalled();
    expect(editors()[0].scrollDOM.scrollTop).toBe(0);
  });

  it("相同文件重新渲染和切回已浏览文件都保留阅读位置", () => {
    render(distant, distantDoc, "repo:distant", null);
    mockGeometry();
    flushFrames();
    for (const view of editors()) view.scrollDOM.scrollTop = 1234;
    render(distant, distantDoc, "repo:distant", headersFor(distantDoc, "pending"));
    flushFrames();
    for (const view of editors()) expect(view.scrollDOM.scrollTop).toBe(1234);
    render(fileB, docB, "repo:b", null);
    flushFrames();
    render(distant, distantDoc, "repo:distant", null);
    flushFrames();
    for (const view of editors()) expect(view.scrollDOM.scrollTop).toBe(1234);
  });

  it("快速切换文件会取消旧文件的定位，避免影响复用的编辑器", () => {
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    render(distant, distantDoc, "repo:distant", null, "unified");
    render(fileB, docB, "repo:b", null, "unified");
    flushFrames();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith(docB.hunks[0].fromB, { y: "center" });
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


describe("行提交信息的实际阅读器行映射", () => {
  it("并排视图的选中行保留左右侧身份，只派发一次行标记更新", () => {
    const file = { left: "one\nold\nlast\n", right: "one\nnew\nlast\n" };
    render(file, documentFor(file.left, file.right, "line"), "line", null);
    const [a, b] = editors();
    const callback = vi.fn();
    const remove = installLineSelection([{ view: a, side: "left" }, { view: b, side: "right" }], callback);
    const dispatch = vi.spyOn(b, "dispatch");
    const rightRow = b.contentDOM.querySelectorAll(".cm-line")[1];
    act(() => rightRow.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 })));
    expect(callback).toHaveBeenLastCalledWith({ side: "b", line: 2 });
    expect(lineAtNode({ view: a, side: "left" }, a.contentDOM.querySelectorAll(".cm-line")[1])).toEqual({ side: "a", line: 2 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(b.contentDOM.querySelectorAll(".cm-line")[1].classList.contains("line-history-selected")).toBe(true);
    act(() => b.contentDOM.querySelectorAll(".cm-line")[1].dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 })));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(b.contentDOM.querySelectorAll(".cm-line")[1].classList.contains("line-history-selected")).toBe(true);
    const range = document.createRange();
    const startRow = a.contentDOM.querySelectorAll(".cm-line")[0];
    const endRow = a.contentDOM.querySelectorAll(".cm-line")[2];
    range.setStart(startRow, 0);
    range.setEnd(endRow, endRow.childNodes.length);
    act(() => { const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
    expect(callback).toHaveBeenLastCalledWith({ side: "a", line: 3 });
    expect(b.contentDOM.querySelectorAll(".cm-line")[1].classList.contains("line-history-selected")).toBe(false);
    remove();
  });
  it("统一视图中被删除的多行映射回旧版本行号", () => {
    const file = { left: "same\nold one\nold two\nlast\n", right: "same\nnew\nlast\n" };
    render(file, documentFor(file.left, file.right, "deleted"), "deleted", null, "unified");
    const [view] = editors();
    const deleted = [...view.contentDOM.querySelectorAll(".cm-deletedChunk div.cm-deletedLine")];
    expect(deleted.length).toBeGreaterThanOrEqual(2);
    expect(lineAtNode({ view, side: "unified" }, deleted[1])).toEqual({ side: "a", line: 3 });
  });
  it("统一视图同行删除片段仍归属旧版本", () => {
    const file = { left: "one\nreturn old();\nlast\n", right: "one\nreturn new();\nlast\n" };
    render(file, documentFor(file.left, file.right, "inline"), "inline", null, "unified");
    const [view] = editors();
    const deletion = view.contentDOM.querySelector("del.cm-deletedText")!;
    expect(deletion).toBeTruthy();
    expect(lineAtNode({ view, side: "unified" }, deletion)).toEqual({ side: "a", line: 2 });
  });
});

describe("独立行跳转", () => {
  const open = () => {
    const event = new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => document.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    return document.querySelector<HTMLFormElement>(".oris-goto-panel")!;
  };
  const jump = (panel: HTMLFormElement, value: string) => act(() => {
    panel.querySelector<HTMLInputElement>("input")!.value = value;
    panel.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  it("Ctrl+G 阻止默认查找，仅跳转目标行；Ctrl+F 内容搜索保持独立", () => {
    render(fileA, docA, "goto", null);
    const panel = open();
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).not.toMatch(/搜索|查找|下一|上一/);
    expect(host.querySelector<HTMLDivElement>(".oris-search-panel")!.hidden).toBe(true);
    jump(panel, "30");
    expect(editors()[1].state.selection.main.head).toBe(editors()[1].state.doc.line(30).from);
    expect(panel.hidden).toBe(true);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(host.querySelector<HTMLDivElement>(".oris-search-panel")!.hidden).toBe(false);
    open(); expect(host.querySelector<HTMLDivElement>(".oris-search-panel")!.hidden).toBe(true);
  });
  it("按当前左侧定位，拒绝越界和非整数，Esc 只关闭面板", () => {
    render(fileA, docA, "goto-left", null);
    const a = editors()[0];
    act(() => a.contentDOM.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    const panel = open();
    for (const value of ["0", "99999", "30.5", "text"]) { jump(panel, value); expect(panel.hidden).toBe(false); expect(panel.textContent).toContain("请输入"); expect(a.state.selection.main.head).toBe(0); }
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(panel.hidden).toBe(true);
    open(); jump(panel, "20"); expect(a.state.selection.main.head).toBe(a.state.doc.line(20).from);
  });
  it("展开目标所在的并排折叠区段，并支持统一视图", () => {
    const file = { left: lines(200), right: lines(200, (i, l) => i === 100 ? `${l} changed` : l) };
    const doc = documentFor(file.left, file.right, "goto-folded");
    render(file, doc, "folded", null, "split", true);
    expect(Number(host.querySelector<HTMLElement>("[data-collapsed-regions]")!.dataset.collapsedRegions)).toBeGreaterThan(1);
    jump(open(), "20");
    expect(host.querySelector<HTMLElement>("[data-expanded-regions]")!.dataset.expandedRegions).toBe("1");
    render(file, doc, "folded-unified", null, "unified", true);
    const collapsedCount = host.querySelectorAll(".cm-collapsedLines").length;
    expect(collapsedCount).toBeGreaterThan(0);
    jump(open(), "30");
    expect(host.querySelectorAll(".cm-collapsedLines").length).toBeLessThan(collapsedCount);
    expect(editors()[0].state.selection.main.head).toBe(editors()[0].state.doc.line(30).from);
  });
});

it("追溯跨阅读器重建后恢复行锚点与水平位置，定位不触发 focus", () => {
  const ref = render(fileA, docA, "repo:source", null);
  const sourceViews = editors();
  sourceViews.forEach(view => {
    vi.spyOn(view, "lineBlockAtHeight").mockReturnValue({ from: view.state.doc.line(4).from, top: 40 } as ReturnType<EditorView["lineBlockAtHeight"]>);
    view.scrollDOM.scrollTop = 47; view.scrollDOM.scrollLeft = 11;
  });
  const anchors = ref.current!.captureViewport();
  expect(anchors).toEqual([{ line: 4, offset: 7, left: 11 }, { line: 4, offset: 7, left: 11 }]);
  act(() => root.unmount()); root = createRoot(host);
  const next = render(fileA, docA, "repo:source", null);
  const views = editors(); const focus = views.map(view => vi.spyOn(view, "focus"));
  views.forEach(view => vi.spyOn(view, "requestMeasure").mockImplementation(request => {
    if (request) { const result = request.read(view); request.write?.(result, view); }
  }));
  act(() => next.current!.restoreViewport(anchors));
  views.forEach(view => { expect(view.scrollDOM.scrollTop).toBe(view.lineBlockAt(view.state.doc.line(4).from).top + 7); expect(view.scrollDOM.scrollLeft).toBe(11); });
  act(() => next.current!.revealLine({ side: "b", line: 9 }));
  focus.forEach(spy => expect(spy).not.toHaveBeenCalled());
});
