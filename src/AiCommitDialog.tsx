import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AiPlan } from "./ai-api";
import type { AiAction } from "./ai-actions";
import { activePromptTag, configuredPromptTags, insertPromptTag, matchingPromptTags, type AiPromptTag } from "./ai-prompt-tags";
import { conversationContext, resolveAiRoute, hasAiCommand, sessionEvent, type AiConversationMessage, type AiResolvedRoute, type AiTurn } from "./ai-rules";
import { useSettings, type SettingsStore } from "./settings";
import AiMessage from "./AiMessage";
import ContextSelector from "./context-selection/ContextSelector";
import type { Attachment } from "./context-selection/model";
import ReviewResults from "./ai-review/ReviewResults";
import { reviewText, type ReviewResult, type ReviewFinding } from "./ai-review/model";
interface Props {
  settings: SettingsStore;
  project: { repoId: string; name: string; branch: string | null } | null;
  onClose(): void;
  onLocateReview?(result: ReviewResult, finding: ReviewFinding): Promise<void>;
  onGenerate(description: string, requestId: string, turn: AiTurn): Promise<AiPlan>;
  onPlanAction(description: string, requestId: string, turn: AiTurn): Promise<AiAction>;
  onExecuteAction(action: AiAction, turn: AiTurn): Promise<string>;
  onCancelGeneration(requestId: string): Promise<void>;
  onCommit(plan: AiPlan, turn: AiTurn): Promise<string>;
}
interface Message extends AiConversationMessage { id: string; route?: AiResolvedRoute; review?: ReviewResult }
export default function AiCommitDialog({ settings, project, onClose, onGenerate, onPlanAction, onExecuteAction, onCancelGeneration, onCommit, onLocateReview }: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([]), [selectorOpen,setSelectorOpen] = useState(false);
  const ai = useSettings(settings, v => v.ai), boundProject = useRef(project).current;
  const [description, setDescription] = useState(""), [messages, setMessages] = useState<Message[]>([]);
  const [caret, setCaret] = useState(0), [menuDismissed, setMenuDismissed] = useState(false), [activeTagIndex, setActiveTagIndex] = useState(0), [composing, setComposing] = useState(false);
  const [mainProfileId, setMainProfileId] = useState<string | null>(null), [sessionStarted, setSessionStarted] = useState(false);
  const primary = useRef<{ route: AiResolvedRoute; systemPrompt: string; commitPrompt: string } | null>(null);
  const transcript = useRef<string[]>([]), transcriptTrimmed = useRef(false);
  const record = (block: string) => {
    transcript.current.push(block);
    while (transcript.current.length > 48 || transcript.current.join("").length > 240000) { transcript.current.shift(); transcriptTrimmed.current = true; }
  };
  const [modelPicker, setModelPicker] = useState(false), [error, setError] = useState(""), [contextTrimmed, setContextTrimmed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "generating" | "executing">("idle");
  const [runningRoute, setRunningRoute] = useState<AiResolvedRoute | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), history = useRef<HTMLDivElement>(null), nearBottom = useRef(true);
  const promptMenu = useRef<HTMLDivElement>(null);
  const pendingRequest = useRef<string | null>(null), closed = useRef(false), epoch = useRef(0), busy = useRef(false);
  const tagMatch = composing ? null : activePromptTag(description, caret);
  const tagCandidates = tagMatch ? matchingPromptTags(tagMatch.query, configuredPromptTags(ai.ruleSet)) : [];
  const menuOpen = phase === "idle" && !menuDismissed && tagCandidates.length > 0;
  const selectedTagIndex = Math.min(activeTagIndex, tagCandidates.length - 1);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menu = promptMenu.current, selected = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !selected) return;
    // 只调整列表自身，不滚动祖先容器，也不转移输入框焦点。
    const top = menu.getBoundingClientRect().top + menu.clientTop, bottom = top + menu.clientHeight;
    const item = selected.getBoundingClientRect();
    if (item.top < top) menu.scrollTop -= top - item.top;
    else if (item.bottom > bottom) menu.scrollTop += item.bottom - bottom;
  }, [menuOpen, selectedTagIndex, tagMatch?.query, tagCandidates.length]);
  let resolved: AiResolvedRoute | null = null, mainRoute: AiResolvedRoute | null = primary.current?.route ?? null, routeError = "";
  try {
    mainRoute ??= { ...resolveAiRoute(ai, "", mainProfileId), ruleName: "会话主模型" };
    const command = hasAiCommand(description) ? resolveAiRoute(ai, description) : mainRoute;
    resolved = command.commandId ? command : mainRoute;
  } catch (e) { routeError = e instanceof Error ? e.message : String(e); }
  if (phase !== "idle" && runningRoute) resolved = runningRoute;
  const projectChanged = (project?.repoId ?? null) !== (boundProject?.repoId ?? null) || (project?.branch ?? null) !== (boundProject?.branch ?? null);
  useEffect(()=>{if(projectChanged)setSelectorOpen(false);},[projectChanged]);
  const chooseTag = (tag: AiPromptTag) => {
    if (!tagMatch) return;
    const next = insertPromptTag(description, tagMatch, tag);
    setDescription(next.text); setCaret(next.caret); setMenuDismissed(true); setActiveTagIndex(0);
    queueMicrotask(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  };
  const append = (role: Message["role"], content: string, route?: AiResolvedRoute, review?: ReviewResult) => {
    setMessages(v => [...v, { id: crypto.randomUUID(), role, content, route, review }]);
    record(sessionEvent(role, route?.commandId && role !== "user" ? JSON.stringify({ command: `@${route.commandTag}`, rule: route.ruleName, model: route.profile.model, configuration: route.profile.name, result: content }) : content));
  };
  const dismiss = () => { closed.current = true; epoch.current++; if (pendingRequest.current) void onCancelGeneration(pendingRequest.current).catch(() => {}); onClose(); };
  useEffect(() => {
    closed.current = false; input.current?.focus();
    return () => { closed.current = true; epoch.current++; if (pendingRequest.current) void onCancelGeneration(pendingRequest.current).catch(() => {}); };
  }, [onCancelGeneration]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape" || composing || selectorOpen) return; e.preventDefault(); e.stopPropagation(); if (menuOpen) setMenuDismissed(true); else if (modelPicker) setModelPicker(false); else dismiss(); };
    window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true);
  });
  useEffect(() => { if (nearBottom.current && history.current) history.current.scrollTop = history.current.scrollHeight; }, [messages, phase]);
  const stop = () => { if (phase !== "generating") return; epoch.current++; const request = pendingRequest.current; pendingRequest.current = null; busy.current = false; setPhase("idle"); if (request) void onCancelGeneration(request).catch(() => {}); append("operation", "已停止生成，本轮未执行应用操作。", runningRoute ?? undefined); };
  const submit = async () => {
    if (busy.current) return;
    if (!description.trim()) { setError("请输入要处理的任务"); return; }
    if (description.length > 10000) { setError("本轮输入不能超过 10,000 字符"); return; }
    if (projectChanged) { setError("项目或分支已切换，请关闭并重新打开对话"); return; }
    const snapshot = settings.get().ai;
    let route: AiResolvedRoute; try {
      const session = primary.current ?? { route: { ...resolveAiRoute(snapshot, "", mainProfileId), ruleName: "会话主模型" }, systemPrompt: snapshot.prompts.commandCenter, commitPrompt: snapshot.prompts.describedCommit };
      const command = hasAiCommand(description) ? resolveAiRoute(snapshot, description) : session.route;
      route = command.commandId ? command : session.route;
      primary.current = session; setSessionStarted(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    if (["review","explain"].includes(route.commandId ?? "")) route = { ...route, mode: "answer" };
    const turn: AiTurn = { route, ...conversationContext(messages.map(({ role, content }) => ({ role, content }))), repoId: boundProject?.repoId ?? null, branch: boundProject?.branch ?? null,
      systemPrompt: route.commandId ? snapshot.prompts.commandCenter : primary.current!.systemPrompt, commitPrompt: route.commandId ? snapshot.prompts.describedCommit : primary.current!.commitPrompt,
      attachments };
    const text = description.trim(), requestId = crypto.randomUUID(), generation = ++epoch.current;
    const valid = () => !closed.current && generation === epoch.current;
    busy.current = true; pendingRequest.current = requestId; setRunningRoute(route); setPhase("generating"); setError(""); setContextTrimmed(route.commandId ? turn.historyTruncated : transcriptTrimmed.current); nearBottom.current = true; append("user", text, route);
    setDescription(""); setCaret(0); setActiveTagIndex(0); setMenuDismissed(true);
    if (!route.commandId) turn.sessionTranscript = transcript.current.join("");
    try {
      const action = await onPlanAction(text, requestId, turn);
      if (!valid()) return;
      pendingRequest.current = null;
      if (turn.requestTranscript) record(turn.requestTranscript);
      if (action.kind === "answer") { append(route.commandId ? "tool" : "assistant", action.review ? reviewText(action.review) : action.message, route, action.review); return; }
      if (route.mode === "answer") throw new Error("当前指令只允许回答，已阻止模型提出的应用操作");
      append(route.commandId ? "tool" : "assistant", action.summary, route);
      let outcome: string;
      if (action.kind === "commitSelected") {
        const commitRequestId = crypto.randomUUID(); pendingRequest.current = commitRequestId;
        const plan = await onGenerate(text, commitRequestId, turn);
        if (!valid()) return;
        pendingRequest.current = null;
        if (!plan.message.trim() || !plan.pathIds.length || plan.selectionWarning) throw new Error(plan.selectionWarning || "AI 未能确定可提交文件，请补充描述后重试");
        setPhase("executing"); outcome = await onCommit(plan, turn);
      } else { setPhase("executing"); outcome = await onExecuteAction(action, turn); }
      if (!valid()) return;
      append("operation", outcome || "操作已完成", route);
    } catch (e) { if (valid()) { const message = e instanceof Error ? e.message : String(e); setError(message); append("operation", `本轮未完成：${message}`, route); } }
    finally { if (valid()) { pendingRequest.current = null; busy.current = false; setPhase("idle"); setMenuDismissed(false); } }
  };
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => setError("无法复制，请手动选择文本"));
  return <div className="ai-commit-overlay" onMouseDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div className="ai-commit-dialog ai-conversation" role="dialog" aria-modal="true" aria-label="AI 临时对话">
      <header className="ai-conversation-head"><div><strong>AI 对话</strong><small>{boundProject ? `${boundProject.name} · ${boundProject.branch ?? "未出生分支"}` : "未绑定项目"} · 关闭后不保留会话</small></div><button aria-label="关闭 AI 对话" onClick={dismiss}>×</button></header>
      <section className="ai-conversation-route" aria-label="本轮路由"><div className="ai-route-badges"><span>主会话：{mainRoute ? `${mainRoute.profile.name} · ${mainRoute.profile.model}` : "模型未配置"}</span><button onClick={() => setModelPicker(v => !v)} disabled={phase !== "idle"}>选择主模型 ▾</button></div>
        <small>{resolved?.commandId ? `一次性调用 @${resolved.commandTag} → ${resolved.ruleName} → ${resolved.profile.name} · ${resolved.profile.model} · ${resolved.mode === "answer" ? "仅回答" : "允许应用操作"}` : resolved ? "普通对话使用主模型，指令回复不切换主模型。" : routeError}</small>
        {modelPicker && <div className="ai-model-picker"><label>会话主模型<select aria-label="会话主模型" value={mainProfileId ?? "__route"} disabled={phase !== "idle" || sessionStarted} onChange={e => setMainProfileId(e.target.value === "__route" ? null : e.target.value)}><option value="__route">使用默认路由模型</option>{ai.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model || "未选择模型"}</option>)}</select></label><small>{sessionStarted ? "本会话的主模型已固定，更换模型请重新打开窗口。" : "首次发送后固定主模型与系统提示词。@指令按各自路由独立调用。"}</small></div>}
      </section>
      {selectorOpen && boundProject && !projectChanged && <ContextSelector repoId={boundProject.repoId} value={attachments} profile={ai.ruleSet.selectionProfileId ? ai.profiles.find(p=>p.id===ai.ruleSet.selectionProfileId)??null : resolved?.profile??mainRoute?.profile??null} onApply={items=>{setAttachments(items);setSelectorOpen(false);}} onClose={()=>setSelectorOpen(false)}/>}
      <div className="ai-conversation-messages" ref={history} role="log" aria-label="本次对话消息" aria-live="polite" onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {!messages.length && <p className="ai-conversation-empty">输入任务开始对话，可用 @ 选择指令。</p>}
        {messages.map(m => <article key={m.id} className={`ai-chat-message ${m.role}${m.role === "tool" ? " assistant" : ""}`}><div className="ai-chat-byline"><strong>{m.role === "user" ? "你" : m.role === "assistant" ? "主模型" : m.role === "tool" ? "指令结果" : "应用结果"}</strong>{m.route && <small>{m.route.ruleName} · {m.route.profile.name} · {m.route.profile.model}{m.route.overridden ? " · 手动覆盖" : ""}</small>}<button aria-label={`复制${m.role === "user" ? "输入" : "回复"}`} onClick={() => copy(m.content)}>复制</button></div>{m.review ? <ReviewResults result={m.review} onLocate={onLocateReview ? (result, finding) => { void onLocateReview(result, finding).then(() => { if (!closed.current) dismiss(); }, e => { if (!closed.current) setError(e instanceof Error ? e.message : String(e)); }); } : undefined}/> : <AiMessage text={m.content}/>}</article>)}
        {phase !== "idle" && <div className="ai-input-progress" role="status"><span className="ai-spinner"/>{phase === "generating" ? "AI 正在处理…" : "应用正在执行…"}</div>}
      </div>
      {projectChanged && <p className="settings-warning" role="status">项目或分支已切换，本会话不能继续操作，请重新打开。</p>}
      {contextTrimmed && <p className="settings-note">上下文达到上限，较早记录未发送；截断后会话前缀会变化。</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="ai-conversation-composer"><div className="ai-attachment-strip"><button aria-label="添加上下文附件" disabled={phase!=="idle"||projectChanged||!boundProject} onClick={()=>setSelectorOpen(true)}>＋</button>{(["files","commits"] as const).map(kind=>{const count=attachments.filter(x=>x.kind===kind).length;return count>0&&<span key={kind}><button disabled={phase!=="idle"||projectChanged} onClick={()=>setSelectorOpen(true)}>{kind==="files"?"文件差异":"提交"} {count}</button><button disabled={phase!=="idle"} aria-label={`删除${kind==="files"?"文件":"提交"}附件`} onClick={()=>setAttachments(v=>v.filter(x=>x.kind!==kind))}>×</button></span>;})}</div><div className="ai-commit-input-wrap"><textarea ref={input} aria-label="输入 AI 指令" aria-autocomplete="list" aria-expanded={menuOpen} aria-controls={menuOpen ? "ai-prompt-options" : undefined} aria-activedescendant={menuOpen ? `ai-prompt-option-${selectedTagIndex}` : undefined}
        rows={2} placeholder="与主模型对话，或输入 @ 执行一次性指令…" value={description} readOnly={phase !== "idle"}
        onChange={e => { setDescription(e.target.value); setCaret(e.target.selectionStart); setMenuDismissed(false); setActiveTagIndex(0); }} onClick={e => setCaret(e.currentTarget.selectionStart)} onSelect={e => setCaret(e.currentTarget.selectionStart)} onKeyUp={e => setCaret(e.currentTarget.selectionStart)} onCompositionStart={() => setComposing(true)} onCompositionEnd={e => { setComposing(false); setCaret(e.currentTarget.selectionStart); }}
        onKeyDown={e => { if (e.nativeEvent.isComposing || composing) return; if (menuOpen && !(e.ctrlKey || e.metaKey || e.altKey)) { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActiveTagIndex(i => (i + (e.key === "ArrowDown" ? 1 : tagCandidates.length - 1)) % tagCandidates.length); return; } if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseTag(tagCandidates[selectedTagIndex]); return; } } if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }}/>
        {menuOpen && <div ref={promptMenu} id="ai-prompt-options" className="ai-prompt-menu" role="listbox" aria-label="AI 指令候选"><div className="ai-prompt-menu-title">指令与路由</div>{tagCandidates.map((tag, index) => {
          let model = "待配置"; try { const r = resolveAiRoute(ai, tag.label); model = `${r.profile.name} · ${r.profile.model}`; } catch { /* 显示不可用状态 */ }
          return <button key={tag.id} id={`ai-prompt-option-${index}`} type="button" role="option" aria-selected={index === selectedTagIndex} className={index === selectedTagIndex ? "selected" : ""} onMouseDown={e => e.preventDefault()} onClick={() => chooseTag(tag)}><span>{tag.label}</span><small>{tag.detail}<br/>{model}</small></button>;
        })}</div>}
      </div><div className="ai-compose-footer"><small>Ctrl/Cmd + Enter 发送 · @指令独立调用</small><div className="ai-commit-actions">{phase === "generating" ? <button onClick={stop}>停止生成</button> : <button className="primary" aria-label="确认 AI 指令" disabled={phase !== "idle" || projectChanged} onClick={() => void submit()}>{phase === "executing" ? "执行中…" : "发送 ↑"}</button>}</div></div></div>
    </div>
  </div>;
}
