import { beforeEach, expect, it, vi } from "vitest";
import { contextIndex, describeNode, evidencePages, compactEvidence, tokenEstimate, CONTEXT_BUDGET, type IndexNode } from "./compression";
import { routeCandidates, type Attachment } from "./model";
import { withAttachmentReads } from "./reader";
import { reviewAttachments } from "./review";
import { context } from "../ai-review/fixtures";
const invoke=vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
const profile={id:"api",name:"API",kind:"api" as const,provider:"openai" as const,baseUrl:"",model:"m",hasKey:true,executable:""};
const file=(i:number,directory="Football/Logic"):Attachment=>({id:`unstaged:${"long-base64-id".repeat(20)}${i}`,kind:"files",repoId:"repo",label:`${directory}/Player${i}.ts`,path:`${directory}/Player${i}.ts`,source:"unstaged",request:{range:{kind:"unstaged"},identity:"old",pathIds:[`p${i}`],contextPaths:[]}});
const fixture=(nextOffset:number|null=null)=>({...context,nextOffset,truncated:false,inventory:{...context.inventory,identity:"fresh",files:[{...context.sources[0].file,pathId:"p0"}]},sources:context.sources.map(s=>({...s,truncated:false}))});
beforeEach(()=>{invoke.mockReset();invoke.mockImplementation(async(command)=>command==="review_inventory"?fixture().inventory:fixture());});
it("keeps all 10000 long-ID files reachable through bounded indexes without transmitting their IDs",()=>{
  const items=Array.from({length:10000},(_,i)=>file(i)), roots=contextIndex(items);let count=0;
  const visit=(nodes:IndexNode[])=>{expect(tokenEstimate(nodes.map(describeNode))).toBeLessThanOrEqual(CONTEXT_BUDGET.index);for(const n of nodes){if(n.children)visit(n.children);else count++;}};
  visit(roots);expect(count).toBe(10000);expect(JSON.stringify(roots.map(describeNode))).not.toContain("long-base64-id");
});
it("routes a large candidate set by directories without reading unrelated source bodies",async()=>{
  const candidates=[...Array.from({length:600},(_,i)=>file(i,"Docs")),file(999)];
  invoke.mockImplementation(async(command,args)=>{expect(command).toBe("select_context");expect(JSON.stringify(args.context)).not.toContain("long-base64-id");
    const entries=args.context.candidates as {id:string;label:string;type:string}[];
    return {kind:"answer",selection:{target:"files",mode:"add",ids:entries.filter(e=>e.label.includes("Football")||e.type==="item").map(e=>e.id),reason:"相关"}};});
  const result=await routeCandidates(profile,"football逻辑",candidates,[],"files","r",()=>true);
  expect(result.items.map(a=>a.id)).toEqual([candidates.at(-1)!.id]);expect(invoke).toHaveBeenCalledTimes(2);
});
it("initial attachment request contains only a compact index and final answer can finish without reading bodies",async()=>{
  const answer=vi.fn(async(payload:unknown)=>{expect(JSON.stringify(payload)).not.toContain("return items");return {kind:"answer",message:"只需要目录"};});
  const result=await withAttachmentReads("repo",[file(0)],()=>true,answer,"");
  expect(invoke).not.toHaveBeenCalled();expect(result.coverage.unopened).toBe(1);expect(result.coverage.readChunks).toBe(0);
});
it("controlled reads expose only requested chunks, cache duplicate reads and validate against original content",async()=>{
  let step=0,group="",item="",chunk="";
  const result=await withAttachmentReads("repo",[file(0)],()=>true,async(value)=>{
    const payload=value as any;
    switch(step++){
      case 0:group=payload.index[0].id;return {kind:"answer",contextRead:{action:"expand",ids:[group]}};
      case 1:item=payload.index[0].entries[0].id;return {kind:"answer",contextRead:{action:"read",ids:[item]}};
      case 2:expect(payload.evidence).toEqual([]);chunk=payload.index[0].parts[0].id;return {kind:"answer",contextRead:{action:"read",ids:[chunk]}};
      case 3:expect(payload.evidence[0].sources[0].lines[0].text).toBe("return items[0].name;");return {kind:"answer",contextRead:{action:"read",ids:[chunk]}};
      default:return {kind:"answer",message:"done"};
    }
  },"");
  expect(result.coverage.readChunks).toBe(1);expect(invoke.mock.calls.filter(c=>c[0]==="review_context_page")).toHaveLength(2); // read + final validation
});
it("refuses arbitrary paths, unknown IDs, and cancellation before exposing evidence",async()=>{
  await expect(withAttachmentReads("repo",[file(0)],()=>true,async()=>({kind:"answer",contextRead:{action:"read",ids:["../../secret"]}}),"")).rejects.toThrow("范围外");
  await expect(withAttachmentReads("repo",[file(0)],()=>false,async()=>({}),"")).rejects.toThrow("取消");
  expect(invoke).not.toHaveBeenCalled();
});
it("preserves complete numbered lines, reports oversized lines and never duplicates full diff in wire evidence",()=>{
  const raw=fixture();raw.sources[0].lines=Array.from({length:100},(_,i)=>({line:i+1,text:"const value = 123;".repeat(15)}));
  raw.sources[0].lines.push({line:101,text:"x".repeat(10000)});
  const pages=evidencePages(raw);expect(pages.length).toBeGreaterThan(1);
  expect(pages.flatMap(p=>p.sources.flatMap(s=>s.lines))).toHaveLength(100);
  expect(pages[0].warnings.join()).toContain("超长原文行");
  expect(pages.every(p=>tokenEstimate(compactEvidence(p))<=CONTEXT_BUDGET.evidence)).toBe(true);
  expect(JSON.stringify(pages.map(compactEvidence))).not.toContain("actual diff");
});
it("full review follows continuation to late-file evidence and does not publish partial results on stale validation",async()=>{
  invoke.mockImplementation(async(command,args)=>command==="review_inventory"?fixture().inventory:{...fixture(args.offset===0?90:null),sources:[{...fixture().sources[0],lines:[{line:args.offset===0?1:900,text:args.offset===0?"early":"late bug"}]}]});
  const answer=vi.fn(async(value)=>{const c=value as any;return {kind:"answer",review:{summary:c.sources[0].lines[0].text,impact:"",findings:[],commits:[]}};});
  const result=await reviewAttachments("repo",[file(0)],()=>true,answer,"");
  expect(answer).toHaveBeenCalledTimes(2);expect(result.result?.summary).toContain("late bug");expect(result.result?.context.sources.some(s=>s.lines.some(l=>l.line===900))).toBe(true);
  let reads=0;
  invoke.mockImplementation(async command=>command==="review_inventory"?fixture().inventory:{...fixture(),sources:fixture().sources.map(s=>({...s,contentId:++reads>1?"changed":s.contentId}))});
  await expect(reviewAttachments("repo",[file(0)],()=>true,answer,"")).rejects.toThrow("仓库发生变化");
});
