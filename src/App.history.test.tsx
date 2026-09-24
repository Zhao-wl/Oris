// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPair, FileChange, RepositorySnapshot } from "./types";
import type { OperationOutcome } from "./operations-api";
import type { CommitInfo, RefsView } from "./history-api";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";
import { FETCH_LOG_KEY } from "./history-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), operation: vi.fn(),
  log: vi.fn(), changes: vi.fn(), compare: vi.fn(), fileHistory: vi.fn(), refs: vi.fn(), revision: vi.fn()
}));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: vi.fn(async () => null), activateRepository: vi.fn(async () => true), loadSnapshot: vi.fn(async () => null), saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}), decodeContentFrame: (x: unknown) => x }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: vi.fn(), discardBackups: vi.fn(async () => []), headCommitInfo: vi.fn(async () => null) }));
vi.mock("./history-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./history-api")>()),
  readLog: bridge.log, commitChanges: bridge.changes, compareRevisions: bridge.compare, fileHistory: bridge.fileHistory, readRefs: bridge.refs, readRevisionPair: bridge.revision }));
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
const snap = (): RepositorySnapshot => ({ requestId: "s", repo, scope: "unstaged", revision: "r1", scannedAt: 1, files: [change("a.txt")], statsReady: true,
  scopes: { unstaged: [change("a.txt")], staged: [], all: [change("a.txt")] }, branchInfo: { head: "main", oid: O("1"), upstream: "origin/main", ahead: 1, behind: 2 },
  inProgress: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false }, git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" } });
const pair = (endpoint: "index" | "commit" | "emptyTree", id: string, missing = false): ContentPair => ({ requestId: "c", repoId: "a", revision: "x", pathId: id, displayPath: id, stale: false, degradation: null,
  left: { endpoint, text: missing ? "" : "l", byteLength: missing ? 0 : 1, encoding: missing ? "missing" : "utf-8", eol: "none", hasFinalNewline: false, contentId: `l-${id}-${endpoint}` },
  right: { endpoint: endpoint === "index" ? "workingTree" : "commit", text: "r", byteLength: 1, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: `r-${id}-${endpoint}` } });
const commit = (oid: string, parents: string[], subject: string, refs: CommitInfo["refs"] = []): CommitInfo => ({ oid, parents, subject, body: "", authorName: "Alice", authorEmail: "a@x", authorTime: 1_700_000_000, committerName: "Alice", committerEmail: "a@x", committerTime: 1_700_000_000, refs });
// 线性 + 合并 + 根：merge(3) ← main(1) / topic(2) ← root(0)
const history = [
  commit(O("3"), [O("1"), O("2")], "merge topic", [{ name: "HEAD", kind: "head", current: false }, { name: "refs/heads/main", kind: "local", current: true }]),
  commit(O("1"), [O("0")], "main work"),
  commit(O("2"), [O("0")], "topic work", [{ name: "refs/heads/topic", kind: "local", current: false }]),
  commit(O("0"), [], "root")
];
const refsView = (mainOid = O("3")): RefsView => ({
  head: { branch: "refs/heads/main", oid: O("3"), detached: false, unborn: false },
  local: [
    { fullName: "refs/heads/main", name: "main", kind: "local", oid: mainOid, current: true, tracking: { state: "known", upstream: "refs/remotes/origin/main", ahead: 1, behind: 2 }, remote: "origin" },
    { fullName: "refs/heads/topic", name: "topic", kind: "local", oid: O("2"), current: false, tracking: { state: "gone", upstream: "refs/remotes/origin/topic" }, remote: "origin" },
    { fullName: "refs/heads/solo", name: "solo", kind: "local", oid: O("0"), current: false, tracking: { state: "noUpstream" }, remote: null }
  ],
  remote: [{ fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remote", oid: O("1"), current: false, tracking: null, remote: "origin" }],
  shallow: false, remotes: ["origin", "backup"], defaultRemote: "origin", fetchHeadAt: null
});

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector(selector) as T | null;
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const click = async (element: Element | null) => { expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click()); await flush(); };
const contextMenu = async (element: Element | null) => { expect(element).toBeTruthy(); await act(async () => { element!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })); }); await flush(); };
const reading = () => host.querySelector("[data-testid=readable]")?.textContent ?? null;
const openLog = async () => { await click(all(".git-tabs button").find((b) => b.textContent === "日志")!); };

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as unknown as CanvasRenderingContext2D);
  bridge.open.mockResolvedValue(snap());
  bridge.refresh.mockResolvedValue(snap());
  bridge.read.mockImplementation(async (_r: string, _s: string, _v: string, pathId: string) => pair("index", pathId));
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string]) => ({ requestId, contentIds, changes: [], hunks: [], elapsedMs: 0 }));
  bridge.refs.mockImplementation(async () => refsView());
  bridge.log.mockImplementation(async (_repo: string, query: { refs: string[] }, cursor: unknown) => {
    if (cursor) return { commits: [], next: null, tips: [] };
    const commits = query.refs.includes("refs/heads/topic") ? [history[2], history[3]] : history;
    return { commits, next: null, tips: [] };
  });
  bridge.changes.mockImplementation(async (_repo: string, oid: string, parent: string | null) => {
    const info = history.find((c) => c.oid === oid)!;
    const chosen = parent ?? info.parents[0] ?? null;
    const files = oid === O("0") ? [{ path: "root.txt", oldPath: null, pathId: "id-root.txt", oldPathId: null, status: "added" }]
      : chosen === O("2") ? [{ path: "main.txt", oldPath: null, pathId: "id-main.txt", oldPathId: null, status: "added" }]
      : [{ path: "src/a.txt", oldPath: null, pathId: "id-src/a.txt", oldPathId: null, status: "modified" }, { path: "new.txt", oldPath: "old.txt", pathId: "id-new.txt", oldPathId: "id-old.txt", status: "renamed" }];
    return { oid, parent: chosen, parents: info.parents, files };
  });
  bridge.compare.mockImplementation(async (_repo: string, left: string, right: string) => ({ leftRef: left, rightRef: right, left, right, files: [{ path: "diff.txt", oldPath: null, pathId: "id-diff.txt", oldPathId: null, status: "modified" }] }));
  bridge.fileHistory.mockResolvedValue({ entries: [
    { commit: history[1], path: "new.txt", pathId: "id-new.txt", status: "renamed", renamedFrom: "old.txt", renamedFromId: "id-old.txt" },
    { commit: history[3], path: "old.txt", pathId: "id-old.txt", status: "added", renamedFrom: null, renamedFromId: null }
  ], next: null, reachedOrigin: true });
  bridge.revision.mockImplementation(async (_repo: string, left: string | null, _right: string, pathId: string) => pair(left ? "commit" : "emptyTree", pathId, !left));
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [{ repo, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const mount = async () => { await act(async () => { root.render(<App />); }); await flush(); };

describe("Git log tab (A07 / A08)", () => {
  it("shows the working branch separately from the browsed branch; filtering never runs a write operation", async () => {
    await mount();
    expect(bridge.log).not.toHaveBeenCalled();
    await openLog();
    expect(q(".log-current")?.textContent).toContain("● main");
    expect(q(".log-current")?.textContent).toContain("↑1 ↓2");
    const tracking = all(".log-branch").map((b) => b.textContent);
    expect(tracking.some((t) => t?.includes("topic") && t.includes("上游已消失"))).toBe(true);
    expect(tracking.some((t) => t?.includes("solo") && t.includes("无上游"))).toBe(true);
    expect(tracking.join()).not.toContain("↑0 ↓0");
    expect(all(".log-row").map((r) => r.querySelector(".log-subject")?.textContent)).toEqual(["HEADmainmerge topic", "main work", "topictopic work", "root"]);
    await click(all(".log-branch").find((b) => b.textContent?.includes("topic"))!);
    expect(bridge.log).toHaveBeenLastCalledWith("a", expect.objectContaining({ refs: ["refs/heads/topic"] }), null);
    expect(all(".log-row")).toHaveLength(2);
    expect(q(".log-current")?.textContent).toContain("● main");
    expect(q(".log-branch.browsing")?.textContent).toContain("topic");
    expect(bridge.operation).not.toHaveBeenCalled();
  });

  it("merge commits pick either parent; root commits compare against the empty tree", async () => {
    await mount();
    await openLog();
    expect(bridge.changes).toHaveBeenLastCalledWith("a", O("3"), null);
    const parents = all(".parent-pick");
    expect(parents.map((p) => p.textContent)).toEqual(["1 · 11111111", "2 · 22222222"]);
    expect(parents[0].getAttribute("aria-pressed")).toBe("true");
    await click(parents[1]);
    expect(bridge.changes).toHaveBeenLastCalledWith("a", O("3"), O("2"));
    expect(all(".log-file-path").map((n) => n.textContent)).toEqual(["main.txt"]);
    await click(all(".log-row").at(-1)!);
    expect(q(".log-parents")?.textContent).toContain("根提交");
    await click(all(".log-file").find((b) => b.textContent?.includes("root.txt"))!);
    expect(bridge.revision).toHaveBeenLastCalledWith("a", null, O("0"), "id-root.txt", null, expect.any(String));
    expect(reading()).toContain("history:commit:");
  });

  it("opens a commit file in the same diff reader with pinned endpoints, then returns to the local reading position", async () => {
    await mount();
    expect(reading()).toBe("a:unstaged:id-a.txt");
    await openLog();
    await click(all(".log-file").find((b) => b.textContent?.includes("new.txt"))!);
    expect(bridge.revision).toHaveBeenLastCalledWith("a", O("1"), O("3"), "id-new.txt", "id-old.txt", expect.any(String));
    expect(reading()).toBe(`a:history:commit:${O("3")}:${O("1")}:id-new.txt`);
    expect(q(".history-badge")?.textContent).toBe("历史 · 提交 33333333");
    expect(q(".tabbar strong")?.textContent).toBe("new.txt");
    expect(q(".endpoints")?.textContent).toContain("父提交 11111111（第 1 个父节点）");
    expect(q(".endpoints")?.textContent).toContain("提交 33333333");
    expect(q(".file.selected")).toBeNull();
    await click(button("← 返回本地变化"));
    expect(reading()).toBe("a:unstaged:id-a.txt");
    expect(q(".history-badge")).toBeNull();
    expect(q(".file.selected")?.getAttribute("aria-label")).toBe("a.txt");
  });
});

describe("compare and file history (A09)", () => {
  it("compares two endpoints by their pinned OIDs, swaps direction, and flags a moved ref", async () => {
    await mount();
    await openLog();
    await contextMenu(all(".log-branch").find((b) => b.textContent?.includes("topic"))!);
    await click(button("设为比较起点（A）"));
    expect(q(".log-compare-start")?.textContent).toContain("topic");
    await contextMenu(all(".log-branch").find((b) => b.textContent?.startsWith("● main"))!);
    await click(button("与比较起点比较（A → 此处）"));
    expect(bridge.compare).toHaveBeenLastCalledWith("a", O("2"), O("3"));
    expect(q(".log-detail")?.textContent).toContain("直接比较（非共同基线）");
    await click(all(".log-detail .log-file")[0]);
    expect(bridge.revision).toHaveBeenLastCalledWith("a", O("2"), O("3"), "id-diff.txt", null, expect.any(String));
    expect(q(".endpoints")?.textContent).toContain("A · topic @ 22222222");
    await click(button("⇄ 交换方向"));
    expect(bridge.compare).toHaveBeenLastCalledWith("a", O("3"), O("2"));
    // main 在外部前进：提示端点已移动，比较仍使用固定的 OID，直到用户选择按新位置重新比较。
    bridge.refs.mockImplementation(async () => refsView(O("9")));
    bridge.operation.mockResolvedValue({ opId: "op", repoId: "a", kind: "fetch", status: "succeeded", message: "已获取 origin", output: "", outputTruncated: false, snapshot: snap(), confirmation: null, backup: null, lockLeft: false, gitProcesses: 1, elapsedMs: 1 } satisfies OperationOutcome);
    await click(q(".sync-button")); await click(button("获取…", q(".sync-popover")!));
    await click(button("获取", q(".fetch-dialog")!));
    expect(q(".log-moved")?.textContent).toContain("main 已移动到 99999999");
    const calls = bridge.compare.mock.calls.length;
    await click(button("按新位置重新比较"));
    expect(bridge.compare.mock.calls.length).toBe(calls + 1);
    expect(bridge.compare).toHaveBeenLastCalledWith("a", O("9"), O("2"));
  });

  it("file history marks the rename boundary, opens entries against the first parent, and starts from the local file", async () => {
    await mount();
    await click(button("文件历史"));
    expect(bridge.fileHistory).toHaveBeenLastCalledWith("a", "HEAD", "id-a.txt", 100, null);
    expect(q(".log-rename-boundary")?.textContent).toContain("由 old.txt 改名而来");
    expect(q(".log-commits-pane")?.textContent).toContain("已到达文件起点");
    await click(all(".log-history-row")[0]);
    expect(bridge.revision).toHaveBeenLastCalledWith("a", O("0"), O("1"), "id-new.txt", "id-old.txt", expect.any(String));
    expect(q(".history-badge")?.textContent).toContain("文件历史");
    await click(button("← 返回提交历史"));
    expect(all(".log-row").length).toBe(4);
  });
});

describe("explicit fetch (A10)", () => {
  it("defaults to the upstream remote, runs one fetch operation and records Oris' completion time", async () => {
    bridge.operation.mockResolvedValue({ opId: "op", repoId: "a", kind: "fetch", status: "succeeded", message: "已获取 origin：1 个远端跟踪引用 / 标签有更新", output: "", outputTruncated: false, snapshot: snap(), confirmation: null, backup: null, lockLeft: false, gitProcesses: 1, elapsedMs: 1 } satisfies OperationOutcome);
    await mount();
    await click(q(".sync-button")); await click(button("获取…", q(".sync-popover")!));
    const dialog = q(".fetch-dialog")!;
    expect(dialog.textContent).toContain("不修改工作区");
    expect((dialog.querySelector("select") as HTMLSelectElement).value).toBe("origin");
    await click(button("获取", dialog));
    expect(bridge.operation).toHaveBeenCalledTimes(1);
    expect(bridge.operation).toHaveBeenLastCalledWith("a", "unstaged", expect.any(String), { kind: "fetch", remote: "origin" });
    expect(JSON.parse(localStorage.getItem(FETCH_LOG_KEY)!)["C:/a"].remote).toBe("origin");
    expect(q(".op-status")?.textContent).toContain("已获取 origin");
  });

  it("asks the user to choose a remote when the current branch has no valid upstream", async () => {
    bridge.refs.mockImplementation(async () => ({ ...refsView(), defaultRemote: null }));
    await mount();
    await click(q(".sync-button")); await click(button("获取…", q(".sync-popover")!));
    const dialog = q(".fetch-dialog")!;
    expect(button("获取", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("请选择要获取的 remote");
    const select = dialog.querySelector("select") as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "backup"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(button("获取", dialog).disabled).toBe(false);
  });
});
