// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LineHistoryBar from "./LineHistoryBar";
import { lineHistoryKey, type LineHistoryContext } from "./line-history-model";
import type { CommitInfo, LineAttribution } from "./history-api";

const bridge = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }));
vi.mock("./history-api", async importOriginal => ({ ...(await importOriginal<typeof import("./history-api")>()), readLineAttribution: bridge.read, readLineChange: bridge.change }));
const commit: CommitInfo = { oid: "a".repeat(40), parents: ["b".repeat(40)], authorName: "Alice", authorEmail: "alice@x", authorTime: 1_700_000_000, committerName: "Bob", committerEmail: "bob@x", committerTime: 1_700_000_060, subject: "selected commit", body: "full commit body", refs: [] };
const attribution: LineAttribution = { commit, originalLine: 8, path: "old.txt", pathId: "old", shallow: false };
const textSide = (contentId: string) => ({ endpoint: "workingTree" as const, text: "one\ntwo\n", contentId, encoding: "utf-8" as const, byteLength: 8, eol: "lf" as const, hasFinalNewline: true });
const context: LineHistoryContext = { head: "b".repeat(40), history: null, file: { pathId: "f", displayPath: "f.txt", oldPathId: null, oldDisplayPath: null, status: "modified", additions: 1, deletions: 1 }, pair: { repoId: "r", requestId: "req", revision: "s", pathId: "f", displayPath: "f.txt", stale: false, degradation: null, left: textSide("a"), right: textSide("b") } };
let host: HTMLDivElement, root: Root;
const jump = vi.fn();
const render = (line = 1) => act(() => root.render(<LineHistoryBar context={context} selection={{ key: lineHistoryKey(context), value: { side: "b", line } }} onJump={jump}/>));
const read = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(170); }); };
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
beforeEach(() => { vi.useFakeTimers(); bridge.read.mockReset().mockResolvedValue(attribution); bridge.change.mockReset().mockResolvedValue(["@@ -8 +8 @@", "-old", "+new"]); jump.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("行提交信息浮层与直接跳转", () => {
  it("悬浮详情靠近鼠标，并在底部向上翻转，不使用底栏右边缘", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      return this.classList.contains("line-history-popover") ? new DOMRect(0, 0, 300, 180) : new DOMRect(0, 700, 1000, 24);
    });
    render(); await read();
    await act(async () => button("selected commit", host).dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 100, clientY: 700 })));
    const popup = document.querySelector<HTMLElement>('[aria-label="行提交详情"]')!;
    expect(popup.style.left).toBe("112px"); expect(popup.style.top).toBe("530px");
    await act(async () => { button("selected commit", host).dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 500, clientY: 710 })); button("selected commit", host).focus(); button("selected commit", host).click(); });
    expect(popup.style.left).toBe("112px"); expect(popup.style.top).toBe("530px");
    await act(async () => { button("复制 SHA", popup).dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 250, clientY: 570 })); button("复制 SHA", popup).focus(); });
    expect(popup.style.left).toBe("112px"); expect(popup.style.top).toBe("530px");
    expect(button("selected commit", host).hasAttribute("title")).toBe(false);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => button("selected commit", host).dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 400, clientY: 700 })));
    expect(document.querySelector<HTMLElement>('[aria-label="行提交详情"]')!.style.left).toBe("412px");
  });
  it("变化片段加载后也保持出现时的坐标，内容在视口剩余高度内滚动", async () => {
    let finish!: (lines: string[]) => void;
    bridge.change.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let height = 180;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) { return this.classList.contains("line-history-popover") ? new DOMRect(0, 0, 300, height) : new DOMRect(0, 700, 1000, 24); });
    render(); await read();
    await act(async () => button("selected commit", host).dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 100, clientY: 700 })));
    const popup = document.querySelector<HTMLElement>('[aria-label="行提交详情"]')!;
    height = 400;
    await act(async () => finish(["@@ -8 +8 @@", "+loaded patch"]));
    expect(popup.textContent).toContain("loaded patch");
    expect(popup.style.left).toBe("112px"); expect(popup.style.top).toBe("530px"); expect(popup.style.maxHeight).toBe("234px");
  });
  it("展示完整信息和真实 patch，只有作者与 SHA 执行跳转，没有重复按钮", async () => {
    render(); await read();
    await act(async () => button("selected commit", host).click());
    const popup = document.querySelector('[aria-label="行提交详情"]')!;
    expect(popup.textContent).toContain("full commit body"); expect(popup.textContent).toContain("Bob"); expect(popup.textContent).toContain("+new");
    expect(popup.textContent).not.toContain("定位提交"); expect(popup.textContent).not.toContain("查看提交变化");
    expect(bridge.change).toHaveBeenCalledWith("r", commit.oid, "old", 8);
    await act(async () => button("Alice", popup).click()); expect(jump).toHaveBeenLastCalledWith(attribution, true);
    await act(async () => button("aaaaaaaa", host).click()); expect(jump).toHaveBeenLastCalledWith(attribution, false);
  });
  it("未提交的行不显示历史跳转，也不读取提交 patch", async () => {
    bridge.read.mockResolvedValue({ ...attribution, commit: null }); render(); await read();
    expect(host.textContent).toContain("未提交修改"); expect(host.querySelectorAll("button")).toHaveLength(0); expect(bridge.change).not.toHaveBeenCalled();
  });
  it("快速切换行后，迟到的旧行结果不会覆盖新行", async () => {
    let finish!: (value: LineAttribution) => void;
    bridge.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ...attribution, commit: { ...commit, subject: "new line commit" } });
    render(1); await read(); render(2); await read();
    await act(async () => finish(attribution));
    expect(host.textContent).toContain("new line commit"); expect(host.textContent).not.toContain("selected commit");
  });
});
