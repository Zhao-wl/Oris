// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPair, FileChange, InProgressSummary, RepositorySnapshot } from "./types";
import type { OperationOutcome, OperationRequest } from "./operations-api";
import type { RefsView } from "./history-api";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({
  open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), operation: vi.fn(), removeLocks: vi.fn(), refs: vi.fn(), remotes: vi.fn(), log: vi.fn(), changes: vi.fn(), mergeMessage: vi.fn()
}));
vi.mock("./api", () => ({ discoverGroup: vi.fn(async () => ({ isGroup: false, members: [], selectedRepoId: null, ignored: [] })), memberChangeCount: vi.fn(async () => 0), watchGroup: vi.fn(async () => {}), setSubmodulePointers: vi.fn(async () => {}), openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: vi.fn(async () => null), activateRepository: vi.fn(async () => true), loadSnapshot: vi.fn(async () => null), saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}), decodeContentFrame: (x: unknown) => x }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, removeStaleLocks: bridge.removeLocks, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null),
  prepareDiscard: vi.fn(), discardBackups: vi.fn(async () => []), headCommitInfo: vi.fn(async () => null) }));
vi.mock("./history-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./history-api")>()),
  readLog: bridge.log, commitChanges: bridge.changes, compareRevisions: vi.fn(), fileHistory: vi.fn(), readRefs: bridge.refs, readRemotes: bridge.remotes, readRevisionPair: vi.fn(),
  stashList: vi.fn(async () => []), stashChanges: vi.fn(), checkBranchName: vi.fn(async () => {}), mergeMessage: bridge.mergeMessage }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./DiffViewer", () => ({ default: ({ readingKey }: { readingKey: string }) => <div data-testid="readable">{readingKey}</div> }));
vi.mock("./ImageViewer", () => ({ default: () => <div/> }));
import App from "./App";
import { cancelOperation } from "./operations-api";

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
const main = (kind: "fetch" | "pull" | "push") => q<HTMLButtonElement>(`.sync-${kind} .sync-main`)!;
const more = (kind: "fetch" | "pull" | "push") => q<HTMLButtonElement>(`.sync-${kind} .sync-more`)!;
const chooseRemote = (paths: string[]) => async () => outcome("fetch", { status: "needsConfirmation", snapshot: null, message: "请选择 remote", confirmation: { reason: "chooseRemote", message: "当前分支没有可用的上游，仓库有多个 remote：请选择 remote", paths } });
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
  bridge.remotes.mockResolvedValue({ remotes: ["origin"], defaultRemote: "origin", fetchHeadAt: null });
  bridge.log.mockResolvedValue({ commits: [{ oid: O("2"), parents: [O("1")], subject: "topic work", body: "", authorName: "A", authorEmail: "a@x", authorTime: 1_700_000_000, committerName: "A", committerEmail: "a@x", committerTime: 1_700_000_000, refs: [] }], next: null, tips: [] });
  bridge.changes.mockResolvedValue({ oid: O("2"), parent: O("1"), parents: [O("1")], files: [] });
  bridge.mergeMessage.mockResolvedValue("Merge branch 'topic'");
  bridge.operation.mockImplementation(async (_repo: string, _scope: string, _op: string, request: OperationRequest) => outcome(request.kind === "stashApply" && request.pop ? "stashPop" : request.kind));
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [{ repo, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sync entry (B11)", () => {
  it("shows fetch / pull / push with ahead / behind from the snapshot and fetches in one click without reading refs", async () => {
    await mount();
    expect(main("pull").textContent).toBe("↓2 拉取");
    expect(main("push").textContent).toBe("↑1 推送");
    expect(main("fetch").textContent).toBe("⟳ 获取");
    const refsCalls = bridge.refs.mock.calls.length;
    await click(main("fetch"));
    expect(requests()).toEqual([{ kind: "fetch", remote: null }]);
    expect(q(".dialog-overlay")).toBeNull();
    expect(bridge.refs.mock.calls.length).toBe(refsCalls);
    expect(q(".sync-toast.succeeded")?.textContent).toContain("done");
    expect(main("fetch").textContent).toBe("⟳ 获取刚刚");
  });

  it("lists remotes only when fetch ▾ is opened, and asks which remote when the backend cannot decide", async () => {
    await mount();
    const refsCalls = bridge.refs.mock.calls.length;
    await click(more("fetch"));
    expect(bridge.remotes).toHaveBeenCalledWith("a");
    expect(bridge.refs.mock.calls.length).toBe(refsCalls);
    const menu = q(".sync-menu")!;
    expect(menu.textContent).toContain("origin当前分支上游所属，主按钮默认");
    await click([...menu.querySelectorAll<HTMLButtonElement>(".sync-menu-item")].find((b) => b.textContent?.includes("origin")));
    expect(requests()[0]).toEqual({ kind: "fetch", remote: "origin" });
    expect(q(".sync-menu")).toBeNull();
    bridge.operation.mockImplementationOnce(chooseRemote(["mirror", "origin"]));
    await click(main("fetch"));
    const dialog = q(".remote-choice-dialog")!;
    expect(dialog.textContent).toContain("有多个 remote");
    expect(q(".sync-toast")).toBeNull();
    await click(dialog.querySelector("input[aria-label=origin]"));
    await click(button("获取", dialog));
    expect(requests().slice(1)).toEqual([{ kind: "fetch", remote: null }, { kind: "fetch", remote: "origin" }]);
  });

  it("says the fetch time is unknown once fetch ▾ sees an external fetch after the Oris one (R-REMOTE)", async () => {
    await mount();
    await click(main("fetch"));
    expect(main("fetch").title).toContain("上次由 Oris 获取");
    bridge.remotes.mockResolvedValue({ remotes: ["origin"], defaultRemote: "origin", fetchHeadAt: Date.now() + 60_000 });
    await click(more("fetch"));
    expect(main("fetch").title).toContain("时间未知");
  });

  it("drops a remote choice that arrives after switching to another project", async () => {
    const repoB = { ...repo, repoId: "b", displayName: "b", worktreePath: "C:/b", gitDir: "C:/b/.git", commonDir: "C:/b/.git" };
    bridge.open.mockImplementation(async (path: string) => (path === "C:/b" ? { ...snap(), repo: repoB } : snap()));
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [repo, repoB].map((r) => ({ repo: r, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() })) }));
    let answer: () => void = () => {};
    bridge.operation.mockImplementationOnce(() => new Promise<OperationOutcome>((resolve) => { answer = () => void chooseRemote(["mirror", "origin"])().then(resolve); }));
    await mount();
    await click(main("fetch"));
    await click(q(".project-tab:nth-child(2) .project-switch"));
    expect(q(".project-tab.active")?.getAttribute("title")).toBe("C:/b");
    await act(async () => answer()); await flush();
    expect(q(".remote-choice-dialog")).toBeNull();
    expect(requests()).toEqual([{ kind: "fetch", remote: null }]);
  });

  it("publishes a branch without an upstream in one click, disables pull there, and disables both on a detached HEAD", async () => {
    bridge.open.mockResolvedValue(snap([change("a.txt")], idle, null));
    bridge.refs.mockResolvedValue(refsView({}, { state: "noUpstream" }));
    await mount();
    expect(main("pull").disabled).toBe(true);
    expect(main("pull").title).toContain("没有上游");
    expect(main("push").textContent).toBe("↑ 发布分支");
    await click(more("pull"));
    await click(button("设置上游…", q(".sync-menu")!));
    expect(q(".branch-dialog")?.textContent).toContain("设置 main 的上游");
    await click(button("取消", q(".branch-dialog")!));
    bridge.operation.mockImplementationOnce(chooseRemote(["mirror", "origin"]));
    await click(main("push"));
    await click(button("发布", q(".remote-choice-dialog")!));
    expect(requests()).toEqual([{ kind: "push", remote: null }, { kind: "push", remote: "mirror" }]);
    // 发布后快照带上游：按钮回到“推送”。
    expect(main("push").textContent).toBe("↑1 推送");
    await act(async () => root.unmount());
    root = createRoot(host);
    bridge.open.mockResolvedValue({ ...snap(), branchInfo: { head: null, oid: O("1"), upstream: null, ahead: null, behind: null } });
    await mount();
    expect(main("pull").disabled).toBe(true);
    expect(main("push").disabled).toBe(true);
    expect(main("push").title).toContain("分离 HEAD");
    expect(main("fetch").disabled).toBe(false);
  });

  it("pulls fast-forward only by default, offers merge on divergence and stash when local changes block", async () => {
    bridge.operation
      .mockImplementationOnce(async () => outcome("pull", { status: "needsConfirmation", snapshot: null, confirmation: { reason: "diverged", message: "本地分支 main 与 origin/main 已分叉，无法仅快进", paths: [] } }))
      .mockImplementationOnce(async () => outcome("pull", { status: "needsConfirmation", snapshot: null, confirmation: { reason: "localChanges", message: "工作区改动会被拉取覆盖", paths: ["a.txt"] } }));
    await mount();
    await click(main("pull"));
    expect(requests()[0]).toEqual({ kind: "pull", mode: "ffOnly" });
    expect(q(".confirm-dialog")?.textContent).toContain("已分叉");
    await click(button("改用合并拉取", q(".confirm-dialog")!));
    expect(requests()[1]).toEqual({ kind: "pull", mode: "merge" });
    expect(q(".confirm-dialog")?.textContent).toContain("stash 后拉取");
    await click(button("stash 后拉取", q(".confirm-dialog")!));
    expect(requests()[2]).toEqual({ kind: "pull", mode: "merge", stashFirst: true, stashUntracked: false });
    expect(q(".sync-toast.succeeded")).toBeTruthy();
  });

  it("remembers the pull mode chosen in pull ▾ for this repository", async () => {
    await mount();
    await click(more("pull"));
    const menu = q(".sync-menu")!;
    expect(menu.textContent).toContain("不做 rebase");
    expect(menu.querySelector("[aria-checked=true]")?.textContent).toContain("仅快进");
    await click([...menu.querySelectorAll<HTMLButtonElement>(".sync-menu-item")].find((b) => b.textContent?.startsWith("合并远端改动")));
    await click(main("pull"));
    expect(requests()).toEqual([{ kind: "pull", mode: "merge" }]);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    await click(main("pull"));
    expect(requests()[1]).toEqual({ kind: "pull", mode: "merge" });
  });

  it("pushes to the upstream in one click and never offers force", async () => {
    await mount();
    await click(more("push"));
    expect(q(".sync-menu")?.textContent).toContain("推送 main → origin/main：领先 1 个提交");
    expect(q(".sync-menu")?.textContent).toContain("不提供强制推送");
    await click(main("push"));
    expect(requests()[0]).toEqual({ kind: "push", remote: null });
    expect(host.textContent).not.toContain("强制推送…");
  });

  it("turns the running button into cancel and keeps the others unavailable", async () => {
    let finish: (value: OperationOutcome) => void = () => {};
    bridge.operation.mockImplementationOnce(() => new Promise<OperationOutcome>((resolve) => { finish = resolve; }));
    await mount();
    await click(main("fetch"));
    expect(main("fetch").textContent).toBe("获取中… ✕ 取消");
    expect(main("pull").disabled).toBe(true);
    expect(more("fetch").disabled).toBe(true);
    await click(main("fetch"));
    expect(cancelOperation).toHaveBeenCalledWith("a");
    await act(async () => finish(outcome("fetch", { status: "cancelled", message: "已取消获取 origin" })));
    await flush();
    expect(q(".sync-toast.cancelled")?.textContent).toContain("已取消获取 origin");
    expect(main("fetch").textContent).toBe("⟳ 获取");
  });
});

describe("decision follow-ups (V2-D48 / V2-D49)", () => {
  it("offers a pull shortcut after a rejected push, without pushing again", async () => {
    const rejected = async () => outcome("push", { status: "failed", message: "推送 main 到 origin/main被拒绝：远端有本地没有的新提交。请先拉取\n ! [rejected] main -> main (fetch first)", snapshot: snap() });
    bridge.operation.mockImplementation(async (_repo: string, _scope: string, _op: string, request: OperationRequest) => request.kind === "push" ? rejected() : outcome(request.kind));
    await mount();
    await click(main("push"));
    const toast = q(".sync-toast.failed")!;
    expect(toast.textContent).toContain("被拒绝");
    expect(toast.textContent).toContain("[rejected]");
    await click(button("拉取", toast));
    expect(requests()).toEqual([{ kind: "push", remote: null }, { kind: "pull", mode: "ffOnly" }]);
    await click(main("push"));
    const shortcut = q(".push-rejected-pull")!;
    expect(shortcut.textContent).toBe("拉取");
    await click(shortcut);
    expect(requests().at(-1)).toEqual({ kind: "pull", mode: "ffOnly" });
  });

  it("offers retry and the output page after other sync failures", async () => {
    bridge.operation.mockImplementationOnce(async () => outcome("fetch", { status: "failed", message: "获取 origin 失败：认证失败" }));
    await mount();
    await click(main("fetch"));
    const toast = q(".sync-toast.failed")!;
    expect(toast.textContent).toContain("认证失败");
    await click(button("重试", toast));
    expect(requests()).toEqual([{ kind: "fetch", remote: null }, { kind: "fetch", remote: null }]);
  });

  describe("stale Git lock files (V2-D65)", () => {
    const lock = "C:/a/.git/index.lock";
    const locked = (kind: "fetch" | "pull" | "push", status: "failed" | "needsConfirmation" = "failed") => async () => outcome(kind, { status, snapshot: status === "failed" ? snap() : null, message: "锁文件已存在",
      confirmation: { reason: "staleLock", message: "仓库中存在 Git 锁文件。最近修改：index.lock（5 分钟前修改）", paths: [lock] } });

    it("asks before removing the lock, then pulls again once", async () => {
      bridge.operation.mockImplementationOnce(locked("pull", "needsConfirmation"));
      bridge.removeLocks.mockResolvedValue([lock]);
      await mount();
      await click(main("pull"));
      const dialog = q(".confirm-dialog")!;
      expect(dialog.textContent).toContain("index.lock");
      expect(dialog.textContent).toContain("没有其他 Git 进程");
      expect(bridge.removeLocks).not.toHaveBeenCalled();
      await click(button("删除锁文件并拉取", dialog));
      expect(bridge.removeLocks).toHaveBeenCalledWith("a", [lock]);
      expect(requests()).toEqual([{ kind: "pull", mode: "ffOnly" }, { kind: "pull", mode: "ffOnly" }]);
      expect(q(".sync-toast.succeeded")).toBeTruthy();
    });

    it("removes a lock reported by a failed push and pushes again; cancelling keeps the lock and shows the failure", async () => {
      bridge.operation.mockImplementationOnce(locked("push"));
      bridge.removeLocks.mockResolvedValue([lock]);
      await mount();
      await click(main("push"));
      await click(button("删除锁文件并推送", q(".confirm-dialog")!));
      expect(requests()).toEqual([{ kind: "push", remote: null }, { kind: "push", remote: null }]);
      expect(q(".sync-toast.succeeded")).toBeTruthy();

      bridge.operation.mockImplementationOnce(locked("fetch"));
      await click(main("fetch"));
      await click(button("取消", q(".confirm-dialog")!));
      expect(bridge.removeLocks).toHaveBeenCalledTimes(1);
      expect(requests().slice(2)).toEqual([{ kind: "fetch", remote: null }]);
      expect(q(".sync-toast.failed")?.textContent).toContain("锁文件已存在");
    });

    it("does not ask again when the retry is still locked, and reports a failed removal", async () => {
      bridge.operation.mockImplementationOnce(locked("pull", "needsConfirmation")).mockImplementationOnce(locked("pull"));
      bridge.removeLocks.mockResolvedValue([lock]);
      await mount();
      await click(main("pull"));
      await click(button("删除锁文件并拉取", q(".confirm-dialog")!));
      expect(requests()).toHaveLength(2);
      expect(q(".confirm-dialog")).toBeNull();
      expect(q(".sync-toast.failed")?.textContent).toContain("锁文件已存在");

      bridge.operation.mockImplementationOnce(locked("fetch"));
      bridge.removeLocks.mockRejectedValue({ kind: "writeBlocked", message: "拒绝删除" });
      await click(main("fetch"));
      await click(button("删除锁文件并获取远端状态", q(".confirm-dialog")!));
      expect(requests()).toHaveLength(3);
      expect(q(".sync-toast.failed")?.textContent).toContain("删除锁文件失败");
    });
  });

  it("explains merge.ff=only in the merge dialog", async () => {
    bridge.refs.mockResolvedValue(refsView({ mergeFf: "only" }));
    await mount();
    await click(q(".branch-button"));
    const row = all(".branch-row").find((r) => r.querySelector(".branch-row-name")?.textContent === "topic")!;
    await click(button("更多 ▾", row));
    await click(button("合并到当前分支…"));
    expect(q(".merge-dialog")?.textContent).toContain("merge.ff=only 只允许快进");
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
    expect((["fetch", "pull", "push"] as const).every((kind) => main(kind).disabled)).toBe(true);
    await click(q(".branch-button"));
    const row = all(".branch-row").find((r) => r.querySelector(".branch-row-name")?.textContent === "topic")!;
    expect(button("切换", row).disabled).toBe(true);
  });
});
