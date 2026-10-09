import type { ReviewFinding, ReviewResult } from "./model";
import AiMessage from "../AiMessage";
export default function ReviewResults({ result, onLocate }: { result: ReviewResult; onLocate?: (result: ReviewResult, finding: ReviewFinding) => void }) {
  const c = result.context, i = c.inventory;
  return <section className="ai-review-results" aria-label="变更集审查结果">
    <small>范围：{c.ranges ? c.ranges.map(r=>`${r.kind} ${r.left?.slice(0,8)??"空树"} → ${r.right.slice(0,10)}`).join("；") : `${i.range.kind} · ${i.left?.slice(0,8)??"空树"} → ${i.right}`} · revision {i.revision.slice(0, 8)} · 上下文 {c.used}/{c.budget} 字节{c.truncated ? " · 已截断，审查不完整" : ""}</small>
    {c.warnings.map((warning, index) => <p key={index} className="settings-warning">{warning}</p>)}
    <AiMessage text={result.summary + "\n\n" + result.impact}/>
    <details><summary>实际读取来源（{c.sources.length}）</summary>{c.sources.map(s => <p key={s.id}>{s.file.path} · {s.side} · {s.endpoint} · 内容 {s.contentId.slice(0, 10)} · 行 {s.lines.map(l => l.line).join(", ")}{s.supplemental ? " · 显式补充" : ""}{s.truncated ? " · 截断" : ""}</p>)}</details>
    {result.findings.length === 0 && <p>未发现有明确代码依据的问题。</p>}
    {result.findings.map((f, index) => <article key={index} className="ai-review-finding"><strong>{f.invalid ? "未核实：" : ""}{f.title}</strong><p>触发：{f.trigger}<br/>影响：{f.impact}<br/>建议：{f.suggestion}</p><code>{f.evidence}</code><p>{f.invalid ?? `${f.source!.file.path} · ${f.source!.side} · ${f.line} 行`}</p><button disabled={!!f.invalid || !onLocate} onClick={() => onLocate?.(result, f)}>定位问题</button></article>)}
    <strong>提交组织建议（只读）</strong><p>同一文件混合改动需手动整理；本轮不会实施行级提交。</p>
    {result.commits.map((c, index) => <p key={index}>{c.title}：{c.paths.join("、")}<br/>{c.reason}</p>)}
    <p>未核实：{result.limitations || "未运行测试；模型回答不能证明测试通过。"}</p>
  </section>;
}
