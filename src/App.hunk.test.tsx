// @vitest-environment jsdom
// V2-05：块操作在 App 层的接线——按需读取块映射、按钮与请求、丢弃确认、禁用原因。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPair, FileChange, RepositorySnapshot } from "./types";
import type { HunkMap, OperationOutcome } from "./operations-api";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({ open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), map: vi.fn(), operation: vi.fn() }));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: vi.fn(async () => null), activateRepository: vi.fn(async () => true), loadSnapshot: vi.fn(async () => null), saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}) }));
vi.mock("./operations-api", () => ({ runOperation: bridge.operation, hunkMap: bridge.map, cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null), prepareDiscard: vi.fn(), discardBackups: vi.fn(async () => []), headCommitInfo: vi.fn(async () => null) }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
// 阅读器替身：把块标题行渲染成可点击的按钮或说明，并提供一个“移入”触发器。
vi.mock("./DiffViewer", async () => {
  const { forwardRef } = await import("react");
  type Headers = { items: { index: number; state: string; reason?: string }[]; actions: { action: string; label: string }[]; disabledReason: string | null; onAction(i: number, a: string): void; onIntent(): void } | null;
  return { default: forwardRef((props: { hunkHeaders?: Headers }, _ref) => {
    const headers = props.hunkHeaders;
    return <div data-testid="viewer">{headers && <button type="button" data-testid="intent" onClick={() => headers.onIntent()}>移入</button>}
      {headers?.items.map((item) => <div key={item.index} className="hunk" data-state={item.state}>{item.state === "unmatched" ? <span className="hunk-note">{item.reason}</span>
        : headers.actions.map((a) => <button key={a.action} type="button" disabled={!!headers.disabledReason} onClick={() => headers.onAction(item.index, a.action)}>{a.label}</button>)}</div>)}</div>;
  }) };
});
vi.mock("./ImageViewer", () => ({ default: () => <div/> }));
import App from "./App";

const repo = { repoId: "a", displayName: "a", worktreePath: "C:/a", gitDir: "C:/a/.git", commonDir: "C:/a/.git", branch: "main" };
const change = (path: string): FileChange => ({ pathId: `id-${path}`, displayPath: path, oldPathId: null, oldDisplayPath: null, status: "modified", additions: 1, deletions: 1 });
const files = [change("a.txt")];
const snap = (scope: "unstaged" | "staged" | "all" = "unstaged"): RepositorySnapshot => ({
  requestId: "s", repo, scope, revision: "r1", scannedAt: 1, files, statsReady: true, scopes: { unstaged: files, staged: files, all: files },
  branchInfo: { head: "main", oid: "h".repeat(40), upstream: null, ahead: null, behind: null }, inProgress: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false },
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" }
});
const LEFT = "one\ntwo\nthree\nfour\nfive\nsix\n", RIGHT = "one\nTWO\nthree\nfour\nfive\nSIX\n";
const pair = (): ContentPair => ({ requestId: "c", repoId: "a", revision: "r1", pathId: "id-a.txt", displayPath: "a.txt", stale: false, degradation: null,
  left: { endpoint: "index", text: LEFT, byteLength: LEFT.length, encoding: "utf-8", bom: false, kind: "text", eol: "lf", hasFinalNewline: true, contentId: "L" },
  right: { endpoint: "workingTree", text: RIGHT, byteLength: RIGHT.length, encoding: "utf-8", bom: false, kind: "text", eol: "lf", hasFinalNewline: true, contentId: "R" } });
const gitMap = (patch: Partial<HunkMap> = {}): HunkMap => ({ scope: "unstaged", pathId: "id-a.txt", contentIds: ["L", "R"], blocked: null, note: null,
  hunks: [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2, digest: "h1" }, { oldStart: 5, oldEnd: 6, newStart: 5, newEnd: 6, digest: "h2" }], ...patch });
const outcome = (kind: OperationOutcome["kind"]): OperationOutcome => ({ opId: "op", repoId: "a", kind, status: "succeeded", message: "done", output: "", outputTruncated: false, snapshot: snap(), confirmation: null, backup: null, lockLeft: false, gitProcesses: 2, elapsedMs: 5 });

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); }); };
const click = async (element: Element | null | undefined) => { if (!element) throw new Error("元素不存在"); await act(async () => (element as HTMLElement).click()); await flush(); };
const buttons = (label: string) => [...host.querySelectorAll(".hunk button")].filter((b) => b.textContent === label) as HTMLButtonElement[];
const notices = () => [...host.querySelectorAll(".reading-notice p")].map((n) => n.textContent).join("\n");
const settle = async () => { for (let i = 0; i < 40 && !host.querySelector('[data-testid="viewer"]'); i++) await flush(); };
const mount = async () => { await act(async () => { root.render(<App />); }); await flush(); await click(host.querySelector('.file[aria-label="a.txt"]')); await settle(); };

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (value: string) => ({ width: value.length * 6 }) } as unknown as CanvasRenderingContext2D);
  bridge.open.mockResolvedValue(snap());
  bridge.refresh.mockResolvedValue(snap());
  bridge.read.mockImplementation(async () => pair());
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string], left: string, right: string, whitespace = "keep") => {
    const { computeDiff } = await import("./diff-core");
    return { requestId, contentIds, whitespace, elapsedMs: 0, ...computeDiff(left, right, whitespace) };
  });
  bridge.map.mockResolvedValue(gitMap());
  bridge.operation.mockImplementation(async (_repo: string, _scope: string, _op: string, request: { kind: OperationOutcome["kind"] }) => outcome(request.kind));
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [{ repo, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.querySelectorAll(".confirm-dialog").forEach((n) => n.remove()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("块操作（V2-05）", () => {
  it("浏览时不读取块映射；移入后读取，暂存此块发送行范围、摘要与显示时的内容标识", async () => {
    await mount();
    expect(buttons("暂存此块")).toHaveLength(2);
    expect(bridge.map).not.toHaveBeenCalled();
    await click(host.querySelector('[data-testid="intent"]'));
    expect(bridge.map).toHaveBeenCalledWith("a", "unstaged", "r1", "id-a.txt");
    await click(buttons("暂存此块")[1]);
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), { kind: "hunkStage", pathId: "id-a.txt", contentIds: ["L", "R"], hunk: gitMap().hunks[1] });
  });

  it("点击时映射尚未读取：先读取并核对再执行", async () => {
    await mount();
    await click(buttons("暂存此块")[0]);
    expect(bridge.map).toHaveBeenCalledTimes(1);
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), expect.objectContaining({ kind: "hunkStage", hunk: gitMap().hunks[0] }));
  });

  it("丢弃此块先确认，确认后发送 hunkDiscard", async () => {
    await mount();
    await click(buttons("丢弃此块")[0]);
    expect(bridge.operation).not.toHaveBeenCalled();
    const dialog = document.querySelector(".confirm-dialog");
    expect(dialog?.textContent).toContain("丢弃此块");
    expect(dialog?.textContent).toContain("撤销丢弃");
    await click([...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent === "丢弃此块"));
    expect(bridge.operation).toHaveBeenCalledWith("a", "unstaged", expect.any(String), expect.objectContaining({ kind: "hunkDiscard", hunk: gitMap().hunks[0] }));
  });

  it("与 Git 对应不上的块不显示按钮并说明原因", async () => {
    bridge.map.mockResolvedValue(gitMap({ hunks: [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2, digest: "h1" }] }));
    await mount();
    await click(host.querySelector('[data-testid="intent"]'));
    const states = [...host.querySelectorAll(".hunk")].map((n) => n.getAttribute("data-state"));
    expect(states).toEqual(["ready", "unmatched"]);
    expect(host.querySelector(".hunk-note")?.textContent).toContain("对应不上");
  });

  it("Git 报告整个文件不能做块操作时隐藏按钮并常驻说明", async () => {
    bridge.map.mockResolvedValue(gitMap({ hunks: [], blocked: "二进制文件不提供块操作" }));
    await mount();
    await click(host.querySelector('[data-testid="intent"]'));
    expect(host.querySelectorAll(".hunk")).toHaveLength(0);
    expect(notices()).toContain("块操作不可用：二进制文件不提供块操作");
  });

  it("忽略空白与“全部”范围：不提供块操作，并说明原因", async () => {
    await mount();
    const select = host.querySelector('select[aria-label="空白规则"]') as HTMLSelectElement;
    await act(async () => { select.value = "ignore"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(host.querySelectorAll(".hunk")).toHaveLength(0);
    expect(notices()).toContain("忽略空白模式下不提供块操作");
    await act(async () => { select.value = "keep"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    bridge.open.mockResolvedValue(snap("all"));
    await click([...host.querySelectorAll(".scope")].find((b) => b.textContent === "全部"));
    await click(host.querySelector('.file[aria-label="a.txt"]'));
    expect(host.querySelectorAll(".hunk")).toHaveLength(0);
    expect(notices()).toContain("“全部”范围");
  });

  it("已暂存范围提供“取消暂存此块”", async () => {
    await mount();
    await click([...host.querySelectorAll(".scope")].find((b) => b.textContent === "已暂存"));
    await click(host.querySelector('.file[aria-label="a.txt"]'));
    expect(buttons("取消暂存此块")).toHaveLength(2);
    expect(buttons("暂存此块")).toHaveLength(0);
  });
});
