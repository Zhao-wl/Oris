// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import ContextSelector from "./ContextSelector";
const invoke=vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
const apply=vi.fn(),close=vi.fn();
beforeEach(()=>{vi.stubGlobal("innerHeight",734);vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);apply.mockClear();close.mockClear();invoke.mockReset();invoke.mockImplementation(async(command,{range}={})=>{
  if(command==="read_refs")return {local:[],remote:[]};
  if(command==="review_inventory")return {repoId:"r",range,identity:range.kind,revision:"rev",left:"HEAD",right:"index",totalFiles:range.kind==="staged"?0:1000,files:range.kind==="staged"?[]:Array.from({length:1000},(_,i)=>({pathId:"f"+i,path:`src/File${i}.ts`,status:"modified"}))};
  if(command==="selection_commits")return {commits:[],next:null,tips:[]};
});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const button=(s:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.startsWith(s))!;
const click=async(b:Element)=>{await act(async()=>{(b as HTMLButtonElement).click();});};
const mount=async()=>{await act(async()=>root.render(<ContextSelector repoId="r" value={[]} profile={null} onApply={apply} onClose={close}/>));};
it("virtualizes 1000 real candidates while bulk selection covers every match; collapsed groups still remove all",async()=>{
  await mount();expect(host.querySelectorAll(".cs-row").length).toBeLessThan(40);
  expect(host.textContent).toContain("未加入 1000");expect(host.textContent).not.toContain("分支比较");expect(host.querySelector('[aria-label="行密度"]')).toBeNull();
  await click(button("加入全部匹配"));expect(host.textContent).toContain("已加入 1000 项");
  await click([...host.querySelectorAll(".cs-group")].find(e=>e.textContent?.includes("文件差异"))!);
  await click(button("移除匹配"));expect(host.textContent).toContain("已加入 0 项");
  await click(button("撤销"));await click(button("应用附件"));expect(apply.mock.calls[0][0]).toHaveLength(1000);
});
it("cancel discards edits and explicit AI object selection switches candidate type",async()=>{
  await mount();await click(button("加入全部匹配"));
  const select=host.querySelector<HTMLSelectElement>('[aria-label="AI 操作对象"]')!;
  await act(async()=>{select.value="commits";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(host.querySelector('[aria-label="提交筛选类型"]')).not.toBeNull();
  await click(button("取消"));expect(close).toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
});
it("moves joined files out of candidates and restores them on removal; the tree shares directory hierarchy",async()=>{
  await mount();expect(host.querySelector('[aria-label="文件展示"]')?.textContent).toBe("☷⑂");
  expect(host.textContent).not.toContain("仅未加入");expect(host.textContent).not.toContain("AI 前提范围");
  await click(host.querySelector('[aria-label="加入 src/File0.ts 未暂存"]')!);
  expect(host.querySelector('[aria-label="候选内容"]')?.textContent).not.toContain("File0.ts");
  expect(host.querySelector('[aria-label="已加入内容"]')?.textContent).toContain("File0.ts");
  await click(host.querySelector('[aria-label="移除 src/File0.ts 未暂存"]')!);
  expect(host.querySelector('[aria-label="候选内容"]')?.textContent).toContain("File0.ts");
});
it("commit navigation uses explicit pages and date filters stay in a single range popover",async()=>{
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command,args)=>command==="selection_commits"?{commits:Array.from({length:21},(_,i)=>({oid:String(i),subject:`commit-${i}`,authorName:"A",authorTime:0})),next:null,tips:[]}:original(command,args));
  await mount();await click(button("提交记录"));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,280));});
  const list=host.querySelector('[aria-label="候选内容"]')!;
  expect(list.textContent).toContain("commit-0");expect(list.textContent).not.toContain("commit-10");
  const calls=invoke.mock.calls.length;
  await act(async()=>list.dispatchEvent(new Event("scroll",{bubbles:true})));expect(invoke.mock.calls.length).toBe(calls);
  await click(host.querySelector('[aria-label="下一页提交"]')!);expect(list.isConnected).toBe(false);
  expect(host.querySelector('[aria-label="候选内容"]')?.textContent).toContain("commit-10");
  await click(host.querySelector('[aria-label="上一页提交"]')!);expect(host.textContent).toContain("第 1 页");
  expect(host.querySelector('[aria-label="开始日期"]')).toBeNull();
  await click(host.querySelector('[aria-label="提交日期区间"]')!);expect(host.querySelector('[aria-label="开始日期"]')).not.toBeNull();
  const field=host.querySelector<HTMLSelectElement>('[aria-label="提交筛选类型"]')!;
  await act(async()=>{field.value="path";field.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(host.querySelector('input[placeholder="搜索涉及路径"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="提交作者"]')).toBeNull();
  for(const [label,value] of [["开始日期","2026-10-01"],["结束日期","2026-10-09"],["提交筛选内容","Assets/Football"]]){
    const input=host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
  }
  await click(button("应用日期"));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,280));});
  expect(invoke.mock.calls.filter(c=>c[0]==="selection_commits").at(-1)?.[1].query).toMatchObject({since:"2026-10-01",until:"2026-10-09",path:"Assets/Football",author:""});
  expect(host.querySelector('[aria-label="开始日期"]')).toBeNull();
});
it("AI removal still receives joined candidates even though they are hidden from the left pane",async()=>{
  const model=await import("./model");const assist=vi.spyOn(model,"assistSelection").mockResolvedValue({ids:["unstaged:f0"],mode:"remove",reason:"移除"});
  try{
    await act(async()=>root.render(<ContextSelector repoId="r" value={[{id:"unstaged:f0",kind:"files",repoId:"r",label:"src/File0.ts",path:"src/File0.ts",source:"unstaged"}]} profile={{id:"api",name:"api",kind:"api",provider:"openai",model:"m",baseUrl:"",hasKey:true,executable:""}} onApply={apply} onClose={close}/>));
    const input=host.querySelector<HTMLInputElement>('[aria-label="AI 选择指令"]')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"移除 File0");input.dispatchEvent(new Event("input",{bubbles:true}));});
    await click(host.querySelector('[aria-label="调整选择"]')!);
    expect(assist.mock.calls[0][2].some(a=>a.id==="unstaged:f0")).toBe(true);
    await click(button("应用附件"));expect(apply.mock.calls[0][0]).toHaveLength(0);
  }finally{assist.mockRestore();}
});
