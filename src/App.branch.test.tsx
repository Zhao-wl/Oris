// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPair, FileChange, RepositorySnapshot } from "./types";
import type { OperationOutcome, OperationRequest } from "./operations-api";
import type { RefsView, StashEntry } from "./history-api";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), operation: vi.fn(),
  log: vi.fn(), changes: vi.fn(), refs: vi.fn(), revision: vi.fn(), stashList: vi.fn(), stashChanges: vi.fn(), checkName: vi.fn()
}));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: vi.fn(async () => null), activateRepository: vi.fn(async () => true), loadSnapshot: vi.fn(async () => null), saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}), decodeContentFrame: (x: unknown) => x }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: vi.fn(), discardBackups: vi.fn(async () => []), headCommitInfo: vi.fn(async () => null) }));
vi.mock("./history-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./history-api")>()),
  readLog: bridge.log, commitChanges: bridge.changes, compareRevisions: vi.fn(), fileHistory: vi.fn(), readRefs: bridge.refs, readRevisionPair: bridge.revision,
  stashList: bridge.stashList, stashChanges: bridge.stashChanges, checkBranchName: bridge.checkName }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./DiffViewer", () => ({ default: ({ readingKey }: { readingKey: string }) => <div data-testid="readable">{readingKey}</div> }));
vi.mock("./ImageViewer", () => ({ default: () => <div/> }));
import App from "./App";

const O = (c: string) => c.repeat(40);
const repo = { repoId: "a", displayName: "a", worktreePath: "C:/a", gitDir: "C:/a/.git", commonDir: "C:/a/.git", branch: "main" };
const change = (path: string): FileChange => ({ pathId: `id-${path}`, displayPath: path, oldPathId: null, oldDisplayPath: null, status: "modified", additions: 1, deletions: 0 });
const snap = (files: FileChange[] = [change("a.txt"), change("b.txt")], head: string | null = "main", branch = "main"): RepositorySnapshot => ({ requestId: "s", repo: { ...repo, branch }, scope: "unstaged", revision: `r-${files.length}-${head}`, scannedAt: 1, files, statsReady: true,
  scopes: { unstaged: files, staged: [], all: files }, branchInfo: { head, oid: O("1"), upstream: null, ahead: null, behind: null },
  inProgress: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false }, git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" } });
const pair = (id: string): ContentPair => ({ requestId: "c", repoId: "a", revision: "x", pathId: id, displayPath: id, stale: false, degradation: null,
  left: { endpoint: "index", text: "l", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: `l-${id}` },
  right: { endpoint: "workingTree", text: "r", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: `r-${id}` } });
const refsView: RefsView = {
  head: { branch: "refs/heads/main", oid: O("1"), detached: false, unborn: false },
  local: [
    { fullName: "refs/heads/main", name: "main", kind: "local", oid: O("1"), current: true, tracking: { state: "noUpstream" }, remote: null },
    { fullName: "refs/heads/feature", name: "feature", kind: "local", oid: O("2"), current: false, tracking: { state: "known", upstream: "refs/remotes/origin/feature", ahead: 0, behind: 0 }, remote: "origin" }
  ],
  remote: [{ fullName: "refs/remotes/origin/feature", name: "origin/feature", kind: "remote", oid: O("2"), current: false, tracking: null, remote: "origin" }],
  shallow: false, remotes: ["origin"], defaultRemote: null, fetchHeadAt: null
};
const outcome = (kind: OperationOutcome["kind"], extra: Partial<OperationOutcome> = {}): OperationOutcome => ({ opId: "op", repoId: "a", kind, status: "succeeded", message: "done", output: "", outputTruncated: false, snapshot: snap(), confirmation: null, backup: null, lockLeft: false, gitProcesses: 1, elapsedMs: 1, ...extra });
const stashes: StashEntry[] = [
  { index: 0, oid: O("a"), message: "wip login", branch: "main", time: 1_700_000_000, base: O("1"), untracked: O("c") },
  { index: 1, oid: O("b"), message: "debug", branch: "feature", time: 1_700_000_000, base: O("2"), untracked: null }
];

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector(selector) as T | null;
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click()); await flush(); };
const type = async (element: HTMLInputElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); await flush(); };
const tick = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); await flush(); };
const requests = () => bridge.operation.mock.calls.map((call) => call[3] as OperationRequest);
const openBranches = async () => { await click(q(".branch-button")); };
const branchRow = (name: string) => all(".branch-row").find((row) => row.querySelector(".branch-row-name")?.textContent?.replace("● ", "") === name)!;
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
  bridge.refs.mockResolvedValue(refsView);
  bridge.log.mockResolvedValue({ commits: [{ oid: O("1"), parents: [], subject: "base", body: "", authorName: "A", authorEmail: "a@x", authorTime: 1_700_000_000, committerName: "A", committerEmail: "a@x", committerTime: 1_700_000_000, refs: [] }], next: null, tips: [] });
  bridge.changes.mockResolvedValue({ oid: O("1"), parent: null, parents: [], files: [] });
  bridge.stashList.mockResolvedValue(stashes);
  bridge.stashChanges.mockImplementation(async (_repo: string, oid: string) => ({ oid, base: oid === O("a") ? O("1") : O("2"), tracked: [{ path: "a.txt", oldPath: null, pathId: "id-a.txt", oldPathId: null, status: "modified" }], untrackedCommit: oid === O("a") ? O("c") : null, untracked: oid === O("a") ? [{ path: "u.txt", oldPath: null, pathId: "id-u.txt", oldPathId: null, status: "added" }] : [] }));
  bridge.revision.mockImplementation(async (_repo: string, _left: string | null, _right: string, pathId: string) => ({ ...pair(pathId), left: { ...pair(pathId).left, endpoint: "commit" }, right: { ...pair(pathId).right, endpoint: "commit" } }));
  bridge.checkName.mockImplementation(async (_repo: string, name: string) => { if (/\s|\.\./.test(name)) throw { kind: "writeBlocked", message: `分支名“${name}”无效` }; });
  bridge.operation.mockImplementation(async (_repo: string, _scope: string, _op: string, request: OperationRequest) => outcome(request.kind === "stashApply" && request.pop ? "stashPop" : request.kind));
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [{ repo, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("branch popover (B10)", () => {
  it("switches a local branch and offers “stash 后切换” when Git refuses because of local changes", async () => {
    bridge.operation.mockImplementationOnce(async () => outcome("branchSwitch", { status: "needsConfirmation", snapshot: null, message: "Git 拒绝切换到 feature：工作区改动会被覆盖", confirmation: { reason: "localChanges", message: "Git 拒绝切换到 feature：工作区改动会被覆盖。可以先储藏再切换，切换后不会自动恢复", paths: ["a.txt"] } }));
    await mount();
    await openBranches();
    expect(branchRow("main").textContent).toContain("当前");
    expect(q(".branch-popover")?.textContent).toContain("远端跟踪分支 · 1");
    await click(button("切换", branchRow("feature")));
    expect(requests()[0]).toEqual({ kind: "branchSwitch", name: "refs/heads/feature" });
    expect(q(".confirm-dialog")?.textContent).toContain("stash 后切换");
    expect(q(".confirm-dialog")?.textContent).toContain("切换后不会自动恢复");
    expect(q(".confirm-items")?.textContent).toContain("a.txt");
    await click(button("stash 后切换", q(".confirm-dialog")!));
    expect(requests()[1]).toEqual({ kind: "branchSwitch", name: "refs/heads/feature", stashFirst: true, stashUntracked: false });
  });

  it("includes untracked files only when Git said untracked files would be overwritten", async () => {
    bridge.operation.mockImplementationOnce(async () => outcome("checkout", { status: "needsConfirmation", snapshot: null, confirmation: { reason: "untrackedOverwritten", message: "未跟踪文件会被覆盖", paths: ["new.txt"] } }));
    await mount();
    await click(Array.from(host.querySelectorAll<HTMLButtonElement>(".git-tabs button")).find((b) => b.textContent === "日志"));
    await act(async () => { q(".log-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); }); await flush();
    await click(button("检出（分离 HEAD）"));
    expect(requests()[0]).toEqual({ kind: "checkout", commit: O("1") });
    expect(q(".confirm-dialog")?.textContent).toContain("包含未跟踪文件");
    await click(button("stash 后切换", q(".confirm-dialog")!));
    expect(requests()[1]).toEqual({ kind: "checkout", commit: O("1"), stashFirst: true, stashUntracked: true });
  });

  it("checks out a remote branch as a tracking branch and lets the user choose when the local name exists", async () => {
    bridge.operation.mockImplementationOnce(async () => outcome("branchTrack", { status: "needsConfirmation", snapshot: null, confirmation: { reason: "localExists", message: "已存在同名本地分支 feature", paths: ["feature"] } }));
    await mount();
    await openBranches();
    await click(button("检出", branchRow("origin/feature")));
    expect(requests()[0]).toEqual({ kind: "branchTrack", remote: "refs/remotes/origin/feature" });
    const dialog = q(".branch-dialog")!;
    expect(dialog.textContent).toContain("已存在同名本地分支");
    await type(dialog.querySelector("input[aria-label=跟踪分支名]") as HTMLInputElement, "feature-copy");
    await tick(200);
    await click(button("新建跟踪分支", dialog));
    expect(requests()[1]).toEqual({ kind: "branchTrack", remote: "refs/remotes/origin/feature", localName: "feature-copy" });
  });

  it("validates new branch names with Git rules and creates from the chosen start point", async () => {
    await mount();
    await openBranches();
    await click(button("＋ 新建分支…"));
    const dialog = q(".branch-dialog")!;
    const input = dialog.querySelector("input[aria-label=新分支名]") as HTMLInputElement;
    await type(input, "bad name");
    await tick(200);
    expect(button("新建并切换", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("无效");
    await type(input, "feature");
    await tick(200);
    expect(dialog.textContent).toContain("本地分支 feature 已存在");
    await type(input, "topic/x");
    await tick(200);
    const select = dialog.querySelector("select") as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "refs/remotes/origin/feature"); select.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
    await click(dialog.querySelector("input[aria-label=创建后立即切换]"));
    await click(button("新建", dialog));
    expect(requests()[0]).toEqual({ kind: "branchCreate", name: "topic/x", start: "refs/remotes/origin/feature", switch: false });
  });

  it("deletes with confirmation, strongly confirms unmerged branches, renames and sets the upstream", async () => {
    bridge.operation.mockImplementationOnce(async () => outcome("branchDelete", { status: "needsConfirmation", snapshot: null, confirmation: { reason: "unmerged", message: "分支 feature 有 2 个提交尚未合并…只能通过 reflog 找回", paths: ["feature"] } }));
    await mount();
    await openBranches();
    await click(button("更多 ▾", branchRow("feature")));
    await click(button("删除…"));
    expect(bridge.operation).not.toHaveBeenCalled();
    await click(button("删除", q(".confirm-dialog")!));
    expect(requests()[0]).toEqual({ kind: "branchDelete", name: "refs/heads/feature" });
    expect(q(".confirm-dialog")?.textContent).toContain("reflog");
    await click(button("仍然删除", q(".confirm-dialog")!));
    expect(requests()[1]).toEqual({ kind: "branchDelete", name: "refs/heads/feature", force: true });
    await openBranches();
    await click(button("更多 ▾", branchRow("main")));
    expect(button("删除…").disabled).toBe(true);
    await click(button("重命名…"));
    const rename = q(".branch-dialog")!;
    await type(rename.querySelector("input") as HTMLInputElement, "trunk");
    await tick(200);
    await click(button("重命名", rename));
    expect(requests()[2]).toEqual({ kind: "branchRename", name: "refs/heads/main", newName: "trunk" });
    await openBranches();
    await click(button("更多 ▾", branchRow("main")));
    await click(button("设置上游…"));
    const upstream = q(".branch-dialog")!;
    const select = upstream.querySelector("select") as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "refs/remotes/origin/feature"); select.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
    await click(button("设为上游", upstream));
    expect(requests()[3]).toEqual({ kind: "setUpstream", name: "refs/heads/main", upstream: "refs/remotes/origin/feature" });
  });

  it("shows a persistent detached-HEAD banner that offers “从这里新建分支”", async () => {
    bridge.open.mockResolvedValue(snap(undefined, null, "detached @ 1111111"));
    await mount();
    expect(q(".detached-banner")?.textContent).toContain("分离 HEAD");
    await click(button("从这里新建分支…", q(".detached-banner")!));
    expect(q(".branch-dialog")?.textContent).toContain("当前 HEAD");
  });

  it("after switching, keeps the reading position when the file still exists and explains when it does not", async () => {
    await mount();
    expect(q("[data-testid=readable]")?.textContent).toBe("a:unstaged:id-a.txt");
    bridge.operation.mockImplementationOnce(async () => outcome("branchSwitch", { snapshot: snap([change("a.txt"), change("c.txt")], "feature", "feature") }));
    await openBranches();
    await click(button("切换", branchRow("feature")));
    expect(q("[data-testid=readable]")?.textContent).toBe("a:unstaged:id-a.txt");
    expect(q(".selection-notice")).toBeNull();
    bridge.operation.mockImplementationOnce(async () => outcome("branchSwitch", { snapshot: snap([change("z.txt")], "main", "main") }));
    await openBranches();
    await click(button("切换", branchRow("feature")));
    expect(q("[data-testid=readable]")?.textContent).toBe("a:unstaged:id-z.txt");
    expect(host.textContent).toContain("此前选中的文件已不在当前比较范围中");
  });
});

describe("stash tab (B09)", () => {
  const openStash = async () => { await click(Array.from(host.querySelectorAll<HTMLButtonElement>(".git-tabs button")).find((b) => b.textContent?.startsWith("Stash"))); };

  it("lists stashes, stashes with message / untracked / only the selected files, and applies, pops and drops by identity", async () => {
    await mount();
    await openStash();
    expect(all(".stash-row").map((r) => r.querySelector(".stash-text")?.textContent)).toEqual([expect.stringContaining("stash@{0} · wip login"), expect.stringContaining("stash@{1} · debug")]);
    expect(q(".git-tabs")?.textContent).toContain("Stash · 2");
    await type(q<HTMLInputElement>("input[aria-label='stash 说明']")!, "half done");
    await click(q("input[aria-label=包含未跟踪文件]"));
    await click(q("input[aria-label=只储藏选中的文件]"));
    await click(button("储藏"));
    expect(requests()[0]).toEqual({ kind: "stashPush", message: "half done", includeUntracked: true, pathIds: ["id-a.txt"] });
    await click(button("应用"));
    expect(requests()[1]).toEqual({ kind: "stashApply", index: 0, oid: O("a"), pop: false });
    await click(button("弹出"));
    expect(requests()[2]).toEqual({ kind: "stashApply", index: 0, oid: O("a"), pop: true });
    await click(button("删除…", q(".stash-list")!));
    expect(q(".confirm-dialog")?.textContent).toContain("无法撤销");
    await click(button("删除 stash", q(".confirm-dialog")!));
    expect(requests()[3]).toEqual({ kind: "stashDrop", index: 0, oid: O("a") });
  });

  it("opens tracked and untracked parts of a stash in the same diff reader", async () => {
    await mount();
    await openStash();
    expect(q(".stash-detail")?.textContent).toContain("未跟踪文件 · 1");
    await click(all(".stash-detail .log-file").find((b) => b.textContent?.includes("a.txt")));
    expect(bridge.revision).toHaveBeenLastCalledWith("a", O("1"), O("a"), "id-a.txt", null, expect.any(String));
    expect(q(".history-badge")?.textContent).toContain("stash@{0}");
    await click(all(".stash-detail .log-file").find((b) => b.textContent?.includes("u.txt")));
    expect(bridge.revision).toHaveBeenLastCalledWith("a", null, O("c"), "id-u.txt", null, expect.any(String));
    expect(q(".history-badge")?.textContent).toContain("未跟踪");
  });
});
