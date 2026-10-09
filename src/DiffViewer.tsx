import { useEffect, useImperativeHandle, useLayoutEffect, useRef, forwardRef, type CSSProperties } from "react";
import { EditorState, StateEffect, StateField, Text, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { Change, getChunks, uncollapseUnchanged, unifiedMergeView } from "@codemirror/merge";
import { oneDark } from "@codemirror/theme-one-dark";
import { appearanceExtensions, createAppearanceCompartments, reconfigureAppearance, type AppearanceCompartments, type Scheme } from "./themes/runtime";
import { chainedWheelDelta, contextAnchor, diffMarkerGeometry, fontChangeScroll, mapDiffPosition, railViewportStartLine, type DiffBoundaryPair, type DiffSide } from "./diff-scroll";
import type { DiffPresentation } from "./diff-presentation";
import { activeScheme, settings } from "./appearance";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { collectQueryMatches, createReadingQuery, type ReadingSearchOptions, type TextMatch } from "./search-model";
import type { DiffDocument } from "./types";
import type { HunkItem } from "./hunk-model";
import { highlightLineSelection, installLineSelection, lineSelectionMarker, type DiffLineSelection } from "./diff-line-selection";
import { installGoToLine } from "./go-to-line";

const DIFF_SEPARATOR_WIDTH = 56;
const DIFF_RAIL_WIDTH = 24;
const DIFF_PANE_MIN_WIDTH = 180;

type AlignmentTone = "neutral" | "modified" | "inserted" | "deleted";

interface AlignmentSpacerSpec {
  pos: number;
  height: number;
  side: number;
  tone: AlignmentTone;
  /** prefix / body：对齐块的上边与下边；anchor：视口顶部所在上下文中的锚定间隔（chunkIndex 为上下文区域序号，见 findAnchor）。 */
  role: "prefix" | "body" | "anchor";
  chunkIndex: number;
}

interface SplitView {
  dom: HTMLElement;
  editorRoot: HTMLElement;
  paneA: HTMLElement;
  paneB: HTMLElement;
  a: EditorView;
  b: EditorView;
  chunks: Change[];
  rails: { a: HTMLElement; b: HTMLElement };
  boundaries: DiffBoundaryPair[];
}

interface SplitController {
  view: SplitView;
  navigate(index: number, focus?: boolean): void;
  settleViewport(onComplete: () => void): void;
  /** 外观（字号、配色）reconfigure 后重新测量对齐、连接带与轨道。 */
  refreshLayout(): void;
  /** 展开全部折叠的未变化内容；返回本次展开的区段数。 */
  expandAll(): number;
  revealLine(side: DiffSide, line: number): void;
  /** keepViews 为 true 时只拆除控制器与外层 DOM，EditorView 留给下一个文件复用。 */
  destroy(keepViews?: boolean): void;
}

interface SingleController {
  view: EditorView;
  chunks: Change[];
  navigate(index: number, focus?: boolean): void;
  destroy(keepViews?: boolean): void;
}

/** 可复用的编辑器实例（技术方案 §5.7：切换文件时只替换文档与装饰，不重建编辑器）。 */
interface EditorPool {
  a?: EditorView;
  b?: EditorView;
  single?: EditorView;
  unified?: EditorView;
}

/**
 * 阅读器的固定主题只创建一次（lc5）：EditorView.theme 每次调用都会生成新的作用域类名，并向文档样式表追加一组规则。
 * 原先写在切换文件时重跑的 effect 里，每切换一次文件样式表就多 3 条规则、永不回收，长时间使用后每次样式重算都越来越慢。
 */
const DIFF_EDITOR_THEME = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { fontFamily: "JetBrains Mono, Cascadia Code, SFMono-Regular, Consolas, monospace" },
  ".cm-content": { caretColor: "transparent" }
});

/** 与 EditorState 默认的换行规则相同（`\r\n`、`\r`、`\n`），先得到 Text 以便在建状态之前算好装饰。 */
function textOf(value: string) {
  return Text.of(value.split(/\r\n?|\n/));
}

/** 复用已有 EditorView：挂到新的容器并以新文档与扩展替换状态；没有可复用实例时新建。 */
function reuseOrCreate(existing: EditorView | undefined, parent: HTMLElement, doc: string | Text, extensions: Extension[]) {
  if (!existing) return new EditorView({ parent, doc, extensions });
  // 复用的编辑器此时已从页面摘下（上一个控制器 destroy(true)）。摘下的滚动容器没有布局框，挂回后 scrollTop / scrollLeft
  // 本来就是 0（WebView2 中实测）；原先换入文档后再写 0 不改变结果，却会在刚换入的大文档上强制一次同步样式与布局，因此不再写。
  parent.append(existing.dom);
  existing.setState(EditorState.create({ doc, extensions }));
  remeasureWhenVisible(existing);
  return existing;
}

const reattachObservers = new WeakMap<EditorView, IntersectionObserver>();

/**
 * 摘下 DOM 期间 CodeMirror 内部的 IntersectionObserver 记为不可见；重新挂载后在它异步回报
 * 可见之前，scroll 事件不会触发测量。恢复阅读位置、左右同步写入的 scrollTop 恰好落在这段
 * 时间里，视口停留在旧范围，出现大片空白直到下一次滚动。可见后补一次测量。
 */
function remeasureWhenVisible(view: EditorView) {
  reattachObservers.get(view)?.disconnect();
  if (typeof IntersectionObserver !== "function") return;
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.intersectionRatio > 0)) return;
    observer.disconnect();
    reattachObservers.delete(view);
    view.requestMeasure();
  }, { threshold: [0, 0.001] });
  reattachObservers.set(view, observer);
  observer.observe(view.dom);
}

const alignmentLayouts = new WeakMap<SplitView, { a: AlignmentSpacerSpec[]; b: AlignmentSpacerSpec[] }>();
/** 对齐锚点与视口顶部的距离（px），见 installChangeAlignment 的 findAnchor。 */
const ANCHOR_MARGIN = 300;

class AlignmentSpacer extends WidgetType {
  constructor(
    readonly height: number,
    readonly tone: AlignmentTone,
    readonly role: AlignmentSpacerSpec["role"],
    readonly chunkIndex: number,
    readonly pos: number
  ) {
    super();
  }

  eq(other: AlignmentSpacer) {
    return Math.abs(this.height - other.height) <= 0.05 && this.tone === other.tone &&
      this.role === other.role && this.chunkIndex === other.chunkIndex && this.pos === other.pos;
  }

  toDOM() {
    const element = document.createElement("div");
    element.className = `oris-alignment-spacer ${this.tone}`;
    element.style.height = `${this.height}px`;
    element.dataset.alignmentHeight = String(this.height);
    element.dataset.alignmentRole = this.role;
    element.dataset.chunkIndex = String(this.chunkIndex);
    element.dataset.documentPosition = String(this.pos);
    return element;
  }

  get estimatedHeight() {
    return this.height;
  }

  ignoreEvent() {
    return true;
  }
}

class CollapsedLinesWidget extends WidgetType {
  constructor(readonly regionId: number, readonly lineCount: number, readonly expand: (regionId: number) => void) {
    super();
  }

  eq(other: CollapsedLinesWidget) {
    return this.regionId === other.regionId && this.lineCount === other.lineCount;
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-collapsedLines";
    button.textContent = `展开 ${this.lineCount} 行未变化内容`;
    button.setAttribute("aria-label", button.textContent);
    button.addEventListener("click", () => this.expand(this.regionId));
    return button;
  }

  ignoreEvent() {
    return false;
  }
}

/** 块操作（V2-05）：显示在差异块上方的块标题行，操作用完整文字；中央连接带保持纯阅读语义。 */
export interface HunkHeaderAction {
  action: "stage" | "unstage" | "discard";
  label: string;
  danger?: boolean;
}
export interface HunkHeaders {
  items: HunkItem[];
  actions: HunkHeaderAction[];
  /** 写操作进行中、校验中等：按钮不可用并以 title 说明。 */
  disabledReason: string | null;
  onAction(index: number, action: HunkHeaderAction["action"]): void;
  /** 指针移入或键盘聚焦 diff：按需读取块映射（浏览时不启动 Git 进程）。 */
  onIntent(): void;
}

class HunkHeaderWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly total: number,
    readonly item: HunkItem,
    readonly actions: HunkHeaderAction[],
    readonly disabledReason: string | null,
    readonly run: (index: number, action: HunkHeaderAction["action"]) => void
  ) {
    super();
  }

  eq(other: HunkHeaderWidget) {
    return other.index === this.index && other.total === this.total && other.item.state === this.item.state && other.item.reason === this.item.reason &&
      other.item.ref?.digest === this.item.ref?.digest && other.disabledReason === this.disabledReason && other.actions.map((a) => a.action).join() === this.actions.map((a) => a.action).join();
  }

  toDOM() {
    const row = document.createElement("div");
    row.className = `hunk-title ${this.item.state}`;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `第 ${this.index + 1} / ${this.total} 个差异块`);
    row.dataset.hunkIndex = String(this.index);
    const label = document.createElement("span");
    label.className = "hunk-label";
    label.textContent = `第 ${this.index + 1} / ${this.total} 块`;
    row.append(label);
    if (this.item.state !== "unmatched") {
      const actions = document.createElement("span");
      actions.className = "hunk-actions";
      for (const entry of this.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = entry.danger ? "danger" : "";
        button.textContent = entry.label;
        button.dataset.action = entry.action;
        button.disabled = !!this.disabledReason;
        if (this.disabledReason) button.title = this.disabledReason;
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => this.run(this.index, entry.action));
        actions.append(button);
      }
      row.append(actions);
    } else {
      const note = document.createElement("span");
      note.className = "hunk-note";
      note.textContent = this.item.reason ?? "";
      row.append(note);
    }
    return row;
  }

  get estimatedHeight() {
    return 24;
  }

  ignoreEvent() {
    return true;
  }
}

/** 行号栏宽度写入 --oris-gutter-width：块标签横向滚动时贴在行号栏右侧（行号栏本身 sticky 且盖在内容上方）。 */
const gutterWidthVar = ViewPlugin.fromClass(class {
  width = -1;
  constructor(readonly view: EditorView) {
    this.measure();
  }
  update(update: ViewUpdate) {
    if (update.geometryChanged) this.measure();
  }
  measure() {
    this.view.requestMeasure({
      key: this,
      read: (view) => view.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0,
      write: (width, view) => {
        if (width === this.width) return;
        this.width = width;
        view.dom.style.setProperty("--oris-gutter-width", `${width}px`);
      }
    });
  }
});

const setHunkHeaders = StateEffect.define<DecorationSet>();
const hunkHeaderField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(headers, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHunkHeaders)) return effect.value;
    }
    return headers.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

/** 块标题行（V2-05）：放在右侧（并排）或统一视图编辑器中每个差异块的起点之前。 */
function hunkHeaderDecorations(doc: Text, chunks: readonly Change[], headers: HunkHeaders | null, run: (index: number, action: HunkHeaderAction["action"]) => void) {
  if (!headers) return Decoration.none;
  const ranges = chunks.flatMap((chunk, index) => {
    const item = headers.items[index];
    if (!item) return [];
    const pos = Math.min(chunk.fromB, doc.length);
    return [Decoration.widget({ widget: new HunkHeaderWidget(index, chunks.length, item, headers.actions, headers.disabledReason, run), block: true, side: -1 }).range(doc.lineAt(pos).from)];
  });
  return Decoration.set(ranges, true);
}

const setAlignmentSpacers = StateEffect.define<DecorationSet>();
const alignmentSpacers = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(spacers, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setAlignmentSpacers)) return effect.value;
    }
    return spacers.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

const setCollapsedRanges = StateEffect.define<DecorationSet>();
const collapsedRanges = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(ranges, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCollapsedRanges)) return effect.value;
    }
    return ranges.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

const setSearchHighlights = StateEffect.define<DecorationSet>();
const searchHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSearchHighlights)) return effect.value;
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

const setSelectionHighlights = StateEffect.define<DecorationSet>();
const selectionHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSelectionHighlights)) return effect.value;
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

function alignmentTone(chunk: Change): Exclude<AlignmentTone, "neutral"> {
  if (chunk.fromA === chunk.toA) return "inserted";
  if (chunk.fromB === chunk.toB) return "deleted";
  return "modified";
}

function sideTone(chunk: Change, side: DiffSide): Exclude<AlignmentTone, "neutral"> {
  if (side === "a" && chunk.fromB === chunk.toB) return "deleted";
  if (side === "b" && chunk.fromA === chunk.toA) return "inserted";
  return "modified";
}

function boundaryY(view: EditorView, pos: number) {
  const safe = Math.max(0, Math.min(pos, view.state.doc.length));
  if (view.state.doc.length === 0) return view.documentPadding.top;
  const block = view.lineBlockAt(safe);
  return view.documentPadding.top + (safe === view.state.doc.length ? block.bottom : block.top);
}

function lineBoundary(doc: Text, pos: number) {
  const safe = Math.max(0, Math.min(pos, doc.length));
  return safe === doc.length ? doc.lines : doc.lineAt(safe).number - 1;
}

function specsEqual(left: AlignmentSpacerSpec[], right: AlignmentSpacerSpec[]) {
  return left.length === right.length && left.every((spec, index) => {
    const other = right[index];
    return spec.pos === other.pos && spec.side === other.side && spec.tone === other.tone &&
      spec.role === other.role && spec.chunkIndex === other.chunkIndex &&
      Math.abs(spec.height - other.height) <= 0.05;
  });
}

function spacerDecorations(specs: AlignmentSpacerSpec[]) {
  return Decoration.set(specs.map((spec) => Decoration.widget({
    widget: new AlignmentSpacer(spec.height, spec.tone, spec.role, spec.chunkIndex, spec.pos),
    block: true,
    side: spec.side
  }).range(spec.pos)), true);
}

/** 间隔规格按位置与“块:角色”建立的索引。规格数组每次调整都整体替换，按数组缓存；块数多时避免每次查询都线性扫描（V2-D75 后块数可达上千）。 */
const specIndexes = new WeakMap<readonly AlignmentSpacerSpec[], { byPos: Map<number, AlignmentSpacerSpec[]>; byRole: Map<string, number> }>();
function specIndex(specs: readonly AlignmentSpacerSpec[]) {
  let index = specIndexes.get(specs);
  if (!index) {
    index = { byPos: new Map(), byRole: new Map() };
    for (const spec of specs) {
      const atPos = index.byPos.get(spec.pos);
      if (atPos) atPos.push(spec);
      else index.byPos.set(spec.pos, [spec]);
      const key = `${spec.chunkIndex}:${spec.role}`;
      if (!index.byRole.has(key)) index.byRole.set(key, spec.height);
    }
    specIndexes.set(specs, index);
  }
  return index;
}

const NO_SPECS: readonly AlignmentSpacerSpec[] = Object.freeze([]);

function specHeight(specs: readonly AlignmentSpacerSpec[], chunkIndex: number, role: AlignmentSpacerSpec["role"]) {
  return specIndex(specs).byRole.get(`${chunkIndex}:${role}`) ?? 0;
}

function alignedBoundary(
  split: SplitView,
  side: DiffSide,
  pos: number,
  chunkIndex: number,
  edge: "top" | "bottom"
) {
  const view = side === "a" ? split.a : split.b;
  // 没有对齐间隔时共用同一个空数组：每次新建 [] 会让 specIndex 的缓存全部落空，每次查询都新建两个 Map（每次测量调用 6 × 块数次）。
  const specs = alignmentLayouts.get(split)?.[side] ?? NO_SPECS;
  const samePositionOffset = (specIndex(specs).byPos.get(pos) ?? NO_SPECS).reduce((height, spec) => {
    if (spec.pos !== pos || spec.role === "anchor") return height;
    if (spec.chunkIndex < chunkIndex) return height + spec.height;
    if (spec.chunkIndex > chunkIndex) return height;
    return height + (edge === "top"
      ? spec.role === "prefix" ? spec.height : 0
      : spec.role === "body" ? spec.height : 0);
  }, 0);
  return boundaryY(view, pos) + samePositionOffset;
}

function installChangeAlignment(split: SplitView, onGeometryChange: () => void) {
  let currentA: AlignmentSpacerSpec[] = [];
  let currentB: AlignmentSpacerSpec[] = [];
  let timer = 0;
  let generation = 0;
  let completion: (() => void) | undefined;
  const frames = new Set<number>();
  let settled: { a: number; b: number } | null = null;
  let settledAt = 0;
  let refines = 0;
  let refineTimer = 0;

  const applySpecs = (nextA: AlignmentSpacerSpec[], nextB: AlignmentSpacerSpec[]) => {
    const order = (left: AlignmentSpacerSpec, right: AlignmentSpacerSpec) =>
      left.pos - right.pos || left.side - right.side || left.chunkIndex - right.chunkIndex;
    nextA.sort(order);
    nextB.sort(order);
    alignmentLayouts.set(split, { a: nextA, b: nextB });
    const changedA = !specsEqual(currentA, nextA);
    const changedB = !specsEqual(currentB, nextB);
    if (changedA) {
      currentA = nextA;
      split.a.dispatch({ effects: setAlignmentSpacers.of(spacerDecorations(nextA)) });
    }
    if (changedB) {
      currentB = nextB;
      split.b.dispatch({ effects: setAlignmentSpacers.of(spacerDecorations(nextB)) });
    }
    if (changedA || changedB) onGeometryChange();
  };

  const roleHeight = specHeight;
  const normalizedHeights = (oldA: number, oldB: number, deltaAminusB: number) => {
    const nextDifference = oldA - oldB - deltaAminusB;
    if (nextDifference > 0.05) return [nextDifference, 0] as const;
    if (nextDifference < -0.05) return [0, -nextDifference] as const;
    return [0, 0] as const;
  };
  const afterFrames = (count: number, expectedGeneration: number, callback: () => void) => {
    const frame = requestAnimationFrame(() => {
      frames.delete(frame);
      if (expectedGeneration !== generation) return;
      if (count > 1) afterFrames(count - 1, expectedGeneration, callback);
      else callback();
    });
    frames.add(frame);
  };
  const afterEditorMeasure = (expectedGeneration: number, callback: () => void) => {
    let remaining = 2;
    const complete = () => {
      remaining -= 1;
      if (remaining === 0) afterFrames(1, expectedGeneration, callback);
    };
    split.a.requestMeasure({ read: () => undefined, write: complete });
    split.b.requestMeasure({ read: () => undefined, write: complete });
  };
  /**
   * 视口顶部落在某段上下文（区域 k：块 k-1 与块 k 之间；k = 0 为第一个块之前，k = 块数为最后一个块之后）的中间时，
   * 返回视口顶部那一行及另一侧对应的行（上下文两侧行数相同，按行序对应）。视口顶部在块内或正好是区域第一行时返回 null。
   * 视口外的行高度是 CodeMirror 的估算值，两侧的估算在同一段上下文里也不相同（各自按内容宽度估算折行），
   * 只在块边界补偿时，这段上下文里的偏差要到下一个块顶才被吸收，视口正好在上下文中时两侧就会错开。
   */
  const findAnchor = () => {
    const master: DiffSide = split.dom.dataset.masterSide === "a" ? "a" : "b";
    const view = master === "a" ? split.a : split.b;
    // 锚点取视口顶部以上 ANCHOR_MARGIN 处的行：锚定间隔离视口足够远，对齐过程中内容移动也不会露出来；
    // 这段距离在 CodeMirror 实际渲染的范围内（视口上下各约 1000 px），两侧都是测量值，不再有估算偏差。
    const height = view.scrollDOM.scrollTop - view.documentPadding.top - ANCHOR_MARGIN;
    if (height <= 0 || !split.chunks.length) return null;
    const line = view.state.doc.lineAt(view.lineBlockAtHeight(height).from).number;
    const firstLine = (side: DiffSide, pos: number) => lineBoundary((side === "a" ? split.a : split.b).state.doc, pos) + 1;
    const chunkLines = split.chunks.map((chunk) => ({ firstA: firstLine("a", chunk.fromA), firstB: firstLine("b", chunk.fromB), nextA: firstLine("a", chunk.toA), nextB: firstLine("b", chunk.toB) }));
    return contextAnchor(master, line, chunkLines, { a: split.a.state.doc.lines, b: split.b.state.doc.lines });
  };
  type Anchor = NonNullable<ReturnType<typeof findAnchor>>;
  /** 锚点行两侧文字顶部之差（A − B）：锚定间隔在行的上方，boundaryY 取的是含间隔的块顶，所以加上该区域锚定间隔的高度。 */
  const anchorDeltaFor = (anchor: Anchor | null) => {
    if (!anchor) return 0;
    const posA = split.a.state.doc.line(anchor.lineA).from;
    const posB = split.b.state.doc.line(anchor.lineB).from;
    return boundaryY(split.a, posA) + roleHeight(currentA, anchor.region, "anchor") -
      (boundaryY(split.b, posB) + roleHeight(currentB, anchor.region, "anchor"));
  };
  /** 块边界两侧之差的最大值；给出 near 时只看主控侧位于 [from, to] 内的边界。 */
  const boundaryError = (near?: { from: number; to: number }) => split.chunks.reduce((maximum, chunk, chunkIndex) => {
    const topA = alignedBoundary(split, "a", chunk.fromA, chunkIndex, "top");
    const topB = alignedBoundary(split, "b", chunk.fromB, chunkIndex, "top");
    const bottomA = chunk.fromA === chunk.toA
      ? topA + roleHeight(currentA, chunkIndex, "body")
      : alignedBoundary(split, "a", chunk.toA, chunkIndex, "bottom");
    const bottomB = chunk.fromB === chunk.toB
      ? topB + roleHeight(currentB, chunkIndex, "body")
      : alignedBoundary(split, "b", chunk.toB, chunkIndex, "bottom");
    const inside = (a: number, b: number) => !near || Math.max(a, b) >= near.from && Math.min(a, b) <= near.to;
    return Math.max(maximum, inside(topA, topB) ? Math.abs(topA - topB) : 0, inside(bottomA, bottomB) ? Math.abs(bottomA - bottomB) : 0);
  }, 0);
  /**
   * 当前视口下是否需要增量重新对齐：视口附近（上方 2 屏、下方 3 屏以内）的块边界未对齐（对齐后行高被重新测量），
   * 或视口已移到另一段上下文而新锚点两侧未对齐。远处边界的估算误差看不到，滚动到附近时再处理，避免反复对齐整份文件。
   */
  const needsRefine = () => {
    const view = split.dom.dataset.masterSide === "a" ? split.a : split.b;
    const { scrollTop, clientHeight } = view.scrollDOM;
    return boundaryError({ from: scrollTop - 2 * clientHeight, to: scrollTop + 3 * clientHeight }) > 0.5 ||
      Math.abs(anchorDeltaFor(findAnchor())) > 0.5;
  };
  const measure = () => {
    const expectedGeneration = generation;
    const anchor = findAnchor();
    split.dom.dataset.alignmentAnchor = anchor ? `${anchor.region}:${anchor.lineA}:${anchor.lineB}` : "";
    const finish = () => {
      split.dom.dataset.alignmentReady = "true";
      onGeometryChange();
      const callback = completion;
      completion = undefined;
      callback?.();
      // 记下这次对齐所依据的两侧内容高度（最后一次调整间隔后已等过一轮编辑器测量）：之后高度再变（新进入视口的行被测量、
      // 字号切换后的测量）时增量重新对齐（refine）。不能推迟到下一帧再记，否则那一帧里的测量会被当成已对齐的高度。
      settled = { a: split.a.contentHeight, b: split.b.contentHeight };
      settledAt = performance.now();
      // 对齐期间视口可能已经移动（滚动、滚动锚定）：按当前视口再核对一次。
      if (needsRefine()) scheduleRefine();
    };
    const anchorDelta = () => anchorDeltaFor(anchor);
    const maximumAlignmentError = () => Math.max(Math.abs(anchorDelta()), boundaryError());
    const endRound = (round: number) => {
      if (expectedGeneration !== generation) return;
      if (round < 8 && maximumAlignmentError() > 0.5) alignPass(round + 1);
      else finish();
    };
    /**
     * 一轮对齐：按文档顺序一次算出全部锚点、前缀与下边间隔，只派发一次、等一次编辑器测量，再按实测误差决定是否进入下一轮。
     * 某个间隔的高度变化 δ 会让其后的所有边界平移 δ（间隔的 estimatedHeight 就是其高度），因此“旧布局下的边界 + 前面已累计的变化”
     * 就是逐块调整并等待测量后看到的值。原先逐块等待两次测量，块数多时一轮要上千帧（V2-D75 后的已知限制，研究 10 §7.4）。
     */
    const alignPass = (round: number) => {
      if (expectedGeneration !== generation) return;
      const heights = { a: new Map<string, number>(), b: new Map<string, number>() };
      let shiftA = 0;
      let shiftB = 0;
      const set = (chunkIndex: number, role: AlignmentSpacerSpec["role"], [nextA, nextB]: readonly [number, number]) => {
        const oldA = roleHeight(currentA, chunkIndex, role);
        const oldB = roleHeight(currentB, chunkIndex, role);
        // 与生成间隔时的阈值一致：不超过 0.5 px 的间隔不插入
        const a = nextA > 0.5 ? nextA : 0;
        const b = nextB > 0.5 ? nextB : 0;
        heights.a.set(`${chunkIndex}:${role}`, a);
        heights.b.set(`${chunkIndex}:${role}`, b);
        shiftA += a - oldA;
        shiftB += b - oldB;
        return [a, b] as const;
      };
      // 区域 k（块 k-1 与块 k 之间）：有锚点时只保留当前锚点；本轮没有锚点时保留已有锚点，与先前一致。
      const alignRegion = (region: number) => {
        const oldA = roleHeight(currentA, region, "anchor");
        const oldB = roleHeight(currentB, region, "anchor");
        if (anchor?.region === region) set(region, "anchor", normalizedHeights(oldA, oldB, anchorDelta() + shiftA - shiftB));
        else if (anchor) set(region, "anchor", [0, 0]);
        else set(region, "anchor", [oldA, oldB]);
      };
      split.chunks.forEach((chunk, chunkIndex) => {
        alignRegion(chunkIndex);
        const topA = alignedBoundary(split, "a", chunk.fromA, chunkIndex, "top") + shiftA;
        const topB = alignedBoundary(split, "b", chunk.fromB, chunkIndex, "top") + shiftB;
        const oldPrefixA = roleHeight(currentA, chunkIndex, "prefix");
        const oldPrefixB = roleHeight(currentB, chunkIndex, "prefix");
        const [prefixA, prefixB] = set(chunkIndex, "prefix", normalizedHeights(oldPrefixA, oldPrefixB, topA - topB));
        const bottomA = chunk.fromA === chunk.toA
          ? topA + prefixA - oldPrefixA + roleHeight(currentA, chunkIndex, "body")
          : alignedBoundary(split, "a", chunk.toA, chunkIndex, "bottom") + shiftA;
        const bottomB = chunk.fromB === chunk.toB
          ? topB + prefixB - oldPrefixB + roleHeight(currentB, chunkIndex, "body")
          : alignedBoundary(split, "b", chunk.toB, chunkIndex, "bottom") + shiftB;
        set(chunkIndex, "body", normalizedHeights(roleHeight(currentA, chunkIndex, "body"), roleHeight(currentB, chunkIndex, "body"), bottomA - bottomB));
      });
      alignRegion(split.chunks.length);
      const build = (sideName: DiffSide, sideHeights: Map<string, number>, current: AlignmentSpacerSpec[]) => {
        const next: AlignmentSpacerSpec[] = [];
        split.chunks.forEach((chunk, chunkIndex) => {
          const prefix = sideHeights.get(`${chunkIndex}:prefix`) ?? 0;
          const body = sideHeights.get(`${chunkIndex}:body`) ?? 0;
          if (prefix) next.push({ pos: sideName === "a" ? chunk.fromA : chunk.fromB, height: prefix, side: -2, tone: "neutral", role: "prefix", chunkIndex });
          if (body) next.push({ pos: sideName === "a" ? chunk.toA : chunk.toB, height: body, side: -1, tone: alignmentTone(chunk), role: "body", chunkIndex });
        });
        if (anchor) {
          const height = sideHeights.get(`${anchor.region}:anchor`) ?? 0;
          const view = sideName === "a" ? split.a : split.b;
          if (height) next.push({ pos: view.state.doc.line(sideName === "a" ? anchor.lineA : anchor.lineB).from, height, side: -2, tone: "neutral", role: "anchor", chunkIndex: anchor.region });
        } else {
          next.push(...current.filter((spec) => spec.role === "anchor"));
        }
        return next;
      };
      applySpecs(build("a", heights.a, currentA), build("b", heights.b, currentB));
      afterEditorMeasure(expectedGeneration, () => endRound(round));
    };
    alignPass(1);
  };
  const resetAndMeasure = (expectedGeneration: number) => {
    if (currentA.length) split.a.dispatch({ effects: setAlignmentSpacers.of(Decoration.none) });
    if (currentB.length) split.b.dispatch({ effects: setAlignmentSpacers.of(Decoration.none) });
    currentA = [];
    currentB = [];
    alignmentLayouts.set(split, { a: [], b: [] });
    split.a.requestMeasure();
    split.b.requestMeasure();
    afterFrames(2, expectedGeneration, measure);
  };
  const schedule = (onComplete?: () => void) => {
    generation += 1;
    completion = onComplete;
    settled = null;
    refines = 0;
    if (refineTimer) { window.clearTimeout(refineTimer); refineTimer = 0; }
    split.dom.dataset.alignmentGeneration = String(generation);
    split.dom.dataset.alignmentReady = "false";
    const expectedGeneration = generation;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      resetAndMeasure(expectedGeneration);
    }, 60);
  };
  // 增量重新对齐：不清空已有间隔，在当前间隔上按新测得的高度调整，并按当前视口重新选锚点（没有 schedule 的整页重排与闪动）。
  // 触发：对齐后内容高度又变（行被重新测量）、滚动停下后视口移到另一段上下文、对齐结束时视口已移动。
  // 同一位置连续触发（上一次完成后 1 s 内）最多 4 次，避免测量与对齐互相触发时反复运行；滚动到新位置时重新计数。
  const refine = () => {
    refineTimer = 0;
    // 高度变化只是信号：视口附近仍对齐时不做任何事。
    if (!needsRefine()) return;
    const count = (key: "alignmentRefines" | "alignmentRefinesSkipped") => { split.dom.dataset[key] = String(Number(split.dom.dataset[key] ?? 0) + 1); };
    if (refines >= 4) { count("alignmentRefinesSkipped"); return; }
    refines += 1;
    count("alignmentRefines");
    generation += 1;
    settled = null;
    split.dom.dataset.alignmentGeneration = String(generation);
    split.dom.dataset.alignmentReady = "false";
    afterFrames(1, generation, measure);
  };
  const scheduleRefine = (delay = 80) => {
    if (refineTimer) window.clearTimeout(refineTimer);
    refineTimer = window.setTimeout(refine, delay);
  };
  const heights = new ResizeObserver(() => {
    if (!settled || timer) return;
    if (Math.abs(split.a.contentHeight - settled.a) <= 0.5 && Math.abs(split.b.contentHeight - settled.b) <= 0.5) return;
    if (performance.now() - settledAt > 1000) refines = 0;
    scheduleRefine();
  });
  heights.observe(split.a.contentDOM);
  heights.observe(split.b.contentDOM);
  let scrollTimer = 0;
  const scrollEnd = () => {
    scrollTimer = 0;
    if (!settled || timer || refineTimer) return;
    if (!needsRefine()) return;
    refines = 0;
    scheduleRefine(0);
  };
  const onScroll = () => {
    if (scrollTimer) window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(scrollEnd, 120);
  };
  split.a.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  split.b.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  const resize = new ResizeObserver(() => schedule());
  resize.observe(split.paneA);
  resize.observe(split.paneB);
  schedule();
  return {
    schedule,
    destroy() {
      generation += 1;
      completion = undefined;
      if (timer) window.clearTimeout(timer);
      if (refineTimer) window.clearTimeout(refineTimer);
      if (scrollTimer) window.clearTimeout(scrollTimer);
      for (const frame of frames) cancelAnimationFrame(frame);
      split.a.scrollDOM.removeEventListener("scroll", onScroll);
      split.b.scrollDOM.removeEventListener("scroll", onScroll);
      heights.disconnect();
      resize.disconnect();
      alignmentLayouts.delete(split);
      delete split.dom.dataset.alignmentReady;
      delete split.dom.dataset.alignmentGeneration;
      delete split.dom.dataset.alignmentAnchor;
      delete split.dom.dataset.alignmentRefines;
      delete split.dom.dataset.alignmentRefinesSkipped;
    }
  };
}

export function buildSideDecorations(doc: Text, chunks: Change[], changes: DiffDocument["changes"], side: DiffSide, highlight: "words" | "lines") {
  const ranges: Range<Decoration>[] = [];
  for (const chunk of chunks) {
    const from = side === "a" ? chunk.fromA : chunk.fromB;
    const to = side === "a" ? chunk.toA : chunk.toB;
    if (from === to) continue;
    const tone = sideTone(chunk, side);
    const firstLine = doc.lineAt(Math.min(from, doc.length)).number;
    const lastPosition = Math.max(from, Math.min(doc.length, to) - 1);
    const lastLine = doc.lineAt(lastPosition).number;
    for (let line = firstLine; line <= lastLine; line += 1) {
      ranges.push(Decoration.line({ class: `oris-${tone}-line` }).range(doc.line(line).from));
    }
  }
  if (highlight === "words") {
    for (const change of changes) {
      const from = Math.min(doc.length, side === "a" ? change.fromA : change.fromB);
      const to = Math.min(doc.length, side === "a" ? change.toA : change.toB);
      if (to > from) ranges.push(Decoration.mark({ class: "oris-changed-text" }).range(from, to));
    }
  }
  return Decoration.set(ranges, true);
}

interface ReadingSearchView {
  view: EditorView;
  side: "left" | "right" | "unified";
}

interface GlobalSearchMatch extends TextMatch {
  viewIndex: number;
}

function installReadingSearch(
  parent: HTMLElement,
  entries: ReadingSearchView[],
  settleViewport: ((onComplete: () => void) => void) | undefined
) {
  const panel = document.createElement("div");
  panel.className = "oris-search-panel";
  panel.hidden = true;
  panel.setAttribute("role", "search");
  panel.setAttribute("aria-label", "在当前差异中搜索");
  const input = document.createElement("input");
  input.className = "oris-search-input";
  input.type = "text";
  input.maxLength = 512;
  input.placeholder = "在当前差异中搜索";
  input.setAttribute("aria-label", "搜索文本");
  const optionButton = (text: string, label: string, title: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "oris-search-option";
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "false");
    return button;
  };
  const caseButton = optionButton("Aa", "区分大小写", "区分大小写");
  const wordButton = optionButton("全", "全字匹配", "全字匹配（使用编辑器 Unicode 词边界）");
  const regexButton = optionButton(".*", "使用正则表达式", "使用正则表达式");
  const status = document.createElement("span");
  status.className = "oris-search-status";
  status.setAttribute("aria-live", "polite");
  const actionButton = (text: string, label: string, title: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "oris-search-action";
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-label", label);
    return button;
  };
  const previousButton = actionButton("↑", "上一个搜索结果", "上一个结果（Shift+Enter）");
  const nextButton = actionButton("↓", "下一个搜索结果", "下一个结果（Enter）");
  const closeButton = actionButton("×", "关闭搜索", "关闭搜索（Escape）");
  panel.append(input, caseButton, wordButton, regexButton, status, previousButton, nextButton, closeButton);
  parent.append(panel);

  let options: ReadingSearchOptions = { caseSensitive: false, wholeWord: false, regexp: false };
  let matches: GlobalSearchMatch[] = [];
  let currentIndex = -1;
  let limited = false;
  let selectionText = "";
  let refreshFrame = 0;
  let inputTimer = 0;
  let lastFocused = entries.at(-1)?.view;
  const SEARCH_LIMIT = 10_000;
  const VISIBLE_MATCH_LIMIT = 500;
  const SELECTION_MATCH_LIMIT = 200;

  // 每个视图上次派发的是否为空：两类高亮都从空到空时不派发。每次 dispatch 都会让 CodeMirror 读取 DOM 选区，
  // 在没有选区时这会强制整页样式与布局（WebView2 实测每次约 4 ms）；滚动与外观切换期间逐帧触发，累积明显。
  const lastEmpty = new WeakMap<EditorView, { search: boolean; selection: boolean }>();
  const dispatchDecorations = (view: EditorView, search: Range<Decoration>[], selection: Range<Decoration>[]) => {
    const previous = lastEmpty.get(view);
    const next = { search: search.length === 0, selection: selection.length === 0 };
    if (previous && previous.search && previous.selection && next.search && next.selection) return;
    lastEmpty.set(view, next);
    view.dispatch({ effects: [setSearchHighlights.of(Decoration.set(search, true)), setSelectionHighlights.of(Decoration.set(selection, true))] });
  };
  const visibleDecorations = (
    entry: ReadingSearchView,
    query: ReturnType<typeof createReadingQuery>,
    className: string,
    limit: number,
    viewIndex: number,
    markCurrent: boolean
  ) => {
    const ranges: Range<Decoration>[] = [];
    let remaining = limit;
    for (const visible of entry.view.visibleRanges) {
      if (remaining <= 0) break;
      const found = collectQueryMatches(entry.view.state, query, visible.from, visible.to, remaining).matches;
      for (const match of found) {
        const current = markCurrent && currentIndex >= 0 && matches[currentIndex]?.viewIndex === viewIndex &&
          matches[currentIndex].from === match.from && matches[currentIndex].to === match.to;
        ranges.push(Decoration.mark({ class: `${className}${current ? " current" : ""}` }).range(match.from, match.to));
      }
      remaining -= found.length;
    }
    return ranges;
  };
  const refreshVisible = () => {
    refreshFrame = 0;
    const explicit = createReadingQuery(input.value, options);
    const selected = selectionText && selectionText.length <= 512
      ? createReadingQuery(selectionText, options, true)
      : undefined;
    entries.forEach((entry, viewIndex) => {
      const searchRanges = input.value && explicit.valid
        ? visibleDecorations(entry, explicit, "oris-search-match", VISIBLE_MATCH_LIMIT, viewIndex, true)
        : [];
      const selectionRanges = selected
        ? visibleDecorations(entry, selected, "oris-selection-match", SELECTION_MATCH_LIMIT, viewIndex, false)
        : [];
      dispatchDecorations(entry.view, searchRanges, selectionRanges);
    });
  };
  const scheduleVisible = () => {
    if (!refreshFrame) refreshFrame = requestAnimationFrame(refreshVisible);
  };
  const renderStatus = (invalid = false) => {
    status.classList.toggle("error", invalid);
    if (invalid) status.textContent = "正则表达式无效";
    else if (!input.value || !matches.length) status.textContent = "0/0";
    else status.textContent = `${currentIndex + 1}/${matches.length}${limited ? "+" : ""}`;
    previousButton.disabled = nextButton.disabled = invalid || matches.length === 0;
  };
  const rebuildSearch = (resetCurrent = true) => {
    if (inputTimer) {
      window.clearTimeout(inputTimer);
      inputTimer = 0;
    }
    matches = [];
    limited = false;
    const query = createReadingQuery(input.value, options);
    if (!input.value || !query.valid) {
      currentIndex = -1;
      renderStatus(Boolean(input.value && !query.valid));
      scheduleVisible();
      return;
    }
    let remaining = SEARCH_LIMIT;
    entries.forEach((entry, viewIndex) => {
      if (remaining <= 0) {
        limited = true;
        return;
      }
      const found = collectQueryMatches(entry.view.state, query, 0, entry.view.state.doc.length, remaining);
      matches.push(...found.matches.map((match) => ({ ...match, viewIndex })));
      remaining -= found.matches.length;
      limited ||= found.limited;
    });
    if (resetCurrent) currentIndex = matches.length ? 0 : -1;
    else currentIndex = matches.length ? Math.min(Math.max(0, currentIndex), matches.length - 1) : -1;
    renderStatus();
    scheduleVisible();
  };
  const navigate = (direction: -1 | 1) => {
    if (!matches.length) return;
    currentIndex = (currentIndex + direction + matches.length) % matches.length;
    const match = matches[currentIndex];
    const entry = entries[match.viewIndex];
    const position = () => {
      const block = entry.view.lineBlockAt(match.from);
      entry.view.scrollDOM.scrollTop = Math.max(0, block.top - entry.view.scrollDOM.clientHeight / 3);
    };
    position();
    settleViewport?.(() => {
      position();
      requestAnimationFrame(scheduleVisible);
    });
    renderStatus();
    requestAnimationFrame(scheduleVisible);
  };
  const setOption = (key: keyof ReadingSearchOptions, button: HTMLButtonElement) => {
    options = { ...options, [key]: !options[key] };
    button.classList.toggle("active", options[key]);
    button.setAttribute("aria-pressed", String(options[key]));
    rebuildSearch();
    input.focus({ preventScroll: true });
  };
  caseButton.addEventListener("click", () => setOption("caseSensitive", caseButton));
  wordButton.addEventListener("click", () => setOption("wholeWord", wordButton));
  regexButton.addEventListener("click", () => setOption("regexp", regexButton));
  previousButton.addEventListener("click", () => navigate(-1));
  nextButton.addEventListener("click", () => navigate(1));
  input.addEventListener("input", () => {
    if (inputTimer) window.clearTimeout(inputTimer);
    inputTimer = window.setTimeout(() => rebuildSearch(), 80);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  const close = () => {
    panel.hidden = true;
    input.value = "";
    matches = [];
    currentIndex = -1;
    renderStatus();
    scheduleVisible();
    if (lastFocused) {
      const scrollTop = lastFocused.scrollDOM.scrollTop;
      lastFocused.focus();
      lastFocused.scrollDOM.scrollTop = scrollTop;
      requestAnimationFrame(() => { if (lastFocused) lastFocused.scrollDOM.scrollTop = scrollTop; });
    }
  };
  closeButton.addEventListener("click", close);
  const selectedTextInEditor = () => {
    const selection = globalThis.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode) return "";
    return entries.some((entry) => entry.view.contentDOM.contains(selection.anchorNode)) ? selection.toString() : "";
  };
  const open = () => {
    panel.hidden = false;
    const selected = selectedTextInEditor();
    if (selected && selected.length <= 512) input.value = selected;
    rebuildSearch();
    input.focus({ preventScroll: true });
    input.select();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      open();
    } else if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);
  entries.forEach((entry) => {
    entry.view.contentDOM.addEventListener("focusin", () => { lastFocused = entry.view; });
    entry.view.scrollDOM.addEventListener("scroll", scheduleVisible, { passive: true });
  });
  const onSelectionChange = () => {
    const selection = globalThis.getSelection();
    if (!selection?.anchorNode) return;
    const inside = entries.some((entry) => entry.view.contentDOM.contains(selection.anchorNode));
    if (!inside) return;
    selectionText = selection.isCollapsed ? "" : selection.toString();
    scheduleVisible();
  };
  document.addEventListener("selectionchange", onSelectionChange);
  renderStatus();
  return {
    destroy() {
      if (refreshFrame) cancelAnimationFrame(refreshFrame);
      if (inputTimer) window.clearTimeout(inputTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      entries.forEach((entry) => entry.view.scrollDOM.removeEventListener("scroll", scheduleVisible));
      panel.remove();
    }
  };
}

interface PairedCollapseRegion {
  id: number;
  a: { from: number; to: number; lines: number };
  b: { from: number; to: number; lines: number };
}

function collapseRange(doc: Text, previous: number, next: number, margin = 3, minimum = 5) {
  const startBoundary = lineBoundary(doc, previous);
  const endBoundary = lineBoundary(doc, next);
  const firstHiddenLine = startBoundary + margin + 1;
  const lastHiddenLine = endBoundary - margin;
  const lines = lastHiddenLine - firstHiddenLine + 1;
  if (lines < minimum || firstHiddenLine < 1 || lastHiddenLine > doc.lines) return null;
  const from = doc.line(firstHiddenLine).from;
  const to = lastHiddenLine < doc.lines ? doc.line(lastHiddenLine + 1).from : doc.length;
  return to > from ? { from, to, lines } : null;
}

function pairedCollapseRegions(a: Text, b: Text, chunks: Change[]) {
  const regions: PairedCollapseRegion[] = [];
  let previousA = 0;
  let previousB = 0;
  const boundaries = [...chunks, new Change(a.length, a.length, b.length, b.length)];
  for (const chunk of boundaries) {
    const rangeA = collapseRange(a, previousA, chunk.fromA);
    const rangeB = collapseRange(b, previousB, chunk.fromB);
    if (rangeA && rangeB) regions.push({ id: regions.length, a: rangeA, b: rangeB });
    previousA = chunk.toA;
    previousB = chunk.toB;
  }
  return regions;
}

function installPairedCollapse(split: SplitView) {
  const regions = pairedCollapseRegions(split.a.state.doc, split.b.state.doc, split.chunks);
  const expanded = new Set<number>();
  split.dom.dataset.collapsedRegions = String(regions.length);
  const update = () => {
    const sideDecorations = (side: DiffSide) => Decoration.set(regions
      .filter((region) => !expanded.has(region.id))
      .map((region) => {
        const range = region[side];
        return Decoration.replace({
          block: true,
          widget: new CollapsedLinesWidget(region.id, range.lines, (regionId) => {
            expanded.add(regionId);
            update();
          })
        }).range(range.from, range.to);
      }), true);
    split.a.dispatch({ effects: setCollapsedRanges.of(sideDecorations("a")) });
    split.b.dispatch({ effects: setCollapsedRanges.of(sideDecorations("b")) });
    split.dom.dataset.expandedRegions = String(expanded.size);
  };
  update();
  return {
    reveal(side: DiffSide, position: number) {
      const region = regions.find(region => !expanded.has(region.id) && position >= region[side].from && position < region[side].to);
      if (region) { expanded.add(region.id); update(); }
    },
    expandAll() {
      const hidden = regions.filter((region) => !expanded.has(region.id)).length;
      regions.forEach((region) => expanded.add(region.id));
      if (hidden) update();
      return hidden;
    },
    destroy() {
      split.a.dispatch({ effects: setCollapsedRanges.of(Decoration.none) });
      split.b.dispatch({ effects: setCollapsedRanges.of(Decoration.none) });
    }
  };
}

/**
 * 统一视图的“全部展开”：按 @codemirror/merge `buildCollapsedRanges` 的同一规则（margin 3、至少 5 行）
 * 找出折叠区段的起点，逐个派发公开的 `uncollapseUnchanged` 效果。
 */
function expandUnified(view: EditorView, targetLine?: number, margin = 3, minLines = 5) {
  const chunks = getChunks(view.state)?.chunks ?? [];
  const doc = view.state.doc;
  const starts: number[] = [];
  let previousLine = 1;
  for (let index = 0; ; index++) {
    const chunk = index < chunks.length ? chunks[index] : null;
    const from = index ? previousLine + margin : 1;
    const to = chunk ? doc.lineAt(chunk.fromB).number - 1 - margin : doc.lines;
    if (to - from + 1 >= minLines && (targetLine === undefined || (targetLine >= from && targetLine <= to))) starts.push(doc.line(from).from);
    if (!chunk) break;
    previousLine = doc.lineAt(Math.min(doc.length, chunk.toB)).number;
  }
  if (starts.length) view.dispatch({ effects: starts.map((pos) => uncollapseUnchanged.of(pos)) });
  return starts.length;
}

function createRail(side: DiffSide, controls: string) {
  const rail = document.createElement("div");
  rail.className = `diff-overview-rail ${side === "a" ? "left" : "right"}`;
  rail.tabIndex = 0;
  rail.setAttribute("role", "scrollbar");
  rail.setAttribute("aria-label", side === "a" ? "左侧差异滚动条" : "右侧差异滚动条");
  rail.setAttribute("aria-orientation", "vertical");
  rail.setAttribute("aria-controls", controls);
  rail.setAttribute("aria-valuemin", "0");
  const markers = document.createElement("div");
  markers.className = "diff-overview-markers";
  const viewport = document.createElement("div");
  viewport.className = "diff-overview-viewport";
  viewport.setAttribute("aria-hidden", "true");
  // 标记单独放一层（位置与层级不变）：重建时一次换掉全部标记，点击由这一层委托处理（lc5：上千块时逐个移除、逐个绑定监听器约 6 ms）。
  const markerList = document.createElement("div");
  markerList.className = "diff-overview-marker-list";
  markerList.addEventListener("click", (event) => {
    const marker = (event.target as Element | null)?.closest?.<HTMLElement>(".diff-overview-marker");
    if (!marker || !markerList.contains(marker)) return;
    event.stopPropagation();
    markerNavigation.get(markerList)?.(Number(marker.dataset.hunkIndex));
  });
  markers.append(viewport, markerList);
  rail.append(markers);
  return { rail, markers, viewport };
}

function installSplitResize(
  split: SplitView,
  separator: HTMLElement,
  initialRatio: number,
  onLayoutChange: (ratio: number, leftWidth: number) => void,
  onGeometryChange: () => void
) {
  let leftWidth = 0;
  let ratio = initialRatio;
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;
  const availableWidth = () => Math.max(0, split.editorRoot.clientWidth - DIFF_SEPARATOR_WIDTH - DIFF_RAIL_WIDTH * 2);
  const clamp = (width: number, available: number) => {
    const minimum = Math.min(DIFF_PANE_MIN_WIDTH, available / 2);
    return Math.min(Math.max(minimum, width), Math.max(minimum, available - minimum));
  };
  // 可用宽度只读一次：写入 --diff-left-width 之后再读 clientWidth 会让样式失效后的布局再强制计算一遍（编辑器宽度不影响外层宽度）。
  const applyWidth = (width: number | ((available: number) => number), remember = true) => {
    const available = availableWidth();
    const next = Math.round(clamp(typeof width === "function" ? width(available) : width, available));
    if (next !== leftWidth) {
      leftWidth = next;
      split.editorRoot.style.setProperty("--diff-left-width", `${next}px`);
      split.a.requestMeasure();
      split.b.requestMeasure();
      onGeometryChange();
    }
    if (remember && available > 0) ratio = next / available;
    onLayoutChange(ratio, next + DIFF_RAIL_WIDTH);
    separator.setAttribute("aria-valuemin", String(Math.round(Math.min(DIFF_PANE_MIN_WIDTH, available / 2))));
    separator.setAttribute("aria-valuemax", String(Math.round(Math.max(0, available - DIFF_PANE_MIN_WIDTH))));
    separator.setAttribute("aria-valuenow", String(next));
  };
  applyWidth((available) => available * ratio, false);
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: leftWidth };
    separator.classList.add("dragging");
    separator.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyWidth(drag.startWidth + event.clientX - drag.startX);
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    separator.classList.remove("dragging");
    if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    applyWidth(leftWidth + (event.key === "ArrowLeft" ? -16 : 16));
  };
  separator.addEventListener("pointerdown", onPointerDown);
  separator.addEventListener("pointermove", onPointerMove);
  separator.addEventListener("pointerup", onPointerEnd);
  separator.addEventListener("pointercancel", onPointerEnd);
  separator.addEventListener("keydown", onKeyDown);
  const resize = new ResizeObserver(() => applyWidth((available) => available * ratio, false));
  resize.observe(split.editorRoot);
  return () => {
    resize.disconnect();
    separator.removeEventListener("pointerdown", onPointerDown);
    separator.removeEventListener("pointermove", onPointerMove);
    separator.removeEventListener("pointerup", onPointerEnd);
    separator.removeEventListener("pointercancel", onPointerEnd);
    separator.removeEventListener("keydown", onKeyDown);
  };
}

interface ConnectorGeometry {
  index: number;
  chunk: Change;
  tone: Exclude<AlignmentTone, "neutral">;
  aTop: number;
  aBottom: number;
  bTop: number;
  bBottom: number;
  aPaintBottom: number;
  bPaintBottom: number;
}

function renderRailMarkers(
  rail: HTMLElement,
  view: EditorView,
  chunks: readonly Change[],
  side: DiffSide,
  navigate: (index: number) => void,
  toneOverride?: Exclude<AlignmentTone, "neutral">
) {
  const markers = rail.querySelector<HTMLElement>(".diff-overview-marker-list")!;
  markerNavigation.set(markers, navigate);
  const doc = view.state.doc;
  // 只读一次高度：循环中读取会在每次追加标记后强制同步布局（块数多时为 O(n²)，V2-D75）
  const railHeight = rail.clientHeight;
  const deviceMinimum = Math.max(1, 1 / Math.max(1, window.devicePixelRatio));
  // 标记只取决于块、文档与轨道高度；测量随滚动频繁触发，没有变化时不重建
  const previous = renderedRailMarkers.get(rail);
  if (previous && previous.chunks === chunks && previous.doc === doc && previous.height === railHeight && previous.deviceMinimum === deviceMinimum && previous.tone === toneOverride) return;
  renderedRailMarkers.set(rail, { chunks, doc, height: railHeight, deviceMinimum, tone: toneOverride });
  // 视口框在外层、不随标记重建（摘下它会丢失拖动中的指针捕获）；标记层整体替换。
  const fragment = document.createDocumentFragment();
  const occupied = new Map<string, { node: HTMLButtonElement; top: number; bottom: number }>();
  chunks.forEach((chunk, index) => {
    const from = side === "a" ? chunk.fromA : chunk.fromB;
    const to = side === "a" ? chunk.toA : chunk.toB;
    const tone = toneOverride ?? alignmentTone(chunk);
    const marker = diffMarkerGeometry(railHeight, lineBoundary(doc, from), lineBoundary(doc, to), doc.lines, deviceMinimum);
    const bucket = `${tone}:${Math.round(marker.top)}`;
    const existing = occupied.get(bucket);
    if (existing) {
      const bottom = Math.max(existing.bottom, marker.top + marker.height);
      existing.bottom = bottom;
      existing.node.style.height = `${Math.max(deviceMinimum, bottom - existing.top)}px`;
      return;
    }
    const node = document.createElement("button");
    node.type = "button";
    node.className = `diff-overview-marker ${tone}`;
    node.style.top = `${marker.top}px`;
    node.style.height = `${marker.height}px`;
    node.dataset.hunkIndex = String(index);
    node.setAttribute("aria-label", `跳到第 ${index + 1} 个差异块`);
    fragment.append(node);
    occupied.set(bucket, { node, top: marker.top, bottom: marker.top + marker.height });
  });
  markers.replaceChildren(fragment);
}

/** 各轨道标记层当前的跳转函数（标记点击委托给标记层，见 createRail）。 */
const markerNavigation = new WeakMap<HTMLElement, (index: number) => void>();

const renderedRailMarkers = new WeakMap<HTMLElement, { chunks: readonly Change[]; doc: Text; height: number; deviceMinimum: number; tone: string | undefined }>();

function installSplitVisuals(split: SplitView, navigate: (index: number) => void) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("diff-connectors");
  svg.setAttribute("aria-hidden", "true");
  const zeroLayer = document.createElement("div");
  zeroLayer.className = "diff-zero-layer";
  zeroLayer.setAttribute("aria-hidden", "true");
  split.dom.append(svg, zeroLayer);
  let geometry: ConnectorGeometry[] = [];
  let drawFrame = 0;
  let measureFrame = 0;

  const markerNodes = (side: DiffSide) => {
    const rail = split.rails[side];
    renderRailMarkers(rail, side === "a" ? split.a : split.b, split.chunks, side, navigate);
  };

  const draw = () => {
    drawFrame = 0;
    const root = split.dom.getBoundingClientRect();
    const left = split.paneA.getBoundingClientRect();
    const right = split.paneB.getBoundingClientRect();
    const width = split.dom.clientWidth;
    const height = split.dom.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();
    zeroLayer.replaceChildren();
    const x1 = left.right - root.left;
    const x2 = right.left - root.left;
    const aScroll = split.a.scrollDOM.scrollTop;
    const bScroll = split.b.scrollDOM.scrollTop;
    split.dom.dataset.connectorGeometryCount = String(geometry.length);
    split.dom.dataset.connectorX1 = String(x1);
    split.dom.dataset.connectorX2 = String(x2);
    if (geometry[0]) split.dom.dataset.firstConnectorGeometry = JSON.stringify(geometry[0]);
    split.dom.dataset.leftScrollTop = String(aScroll);
    split.dom.dataset.rightScrollTop = String(bScroll);
    if (x2 <= x1) return;
    const firstControl = x1 + (x2 - x1) * 0.3;
    const secondControl = x1 + (x2 - x1) * 0.7;
    let low = 0;
    let high = geometry.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const item = geometry[middle];
      if (Math.max(item.aPaintBottom - aScroll, item.bPaintBottom - bScroll) < -2) low = middle + 1;
      else high = middle;
    }
    const firstVisible = low;
    low = firstVisible;
    high = geometry.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const item = geometry[middle];
      if (Math.min(item.aTop - aScroll, item.bTop - bScroll) <= height + 2) low = middle + 1;
      else high = middle;
    }
    for (let geometryIndex = firstVisible; geometryIndex < low; geometryIndex += 1) {
      const item = geometry[geometryIndex];
      const aTop = item.aTop - aScroll;
      const aBottom = item.aBottom - aScroll;
      const bTop = item.bTop - bScroll;
      const bBottom = item.bBottom - bScroll;
      const aPaintBottom = item.aPaintBottom - aScroll;
      const bPaintBottom = item.bPaintBottom - bScroll;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add(item.tone);
      path.dataset.hunkIndex = String(item.index);
      path.dataset.fromA = String(item.chunk.fromA);
      path.dataset.toA = String(item.chunk.toA);
      path.dataset.fromB = String(item.chunk.fromB);
      path.dataset.toB = String(item.chunk.toB);
      path.dataset.aTop = String(aTop);
      path.dataset.aBottom = String(aBottom);
      path.dataset.bTop = String(bTop);
      path.dataset.bBottom = String(bBottom);
      path.dataset.aPaintBottom = String(aPaintBottom);
      path.dataset.bPaintBottom = String(bPaintBottom);
      path.setAttribute("d", `M ${x1} ${aTop} C ${firstControl} ${aTop}, ${secondControl} ${bTop}, ${x2} ${bTop} ` +
        `L ${x2} ${bPaintBottom} C ${secondControl} ${bPaintBottom}, ${firstControl} ${aPaintBottom}, ${x1} ${aPaintBottom} Z`);
      svg.append(path);
      const addZeroLine = (side: DiffSide, y: number, pane: DOMRect) => {
        const line = document.createElement("div");
        line.className = `diff-zero-line ${item.tone} ${side === "a" ? "left" : "right"}`;
        line.style.left = `${pane.left - root.left}px`;
        line.style.width = `${pane.width}px`;
        line.style.top = `${y}px`;
        line.dataset.hunkIndex = String(item.index);
        zeroLayer.append(line);
      };
      if (item.chunk.fromA === item.chunk.toA && aTop >= 0 && aTop <= height) addZeroLine("a", aTop, left);
      if (item.chunk.fromB === item.chunk.toB && bTop >= 0 && bTop <= height) addZeroLine("b", bTop, right);
    }
  };
  const scheduleDraw = () => { if (!drawFrame) drawFrame = requestAnimationFrame(draw); };
  const drawNow = () => {
    if (drawFrame) cancelAnimationFrame(drawFrame);
    draw();
  };
  const measure = () => {
    measureFrame = 0;
    const layouts = alignmentLayouts.get(split);
    // 连接带几何与左右同步用的边界在同一轮中算出：同一块的上、下边界只查询一次（原先边界表又把每块的上下边界重算一遍）。
    const boundaries: SplitView["boundaries"] = [{ a: boundaryY(split.a, 0), b: boundaryY(split.b, 0) }];
    geometry = split.chunks.map((chunk, index) => {
      const aTop = alignedBoundary(split, "a", chunk.fromA, index, "top");
      const bTop = alignedBoundary(split, "b", chunk.fromB, index, "top");
      // 一侧为空（纯新增 / 纯删除）时连接带的下边与上边重合，但边界表仍取该位置的“下边”（含块下方的间隔）
      const aEdge = alignedBoundary(split, "a", chunk.toA, index, "bottom");
      const bEdge = alignedBoundary(split, "b", chunk.toB, index, "bottom");
      const aBottom = chunk.fromA === chunk.toA ? aTop : aEdge;
      const bBottom = chunk.fromB === chunk.toB ? bTop : bEdge;
      boundaries.push({ a: aTop, b: bTop }, { a: aEdge, b: bEdge });
      // 每块最多一个下边间隔
      const bodyHeight = (side: DiffSide) => layouts ? specHeight(layouts[side], index, "body") : 0;
      return {
        index,
        chunk,
        tone: alignmentTone(chunk),
        aTop,
        aBottom,
        bTop,
        bBottom,
        aPaintBottom: chunk.fromA === chunk.toA ? aBottom + Math.max(1, bodyHeight("a")) : aBottom,
        bPaintBottom: chunk.fromB === chunk.toB ? bBottom + Math.max(1, bodyHeight("b")) : bBottom
      };
    });
    split.boundaries = boundaries;
    split.boundaries.push({
      a: boundaryY(split.a, split.a.state.doc.length),
      b: boundaryY(split.b, split.b.state.doc.length)
    });
    markerNodes("a");
    markerNodes("b");
    draw();
  };
  const scheduleMeasure = () => { if (!measureFrame) measureFrame = requestAnimationFrame(measure); };
  const resize = new ResizeObserver(scheduleMeasure);
  resize.observe(split.dom);
  resize.observe(split.a.contentDOM);
  resize.observe(split.b.contentDOM);
  const mutation = new MutationObserver(scheduleMeasure);
  mutation.observe(split.a.contentDOM, { subtree: true, childList: true, attributes: true });
  mutation.observe(split.b.contentDOM, { subtree: true, childList: true, attributes: true });
  // Scroll-driven redraws come from installScrollAndRails, which knows when the
  // other pane is about to be synced and must not be painted against a stale scrollTop.
  scheduleMeasure();
  return {
    scheduleDraw,
    drawNow,
    scheduleMeasure,
    destroy() {
      if (drawFrame) cancelAnimationFrame(drawFrame);
      if (measureFrame) cancelAnimationFrame(measureFrame);
      resize.disconnect();
      mutation.disconnect();
      svg.remove();
      zeroLayer.remove();
    }
  };
}

function clampViewScroll(view: EditorView, value: number) {
  return Math.min(Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight), Math.max(0, value));
}

// Fractional line position (0-based) of a document height, interpolated inside the
// line block so the rail band moves continuously instead of in whole-line steps.
function lineAtHeight(view: EditorView, height: number) {
  const doc = view.state.doc;
  const block = view.lineBlockAtHeight(height);
  const first = doc.lineAt(Math.min(doc.length, block.from)).number - 1;
  const last = doc.lineAt(Math.min(doc.length, block.to)).number;
  const ratio = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
  return first + ratio * (last - first);
}

// Inverse of lineAtHeight.
function heightAtLine(view: EditorView, position: number) {
  const doc = view.state.doc;
  const index = Math.min(doc.lines - 1, Math.max(0, Math.floor(position)));
  const block = view.lineBlockAt(doc.line(index + 1).from);
  const first = doc.lineAt(block.from).number - 1;
  const last = doc.lineAt(block.to).number;
  const ratio = Math.min(1, Math.max(0, (position - first) / Math.max(1, last - first)));
  return block.top + ratio * block.height;
}

function updateRailViewport(rail: HTMLElement, view: EditorView) {
  const band = rail.querySelector<HTMLElement>(".diff-overview-viewport")!;
  const doc = view.state.doc;
  // While dragging, the band follows the pointer directly (see installRailInput).
  const dragging = rail.dataset.dragging === "true";
  if (doc.length === 0) {
    band.style.top = "0px";
    band.style.height = `${rail.clientHeight}px`;
    band.dataset.lineFrom = "0";
    band.dataset.lineTo = "0";
    band.dataset.lineTotal = "0";
  } else if (!dragging) {
    const viewportRect = view.scrollDOM.getBoundingClientRect();
    const topHeight = Math.max(0, Math.min(view.contentHeight, (viewportRect.top - view.documentTop) / view.scaleY));
    const bottomHeight = Math.max(topHeight, Math.min(view.contentHeight, (viewportRect.bottom - view.documentTop) / view.scaleY));
    const firstLine = lineAtHeight(view, topHeight);
    const lastLine = Math.min(doc.lines, Math.max(firstLine + 1, lineAtHeight(view, bottomHeight)));
    const top = rail.clientHeight * firstLine / doc.lines;
    const bottom = rail.clientHeight * lastLine / doc.lines;
    band.style.top = `${top}px`;
    band.style.height = `${Math.max(2, bottom - top)}px`;
    band.dataset.lineFrom = String(firstLine);
    band.dataset.lineTo = String(lastLine);
    band.dataset.lineTotal = String(doc.lines);
  }
  const maximum = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
  rail.setAttribute("aria-valuemax", String(maximum));
  rail.setAttribute("aria-valuenow", String(Math.round(view.scrollDOM.scrollTop)));
  rail.setAttribute("aria-disabled", String(maximum <= 0));
}

type RailDrag = { pointerId: number; grabOffset: number; bandHeight: number; visibleLines: number };

function setViewFromRail(view: EditorView, rail: HTMLElement, pointerY: number, drag: RailDrag) {
  const doc = view.state.doc;
  if (!doc.length) return;
  const band = rail.querySelector<HTMLElement>(".diff-overview-viewport")!;
  // Band size is frozen for the whole drag; letting it follow the live visible line
  // count (spacers, collapsed ranges) would shift the pointer-to-scroll mapping mid-drag.
  const position = railViewportStartLine(
    rail.clientHeight,
    drag.bandHeight,
    pointerY,
    drag.grabOffset,
    doc.lines,
    drag.visibleLines
  );
  band.style.top = `${position.top}px`;
  const scroll = view.scrollDOM;
  const contentOffset = view.documentTop - scroll.getBoundingClientRect().top + scroll.scrollTop;
  scroll.scrollTop = clampViewScroll(view, contentOffset + heightAtLine(view, position.line) * view.scaleY);
}

function installRailInput(rail: HTMLElement, view: EditorView, onUserInput: () => void) {
  const band = rail.querySelector<HTMLElement>(".diff-overview-viewport")!;
  const markers = rail.querySelector<HTMLElement>(".diff-overview-markers")!;
  let drag: RailDrag | null = null;
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || rail.getAttribute("aria-disabled") === "true") return;
    const bandRect = band.getBoundingClientRect();
    // The band paints above the translucent markers; a marker press inside the band still grabs the band.
    const onMarker = event.target instanceof HTMLElement && event.target.classList.contains("diff-overview-marker");
    const onBand = event.target === band || (onMarker && event.clientY >= bandRect.top && event.clientY <= bandRect.bottom);
    if (!onBand && event.target !== rail && event.target !== markers) return;
    onUserInput();
    const lineFrom = Number(band.dataset.lineFrom ?? "0");
    const lineTo = Number(band.dataset.lineTo ?? String(lineFrom + 1));
    drag = {
      pointerId: event.pointerId,
      // Clicking the track centres the band under the pointer, then keeps dragging.
      grabOffset: onBand ? event.clientY - bandRect.top : bandRect.height / 2,
      bandHeight: bandRect.height,
      visibleLines: Math.max(1, lineTo - lineFrom)
    };
    rail.dataset.dragging = "true";
    // Capture on the rail, which is never re-rendered, so the drag survives marker refreshes.
    rail.setPointerCapture(event.pointerId);
    if (!onBand) setViewFromRail(view, rail, event.clientY - rail.getBoundingClientRect().top, drag);
    event.preventDefault();
  };
  const pointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setViewFromRail(view, rail, event.clientY - rail.getBoundingClientRect().top, drag);
  };
  const pointerEnd = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    delete rail.dataset.dragging;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    updateRailViewport(rail, view);
  };
  const railKey = (event: KeyboardEvent) => {
    let next: number | undefined;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = view.scrollDOM.scrollHeight;
    else if (event.key === "PageUp") next = view.scrollDOM.scrollTop - view.scrollDOM.clientHeight;
    else if (event.key === "PageDown") next = view.scrollDOM.scrollTop + view.scrollDOM.clientHeight;
    else if (event.key === "ArrowUp") next = view.scrollDOM.scrollTop - view.defaultLineHeight;
    else if (event.key === "ArrowDown") next = view.scrollDOM.scrollTop + view.defaultLineHeight;
    if (next === undefined) return;
    onUserInput();
    view.scrollDOM.scrollTop = clampViewScroll(view, next);
    event.preventDefault();
  };
  rail.addEventListener("pointerdown", pointerDown);
  rail.addEventListener("pointermove", pointerMove);
  rail.addEventListener("pointerup", pointerEnd);
  rail.addEventListener("pointercancel", pointerEnd);
  rail.addEventListener("lostpointercapture", pointerEnd);
  rail.addEventListener("keydown", railKey);
  return () => {
    rail.removeEventListener("pointerdown", pointerDown);
    rail.removeEventListener("pointermove", pointerMove);
    rail.removeEventListener("pointerup", pointerEnd);
    rail.removeEventListener("pointercancel", pointerEnd);
    rail.removeEventListener("lostpointercapture", pointerEnd);
    rail.removeEventListener("keydown", railKey);
  };
}

function installScrollAndRails(
  split: SplitView,
  visuals: { scheduleDraw: () => void; drawNow: () => void },
  onUserViewportChange: () => void
) {
  let epoch = 0;
  let frame = 0;
  let pending: DiffSide | null = null;
  let master: DiffSide = "b";
  const tokens: Partial<Record<DiffSide, { epoch: number; expected: number }>> = {};
  const viewFor = (side: DiffSide) => side === "a" ? split.a : split.b;
  const railFor = (side: DiffSide) => split.rails[side];
  const claim = (side: DiffSide, userInitiated = false) => {
    epoch += 1;
    master = side;
    delete tokens.a;
    delete tokens.b;
    split.dom.dataset.masterSide = side;
    split.dom.dataset.syncEpoch = String(epoch);
    if (userInitiated) onUserViewportChange();
  };
  const beginProgramEpoch = () => {
    epoch += 1;
    pending = null;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      // The cancelled sync owned the redraw for the scroll that scheduled it.
      visuals.scheduleDraw();
    }
    delete tokens.a;
    delete tokens.b;
    split.dom.dataset.syncEpoch = String(epoch);
    return epoch;
  };
  const write = (side: DiffSide, value: number, writeEpoch: number) => {
    const target = viewFor(side).scrollDOM;
    const next = clampViewScroll(viewFor(side), value);
    tokens[side] = { epoch: writeEpoch, expected: next };
    target.scrollTop = next;
  };
  const updateRail = (side: DiffSide) => {
    const view = viewFor(side);
    const rail = railFor(side);
    updateRailViewport(rail, view);
  };
  const updateRailViewports = () => {
    updateRail("a");
    updateRail("b");
  };
  const updateRails = () => {
    updateRailViewports();
    visuals.scheduleDraw();
  };
  const syncFrom = (side: DiffSide) => {
    const source = viewFor(side);
    const targetSide: DiffSide = side === "a" ? "b" : "a";
    const target = viewFor(targetSide);
    const anchor = source.scrollDOM.clientHeight / 3;
    const mapped = mapDiffPosition(split.boundaries, side, source.scrollDOM.scrollTop + anchor);
    split.dom.dataset.syncSegment = String(mapped.segment);
    split.dom.dataset.syncSourceTop = String(source.scrollDOM.scrollTop);
    write(targetSide, mapped.value - target.scrollDOM.clientHeight / 3, epoch);
    updateRailViewports();
    // Draw in this frame, after both panes hold their final scrollTop; a deferred
    // draw would paint connectors against one pane that has already moved on.
    visuals.drawNow();
  };
  const scheduleSync = (side: DiffSide) => {
    pending = side;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const next = pending;
      pending = null;
      if (next) syncFrom(next);
    });
  };
  // Horizontal scroll mirrors 1:1. The narrower pane clamps, so a write is only
  // tokened when it actually moved the target; otherwise its clamped echo would
  // drag the source pane back.
  const lefts: Record<DiffSide, number> = { a: split.a.scrollDOM.scrollLeft, b: split.b.scrollDOM.scrollLeft };
  const tops: Record<DiffSide, number> = { a: split.a.scrollDOM.scrollTop, b: split.b.scrollDOM.scrollTop };
  const leftTokens: Partial<Record<DiffSide, number>> = {};
  const syncHorizontal = (side: DiffSide) => {
    const current = viewFor(side).scrollDOM.scrollLeft;
    if (current === lefts[side]) return;
    lefts[side] = current;
    const expected = leftTokens[side];
    delete leftTokens[side];
    if (expected !== undefined && Math.abs(expected - current) <= 1) return;
    const targetSide: DiffSide = side === "a" ? "b" : "a";
    const target = viewFor(targetSide).scrollDOM;
    target.scrollLeft = current;
    if (target.scrollLeft !== lefts[targetSide]) leftTokens[targetSide] = target.scrollLeft;
  };
  const onScroll = (side: DiffSide) => {
    syncHorizontal(side);
    const token = tokens[side];
    const current = viewFor(side).scrollDOM.scrollTop;
    const moved = current !== tops[side];
    tops[side] = current;
    if (token && Math.abs(token.expected - current) <= 1) {
      delete tokens[side];
      updateRails();
      return;
    }
    // Purely horizontal scroll: no vertical re-sync or master change.
    if (!moved) return;
    if (side !== master) claim(side);
    scheduleSync(side);
    // Connectors wait for syncFrom: drawing now would pair this pane's new
    // scrollTop with the other pane's pre-sync one.
    updateRailViewports();
  };
  const extentOf = (view: EditorView) => ({
    top: view.scrollDOM.scrollTop,
    max: Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)
  });
  // When the hovered pane is already at its top/bottom but the other pane still
  // has room, keep the wheel moving by scrolling the other pane instead.
  const chainWheel = (side: DiffSide, event: WheelEvent) => {
    if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
    const source = viewFor(side);
    const targetSide: DiffSide = side === "a" ? "b" : "a";
    const target = viewFor(targetSide);
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? target.defaultLineHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? target.scrollDOM.clientHeight : 1;
    const delta = chainedWheelDelta(event.deltaY * unit, extentOf(source), extentOf(target));
    if (!delta) return false;
    event.preventDefault();
    claim(targetSide, true);
    target.scrollDOM.scrollTop += delta;
    return true;
  };
  const listeners: Array<() => void> = [];
  for (const side of ["a", "b"] as const) {
    const scrollDOM = viewFor(side).scrollDOM;
    const scroll = () => onScroll(side);
    const userInput = () => claim(side, true);
    const wheel = (event: WheelEvent) => {
      if (!chainWheel(side, event)) claim(side, true);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) claim(side, true);
    };
    scrollDOM.addEventListener("scroll", scroll, { passive: true });
    scrollDOM.addEventListener("wheel", wheel, { passive: false });
    scrollDOM.addEventListener("touchstart", userInput, { passive: true });
    scrollDOM.addEventListener("pointerdown", userInput, { passive: true });
    scrollDOM.addEventListener("keydown", keyboard);
    listeners.push(() => {
      scrollDOM.removeEventListener("scroll", scroll);
      scrollDOM.removeEventListener("wheel", wheel);
      scrollDOM.removeEventListener("touchstart", userInput);
      scrollDOM.removeEventListener("pointerdown", userInput);
      scrollDOM.removeEventListener("keydown", keyboard);
    });
    const rail = railFor(side);
    listeners.push(installRailInput(rail, viewFor(side), () => claim(side, true)));
  }
  const resize = new ResizeObserver(updateRails);
  resize.observe(split.dom);
  resize.observe(split.a.scrollDOM);
  resize.observe(split.b.scrollDOM);
  updateRails();
  return {
    beginProgramEpoch,
    write,
    updateRails,
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      listeners.forEach((remove) => remove());
    }
  };
}

function createSplitView(
  parent: HTMLElement,
  left: string,
  right: string,
  diffDocument: DiffDocument,
  shared: Extension[],
  highlight: "words" | "lines",
  collapsed: boolean,
  alignChanges: boolean,
  initialRatio: number,
  onLayoutChange: (ratio: number, leftWidth: number) => void,
  onPositionChange: (position: number, total: number) => void,
  pool: EditorPool = {}
): SplitController {
  const root = document.createElement("div");
  root.className = "oris-split-view";
  root.dataset.alignmentEnabled = String(alignChanges);
  root.dataset.alignmentReady = String(!alignChanges);
  const editorRoot = document.createElement("div");
  editorRoot.className = "oris-split-editors";
  const leftRail = createRail("a", "oris-left-editor");
  const rightRail = createRail("b", "oris-right-editor");
  const paneA = document.createElement("div");
  paneA.className = "oris-split-pane left";
  const paneB = document.createElement("div");
  paneB.className = "oris-split-pane right";
  const separator = document.createElement("div");
  separator.className = "diff-pane-resizer";
  separator.setAttribute("role", "separator");
  separator.setAttribute("aria-label", "调整左右 Diff 宽度");
  separator.setAttribute("aria-orientation", "vertical");
  separator.tabIndex = 0;
  editorRoot.append(leftRail.rail, paneA, separator, paneB, rightRail.rail);
  root.append(editorRoot);
  parent.append(root);
  const chunks = diffDocument.hunks.map((change) => new Change(change.fromA, change.toA, change.fromB, change.toB));
  root.dataset.leftLength = String(left.length);
  root.dataset.rightLength = String(right.length);
  root.dataset.hunkCount = String(chunks.length);
  // 差异装饰随状态一起创建：换入文档后再 appendConfig 会让每个编辑器多一次重新配置与派发（每次派发都会读取 DOM 选区、强制布局）。
  const docA = textOf(left);
  const docB = textOf(right);
  // 块标题行（块级 widget）不放进初始状态，仍在挂载后派发：初始状态里就有上千个块级 widget 时，CodeMirror 的
  // viewportLineBlocks 会包含视口外的大量行块，行号栏按它建元素（1,813 块时约 5,000 个），布局反而慢一倍（lc5 阶段 3 实测）。
  const a = reuseOrCreate(pool.a, paneA, docA, [...shared, EditorView.decorations.of(buildSideDecorations(docA, chunks, diffDocument.changes, "a", highlight))]);
  const b = reuseOrCreate(pool.b, paneB, docB, [...shared, EditorView.decorations.of(buildSideDecorations(docB, chunks, diffDocument.changes, "b", highlight))]);
  pool.a = a;
  pool.b = b;
  a.dom.id = "oris-left-editor";
  b.dom.id = "oris-right-editor";
  const split: SplitView = {
    dom: root,
    editorRoot,
    paneA,
    paneB,
    a,
    b,
    chunks,
    rails: { a: leftRail.rail, b: rightRail.rail },
    boundaries: [{ a: boundaryY(a, 0), b: boundaryY(b, 0) }]
  };
  let visualController: ReturnType<typeof installSplitVisuals> | undefined;
  let scrollController: ReturnType<typeof installScrollAndRails> | undefined;
  let alignmentController: ReturnType<typeof installChangeAlignment> | undefined;
  const navigate = (index: number, focus = true) => {
    if (!chunks.length) return;
    const safeIndex = (index + chunks.length) % chunks.length;
    const chunk = chunks[safeIndex];
    const targets = [
      { side: "a" as const, view: a, pos: Math.min(chunk.fromA, a.state.doc.length) },
      { side: "b" as const, view: b, pos: Math.min(chunk.fromB, b.state.doc.length) }
    ];
    const positionTargets = (recordNavigation: boolean) => {
      const navigationEpoch = scrollController?.beginProgramEpoch() ?? Number(root.dataset.syncEpoch ?? "0") + 1;
      root.dataset.syncEpoch = String(navigationEpoch);
      if (recordNavigation) root.dataset.navigationEpoch = String(navigationEpoch);
      targets.forEach(({ side, view, pos }) => {
        if (recordNavigation) view.dispatch({ selection: { anchor: pos } });
        const hunkTop = alignedBoundary(split, side, pos, safeIndex, "top");
        scrollController?.write(side, hunkTop - view.scrollDOM.clientHeight / 3, navigationEpoch);
      });
    };
    positionTargets(focus);
    if (focus) b.contentDOM.focus({ preventScroll: true });
    onPositionChange(safeIndex + 1, chunks.length);
    alignmentController?.schedule(() => {
      positionTargets(false);
      scrollController?.updateRails();
      visualController?.scheduleDraw();
    });
    scrollController?.updateRails();
    visualController?.scheduleDraw();
  };
  visualController = installSplitVisuals(split, navigate);
  scrollController = installScrollAndRails(split, visualController, () => alignmentController?.schedule());
  const removeResize = installSplitResize(split, separator, initialRatio, onLayoutChange, visualController.scheduleMeasure);
  const collapse = collapsed ? installPairedCollapse(split) : undefined;
  alignmentController = alignChanges ? installChangeAlignment(split, visualController.scheduleMeasure) : undefined;
  onPositionChange(chunks.length ? 1 : 0, chunks.length);
  return {
    view: split,
    navigate,
    settleViewport(onComplete) {
      if (alignmentController) alignmentController.schedule(onComplete);
      else onComplete();
    },
    revealLine(side, line) {
      const view = side === "a" ? split.a : split.b;
      collapse?.reveal(side, view.state.doc.line(line).from);
      alignmentController?.schedule(); visualController?.scheduleMeasure(); scrollController?.updateRails();
    },
    expandAll() {
      const expanded = collapse?.expandAll() ?? 0;
      if (expanded) {
        alignmentController?.schedule();
        visualController?.scheduleMeasure();
        scrollController?.updateRails();
      }
      return expanded;
    },
    refreshLayout() {
      alignmentController?.schedule();
      visualController?.scheduleMeasure();
      scrollController?.updateRails();
    },
    destroy(keepViews = false) {
      alignmentController?.destroy();
      collapse?.destroy();
      removeResize();
      scrollController?.destroy();
      visualController?.destroy();
      if (keepViews) {
        a.dom.remove();
        b.dom.remove();
      } else {
        a.destroy();
        b.destroy();
      }
      root.remove();
    }
  };
}

function createSingleView(
  parent: HTMLElement,
  text: string,
  diffDocument: DiffDocument,
  shared: Extension[],
  presentation: Extract<DiffPresentation, { kind: "single" }>,
  onPositionChange: (position: number, total: number) => void,
  pool: EditorPool = {}
): SingleController {
  const root = document.createElement("div");
  root.className = `oris-single-view ${presentation.tone}`;
  root.dataset.singleSide = presentation.side;
  root.dataset.emptyFile = String(presentation.empty);
  const pane = document.createElement("div");
  pane.className = "oris-single-pane";
  const rail = createRail(presentation.side, "oris-single-editor");
  if (presentation.side === "a") root.append(rail.rail, pane);
  else root.append(pane, rail.rail);
  parent.append(root);

  const doc = textOf(text);
  const lineClass = presentation.tone === "inserted" ? "oris-inserted-line" : "oris-deleted-line";
  const lineDecorations = Array.from({ length: doc.lines }, (_, index) => Decoration.line({ class: lineClass }).range(doc.line(index + 1).from));
  const view = reuseOrCreate(pool.single, pane, doc, [...shared, EditorView.decorations.of(Decoration.set(lineDecorations))]);
  pool.single = view;
  view.dom.id = "oris-single-editor";

  if (presentation.empty) {
    const state = document.createElement("div");
    state.className = `oris-empty-file-state ${presentation.tone}`;
    state.setAttribute("role", "status");
    state.textContent = presentation.tone === "inserted" ? "新增空文件（0 字节）" : "删除空文件（0 字节）";
    pane.append(state);
  }

  const chunks = diffDocument.hunks.map((change) => new Change(change.fromA, change.toA, change.fromB, change.toB));
  const navigate = (index: number, focus = true) => {
    if (!chunks.length) return;
    const safeIndex = (index + chunks.length) % chunks.length;
    const chunk = chunks[safeIndex];
    const pos = Math.min(presentation.side === "a" ? chunk.fromA : chunk.fromB, view.state.doc.length);
    if (focus) view.dispatch({ selection: { anchor: pos } });
    const block = view.lineBlockAt(pos);
    view.scrollDOM.scrollTop = clampViewScroll(view, block.top - view.scrollDOM.clientHeight / 3);
    if (focus) view.contentDOM.focus({ preventScroll: true });
    onPositionChange(safeIndex + 1, chunks.length);
  };
  const markerChunks = chunks.length ? chunks : [new Change(0, 0, 0, 0)];
  const update = () => {
    updateRailViewport(rail.rail, view);
    renderRailMarkers(rail.rail, view, markerChunks, presentation.side, navigate, presentation.tone);
  };
  const scroll = () => updateRailViewport(rail.rail, view);
  view.scrollDOM.addEventListener("scroll", scroll, { passive: true });
  const removeRailInput = installRailInput(rail.rail, view, () => undefined);
  const resize = new ResizeObserver(update);
  resize.observe(root);
  resize.observe(view.scrollDOM);
  update();
  onPositionChange(chunks.length ? 1 : 0, chunks.length);

  return {
    view,
    chunks,
    navigate,
    destroy(keepViews = false) {
      resize.disconnect();
      removeRailInput();
      view.scrollDOM.removeEventListener("scroll", scroll);
      if (keepViews) view.dom.remove();
      else view.destroy();
      root.remove();
    }
  };
}

export interface DiffViewerHandle {
  goToLine(side: "left" | "right", line: number): void;
  navigate(direction: -1 | 1): void;
  navigateTo(index: number): void;
  /** “全部展开”：展开所有折叠的未变化内容，返回展开的区段数。 */
  expandAll(): number;
}

interface Props {
  readingKey: string;
  presentation: DiffPresentation;
  left: string;
  right: string;
  document: DiffDocument;
  mode: "split" | "unified";
  highlight: "words" | "lines";
  collapsed: boolean;
  wrap: boolean;
  alignChanges: boolean;
  onPositionChange(position: number, total: number): void;
  onSplitLayoutChange(ratio: number, leftWidth: number): void;
  /** 块操作标题行（V2-05）；为 null 时不显示（“全部”范围、历史阅读、不可操作的文件）。 */
  hunkHeaders?: HunkHeaders | null;
  onLineSelect?(selection: DiffLineSelection): void;
  selectedLine?: DiffLineSelection | null;
}

const DiffViewer = forwardRef<DiffViewerHandle, Props>(function DiffViewer(
  { readingKey, presentation, left, right, document, mode, highlight, collapsed, wrap, alignChanges, onPositionChange, onSplitLayoutChange, hunkHeaders = null, onLineSelect, selectedLine = null },
  ref
) {
  const host = useRef<HTMLDivElement>(null);
  const lineSelect = useRef(onLineSelect);
  lineSelect.current = onLineSelect;
  const hunkRef = useRef(hunkHeaders);
  hunkRef.current = hunkHeaders;
  /** 把块标题行放到右侧（并排）或统一视图编辑器中每个差异块的起点之前。 */
  const applyHunkHeaders = useRef(() => {});
  const runHunkAction = useRef((index: number, action: HunkHeaderAction["action"]) => hunkRef.current?.onAction(index, action)).current;
  applyHunkHeaders.current = () => {
    const current = runtime.current;
    const view = current.split?.view.b ?? current.unified;
    if (!view) return;
    const headers = hunkRef.current;
    // 挂载时已派发过同一份标题行：随后的 hunkHeaders effect 不再重复派发（重复派发会多一次选区读取、强制布局与重新对齐）。
    if (current.appliedHunkHeaders === headers) return;
    current.appliedHunkHeaders = headers;
    const chunks = current.split?.view.chunks ?? (current.unified ? getChunks(current.unified.state)?.chunks ?? [] : []);
    const decorations = hunkHeaderDecorations(view.state.doc, chunks, headers, runHunkAction);
    // 没有标题行、编辑器里也没有时不派发（每次派发都会让 CodeMirror 读取 DOM 选区）。
    if (!decorations.size && view.state.field(hunkHeaderField, false)?.size === 0) return;
    view.dispatch({ effects: setHunkHeaders.of(decorations) });
    current.split?.refreshLayout();
  };
  // 字号与配色直接订阅设置与当前方案（V2-06）：外观切换只重新渲染阅读器，不重新渲染整个 App。
  // 当前配色方案为 null（尚未加载）时沿用 V1 的 one-dark。
  const fontSize = useSettings(settings, (value) => value.appearance.fontSize);
  const scheme = useStore(activeScheme, (value) => value);
  const runtime = useRef<{ split?: SplitController; single?: SingleController; unified?: EditorView; position: number; appliedHunkHeaders?: HunkHeaders | null }>({ position: 0 });
  const splitRatio = useRef(0.5);
  /** 按阅读键保存的阅读位置（最近 32 个），切回同一文件时恢复。 */
  const savedViewports = useRef(new Map<string, { line: number; text: string; offset: number; left: number }[]>());
  const pool = useRef<EditorPool>({});
  // 配色与字号放在 Compartment 中：切换时 reconfigure，不重建编辑器（技术方案 §9.4）。
  const compartments = useRef<AppearanceCompartments>(createAppearanceCompartments());
  const appearance = useRef({ scheme, fontSize });
  appearance.current = { scheme, fontSize };
  const layoutKey = `${readingKey}:${presentation.kind === "single" ? `single-${presentation.side}` : "compare"}`;

  useImperativeHandle(ref, () => ({
    goToLine(side, line) {
      const current = runtime.current;
      const view = current.split ? (side === "left" ? current.split.view.a : current.split.view.b) : current.single?.view ?? current.unified;
      if (!view || !Number.isInteger(line) || line < 1 || line > view.state.doc.lines) return;
      if (current.split) current.split.revealLine(side === "left" ? "a" : "b", line);
      else if (current.unified) expandUnified(current.unified, line);
      const target = view.state.doc.line(line);
      view.dispatch({ selection: { anchor: target.from, head: target.to }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
    },
    expandAll() {
      const current = runtime.current;
      if (current.split) return current.split.expandAll();
      if (current.unified) return expandUnified(current.unified);
      return 0;
    },
    navigateTo(index) {
      const current = runtime.current;
      const chunks = current.split?.view.chunks ?? current.single?.chunks ?? (current.unified ? getChunks(current.unified.state)?.chunks ?? [] : []);
      if (!chunks.length) return;
      current.position = Math.max(0, Math.min(chunks.length - 1, index));
      if (current.split) {
        current.split.navigate(current.position);
        return;
      }
      if (current.single) {
        current.single.navigate(current.position);
        return;
      }
      const chunk = chunks[current.position];
      if (chunk && current.unified) current.unified.dispatch({ effects: EditorView.scrollIntoView(chunk.fromB, { y: "center" }) });
      onPositionChange(current.position + 1, chunks.length);
    },
    navigate(direction) {
      const current = runtime.current;
      const chunks = current.split?.view.chunks ?? current.single?.chunks ?? (current.unified ? getChunks(current.unified.state)?.chunks ?? [] : []);
      if (!chunks.length) return;
      current.position = (current.position + direction + chunks.length) % chunks.length;
      if (current.split) {
        current.split.navigate(current.position);
        return;
      }
      if (current.single) {
        current.single.navigate(current.position);
        return;
      }
      const chunk = chunks[current.position];
      const view = current.unified;
      if (!view) return;
      const anchor = Math.min(chunk.fromB, view.state.doc.length);
      view.dispatch({ selection: { anchor } });
      const block = view.lineBlockAt(anchor);
      view.scrollDOM.scrollTop = Math.max(0, block.top - (view.scrollDOM.clientHeight - block.height) / 2);
      view.contentDOM.focus({ preventScroll: true });
      onPositionChange(current.position + 1, chunks.length);
    }
  }));

  useEffect(() => {
    if (!host.current) return;
    const shared: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      javascript({ typescript: true }),
      EditorState.readOnly.of(true),
      // 统一视图折叠占位（@codemirror/merge 的 CollapseWidget）的中文文字，与并排视图一致。
      EditorState.phrases.of({ "$ unchanged lines": "展开 $ 行未变化内容" }),
      alignmentSpacers,
      hunkHeaderField,
      gutterWidthVar,
      collapsedRanges,
      searchHighlights,
      selectionHighlights,
      lineSelectionMarker,
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      EditorView.domEventHandlers({
        copy(event) {
          const selection = globalThis.getSelection()?.toString() ?? "";
          if (!selection || !event.clipboardData) return false;
          event.clipboardData.setData("text/plain", selection);
          event.preventDefault();
          return true;
        }
      }),
      DIFF_EDITOR_THEME,
      ...(wrap ? [EditorView.lineWrapping] : []),
      // 字号由宿主元素上的 --diff-font-size 决定（见下方 useLayoutEffect），不放进编辑器主题。
      ...(appearance.current.scheme
        ? appearanceExtensions(compartments.current, appearance.current.scheme, null)
        : [compartments.current.theme.of(oneDark), compartments.current.highlight.of([]), compartments.current.fontSize.of([])])
    ];
    const collapseUnchanged = collapsed ? { margin: 3, minSize: 5 } : undefined;
    const diffConfig = { override: () => document.changes.map((change) => new Change(change.fromA, change.toA, change.fromB, change.toB)) };
    let split: SplitController | undefined;
    let single: SingleController | undefined;
    let unified: EditorView | undefined;
    let readingSearch: ReturnType<typeof installReadingSearch> | undefined;
    if (presentation.kind === "single") {
      single = createSingleView(
        host.current,
        presentation.side === "a" ? left : right,
        document,
        shared,
        presentation,
        onPositionChange,
        pool.current
      );
      runtime.current = { single, position: 0 };
    } else if (mode === "split") {
      split = createSplitView(
        host.current, left, right, document, shared, highlight, collapsed, alignChanges, splitRatio.current,
        (ratio, leftWidth) => {
          splitRatio.current = ratio;
          onSplitLayoutChange(ratio, leftWidth);
        },
        onPositionChange,
        pool.current
      );
      runtime.current = { split, position: 0 };
    } else {
      unified = reuseOrCreate(pool.current.unified, host.current, right, [
        ...shared,
        unifiedMergeView({
          original: left,
          highlightChanges: highlight === "words",
          gutter: true,
          mergeControls: false,
          allowInlineDiffs: true,
          collapseUnchanged,
          diffConfig
        })
      ]);
      pool.current.unified = unified;
      runtime.current = { unified, position: 0 };
      const total = getChunks(unified.state)?.chunks.length ?? 0;
      onPositionChange(total ? 1 : 0, total);
    }
    const searchViews: ReadingSearchView[] = split
      ? [{ view: split.view.a, side: "left" }, { view: split.view.b, side: "right" }]
      : single ? [{ view: single.view, side: presentation.kind === "single" && presentation.side === "a" ? "left" : "right" }]
      : unified ? [{ view: unified, side: "unified" }] : [];
    // 先放块标题行再恢复阅读位置：标题行会改变上方内容的高度，顺序反过来会让阅读位置下移（V2-05）。
    applyHunkHeaders.current();
    const saved = savedViewports.current.get(layoutKey);
    let viewportFrame = 0;
    let disposed = false;
    if (saved) {
      const restore = () => {
        if (disposed) return;
        searchViews.forEach(({ view }, index) => {
          const anchor = saved[index]; if (!anchor) return;
          let number = Math.min(anchor.line, view.state.doc.lines);
          // Keep the visible text as anchor when lines were inserted/deleted above it.
          if (view.state.doc.line(number).text !== anchor.text) {
            for (let distance = 1; distance < view.state.doc.lines; distance++) {
              const candidates = [number + distance, number - distance];
              const match = candidates.find(n => n > 0 && n <= view.state.doc.lines && view.state.doc.line(n).text === anchor.text);
              if (match) { number = match; break; }
            }
          }
          view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(view.state.doc.line(number).from).top + anchor.offset);
          view.scrollDOM.scrollLeft = anchor.left;
        });
      };
      if (split) split.settleViewport(restore); else viewportFrame = requestAnimationFrame(restore);
    } else {
      // 首次打开文件，在块标题行挂载和视口测量后定位到第一处差异；自动定位只滚动，不抢走文件列表焦点。
      // 已有阅读快照时仍恢复原位置；无差异时保持文档顶部。
      viewportFrame = requestAnimationFrame(() => {
        if (disposed || runtime.current.position !== 0) return;
        if (split) split.navigate(0, false);
        else if (single) single.navigate(0, false);
        else if (unified) {
          const first = getChunks(unified.state)?.chunks[0];
          if (first) unified.dispatch({ effects: EditorView.scrollIntoView(Math.min(first.fromB, unified.state.doc.length), { y: "center" }) });
        }
      });
    }
    readingSearch = installReadingSearch(host.current, searchViews, split ? (onComplete) => split?.settleViewport(onComplete) : undefined);
    const removeLineSelection = installLineSelection(searchViews, selection => lineSelect.current?.(selection));
    const removeGoToLine = installGoToLine(host.current, searchViews, (entry, line) => {
      if (split) split.revealLine(entry.side === "left" ? "a" : "b", line);
      else if (unified) expandUnified(unified, line);
    }, selection => { highlightLineSelection(searchViews, selection); lineSelect.current?.(selection); });
    return () => {
      removeGoToLine();
      removeLineSelection();
      disposed = true;
      if (viewportFrame) cancelAnimationFrame(viewportFrame);
      const viewports = savedViewports.current;
      viewports.delete(layoutKey);
      viewports.set(layoutKey, searchViews.map(({ view }) => {
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
        const line = view.state.doc.lineAt(block.from);
        return { line: line.number, text: line.text, offset: view.scrollDOM.scrollTop - block.top, left: view.scrollDOM.scrollLeft };
      }));
      while (viewports.size > 32) viewports.delete(viewports.keys().next().value as string);
      readingSearch?.destroy();
      split?.destroy(true);
      single?.destroy(true);
      unified?.dom.remove();
      runtime.current = { position: 0 };
      if (host.current) host.current.replaceChildren();
    };
  }, [layoutKey, left, right, document, mode, highlight, collapsed, wrap, alignChanges, onPositionChange, onSplitLayoutChange, presentation]);

  useEffect(() => { applyHunkHeaders.current(); }, [hunkHeaders]);
  useEffect(() => {
    const current = runtime.current;
    const entries = current.split ? [{ view: current.split.view.a, side: "left" as const }, { view: current.split.view.b, side: "right" as const }]
      : current.single ? [{ view: current.single.view, side: presentation.kind === "single" && presentation.side === "a" ? "left" as const : "right" as const }]
      : current.unified ? [{ view: current.unified, side: "unified" as const }] : [];
    highlightLineSelection(entries, selectedLine);
  }, [selectedLine, layoutKey, document, mode, presentation]);
  // 指针移入或键盘聚焦阅读器时按需读取块映射。
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const intent = () => hunkRef.current?.onIntent();
    element.addEventListener("pointerenter", intent);
    element.addEventListener("focusin", intent);
    return () => { element.removeEventListener("pointerenter", intent); element.removeEventListener("focusin", intent); };
  }, []);
  const liveViews = () => {
    const views = pool.current;
    // 只处理挂在页面上的编辑器；复用池中暂时脱离页面的编辑器在下次复用时由 setState 带上当前外观。
    return [views.a, views.b, views.single, views.unified].filter((view): view is EditorView => !!view && view.dom.isConnected);
  };
  // 配色：只在方案真正变化时 reconfigure 主题与语法高亮（扩展实例按方案缓存）。
  const appliedScheme = useRef<Scheme | null>(null);
  useEffect(() => {
    if (appliedScheme.current === scheme) return;
    appliedScheme.current = scheme;
    reconfigureAppearance(liveViews(), compartments.current, scheme, null);
    const frame = requestAnimationFrame(() => runtime.current.split?.refreshLayout());
    return () => cancelAnimationFrame(frame);
  }, [scheme]);
  // 字号：宿主元素上的 CSS 变量在本次提交中生效，编辑器不派发任何事务，只重新测量（与网页字体加载后的处理相同）。
  // 每次 dispatch 都会让 CodeMirror 读取 DOM 选区并强制整页布局，字号切换时逐个编辑器 reconfigure 是主要开销。
  // V2-D58：滚动在文件中部时，同一像素位置在新字号下对应的行相差很远（13 → 14 px 时约 7%），CodeMirror 第一轮测量会按旧像素
  // 位置选出一片完全不同的视口并整片重绘，再按滚动锚点修正后第二次整片重绘。这里先按 CodeMirror 自己的锚点规则
  // （scrollAnchorAt：视口顶部那一行保持相同的像素偏移）给出滚动快照，第一轮就按该行选视口，阅读位置规则不变。
  // 在顶部、滚到底部、自动换行时保持原来的只测量（见 fontChangeScroll；阅读位置与优化前逐项一致，见 V2-D58 结果）。
  const appliedFontSize = useRef(fontSize);
  useLayoutEffect(() => {
    if (appliedFontSize.current === fontSize) return;
    appliedFontSize.current = fontSize;
    for (const view of liveViews()) {
      const { scrollTop, scrollHeight, clientHeight } = view.scrollDOM;
      if (fontChangeScroll({ scrollTop, scrollHeight, clientHeight, lineWrapping: view.lineWrapping }) === "snapshot") view.dispatch({ effects: view.scrollSnapshot() });
      else view.requestMeasure();
    }
    const frame = requestAnimationFrame(() => runtime.current.split?.refreshLayout());
    return () => cancelAnimationFrame(frame);
  }, [fontSize]);

  // 在主 effect 之后声明：卸载时先拆除控制器，再销毁复用池中的编辑器。
  useEffect(() => () => {
    const views = pool.current;
    for (const view of [views.a, views.b, views.single, views.unified]) {
      if (!view) continue;
      reattachObservers.get(view)?.disconnect();
      view.destroy();
    }
    pool.current = {};
  }, []);

  return <div className="diff-host" ref={host} aria-label="只读文件差异" style={{ "--diff-font-size": `${fontSize}px` } as CSSProperties} />;
});

export default DiffViewer;
