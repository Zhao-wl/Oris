// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import ContextSelector from "./ContextSelector";
const invoke=vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
const apply=vi.fn(),close=vi.fn();
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);apply.mockClear();close.mockClear();invoke.mockReset();invoke.mockImplementation(async(command,{range}={})=>{
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
  expect(host.textContent).toContain("匹配 1000");expect(host.textContent).not.toContain("分支比较");expect(host.querySelector('[aria-label="行密度"]')).toBeNull();
  await click(button("加入全部匹配"));expect(host.textContent).toContain("已加入 1000 项");
  await click([...host.querySelectorAll(".cs-group")].find(e=>e.textContent?.includes("文件差异"))!);
  await click(button("移除匹配"));expect(host.textContent).toContain("已加入 0 项");
  await click(button("撤销"));await click(button("应用附件"));expect(apply.mock.calls[0][0]).toHaveLength(1000);
});
it("cancel discards edits and explicit AI object selection switches candidate type",async()=>{
  await mount();await click(button("加入全部匹配"));
  const select=host.querySelector<HTMLSelectElement>('[aria-label="AI 操作对象"]')!;
  await act(async()=>{select.value="commits";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(host.querySelector('[aria-label="提交作者"]')).not.toBeNull();
  await click(button("取消"));expect(close).toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
});
