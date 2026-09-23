// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareScope, ContentPair, RepositorySnapshot } from "./types";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), close: vi.fn(), diff: vi.fn(), queryFocus: vi.fn(),
  focused: false, focus: null as null | ((event: { payload: boolean }) => void),
  changed: null as null | ((event: { payload: string }) => void),
}));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: bridge.close }));
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
