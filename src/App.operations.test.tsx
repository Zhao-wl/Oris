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
  operation: vi.fn(), prepareDiscard: vi.fn(), head: vi.fn(), backups: vi.fn(),
}));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: bridge.details, activateRepository: bridge.activate, loadSnapshot: bridge.loadSnapshot, saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}) }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: bridge.prepareDiscard, discardBackups: bridge.backups, headCommitInfo: bridge.head }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./DiffViewer", () => ({ default: ({ readingKey }: { readingKey: string }) => <div data-testid="readable">{readingKey}</div> }));
vi.mock("./ImageViewer", () => ({ default: () => <div/> }));
import App from "./App";

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
const click = async (element: HTMLElement) => { await act(async () => element.click()); await flush(); };
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  bridge.details.mockResolvedValue(null); bridge.activate.mockResolvedValue(true); bridge.loadSnapshot.mockResolvedValue(null);
  bridge.backups.mockResolvedValue([]); bridge.head.mockResolvedValue(null);
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

  it("batch-stages checked files; checkboxes only select targets", async () => {
    bridge.operation.mockResolvedValue(outcome("stage", snap([], [change("a.txt"), change("b.txt")], "r2")));
    await mount();
    await click(row("a.txt").querySelector(".file-check") as HTMLElement);
    await click(row("b.txt").querySelector(".file-check") as HTMLElement);
    expect(bridge.operation).not.toHaveBeenCalled();
    await click(button("暂存所选"));
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "stage", pathIds: ["id-a.txt", "id-b.txt"] });
  });
});

describe("discard (B06)", () => {
  it("confirms with the file count and untracked files; cancelling runs nothing; an over-budget file is marked irreversible", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt"), change("new.txt", "untracked")], []));
    bridge.prepareDiscard.mockResolvedValue({ scope: "unstaged", files: 2, untracked: 1, paths: ["a.txt", "new.txt"], unrecoverable: [], blocked: [] });
    await mount();
    await click(row("a.txt").querySelector(".file-check") as HTMLElement);
    await click(row("new.txt").querySelector(".file-check") as HTMLElement);
    await click(button("丢弃所选…"));
    const dialog = host.querySelector(".confirm-dialog")!;
    expect(dialog.querySelector("h3")?.textContent).toBe("丢弃 2 个文件的改动");
    expect(dialog.textContent).toContain("1 个是未跟踪文件");
    expect(dialog.querySelector(".confirm-warning")).toBeNull();
    await click(button("取消"));
    expect(host.querySelector(".confirm-dialog")).toBeNull();
    expect(bridge.operation).not.toHaveBeenCalled();
    bridge.prepareDiscard.mockResolvedValue({ scope: "unstaged", files: 1, untracked: 0, paths: ["a.txt"], unrecoverable: ["a.txt"], blocked: [] });
    bridge.operation.mockResolvedValue(outcome("discard", snap([change("new.txt", "untracked")], [], "r2"), { backup: { id: "b1", createdAt: 1, scope: "unstaged", files: 1, unrecoverable: 1, paths: ["a.txt"] } }));
    await click(rowButton("a.txt", "丢弃…"));
    expect(host.querySelector(".confirm-warning")?.textContent).toContain("不可撤销");
    await click(button("丢弃（含不可撤销）"));
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "discard", scope: "unstaged", pathIds: ["id-a.txt"], confirmedUnrecoverable: true });
  });

  it("disables discard for gitlinks and conflicts with a reason; conflicts offer mark-resolved instead", async () => {
    bridge.open.mockResolvedValue(snap([{ ...change("sub"), gitlink: true }, change("c.txt", "conflicted")], [change("c.txt", "conflicted")]));
    await mount();
    expect(rowButton("sub", "丢弃…").disabled).toBe(true);
    expect(rowButton("sub", "丢弃…").title).toContain("gitlink");
    expect(rowButton("c.txt", "标记已解决")).toBeTruthy();
    expect(rowButton("c.txt", "丢弃…")).toBeUndefined();
  });
});

describe("commit panel (B07)", () => {
  it("saves the draft per project across restarts, explains why commit is unavailable, and clears the draft after a successful commit", async () => {
    await mount();
    await click(button("提交 · 0"));
    const textarea = host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement;
    await type(textarea, "feat: 草稿\n\n正文");
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!)).toEqual({ a: "feat: 草稿\n\n正文" });
    expect(button("提交").disabled).toBe(true);
    expect(host.querySelector(".commit-reason")?.textContent).toContain("没有已暂存的内容");
    // 重启：草稿恢复。
    await act(async () => root.unmount()); root = createRoot(host);
    bridge.open.mockResolvedValue(snap([change("b.txt")], [change("a.txt", "added")]));
    await mount();
    await click(button("提交 · 1"));
    expect((host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement).value).toBe("feat: 草稿\n\n正文");
    bridge.operation.mockResolvedValue(outcome("commit", snap([change("b.txt")], [], "r3"), { message: "已提交：abcdef12" }));
    await click(button("提交"));
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "commit", message: "feat: 草稿\n\n正文", amend: false, keepMessage: false, expectedHead: null });
    expect((host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement).value).toBe("");
    expect(localStorage.getItem(DRAFTS_KEY)).toBe("{}");
    expect(host.querySelector(".commit-result.succeeded")?.textContent).toContain("已提交");
  });

  it("disables amend and undo for a pushed HEAD, and prefills the original message for amend", async () => {
    bridge.open.mockResolvedValue(snap([], [change("a.txt", "added")]));
    bridge.head.mockResolvedValue({ oid: "h".repeat(40), parents: ["p".repeat(40)], message: "original message", subject: "original message", pushed: true, upstream: "origin/main", detached: false });
    await mount();
    await click(button("提交 · 1"));
    expect(button("撤销最近提交…").disabled).toBe(true);
    expect(button("撤销最近提交…").title).toContain("origin/main");
    await click(host.querySelector("input[aria-label='修订最近一次提交（amend）']") as HTMLElement);
    expect((host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement).value).toBe("original message");
    expect(button("修订提交").disabled).toBe(true);
    expect(host.querySelector(".commit-reason")?.textContent).toContain("强制推送");
  });

  it("shows failing hook output and keeps the draft", async () => {
    bridge.open.mockResolvedValue(snap([], [change("a.txt", "added")]));
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ a: "wip" }));
    bridge.operation.mockResolvedValue(outcome("commit", snap([], [change("a.txt", "added")], "r2"), { status: "failed", message: "提交失败：退出码 1；没有生成提交", output: "HOOK-FAIL-MARKER: lint failed" }));
    await mount();
    await click(button("提交 · 1"));
    await click(button("提交"));
    expect(host.querySelector(".commit-result.failed pre")?.textContent).toContain("HOOK-FAIL-MARKER");
    expect((host.querySelector("textarea[aria-label='提交信息']") as HTMLTextAreaElement).value).toBe("wip");
  });
});
