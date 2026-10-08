import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { lineAtNode, type DiffLineSelection, type LineSelectionView } from "./diff-line-selection";
import { lineKey, type FineLineNote } from "./fine-diff-model";

interface Marker { line: number; className: string; title: string }
const setFineMarkers = StateEffect.define<Marker[]>();
export const fineMarkers = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFineMarkers)) {
      return Decoration.set(effect.value.filter(m => m.line <= tr.state.doc.lines).map(m => Decoration.line({ class: m.className, attributes: { title: m.title } }).range(tr.state.doc.line(m.line).from)), true);
    }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: field => EditorView.decorations.from(field, value => value)
});
export function applyFineMarkers(entries: LineSelectionView[], selected: readonly DiffLineSelection[], notes: readonly FineLineNote[], moves: boolean, format: boolean) {
  const byLine = new Map<string, { className: string; title: string }>();
  for (const note of notes) {
    const className = [moves && note.move ? "oris-move-candidate" : "", format && note.format ? "oris-format-noise" : ""].filter(Boolean).join(" ");
    if (className) byLine.set(lineKey(note), { className, title: note.move && moves ? `移动候选 ${note.move}（文本相同；不证明语义等价）` : "格式噪声：仅淡化显示" });
  }
  for (const line of selected) { const old = byLine.get(lineKey(line)); byLine.set(lineKey(line), { className: `${old?.className ?? ""} oris-change-selected`, title: old?.title ?? "已选择变化行" }); }
  for (const entry of entries) {
    const side = entry.side === "left" ? "a" : "b";
    const markers = [...byLine].filter(([key]) => key.startsWith(`${side}:`)).map(([key, values]) => ({ line: Number(key.slice(2)), ...values }));
    if (markers.length || entry.view.state.field(fineMarkers, false)?.size) entry.view.dispatch({ effects: setFineMarkers.of(markers) });
  }
  return () => {
    for (const entry of entries.filter(e => e.side === "unified")) {
      for (const node of entry.view.contentDOM.querySelectorAll("div.cm-deletedLine,del.cm-deletedText")) {
        const line = lineAtNode(entry, node);
        const values = line && byLine.get(lineKey(line));
        const element = node as HTMLElement;
        for (const name of ["oris-move-candidate", "oris-format-noise", "oris-change-selected"]) element.classList.toggle(name, !!values?.className.includes(name));
        if (values) element.title = values.title; else element.removeAttribute("title");
      }
    }
  };
}
