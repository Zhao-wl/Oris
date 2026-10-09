import { reviewContextPage, reviewInventory, reviewSnapshot, type ReviewContext, type ReviewRequest } from "../ai-review/model";
import type { Attachment } from "./model";

/** Fresh refs at the start, immutable identity thereafter. Changes during reading fail closed. */
export async function* attachmentEvidence(repoId:string,item:Attachment,valid:()=>boolean):AsyncGenerator<{context:ReviewContext;validate:()=>Promise<void>}> {
  if(item.repoId!==repoId)throw new Error("附件属于其他仓库");
  const check=()=>{if(!valid())throw new Error("上下文读取已取消");};check();
  const range=item.request?.range ?? (item.commit?{kind:"commit" as const,commit:item.commit.oid}:null);
  if(!range)throw new Error("附件没有有效来源");
  const inventory=await reviewInventory(repoId,range);check();
  const paths=item.request?.pathIds??inventory.files.map(f=>f.pathId);
  if(paths.some(id=>!inventory.files.some(f=>f.pathId===id)))throw new Error("附加的文件变化已消失，请重新选择附件");
  const request:ReviewRequest={range:inventory.range,identity:inventory.identity,pathIds:paths,contextPaths:[]};
  let batch=0;
  // One file per cursor keeps continuation independent of unrelated file size.
  for(const path of paths){
    const part={...request,pathIds:[path]};let offset=0;
    while(true){
      check();const raw=await reviewContextPage(repoId,part,offset);check();
      const pageOffset=offset;
      const context:ReviewContext={...raw,sources:raw.sources.map(s=>({...s,id:`${batch}:${s.id}`,request:part})),
        ranges:[{kind:raw.inventory.range.kind,left:raw.inventory.left,right:raw.inventory.right}],
        warnings:[...raw.warnings,...(item.request&&item.request.identity!==inventory.identity?["附件版本已变化，本轮使用重新读取的当前版本"]:[])]};
      yield {context,validate:async()=>{
        check();const fresh=await reviewContextPage(repoId,part,pageOffset);check();
        if(fresh.inventory.identity!==raw.inventory.identity||raw.sources.some(s=>!fresh.sources.some(n=>n.id===s.id&&n.contentId===s.contentId)))throw new Error("模型运行期间仓库发生变化，结果未应用，请重新分析");
      }};
      batch++;
      if(raw.nextOffset==null)break;
      if(raw.nextOffset<=offset)throw new Error("差异分页游标未前进");
      offset=raw.nextOffset;
    }
  }
}

/** Capture once before inference; ordinary selection and live reading keep their guards. */
export async function* attachmentSnapshotEvidence(repoId: string, item: Attachment, valid: () => boolean, maxBytes: () => number) {
  const check = () => { if (!valid()) throw new Error("上下文读取已取消"); };
  check(); if (item.repoId !== repoId) throw new Error("附件属于其他仓库");
  const range = item.request?.range ?? (item.commit ? { kind: "commit" as const, commit: item.commit.oid } : null);
  if (!range) throw new Error("附件没有有效来源");
  const inventory = await reviewInventory(repoId, range); check();
  const paths = item.request?.pathIds ?? inventory.files.map(f => f.pathId);
  const unavailable = (reason: string) => ({ context: { inventory, sources: [], diff: "", budget: 0, used: 0, truncated: true, warnings: [reason] } as ReviewContext, validate: async () => {} });
  for (const path of paths) {
    check();
    if (maxBytes() < 1000) return;
    if (!inventory.files.some(f => f.pathId === path)) { yield unavailable(`${item.label}：采集时变化已消失，本条目未读取`); continue; }
    const request: ReviewRequest = { range: inventory.range, identity: inventory.identity, pathIds: [path], contextPaths: [] };
    let raw: ReviewContext;
    try { raw = await reviewSnapshot(repoId, request, maxBytes()); }
    catch (error) { check(); yield unavailable(`${item.label}：快照读取失败，未分析此文件：${String(error).slice(0, 500)}`); continue; }
    check();
    const context: ReviewContext = { ...raw, sources: raw.sources.map(s => ({ ...s, id: `0:${s.id}`, request: { ...request, identity: raw.inventory.identity } })),
      ranges: [{ kind: raw.inventory.range.kind, left: raw.inventory.left, right: raw.inventory.right }] };
    yield { context, validate: async () => {
      check();
      const fresh = await reviewContextPage(repoId, { ...request, identity: raw.inventory.identity }, 0); check();
      if (fresh.inventory.identity !== raw.inventory.identity || raw.sources.some(s => !fresh.sources.some(n => n.id === s.id && n.contentId === s.contentId))) throw new Error("仓库已变化");
    } };
  }
}
