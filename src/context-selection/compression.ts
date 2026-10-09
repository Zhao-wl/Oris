import type { Attachment } from "./model";
import type { ReviewContext } from "../ai-review/model";

/** Conservative, model-independent upper estimate. This is not a vendor tokenizer. */
export const tokenEstimate = (value: unknown): number => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
export const CONTEXT_BUDGET = { index: 2000, evidence: 8000, task: 96000, calls: 64 } as const;
export function compactConversation<T>(messages:T[]) {
  const result:T[]=[];let used=0;
  for(const message of [...messages].reverse()) { const size=tokenEstimate(message);if(used+size>2000)break;result.unshift(message);used+=size; }
  return {messages:result,omitted:messages.length-result.length};
}
export interface IndexNode { id: string; label: string; count: number; item?: Attachment; children?: IndexNode[] }
export function contextIndex(items: Attachment[]): IndexNode[] {
  let serial = 0;
  const groups = new Map<string, IndexNode[]>();
  for (const item of items) {
    const directory = item.kind === "files" ? (item.path ?? item.label).split("/").slice(0,-1).join("/") || "." : new Date((item.commit?.authorTime ?? 0)*1000).toISOString().slice(0,10);
    const key = `${item.source ?? "commit"}:${directory}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ id: `f${serial++}`, label: item.kind === "files" ? (item.path ?? item.label).split("/").pop()! : `${item.commit?.authorName ?? ""} · ${item.label}`, count: 1, item });
  }
  // Every entry remains reachable, including very large or flat directories.
  const bound = (nodes: IndexNode[], prefix: string): IndexNode[] => {
    if (tokenEstimate(nodes.map(describeNode)) <= CONTEXT_BUDGET.index || nodes.length <= 1) return nodes;
    const buckets: IndexNode[][] = []; let page: IndexNode[] = [];
    for (const node of nodes) {
      if (page.length && tokenEstimate([...page,node].map(describeNode)) > CONTEXT_BUDGET.index) { buckets.push(page); page=[]; }
      page.push(node);
    }
    if (page.length) buckets.push(page);
    // Long individual labels are shortened only for navigation, never evidence.
    if (buckets.length === nodes.length) buckets.splice(0,buckets.length,...Array.from({length:Math.ceil(nodes.length/8)},(_,i)=>nodes.slice(i*8,i*8+8)));
    const parents = buckets.map(children=>({id:`g${serial++}`,label:`${prefix} [${children[0].label.slice(0,40)} … ${children.at(-1)!.label.slice(0,40)}]`,count:children.reduce((n,c)=>n+c.count,0),children}));
    return bound(parents,prefix);
  };
  return bound([...groups].sort(([a],[b])=>a.localeCompare(b)).map(([label,children])=>({id:`g${serial++}`,label,count:children.length,children:bound(children,label)})),"目录 / 日期分组");
}
export const describeNode = (node: IndexNode) => ({ id: node.id, label: node.label.slice(0,240), count: node.count, type: node.children ? "group" : "item" });

/** Remove duplicated patch payload; retain exact numbered source lines for citations. */
export function evidencePages(context: ReviewContext, budget:number = CONTEXT_BUDGET.evidence-1200): ReviewContext[] {
  const pages: ReviewContext[] = [];
  const empty = (): ReviewContext => ({...context, inventory:{...context.inventory,files:[]}, sources:[],diff:"",used:0,budget,warnings:[],truncated:context.truncated});
  let page = empty(); let skipped = 0;
  const flush = () => { if (page.sources.length) pages.push(page); page=empty(); };
  for (const source of context.sources) {
    for (const line of source.lines) {
      const row = {...source,lines:[line]};
      const cost = tokenEstimate({id:source.id,path:source.file.path,side:source.side,lines:[line]});
      if (cost > budget / 2) { skipped++; continue; }
      const found = page.sources.find(s=>s.id===source.id);
      const extra = found ? tokenEstimate(line) : cost;
      if (page.used + extra > budget) flush();
      const target = page.sources.find(s=>s.id===source.id);
      if (target) target.lines.push(line); else page.sources.push(row);
      page.used += extra;
    }
  }
  flush();
  if(!pages.length && skipped)pages.push(empty());
  for (const result of pages) {
    result.inventory.files = [...new Map(result.sources.map(s=>[s.file.pathId,s.file])).values()];
    result.diff = "精确差异上下文见 sources：left 为修改前，right 为修改后；行号保持原文件位置。未发送重复 patch。";
    result.warnings = [...context.warnings, ...(skipped?[`${skipped} 个超长原文行未读取，结论不完整`]:[])];
    result.truncated ||= skipped>0;
  }
  return pages;
}

/** Wire projection only. Full IDs, requests, hashes stay local for navigation/validation. */
export function compactEvidence(context: ReviewContext) {
  return { ranges:context.ranges ?? [{kind:context.inventory.range.kind,left:context.inventory.left,right:context.inventory.right}],
    sources:context.sources.map(s=>({id:s.id,file:{path:s.file.path,status:s.file.status},side:s.side,endpoint:s.endpoint,range:s.request?.range??context.inventory.range,lines:s.lines})),
    coverage:{truncated:context.truncated,warnings:context.warnings}, note:context.diff };
}
