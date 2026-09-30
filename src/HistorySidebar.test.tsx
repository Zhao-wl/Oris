// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HistorySidebar from "./HistorySidebar";
import type { Branch, RefsView } from "./history-api";

let root: Root;
let host: HTMLDivElement;
const branch = (name: string, current = false): Branch => ({ fullName: `refs/heads/${name}`, name, kind: "local", oid: "a".repeat(40), current, tracking: null, remote: null });
const refs = (current: string): RefsView => ({
  head: { branch: current, oid: "a".repeat(40), detached: false, unborn: false },
  local: ["dev", "feature", "main"].map((name) => branch(name, name === current)), remote: [], tags: [], shallow: false, remotes: [], defaultRemote: null, fetchHeadAt: null,
});
const render = async (view: RefsView | null, hidden: boolean) => {
  await act(async () => root.render(<HistorySidebar refs={view} refsError={null} headLabel="feature" current={null} hidden={hidden} filter={null} onFilter={() => {}}
    stashes={[]} stashError={null} selectedStash={null} onStash={() => {}} blocked={null} onMenu={() => {}}/>));
};
let scrolled: string[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  scrolled = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this.getAttribute("data-ref") ?? ""); });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("scrolls to the current branch once refs load and again each time the history is reopened", async () => {
  await render(null, false);
  expect(scrolled).toEqual([]);
  await render(refs("feature"), false);
  expect(scrolled).toEqual(["refs/heads/feature"]);
  // 可见期间的刷新不打扰用户的滚动位置。
  await render(refs("feature"), false);
  expect(scrolled).toEqual(["refs/heads/feature"]);
  // 隐藏期间切换了分支，重新打开时定位到新的当前分支。
  await render(refs("feature"), true);
  await render(refs("main"), true);
  expect(scrolled).toEqual(["refs/heads/feature"]);
  await render(refs("main"), false);
  expect(scrolled).toEqual(["refs/heads/feature", "refs/heads/main"]);
});
