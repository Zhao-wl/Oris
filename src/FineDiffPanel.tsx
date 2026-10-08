import { useEffect, useRef, useState } from "react";
import { previewLines, type HunkMap, type LinePreview, type LineSelectionRequest, type OperationRequest } from "./operations-api";
import { errorText } from "./error-message";
import type { ContentPair } from "./types";
import type { DiffLineSelection } from "./diff-line-selection";
import { lineKey, splitHunkLines, toLineSelections } from "./fine-diff-model";
import "./fine-diff.css";

interface Props {
  initialHunk?: number | null;
  pair: ContentPair; scope: "unstaged" | "staged"; texts: [string, string]; map: HunkMap | null;
  selected: DiffLineSelection[]; onSelect(lines: DiffLineSelection[]): void;
  blocked: string | null; onRun(request: OperationRequest): Promise<unknown>; onClose(): void;
}
export default function FineDiffPanel({ pair, scope, texts, map, selected, onSelect, blocked, onRun, onClose, initialHunk = null }: Props) {
  const [preview, setPreview] = useState<{ request: LineSelectionRequest; value: LinePreview } | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [blockPage, setBlockPage] = useState(initialHunk === null ? 0 : Math.floor(initialHunk / 20));
  const [unitPages, setUnitPages] = useState<Record<number, number>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>(initialHunk === null ? {} : { [initialHunk]: true });
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPreview(null); setError(""); setBusy(false); }, [selected, pair, map, scope]);
  useEffect(() => () => { generation.current++; }, []);
  const keys = new Set(selected.map(lineKey));
  const lines = [texts[0].split("\n"), texts[1].split("\n")];
  const toggle = (selection: DiffLineSelection[]) => {
    const remove = selection.every(l => keys.has(lineKey(l)));
    const next = new Map(selected.map(l => [lineKey(l), l]));
    selection.forEach(l => { if (remove) next.delete(lineKey(l)); else next.set(lineKey(l), l); }); onSelect([...next.values()]);
  };
  const prepare = async () => {
    if (!map || blocked || !selected.length || busy) return;
    const token = ++generation.current; setBusy(true); setError(""); setPreview(null);
    const request: LineSelectionRequest = { pathId: pair.pathId, contentIds: [pair.left.contentId, pair.right.contentId], expectedRevision: pair.revision, selections: toLineSelections(map, selected) };
    try { const value = await previewLines(pair.repoId, scope, request); if (token === generation.current) setPreview({ request, value }); }
    catch (reason) { if (token === generation.current) setError(errorText(reason)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  return <section className="fine-diff-panel" aria-label="行选区与块拆分">
    <div className="fine-diff-actions"><strong>行选区 · 已选 {selected.length} 行</strong><span className="spacer"/>
      <button disabled={!selected.length || busy} onClick={() => onSelect([])}>清空选区</button>
      <button disabled={!!blocked || !map || !selected.length || busy} title={blocked ?? undefined} onClick={() => void prepare()}>预览{scope === "staged" ? "取消暂存" : "暂存"}选区</button><button onClick={onClose}>收起选行</button></div>
    <p>Ctrl / Cmd 点击变化行切换选择，Shift 点击扩展同侧选区。替换两侧按行序配对，可独立选择：只选旧行、只选新增行和成对选择会产生不同结果，执行前请检查预览。</p>
    {blocked && <p role="status">行操作不可用：{blocked}</p>}{!map && !blocked && <p role="status">正在核验 Git 原始行映射…</p>}
    {map && !blocked && <div className="fine-diff-groups">{map.hunks.length > 20 && <div><button disabled={blockPage === 0} onClick={() => setBlockPage(p => p - 1)}>上一页块</button> {blockPage + 1} / {Math.ceil(map.hunks.length / 20)} <button disabled={(blockPage + 1) * 20 >= map.hunks.length} onClick={() => setBlockPage(p => p + 1)}>下一页块</button></div>}
    {map.hunks.slice(blockPage * 20, blockPage * 20 + 20).map((hunk, offset) => { const index = blockPage * 20 + offset; const count = Math.max(hunk.oldEnd - hunk.oldStart, hunk.newEnd - hunk.newStart); const page = unitPages[index] ?? 0; const open = expanded[index] ?? map.hunks.length === 1; return <details key={hunk.digest + index} open={open} onToggle={event => { const open = event.currentTarget.open; setExpanded(values => values[index] === open ? values : { ...values, [index]: open }); }}>
      <summary>Git 块 {index + 1} · {hunk.oldStart === hunk.oldEnd ? `旧侧插入点 ${hunk.oldStart}` : `旧行 ${hunk.oldStart + 1}–${hunk.oldEnd}`} / {hunk.newStart === hunk.newEnd ? `新侧删除点 ${hunk.newStart}` : `新行 ${hunk.newStart + 1}–${hunk.newEnd}`}</summary>
      {open && count > 200 && <div><button disabled={page === 0} onClick={() => setUnitPages(p => ({ ...p, [index]: page - 1 }))}>上一页行组</button> {page + 1} / {Math.ceil(count / 200)} <button disabled={(page + 1) * 200 >= count} onClick={() => setUnitPages(p => ({ ...p, [index]: page + 1 }))}>下一页行组</button></div>}
      {open && splitHunkLines(map, index, page * 200, page * 200 + 200).map((unit, offset) => { const i = page * 200 + offset; return <div className="fine-diff-unit" key={i}>
        <button onClick={() => toggle(unit)} aria-pressed={unit.every(l => keys.has(lineKey(l)))}>{unit.length === 2 ? "成对选择" : "选择此行"} {i + 1}</button>
        {unit.map(line => <label key={lineKey(line)}><input type="checkbox" checked={keys.has(lineKey(line))} onChange={() => toggle([line])} aria-label={`${line.side === "a" ? "旧" : "新"}行 ${line.line}`}/><span>{line.side === "a" ? "−" : "+"} {line.line}</span><code>{lines[line.side === "a" ? 0 : 1][line.line - 1] ?? ""}</code></label>)}
      </div>; })}
    </details>; })}</div>}
    {error && <p role="alert">{error}</p>}
    {preview && <div className="fine-diff-preview" role="region" aria-label="行补丁预览"><p>选区：旧行 {preview.value.removed} / 新增行 {preview.value.added}</p><p>{preview.value.note}</p><pre>{preview.value.patch}</pre>
      <button className="primary" disabled={!!blocked || busy} title={blocked ?? undefined} onClick={async () => { setBusy(true); try { await onRun({ kind: scope === "staged" ? "linesUnstage" : "linesStage", selection: preview.request, previewDigest: preview.value.digest }); setPreview(null); onSelect([]); } finally { setBusy(false); } }}>确认{scope === "staged" ? "取消暂存" : "暂存"}选区</button>
    </div>}
  </section>;
}
