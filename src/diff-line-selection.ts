import { Decoration, EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { getChunks, getOriginalDoc } from "@codemirror/merge";

export interface DiffLineSelection { side: "a" | "b"; line: number }
export interface LineSelectionView { view: EditorView; side: "left" | "right" | "unified" }

const setLineMarker = StateEffect.define<number | null>();
export const lineSelectionMarker = StateField.define({
  create: () => ({ line: null as number | null, decorations: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setLineMarker)) {
      const line = effect.value;
      return { line, decorations: line !== null && line > 0 && line <= transaction.state.doc.lines ? Decoration.set([Decoration.line({ class: "line-history-selected" }).range(transaction.state.doc.line(line).from)]) : Decoration.none };
    }
    return transaction.docChanged ? { line: null, decorations: Decoration.none } : value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

function mark(view: EditorView, line: number | null) {
  if (view.state.field(lineSelectionMarker, false)?.line !== line) view.dispatch({ effects: setLineMarker.of(line) });
}

export function highlightLineSelection(entries: LineSelectionView[], selection: DiffLineSelection | null) {
  for (const entry of entries) {
    const { view, side } = entry;
    for (const node of view.contentDOM.querySelectorAll(".cm-deletedLine.line-history-selected")) node.classList.remove("line-history-selected");
    if (!selection || (side !== "unified" && (side === "left" ? "a" : "b") !== selection.side)) { mark(view, null); continue; }
    if (side !== "unified" || selection.side === "b") { mark(view, selection.line); continue; }
    mark(view, null);
    for (const node of view.contentDOM.querySelectorAll("div.cm-deletedLine,del.cm-deletedText")) {
      const original = lineAtNode(entry, node);
      if (original?.side === "a" && original.line === selection.line) {
        const row = node.closest(".cm-line");
        if (row) mark(view, view.state.doc.lineAt(view.posAtDOM(row)).number);
        else node.classList.add("line-history-selected");
        break;
      }
    }
  }
}

/** 使用真实文档位置，排除对齐占位和折叠区域；统一视图的删除内容映射到原文。 */
export function lineAtNode(entry: LineSelectionView, node: Node, offset = 0): DiffLineSelection | null {
  const { view, side } = entry;
  const element = node instanceof Element ? node : node.parentElement;
  if (!element || !view.contentDOM.contains(element)) return null;
  const deletedChunk = element.closest(".cm-deletedChunk");
  if (side === "unified" && deletedChunk) {
    const row = element.closest("div.cm-deletedLine");
    if (!row) return null;
    const position = view.posAtDOM(deletedChunk);
    const chunk = getChunks(view.state)?.chunks.find(chunk => chunk.fromB === position);
    if (!chunk) return null;
    const index = [...deletedChunk.querySelectorAll("div.cm-deletedLine")].indexOf(row);
    return { side: "a", line: getOriginalDoc(view.state).lineAt(chunk.fromA).number + index };
  }
  const row = element.closest(".cm-line");
  if (!row) return null;
  // 同行嵌入的删除片段是一个原文 widget。它的位置对应 change.fromB。
  if (side === "unified" && element.closest("del.cm-deletedText")) {
    const deletion = element.closest("del.cm-deletedText")!;
    const position = view.posAtDOM(deletion);
    for (const chunk of getChunks(view.state)?.chunks ?? []) {
      const change = chunk.changes.find(change => chunk.fromB + change.fromB === position && change.toA > change.fromA);
      if (change) return { side: "a", line: getOriginalDoc(view.state).lineAt(chunk.fromA + change.fromA).number };
    }
    return null;
  }
  const position = node.nodeType === Node.TEXT_NODE ? view.posAtDOM(node, offset) : view.posAtDOM(row);
  return { side: side === "left" ? "a" : "b", line: view.state.doc.lineAt(position).number };
}

export function installLineSelection(entries: LineSelectionView[], onSelect: (selection: DiffLineSelection) => void) {
  let last = "";
  const selectNode = (node: Node, offset = 0) => {
    const entry = entries.find(entry => entry.view.contentDOM.contains(node));
    if (!entry) return;
    const selection = lineAtNode(entry, node, offset);
    if (!selection) return;
    const key = `${selection.side}:${selection.line}`;
    if (key !== last) { last = key; highlightLineSelection(entries, selection); onSelect(selection); }
  };
  const pointer = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.target instanceof Node)) return;
    const selection = globalThis.getSelection();
    if (selection && !selection.isCollapsed && selection.focusNode && entries.some(entry => entry.view.contentDOM.contains(selection.focusNode))) selectNode(selection.focusNode, selection.focusOffset);
    else selectNode(event.target);
  };
  const nativeSelection = () => {
    const selection = globalThis.getSelection();
    if (selection?.focusNode) selectNode(selection.focusNode, selection.focusOffset);
  };
  for (const { view } of entries) view.contentDOM.addEventListener("pointerup", pointer);
  globalThis.document.addEventListener("selectionchange", nativeSelection);
  return () => {
    for (const { view } of entries) view.contentDOM.removeEventListener("pointerup", pointer);
    globalThis.document.removeEventListener("selectionchange", nativeSelection);
    for (const { view } of entries) for (const node of view.contentDOM.querySelectorAll(".cm-deletedLine.line-history-selected")) node.classList.remove("line-history-selected");
  };
}
