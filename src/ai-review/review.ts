import { type Attachment, type ContextLimits } from "../context-selection/model";
import { combine, withAttachmentEvidence } from "../context-selection/windows";
import { parseReview, type ReviewResult } from "./model";

export async function reviewAttachments(repoId: string, attachments: Attachment[], valid: () => boolean,
  answer: (context: unknown) => Promise<unknown>, promptCost: unknown, limits: ContextLimits = {}) {
  const { results, warnings, opened, pagesRead, fragments, windows, jointWindows, stopped, meter } = await withAttachmentEvidence(repoId, attachments, valid, answer, (response, context) => {
    if ((response as { kind?: string })?.kind !== "answer") throw new Error("分析指令只允许回答");
    return parseReview((response as { review?: unknown }).review, context);
  }, promptCost, limits);
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
