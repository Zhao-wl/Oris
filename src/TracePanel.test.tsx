// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BlamePage, ContentSearchPage, TraceSource, LineHistoryPage, TraceEntry } from "./trace-api";
const bridge = vi.hoisted(() => ({ blame: vi.fn(), lines: vi.fn(), search: vi.fn(), cancel: vi.fn() }));
vi.mock("./trace-api", async original => ({ ...(await original<typeof import("./trace-api")>()), readFileBlame: bridge.blame, readLineHistory: bridge.lines, searchHistoryContent: bridge.search, cancelTraceQuery: bridge.cancel }));
import TracePanel from "./TracePanel";

const source: TraceSource = { repoId: "repo-a", query: { pathId: "f", revision: "a".repeat(40), contents: "one\ntwo\n", line: 2 }, endLine: 2, contentId: "bytes-hash", snapshotRevision: "reader-revision", side: "b" };
const stats = { elapsedMs: 4, outputBytes: 100, shallow: false };
const page: BlamePage = { ...stats, rows: [{ line: 1, originalLine: 1, path: "f", pathId: "f", oid: "a".repeat(40), author: "author", summary: "origin", text: "one" }], next: 201, totalLines: 201 };
const entry: TraceEntry = { oid: "c".repeat(40), parent: "b".repeat(40), path: "new.txt", pathId: "new", oldPath: "old.txt", oldPathId: "old", status: "renamed", newRange: { start: 2, end: 2 }, oldRange: { start: 1, end: 1 }, inferred: true, merge: false, patch: ["+target"] };
const linePage: LineHistoryPage = { ...stats, entries: [entry], next: null, reason: "origin", note: "first-parent limitation", scanned: 3 };
let host: HTMLDivElement, root: Root;
const compare = vi.fn(), locate = vi.fn(), back = vi.fn();
const flush = async () => act(async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
const click = async (label: string) => { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()); await flush(); };
const input = (label: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find(l => l.textContent?.startsWith(label))!.querySelector<HTMLInputElement>("input")!;
const type = async (label: string, value: string) => { await act(async () => { const node = input(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); await flush(); };
const render = async (repoId = "repo-a", hasSource = true) => { await act(async () => root.render(<TracePanel key={repoId} repoId={repoId} source={hasSource ? { ...source, repoId } : null} label="file" initialRefs={["refs/heads/main"]} onCompare={compare} onLocate={locate} onReturn={back} onClose={() => {}}/>)); await flush(); };
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); bridge.cancel.mockResolvedValue(undefined); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("按需加载 blame，传递仓库/快照/侧别并只保留当前 200 行页", async () => {
  bridge.blame.mockResolvedValue(page); await render(); expect(bridge.blame).not.toHaveBeenCalled();
  await click("加载整文件归属"); expect(bridge.blame).toHaveBeenLastCalledWith("repo-a", expect.any(String), source.query, { contentId: source.contentId, snapshotRevision: source.snapshotRevision, side: "b" }, 1);
  await click("aaaaaaaa"); expect(locate).toHaveBeenCalledWith("a".repeat(40), "f");
  bridge.blame.mockResolvedValue({ ...page, rows: [{ ...page.rows[0], line: 201, text: "next page" }], next: null });
  await click("下一页"); expect(host.querySelectorAll(".trace-blame-row")).toHaveLength(1); expect(host.textContent).toContain("next page"); expect(bridge.blame.mock.calls.at(-1)![4]).toBe(201);
});
it("取消后的迟到页和切换仓库的旧响应均不污染当前结果", async () => {
  let finish!: (page: BlamePage) => void; bridge.blame.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); await click("加载整文件归属"); const id = bridge.blame.mock.calls[0][1]; await click("取消查询"); expect(bridge.cancel).toHaveBeenCalledWith("repo-a", id);
  await act(async () => finish(page)); expect(host.querySelector(".trace-blame-row")).toBeNull();
  await click("加载整文件归属"); const old = finish; await render("repo-b"); await act(async () => old(page)); expect(host.querySelector(".trace-blame-row")).toBeNull(); expect(bridge.cancel.mock.calls.at(-1)![0]).toBe("repo-a");
});
it("行段变化取消请求；真实结果携带重命名前后路径与 OID 进入比较", async () => {
  let finish!: (page: LineHistoryPage) => void; bridge.lines.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(linePage);
  await render(); await click("连续行历史"); await click("追踪行段"); await type("结束行", "3"); await act(async () => finish(linePage)); expect(host.textContent).not.toContain("+target");
  await click("追踪行段"); expect(bridge.lines.mock.calls.at(-1)![2]).toMatchObject({ source: { line: 2 }, endLine: 3, identity: { snapshotRevision: "reader-revision", side: "b" } });
  await click("比较本次修改前后版本"); expect(compare).toHaveBeenCalledWith(entry); expect(host.textContent).toContain("替换块范围推断"); await click("返回阅读位置"); expect(back).toHaveBeenCalled();
});
it("零命中但有游标显示未完成，分页复用条件；改条件取消旧搜索", async () => {
  const cursor = { binding: "bound", tips: ["a".repeat(40)], skip: 30 };
  const result: ContentSearchPage = { ...stats, entries: [], next: cursor, tips: cursor.tips, reason: "scanBudget", note: "scan budget reached", scanned: 30 };
  bridge.search.mockResolvedValue(result); await render("repo-a", false); await type("内容文本", "needle"); await click("搜索历史内容"); expect(host.textContent).toContain("仍有未扫描提交");
  await click("下一页"); expect(bridge.search.mock.calls.at(-1)![3]).toEqual(cursor);
  let finish!: (page: ContentSearchPage) => void; bridge.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click("下一页"); await type("内容文本", "changed"); expect(bridge.cancel).toHaveBeenCalled(); await act(async () => finish(result)); expect(host.textContent).not.toContain("scan budget reached");
});
