import { attachmentEvidence } from "./evidence";
import { parseReview, type ReviewContext, type ReviewResult } from "../ai-review/model";
import { budgetedAnswer, newContextMeter, type Attachment, type ContextLimits } from "./model";
import { compactEvidence, CONTEXT_BUDGET, evidencePages, tokenEstimate } from "./compression";

/** Full review visits every attachment until the cumulative budget is exhausted. */
export async function reviewAttachments(repoId:string,attachments:Attachment[],valid:()=>boolean,
  answer:(context:unknown)=>Promise<unknown>,promptCost:unknown,limits:ContextLimits={}) {
  const meter=newContextMeter(limits),results:ReviewResult[]=[],warnings:string[]=[];
  const validators:(()=>Promise<void>)[]=[];let fileCount=0,opened=0,pagesRead=0,stopped=false;
  const check=()=>{if(!valid())throw new Error("审查已取消");};
  outer:for(const attachment of attachments){
    check();
    for await (const loaded of attachmentEvidence(repoId,attachment,valid)) {
      check();
      if(meter.calls>=CONTEXT_BUDGET.calls||meter.tokens>=meter.task-10000){stopped=true;break outer;}
      validators.push(loaded.validate);fileCount++;
      warnings.push(...loaded.context.warnings);
      const pages=evidencePages(loaded.context);
      for(const page of pages){
        if(pagesRead)page.sources=page.sources.map(s=>({...s,id:`b${pagesRead}:${s.id}`}));
        const wire=compactEvidence(page);
        if(meter.calls>=CONTEXT_BUDGET.calls||meter.tokens+tokenEstimate({promptCost,wire})+2000>meter.task){stopped=true;break outer;}
        const response=await budgetedAnswer(meter,{promptCost,wire},()=>answer(wire));check();
        if((response as {kind?:string}).kind!=="answer")throw new Error("分析指令只允许回答");
        results.push(parseReview((response as {review?:unknown}).review,page));pagesRead++;
      }
    }
    opened++;
  }
  for(const validate of validators){check();await validate();}check();
  const coverage=`附件 ${attachments.length} 项；已遍历 ${opened} 项，读取 ${fileCount} 个原文分页、分析 ${pagesRead} 个证据片段；${stopped?"累计预算耗尽，剩余内容未审查":"附件遍历完成"}。原文截断与跨片段关联限制见下方，不能据局部结果认定整体无问题。`;
  if(!results.length)return {result:null,coverage:coverage+"\n"+[...new Set(warnings)].join("\n")};
  const contexts=results.map(r=>r.context),first=contexts[0];
  const context:ReviewContext={...first,budget:meter.task,used:meter.tokens,truncated:stopped||contexts.some(c=>c.truncated),
    inventory:{...first.inventory,files:contexts.flatMap(c=>c.inventory.files)},sources:contexts.flatMap(c=>c.sources),
    ranges:contexts.flatMap(c=>c.ranges??[{kind:c.inventory.range.kind,left:c.inventory.left,right:c.inventory.right}]),diff:"分批提供精确原文；完整源信息仅在本地保留用于定位。",
    warnings:[...new Set([...warnings,...contexts.flatMap(c=>c.warnings),coverage,"逐片段审查，尚未做完整跨文件联合推理；不能保证发现所有关联问题。"])]};
  const findings=[...new Map(results.flatMap(r=>r.findings).map(f=>[`${f.source?.file.path}:${f.source?.side}:${f.line}:${f.title}`,f])).values()];
  const result:ReviewResult={context,summary:results.map(r=>r.summary).join("\n"),impact:results.map(r=>r.impact).filter(Boolean).join("\n"),findings,
    commits:results.flatMap(r=>r.commits),limitations:[coverage,...results.map(r=>r.limitations)].filter(Boolean).join("\n")};
  return {result,coverage};
}
