import { useEffect, useRef, useState } from "react";
import type { AiPlan } from "./ai-api";
import type { AiAction } from "./ai-actions";
import { activePromptTag, insertPromptTag, matchingPromptTags, type AiPromptTag } from "./ai-prompt-tags";

interface Props {
  onClose(): void;
  onGenerate(description: string, requestId: string): Promise<AiPlan>;
  onPlanAction(description: string, requestId: string): Promise<AiAction>;
  onExecuteAction(action: AiAction): Promise<boolean>;
  onCancelGeneration(requestId: string): Promise<void>;
  onCommit(plan: AiPlan): Promise<boolean>;
}

export default function AiCommitDialog({ onClose, onGenerate, onPlanAction, onExecuteAction, onCancelGeneration, onCommit }: Props) {
  const [description, setDescription] = useState("");
  const [caret, setCaret] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeTagIndex, setActiveTagIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "generating" | "executing">("idle");
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingRequest = useRef<string | null>(null);
  const closed = useRef(false);
  const tagMatch = composing ? null : activePromptTag(description, caret);
  const tagCandidates = tagMatch ? matchingPromptTags(tagMatch.query) : [];
  const menuOpen = phase === "idle" && answer === null && !menuDismissed && tagCandidates.length > 0;
  const selectedTagIndex = Math.min(activeTagIndex, tagCandidates.length - 1);

  const resize = () => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(input.current.scrollHeight, 220)}px`;
    }
  };
  const chooseTag = (tag: AiPromptTag) => {
    if (!tagMatch) return;
    const next = insertPromptTag(description, tagMatch, tag);
    setDescription(next.text); setCaret(next.caret); setMenuDismissed(true); setActiveTagIndex(0);
    const restoreCaret = () => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); resize(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restoreCaret);
    else queueMicrotask(restoreCaret);
  };
  const dismiss = () => {
    if (phase === "executing") return;
    closed.current = true;
    if (pendingRequest.current) void onCancelGeneration(pendingRequest.current).catch(() => {});
    onClose();
  };
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || composing) return;
      event.preventDefault();
      if (menuOpen) setMenuDismissed(true);
      else dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  useEffect(() => () => {
    closed.current = true;
    if (pendingRequest.current) void onCancelGeneration(pendingRequest.current).catch(() => {});
  }, [onCancelGeneration]);

  const submit = async () => {
    if (phase !== "idle") return;
    if (!description.trim()) { setError("请输入要执行的操作"); return; }
    setPhase("generating"); setError("");
    const requestId = crypto.randomUUID();
    pendingRequest.current = requestId;
    try {
      const action = await onPlanAction(description, requestId);
      pendingRequest.current = null;
      if (closed.current) return;
      if (action.kind === "answer") { setAnswer(action.message); return; }
      if (action.kind === "commitSelected") {
        pendingRequest.current = requestId;
        const generated = await onGenerate(description, requestId);
        pendingRequest.current = null;
        if (closed.current) return;
        if (!generated.message.trim() || !generated.pathIds.length || generated.selectionWarning) {
          throw new Error(generated.selectionWarning || "AI 未能确定可提交文件，请补充描述后重试");
        }
        setPhase("executing");
        if (!await onCommit(generated)) throw new Error("提交未完成，请查看操作输出");
      } else {
        setPhase("executing");
        if (!await onExecuteAction(action)) throw new Error("操作未完成，请查看操作输出");
      }
      closed.current = true;
      onClose();
    } catch (failure) {
      if (!closed.current) setError(String(failure));
    } finally {
      pendingRequest.current = null;
      if (!closed.current) setPhase("idle");
    }
  };

  return <div className="ai-commit-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <div className="ai-commit-dialog" role="dialog" aria-modal="true" aria-label="AI">
      {answer === null ? <div className="ai-commit-input-row">
        <div className="ai-commit-input-wrap">
          <span className="ai-input-logo" aria-hidden="true">AI</span>
          <textarea ref={input} aria-label="输入 AI 指令" aria-autocomplete="list" aria-expanded={menuOpen}
            aria-controls={menuOpen ? "ai-prompt-options" : undefined}
            aria-activedescendant={menuOpen ? `ai-prompt-option-${selectedTagIndex}` : undefined}
            rows={1} placeholder="让 Oris 做什么？可用 @Git、@设置、@提交、@拉取…"
            value={description} readOnly={phase !== "idle"}
            onChange={(event) => { setDescription(event.target.value); setCaret(event.target.selectionStart); setMenuDismissed(false); setActiveTagIndex(0); resize(); }}
            onClick={(event) => { setCaret(event.currentTarget.selectionStart); setMenuDismissed(false); }}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => { setComposing(false); setCaret(event.currentTarget.selectionStart); }}
            onKeyDown={(event) => {
              if (menuOpen && !event.nativeEvent.isComposing && !(event.ctrlKey || event.metaKey || event.altKey)) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveTagIndex((current) => (current + (event.key === "ArrowDown" ? 1 : tagCandidates.length - 1)) % tagCandidates.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); chooseTag(tagCandidates[selectedTagIndex]); return; }
              }
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submit(); }
            }}/>
          {phase !== "idle" && <div className="ai-input-progress" role="status" aria-label={phase === "executing" ? "AI 正在执行" : "AI 正在处理"}><span className="ai-spinner"/></div>}
          {menuOpen && <div id="ai-prompt-options" className="ai-prompt-menu" role="listbox" aria-label="提示词候选">
            <div className="ai-prompt-menu-title">提示词包</div>
            {tagCandidates.map((tag, index) => <button key={tag.name} id={`ai-prompt-option-${index}`} type="button" role="option"
              aria-selected={index === selectedTagIndex} className={index === selectedTagIndex ? "selected" : ""}
              onMouseDown={(event) => event.preventDefault()} onClick={() => chooseTag(tag)}>
              <span>{tag.label}</span><small>{tag.detail}</small>
            </button>)}
          </div>}
        </div>
        <div className="ai-commit-actions"><button type="button" className="primary ai-confirm-icon" aria-label="确认 AI 指令"
          title="执行（Ctrl/Cmd+Enter）" disabled={phase !== "idle"} onClick={() => void submit()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg>
        </button></div>
      </div> : <div className="ai-commit-preview"><h3>AI 回复</h3><p>{answer}</p><div className="ai-commit-preview-actions"><button type="button" onClick={dismiss}>关闭</button></div></div>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  </div>;
}
