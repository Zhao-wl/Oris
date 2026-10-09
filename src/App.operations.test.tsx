// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareScope, ContentPair, FileChange, RepositorySnapshot } from "./types";
import type { OperationOutcome } from "./operations-api";
import { DRAFTS_KEY } from "./operations-model";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  reviewContext: vi.fn(), reviewInventory: vi.fn(), reviewLocation: vi.fn(), goToLine: vi.fn(), open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), details: vi.fn(), activate: vi.fn(), loadSnapshot: vi.fn(),
  operation: vi.fn(), prepareDiscard: vi.fn(), head: vi.fn(), backups: vi.fn(), planAi: vi.fn(), refs: vi.fn(), reveal: vi.fn(async () => {}),
}));
vi.mock("./api", () => ({ discoverGroup: vi.fn(async () => ({ isGroup: false, members: [], selectedRepoId: null, ignored: [] })), memberChangeCount: vi.fn(async () => 0), watchGroup: vi.fn(async () => {}), setSubmodulePointers: vi.fn(async () => {}), openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: bridge.details, revealInFileManager: bridge.reveal, activateRepository: bridge.activate, loadSnapshot: bridge.loadSnapshot, saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}) }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: bridge.prepareDiscard, discardBackups: bridge.backups, headCommitInfo: bridge.head }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("./ai-api", () => ({ planAiAction: bridge.planAi, generateAiCommit: vi.fn(), cancelAiGeneration: vi.fn(async () => {}) }));
vi.mock("./ai-review/model", async original => ({ ...(await original<typeof import("./ai-review/model")>()), reviewContext: bridge.reviewContext, reviewContextPage: bridge.reviewContext, reviewInventory: bridge.reviewInventory, reviewLocation: bridge.reviewLocation }));
vi.mock("./history-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./history-api")>()), readRefs: bridge.refs }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./DiffViewer", async () => { const { forwardRef, useImperativeHandle } = await import("react"); return { default: forwardRef(({ readingKey }: { readingKey: string }, ref) => { useImperativeHandle(ref, () => ({ goToLine: bridge.goToLine })); return <div data-testid="readable">{readingKey}</div>; }) }; });
vi.mock("./ImageViewer", () => ({ default: () => <div/> }));
import App from "./App";
import { settings } from "./appearance";

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

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  settings.update("ai", "profiles", []); settings.update("ai", "activeId", "");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  bridge.reviewInventory.mockImplementation(async (repoId,range)=>({repoId,range,identity:"empty",revision:"r1",files:[],totalFiles:0,left:null,right:"index"}));
  bridge.details.mockResolvedValue(null); bridge.activate.mockResolvedValue(true); bridge.loadSnapshot.mockResolvedValue(null);
  bridge.backups.mockResolvedValue([]); bridge.head.mockResolvedValue(null);
  bridge.refs.mockResolvedValue({ head: { branch: "main", oid: "h".repeat(40), detached: false, unborn: false }, local: [], remote: [], tags: [], shallow: false, remotes: [], defaultRemote: null, fetchHeadAt: null });
  bridge.open.mockResolvedValue(snap([change("a.txt"), change("b.txt")], []));
  bridge.refresh.mockImplementation(async () => snap([change("a.txt"), change("b.txt")], []));
  bridge.read.mockImplementation(async (_repo: string, _scope: string, revision: string, pathId: string) => pair(pathId, revision));
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string]) => ({ requestId, contentIds, changes: [], hunks: [], elapsedMs: 0 }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  settings.update("ai", "ruleSet", { ...originalRules, routes: originalRules.routes.map(r => r.commandId === "explain" ? { ...r, profileId: "tool-ai" } : r) });
  bridge.planAi.mockResolvedValue({ kind: "answer", message: "已检查当前状态" });
  try {
    await mount(); await click(host.querySelector(".titlebar .commit-entry")!);
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
    for (const text of ["解释当前改动", "@解释 检查改动", "说明审查结果"]) {
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
const reviewSource = { id: "src-id", file: { pathId: "id-a.txt", path: "a.txt", oldPathId: null, oldPath: null, status: "modified" }, side: "right" as const, endpoint: "index", contentId: "r-id-a.txt", lines: [{ line: 1, text: "y" }], truncated: false, supplemental: false };
const reviewFixture = { inventory: { repoId: "a", range: { kind: "staged" as const }, identity: "review-id", revision: "r1", left: "h".repeat(40), right: "index", files: [reviewSource.file], totalFiles: 1 }, sources: [reviewSource], diff: "+y", budget: 40000, used: 20, truncated: false, warnings: [] };
const modelReview = { kind: "answer", message: "reviewed", review: { summary: "reviewed", impact: "impact", findings: [{ title: "Issue", sourceId: "0:src-id", line: 1, evidence: "y", trigger: "trigger", impact: "impact", suggestion: "suggestion" }], commits: [] } };
async function chooseOperationFiles(purpose:"stage"|"commit") {
  bridge.reviewInventory.mockImplementation(async(repoId,range)=>({...reviewFixture.inventory,repoId,range,identity:range.kind,files:range.kind==="unstaged"?[reviewSource.file]:[]}));
  await mount();
  if(purpose==="stage")await click(button("辅助选择…"));
  else {await click(commitTab());await click(button("选择文件 / AI 辅助…"));}
  await click(button("加入全部匹配"));
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.startsWith("应用文件选择"))!);
  expect(bridge.operation).not.toHaveBeenCalled();
}
it("selection only applies a file set; explicit stage uses a revision guarded operation",async()=>{
  await chooseOperationFiles("stage");bridge.operation.mockResolvedValue(outcome("stage",snap([],[change("a.txt")])));
  await click(button("暂存已选文件"));expect(bridge.operation.mock.calls[0][3]).toEqual({kind:"stageSelected",expectedRevision:"r1",pathIds:["id-a.txt"]});
});
it("commit selection reuses the selector and submits only on the commit button",async()=>{
  await chooseOperationFiles("commit");bridge.operation.mockResolvedValue(outcome("commit",snap([],[])));
  await type(host.querySelector<HTMLTextAreaElement>('[aria-label="提交信息"]')!,"selected changes");await click(button("提交"));
  expect(bridge.operation.mock.calls[0][3]).toEqual({kind:"commitSelected",expectedRevision:"r1",pathIds:["id-a.txt"],message:"selected changes"});
});
it("stale selected files never reach the write runner",async()=>{
  await chooseOperationFiles("stage");bridge.reviewInventory.mockResolvedValue({...reviewFixture.inventory,identity:"changed"});
  await click(button("暂存已选文件"));expect(bridge.operation).not.toHaveBeenCalled();expect(host.textContent).toContain("文件选择已过期");
});
async function reviewStart() {
  settings.update("ai", "profiles", [{ id: "test-ai", name: "模型", kind: "cli", provider: "codex", executable: "", baseUrl: "", model: "model", hasKey: false }]); settings.update("ai", "activeId", "test-ai");
  bridge.reviewInventory.mockResolvedValue(reviewFixture.inventory); bridge.reviewContext.mockResolvedValue(reviewFixture);
  await mount(); await click(host.querySelector(".titlebar .commit-entry")!);
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  await type(input, "@审查 检查变更集"); return input;
}
it("review uses routed answer-only transport, validates the result and locates exact content without Git writes", async () => {
  bridge.planAi.mockResolvedValue(modelReview);
  await reviewStart(); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(bridge.planAi.mock.calls[0][5]).toBe(true); expect(bridge.planAi.mock.calls[0][2].review.sources[0]).toMatchObject({id:"0:src-id",file:{path:"a.txt"},side:"right",lines:reviewSource.lines});
  expect(bridge.planAi.mock.calls[0][2].review.sources[0].request).toBeUndefined();
  expect(bridge.reviewContext).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[aria-label="变更集审查结果"]')?.textContent).toContain("Issue");
  bridge.reviewLocation.mockResolvedValue(pair("id-a.txt", "r1"));
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "定位问题")!);
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(host.querySelector('[aria-label="AI 临时对话"]')).toBeNull();
  expect(host.querySelector('.history-badge')?.textContent).toContain("审查定位");
  expect(bridge.goToLine).toHaveBeenCalledWith("right", 1); expect(bridge.operation).not.toHaveBeenCalled();
});
it.each(["provider", "stale", "action"])("review fails accurately for %s and never executes operations", async failure => {
  if (failure === "provider") bridge.planAi.mockRejectedValue(new Error("提供方连接失败"));
  else if (failure === "action") bridge.planAi.mockResolvedValue({ kind: "git", operation: { kind: "stage", pathIds: ["id-a.txt"] } });
  else { bridge.planAi.mockResolvedValue(modelReview); }
  await reviewStart();
  if (failure === "stale") bridge.reviewContext.mockResolvedValueOnce(reviewFixture).mockRejectedValueOnce(new Error("仓库状态已变化"));
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(host.querySelector('[role=alert]')?.textContent).toContain(failure === "provider" ? "提供方连接失败" : failure === "stale" ? "仓库状态已变化" : "只允许回答");
  expect(host.querySelector('[aria-label="变更集审查结果"]')).toBeNull(); expect(bridge.operation).not.toHaveBeenCalled();
});
it("review cancellation discards a late answer and does not publish a partial result", async () => {
  const waiting = deferred<unknown>(); bridge.planAi.mockReturnValue(waiting.promise);
  await reviewStart(); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "停止生成")!);
  waiting.resolve(modelReview); await flush();
  expect(host.querySelector('[aria-label="变更集审查结果"]')).toBeNull(); expect(bridge.operation).not.toHaveBeenCalled();
  expect(host.querySelector('[role=log]')?.textContent).toContain("已停止生成");
});
it("locates a verified text side when the other side is binary using the partial reader", async () => {
  const source = { ...reviewSource, side: "left" as const, contentId: "l-id-a.txt", endpoint: "base", lines: [{ line: 1, text: "x" }] };
  bridge.planAi.mockResolvedValue({ ...modelReview, review: { ...modelReview.review, findings: [{ ...modelReview.review.findings[0], evidence: "x" }] } });
  await reviewStart(); bridge.reviewContext.mockResolvedValue({ ...reviewFixture, sources: [source] });
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  const target = pair("id-a.txt", "r1"); target.right = { ...target.right, text: null, kind: "binary" };
  bridge.reviewLocation.mockResolvedValue(target);
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "定位问题")!);
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(host.querySelector('.partial-notice')).not.toBeNull();
  expect(bridge.goToLine).toHaveBeenCalledWith("left", 1); expect(bridge.operation).not.toHaveBeenCalled();
});
