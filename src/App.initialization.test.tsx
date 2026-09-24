// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareScope, ContentPair, RepositorySnapshot } from "./types";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), close: vi.fn(), diff: vi.fn(), queryFocus: vi.fn(),
  details: vi.fn(), activate: vi.fn(), loadSnapshot: vi.fn(), saveSnapshot: vi.fn(),
  focused: false, focus: null as null | ((event: { payload: boolean }) => void),
  changed: null as null | ((event: { payload: string }) => void),
}));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: bridge.close, cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: bridge.details, activateRepository: bridge.activate, loadSnapshot: bridge.loadSnapshot, saveSnapshot: bridge.saveSnapshot, removeSnapshot: vi.fn(async () => {}) }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isFocused: bridge.queryFocus,
  onFocusChanged: async (callback: typeof bridge.focus) => { bridge.focus = callback; return () => { if (bridge.focus === callback) bridge.focus = null; }; },
}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_name: string, callback: typeof bridge.changed) => {
  bridge.changed = callback; return () => { if (bridge.changed === callback) bridge.changed = null; };
} }));
vi.mock("./DiffViewer", () => ({ default: ({ readingKey }: { readingKey: string }) => <div data-testid="readable">{readingKey}</div> }));
vi.mock("./FileTree", () => ({
  compareFiles: (a: { displayPath: string }, b: { displayPath: string }) => a.displayPath.localeCompare(b.displayPath),
  default: ({ files, onSelect }: { files: RepositorySnapshot["files"]; onSelect: (file: RepositorySnapshot["files"][number]) => void }) => <>{files.map(file => <button key={file.pathId} onClick={() => onSelect(file)}>{file.displayPath}</button>)}</>,
}));
vi.mock("./ImageViewer", () => ({ default: () => <div data-testid="image-viewer"/> }));
import App from "./App";

const repo = (id: string) => ({ repoId: id, displayName: id, worktreePath: `C:/${id}`, gitDir: `C:/${id}/.git`, commonDir: `C:/${id}/.git`, branch: "main" });
const snapshot = (id: string, revision = "r1"): RepositorySnapshot => ({
  requestId: "snapshot", repo: repo(id), scope: "unstaged", revision, scannedAt: 1,
  files: [{ pathId: "f", displayPath: "file.txt", oldPathId: null, oldDisplayPath: null, status: "modified", additions: 1, deletions: 1 }],
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" },
});
const pair = (id: string, revision = "r1"): ContentPair => ({
  requestId: "content", repoId: id, revision, pathId: "f", displayPath: "file.txt", stale: false, degradation: null,
  left: { endpoint: "index", text: "before", byteLength: 6, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: "l" },
  right: { endpoint: "workingTree", text: revision, byteLength: 2, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: revision },
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };
const focus = async (value: boolean) => { bridge.focused = value; await act(async () => { bridge.focus?.({ payload: value }); }); await flush(); };
const click = async (selector: string) => { await act(async () => { (host.querySelector(selector) as HTMLButtonElement).click(); }); await flush(); };
const mount = async (ids = ["a"], strict = false) => {
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: ids[0], projects: ids.map(id => ({ repo: repo(id), gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() })) }));
  await act(async () => { root.render(strict ? <StrictMode><App /></StrictMode> : <App />); }); await flush();
};
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); localStorage.clear();
  bridge.focused = false; bridge.focus = null; bridge.changed = null;
  bridge.queryFocus.mockImplementation(async () => bridge.focused);
  bridge.details.mockResolvedValue(null); bridge.activate.mockResolvedValue(true); bridge.loadSnapshot.mockResolvedValue(null); bridge.saveSnapshot.mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  bridge.open.mockImplementation(async (path: string, scope: CompareScope) => ({ ...snapshot(path.slice(3)), scope }));
  bridge.read.mockImplementation(async (id: string, _scope: string, revision: string) => pair(id, revision));
  bridge.refresh.mockImplementation(async (id: string, scope: CompareScope) => ({ ...snapshot(id), scope }));
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string]) => ({ requestId, contentIds, changes: [], hunks: [], elapsedMs: 0 }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("controlled focus state integration (no native windows)", () => {
  it("persists tab aliases and drag order through remount; closing an inactive tab does not select it", async () => {
    await mount(["a", "b"]);
    await act(async () => host.querySelector('.project-tab:nth-child(2) .project-switch span')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await act(async () => {
      const field = host.querySelector('.project-rename')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '中文别名');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (host.querySelector('.project-rename') as HTMLInputElement).blur());
    const [first, second] = [...host.querySelectorAll<HTMLElement>('.project-tab')];
    document.elementFromPoint = () => first;
    for (const [type, clientX] of [['pointerdown', 200], ['pointermove', 20], ['pointerup', 20]] as const)
      await act(async () => second.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX, clientY: 5 })));
    Reflect.deleteProperty(document, 'elementFromPoint');
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!);
    expect(saved.projects.map((p: { repo: { repoId: string } }) => p.repo.repoId)).toEqual(['b', 'a']);
    expect(saved.projects[0].customName).toBe('中文别名'); expect(saved.activeRepoId).toBe('a');
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => root.render(<App/>)); await flush();
    expect(host.querySelector('.project-switch span')!.textContent).toBe('中文别名');
    expect(host.querySelector('.project-tab.active')!.getAttribute('title')).toBe('C:/a');
    const opens = bridge.open.mock.calls.length;
    await click('.project-tab:first-child .project-close');
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith('b'); expect(bridge.open).toHaveBeenCalledTimes(opens);
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!).projects.map((p: { repo: { repoId: string } }) => p.repo.repoId)).toEqual(['a']);
  });
  it.each(["readable", "empty", "error"])("restarts saved v2 non-first staged tab under StrictMode: %s", async outcome => {
    await mount(["a", "b"]);
    await click('.project-tab:nth-child(2) .project-switch');
    await click('.scope-row button:nth-child(2)');
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_KEY)!);
    expect(saved.activeRepoId).toBe("b"); expect(saved.projects[1].anchor.scope).toBe("staged");
    await act(async () => root.unmount()); root = createRoot(host);
    bridge.open.mockClear(); bridge.read.mockClear(); bridge.refresh.mockClear();
    if (outcome === "error") bridge.open.mockRejectedValueOnce(new Error("saved repo unavailable"));
    if (outcome === "empty") bridge.open.mockResolvedValueOnce({ ...snapshot("b"), scope: "staged", files: [] });
    await act(async () => root.render(<StrictMode><App /></StrictMode>)); await flush();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.open.mock.calls[0].slice(0, 2)).toEqual(["C:/b", "staged"]);
    expect(host.querySelector('.project-tab.active')?.getAttribute('title')).toBe("C:/b");
    expect(host.textContent).not.toContain("正在读取真实仓库");
    expect(host.querySelector('.project-state')).toBeNull();
    if (outcome !== "error") expect(host.querySelector('.restore-status')?.textContent?.split(' · ')[0]).toBe("已同步");
    if (outcome === "readable") expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("b:staged:f");
    if (outcome === "empty") { expect(host.textContent).toContain("当前比较范围没有变化"); expect(host.textContent).not.toContain("未知项目状态"); expect(bridge.read).not.toHaveBeenCalled(); }
    if (outcome === "error") { expect(host.textContent).toContain("saved repo unavailable"); expect(bridge.read).not.toHaveBeenCalled(); expect(host.querySelector('.sidebar > footer')?.textContent).toBe("项目读取失败"); }
    await tick(61000); expect(bridge.refresh).not.toHaveBeenCalled();
  });
  it("automatically opens the first valid record if the saved active ID is invalid", async () => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "missing", projects: ["a", "b"].map(id => ({ repo: repo(id), anchor: defaultAnchor() })) }));
    await act(async () => root.render(<StrictMode><App /></StrictMode>)); await flush();
    expect(bridge.open).toHaveBeenCalledTimes(1); expect(bridge.open.mock.calls[0][0]).toBe("C:/a");
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("a:unstaged:f");
  });
  it("restores only the active repository while initially unfocused", async () => {
    await mount(["a", "b"]);
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.open.mock.calls[0][0]).toBe("C:/a");
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("a:unstaged:f");
    expect(host.textContent).not.toContain("正在读取真实仓库");
    expect(host.querySelector('.restore-status')?.textContent?.split(' · ')[0]).toBe("已同步");
  });
  it("keeps the initialization request through blur during metadata and content reads", async () => {
    const opening = deferred<RepositorySnapshot>(); const reading = deferred<ContentPair>();
    bridge.open.mockReturnValueOnce(opening.promise); bridge.read.mockReturnValueOnce(reading.promise);
    await mount(); await focus(true); await tick(200); await focus(false);
    opening.resolve(snapshot("a")); await flush();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.read).toHaveBeenCalledTimes(1);
    await focus(false); reading.resolve(pair("a")); await flush();
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("a:unstaged:f");
    expect(host.textContent).not.toContain("正在读取真实仓库");
  });
  it("clears loading and shows a useful error when initialization fails unfocused", async () => {
    bridge.open.mockRejectedValueOnce(new Error("repository missing"));
    await mount();
    expect(host.textContent).toContain("项目恢复失败：repository missing");
    expect(host.textContent).not.toContain("正在读取真实仓库");
    expect(host.querySelector('.sidebar > footer')?.textContent).toBe("项目读取失败");
  });
  it("does not refresh after initialization while unfocused; merges focus events and dirty changes", async () => {
    await mount(); const view = host.querySelector('[data-testid="readable"]');
    for (let i = 0; i < 8; i++) bridge.changed?.({ payload: "a" });
    await tick(61000); expect(bridge.refresh).not.toHaveBeenCalled();
    await focus(true); await focus(true); await focus(true); await tick(500);
    expect(bridge.refresh).toHaveBeenCalledTimes(1);
    expect(bridge.read).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="readable"]')).toBe(view);
  });
  it("isolates a slow initial A from an explicit switch to B and allows B to finish unfocused", async () => {
    const slow = deferred<RepositorySnapshot>(); bridge.open.mockReturnValueOnce(slow.promise);
    await mount(["a", "b"]); await click('.project-tab:nth-child(2) .project-switch');
    await focus(false); slow.resolve(snapshot("a")); await flush();
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("b:unstaged:f");
    expect(bridge.read.mock.calls.map(call => call[0])).toEqual(["b"]);
    expect(host.textContent).not.toContain("正在读取真实仓库");
  });
  it("initializes before the initial focus query resolves and does not duplicate a slow focused open", async () => {
    const native = deferred<boolean>(); const opening = deferred<RepositorySnapshot>();
    bridge.queryFocus.mockReturnValue(native.promise); bridge.open.mockReturnValueOnce(opening.promise);
    await mount(); expect(bridge.open).toHaveBeenCalledTimes(1);
    await focus(true); await tick(31000);
    expect(bridge.open).toHaveBeenCalledTimes(1); expect(bridge.refresh).not.toHaveBeenCalled();
    opening.resolve(snapshot("a")); await flush(); native.resolve(false); await flush();
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("a:unstaged:f");
  });
  it.each(["content", "worker"])("reports %s initialization errors and exits loading", async phase => {
    if (phase === "content") bridge.read.mockRejectedValueOnce(new Error("content failed"));
    else bridge.diff.mockRejectedValueOnce(new Error("worker failed"));
    await mount(); await focus(false);
    expect(host.textContent).toContain(`${phase} failed`);
    expect(host.textContent).not.toContain("正在读取真实仓库");
    expect((host.querySelector('.openbar button') as HTMLButtonElement).disabled).toBe(false);
  });
  it("keeps an explicit file read alive across blur", async () => {
    await mount(); const reading = deferred<ContentPair>(); bridge.read.mockReturnValueOnce(reading.promise);
    // A different scope creates an uncached explicit read.
    await click('.scope-row button:nth-child(2)'); await focus(false);
    expect(bridge.read).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="readable"]')).toBeNull();
    reading.resolve(pair("a")); await flush();
    expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();
    expect(host.textContent).not.toContain("正在读取真实仓库");
  });
  it("drops automatic in-flight results after blur and resumes a single check on focus", async () => {
    await mount(); const oldView = host.querySelector('[data-testid="readable"]');
    const pending = deferred<RepositorySnapshot>(); bridge.refresh.mockReturnValueOnce(pending.promise);
    await focus(true); await tick(200); expect(bridge.refresh).toHaveBeenCalledTimes(1);
    await focus(false); pending.resolve(snapshot("a", "r2")); await flush();
    expect(bridge.read).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="readable"]')).toBe(oldView);
    await tick(61000); expect(bridge.refresh).toHaveBeenCalledTimes(1);
    bridge.refresh.mockResolvedValue(snapshot("a", "r2"));
    await focus(true); await focus(true); await tick(500);
    expect(bridge.refresh).toHaveBeenCalledTimes(2); expect(bridge.read).toHaveBeenCalledTimes(2);
  });
  it("restores a legacy record and a StrictMode mount without waiting for focus", async () => {
    localStorage.setItem("oris.recentRepository.v1", JSON.stringify({ path: "C:/legacy" }));
    await act(async () => root.render(<StrictMode><App /></StrictMode>)); await flush();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("legacy:unstaged:f");
  });
  it("finishes initialization even when the native focus query rejects", async () => {
    bridge.queryFocus.mockRejectedValueOnce(new Error("focus unavailable"));
    await mount();
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("a:unstaged:f");
    await tick(61000); expect(bridge.refresh).not.toHaveBeenCalled();
  });
  it("does not let a late initial focus response overwrite a newer focus event", async () => {
    const initial = deferred<boolean>(); bridge.queryFocus.mockReturnValueOnce(initial.promise);
    await mount(); await focus(true); initial.resolve(false); await flush(); await tick(500);
    expect(bridge.refresh).toHaveBeenCalledTimes(1);
  });
});
describe("task03 conflict navigation and partial content", () => {
 it("selects true versions, avoids cache and rejects superseded version requests", async()=>{
  const conflict = snapshot("a");conflict.files[0].status="conflicted";
  bridge.open.mockResolvedValue(conflict);
  const first=pair("a");first.left.endpoint="stage2";first.right.endpoint="stage3";
  bridge.read.mockResolvedValue(first);
  await mount();
  expect(bridge.read.mock.calls[0][6]).toEqual(["stage2","stage3"]);
  const pending=deferred<ContentPair>();bridge.read.mockReturnValueOnce(pending.promise);
  const change=async(selector:string,value:string)=>{await act(async()=>{const field=host.querySelector(selector) as HTMLSelectElement;field.value=value;field.dispatchEvent(new Event("change",{bubbles:true}));});await flush();};
  await change('[aria-label="冲突左版本"]',"stage1");
  const latest=pair("a","latest");latest.left.endpoint="stage1";latest.right.endpoint="workingTree";latest.left.details={state:"ready",reason:null,oid:"real-stage1-oid",mode:"100644",image:null};bridge.read.mockResolvedValueOnce(latest);
  await change('[aria-label="冲突右版本"]',"workingTree");
  expect(bridge.read.mock.calls.at(-1)?.[6]).toEqual(["stage1","workingTree"]);
  expect(host.textContent).toContain("real-stage1-oid");
  const outdated=pair("a","outdated");outdated.left.details={state:"ready",reason:null,oid:"stale-oid",mode:"100644",image:null};
  await act(async()=>pending.resolve(outdated));await flush();
  expect(host.textContent).not.toContain("stale-oid");expect(host.textContent).toContain("real-stage1-oid");
 });
 it("preserves usable text when the other endpoint fails and reports no false zero comparison",async()=>{
  const conflict=snapshot("a");conflict.files[0].status="conflicted";bridge.open.mockResolvedValue(conflict);
  const partial=pair("a");partial.left.text=null;partial.left.details={state:"unavailable",reason:"解码失败",oid:"failed-oid",mode:"100644",image:null};partial.degradation="解码失败";bridge.read.mockResolvedValue(partial);
  await mount();expect(host.textContent).toContain("跨侧差异计数与导航不可计算");expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();expect(bridge.diff).not.toHaveBeenCalled();expect(host.textContent).not.toContain("0 处差异");
 });
});

it("task03 discards conflict content invalidated while reading and allows cancellation followed by another read", async()=>{
  const conflict=snapshot("a");conflict.files[0].status="conflicted";bridge.open.mockResolvedValue(conflict);
  const pending=deferred<ContentPair>();bridge.read.mockReturnValueOnce(pending.promise);
  await mount();await act(async()=>bridge.changed?.({payload:"a"}));
  const result=pair("a");result.left.endpoint="stage2";result.right.endpoint="stage3";
  await act(async()=>pending.resolve(result));await flush();
  expect(host.querySelector('[data-testid="readable"]')).toBeNull();expect(host.textContent).toContain("旧内容已丢弃");
  const cancelled=deferred<ContentPair>();bridge.read.mockReturnValueOnce(cancelled.promise);
  await click('.files button');
  const button=[...host.querySelectorAll('button')].find(node=>node.textContent==="取消读取")!;
  await act(async()=>button.click());await flush();await act(async()=>cancelled.resolve(result));await flush();
  expect(host.querySelector('[data-testid="readable"]')).toBeNull();
  bridge.read.mockResolvedValueOnce(result);await click('.files button');expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();
});
it("task03 same-image reselect and watcher invalidation keep the image visible until a refresh proves it changed",async()=>{
  const snap=snapshot("a");snap.files[0].displayPath="image.png";bridge.open.mockResolvedValue(snap);
  const result=pair("a");result.displayPath="image.png";result.left.text=null;result.right.text=null;
  const details={state:"ready" as const,reason:null,oid:null,mode:null,image:{mime:"image/png",base64:"AA==",width:2,height:3,displayWidth:2,displayHeight:3,orientation:1}};
  result.left.details=details;result.right.details=details;bridge.read.mockResolvedValue(result);
  await mount();expect(host.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
  await click('.files button');expect(host.querySelector('[data-testid="image-viewer"]')).not.toBeNull();expect(bridge.read).toHaveBeenCalledTimes(2);
  await act(async()=>bridge.changed?.({payload:"a"}));await flush();expect(host.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
  await focus(true);await tick(3500);const refreshes=bridge.refresh.mock.calls.length;
  await act(async()=>bridge.changed?.({payload:"a"}));await tick(400);
  expect(bridge.refresh).toHaveBeenCalledTimes(refreshes+1);expect(bridge.read).toHaveBeenCalledTimes(2);expect(host.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
  // A continuous event stream (e.g. an editor rewriting caches) cannot postpone the refresh indefinitely.
  for(let i=0;i<10;i++){await act(async()=>bridge.changed?.({payload:"a"}));await tick(200);}
  expect(bridge.refresh).toHaveBeenCalledTimes(refreshes+2);expect(host.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
});
it("JSON snapshot failure preserves the backend reason instead of generic operation failed", async () => {
  const jsonSnapshot=snapshot("a");jsonSnapshot.files[0]={...jsonSnapshot.files[0],displayPath:"artifacts/task-03/build/debug/.fingerprint/block-buffer-6d3323bfb37c0008/lib-block_buffer.json",status:"untracked"};
  bridge.open.mockResolvedValue(jsonSnapshot);
  bridge.read.mockRejectedValue({kind:"staleRequest"});
  await mount();
  expect(host.querySelector(".state.error p")?.textContent).toContain("刷新");
  expect(host.textContent).not.toContain("操作失败");
});
it("manual refresh retries unread JSON even when repository revision is unchanged", async()=>{
  const snap=snapshot("a");snap.files[0].status="untracked";snap.files[0].displayPath="new.json";
  bridge.open.mockResolvedValue(snap);bridge.refresh.mockResolvedValue(snap);
  bridge.read.mockRejectedValueOnce({kind:"staleRequest"});
  await mount();
  const json=pair("a");json.left={...json.left,encoding:"missing",text:"",byteLength:0};json.right.text='{"valid":true}';bridge.read.mockResolvedValueOnce(json);
  await act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent?.includes("本地刷新"))!.click());await flush();
  expect(bridge.read).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();
});
it("manual refresh keeps repeated JSON read failures visible",async()=>{
  const snap=snapshot("a");snap.files[0].displayPath="new.json";
  bridge.open.mockResolvedValue(snap);bridge.read.mockRejectedValue({kind:"io",message:"读取权限被拒绝"});
  await mount();bridge.refresh.mockResolvedValue({...snap,revision:"r2"});
  await act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent?.includes("本地刷新"))!.click());await flush();
  expect(bridge.read).toHaveBeenCalledTimes(2);expect(host.querySelector('.state.error p')?.textContent).toContain("读取权限被拒绝");
});

it("unchanged automatic repository checks do not dismiss a content read failure", async()=>{
  bridge.read.mockRejectedValue({kind:"io",message:"JSON读取权限被拒绝"});
  await mount();await focus(true);await tick(500);
  expect(bridge.refresh).toHaveBeenCalled();expect(bridge.read).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.state.error p')?.textContent).toContain("JSON读取权限被拒绝");
});

it("manual refresh queues once behind an automatic scan and completes while writes continue", async () => {
  await mount(); await focus(true); await tick(200);
  const slow = deferred<RepositorySnapshot>();
  bridge.refresh.mockReturnValueOnce(slow.promise);
  await tick(1600);
  await act(async () => bridge.changed?.({ payload: "a" })); await tick(350);
  const refreshButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("本地刷新"))!;
  expect(refreshButton.disabled).toBe(false);
  await act(async () => refreshButton.click()); await flush();
  expect(refreshButton.disabled).toBe(true);
  const before = bridge.refresh.mock.calls.length;
  for (let i = 0; i < 10; i++) { await act(async () => bridge.changed?.({ payload: "a" })); await tick(100); }
  expect(bridge.refresh).toHaveBeenCalledTimes(before);
  await act(async () => slow.resolve(snapshot("a", "r2"))); await flush(); await tick(1);
  expect(bridge.refresh).toHaveBeenCalledTimes(before + 1);
  expect(refreshButton.disabled).toBe(false);
  expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();
  await focus(false); const blurred = bridge.refresh.mock.calls.length;
  for (let i = 0; i < 10; i++) { await act(async () => bridge.changed?.({ payload: "a" })); await tick(250); }
  expect(bridge.refresh).toHaveBeenCalledTimes(blurred);
});
it("path-specific unrelated writes preserve displayed conflict content", async () => {
  bridge.open.mockResolvedValue({ ...snapshot("a"), files: [{ ...snapshot("a").files[0], status: "conflicted" }] });
  bridge.read.mockResolvedValue({ ...pair("a"), left: { ...pair("a").left, endpoint: "stage2" }, right: { ...pair("a").right, endpoint: "stage3" } });
  await mount();
  expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();
  await act(async () => (bridge.changed as unknown as (event: { payload: unknown }) => void)?.({ payload: { repoId: "a", paths: ["generated/other.json"], global: false } }));
  expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();
  await act(async () => (bridge.changed as unknown as (event: { payload: unknown }) => void)?.({ payload: { repoId: "a", paths: ["file.txt"], global: false } }));
  expect(host.querySelector('[data-testid="readable"]')).toBeNull();
});

it("unrelated continuous events do not reject an in-flight conflict read", async () => {
  bridge.open.mockResolvedValue({ ...snapshot("a"), files: [{ ...snapshot("a").files[0], status: "conflicted" }] });
  const pending = deferred<ContentPair>(); bridge.read.mockReturnValueOnce(pending.promise);
  await mount();
  for (let i = 0; i < 10; i++) await act(async () => (bridge.changed as unknown as (event: { payload: unknown }) => void)?.({ payload: { repoId: "a", paths: ["generated/other.json"], global: false } }));
  await act(async () => pending.resolve({ ...pair("a"), left: { ...pair("a").left, endpoint: "stage2" }, right: { ...pair("a").right, endpoint: "stage3" } })); await flush();
  expect(host.querySelector('[data-testid="readable"]')).not.toBeNull();
  expect(host.textContent).not.toContain("旧内容已丢弃"); expect(bridge.read).toHaveBeenCalledTimes(1);
});

describe("V2 data layer integration (mocked backend)", () => {
  const v2 = (id: string, revision = "r1"): RepositorySnapshot => {
    const base = snapshot(id, revision);
    const staged = { ...base.files[0], pathId: "s", displayPath: "staged.txt" };
    return { ...base, statsReady: false, scopes: { unstaged: base.files, staged: [staged], all: [...base.files, staged] } };
  };
  it("switches scope locally without starting a backend scan and fills stats in the background", async () => {
    bridge.open.mockImplementation(async (path: string) => v2(path.slice(3)));
    bridge.details.mockResolvedValue({ revision: "r1", elapsedMs: 1, stats: { unstaged: [["f", 7, 2]], staged: [["s", 1, 0]], all: [] }, all: [] });
    await mount(["a"]);
    await tick(10);
    expect(bridge.details).toHaveBeenCalledWith("a", "r1");
    const opens = bridge.open.mock.calls.length, refreshes = bridge.refresh.mock.calls.length;
    await click('.scope:nth-child(2)');
    await tick(10);
    expect([...host.querySelectorAll('.files button')].map(node => node.textContent)).toEqual(["staged.txt"]);
    expect(bridge.open.mock.calls.length).toBe(opens);
    expect(bridge.refresh.mock.calls.length).toBe(refreshes);
    expect(host.querySelector('.sidebar > footer')?.textContent).toContain("已暂存");
  });
  it("shows the persisted snapshot as verifying on restart, then replaces it after verification", async () => {
    const opening = deferred<RepositorySnapshot>();
    bridge.open.mockReturnValueOnce(opening.promise);
    const persisted = v2("a", "old");
    bridge.loadSnapshot.mockResolvedValue(JSON.stringify({ version: 1, savedAt: 1, snapshot: persisted }));
    await mount(["a"]);
    expect(host.querySelector('.verifying')?.textContent).toBe("校验中");
    expect([...host.querySelectorAll('.files button')].map(node => node.textContent)).toEqual(["file.txt"]);
    opening.resolve(v2("a", "r1"));
    await tick(10);
    expect(host.querySelector('.verifying')).toBeNull();
  });
  it("background changes only mark a project dirty; switching back refreshes it, clean projects are not rescanned", async () => {
    bridge.open.mockImplementation(async (path: string) => v2(path.slice(3)));
    bridge.refresh.mockImplementation(async (id: string) => v2(id, "r2"));
    await mount(["a", "b"]);
    await click('.project-tab:nth-child(2) .project-switch');
    await tick(10);
    await click('.project-tab:nth-child(1) .project-switch');
    await tick(10);
    const refreshes = bridge.refresh.mock.calls.length;
    await click('.project-tab:nth-child(2) .project-switch');
    await tick(10);
    expect(bridge.refresh.mock.calls.length).toBe(refreshes);
    await click('.project-tab:nth-child(1) .project-switch');
    await tick(10);
    await act(async () => { bridge.changed?.({ payload: { repoId: "b", paths: ["x.txt"], global: false } } as never); });
    await tick(10);
    expect(bridge.refresh.mock.calls.length).toBe(refreshes);
    await click('.project-tab:nth-child(2) .project-switch');
    await tick(10);
    expect(bridge.refresh.mock.calls.length).toBe(refreshes + 1);
    expect(bridge.refresh.mock.calls.at(-1)?.[0]).toBe("b");
  });
});
