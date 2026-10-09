import type { ReactNode } from "react";
import "./ai-input.css";

/** Shared live-AI entry: identity, submit, loading and cancellation. */
export default function AiInputFrame({children,prefix,busy=false,disabled=false,onSend,onStop,label="发送",stopLabel="停止生成",className=""}:{
  children:ReactNode;prefix?:ReactNode;busy?:boolean;disabled?:boolean;onSend():void;onStop?():void;label?:string;stopLabel?:string;className?:string;
}) {
  return <div className={`ai-input-frame ${prefix?"ai-input-with-prefix":""} ${className}`} aria-busy={busy}>
    <span className="ai-entry-mark" title="AI" aria-label="AI"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"/></svg></span>
    {prefix&&<div className="ai-entry-prefix">{prefix}</div>}
    {children}
    <button type="button" className="ai-entry-send" aria-label={busy&&onStop?stopLabel:label} title={busy?(onStop?stopLabel:"AI 正在处理"):label} disabled={busy?!onStop:disabled} onClick={busy?onStop:onSend}>
      {busy?<><span role="status" aria-label="AI 正在处理" className="ai-spinner"/>{onStop&&<span className="ai-stop-square" aria-hidden="true"/>}</>:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>}
      <span className="ai-sr-only">{busy&&onStop?stopLabel:label}</span>
    </button>
  </div>;
}
