import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readRefs, type LogCursor } from "../history-api";
import { errorText } from "../error-message";
import type { AiProfile } from "../settings";
import { assistSelection, cancelAiGeneration, changeSelection, commitAttachment, emptyFilter, fileAttachments, loadAttachmentContext, selectionCommits, type Attachment, type CommitFilter, type SelectionKind } from "./model";
import "./selection.css";

interface Props {
  repoId: string; value: Attachment[]; profile: AiProfile | null;
  purpose?: "context" | "stage" | "commit";
  onApply(value: Attachment[]): void; onClose(): void;
}
interface Row { id: string; item?: Attachment; group?: string; items?: Attachment[] }
function WindowedList({ rows, render, onEnd, label }: { rows: Row[]; render(row: Row): ReactNode; onEnd?(): void; label: string }) {
  const [top, setTop] = useState(0), ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current && top > rows.length * 28) { ref.current.scrollTop = 0; setTop(0); } }, [rows.length, top]);
  const start = Math.max(0, Math.floor(top / 28) - 4), end = Math.min(rows.length, start + 30);
  return <div ref={ref} className="cs-list" aria-label={label} onScroll={e => { setTop(e.currentTarget.scrollTop); if (e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 180) onEnd?.(); }}>
    {!rows.length && <p className="cs-empty">没有匹配内容</p>}
    <div style={{ height: rows.length * 28, position: "relative" }}>{rows.slice(start, end).map((row,i) => <div className="cs-row" key={row.id} style={{ top: (start+i)*28 }}>{render(row)}</div>)}</div>
  </div>;
}
const sourceLabel = (item: Attachment) => item.kind === "commits" ? item.commit!.oid.slice(0,8) : item.source === "staged" ? "已暂存" : "未暂存";
export default function ContextSelector({ repoId, value, profile, purpose = "context", onApply, onClose }: Props) {
  const dialog = useRef<HTMLElement>(null);
  const [selected,setSelected] = useState(value), [tab,setTab] = useState<SelectionKind>("files");
  const [files,setFiles] = useState<Attachment[]>([]), [commits,setCommits] = useState<Attachment[]>([]), [cursor,setCursor] = useState<LogCursor|null>(null);
  const [filter,setFilter] = useState<CommitFilter>(emptyFilter), [query,setQuery] = useState(""), [source,setSource] = useState(""), [layout,setLayout] = useState("tree"), [only,setOnly] = useState(false);
  const [branches,setBranches] = useState<{name:string;fullName:string}[]>([]), [selectedQuery,setSelectedQuery] = useState(""), [selectedKind,setSelectedKind] = useState("all");
  const [collapsed,setCollapsed] = useState(new Set<string>()), [highlight,setHighlight] = useState(new Set<string>()), anchor = useRef<string|null>(null);
  const [undo,setUndo] = useState<Attachment[][]>([]), [prompt,setPrompt] = useState(""), [feedback,setFeedback] = useState(""), [error,setError] = useState("");
  const [loading,setLoading] = useState(false), [busy,setBusy] = useState(false), [preview,setPreview] = useState<{title:string;text:string}|null>(null);
  const generation = useRef(0), previewGeneration = useRef(0), active = useRef(true), pending = useRef<string|null>(null), fetching = useRef(false);
  const selectedIds = useMemo(()=>new Set(selected.map(x=>x.id)),[selected]);
  const effectiveFilter = useMemo(()=>({...filter,keyword:query}),[filter,query]);
  const stop = () => { generation.current++; fetching.current=false; setBusy(false); setLoading(false); if(pending.current) void cancelAiGeneration(pending.current).catch(()=>{}); pending.current=null; };
  const close = () => { stop(); onClose(); };
  useEffect(()=>{ const previous=document.activeElement as HTMLElement|null; dialog.current?.querySelector<HTMLInputElement>('[aria-label="搜索候选"]')?.focus(); return()=>previous?.focus(); },[]);
  useEffect(()=>{ active.current=true; return ()=>{active.current=false;generation.current++;previewGeneration.current++;if(pending.current)void cancelAiGeneration(pending.current).catch(()=>{});};},[]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();e.stopImmediatePropagation();close();}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);});
  useEffect(()=>{let live=true;setLoading(true);void fileAttachments(repoId).then(items=>{if(live)setFiles(items);},e=>{if(live)setError(errorText(e));}).finally(()=>{if(live)setLoading(false);});void readRefs(repoId).then(r=>{if(live)setBranches([...r.local,...r.remote]);},()=>{});return()=>{live=false;};},[repoId]);
  useEffect(()=>{
    const seq=++generation.current;setHighlight(new Set());anchor.current=null;fetching.current=false;
    if(tab!=="commits")return;
    setCommits([]);setCursor(null);setLoading(true);setError("");
    const timer=setTimeout(()=>{fetching.current=true;void selectionCommits(repoId,effectiveFilter,null).then(page=>{if(seq===generation.current){setCommits(page.commits.map(c=>commitAttachment(repoId,c)));setCursor(page.next);}},e=>{if(seq===generation.current)setError(errorText(e));}).finally(()=>{if(seq===generation.current){setLoading(false);fetching.current=false;}});},250);
    return()=>clearTimeout(timer);
  },[repoId,tab,effectiveFilter]);
  const loadMore=async()=>{if(!cursor||fetching.current||busy)return;const seq=generation.current;fetching.current=true;setLoading(true);try{const page=await selectionCommits(repoId,effectiveFilter,cursor);if(seq!==generation.current)return;setCommits(v=>[...new Map([...v,...page.commits.map(c=>commitAttachment(repoId,c))].map(x=>[x.id,x])).values()]);setCursor(page.next);}catch(e){if(seq===generation.current)setError(errorText(e));}finally{if(seq===generation.current){fetching.current=false;setLoading(false);}}};
  const baseCandidates = tab==="files" ? files.filter(x=>(purpose!=="stage"||x.source==="unstaged")&&(!source||x.source===source)&&x.label.toLowerCase().includes(query.toLowerCase())) : commits;
  const matches = baseCandidates.filter(x=>!only||!selectedIds.has(x.id));
  const picked = selected.filter(x=>(selectedKind==="all"||x.kind===selectedKind)&&x.label.toLowerCase().includes(selectedQuery.toLowerCase()));
  const grouped = (items:Attachment[],chosen=false):Row[]=>{
    if(!chosen&&(tab!=="files"||layout==="flat"))return items.map(item=>({id:item.id,item}));
    const groups=new Map<string,Attachment[]>();for(const item of items){const key=chosen?(item.kind==="files"?"文件差异":"提交记录"):(item.path?.includes("/")?item.path.slice(0,item.path.lastIndexOf("/")):"根目录");if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(item);}
    return [...groups].sort(([a],[b])=>a.localeCompare(b)).flatMap(([group,children])=>{const id=(chosen?"picked:":"source:")+group;return [{id,group,items:children},...collapsed.has(id)?[]:children.map(item=>({id:item.id,item}))];});
  };
  const rows=grouped(matches), chosenRows=grouped(picked,true);
  const update=(candidates:Attachment[],ids:string[],mode:"add"|"remove"|"replace",reason:string,kind?:SelectionKind)=>{
    const next=changeSelection(selected,candidates,ids,mode,kind), nextIds=new Set(next.map(x=>x.id));
    const add=next.filter(x=>!selectedIds.has(x.id)).length, remove=selected.filter(x=>!nextIds.has(x.id)).length;
    if(add||remove){setUndo(v=>[...v.slice(-9),selected]);setSelected(next);}
    setFeedback(`${reason} · 新增 ${add} / 移除 ${remove}${mode==="add"?` / 已存在 ${ids.length-add}`:""}`);
  };
  const allMatches=async()=>{
    if(tab==="files"||!cursor)return matches;
    const seq=generation.current;let next:LogCursor|null=cursor,items=[...commits];
    while(next){if(items.length>=10000)throw new Error("匹配超过 10,000 条，请缩小筛选；未执行部分批量选择");const page=await selectionCommits(repoId,effectiveFilter,next);if(!active.current||seq!==generation.current)throw new Error("已取消读取");items.push(...page.commits.map(c=>commitAttachment(repoId,c)));next=page.next;}
    setCommits(items);setCursor(null);return items.filter(x=>!only||!selectedIds.has(x.id));
  };
  const bulk=async()=>{const seq=generation.current;setBusy(true);setError("");try{const items=await allMatches();if(active.current&&seq===generation.current)update(items,items.map(x=>x.id),"add","加入全部匹配");}catch(e){if(active.current&&seq===generation.current)setError(errorText(e));}finally{if(active.current&&seq===generation.current)setBusy(false);}};
  const ai=async()=>{
    if(!profile){setError("请先配置辅助选择模型");return;}if(!prompt.trim())return;
    const seq=generation.current, requestId=crypto.randomUUID();pending.current=requestId;setBusy(true);setError("");
    const valid=()=>active.current&&generation.current===seq&&pending.current===requestId;
    try{
      const candidates=await allMatches();if(!valid())return;
      const result=await assistSelection(profile,prompt,candidates,selected,tab,requestId,valid);
      if(valid())update(candidates,result.ids,result.mode,result.reason,tab);
    }catch(e){if(valid())setError(errorText(e));}finally{if(valid()){setBusy(false);pending.current=null;}}
  };
  const peek=async(item:Attachment)=>{const seq=++previewGeneration.current;setPreview({title:item.label,text:"正在读取差异…"});try{const c=await loadAttachmentContext(repoId,[item],()=>active.current&&seq===previewGeneration.current);if(seq===previewGeneration.current)setPreview({title:item.label,text:[c.context?.diff||"无可读取文本差异",...c.warnings].join("\n")});}catch(e){if(seq===previewGeneration.current)setPreview({title:item.label,text:errorText(e)});}};
  const clickItem=(e:React.MouseEvent,item:Attachment,chosen:boolean)=>{
    void peek(item);if(chosen)return;
    const order=rows.flatMap(x=>x.item?[x.id]:[]);if(e.shiftKey&&anchor.current&&order.includes(anchor.current)){const a=order.indexOf(anchor.current),b=order.indexOf(item.id);setHighlight(new Set(order.slice(Math.min(a,b),Math.max(a,b)+1)));}
    else if(e.ctrlKey||e.metaKey)setHighlight(v=>{const next=new Set(v);next.has(item.id)?next.delete(item.id):next.add(item.id);return next;});
    else setHighlight(new Set([item.id]));anchor.current=item.id;
  };
  const row=(row:Row,chosen=false)=>row.group?<><button className="cs-main cs-group" aria-expanded={!collapsed.has(row.id)} title={row.group} onClick={()=>setCollapsed(v=>{const n=new Set(v);n.has(row.id)?n.delete(row.id):n.add(row.id);return n;})}>{collapsed.has(row.id)?"▸":"▾"} {row.group}<small>{row.items!.filter(x=>selectedIds.has(x.id)).length}/{row.items!.length}</small></button><button disabled={busy} onClick={()=>update(row.items!,row.items!.map(x=>x.id),chosen?"remove":"add",chosen?"移除组":"加入目录")}>{chosen?"移除组":"加入目录"}</button></>:<>
    <button className={`cs-main ${!chosen&&highlight.has(row.id)?"cs-highlight":""}`} title={`${row.item!.label} · ${sourceLabel(row.item!)}`} onClick={e=>clickItem(e,row.item!,chosen)} onKeyDown={e=>{if(!chosen&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="a"){e.preventDefault();setHighlight(new Set(matches.map(x=>x.id)));}}}>
      <span className="cs-mark">{selectedIds.has(row.id)?"✓":"·"}</span><span className="cs-name">{!chosen&&tab==="files"&&layout==="tree"?row.item!.label.split("/").pop():row.item!.label}</span>{!chosen&&row.item!.commit&&<><span className="cs-author">{row.item!.commit.authorName}</span><time>{new Date(row.item!.commit.authorTime*1000).toLocaleDateString()}</time></>}<small>{sourceLabel(row.item!)}</small>
    </button><button disabled={busy} aria-label={`${selectedIds.has(row.id)?"移除":"加入"} ${row.item!.label} ${sourceLabel(row.item!)}`} onClick={()=>update([row.item!],[row.id],selectedIds.has(row.id)?"remove":"add","手动调整")}>{selectedIds.has(row.id)?"−":"＋"}</button>
  </>;
  const filesCount=selected.filter(x=>x.kind==="files").length, commitsCount=selected.length-filesCount;
  return <div className="cs-overlay" onMouseDown={e=>{if(e.currentTarget===e.target)close();}}><section ref={dialog} role="dialog" aria-modal="true" aria-label="附加上下文" className="cs-dialog" onKeyDown={e=>{if(e.key!=="Tab")return;const controls=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(x=>x.getClientRects().length);const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}>
    <header><strong>{purpose==="context"?"附加上下文":purpose==="stage"?"选择待暂存文件":"选择待提交文件"}</strong><span>{filesCount} 份文件差异 · {commitsCount} 个提交</span><button aria-label="关闭附件选择" onClick={close}>×</button></header>
    <fieldset disabled={busy} className="cs-controls"><nav><button aria-pressed={tab==="files"} onClick={()=>{setTab("files");setQuery("");}}>文件</button>{purpose==="context"&&<button aria-pressed={tab==="commits"} onClick={()=>{setTab("commits");setQuery("");}}>提交记录</button>}<button disabled={loading} onClick={()=>{setLoading(true);setError("");void fileAttachments(repoId).then(items=>{if(!active.current)return;setFiles(items);setSelected(v=>v.flatMap(a=>a.kind==="commits"?[a]:items.filter(n=>n.id===a.id)));setUndo([]);setFeedback("已刷新文件来源；消失的变化已移除，已有提交仍固定原 OID");},e=>{if(active.current)setError(errorText(e));}).finally(()=>{if(active.current)setLoading(false);});}}>刷新文件</button><small>仅调整选择 · 不执行写入</small></nav>
      <div className="cs-filters"><input aria-label="搜索候选" placeholder={tab==="files"?"搜索文件名或路径":"提交关键词 / OID"} value={query} onChange={e=>{setQuery(e.target.value);setHighlight(new Set());}}/>
        {tab==="files"?<><select aria-label="文件来源" value={source} onChange={e=>{setSource(e.target.value);setHighlight(new Set());}}><option value="">全部变化</option><option value="unstaged">未暂存</option>{purpose!=="stage"&&<option value="staged">已暂存</option>}</select><select aria-label="文件展示" value={layout} onChange={e=>setLayout(e.target.value)}><option value="tree">目录</option><option value="flat">平铺</option></select></>:<><select aria-label="提交分支" value={filter.branch??""} onChange={e=>setFilter(v=>({...v,branch:e.target.value||null}))}><option value="">当前分支</option>{branches.map(b=><option key={b.fullName} value={b.fullName}>{b.name}</option>)}</select><label><input type="checkbox" checked={filter.unpushed} onChange={e=>setFilter(v=>({...v,unpushed:e.target.checked}))}/>未推送</label></>}
        <label><input type="checkbox" checked={only} onChange={e=>setOnly(e.target.checked)}/>仅未加入</label>
      </div>
      {tab==="commits"&&<div className="cs-filters"><input aria-label="提交作者" placeholder="作者" value={filter.author} onChange={e=>setFilter(v=>({...v,author:e.target.value}))}/><input type="date" aria-label="开始日期" value={filter.since} onChange={e=>setFilter(v=>({...v,since:e.target.value}))}/><span>—</span><input type="date" aria-label="结束日期" value={filter.until} onChange={e=>setFilter(v=>({...v,until:e.target.value}))}/><input aria-label="提交涉及路径" placeholder="涉及路径" value={filter.path} onChange={e=>setFilter(v=>({...v,path:e.target.value}))}/></div>}
    </fieldset>
    <div className="cs-panes"><section><div className="cs-pane-head"><strong>{tab==="commits"&&cursor?`已读取 ${matches.length} 条匹配 · 总数待续读`:`匹配 ${matches.length}`}</strong><small>已加入 {matches.filter(x=>selectedIds.has(x.id)).length} · 未加入 {matches.filter(x=>!selectedIds.has(x.id)).length}{cursor&&tab==="commits"?"（已读取部分）":""}</small></div>
      <div className="cs-actions"><button disabled={busy||loading} onClick={()=>void bulk()}>加入全部匹配</button><button disabled={busy||!highlight.size} onClick={()=>update(matches,[...highlight].filter(id=>matches.some(x=>x.id===id)),"add","加入高亮")}>加入高亮 {highlight.size||""}</button><small>Shift 连选 · Ctrl 多选</small></div>
      <div className="cs-columns"><span>{tab==="files"?"文件 / 目录":"提交摘要"}</span>{tab==="commits"&&<><span className="cs-author">作者</span><span>提交日期</span></>}<span>{tab==="files"?"来源":"OID"}</span></div><WindowedList key={`${tab}:${query}:${source}:${JSON.stringify(filter)}`} rows={rows} render={r=>row(r)} label="候选内容" onEnd={tab==="commits"?()=>void loadMore():undefined}/>{tab==="commits"&&cursor&&<button className="cs-more" disabled={loading||busy} onClick={()=>void loadMore()}>继续读取（滚动时自动加载）</button>}
    </section><section><div className="cs-pane-head"><strong>已加入 {selected.length} 项</strong><button disabled={busy||!selected.length} onClick={()=>update(selected,selected.map(x=>x.id),"remove","清空全部")}>清空全部</button></div><div className="cs-actions"><input aria-label="搜索已加入" placeholder="搜索已加入" value={selectedQuery} onChange={e=>setSelectedQuery(e.target.value)}/><select aria-label="已加入类别" value={selectedKind} onChange={e=>setSelectedKind(e.target.value)}><option value="all">全部</option><option value="files">文件</option><option value="commits">提交</option></select><button disabled={busy||!picked.length} onClick={()=>update(picked,picked.map(x=>x.id),"remove","移除匹配")}>移除匹配</button></div><div className="cs-columns"><span>附件</span><span>来源</span></div><WindowedList rows={chosenRows} render={r=>row(r,true)} label="已加入内容"/></section></div>
    <details className="cs-preview" open={preview?true:undefined}><summary>差异预览{preview?` · ${preview.title}`:" · 点选条目查看"}</summary>{preview&&<pre>{preview.text}</pre>}</details>
    <div className="cs-ai"><label>AI 操作对象<select aria-label="AI 操作对象" disabled={busy||purpose!=="context"} value={tab} onChange={e=>{setTab(e.target.value as SelectionKind);setQuery("");}}><option value="files">文件</option>{purpose==="context"&&<option value="commits">提交</option>}</select></label><input aria-label="AI 选择指令" disabled={busy} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="追加逻辑层；再加入渲染层；移除测试…" onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing)void ai();}}/><button disabled={busy||loading||!prompt.trim()} onClick={()=>void ai()}>调整选择</button><button disabled={busy||!undo.length} onClick={()=>{setSelected(undo[undo.length-1]);setUndo(v=>v.slice(0,-1));setFeedback("已撤销上一步");}}>撤销</button>{busy&&<button onClick={stop}>停止</button>}</div>
    <div className="cs-notices" aria-live="polite">{loading&&<span>读取中… </span>}{busy&&<span>处理中… </span>}<span>{feedback||`AI 前提范围：${tab==="files"?"文件":"提交"}的全部筛选匹配项；最多 400 个候选、两次模型调用；差异按预算分批，未覆盖部分会标明。`}</span>{error&&<p role="alert">{error}</p>}</div>
    <footer><small>{purpose==="commit"?"提交将包含所选文件的全部工作区内容（含未暂存改动），不按某一份 diff 提交。":"选择数量不限 · 发送按差异预算分批，结果标明未覆盖部分"}</small><button onClick={close}>取消</button><button className="primary" disabled={busy||loading} onClick={()=>onApply(selected)}>{purpose==="context"?"应用附件":"应用文件选择"} · {selected.length}</button></footer>
  </section></div>;
}
