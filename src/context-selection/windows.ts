import { attachmentSnapshotEvidence } from "./evidence";
import { budgetedAnswer, newContextMeter, type Attachment, type ContextLimits } from "./model";
import { compactEvidence, CONTEXT_BUDGET, evidencePages, tokenEstimate } from "./compression";
import type { ReviewContext } from "../ai-review/model";

/** Each source keeps its own request: commits/index/worktree are not interchangeable. */
export function combine(contexts: ReviewContext[]): ReviewContext {
  const first = contexts[0];
  const ranges = contexts.flatMap(c => c.ranges ?? [{ kind: c.inventory.range.kind, left: c.inventory.left, right: c.inventory.right }]);
  return { ...first, sources: contexts.flatMap(c => c.sources), diff: "同一窗口内提供多份精确原文，联合核对调用方、配置、测试与行为；各来源保留自己的比较范围。",
    inventory: { ...first.inventory, files: [...new Map(contexts.flatMap(c => c.inventory.files).map(f => [f.pathId, f])).values()] },
    ranges: [...new Map(ranges.map(r => [JSON.stringify(r), r])).values()],
    used: contexts.reduce((n, c) => n + c.used, 0), truncated: contexts.some(c => c.truncated), warnings: [...new Set(contexts.flatMap(c => c.warnings))] };
}

/** Joint inference over bounded original-source windows, not summaries of separate files. */
export async function withAttachmentEvidence<T>(repoId: string, attachments: Attachment[], valid: () => boolean,
  answer: (wire: unknown) => Promise<unknown>, interpret: (response: unknown, context: ReviewContext) => T, promptCost: unknown, limits: ContextLimits = {}) {
  const meter = newContextMeter(limits), results: T[] = [], warnings: string[] = [];
  const validators: (() => Promise<void>)[] = [];
  let buffer: ReviewContext[] = [], opened = 0, pagesRead = 0, fragments = 0, windows = 0, jointWindows = 0, stopped = false;
  const check = () => { if (!valid()) throw new Error("分析已取消"); };
  const maxWire = Math.min(CONTEXT_BUDGET.evidence, meter.window - tokenEstimate(promptCost) - 2500);
  if (maxWire < 1000) throw new Error("分析问题与提示词已占满单次上下文预算，请缩短输入或调整模型上限");
  const payload = (parts: ReviewContext[]) => ({ promptCost, wire: compactEvidence(combine(parts)) });
  const fitsWindow = (parts: ReviewContext[]) => tokenEstimate(payload(parts)) + 2000 <= meter.window && tokenEstimate(payload(parts).wire) <= maxWire;
  const fitsTask = (parts: ReviewContext[]) => meter.calls < CONTEXT_BUDGET.calls && meter.tokens + tokenEstimate(payload(parts)) + 2000 <= meter.task;
  const flush = async () => {
    if (!buffer.length) return;
    check();
    if (!fitsTask(buffer)) { stopped = true; return; }
    const context = combine(buffer), wire = compactEvidence(context);
    const response = await budgetedAnswer(meter, { promptCost, wire }, () => answer(wire)); check();
    results.push(interpret(response, context));
    fragments += buffer.length; windows++;
    if (new Set(context.sources.map(s => s.file.path)).size > 1) jointWindows++;
    buffer = [];
  };
  // Capture all budgeted evidence before the first model call. No continuation reads
  // consult the live worktree while the model is running.
  const captured: ReviewContext[] = []; let capturedCost = 0;
  for (const attachment of attachments) {
    check();
    if (capturedCost >= meter.task - 3000) { stopped = true; break; }
    for await (const loaded of attachmentSnapshotEvidence(repoId, attachment, valid, () => meter.task - capturedCost - 2000)) {
      check(); validators.push(loaded.validate); pagesRead++; warnings.push(...loaded.context.warnings);
      const pages = evidencePages(loaded.context, Math.min(6800, maxWire - 500));
      for (const page of pages) {
        warnings.push(...page.warnings);
        if (!page.sources.length) continue;
        page.sources = page.sources.map(s => ({ ...s, id: `e${pagesRead}-${captured.length}:${s.id}` }));
        captured.push(page); capturedCost += tokenEstimate(compactEvidence(page));
      }
    }
    opened++;
  }
  for (const page of captured) {
    check();
    if (buffer.length && !fitsWindow([...buffer, page])) { await flush(); if (buffer.length) break; }
    if (!fitsWindow([page])) throw new Error("原文片段超过分析单次预算，请调整模型上下文上限");
    if (!fitsTask([...buffer, page])) {
      await flush();
      if (buffer.length || !fitsTask([page])) { stopped = true; break; }
    }
    buffer.push(page);
  }
  await flush();
  for (const validate of validators) {
    check();
    try { await validate(); }
    catch { check(); warnings.push("采集后仓库已变化或当前版本无法核验；本轮结论保留并基于已采集的内容快照。定位时将重新核验，后续改动请另开一轮分析。"); }
  }
  check();
  warnings.push("本轮基于分析前逐文件采集的只读内容快照，运行期间的新改动不纳入本轮结论。");
  return { results, warnings: [...new Set(warnings)], attached: attachments.length, opened, pagesRead, fragments, windows, jointWindows, stopped, meter };
}
