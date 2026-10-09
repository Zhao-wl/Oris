import { attachmentEvidence } from "../context-selection/evidence";
import { budgetedAnswer, newContextMeter, type Attachment, type ContextLimits } from "../context-selection/model";
import { compactEvidence, CONTEXT_BUDGET, evidencePages, tokenEstimate } from "../context-selection/compression";
import { parseReview, type ReviewContext, type ReviewResult } from "./model";

/** Each source keeps its own request: commits/index/worktree are not interchangeable. */
function combine(contexts: ReviewContext[]): ReviewContext {
  const first = contexts[0];
  const ranges = contexts.flatMap(c => c.ranges ?? [{ kind: c.inventory.range.kind, left: c.inventory.left, right: c.inventory.right }]);
  return { ...first, sources: contexts.flatMap(c => c.sources), diff: "同一窗口内提供多份精确原文，联合核对调用方、配置、测试与行为；各来源保留自己的比较范围。",
    inventory: { ...first.inventory, files: [...new Map(contexts.flatMap(c => c.inventory.files).map(f => [f.pathId, f])).values()] },
    ranges: [...new Map(ranges.map(r => [JSON.stringify(r), r])).values()],
    used: contexts.reduce((n, c) => n + c.used, 0), truncated: contexts.some(c => c.truncated), warnings: [...new Set(contexts.flatMap(c => c.warnings))] };
}

/** Joint inference over bounded original-source windows, not summaries of separate files. */
export async function reviewAttachments(repoId: string, attachments: Attachment[], valid: () => boolean,
  answer: (context: unknown) => Promise<unknown>, promptCost: unknown, limits: ContextLimits = {}) {
  const meter = newContextMeter(limits), results: ReviewResult[] = [], warnings: string[] = [];
  const validators: (() => Promise<void>)[] = [];
  let buffer: ReviewContext[] = [], opened = 0, pagesRead = 0, fragments = 0, windows = 0, jointWindows = 0, stopped = false;
  const check = () => { if (!valid()) throw new Error("审查已取消"); };
  const maxWire = Math.min(CONTEXT_BUDGET.evidence, meter.window - tokenEstimate(promptCost) - 2500);
  if (maxWire < 1000) throw new Error("审查问题与提示词已占满单次上下文预算，请缩短输入或调整模型上限");
  const payload = (parts: ReviewContext[]) => ({ promptCost, wire: compactEvidence(combine(parts)) });
  const fitsWindow = (parts: ReviewContext[]) => tokenEstimate(payload(parts)) + 2000 <= meter.window && tokenEstimate(payload(parts).wire) <= maxWire;
  const fitsTask = (parts: ReviewContext[]) => meter.calls < CONTEXT_BUDGET.calls && meter.tokens + tokenEstimate(payload(parts)) + 2000 <= meter.task;
  const flush = async () => {
    if (!buffer.length) return;
    check();
    if (!fitsTask(buffer)) { stopped = true; return; }
    const context = combine(buffer), wire = compactEvidence(context);
    const response = await budgetedAnswer(meter, { promptCost, wire }, () => answer(wire)); check();
    if ((response as { kind?: string })?.kind !== "answer") throw new Error("分析指令只允许回答");
    results.push(parseReview((response as { review?: unknown }).review, context));
    fragments += buffer.length; windows++;
    if (new Set(context.sources.map(s => s.file.path)).size > 1) jointWindows++;
    buffer = [];
  };
  outer: for (const attachment of attachments) {
    check();
    if (meter.calls >= CONTEXT_BUDGET.calls || meter.tokens + 2000 >= meter.task) { stopped = true; break; }
    for await (const loaded of attachmentEvidence(repoId, attachment, valid)) {
      check(); validators.push(loaded.validate); pagesRead++; warnings.push(...loaded.context.warnings);
      const pages = evidencePages(loaded.context, Math.min(6800, maxWire - 500));
      for (const page of pages) {
        warnings.push(...page.warnings);
        if (!page.sources.length) continue;
        page.sources = page.sources.map(s => ({ ...s, id: `e${pagesRead}-${fragments + buffer.length}:${s.id}` }));
        if (buffer.length && !fitsWindow([...buffer, page])) { await flush(); if (stopped) break outer; }
        if (!fitsWindow([page])) throw new Error("原文片段超过审查单次预算，请调整模型上下文上限");
        if (!fitsTask([...buffer, page])) {
          await flush();
          if (stopped || !fitsTask([page])) { stopped = true; break outer; }
        }
        buffer.push(page);
      }
    }
    opened++;
  }
  await flush();
  for (const validate of validators) { check(); await validate(); } check();
  const coverage = `附件 ${attachments.length} 项；已遍历 ${opened} 项，读取 ${pagesRead} 个原文分页、分析 ${fragments} 个证据片段；联合审查 ${windows} 个窗口，其中 ${jointWindows} 个含多个文件；${stopped ? "累计预算耗尽，剩余内容未审查" : "附件遍历完成"}。`;
  if (!results.length) return { result: null, coverage: coverage + "\n" + [...new Set(warnings)].join("\n") };
  const limitation = windows > 1 ? "多个窗口分别联合审查，未做跨全部窗口的联合推理，可能遗漏远距离关联。" : "联合结论仅基于本窗口实际提供的原文，不代表全仓库或未读取依赖已检查。";
  const context = combine(results.map(r => r.context));
  context.budget = meter.task; context.used = meter.tokens; context.budgetKind = "estimatedTokens";
  context.truncated ||= stopped;
  context.warnings = [...new Set([...warnings, ...context.warnings, coverage, limitation])];
  const findings = [...new Map(results.flatMap(r => r.findings).map(f => [JSON.stringify([f.invalid ? f.sourceId : f.source?.file.pathId, f.source?.endpoint, f.source?.contentId, f.source?.side, f.line, f.title]), f])).values()];
  const commits = [...new Map(results.flatMap(r => r.commits).map(c => [JSON.stringify([c.title, [...c.paths].sort(), c.reason]), c])).values()];
  const result: ReviewResult = { context, summary: results.map(r => r.summary).join("\n"), impact: results.map(r => r.impact).filter(Boolean).join("\n"), findings, commits,
    limitations: [coverage, limitation, ...results.map(r => r.limitations)].filter(Boolean).join("\n") };
  return { result, coverage };
}
