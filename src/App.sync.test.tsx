// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPair, FileChange, InProgressSummary, RepositorySnapshot } from "./types";
import type { OperationOutcome, OperationRequest } from "./operations-api";
import type { RefsView } from "./history-api";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), operation: vi.fn(), refs: vi.fn(), log: vi.fn(), changes: vi.fn(), mergeMessage: vi.fn()
}));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: vi.fn(async () => null), activateRepository: vi.fn(async () => true), loadSnapshot: vi.fn(async () => null), saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}), decodeContentFrame: (x: unknown) => x }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: vi.fn(), discardBackups: vi.fn(async () => []), headCommitInfo: vi.fn(async () => null) }));
vi.mock("./history-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./history-api")>()),
  readLog: bridge.log, commitChanges: bridge.changes, compareRevisions: vi.fn(), fileHistory: vi.fn(), readRefs: bridge.refs, readRevisionPair: vi.fn(),
  stashList: vi.fn(async () => []), stashChanges: vi.fn(), checkBranchName: vi.fn(async () => {}), mergeMessage: bridge.mergeMessage }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./DiffViewer", () => ({ default: ({ readingKey }: { readingKey: string }) => <div data-testid="readable">{readingKey}</div> }));
vi.mock("./ImageViewer", () => ({ default: () => <div/> }));
import App from "./App";

const O = (c: string) => c.repeat(40);
const repo = { repoId: "a", displayName: "a", worktreePath: "C:/a", gitDir: "C:/a/.git", commonDir: "C:/a/.git", branch: "main" };
const change = (path: string, status: FileChange["status"] = "modified"): FileChange => ({ pathId: `id-${path}`, displayPath: path, oldPathId: null, oldDisplayPath: null, status, additions: 1, deletions: 0 });
const idle: InProgressSummary = { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false };
const snap = (files: FileChange[] = [change("a.txt")], inProgress: InProgressSummary = idle, upstream: string | null = "origin/main"): RepositorySnapshot => ({ requestId: "s", repo, scope: "unstaged", revision: `r-${files.map((f) => f.status).join()}-${inProgress.merge}`, scannedAt: 1, files, statsReady: true,
  scopes: { unstaged: files, staged: [], all: files }, branchInfo: { head: "main", oid: O("1"), upstream, ahead: upstream ? 1 : null, behind: upstream ? 2 : null }, inProgress,
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" } });
const pair = (id: string): ContentPair => ({ requestId: "c", repoId: "a", revision: "x", pathId: id, displayPath: id, stale: false, degradation: null,
  left: { endpoint: "index", text: "l", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: `l-${id}` },
  right: { endpoint: "workingTree", text: "r", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: `r-${id}` } });
const refsView = (overrides: Partial<RefsView> = {}, tracking: RefsView["local"][number]["tracking"] = { state: "known", upstream: "refs/remotes/origin/main", ahead: 1, behind: 2 }): RefsView => ({
  head: { branch: "refs/heads/main", oid: O("1"), detached: false, unborn: false },
  local: [
    { fullName: "refs/heads/main", name: "main", kind: "local", oid: O("1"), current: true, tracking, remote: "origin" },
    { fullName: "refs/heads/topic", name: "topic", kind: "local", oid: O("2"), current: false, tracking: { state: "noUpstream" }, remote: null }
  ],
  remote: [{ fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remote", oid: O("3"), current: false, tracking: null, remote: "origin" }],
  shallow: false, remotes: ["origin"], defaultRemote: "origin", fetchHeadAt: null, pullRebase: null, mergeFf: null, ...overrides
});
const outcome = (kind: OperationOutcome["kind"], extra: Partial<OperationOutcome> = {}): OperationOutcome => ({ opId: "op", repoId: "a", kind, status: "succeeded", message: "done", output: "", outputTruncated: false, snapshot: snap(), confirmation: null, backup: null, lockLeft: false, gitProcesses: 1, elapsedMs: 1, ...extra });

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector(selector) as T | null;
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click()); await flush(); };
const requests = () => bridge.operation.mock.calls.map((call) => call[3] as OperationRequest);
const openSync = async () => { await click(q(".sync-button")); };
const mount = async () => { await act(async () => { root.render(<App />); }); await flush(); };

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  bridge.open.mockResolvedValue(snap());
  bridge.refresh.mockResolvedValue(snap());
  bridge.read.mockImplementation(async (_r: string, _s: string, _v: string, pathId: string) => pair(pathId));
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string]) => ({ requestId, contentIds, changes: [], hunks: [], elapsedMs: 0 }));
  bridge.refs.mockResolvedValue(refsView());
  bridge.log.mockResolvedValue({ commits: [{ oid: O("2"), parents: [O("1")], subject: "topic work", body: "", authorName: "A", authorEmail: "a@x", authorTime: 1_700_000_000, committerName: "A", committerEmail: "a@x", committerTime: 1_700_000_000, refs: [] }], next: null, tips: [] });
  bridge.changes.mockResolvedValue({ oid: O("2"), parent: O("1"), parents: [O("1")], files: [] });
  bridge.mergeMessage.mockResolvedValue("Merge branch 'topic'");
  bridge.operation.mockImplementation(async (_repo: string, _scope: string, _op: string, request: OperationRequest) => outcome(request.kind === "stashApply" && request.pop ? "stashPop" : request.kind));
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [{ repo, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sync entry (B11)", () => {
  it("shows the branch, upstream and ahead / behind, and offers fetch, pull and push in one place", async () => {
    await mount();
    expect(q(".branch-counts")?.textContent).toBe("↑1 ↓2");
    await openSync();
    const pop = q(".sync-popover")!;
    expect(pop.textContent).toContain("● main → origin/main");
    expect(pop.textContent).toContain("↑1 ↓2");
    expect(button("获取…", pop).disabled).toBe(false);
    expect(button("选项…", pop).disabled).toBe(false);
    expect(button("预览…", pop).disabled).toBe(false);
    await click(button("获取…", pop));
    expect(q(".fetch-dialog")).toBeTruthy();
  });

  it("disables pull without an upstream and guides to set one; detached HEAD disables push too", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt")], idle, null));
    bridge.refs.mockResolvedValue(refsView({}, { state: "noUpstream" }));
    await mount();
    expect(q(".titlebar")?.textContent).toContain("无上游");
    await openSync();
    const pop = q(".sync-popover")!;
    expect(button("选项…", pop).disabled).toBe(true);
    expect(pop.textContent).toContain("当前分支没有上游");
    await click(button("设置上游…", pop));
    expect(q(".branch-dialog")?.textContent).toContain("设置 main 的上游");
    await click(button("取消", q(".branch-dialog")!));
    bridge.refs.mockResolvedValue(refsView({ head: { branch: null, oid: O("1"), detached: true, unborn: false }, local: refsView().local.map((b) => ({ ...b, current: false })) }));
    await openSync();
    expect(button("预览…", q(".sync-popover")!).disabled).toBe(true);
    expect(q(".sync-popover")?.textContent).toContain("分离 HEAD");
  });

  it("pulls fast-forward only by default, explains pull.rebase, offers merge on divergence and stash when local changes block", async () => {
    bridge.refs.mockResolvedValue(refsView({ pullRebase: "true" }));
    bridge.operation
      .mockImplementationOnce(async () => outcome("pull", { status: "needsConfirmation", snapshot: null, confirmation: { reason: "diverged", message: "本地分支 main 与 origin/main 已分叉，无法仅快进", paths: [] } }))
      .mockImplementationOnce(async () => outcome("pull", { status: "needsConfirmation", snapshot: null, confirmation: { reason: "localChanges", message: "工作区改动会被拉取覆盖", paths: ["a.txt"] } }));
    await mount();
    await openSync();
    await click(button("选项…", q(".sync-popover")!));
    const dialog = q(".pull-dialog")!;
    expect(dialog.textContent).toContain("pull.rebase=true");
    expect(dialog.textContent).toContain("会以合并方式执行");
    expect((dialog.querySelector("input[aria-label=仅快进]") as HTMLInputElement).checked).toBe(true);
    await click(button("拉取", dialog));
    expect(requests()[0]).toEqual({ kind: "pull", mode: "ffOnly" });
    expect(q(".confirm-dialog")?.textContent).toContain("已分叉");
    await click(button("改用合并拉取", q(".confirm-dialog")!));
    expect(requests()[1]).toEqual({ kind: "pull", mode: "merge" });
    expect(q(".confirm-dialog")?.textContent).toContain("stash 后拉取");
    await click(button("stash 后拉取", q(".confirm-dialog")!));
    expect(requests()[2]).toEqual({ kind: "pull", mode: "merge", stashFirst: true, stashUntracked: false });
  });

  it("pushes to the upstream, or to the only remote with -u when there is no upstream; never offers force", async () => {
    await mount();
    await openSync();
    await click(button("预览…", q(".sync-popover")!));
    expect(q(".push-dialog")?.textContent).toContain("目标：origin/main");
    expect(q(".push-dialog")?.textContent).toContain("没有强制推送");
    await click(button("推送", q(".push-dialog")!));
    expect(requests()[0]).toEqual({ kind: "push", remote: null });
    bridge.refs.mockResolvedValue(refsView({}, { state: "noUpstream" }));
    await openSync();
    await click(button("预览…", q(".sync-popover")!));
    const dialog = q(".push-dialog")!;
    expect(dialog.textContent).toContain("还没有上游");
    expect((dialog.querySelector("select") as HTMLSelectElement).value).toBe("origin");
    await click(button("推送", dialog));
    expect(requests()[1]).toEqual({ kind: "push", remote: "origin" });
    expect(host.textContent).not.toContain("强制推送…");
  });
});

describe("merge (B13 / B14)", () => {
  it("merges a branch from the branch popover and a commit from the log with the displayed OID", async () => {
    await mount();
    await click(q(".branch-button"));
    const row = all(".branch-row").find((r) => r.querySelector(".branch-row-name")?.textContent === "topic")!;
    await click(button("更多 ▾", row));
    await click(button("合并到当前分支…"));
    const dialog = q(".merge-dialog")!;
    expect(dialog.textContent).toContain("topic");
    await click(dialog.querySelector("input[aria-label=总是创建合并提交]"));
    await click(button("合并", dialog));
    expect(requests()[0]).toEqual({ kind: "merge", target: "refs/heads/topic", expected: O("2"), noFf: true });
    await click(Array.from(host.querySelectorAll<HTMLButtonElement>(".git-tabs button")).find((b) => b.textContent === "历史"));
    await act(async () => { q(".log-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); }); await flush();
    await click(button("合并到当前分支…"));
    await click(button("合并", q(".merge-dialog")!));
    expect(requests()[1]).toEqual({ kind: "merge", target: O("2"), expected: O("2"), noFf: false });
  });

  it("shows the merge banner with the conflict count, jumps to conflicts, aborts with confirmation and completes with an editable message", async () => {
    bridge.open.mockResolvedValue(snap([change("ok.txt"), change("c.txt", "conflicted")], { ...idle, merge: true }));
    await mount();
    expect(q(".merge-banner")?.textContent).toContain("合并进行中 · 1 个冲突");
    await click(button("查看冲突", q(".merge-banner")!));
    expect(q(".tabbar strong")?.textContent).toBe("c.txt");
    expect(q(".conflict-toolbar")).toBeTruthy();
    // 这里的中止只核对请求；让它返回仍在合并中的快照，以便继续验证完成合并的路径。
    bridge.operation.mockImplementationOnce(async () => outcome("mergeAbort", { snapshot: snap([change("ok.txt"), change("c.txt", "conflicted")], { ...idle, merge: true }) }));
    await click(button("中止合并…", q(".merge-banner")!));
    expect(q(".confirm-dialog")?.textContent).toContain("merge --abort");
    await click(button("中止合并", q(".confirm-dialog")!));
    expect(requests()[0]).toEqual({ kind: "mergeAbort" });
    // 冲突全部标记解决后：完成合并。
    bridge.operation.mockImplementationOnce(async () => outcome("markResolved", { snapshot: snap([change("ok.txt"), change("c.txt")], { ...idle, merge: true }) }));
    await click(button("标记已解决", all(".file").find((r) => r.getAttribute("aria-label") === "c.txt")!));
    expect(q(".merge-banner")?.textContent).toContain("0 个冲突");
    await click(button("完成合并…", q(".merge-banner")!));
    const textarea = q<HTMLTextAreaElement>(".merge-commit-dialog textarea")!;
    expect(textarea.value).toBe("Merge branch 'topic'");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Merge branch 'topic'\n\n手动解决 c.txt"); textarea.dispatchEvent(new Event("input", { bubbles: true })); }); await flush();
    await click(button("完成合并", q(".merge-commit-dialog")!));
    expect(requests().at(-1)).toEqual({ kind: "mergeCommit", message: "Merge branch 'topic'\n\n手动解决 c.txt" });
  });

  it("disables every write entry, including sync and merge, while an external rebase is in progress", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt")], { ...idle, rebase: true }));
    await mount();
    expect(q(".op-banner")?.textContent).toContain("rebase 进行中");
    await openSync();
    const pop = q(".sync-popover")!;
    expect(["获取…", "选项…", "预览…"].every((label) => button(label, pop).disabled)).toBe(true);
    await click(q(".branch-button"));
    const row = all(".branch-row").find((r) => r.querySelector(".branch-row-name")?.textContent === "topic")!;
    expect(button("切换", row).disabled).toBe(true);
  });
});
