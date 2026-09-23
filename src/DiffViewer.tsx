import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { EditorState, StateEffect, StateField, Text, type Extension, type Range, type StateEffectType } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { Change, getChunks, unifiedMergeView } from "@codemirror/merge";
import { oneDark } from "@codemirror/theme-one-dark";
import { diffMarkerGeometry, mapDiffPosition, railViewportStartLine, type DiffBoundaryPair, type DiffSide } from "./diff-scroll";
import type { DiffPresentation } from "./diff-presentation";
import { collectQueryMatches, createReadingQuery, type ReadingSearchOptions, type TextMatch } from "./search-model";
import type { DiffDocument } from "./types";

const DIFF_SEPARATOR_WIDTH = 56;
const DIFF_RAIL_WIDTH = 24;
const DIFF_PANE_MIN_WIDTH = 180;

type AlignmentTone = "neutral" | "modified" | "inserted" | "deleted";

interface AlignmentSpacerSpec {
  pos: number;
  height: number;
  side: number;
  tone: AlignmentTone;
  role: "prefix" | "body";
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
  navigate(index: number): void;
  settleViewport(onComplete: () => void): void;
  destroy(): void;
}

interface SingleController {
  view: EditorView;
  chunks: Change[];
  navigate(index: number): void;
  destroy(): void;
}

const alignmentLayouts = new WeakMap<SplitView, { a: AlignmentSpacerSpec[]; b: AlignmentSpacerSpec[] }>();

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

function alignedBoundary(
  split: SplitView,
  side: DiffSide,
  pos: number,
  chunkIndex: number,
  edge: "top" | "bottom"
) {
  const view = side === "a" ? split.a : split.b;
  const specs = alignmentLayouts.get(split)?.[side] ?? [];
  const samePositionOffset = specs.reduce((height, spec) => {
    if (spec.pos !== pos) return height;
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

  const roleHeight = (specs: AlignmentSpacerSpec[], chunkIndex: number, role: AlignmentSpacerSpec["role"]) =>
    specs.find((spec) => spec.chunkIndex === chunkIndex && spec.role === role)?.height ?? 0;
  const withRole = (
    specs: AlignmentSpacerSpec[], chunk: Change, chunkIndex: number, sideName: DiffSide,
    role: AlignmentSpacerSpec["role"], height: number
  ) => {
    const next = specs.filter((spec) => spec.chunkIndex !== chunkIndex || spec.role !== role);
    if (height > 0.5) {
      next.push({
        pos: role === "prefix"
          ? sideName === "a" ? chunk.fromA : chunk.fromB
          : sideName === "a" ? chunk.toA : chunk.toB,
        height,
        side: role === "prefix" ? -2 : -1,
        tone: role === "prefix" ? "neutral" : alignmentTone(chunk),
        role,
        chunkIndex
      });
    }
    return next;
  };
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
  const measure = () => {
    const expectedGeneration = generation;
    const finish = () => {
      split.dom.dataset.alignmentReady = "true";
      onGeometryChange();
      const callback = completion;
      completion = undefined;
      callback?.();
    };
    const maximumAlignmentError = () => split.chunks.reduce((maximum, chunk, chunkIndex) => {
      const topA = alignedBoundary(split, "a", chunk.fromA, chunkIndex, "top");
      const topB = alignedBoundary(split, "b", chunk.fromB, chunkIndex, "top");
      const bottomA = chunk.fromA === chunk.toA
        ? topA + roleHeight(currentA, chunkIndex, "body")
        : alignedBoundary(split, "a", chunk.toA, chunkIndex, "bottom");
      const bottomB = chunk.fromB === chunk.toB
        ? topB + roleHeight(currentB, chunkIndex, "body")
        : alignedBoundary(split, "b", chunk.toB, chunkIndex, "bottom");
      return Math.max(maximum, Math.abs(topA - topB), Math.abs(bottomA - bottomB));
    }, 0);
    const alignChunk = (chunkIndex: number, round: number) => {
      if (expectedGeneration !== generation) return;
      if (chunkIndex >= split.chunks.length) {
        finish();
        return;
      }
      const chunk = split.chunks[chunkIndex];
      const topA = alignedBoundary(split, "a", chunk.fromA, chunkIndex, "top");
      const topB = alignedBoundary(split, "b", chunk.fromB, chunkIndex, "top");
      const [prefixA, prefixB] = normalizedHeights(
        roleHeight(currentA, chunkIndex, "prefix"), roleHeight(currentB, chunkIndex, "prefix"), topA - topB
      );
      applySpecs(
        withRole(currentA, chunk, chunkIndex, "a", "prefix", prefixA),
        withRole(currentB, chunk, chunkIndex, "b", "prefix", prefixB)
      );
      afterEditorMeasure(expectedGeneration, () => {
        const alignedTopA = alignedBoundary(split, "a", chunk.fromA, chunkIndex, "top");
        const alignedTopB = alignedBoundary(split, "b", chunk.fromB, chunkIndex, "top");
        const bottomA = chunk.fromA === chunk.toA
          ? alignedTopA + roleHeight(currentA, chunkIndex, "body")
          : alignedBoundary(split, "a", chunk.toA, chunkIndex, "bottom");
        const bottomB = chunk.fromB === chunk.toB
          ? alignedTopB + roleHeight(currentB, chunkIndex, "body")
          : alignedBoundary(split, "b", chunk.toB, chunkIndex, "bottom");
        const [bodyA, bodyB] = normalizedHeights(
          roleHeight(currentA, chunkIndex, "body"), roleHeight(currentB, chunkIndex, "body"), bottomA - bottomB
        );
        applySpecs(
          withRole(currentA, chunk, chunkIndex, "a", "body", bodyA),
          withRole(currentB, chunk, chunkIndex, "b", "body", bodyB)
        );
        afterEditorMeasure(expectedGeneration, () => {
          if (chunkIndex + 1 < split.chunks.length) alignChunk(chunkIndex + 1, round);
          else if (round < 8 && maximumAlignmentError() > 0.5) alignChunk(0, round + 1);
          else finish();
        });
      });
    };
    alignChunk(0, 1);
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
    split.dom.dataset.alignmentGeneration = String(generation);
    split.dom.dataset.alignmentReady = "false";
    const expectedGeneration = generation;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      resetAndMeasure(expectedGeneration);
    }, 60);
  };
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
      for (const frame of frames) cancelAnimationFrame(frame);
      resize.disconnect();
      alignmentLayouts.delete(split);
      delete split.dom.dataset.alignmentReady;
      delete split.dom.dataset.alignmentGeneration;
    }
  };
}

function buildSideDecorations(view: EditorView, chunks: Change[], changes: DiffDocument["changes"], side: DiffSide, highlight: "words" | "lines") {
  const ranges: Range<Decoration>[] = [];
  for (const chunk of chunks) {
    const from = side === "a" ? chunk.fromA : chunk.fromB;
    const to = side === "a" ? chunk.toA : chunk.toB;
    if (from === to) continue;
    const tone = sideTone(chunk, side);
    const firstLine = view.state.doc.lineAt(Math.min(from, view.state.doc.length)).number;
    const lastPosition = Math.max(from, Math.min(view.state.doc.length, to) - 1);
    const lastLine = view.state.doc.lineAt(lastPosition).number;
    for (let line = firstLine; line <= lastLine; line += 1) {
      ranges.push(Decoration.line({ class: `oris-${tone}-line` }).range(view.state.doc.line(line).from));
    }
  }
  if (highlight === "words") {
    for (const change of changes) {
      const from = Math.min(view.state.doc.length, side === "a" ? change.fromA : change.fromB);
      const to = Math.min(view.state.doc.length, side === "a" ? change.toA : change.toB);
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

  const dispatchDecorations = (view: EditorView, effect: StateEffectType<DecorationSet>, ranges: Range<Decoration>[]) => {
    view.dispatch({ effects: effect.of(Decoration.set(ranges, true)) });
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
      dispatchDecorations(entry.view, setSearchHighlights, searchRanges);
      dispatchDecorations(entry.view, setSelectionHighlights, selectionRanges);
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
  };
  update();
  return () => {
    split.a.dispatch({ effects: setCollapsedRanges.of(Decoration.none) });
    split.b.dispatch({ effects: setCollapsedRanges.of(Decoration.none) });
  };
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
  markers.append(viewport);
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
  const clamp = (width: number) => {
    const available = availableWidth();
    const minimum = Math.min(DIFF_PANE_MIN_WIDTH, available / 2);
    return Math.min(Math.max(minimum, width), Math.max(minimum, available - minimum));
  };
  const applyWidth = (width: number, remember = true) => {
    const next = Math.round(clamp(width));
    if (next !== leftWidth) {
      leftWidth = next;
      split.editorRoot.style.setProperty("--diff-left-width", `${next}px`);
      split.a.requestMeasure();
      split.b.requestMeasure();
      onGeometryChange();
    }
    if (remember && availableWidth() > 0) ratio = next / availableWidth();
    onLayoutChange(ratio, next + DIFF_RAIL_WIDTH);
    separator.setAttribute("aria-valuemin", String(Math.round(Math.min(DIFF_PANE_MIN_WIDTH, availableWidth() / 2))));
    separator.setAttribute("aria-valuemax", String(Math.round(Math.max(0, availableWidth() - DIFF_PANE_MIN_WIDTH))));
    separator.setAttribute("aria-valuenow", String(next));
  };
  applyWidth(availableWidth() * ratio, false);
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
  const resize = new ResizeObserver(() => applyWidth(availableWidth() * ratio, false));
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
  const markers = rail.querySelector<HTMLElement>(".diff-overview-markers")!;
  const viewport = markers.querySelector<HTMLElement>(".diff-overview-viewport")!;
  markers.replaceChildren(viewport);
  const doc = view.state.doc;
  const deviceMinimum = Math.max(1, 1 / Math.max(1, window.devicePixelRatio));
  const occupied = new Map<string, { node: HTMLButtonElement; bottom: number }>();
  chunks.forEach((chunk, index) => {
    const from = side === "a" ? chunk.fromA : chunk.fromB;
    const to = side === "a" ? chunk.toA : chunk.toB;
    const tone = toneOverride ?? alignmentTone(chunk);
    const marker = diffMarkerGeometry(rail.clientHeight, lineBoundary(doc, from), lineBoundary(doc, to), doc.lines, deviceMinimum);
    const bucket = `${tone}:${Math.round(marker.top)}`;
    const existing = occupied.get(bucket);
    if (existing) {
      const bottom = Math.max(existing.bottom, marker.top + marker.height);
      existing.bottom = bottom;
      existing.node.style.height = `${Math.max(deviceMinimum, bottom - Number.parseFloat(existing.node.style.top))}px`;
      return;
    }
    const node = document.createElement("button");
    node.type = "button";
    node.className = `diff-overview-marker ${tone}`;
    node.style.top = `${marker.top}px`;
    node.style.height = `${marker.height}px`;
    node.dataset.hunkIndex = String(index);
    node.setAttribute("aria-label", `跳到第 ${index + 1} 个差异块`);
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      navigate(index);
    });
    markers.append(node);
    occupied.set(bucket, { node, bottom: marker.top + marker.height });
  });
}

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
  const measure = () => {
    measureFrame = 0;
    geometry = split.chunks.map((chunk, index) => {
      const aTop = alignedBoundary(split, "a", chunk.fromA, index, "top");
      const bTop = alignedBoundary(split, "b", chunk.fromB, index, "top");
      const aBottom = chunk.fromA === chunk.toA ? aTop : alignedBoundary(split, "a", chunk.toA, index, "bottom");
      const bBottom = chunk.fromB === chunk.toB ? bTop : alignedBoundary(split, "b", chunk.toB, index, "bottom");
      const layouts = alignmentLayouts.get(split);
      const bodyHeight = (side: DiffSide) => layouts?.[side]
        .filter((spec) => spec.chunkIndex === index && spec.role === "body")
        .reduce((height, spec) => height + spec.height, 0) ?? 0;
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
    split.boundaries = [{ a: boundaryY(split.a, 0), b: boundaryY(split.b, 0) }];
    split.chunks.forEach((chunk, index) => {
      split.boundaries.push({
        a: alignedBoundary(split, "a", chunk.fromA, index, "top"),
        b: alignedBoundary(split, "b", chunk.fromB, index, "top")
      });
      split.boundaries.push({
        a: alignedBoundary(split, "a", chunk.toA, index, "bottom"),
        b: alignedBoundary(split, "b", chunk.toB, index, "bottom")
      });
    });
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
  split.a.scrollDOM.addEventListener("scroll", scheduleDraw, { passive: true });
  split.b.scrollDOM.addEventListener("scroll", scheduleDraw, { passive: true });
  scheduleMeasure();
  return {
    scheduleDraw,
    scheduleMeasure,
    destroy() {
      if (drawFrame) cancelAnimationFrame(drawFrame);
      if (measureFrame) cancelAnimationFrame(measureFrame);
      resize.disconnect();
      mutation.disconnect();
      split.a.scrollDOM.removeEventListener("scroll", scheduleDraw);
      split.b.scrollDOM.removeEventListener("scroll", scheduleDraw);
      svg.remove();
      zeroLayer.remove();
    }
  };
}

function clampViewScroll(view: EditorView, value: number) {
  return Math.min(Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight), Math.max(0, value));
}

function updateRailViewport(rail: HTMLElement, view: EditorView) {
  const band = rail.querySelector<HTMLElement>(".diff-overview-viewport")!;
  const doc = view.state.doc;
  if (doc.length === 0) {
    band.style.top = "0px";
    band.style.height = `${rail.clientHeight}px`;
    band.dataset.lineFrom = "0";
    band.dataset.lineTo = "0";
    band.dataset.lineTotal = "0";
  } else {
    const viewportRect = view.scrollDOM.getBoundingClientRect();
    const topHeight = Math.max(0, Math.min(view.contentHeight, (viewportRect.top - view.documentTop) / view.scaleY));
    const bottomHeight = Math.max(topHeight, Math.min(view.contentHeight, (viewportRect.bottom - view.documentTop) / view.scaleY));
    const topBlock = view.lineBlockAtHeight(topHeight);
    const bottomBlock = view.lineBlockAtHeight(bottomHeight);
    const firstLine = Math.max(0, doc.lineAt(Math.min(doc.length, topBlock.from)).number - 1);
    const lastLine = Math.max(firstLine + 1, doc.lineAt(Math.min(doc.length, bottomBlock.to)).number);
    const top = rail.clientHeight * firstLine / doc.lines;
    const bottom = rail.clientHeight * Math.min(doc.lines, lastLine) / doc.lines;
    band.style.top = `${top}px`;
    band.style.height = `${Math.max(2, bottom - top)}px`;
    band.dataset.lineFrom = String(firstLine);
    band.dataset.lineTo = String(Math.min(doc.lines, lastLine));
    band.dataset.lineTotal = String(doc.lines);
  }
  const maximum = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
  rail.setAttribute("aria-valuemax", String(maximum));
  rail.setAttribute("aria-valuenow", String(Math.round(view.scrollDOM.scrollTop)));
  rail.setAttribute("aria-disabled", String(maximum <= 0));
}

function setViewFromRail(view: EditorView, rail: HTMLElement, pointerY: number, grabOffset: number) {
  const doc = view.state.doc;
  if (!doc.length) return;
  const band = rail.querySelector<HTMLElement>(".diff-overview-viewport")!;
  const lineFrom = Number(band.dataset.lineFrom ?? "0");
  const lineTo = Number(band.dataset.lineTo ?? String(lineFrom + 1));
  const visibleLines = Math.max(1, lineTo - lineFrom);
  const startLine = railViewportStartLine(
    rail.clientHeight,
    band.getBoundingClientRect().height,
    pointerY,
    grabOffset,
    doc.lines,
    visibleLines
  );
  const block = view.lineBlockAt(doc.line(Math.min(doc.lines, startLine + 1)).from);
  view.scrollDOM.scrollTop = clampViewScroll(view, block.top);
}

function installRailInput(rail: HTMLElement, view: EditorView, onUserInput: () => void) {
  const band = rail.querySelector<HTMLElement>(".diff-overview-viewport")!;
  let drag: { pointerId: number; grabOffset: number } | null = null;
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || rail.getAttribute("aria-disabled") === "true") return;
    onUserInput();
    const rect = band.getBoundingClientRect();
    drag = { pointerId: event.pointerId, grabOffset: event.clientY - rect.top };
    band.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  };
  const pointerMove = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = rail.getBoundingClientRect();
    setViewFromRail(view, rail, event.clientY - rect.top, drag.grabOffset);
  };
  const pointerEnd = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    if (band.hasPointerCapture(event.pointerId)) band.releasePointerCapture(event.pointerId);
  };
  const railPointer = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target !== rail && event.target !== rail.querySelector(".diff-overview-markers"))) return;
    onUserInput();
    const rect = rail.getBoundingClientRect();
    const bandHeight = band.getBoundingClientRect().height;
    setViewFromRail(view, rail, event.clientY - rect.top, bandHeight / 2);
    event.preventDefault();
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
  band.addEventListener("pointerdown", pointerDown);
  band.addEventListener("pointermove", pointerMove);
  band.addEventListener("pointerup", pointerEnd);
  band.addEventListener("pointercancel", pointerEnd);
  rail.addEventListener("pointerdown", railPointer);
  rail.addEventListener("keydown", railKey);
  return () => {
    band.removeEventListener("pointerdown", pointerDown);
    band.removeEventListener("pointermove", pointerMove);
    band.removeEventListener("pointerup", pointerEnd);
    band.removeEventListener("pointercancel", pointerEnd);
    rail.removeEventListener("pointerdown", railPointer);
    rail.removeEventListener("keydown", railKey);
  };
}

function installScrollAndRails(split: SplitView, onVisualChange: () => void, onUserViewportChange: () => void) {
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
  const updateRails = () => {
    updateRail("a");
    updateRail("b");
    onVisualChange();
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
    updateRails();
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
  const onScroll = (side: DiffSide) => {
    const token = tokens[side];
    const current = viewFor(side).scrollDOM.scrollTop;
    if (token && Math.abs(token.expected - current) <= 1) {
      delete tokens[side];
      updateRails();
      return;
    }
    if (side !== master) claim(side);
    scheduleSync(side);
    updateRails();
  };
  const listeners: Array<() => void> = [];
  for (const side of ["a", "b"] as const) {
    const scrollDOM = viewFor(side).scrollDOM;
    const scroll = () => onScroll(side);
    const userInput = () => claim(side, true);
    const keyboard = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) claim(side, true);
    };
    scrollDOM.addEventListener("scroll", scroll, { passive: true });
    scrollDOM.addEventListener("wheel", userInput, { passive: true });
    scrollDOM.addEventListener("touchstart", userInput, { passive: true });
    scrollDOM.addEventListener("pointerdown", userInput, { passive: true });
    scrollDOM.addEventListener("keydown", keyboard);
    listeners.push(() => {
      scrollDOM.removeEventListener("scroll", scroll);
      scrollDOM.removeEventListener("wheel", userInput);
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
  onPositionChange: (position: number, total: number) => void
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
  const a = new EditorView({ parent: paneA, doc: left, extensions: shared });
  const b = new EditorView({ parent: paneB, doc: right, extensions: shared });
  a.dom.id = "oris-left-editor";
  b.dom.id = "oris-right-editor";
  a.dispatch({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(buildSideDecorations(a, chunks, diffDocument.changes, "a", highlight))) });
  b.dispatch({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(buildSideDecorations(b, chunks, diffDocument.changes, "b", highlight))) });
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
  const navigate = (index: number) => {
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
    positionTargets(true);
    b.contentDOM.focus({ preventScroll: true });
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
  scrollController = installScrollAndRails(split, visualController.scheduleDraw, () => alignmentController?.schedule());
  const removeResize = installSplitResize(split, separator, initialRatio, onLayoutChange, visualController.scheduleMeasure);
  const removeCollapse = collapsed ? installPairedCollapse(split) : undefined;
  alignmentController = alignChanges ? installChangeAlignment(split, visualController.scheduleMeasure) : undefined;
  onPositionChange(chunks.length ? 1 : 0, chunks.length);
  return {
    view: split,
    navigate,
    settleViewport(onComplete) {
      if (alignmentController) alignmentController.schedule(onComplete);
      else onComplete();
    },
    destroy() {
      alignmentController?.destroy();
      removeCollapse?.();
      removeResize();
      scrollController?.destroy();
      visualController?.destroy();
      a.destroy();
      b.destroy();
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
  onPositionChange: (position: number, total: number) => void
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

  const view = new EditorView({ parent: pane, doc: text, extensions: shared });
  view.dom.id = "oris-single-editor";
  const lineClass = presentation.tone === "inserted" ? "oris-inserted-line" : "oris-deleted-line";
  const lineDecorations = Array.from({ length: view.state.doc.lines }, (_, index) =>
    Decoration.line({ class: lineClass }).range(view.state.doc.line(index + 1).from)
  );
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(Decoration.set(lineDecorations))) });

  if (presentation.empty) {
    const state = document.createElement("div");
    state.className = `oris-empty-file-state ${presentation.tone}`;
    state.setAttribute("role", "status");
    state.textContent = presentation.tone === "inserted" ? "新增空文件（0 字节）" : "删除空文件（0 字节）";
    pane.append(state);
  }

  const chunks = diffDocument.hunks.map((change) => new Change(change.fromA, change.toA, change.fromB, change.toB));
  const navigate = (index: number) => {
    if (!chunks.length) return;
    const safeIndex = (index + chunks.length) % chunks.length;
    const chunk = chunks[safeIndex];
    const pos = Math.min(presentation.side === "a" ? chunk.fromA : chunk.fromB, view.state.doc.length);
    view.dispatch({ selection: { anchor: pos } });
    const block = view.lineBlockAt(pos);
    view.scrollDOM.scrollTop = clampViewScroll(view, block.top - view.scrollDOM.clientHeight / 3);
    view.contentDOM.focus({ preventScroll: true });
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
    destroy() {
      resize.disconnect();
      removeRailInput();
      view.scrollDOM.removeEventListener("scroll", scroll);
      view.destroy();
      root.remove();
    }
  };
}

export interface DiffViewerHandle {
  navigate(direction: -1 | 1): void;
  navigateTo(index: number): void;
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
  fontSize: number;
  dark: boolean;
  alignChanges: boolean;
  onPositionChange(position: number, total: number): void;
  onSplitLayoutChange(ratio: number, leftWidth: number): void;
}

const DiffViewer = forwardRef<DiffViewerHandle, Props>(function DiffViewer(
  { readingKey, presentation, left, right, document, mode, highlight, collapsed, wrap, fontSize, dark, alignChanges, onPositionChange, onSplitLayoutChange },
  ref
) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ split?: SplitController; single?: SingleController; unified?: EditorView; position: number }>({ position: 0 });
  const splitRatio = useRef(0.5);
  const savedViewport = useRef<{ key: string; sides: { line: number; text: string; offset: number; left: number }[] } | null>(null);
  const layoutKey = `${readingKey}:${presentation.kind === "single" ? `single-${presentation.side}` : "compare"}`;

  useImperativeHandle(ref, () => ({
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
      alignmentSpacers,
      collapsedRanges,
      searchHighlights,
      selectionHighlights,
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
      EditorView.theme({
        "&": { fontSize: `${fontSize}px`, height: "100%" },
        ".cm-scroller": { fontFamily: "JetBrains Mono, Cascadia Code, SFMono-Regular, Consolas, monospace" },
        ".cm-content": { caretColor: "transparent" }
      }),
      ...(wrap ? [EditorView.lineWrapping] : []),
      ...(dark ? [oneDark] : [])
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
        onPositionChange
      );
      runtime.current = { single, position: 0 };
    } else if (mode === "split") {
      split = createSplitView(
        host.current, left, right, document, shared, highlight, collapsed, alignChanges, splitRatio.current,
        (ratio, leftWidth) => {
          splitRatio.current = ratio;
          onSplitLayoutChange(ratio, leftWidth);
        },
        onPositionChange
      );
      runtime.current = { split, position: 0 };
    } else {
      unified = new EditorView({
        parent: host.current,
        doc: right,
        extensions: [
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
        ]
      });
      runtime.current = { unified, position: 0 };
      const total = getChunks(unified.state)?.chunks.length ?? 0;
      onPositionChange(total ? 1 : 0, total);
    }
    const searchViews: ReadingSearchView[] = split
      ? [{ view: split.view.a, side: "left" }, { view: split.view.b, side: "right" }]
      : single ? [{ view: single.view, side: presentation.kind === "single" && presentation.side === "a" ? "left" : "right" }]
      : unified ? [{ view: unified, side: "unified" }] : [];
    const saved = savedViewport.current;
    if (saved?.key === layoutKey) {
      const restore = () => searchViews.forEach(({ view }, index) => {
        const anchor = saved.sides[index]; if (!anchor) return;
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
      if (split) split.settleViewport(restore); else requestAnimationFrame(restore);
    }
    readingSearch = installReadingSearch(host.current, searchViews, split ? (onComplete) => split?.settleViewport(onComplete) : undefined);
    return () => {
      savedViewport.current = { key: layoutKey, sides: searchViews.map(({ view }) => {
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
        const line = view.state.doc.lineAt(block.from);
        return { line: line.number, text: line.text, offset: view.scrollDOM.scrollTop - block.top, left: view.scrollDOM.scrollLeft };
      }) };
      readingSearch?.destroy();
      split?.destroy();
      single?.destroy();
      unified?.destroy();
      runtime.current = { position: 0 };
      if (host.current) host.current.replaceChildren();
    };
  }, [layoutKey, left, right, document, mode, highlight, collapsed, wrap, fontSize, dark, alignChanges, onPositionChange, onSplitLayoutChange, presentation]);

  return <div className="diff-host" ref={host} aria-label="只读文件差异" />;
});

export default DiffViewer;
