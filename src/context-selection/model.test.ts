import { beforeEach, expect, it, vi } from "vitest";
import { assistSelection, changeSelection, defaultAttachments, fileAttachments, loadAttachmentContext, parseSelection, type Attachment } from "./model";
import { context } from "../ai-review/fixtures";
const invoke = vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
const file=(id:string,source:"unstaged"|"staged"="unstaged"):Attachment=>({id,kind:"files",repoId:"repo",label:id,path:id,source,request:{range:{kind:source},identity:source,pathIds:[id],contextPaths:[]}});
const commit:Attachment={id:"commit:abc",kind:"commits",repoId:"repo",label:"logic",commit:{oid:"abc",subject:"logic",parents:[],authorName:"Zhao",authorTime:0,authorEmail:"",committerName:"",committerTime:0,committerEmail:"",body:"",refs:[]}};
beforeEach(()=>{invoke.mockReset();});
it("incremental selection and replacement never cross the explicit file/commit boundary",()=>{
  const a=file("logic"),b=file("render"),c=file("test"),candidates=[a,b,c,commit];
  let selected=changeSelection([commit],candidates,[a.id],"add","files");
  selected=changeSelection(selected,candidates,[b.id,c.id],"add","files");
  selected=changeSelection(selected,candidates,[c.id],"remove","files");
  expect(selected.map(x=>x.id)).toEqual([commit.id,a.id,b.id]);
  expect(changeSelection(selected,candidates,[b.id],"replace","files").map(x=>x.id)).toEqual([commit.id,b.id]);
  expect(()=>parseSelection({kind:"git",selection:{target:"files",ids:[a.id],mode:"add",reason:""}},candidates,"files")).toThrow();
  expect(()=>parseSelection({kind:"answer",selection:{target:"files",ids:[commit.id],mode:"add",reason:""}},candidates,"files")).toThrow();
});
it("retains separate staged and unstaged identities for the same file",async()=>{
  invoke.mockImplementation(async(command,{range})=>command==="review_inventory"?{...context.inventory,repoId:"repo",range,identity:range.kind,files:[context.sources[0].file]}:undefined);
  const files=await fileAttachments("repo");expect(files).toHaveLength(2);expect(files[0].id).not.toBe(files[1].id);expect(files.map(x=>x.source)).toEqual(["unstaged","staged"]);
});
it("reports unavailable upstream rather than treating it as zero unpushed commits",async()=>{
  invoke.mockImplementation(async(command,{range})=>{if(command==="selection_commits")throw Error("no upstream");return {...context.inventory,range,files:[]};});
  const result=await defaultAttachments("repo");expect(result.warnings.join()).toContain("no upstream");
});
it("preserves origin request and refuses content changed during model execution",async()=>{
  invoke.mockResolvedValue(context);
  const loaded=await loadAttachmentContext("repo",[file("a"),file("b","staged")]);
  expect(loaded.context?.sources.map(x=>x.id)).toEqual(["0:source","1:source"]);
  expect(loaded.context?.sources[1].request?.range.kind).toBe("staged");
  invoke.mockResolvedValue({...context,inventory:{...context.inventory,identity:"changed"}});
  await expect(loaded.validate()).rejects.toThrow("仓库发生变化");
});
it("selection over 16 files is batched and never silently claims all diff was read",async()=>{
  invoke.mockResolvedValue({...context,used:40000});
  const loaded=await loadAttachmentContext("repo",Array.from({length:150},(_,i)=>file("f"+i)));
  expect(loaded.context?.truncated).toBe(true);expect(loaded.warnings.join()).toContain("未读取");
  expect(invoke.mock.calls.length).toBe(2);
});
it("model selection uses the no-tools endpoint, checks real diff, and ignores cancellation",async()=>{
  const a=file("logic"),profile={id:"api",name:"API",kind:"api" as const,provider:"openai" as const,baseUrl:"",model:"m",hasKey:true,executable:""};
  invoke.mockImplementation(async (command,args)=>command==="select_context"?{kind:"answer",selection:{target:"files",mode:"add",ids:[args.context.candidates[0].id],reason:"logic"}}:command==="review_inventory"?{...context.inventory,identity:"unstaged",files:[{...context.sources[0].file,pathId:"logic"}]}:{...context,inventory:{...context.inventory,identity:"unstaged"}});
  const result=await assistSelection(profile,"加入逻辑",[a],[],"files","request",()=>true);
  expect(result.ids).toEqual([a.id]);expect(invoke.mock.calls.filter(c=>c[0]==="select_context")).toHaveLength(3);expect(invoke.mock.calls.some(c=>c[0]==="plan_ai_action")).toBe(false);
  await expect(assistSelection(profile,"加入逻辑",[a],[],"files","cancel",()=>false)).rejects.toThrow("取消");
});

it("selects test files using metadata without requiring their diff to introduce tests",async()=>{
  const a=file("Assets/Tests/AnimationKickTests.cs"),profile={id:"api",name:"API",kind:"api" as const,provider:"openai" as const,baseUrl:"",model:"m",hasKey:true,executable:""};
  invoke.mockImplementation(async(command,args)=>{
    expect(command).toBe("select_context");
    return {kind:"answer",selection:{target:"files",mode:"add",ids:[args.context.candidates[0].id],evidenceIds:[],reason:"Tests 目录中的测试用例"}};
  });
  const result=await assistSelection(profile,"测试用例文件",[a],[],"files","request",()=>true);
  expect(result.ids).toEqual([a.id]);expect(result.reason).toContain("Tests 目录");expect(invoke).toHaveBeenCalledTimes(2);
  expect(()=>parseSelection({kind:"answer",selection:{target:"files",mode:"add",ids:[a.id],evidenceIds:["outside"],reason:""}},[a],"files")).toThrow("正文核对对象");
});
it("retains the model explanation when index navigation finds no match",async()=>{
  invoke.mockResolvedValue({kind:"answer",selection:{target:"files",mode:"add",ids:[],reason:"当前范围只有文档，没有测试文件"}});
  const result=await assistSelection({id:"api",name:"API",kind:"api",provider:"openai",baseUrl:"",model:"m",hasKey:true,executable:""},"测试用例文件",[file("docs/readme.md")],[],"files","request",()=>true);
  expect(result.ids).toEqual([]);expect(result.reason).toContain("没有测试文件");
});
