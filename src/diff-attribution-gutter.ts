import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import type { AttributionRange } from "./history-api";
import { attributionAt } from "./file-attribution";
import { lineAtNode, type DiffLineSelection, type LineSelectionView } from "./diff-line-selection";

function label(range: AttributionRange) {
  return range.oid ? `${range.oid.slice(0, 8)}  ${range.author || ""}`.trim() : "未提交";
}

class AttributionMarker extends GutterMarker {
  constructor(readonly text: string, readonly description = text) { super(); }
  eq(other: AttributionMarker) { return this.text === other.text && this.description === other.description; }
  toDOM() {
    const node = document.createElement("span");
    node.textContent = this.text;
    node.title = this.description;
    return node;
  }
}

export function attributionGutter(ranges: readonly AttributionRange[], side: DiffLineSelection["side"], select: (line: DiffLineSelection) => void) {
  return gutter({
    class: "oris-attribution-gutter",
    lineMarker(view, block) {
      const line = view.state.doc.lineAt(block.from).number;
      const range = attributionAt(ranges, line);
      if (!range) return null;
      const full = label(range);
      const previous = attributionAt(ranges, line - 1);
      const atViewportStart = block.from === view.viewport.from;
      return new AttributionMarker(previous && previous.oid === range.oid && !atViewportStart ? "·" : full, full);
    },
    domEventHandlers: {
      click(view: EditorView, block) {
        const line = view.state.doc.lineAt(block.from).number;
        if (!attributionAt(ranges, line)) return false;
        select({ side, line });
        return true;
      }
    }
  });
}

// 统一视图保留的旧行由 CodeMirror 的差异部件绘制，不属于右侧文档的行号 gutter。
export function labelUnifiedDeletions(view: EditorView, ranges: readonly AttributionRange[]) {
  const entry: LineSelectionView = { view, side: "unified" };
  const refresh = () => {
    for (const node of view.contentDOM.querySelectorAll<HTMLElement>("div.cm-deletedLine, del.cm-deletedText")) {
      const old = lineAtNode(entry, node);
      const range = old?.side === "a" ? attributionAt(ranges, old.line) : undefined;
      const text = range ? label(range) : null;
      if (text && node.dataset.attribution !== text) node.dataset.attribution = text;
      else if (!text) delete node.dataset.attribution;
    }
  };
  refresh();
  const observer = new MutationObserver(refresh);
  observer.observe(view.contentDOM, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const node of view.contentDOM.querySelectorAll<HTMLElement>("[data-attribution]")) delete node.dataset.attribution;
  };
}
