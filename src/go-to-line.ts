import { EditorView } from "@codemirror/view";
import { lineAtNode, type DiffLineSelection, type LineSelectionView } from "./diff-line-selection";
import { fitInViewport } from "./menu-position";

/** 独立行跳转面板；捕获 Ctrl/Cmd+G，阻止 WebView 打开浏览器查找栏。 */
export function installGoToLine(host: HTMLElement, entries: LineSelectionView[], reveal: (entry: LineSelectionView, line: number) => void, onSelect: (line: DiffLineSelection) => void) {
  const panel = document.createElement("form");
  panel.className = "oris-goto-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "跳转到行");
  const label = document.createElement("label"); label.textContent = "跳转到行";
  const input = document.createElement("input"); input.type = "text"; input.inputMode = "numeric"; input.autocomplete = "off"; input.setAttribute("aria-label", "目标行号");
  label.append(input);
  const hint = document.createElement("span"); hint.className = "oris-goto-hint"; hint.setAttribute("role", "status");
  const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "跳转";
  const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = "×"; dismiss.setAttribute("aria-label", "关闭行跳转");
  panel.append(label, hint, submit, dismiss); document.body.append(panel);
  let target = entries.at(-1)!;
  const focused = entries.map(entry => {
    const pick = () => { target = entry; };
    entry.view.contentDOM.addEventListener("focusin", pick); entry.view.contentDOM.addEventListener("pointerdown", pick);
    return () => { entry.view.contentDOM.removeEventListener("focusin", pick); entry.view.contentDOM.removeEventListener("pointerdown", pick); };
  });
  const range = () => `${target.side === "left" ? "左侧" : target.side === "right" ? "右侧" : "统一视图"} · 1–${target.view.state.doc.lines} 行`;
  const close = (focus = true) => { panel.hidden = true; panel.removeAttribute("role"); if (focus) target.view.contentDOM.focus({ preventScroll: true }); };
  const open = () => {
    // 行跳转与内容搜索相互独立；打开行跳转时收起已有搜索。
    const searchClose = host.querySelector<HTMLButtonElement>('.oris-search-panel:not([hidden]) [aria-label="关闭搜索"]');
    searchClose?.click();
    const selection = globalThis.getSelection();
    const selectedEntry = selection?.focusNode && entries.find(entry => entry.view.contentDOM.contains(selection.focusNode));
    if (selectedEntry) target = selectedEntry;
    const line = selection?.focusNode && lineAtNode(target, selection.focusNode, selection.focusOffset);
    input.value = String(line?.line ?? target.view.state.doc.lineAt(target.view.state.selection.main.head).number);
    hint.textContent = range(); hint.classList.remove("error"); panel.hidden = false; panel.setAttribute("role", "dialog");
    position();
    input.focus({ preventScroll: true }); input.select();
  };
  const position = () => {
    if (panel.hidden) return;
    const rect = host.getBoundingClientRect(), size = panel.getBoundingClientRect();
    const point = fitInViewport(rect.right - size.width - 12, rect.top + 6, size.width, size.height, window.innerWidth, window.innerHeight);
    panel.style.left = `${point.left}px`; panel.style.top = `${point.top}px`;
  };
  const submitLine = (event: Event) => {
    event.preventDefault();
    const text = input.value.trim(); const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1 || number > target.view.state.doc.lines) {
      hint.textContent = `请输入 1–${target.view.state.doc.lines} 的行号`; hint.classList.add("error"); position(); return;
    }
    const side = target.side === "left" ? "a" : "b";
    reveal(target, number);
    const pos = target.view.state.doc.line(number).from;
    close();
    target.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    onSelect({ side, line: number });
  };
  panel.addEventListener("submit", submitLine); dismiss.addEventListener("click", () => close());
  const key = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g" && !host.closest("[hidden]") && !document.querySelector(".dialog-overlay")) {
      event.preventDefault(); event.stopImmediatePropagation(); open();
    } else if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !panel.hidden) close(false);
  };
  document.addEventListener("keydown", key, true);
  window.addEventListener("resize", position);
  return () => { document.removeEventListener("keydown", key, true); window.removeEventListener("resize", position); focused.forEach(remove => remove()); panel.remove(); };
}
