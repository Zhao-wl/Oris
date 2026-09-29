// @vitest-environment jsdom
// 任务 V2-07 工作区的界面流程（B31–B35 的前端部分）：添加即识别、成员并入、标题栏选择器切换、指针开关、嵌套仓库说明、移除整个工作区。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareScope, ContentPair, GroupDiscovery, GroupMember, RepositorySnapshot } from "./types";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), close: vi.fn(), diff: vi.fn(), queryFocus: vi.fn(),
  details: vi.fn(), activate: vi.fn(), loadSnapshot: vi.fn(), saveSnapshot: vi.fn(),
  discover: vi.fn(), count: vi.fn(), watch: vi.fn(), pointers: vi.fn(), dialog: vi.fn(),
  focused: true, focus: null as null | ((event: { payload: boolean }) => void),
  changed: null as null | ((event: { payload: unknown }) => void),
}));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: bridge.close, cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: bridge.details, activateRepository: bridge.activate, loadSnapshot: bridge.loadSnapshot, saveSnapshot: bridge.saveSnapshot, removeSnapshot: vi.fn(async () => {}),
  discoverGroup: bridge.discover, memberChangeCount: bridge.count, watchGroup: bridge.watch, setSubmodulePointers: bridge.pointers }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: bridge.dialog }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isFocused: bridge.queryFocus,
  onFocusChanged: async (callback: typeof bridge.focus) => { bridge.focus = callback; return () => { if (bridge.focus === callback) bridge.focus = null; }; },
}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, callback: typeof bridge.changed) => {
  if (name !== "repository-invalidated") return () => {};
  bridge.changed = callback; return () => { if (bridge.changed === callback) bridge.changed = null; };
} }));
vi.mock("./operations-api", () => ({ runOperation: vi.fn(), cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: vi.fn(), discardBackups: vi.fn(async () => []), headCommitInfo: vi.fn(async () => null) }));
vi.mock("./DiffViewer", () => ({ default: ({ readingKey }: { readingKey: string }) => <div data-testid="readable">{readingKey}</div> }));
vi.mock("./FileTree", () => ({
  compareFiles: (a: { displayPath: string }, b: { displayPath: string }) => a.displayPath.localeCompare(b.displayPath),
  default: ({ files, onSelect }: { files: RepositorySnapshot["files"]; onSelect: (file: RepositorySnapshot["files"][number]) => void }) => <>{files.map(file => <button key={file.pathId} className="file-row" onClick={() => onSelect(file)}>{file.displayPath}</button>)}</>,
}));
vi.mock("./ImageViewer", () => ({ default: () => <div data-testid="image-viewer"/> }));
import App from "./App";

const ROOT = "C:/ws";
const idOf = (path: string) => path === ROOT ? "ws" : path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1).replace(/\//g, "-") : path.slice(3);
const repo = (id: string, path: string) => ({ repoId: id, displayName: path.split("/").pop()!, worktreePath: path, gitDir: `${path}/.git`, commonDir: `${path}/.git`, branch: "dev" });
const snapshot = (path: string, extra: Partial<RepositorySnapshot> = {}): RepositorySnapshot => ({
  requestId: "snapshot", repo: repo(idOf(path), path), scope: "unstaged", revision: "r1", scannedAt: 1,
  files: [{ pathId: `f-${idOf(path)}`, displayPath: `${idOf(path)}.txt`, oldPathId: null, oldDisplayPath: null, status: "modified", additions: 1, deletions: 1 }],
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" },
  scopes: { unstaged: [{ pathId: `f-${idOf(path)}`, displayPath: `${idOf(path)}.txt`, oldPathId: null, oldDisplayPath: null, status: "modified", additions: 1, deletions: 1 }], staged: [], all: [] },
  ...(path === ROOT ? { hasSubmodules: true, nestedRepos: ["battle-r2"] } : {}),
  ...extra,
});
const pair = (id: string, pathId: string): ContentPair => ({
  requestId: "content", repoId: id, revision: "r1", pathId, displayPath: "x", stale: false, degradation: null,
  left: { endpoint: "index", text: "a", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: "l" },
  right: { endpoint: "workingTree", text: "b", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: "r" },
});
const member = (name: string, kind: GroupMember["kind"], extra: Partial<GroupMember> = {}): GroupMember => {
  const path = kind === "superproject" ? ROOT : `${ROOT}/${name}`;
  return { repoId: idOf(path), kind, name, worktreePath: path, relativePath: kind === "superproject" ? "" : name, parentRepoId: kind === "superproject" ? null : "ws", state: "ready",
    gitDir: `${path}/.git`, commonDir: `${path}/.git`, branch: "dev", headOid: "b".repeat(40), recordedOid: kind === "submodule" ? "a".repeat(40) : null, ...extra };
};
const discovery = (selected = "ws"): GroupDiscovery => ({
  isGroup: true, selectedRepoId: selected, ignored: [],
  members: [member("ws", "superproject"), member("audio", "submodule", { repoId: null, state: "uninitialized", gitDir: null, commonDir: null, headOid: null }),
    member("battle", "submodule"), member("battle-r2", "worktree", { parentRepoId: "battle", recordedOid: null }), member("client", "submodule")],
});

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const click = async (element: Element | null) => { expect(element).not.toBeNull(); await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const text = (selector: string) => host.querySelector(selector)?.textContent ?? "";
const tabs = () => [...host.querySelectorAll(".project-tab")].map((tab) => tab.querySelector(".project-switch > span")?.textContent);
const saved = () => JSON.parse(localStorage.getItem(WORKSPACE_KEY)!) as { activeRepoId: string; projects: { repo: { repoId: string }; groupId?: string; group?: { lastRepoId: string; manual: string[] }; customName?: string; showSubmodulePointers?: boolean }[] };
const mount = async (projects: { id: string; path: string; customName?: string }[] = []) => {
  if (projects.length) localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: projects[0].id, projects: projects.map(({ id, path, customName }) => ({ repo: repo(id, path), gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor(), customName })) }));
  await act(async () => { root.render(<App />); }); await flush();
};
const addPath = async (path: string) => {
  if (!host.querySelector(".projectbar")) await mount();
  bridge.dialog.mockResolvedValueOnce(path);
  await click(host.querySelector(".projectbar > button.primary"));
};

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  bridge.focused = true; bridge.focus = null; bridge.changed = null;
  bridge.queryFocus.mockImplementation(async () => bridge.focused);
  bridge.details.mockResolvedValue(null); bridge.activate.mockResolvedValue(true); bridge.loadSnapshot.mockResolvedValue(null); bridge.saveSnapshot.mockResolvedValue(true);
  bridge.watch.mockResolvedValue(undefined); bridge.pointers.mockResolvedValue(undefined); bridge.close.mockResolvedValue(undefined);
  bridge.count.mockImplementation(async (path: string) => path.endsWith("client") ? 12 : 0);
  bridge.discover.mockImplementation(async (path: string) => path.startsWith(ROOT) ? discovery(path === ROOT ? "ws" : idOf(path)) : { isGroup: false, members: [], selectedRepoId: null, ignored: [] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  bridge.open.mockImplementation(async (path: string, scope: CompareScope) => ({ ...snapshot(path), scope }));
  bridge.refresh.mockImplementation(async (id: string, scope: CompareScope) => ({ ...snapshot(id === "ws" ? ROOT : ["battle", "battle-r2", "client"].includes(id) ? `${ROOT}/${id}` : `C:/${id}`), scope, revision: "r2" }));
  bridge.read.mockImplementation(async (id: string, _scope: string, _revision: string, pathId: string) => pair(id, pathId));
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string]) => ({ requestId, contentIds, changes: [], hunks: [], elapsedMs: 0 }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("工作区（V2-07）", () => {
  it("添加父仓库即识别为工作区：一个标签、标题栏为选择器、共用 watcher；已添加的成员直接并入", async () => {
    await mount([{ id: "oris", path: "C:/oris" }, { id: "client", path: `${ROOT}/client`, customName: "客户端" }]);
    // 已有的独立 client 项目（repoId 与发现结果一致）。
    bridge.discover.mockImplementation(async (path: string) => path.startsWith(ROOT) ? { ...discovery(path === ROOT ? "ws" : idOf(path)), members: discovery().members.map((m) => m.name === "client" ? { ...m, repoId: "client" } : m) } : { isGroup: false, members: [], selectedRepoId: null, ignored: [] });
    await addPath(ROOT);
    expect(tabs()).toEqual(["Oris".toLowerCase(), "工作区ws"]);
    expect(host.querySelector(".project-tab.active")?.getAttribute("title")).toBe(ROOT);
    expect(text(".repo-picker-button")).toBe("ws▾");
    expect(bridge.watch).toHaveBeenCalledWith("ws", expect.arrayContaining([expect.objectContaining({ repoId: "ws" }), expect.objectContaining({ repoId: "client" }), expect.objectContaining({ repoId: "battle-r2" })]), null);
    expect(bridge.watch.mock.calls[0][1][0].repoId).toBe("ws");
    expect(text(".sync-toast")).toContain("已作为工作区添加 ws");
    expect(text(".sync-toast")).toContain("原来单独添加的 客户端 已并入工作区");
    const client = saved().projects.find((p) => p.repo.repoId === "client")!;
    expect(client.groupId).toBe("ws"); expect(client.customName).toBe("客户端");
    // 父仓库只显示自身：嵌套仓库目录折叠说明，属于成员的可以切换。
    expect(text(".nested-repos summary")).toBe("1 个嵌套仓库未显示");
    expect(text(".nested-repo")).toContain("battle 的 worktree");
    expect(host.querySelector(".nested-repo button")?.textContent).toBe("切换");
  });

  it("选择器切换成员：未初始化的不能打开，徽标只在打开时读取（最多 2 个并发），一切只针对当前仓库并在重启后恢复", async () => {
    await addPath(ROOT);
    expect(bridge.count).not.toHaveBeenCalled();
    await click(host.querySelector(".repo-picker-button"));
    const rows = () => [...host.querySelectorAll(".repo-row")];
    expect(rows().map((row) => row.querySelector(".repo-row-name")?.firstChild?.textContent)).toEqual(["ws", "audio", "battle", "battle-r2", "client"]);
    const audio = rows()[1];
    expect(audio.getAttribute("aria-disabled")).toBe("true");
    expect(audio.textContent).toContain("git submodule update --init -- audio");
    expect(rows()[2].textContent).toContain("偏离记录");
    expect(bridge.count.mock.calls.map((call) => call[0]).sort()).toEqual([`${ROOT}/battle`, `${ROOT}/battle-r2`, `${ROOT}/client`]);
    expect(rows()[4].textContent).toContain("12 个改动");
    expect(rows()[0].textContent).toContain("1 个改动");
    await click(audio);
    expect(host.querySelector(".repo-picker")).not.toBeNull();
    const opens = bridge.open.mock.calls.length;
    await click(rows()[4]);
    expect(host.querySelector(".repo-picker")).toBeNull();
    expect(bridge.open.mock.calls[opens][0]).toBe(`${ROOT}/client`);
    expect(text(".repo-picker-button")).toBe("client▾");
    expect(host.querySelector(".project-tab.active")?.getAttribute("title")).toBe(ROOT);
    expect(host.querySelector('[data-testid="readable"]')?.textContent).toBe("client:unstaged:f-client");
    expect(host.querySelector(".pointer-switch")).toBeNull();
    expect(saved().activeRepoId).toBe("client");
    expect(saved().projects.find((p) => p.repo.repoId === "ws")!.group!.lastRepoId).toBe("client");
    // Ctrl+E 打开 / 关闭选择器；键盘 ↓ 跳过不可打开的成员。
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true })); }); await flush();
    expect(host.querySelector(".repo-picker")).not.toBeNull();
    await act(async () => { host.querySelector(".repo-picker")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); }); await flush();
    expect(host.querySelector(".repo-row.cursor .repo-row-name")?.firstChild?.textContent).toBe("ws");
    await act(async () => { host.querySelector(".repo-picker")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); await flush();
    expect(host.querySelector(".repo-picker")).toBeNull();
    // 重启：恢复到上次的成员。
    await act(async () => root.unmount()); root = createRoot(host);
    bridge.open.mockClear();
    await act(async () => { root.render(<App />); }); await flush();
    expect(bridge.open.mock.calls[0][0]).toBe(`${ROOT}/client`);
    expect(text(".repo-picker-button")).toBe("client▾");
  });

  it("直接添加子模块目录：打开所属工作区并选中该子模块", async () => {
    await addPath(`${ROOT}/battle`);
    expect(tabs()).toEqual(["工作区ws"]);
    expect(text(".repo-picker-button")).toBe("battle▾");
    expect(text(".sync-toast")).toContain("battle 属于工作区 ws");
  });

  it("子模块指针开关按仓库保存，切换后重新扫描；子模块提交变化让父仓库刷新", async () => {
    await addPath(ROOT);
    const toggle = host.querySelector(".pointer-switch")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    bridge.refresh.mockClear();
    await click(toggle);
    expect(bridge.pointers).toHaveBeenCalledWith("ws", true);
    expect(bridge.refresh).toHaveBeenCalledWith("ws", "unstaged", expect.any(String), false);
    expect(host.querySelector(".pointer-switch")!.getAttribute("aria-checked")).toBe("true");
    expect(saved().projects.find((p) => p.repo.repoId === "ws")!.showSubmodulePointers).toBe(true);
    // 子模块中的提交（refs 事件）：父仓库是当前仓库且开关打开，父仓库刷新。
    bridge.refresh.mockClear();
    vi.useFakeTimers();
    await act(async () => { bridge.changed?.({ payload: { repoId: "battle", paths: [], global: false, kinds: ["refs"] } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); await flush();
    vi.useRealTimers();
    expect(bridge.refresh).toHaveBeenCalledWith("ws", "unstaged", expect.any(String), false);
    // 只有成员登记变化（members）：重新发现，不刷新当前仓库。
    bridge.refresh.mockClear(); bridge.discover.mockClear();
    await act(async () => { bridge.changed?.({ payload: { repoId: "battle", paths: [], global: false, kinds: ["members"] } }); }); await flush();
    expect(bridge.discover).toHaveBeenCalledWith(ROOT, [], null);
    expect(bridge.refresh).not.toHaveBeenCalled();
  });

  it("嵌套仓库可以手动加入工作区并移出；移除工作区标签时关闭全部成员", async () => {
    bridge.open.mockImplementation(async (path: string, scope: CompareScope) => ({ ...snapshot(path), scope, ...(path === ROOT ? { hasSubmodules: true, nestedRepos: ["tools/standalone"] } : {}) }));
    await addPath(ROOT);
    expect(text(".nested-repo")).toContain("独立仓库，未加入工作区");
    const standalone = member("standalone", "manual", { worktreePath: `${ROOT}/tools/standalone`, relativePath: "tools/standalone", repoId: "tools-standalone" });
    bridge.discover.mockImplementation(async (path: string, manual: string[]) => ({ ...discovery(), members: [...discovery().members, ...(manual.length ? [standalone] : [])] }));
    await click(host.querySelector(".nested-repo button"));
    expect(bridge.discover).toHaveBeenLastCalledWith(ROOT, ["C:/ws/tools/standalone"], null);
    expect(saved().projects.find((p) => p.repo.repoId === "ws")!.group!.manual).toEqual(["C:/ws/tools/standalone"]);
    expect(text(".sync-toast")).toContain("已把 standalone 加入工作区");
    await click(host.querySelector(".repo-picker-button"));
    const manualRow = [...host.querySelectorAll(".repo-row")].find((row) => row.textContent?.includes("standalone"))!;
    expect(manualRow.previousElementSibling?.textContent).toBe("手动加入");
    await click(manualRow.querySelector(".repo-remove"));
    expect(saved().projects.find((p) => p.repo.repoId === "ws")!.group!.manual).toEqual([]);
    // 移除工作区：只删应用记录；父仓库与全部成员都关闭。
    await click(host.querySelector(".project-tab .project-close"));
    expect(saved().projects).toEqual([]);
    expect(bridge.close.mock.calls.map((call) => call[0]).sort()).toEqual(expect.arrayContaining(["battle", "battle-r2", "client", "ws"]));
  });
});
