import { useEffect, useRef, useState } from "react";
import type { AiPlan } from "./ai-api";
import { useSettings, type SettingsStore } from "./settings";

interface Props {
  settings: SettingsStore;
  onClose(): void;
  onGenerate(description: string, requestId: string): Promise<AiPlan>;
  onCancelGeneration(requestId: string): Promise<void>;
  onCommit(plan: AiPlan): Promise<boolean>;
}

export default function AiCommitDialog({ settings, onClose, onGenerate, onCancelGeneration, onCommit }: Props) {
  const direct = useSettings(settings, (s) => s.ai.directCommit);
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState<AiPlan | null>(null);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "generating" | "committing">("idle");
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingRequest = useRef<string | null>(null);
  const closed = useRef(false);
  const dismiss = () => {
    if (phase === "committing") return;
    closed.current = true;
    if (pendingRequest.current) void onCancelGeneration(pendingRequest.current).catch(() => {});
    onClose();
  };
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); dismiss(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  useEffect(() => () => { closed.current = true; if (pendingRequest.current) void onCancelGeneration(pendingRequest.current).catch(() => {}); }, [onCancelGeneration]);
  const resize = () => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = `${Math.min(input.current.scrollHeight, 220)}px`; } };
  const commit = async (draft: AiPlan) => {
    if (!draft.message.trim() || draft.pathIds.length === 0) { setError("请填写提交信息并选择文件"); return; }
    setPhase("committing"); setError("");
    try { if (await onCommit(draft)) onClose(); else setError("提交未完成，请查看操作输出"); }
    catch (failure) { setError(String(failure)); }
    finally { if (!closed.current) setPhase("idle"); }
  };
  const confirm = async () => {
    if (phase !== "idle") return;
    if (plan) { await commit({ ...plan, message, pathIds: selected }); return; }
    if (!description.trim()) { setError("请输入想提交的内容"); return; }
    setPhase("generating"); setError("");
    const requestId = crypto.randomUUID();
    pendingRequest.current = requestId;
    try {
      const generated = await onGenerate(description, requestId);
      pendingRequest.current = null;
      if (closed.current) return;
      if (direct && generated.pathIds.length > 0 && !generated.selectionWarning) { await commit(generated); }
      else { setPlan(generated); setMessage(generated.message); setSelected(generated.pathIds); if (generated.selectionWarning) setError(generated.selectionWarning); }
    } catch (failure) { if (!closed.current) setError(String(failure)); }
    finally { pendingRequest.current = null; if (!closed.current) setPhase("idle"); }
  };
  return <div className="ai-commit-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <div className="ai-commit-dialog" role="dialog" aria-modal="true" aria-label="AI 提交">
      {!plan ? <div className="ai-commit-input-row"><div className="ai-commit-input-wrap"><textarea ref={input} aria-label="描述要提交的内容" rows={1} placeholder="描述这次要提交的内容…" value={description} readOnly={phase === "generating"} onChange={(event) => { setDescription(event.target.value); resize(); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void confirm(); } }}/>{phase === "generating" && <div className="ai-input-progress" role="status"><span className="ai-spinner"/>处理中...</div>}</div>
        <div className="ai-commit-actions"><label><input type="checkbox" checked={direct} disabled={phase !== "idle"} onChange={(event) => settings.update("ai", "directCommit", event.target.checked)}/> 直接提交</label><button type="button" className="primary ai-confirm-icon" aria-label="确认 AI 提交" title="确认（Ctrl/Cmd+Enter）" disabled={phase !== "idle"} onClick={() => void confirm()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></button></div>
      </div> : <div className="ai-commit-preview">
        <h3>检查 AI 提交</h3>
        <label htmlFor="ai-commit-message">提交信息</label><textarea id="ai-commit-message" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void confirm(); } }}/>
        <strong>提交文件 · {selected.length}</strong>
        <div className="ai-commit-files">{plan.candidates.map((file) => <label key={file.pathId}><input type="checkbox" checked={selected.includes(file.pathId)} onChange={(event) => { setError(""); setSelected((current) => event.target.checked ? [...current, file.pathId] : current.filter((id) => id !== file.pathId)); }}/>{file.displayPath}</label>)}</div>
        <div className="ai-commit-preview-actions"><button type="button" onClick={() => setPlan(null)} disabled={phase !== "idle"}>返回</button><button type="button" className="primary" disabled={phase !== "idle" || !selected.length || !message.trim()} onClick={() => void confirm()}>提交选中文件</button></div>
      </div>}
      {phase === "committing" && <p role="status"><span className="ai-spinner"/>正在提交…</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  </div>;
}
