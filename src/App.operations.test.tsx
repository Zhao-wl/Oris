// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareScope, ContentPair, FileChange, RepositorySnapshot } from "./types";
import type { OperationOutcome } from "./operations-api";
import { DRAFTS_KEY } from "./operations-model";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), details: vi.fn(), activate: vi.fn(), loadSnapshot: vi.fn(),
  operation: vi.fn(), prepareDiscard: vi.fn(), head: vi.fn(), backups: vi.fn(), planAi: vi.fn(), refs: vi.fn(), reveal: vi.fn(async () => {}),
}));
vi.mock("./api", () => ({ discoverGroup: vi.fn(async () => ({ isGroup: false, members: [], selectedRepoId: null, ignored: [] })), memberChangeCount: vi.fn(async () => 0), watchGroup: vi.fn(async () => {}), setSubmodulePointers: vi.fn(async () => {}), openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: bridge.details, revealInFileManager: bridge.reveal, activateRepository: bridge.activate, loadSnapshot: bridge.loadSnapshot, saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}) }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: bridge.prepareDiscard, discardBackups: bridge.backups, headCommitInfo: bridge.head }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("./ai-api", () => ({ planAiAction: bridge.planAi, generateAiCommit: vi.fn(), cancelAiGeneration: vi.fn(async () => {}) }));
vi.mock("./history-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./history-api")>()), readRefs: bridge.refs }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./DiffViewer", () => ({ default: ({ readingKey }: { readingKey: string }) => <div data-testid="readable">{readingKey}</div> }));
vi.mock("./ImageViewer", () => ({ default: () => <div/> }));
import App from "./App";
import { settings } from "./appearance";
import type { FileIgnoreRule } from "./file-ignore";

const repo = { repoId: "a", displayName: "a", worktreePath: "C:/a", gitDir: "C:/a/.git", commonDir: "C:/a/.git", branch: "main" };
const change = (path: string, status: FileChange["status"] = "modified"): FileChange => ({ pathId: `id-${path}`, displayPath: path, oldPathId: null, oldDisplayPath: null, status, additions: 1, deletions: 0 });
const snap = (unstaged: FileChange[], staged: FileChange[], revision = "r1", scope: CompareScope = "unstaged"): RepositorySnapshot => ({
  requestId: "s", repo, scope, revision, scannedAt: 1, files: scope === "staged" ? staged : unstaged, statsReady: true,
  scopes: { unstaged, staged, all: [...unstaged, ...staged] }, branchInfo: { head: "main", oid: "h".repeat(40), upstream: null, ahead: null, behind: null },
  inProgress: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false },
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" }
});
const pair = (pathId: string, revision: string): ContentPair => ({ requestId: "c", repoId: "a", revision, pathId, displayPath: pathId, stale: false, degradation: null,
  left: { endpoint: "index", text: "x", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: `l-${pathId}` },
  right: { endpoint: "workingTree", text: "y", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: `r-${pathId}` } });
const outcome = (kind: OperationOutcome["kind"], snapshot: RepositorySnapshot | null, extra: Partial<OperationOutcome> = {}): OperationOutcome => ({
  opId: "op", repoId: "a", kind, status: "succeeded", message: "done", output: "", outputTruncated: false, snapshot, confirmation: null, backup: null, lockLeft: false, gitProcesses: 1, elapsedMs: 5, ...extra });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const rows = () => [...host.querySelectorAll(".file")].map((n) => n.getAttribute("aria-label"));
const row = (path: string) => host.querySelector(`.file[aria-label="${path}"]`) as HTMLElement;
const rowButton = (path: string, label: string) => [...row(path).querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const commitTab = () => [...host.querySelectorAll(".git-tabs button")].find((b) => b.textContent?.startsWith("提交 ·")) as HTMLButtonElement;
const contextMenu = async (path: string) => { await act(async () => { row(path).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); }); await flush(); };
const menuItem = (prefix: string) => [...host.querySelectorAll(".file-menu button")].find((b) => b.textContent!.startsWith(prefix)) as HTMLButtonElement | undefined;
const click = async (element: HTMLElement) => { await act(async () => element.click()); await flush(); };
const clickWith = async (path: string, modifiers: MouseEventInit) => { await act(async () => { row(path).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers })); }); await flush(); };
const selectedRows = () => [...host.querySelectorAll(".file.selected")].map((n) => n.getAttribute("aria-label"));
const type = async (element: HTMLTextAreaElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
  await flush();
};
const mount = async () => {
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [{ repo, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }] }));
  await act(async () => { root.render(<App />); }); await flush();
};

// 可选导出真实 React 标记供无窗口 Chromium 复测 CSS；仓库/内容仍为本文件的替身。
const captureLayout = (name: string) => {
  const capture = (globalThis as { orisLayoutCapture?: (name: string, html: string) => void }).orisLayoutCapture;
  if (!capture) return;
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const originals = document.querySelectorAll("input, select, textarea");
  clone.querySelectorAll("input, select, textarea").forEach((element, index) => {
    const original = originals[index];
    if (element instanceof HTMLInputElement && original instanceof HTMLInputElement) {
      element.setAttribute("value", original.value); element.toggleAttribute("checked", original.checked);
    } else if (element instanceof HTMLSelectElement && original instanceof HTMLSelectElement) {
      [...element.options].forEach((option, index) => option.toggleAttribute("selected", original.options[index].selected));
    } else if (element instanceof HTMLTextAreaElement && original instanceof HTMLTextAreaElement) element.textContent = original.value;
  });
  capture(name, `<!doctype html>${clone.outerHTML}`);
};

describe("工单 #36：忽略规则与 AI 配置（DOM，不调用原生窗口）", () => {
  const dsRule = (extra: Partial<FileIgnoreRule> = {}): FileIgnoreRule => ({ id: "ds", repoId: "a", kind: "glob", pattern: "**/.DS_Store", enabled: true, caseSensitive: true, ...extra });
  const aiReady = () => {
    settings.update("ai", "profiles", [{ id: "test-ai", name: "Test AI", kind: "cli", provider: "codex", executable: "/bin/false", baseUrl: "", model: "test-model", hasKey: false }]);
    settings.update("ai", "activeId", "test-ai");
  };
  const send = async (text: string) => {
    await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, text);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!);
  };
  const openIgnore = async () => {
    await click(host.querySelector<HTMLButtonElement>('[aria-label="设置"]')!);
    await click(host.querySelector<HTMLButtonElement>('[aria-controls="settings-git-subnav"]')!);
    await click(button("忽略文件"));
  };
  const setPattern = async (text: string) => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="忽略规则模式"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); }); await flush();
  };
  it("初次加载、三个范围、临时显示与停用规则；真实 Git 计数不受隐藏影响", async () => {
    settings.update("fileIgnore", "rules", [dsRule()]);
    bridge.open.mockResolvedValue(snap([change(".DS_Store", "untracked"), change("json/.DS_Store"), change("src/app.ts")], [change("deep/.DS_Store")]));
    await mount();
    expect(rows()).toEqual(["src/app.ts"]);
    expect(bridge.read.mock.calls[0][3]).toBe("id-src/app.ts");
    expect(host.querySelector(".ignore-status")).toBeNull();
    // 文件列表必须仍是侧栏的第四个网格项，占用 1fr；不能再插入控制区。
    expect(host.querySelector(".sidebar")?.children[3]).toBe(host.querySelector(".files"));
    expect(host.querySelector(".sidebar")?.textContent).not.toContain("忽略规则");
    captureLayout("sidebar");
    expect(button("提交 · 1")).toBeTruthy();
    await click(button("已暂存"));
    expect(rows()).toEqual([]);
    expect(host.querySelector(".files")?.textContent).toContain("已全部忽略");
    await openIgnore();
    captureLayout("settings");
    expect(host.querySelector(".ignore-preview [role=status]")?.textContent).toContain("匹配 1 个文件");
    await click(host.querySelector('[aria-label="临时显示被忽略文件"]')!);
    await click(host.querySelector('[aria-label="关闭设置"]')!);
    expect(rows()).toEqual(["deep/.DS_Store"]);
    await click(button("全部"));
    expect(rows()).toHaveLength(4);
    await openIgnore();
    await click(host.querySelector('[aria-label="临时显示被忽略文件"]')!);
    await click(host.querySelector('[aria-label="关闭设置"]')!);
    expect(rows()).toEqual(["src/app.ts"]);
    await act(async () => { settings.update("fileIgnore", "rules", [dsRule({ enabled: false })]); }); await flush();
    expect(rows()).toHaveLength(4);
    expect(bridge.operation).not.toHaveBeenCalled();
  });
  it("忽略操作全部位于 Git 设置子项，规则生效后切换阅读并可删除", async () => {
    bridge.open.mockResolvedValue(snap([change(".DS_Store"), change("json/.DS_Store"), change("src/app.ts")], []));
    await mount(); await contextMenu(".DS_Store");
    expect(menuItem("忽略")).toBeUndefined();
    await openIgnore();
    expect(host.querySelector('.settings-dialog h3')?.textContent).toBe("忽略文件");
    expect(button("忽略文件").closest("#settings-git-subnav")).toBeTruthy();
    await setPattern(".DS_Store"); await click(button("添加规则"));
    expect(rows()).toEqual(["src/app.ts"]);
    expect(host.querySelector(".file.selected")?.getAttribute("aria-label")).toBe("src/app.ts");
    await setPattern("src/app.ts"); await click(button("添加规则"));
    expect(rows()).toEqual([]); expect(host.querySelector('[data-testid="readable"]')).toBeNull();
    await click(host.querySelector('[aria-label="删除 .DS_Store"]')!);
    expect(rows()).toEqual([".DS_Store", "json/.DS_Store"]);
    expect(bridge.operation).not.toHaveBeenCalled();
  });
  it("AI 配置通过真实设置链生效，并向模型提供当前规则；非法目标不写入", async () => {
    aiReady(); bridge.open.mockResolvedValue(snap([change(".DS_Store"), change("src/app.ts")], []));
    bridge.planAi.mockResolvedValue({ kind: "fileIgnore", operation: { action: "add", rule: { id: ".DS_Store", pattern: ".DS_Store" } } });
    await mount(); await click(host.querySelector(".titlebar .commit-entry")!);
    await send("@设置 当前项目忽略所有目录下的 .DS_Store");
    expect(rows()).toEqual(["src/app.ts"]);
    expect(settings.get().fileIgnore.rules).toHaveLength(1);
    expect(settings.get().fileIgnore.rules[0]).toMatchObject({ pattern: ".DS_Store", kind: "name", repoId: "a", enabled: true, caseSensitive: true });
    const saved = settings.get().fileIgnore.rules[0];
    expect(host.querySelector(".ai-commit-dialog")?.textContent).toContain("忽略规则已保存");
    const context = bridge.planAi.mock.calls[0][2] as { fileIgnore: { currentRepoId: string; rules: unknown[] }; capability: { fileIgnore: unknown } };
    expect(context.fileIgnore).toEqual(expect.objectContaining({ currentRepoId: "a", rules: [] }));
    expect(context.capability.fileIgnore).toBeTruthy();
    bridge.planAi.mockResolvedValue({ kind: "fileIgnore", operation: { action: "add", rule: dsRule({ id: "wrong", repoId: "battle" }) } });
    await send("@设置 忽略另一个项目的文件");
    expect(settings.get().fileIgnore.rules).toEqual([saved]);
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("目标仓库");
    bridge.planAi.mockResolvedValue({ kind: "fileIgnore", operation: { action: "delete", id: saved.id } });
    await send("@设置 取消当前项目对 .DS_Store 的忽略");
    expect(settings.get().fileIgnore.rules).toEqual([]); expect(rows()).toHaveLength(2);
    expect(bridge.operation).not.toHaveBeenCalled();
  });
  it("AI 规划期间规则改变时拒绝旧计划", async () => {
    aiReady(); await mount(); await click(host.querySelector(".titlebar .commit-entry")!);
    const pending = deferred<unknown>(); bridge.planAi.mockReturnValue(pending.promise);
    await send("@设置 忽略 .DS_Store");
    await act(async () => { settings.update("fileIgnore", "rules", [dsRule({ id: "newer" })]); });
    pending.resolve({ kind: "fileIgnore", operation: { action: "add", rule: dsRule() } }); await flush();
    expect(settings.get().fileIgnore.rules.map(r => r.id)).toEqual(["newer"]);
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("规则已变化");
  });
  it("AI 全部暂存排除忽略文件；不能静默操作指定的隐藏文件", async () => {
    aiReady(); settings.update("fileIgnore", "rules", [dsRule()]);
    const original = snap([change(".DS_Store"), change("a.txt"), change("b.txt")], []);
    bridge.open.mockResolvedValue(original); bridge.refresh.mockResolvedValue(original);
    bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "stage", pathIds: "all" } });
    bridge.operation.mockResolvedValue(outcome("stage", original));
    await mount(); await click(host.querySelector(".titlebar .commit-entry")!); await send("暂存全部");
    expect(bridge.operation.mock.calls[0][3]).toEqual({ kind: "stage", pathIds: ["id-a.txt", "id-b.txt"] });
    bridge.operation.mockClear(); bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "stage", pathIds: ["id-.DS_Store"] } });
    await send("暂存 .DS_Store");
    expect(bridge.operation).not.toHaveBeenCalled();
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("被忽略的文件");
  });
  it("提交面板列出忽略但已暂存的文件，不擅自取消暂存", async () => {
    settings.update("fileIgnore", "rules", [dsRule()]);
    bridge.open.mockResolvedValue(snap([change("a.txt")], [change("json/.DS_Store"), change("b.txt")]));
    await mount(); await click(commitTab());
    expect(host.querySelector(".ignore-commit-warning")?.textContent).toContain("仍会提交");
    expect(host.querySelector(".ignore-commit-warning")?.textContent).toContain("json/.DS_Store");
    expect(button("提交 · 2")).toBeTruthy(); expect(bridge.operation).not.toHaveBeenCalled();
  });
  it("设置页手动添加与编辑规则，非法模式报错；启停立即恢复列表", async () => {
    bridge.open.mockResolvedValue(snap([change("json/.DS_Store"), change("a.txt")], []));
    await mount(); await openIgnore();
    const input = host.querySelector<HTMLInputElement>('[aria-label="忽略规则模式"]')!;
    const setInput = async (text: string) => {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); }); await flush();
    };
    await setInput("**/.DS_Store"); await click(button("添加规则"));
    expect(rows()).toEqual(["a.txt"]);
    expect(settings.get().fileIgnore.rules[0]).toMatchObject({ repoId: "a", pattern: "**/.DS_Store" });
    await click(host.querySelector('[aria-label="编辑 **/.DS_Store"]')!);
    await setInput("../bad"); await click(button("保存规则"));
    expect(host.querySelector(".file-ignore-settings [role=alert]")?.textContent).toContain("无效");
    expect(rows()).toEqual(["a.txt"]);
    await setInput("*.txt"); await click(button("保存规则"));
    expect(rows()).toEqual(["json/.DS_Store"]);
    await click(host.querySelector('[aria-label="启用 *.txt"]')!);
    expect(rows()).toHaveLength(2);
    expect(settings.get().fileIgnore.rules[0].enabled).toBe(false);
  });
  it("AI 更新和启停规则即时生效；已有忽略暂存内容时拒绝直接 AI 提交", async () => {
    aiReady(); settings.update("fileIgnore", "rules", [dsRule()]);
    const original = snap([change("a.txt"), change("json/.DS_Store")], [change(".DS_Store")]);
    bridge.open.mockResolvedValue(original); bridge.refresh.mockResolvedValue(original);
    await mount(); await click(host.querySelector(".titlebar .commit-entry")!);
    bridge.planAi.mockResolvedValue({ kind: "fileIgnore", operation: { action: "update", rule: dsRule({ pattern: "*.txt" }) } });
    await send("@设置 将规则改为忽略 txt 文件");
    expect(rows()).toEqual(["json/.DS_Store"]);
    bridge.planAi.mockResolvedValue({ kind: "fileIgnore", operation: { action: "setEnabled", id: "ds", repoId: "a", enabled: false } });
    await send("@设置 停用规则"); expect(rows()).toHaveLength(2);
    bridge.planAi.mockResolvedValue({ kind: "fileIgnore", operation: { action: "update", rule: dsRule() } });
    await send("@设置 恢复忽略 .DS_Store");
    bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "commit", message: "test" } });
    await send("提交暂存内容");
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("仍会进入提交");
    expect(bridge.operation).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  settings.update("ai", "profiles", []); settings.update("ai", "activeId", ""); settings.update("fileIgnore", "rules", []);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  bridge.details.mockResolvedValue(null); bridge.activate.mockResolvedValue(true); bridge.loadSnapshot.mockResolvedValue(null);
  bridge.backups.mockResolvedValue([]); bridge.head.mockResolvedValue(null);
  bridge.refs.mockResolvedValue({ head: { branch: "main", oid: "h".repeat(40), detached: false, unborn: false }, local: [], remote: [], tags: [], shallow: false, remotes: [], defaultRemote: null, fetchHeadAt: null });
  bridge.open.mockResolvedValue(snap([change("a.txt"), change("b.txt")], []));
  bridge.refresh.mockImplementation(async () => snap([change("a.txt"), change("b.txt")], []));
  bridge.read.mockImplementation(async (_repo: string, _scope: string, revision: string, pathId: string) => pair(pathId, revision));
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string]) => ({ requestId, contentIds, changes: [], hunks: [], elapsedMs: 0 }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); settings.update("fileIgnore", "rules", []); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("stage / unstage (B05, B16)", () => {
  it("moves the file optimistically before Git confirms, disables other writes meanwhile, then applies the confirmed snapshot", async () => {
    const pending = deferred<OperationOutcome>();
    bridge.operation.mockReturnValue(pending.promise);
    await mount();
    expect(rows()).toEqual(["a.txt", "b.txt"]);
    await click(rowButton("a.txt", "暂存"));
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "stage", pathIds: ["id-a.txt"] });
    expect(rows()).toEqual(["b.txt"]);
    expect(button("提交 · 1")).toBeTruthy();
    // B16：写操作进行中，同仓库的其他写入口不可用并说明原因。
    expect(rowButton("b.txt", "暂存").disabled).toBe(true);
    expect(rowButton("b.txt", "暂存").title).toContain("正在执行");
    expect(host.querySelector(".op-status.running")?.textContent).toContain("正在暂存");
    pending.resolve(outcome("stage", snap([change("b.txt")], [change("a.txt")], "r2"), { message: "已暂存 1 个文件" }));
    await flush();
    expect(rows()).toEqual(["b.txt"]);
    expect(host.querySelector(".file.selected")?.getAttribute("aria-label")).toBe("b.txt");
    expect(rowButton("b.txt", "暂存").disabled).toBe(false);
    expect(host.querySelector(".op-status")?.textContent).toContain("已暂存 1 个文件");
    expect(host.querySelector(".selection-notice")).toBeNull();
  });

  it("rolls back the optimistic move when the operation is rejected before running (e.g. external index.lock)", async () => {
    bridge.operation.mockRejectedValue({ kind: "externalLock", message: "另一个 Git 进程正在使用该仓库（存在 index.lock）" });
    await mount();
    await click(rowButton("a.txt", "暂存"));
    expect(rows()).toEqual(["a.txt", "b.txt"]);
    expect(host.querySelector(".op-status.failed")?.textContent).toContain("index.lock");
  });

  it("disables write entries while a restored snapshot is still verifying (V2-D08)", async () => {
    const opening = deferred<RepositorySnapshot>();
    bridge.open.mockReturnValue(opening.promise);
    bridge.loadSnapshot.mockResolvedValue(JSON.stringify({ version: 1, snapshot: { ...snap([change("a.txt")], []), files: [] } }));
    await mount();
    expect(rows()).toEqual(["a.txt"]);
    expect(rowButton("a.txt", "暂存").disabled).toBe(true);
    expect(rowButton("a.txt", "暂存").title).toContain("校验");
    opening.resolve(snap([change("a.txt")], []));
    await flush();
    expect(rowButton("a.txt", "暂存").disabled).toBe(false);
  });

  it("Ctrl / Shift + click build a multi-selection; right-click stages all selected; the row button stages only its own file", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt"), change("b.txt"), change("c.txt"), change("d.txt")], []));
    bridge.operation.mockResolvedValue(outcome("stage", snap([change("a.txt"), change("c.txt"), change("d.txt")], [change("b.txt")], "r2")));
    await mount();
    expect(host.querySelector(".file-check")).toBeNull();
    await clickWith("a.txt", {});
    await clickWith("c.txt", { shiftKey: true });
    expect(selectedRows()).toEqual(["a.txt", "b.txt", "c.txt"]);
    await clickWith("b.txt", { ctrlKey: true });
    expect(selectedRows()).toEqual(["a.txt", "c.txt"]);
    await clickWith("b.txt", { ctrlKey: true });
    expect(selectedRows()).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(host.querySelector(".sidebar > footer")?.textContent).toContain("已选 3 个");
    expect(bridge.operation).not.toHaveBeenCalled();
    // 行上的按钮只作用于该行，即使该行在多选中。
    await click(rowButton("b.txt", "暂存"));
    expect(bridge.operation).toHaveBeenLastCalledWith("a", "unstaged", expect.any(String), { kind: "stage", pathIds: ["id-b.txt"] });
    bridge.operation.mockClear();
    expect(rows()).toEqual(["a.txt", "c.txt", "d.txt"]);
    await clickWith("a.txt", {});
    await clickWith("c.txt", { ctrlKey: true });
    await contextMenu("c.txt");
    expect(host.querySelector(".file-menu")?.textContent).toContain("已选中 2 个文件");
    await click(menuItem("暂存")!);
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "stage", pathIds: ["id-a.txt", "id-c.txt"] });
  });

  it("keeps every Ctrl + click even when several arrive before a re-render", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt"), change("b.txt"), change("c.txt"), change("d.txt")], []));
    await mount();
    await act(async () => {
      row("a.txt").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (const path of ["b.txt", "c.txt", "d.txt"]) row(path).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    await flush();
    expect(selectedRows()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
  });

  it("the file context menu opens the right-clicked file in the file manager", async () => {
    bridge.open.mockResolvedValue(snap([change("sub/a.txt"), change("b.txt")], []));
    await mount();
    await contextMenu("b.txt");
    await click(menuItem("在资源管理器中打开")!);
    expect(bridge.reveal).toHaveBeenLastCalledWith("a", "b.txt");
  });

  it("right-clicking an unselected file selects only that file", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt"), change("b.txt"), change("c.txt")], []));
    await mount();
    await clickWith("a.txt", {});
    await clickWith("b.txt", { ctrlKey: true });
    await contextMenu("c.txt");
    expect(selectedRows()).toEqual(["c.txt"]);
    expect(host.querySelector(".file-menu")?.textContent).not.toContain("已选中");
  });
});

describe("discard (B06)", () => {
  it("confirms with the file count and untracked files; cancelling runs nothing; an over-budget file is marked irreversible", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt"), change("new.txt", "untracked")], []));
    bridge.prepareDiscard.mockResolvedValue({ scope: "unstaged", files: 2, untracked: 1, paths: ["a.txt", "new.txt"], unrecoverable: [], blocked: [] });
    await mount();
    await clickWith("a.txt", {});
    await clickWith("new.txt", { ctrlKey: true });
    expect(rowButton("a.txt", "丢弃…")).toBeUndefined();
    await contextMenu("a.txt");
    expect(host.querySelector(".file-menu")?.textContent).toContain("已选中 2 个文件");
    expect(menuItem("暂存")?.textContent).toBe("暂存（2 个文件）");
    await click(menuItem("丢弃…")!);
    const dialog = host.querySelector(".confirm-dialog")!;
    expect(dialog.querySelector("h3")?.textContent).toBe("丢弃 2 个文件的改动");
    expect(dialog.textContent).toContain("1 个是未跟踪文件");
    expect(dialog.querySelector(".confirm-warning")).toBeNull();
    await click(button("取消"));
    expect(host.querySelector(".confirm-dialog")).toBeNull();
    expect(bridge.operation).not.toHaveBeenCalled();
    bridge.prepareDiscard.mockResolvedValue({ scope: "unstaged", files: 1, untracked: 0, paths: ["a.txt"], unrecoverable: ["a.txt"], blocked: [] });
    bridge.operation.mockResolvedValue(outcome("discard", snap([change("new.txt", "untracked")], [], "r2"), { backup: { id: "b1", createdAt: 1, scope: "unstaged", files: 1, unrecoverable: 1, paths: ["a.txt"] } }));
    await clickWith("a.txt", {});
    await contextMenu("a.txt");
    expect(host.querySelector(".file-menu")?.textContent).not.toContain("已选中");
    await click(menuItem("丢弃…")!);
    expect(host.querySelector(".confirm-warning")?.textContent).toContain("不可撤销");
    await click(button("丢弃（含不可撤销）"));
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "discard", scope: "unstaged", pathIds: ["id-a.txt"], confirmedUnrecoverable: true });
  });

  it("disables discard for gitlinks and conflicts with a reason; conflicts offer mark-resolved instead", async () => {
    bridge.open.mockResolvedValue(snap([{ ...change("sub"), gitlink: true }, change("c.txt", "conflicted")], [change("c.txt", "conflicted")]));
    await mount();
    await contextMenu("sub");
    expect(menuItem("丢弃…")!.disabled).toBe(true);
    expect(menuItem("丢弃…")!.title).toContain("gitlink");
    expect(rowButton("c.txt", "标记已解决")).toBeTruthy();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); }); await flush();
    await contextMenu("c.txt");
    expect(menuItem("标记已解决")).toBeTruthy();
    expect(menuItem("丢弃…")!.disabled).toBe(true);
    expect(menuItem("暂存")!.disabled).toBe(true);
  });
});

describe("commit panel (B07)", () => {
  it("uses the model plan and expands a scope-wide selector without a second confirmation", async () => {
    settings.update("ai", "profiles", [{ id: "test-ai", name: "Test AI", kind: "cli", provider: "codex", executable: "/bin/false", baseUrl: "", model: "test-model", hasKey: false }]);
    settings.update("ai", "activeId", "test-ai");
    bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "stage", pathIds: "all" } });
    bridge.operation.mockResolvedValue(outcome("stage", snap([], [change("a.txt"), change("b.txt")], "r2")));
    await mount();
    await click(host.querySelector(".titlebar .commit-entry")!);
    await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "暂存仓库");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!);
    expect(bridge.planAi).toHaveBeenCalledOnce();
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "stage", pathIds: ["id-a.txt", "id-b.txt"] });
    expect(host.querySelector(".ai-commit-dialog [role=log]")?.textContent).toContain("done");
    expect(host.querySelector(".confirm-dialog")).toBeNull();
  });
  it("lets the model choose all staged files for a different prompt", async () => {
    settings.update("ai", "profiles", [{ id: "test-ai", name: "Test AI", kind: "cli", provider: "codex", executable: "/bin/false", baseUrl: "", model: "test-model", hasKey: false }]);
    settings.update("ai", "activeId", "test-ai");
    bridge.open.mockResolvedValue(snap([], [change("a.txt"), change("b.txt")]));
    bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "unstage", pathIds: "all" } });
    bridge.operation.mockResolvedValue(outcome("unstage", snap([change("a.txt"), change("b.txt")], [], "r2")));
    await mount();
    await click(host.querySelector(".titlebar .commit-entry")!);
    await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "取消暂存");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!);
    expect(bridge.planAi).toHaveBeenCalledOnce();
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "unstage", pathIds: ["id-a.txt", "id-b.txt"] });
    expect(host.querySelector(".ai-commit-dialog [role=log]")?.textContent).toContain("done");
  });
  it("V2-D68：AI 丢弃不代替用户确认，后端要求确认时停止并说明、不重试", async () => {
    settings.update("ai", "profiles", [{ id: "test-ai", name: "Test AI", kind: "cli", provider: "codex", executable: "/bin/false", baseUrl: "", model: "test-model", hasKey: false }]);
    settings.update("ai", "activeId", "test-ai");
    bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "discard", scope: "unstaged", pathIds: ["id-a.txt"], confirmedUnrecoverable: true } });
    bridge.operation.mockResolvedValue(outcome("discard", null, { status: "needsConfirmation", message: "需要确认", confirmation: { reason: "unrecoverable", message: "1 个文件超过 50 MiB 备份预算，丢弃后不可撤销", paths: ["a.txt"] } }));
    await mount();
    await click(host.querySelector(".titlebar .commit-entry")!);
    await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "丢弃 a.txt");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!);
    expect(bridge.operation).toHaveBeenCalledOnce();
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "discard", scope: "unstaged", pathIds: ["id-a.txt"], confirmedUnrecoverable: false });
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("丢弃后不可撤销");
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("AI 不代替你确认");
    expect(host.querySelector(".confirm-dialog")).toBeNull();
  });
  it("AI 执行时前置检查未通过（例如外部 index.lock）：输入框显示具体原因，不重试", async () => {
    settings.update("ai", "profiles", [{ id: "test-ai", name: "Test AI", kind: "cli", provider: "codex", executable: "/bin/false", baseUrl: "", model: "test-model", hasKey: false }]);
    settings.update("ai", "activeId", "test-ai");
    bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "stage", pathIds: ["id-a.txt"] } });
    bridge.operation.mockRejectedValue(new Error("另一个 Git 进程正在使用仓库（存在 index.lock）"));
    await mount();
    await click(host.querySelector(".titlebar .commit-entry")!);
    await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "暂存 a.txt");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!);
    expect(bridge.operation).toHaveBeenCalledOnce();
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("index.lock");
  });
  it("V2-D67：AI 不能修改 Git 可执行文件路径；规划上下文不含 Git 设置", async () => {
    settings.update("ai", "profiles", [{ id: "test-ai", name: "Test AI", kind: "cli", provider: "codex", executable: "/bin/false", baseUrl: "", model: "test-model", hasKey: false }]);
    settings.update("ai", "activeId", "test-ai");
    const before = settings.get().git.executable;
    bridge.planAi.mockResolvedValue({ kind: "settings", setting: "gitExecutable", value: "C:/evil/git.exe" });
    await mount();
    await click(host.querySelector(".titlebar .commit-entry")!);
    await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "@设置 改 Git 路径");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!);
    expect(settings.get().git.executable).toBe(before);
    expect(host.querySelector(".ai-commit-dialog [role=alert]")?.textContent).toContain("AI 不能修改 Git 可执行文件路径");
    const context = bridge.planAi.mock.calls[0][2] as Record<string, unknown>;
    expect(context).not.toHaveProperty("gitSetting");
    expect(JSON.stringify((context.capability as { settings: object }).settings)).not.toContain("gitExecutable");
  });
  it("opens the AI commit input from the top button and the window shortcut", async () => {
    await mount();
    await click(host.querySelector(".titlebar .commit-entry")!);
    expect(host.querySelector('.ai-commit-dialog textarea[rows="2"]')).not.toBeNull();
    await act(async () => { host.querySelector(".ai-commit-overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(host.querySelector(".ai-commit-dialog")).toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true })); });
    expect(host.querySelector(".ai-commit-dialog")).not.toBeNull();
  });
  it("saves the draft per project across restarts, explains why commit is unavailable, and clears the draft after a successful commit", async () => {
    await mount();
    await click(commitTab());
    const textarea = host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement;
    await type(textarea, "feat: 草稿\n\n正文");
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!)).toEqual({ a: "feat: 草稿\n\n正文" });
    expect(button("提交").disabled).toBe(true);
    expect(button("提交").title).toContain("没有已暂存的内容");
    // 重启：草稿恢复。
    await act(async () => root.unmount()); root = createRoot(host);
    bridge.open.mockResolvedValue(snap([change("b.txt")], [change("a.txt", "added")]));
    await mount();
    await click(commitTab());
    expect((host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement).value).toBe("feat: 草稿\n\n正文");
    bridge.operation.mockResolvedValue(outcome("commit", snap([change("b.txt")], [], "r3"), { message: "已提交：abcdef12" }));
    await click(button("提交"));
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "commit", message: "feat: 草稿\n\n正文" });
    expect((host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement).value).toBe("");
    expect(localStorage.getItem(DRAFTS_KEY)).toBe("{}");
    expect(host.querySelector(".commit-result.succeeded")?.textContent).toContain("已提交");
  });

  it("disables undo for a pushed HEAD and while the HEAD info is older than the snapshot's HEAD", async () => {
    bridge.open.mockResolvedValue(snap([], [change("a.txt", "added")]));
    bridge.head.mockResolvedValue({ oid: "h".repeat(40), parents: ["p".repeat(40)], message: "original message", subject: "original message", pushed: true, upstream: "origin/main", detached: false });
    await mount();
    await click(commitTab());
    expect(button("撤销最近提交…").disabled).toBe(true);
    expect(button("撤销最近提交…").title).toContain("origin/main");
    await act(async () => root.unmount()); root = createRoot(host);
    bridge.head.mockResolvedValue({ oid: "o".repeat(40), parents: ["p".repeat(40)], message: "old head", subject: "old head", pushed: null, upstream: null, detached: false });
    await mount();
    await click(commitTab());
    expect(button("撤销最近提交…").disabled).toBe(true);
    expect(button("撤销最近提交…").title).toContain("正在读取 HEAD");
  });

  it("commit and push: pushes after a successful commit, publishing the branch when it has no upstream", async () => {
    const withUpstream = (s: RepositorySnapshot): RepositorySnapshot => ({ ...s, branchInfo: { ...s.branchInfo!, upstream: "origin/main", ahead: 1, behind: 0 } });
    bridge.open.mockResolvedValue(snap([], [change("a.txt", "added")]));
    bridge.operation.mockImplementation(async (_repo: string, _scope: string, _op: string, request: { kind: string }) => request.kind === "commit"
      ? outcome("commit", withUpstream(snap([], [], "r2")), { message: "已提交：abcdef12" })
      : outcome("push", withUpstream(snap([], [], "r3")), { message: "已推送" }));
    await mount();
    await click(commitTab());
    await type(host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement, "feat: x");
    await click(host.querySelector("input[aria-label='提交并推送']") as HTMLElement);
    await click(button("提交并推送"));
    expect(bridge.operation.mock.calls.map((call) => call[3])).toEqual([{ kind: "commit", message: "feat: x" }, { kind: "push", remote: null }]);

    // 没有上游：同样一键发布，由后端推送到仅有的 remote 并设为上游（多个 remote 时再请用户选择）。
    await act(async () => root.unmount()); root = createRoot(host);
    bridge.operation.mockReset();
    bridge.operation.mockImplementation(async (_repo: string, _scope: string, _op: string, request: { kind: string }) => request.kind === "commit"
      ? outcome("commit", snap([], [], "r2"), { message: "已提交：abcdef12" })
      : outcome("push", withUpstream(snap([], [], "r3")), { message: "已推送并设为上游" }));
    await mount();
    await click(commitTab());
    await type(host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement, "feat: y");
    await click(host.querySelector("input[aria-label='提交并推送']") as HTMLElement);
    await click(button("提交并推送"));
    expect(bridge.operation.mock.calls.map((call) => call[3])).toEqual([{ kind: "commit", message: "feat: y" }, { kind: "push", remote: null }]);
  });

  it("disables commit and push on a detached HEAD", async () => {
    bridge.open.mockResolvedValue(snap([], [change("a.txt", "added")]));
    bridge.head.mockResolvedValue({ oid: "h".repeat(40), parents: ["p".repeat(40)], message: "m", subject: "m", pushed: null, upstream: null, detached: true });
    await mount();
    await click(commitTab());
    const box = host.querySelector("input[aria-label='提交并推送']") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.closest("label")?.title).toContain("分离 HEAD");
  });

  it("shows failing hook output and keeps the draft", async () => {
    bridge.open.mockResolvedValue(snap([], [change("a.txt", "added")]));
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ a: "wip" }));
    bridge.operation.mockResolvedValue(outcome("commit", snap([], [change("a.txt", "added")], "r2"), { status: "failed", message: "提交失败：退出码 1；没有生成提交", output: "HOOK-FAIL-MARKER: lint failed" }));
    await mount();
    await click(commitTab());
    await click(button("提交"));
    expect(host.querySelector(".commit-result.failed pre")?.textContent).toContain("HOOK-FAIL-MARKER");
    expect((host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement).value).toBe("wip");
  });
});

it("keeps the main request prefix stable around a routed one-shot command and reads ordinary diff without conflict versions", async () => {
  settings.update("ai", "profiles", [
    { id: "test-ai", name: "主模型", kind: "cli", provider: "codex", executable: "", baseUrl: "", model: "main-model", hasKey: false },
    { id: "tool-ai", name: "工具模型", kind: "cli", provider: "claude", executable: "", baseUrl: "", model: "tool-model", hasKey: false }
  ]);
  settings.update("ai", "activeId", "test-ai");
  const originalRules = settings.get().ai.ruleSet;
  settings.update("ai", "ruleSet", { ...originalRules, routes: originalRules.routes.map(r => r.commandId === "review" ? { ...r, profileId: "tool-ai" } : r) });
  bridge.planAi.mockResolvedValue({ kind: "answer", message: "已检查当前状态" });
  try {
    await mount(); await click(host.querySelector(".titlebar .commit-entry")!);
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
    for (const text of ["解释当前改动", "@审查 检查改动", "说明审查结果"]) {
      await type(input, text); await click(host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!);
    }
    expect(bridge.planAi).toHaveBeenCalledTimes(3);
    const [first, tool, last] = bridge.planAi.mock.calls;
    expect(first[0].model).toBe("main-model"); expect(tool[0].model).toBe("tool-model"); expect(last[0].model).toBe("main-model");
    expect(last[3]).toBe(first[3]); expect(last[6].startsWith(first[6])).toBe(true);
    expect(tool[6]).toBeUndefined(); expect(tool[2].conversation).toHaveLength(2);
    expect(last[6]).toContain('"role":"tool"'); expect(last[3]).not.toContain("只报告有代码依据的问题");
    expect(bridge.read.mock.calls.every(call => call[6] === undefined)).toBe(true);
  } finally { settings.update("ai", "ruleSet", originalRules); }
});
