// @vitest-environment jsdom
// 任务 05：空白规则、文件级说明、特殊文件、专注 diff 与键盘入口在 App 层的集成。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPair, FileChange, RepositorySnapshot, TextSide } from "./types";
import { defaultAnchor, WORKSPACE_KEY } from "./workspace-model";

const bridge = vi.hoisted(() => ({ open: vi.fn(), refresh: vi.fn(), read: vi.fn(), diff: vi.fn(), navigate: vi.fn() }));
vi.mock("./api", () => ({ openRepository: bridge.open, refreshRepository: bridge.refresh, readContentPair: bridge.read, closeRepository: vi.fn(async () => {}), cancelContentRead: vi.fn(async () => {}),
  repositoryDetails: vi.fn(async () => null), activateRepository: vi.fn(async () => true), loadSnapshot: vi.fn(async () => null), saveSnapshot: vi.fn(async () => true), removeSnapshot: vi.fn(async () => {}) }));
vi.mock("./operations-api", () => ({ runOperation: vi.fn(), cancelOperation: vi.fn(async () => true), lastOperation: vi.fn(async () => null), prepareDiscard: vi.fn(), discardBackups: vi.fn(async () => []), headCommitInfo: vi.fn(async () => null) }));
vi.mock("./diff", () => ({ calculateDiff: bridge.diff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./DiffViewer", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { default: forwardRef((props: { readingKey: string; document: { hunks: unknown[] } }, ref) => {
    useImperativeHandle(ref, () => ({ navigate: bridge.navigate, navigateTo: vi.fn(), expandAll: vi.fn(() => 0) }));
    return <div data-testid="readable" data-hunks={props.document.hunks.length}>{props.readingKey}</div>;
  }) };
});
vi.mock("./ImageViewer", () => ({ default: () => <div className="image-viewer"/> }));
import App from "./App";

const repo = { repoId: "a", displayName: "a", worktreePath: "C:/a", gitDir: "C:/a/.git", commonDir: "C:/a/.git", branch: "main" };
const change = (path: string): FileChange => ({ pathId: `id-${path}`, displayPath: path, oldPathId: null, oldDisplayPath: null, status: "modified", additions: 1, deletions: 0 });
const files = ["a.ts", "crlf.txt", "data.bin", "sub"].map(change);
const snap = (): RepositorySnapshot => ({
  requestId: "s", repo, scope: "unstaged", revision: "r1", scannedAt: 1, files, statsReady: true, scopes: { unstaged: files, staged: [], all: files },
  branchInfo: { head: "main", oid: "h".repeat(40), upstream: null, ahead: null, behind: null }, inProgress: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false },
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" }
});
const text = (patch: Partial<TextSide>): TextSide => ({ endpoint: "index", text: "x\n", byteLength: 2, encoding: "utf-8", bom: false, kind: "text", eol: "lf", hasFinalNewline: true, contentId: "l", ...patch });
const pairs: Record<string, [TextSide, TextSide]> = {
  "id-a.ts": [text({ text: "a  b\n", contentId: "a1" }), text({ endpoint: "workingTree", text: "a b\n", contentId: "a2" })],
  "id-crlf.txt": [text({ text: "x\r\n", eol: "crlf", contentId: "c1" }), text({ endpoint: "workingTree", text: "x\n", contentId: "c2" })],
  "id-data.bin": [text({ text: null, kind: "binary", encoding: "binary-or-unsupported", byteLength: 3, contentId: "b1" }), text({ endpoint: "workingTree", text: null, kind: "binary", encoding: "binary-or-unsupported", byteLength: 4, contentId: "b2" })],
  "id-sub": [text({ text: null, kind: "gitlink", encoding: "binary-or-unsupported", contentId: "s1", details: { state: "ready", reason: null, oid: "1".repeat(40), mode: "160000", image: null, submodule: { commit: "1".repeat(40), initialized: null, commitChanged: false, trackedChanges: false, untrackedChanges: false } } }),
    text({ endpoint: "workingTree", text: null, kind: "gitlink", encoding: "binary-or-unsupported", contentId: "s2", details: { state: "ready", reason: null, oid: "2".repeat(40), mode: "160000", image: null, submodule: { commit: "2".repeat(40), initialized: true, commitChanged: true, trackedChanges: true, untrackedChanges: false } } })]
};
const pair = (pathId: string): ContentPair => ({ requestId: "c", repoId: "a", revision: "r1", pathId, displayPath: pathId.slice(3), stale: false, degradation: pathId === "id-data.bin" ? "内容包含 NUL 字节，按二进制文件处理" : null, left: pairs[pathId][0], right: pairs[pathId][1] });

let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const row = (path: string) => host.querySelector(`.file[aria-label="${path}"]`) as HTMLElement;
const select = async (path: string) => { await act(async () => row(path).click()); await flush(); };
const setSelect = async (label: string, value: string) => {
  const element = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
};
const key = async (init: KeyboardEventInit) => { await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); }); await flush(); };

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (value: string) => ({ width: value.length * 6 }) } as unknown as CanvasRenderingContext2D);
  bridge.open.mockResolvedValue(snap());
  bridge.refresh.mockResolvedValue(snap());
  bridge.read.mockImplementation(async (_repo: string, _scope: string, _revision: string, pathId: string) => pair(pathId));
  // 模拟 Worker：a.ts 保留空白时 1 处差异，忽略空白时 0 处（并记录略去的空白差异数）
  bridge.diff.mockImplementation(async (requestId: string, contentIds: [string, string], _left: string, _right: string, whitespace = "keep") => ({
    requestId, contentIds, whitespace, ignoredWhitespace: whitespace === "ignore" ? 1 : 0, changes: [],
    hunks: contentIds[0] === "a1" && whitespace === "keep" ? [{ fromA: 0, toA: 4, fromB: 0, toB: 3 }] : [], elapsedMs: 1
  }));
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ version: 2, activeRepoId: "a", projects: [{ repo, gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const mount = async () => { await act(async () => { root.render(<App />); }); await flush(); };

describe("任务 05 阅读体验（App 集成）", () => {
  it("忽略空白：同一内容按新规则重新计算，规则持续可见，只有空白差异时说明原因", async () => {
    await mount();
    await select("a.ts");
    expect(host.querySelector("[data-testid=readable]")?.getAttribute("data-hunks")).toBe("1");
    const reads = bridge.read.mock.calls.length;
    await setSelect("空白规则", "ignore");
    expect(bridge.diff).toHaveBeenLastCalledWith(expect.any(String), ["a1", "a2"], "a  b\n", "a b\n", "ignore");
    expect(bridge.read.mock.calls.length).toBe(reads);
    expect(host.querySelector("[data-testid=readable]")?.getAttribute("data-hunks")).toBe("0");
    expect(host.querySelector(".filter-badge")?.textContent).toBe("已忽略空白 · 略去 1 处");
    expect(host.querySelector(".reading-notice")?.textContent).toContain("忽略空白后没有差异");
    await setSelect("空白规则", "keep");
    expect(host.querySelector("[data-testid=readable]")?.getAttribute("data-hunks")).toBe("1");
    expect(host.querySelector(".filter-badge")).toBeNull();
  });

  it("CRLF → LF：两侧端点标出换行符，并说明文本相同只有换行符变化", async () => {
    await mount();
    await select("crlf.txt");
    expect(host.querySelector(".left-endpoint .encoding")?.textContent).toBe("UTF-8 · CRLF");
    expect(host.querySelector(".right-endpoint .encoding")?.textContent).toBe("UTF-8 · LF");
    expect(host.querySelector(".reading-notice")?.textContent).toBe("文本内容相同，只有换行符：CRLF → LF。");
  });

  it("二进制与子模块显示说明卡片，不显示“内容已降级”遮罩或空 diff", async () => {
    await mount();
    await select("data.bin");
    expect(host.querySelector(".special-file")?.textContent).toContain("二进制文件 · 内容不同");
    expect(host.querySelector(".state.warning")).toBeNull();
    expect(host.querySelector("[data-testid=readable]")).toBeNull();
    await select("sub");
    const card = host.querySelector(".special-file")?.textContent ?? "";
    expect(card).toContain("子模块（gitlink）· 子模块指向的提交已改变");
    expect(card).toContain(`提交 ${"2".repeat(12)}（子模块工作区有已跟踪文件的修改）`);
  });

  it("专注 diff 与 F7：快捷键切换专注、Esc 退出；F7 / Shift+F7 调用阅读器导航", async () => {
    await mount();
    await select("a.ts");
    await key({ key: "Enter", ctrlKey: true, shiftKey: true });
    expect(host.querySelector(".app.focus-mode")).toBeTruthy();
    await key({ key: "Escape" });
    expect(host.querySelector(".app.focus-mode")).toBeNull();
    await key({ key: "F7" });
    await key({ key: "F7", shiftKey: true });
    expect(bridge.navigate.mock.calls).toEqual([[1], [-1]]);
  });
});
