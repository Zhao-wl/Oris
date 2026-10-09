import { useEffect, useRef, useState } from "react";
import { reviewInventory, type ReviewInventory, type ReviewRange, type ReviewRequest } from "./model";
import { errorText } from "../error-message";
export default function ReviewSelector({ repoId, disabled, onChange }: { repoId: string | null; disabled: boolean; onChange: (request: ReviewRequest | undefined) => void }) {
  const [kind, setKind] = useState<ReviewRange["kind"]>("workspace");
  const [commit, setCommit] = useState("HEAD"), [left, setLeft] = useState("refs/heads/main"), [right, setRight] = useState("HEAD");
  const [inventory, setInventory] = useState<ReviewInventory | null>(null), [selected, setSelected] = useState<string[]>([]), [extra, setExtra] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const change = useRef(onChange); change.current = onChange;
  const sequence = useRef(0);
  const load = async () => {
    const seq = ++sequence.current; setInventory(null); setError(""); setLoading(true); change.current(undefined);
    if (!repoId) { setLoading(false); return; }
    const range: ReviewRange = kind === "commit" ? { kind, commit } : kind === "branch" ? { kind, left, right } : { kind };
    try { const value = await reviewInventory(repoId, range); if (seq !== sequence.current) return; setInventory(value); setSelected(value.files.length <= 16 ? value.files.map(f => f.pathId) : []); }
    catch (e) { if (seq === sequence.current) setError(errorText(e)); }
    finally { if (seq === sequence.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [repoId, kind]);
  useEffect(() => {
    const contextPaths = extra.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    change.current(inventory && selected.length && selected.length + contextPaths.length <= 16 ? { range: inventory.range, identity: inventory.identity, pathIds: selected, contextPaths } : undefined);
  }, [inventory, selected, extra]);
  const invalidate = () => { sequence.current++; setInventory(null); change.current(undefined); };
  return <fieldset className="ai-review-selector" disabled={disabled}><legend>审查变更集 · 只读</legend>
    <label>审查范围 <select aria-label="审查范围" value={kind} onChange={e => { invalidate(); setKind(e.target.value as ReviewRange["kind"]); }}><option value="workspace">工作区（HEAD → 当前内容，含未跟踪）</option><option value="staged">暂存区（HEAD → index）</option><option value="commit">指定提交（第一父提交 → 提交；根提交为空树）</option><option value="branch">分支比较（左端点 → 右端点，直接比较）</option></select></label>
    {kind === "commit" && <label>提交（完整 OID 或引用）<input aria-label="审查提交" value={commit} onChange={e => { invalidate(); setCommit(e.target.value); }}/></label>}
    {kind === "branch" && <><label>左端点<input aria-label="审查左端点" value={left} onChange={e => { invalidate(); setLeft(e.target.value); }}/></label><label>右端点<input aria-label="审查右端点" value={right} onChange={e => { invalidate(); setRight(e.target.value); }}/></label></>}
    <button type="button" disabled={loading} onClick={() => void load()}>读取范围 / 刷新文件</button>
    {loading && <p role="status">正在读取审查范围…</p>}{error && <p role="alert">{error}</p>}
    {inventory && <><small>{inventory.left?.slice(0, 8) ?? "空树"} → {inventory.right} · {selected.length}/{inventory.totalFiles} 个变化文件 · 每轮含补充文件最多 16 个</small><div className="ai-review-files">{inventory.files.map(f => <label key={f.pathId}><input type="checkbox" checked={selected.includes(f.pathId)} onChange={e => setSelected(ids => e.target.checked ? [...ids, f.pathId] : ids.filter(id => id !== f.pathId))}/>{f.path}</label>)}</div>{inventory.totalFiles > inventory.files.length && <p>仅列出前 {inventory.files.length} 个文件，请缩小比较范围。</p>}</>}
    <label>补充调用方 / 配置 / 测试（仓库相对路径，每行一个）<textarea aria-label="审查补充文件" value={extra} onChange={e => setExtra(e.target.value)} rows={2}/></label><small>只发送勾选差异及显式补充内容；差异与原文预算 40,000 字节。超出预算会标记截断。</small>
  </fieldset>;
}
