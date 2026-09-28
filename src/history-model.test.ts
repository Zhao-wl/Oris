import { describe, expect, it } from "vitest";
import { layoutGraph } from "./history-graph";
import { fetchAgeText, fetchTimeText, historyStatus, loadPullMode, movedEndpoint, parseProgress, PULL_MODE_KEY, rowSegments, ROW_HEIGHT, savePullMode } from "./history-model";
import type { RefsView } from "./history-api";

describe("commit graph segments", () => {
  it("draws merges into the node, pass-through lanes, and dashed continuations for unloaded parents", () => {
    const layout = layoutGraph([
      { oid: "m", parents: ["a", "b"] },
      { oid: "a", parents: ["root"] },
      { oid: "b", parents: ["root"] }
    ]);
    const loaded = new Set(["m", "a", "b"]);
    const merge = rowSegments(layout.rows[0], loaded);
    expect(merge.filter((s) => s.y1 === ROW_HEIGHT / 2).map((s) => [s.x1, s.x2])).toEqual([[6, 6], [6, 18]]);
    const second = rowSegments(layout.rows[1], loaded);
    // b 的泳道穿过 a 所在行。
    expect(second.some((s) => s.x1 === 18 && s.x2 === 18 && s.y1 === 0)).toBe(true);
    // root 不在已加载集合中：连线是虚线（分页边缘的延续）。
    expect(second.filter((s) => s.y1 === ROW_HEIGHT / 2 && s.x1 === 6).every((s) => s.dashed)).toBe(true);
    expect(new Set(layout.continuations.map((c) => c.target))).toEqual(new Set(["root"]));
    const third = rowSegments(layout.rows[2], loaded);
    expect(third.some((s) => s.y1 === 0 && s.x1 === 18 && s.x2 === 18)).toBe(true);
  });
});

const refs = (branchOid: string, headOid = "h"): RefsView => ({
  head: { branch: "refs/heads/main", oid: headOid, detached: false, unborn: false },
  local: [{ fullName: "refs/heads/main", name: "main", kind: "local", oid: branchOid, current: true, tracking: { state: "noUpstream" }, remote: null }],
  remote: [], shallow: false, remotes: [], defaultRemote: null, fetchHeadAt: null
});

describe("pinned compare endpoints", () => {
  it("reports moved or deleted refs, never OIDs", () => {
    const endpoint = { ref: "refs/heads/main", oid: "1".repeat(40), label: "main" };
    expect(movedEndpoint(endpoint, refs("1".repeat(40)))).toBeNull();
    expect(movedEndpoint(endpoint, refs("2".repeat(40)))).toContain("已移动到 22222222");
    expect(movedEndpoint({ ...endpoint, ref: "refs/heads/gone" }, refs("1".repeat(40)))).toContain("已不存在");
    expect(movedEndpoint({ ref: "a".repeat(40), oid: "a".repeat(40), label: "x" }, refs("2".repeat(40)))).toBeNull();
    expect(movedEndpoint({ ref: "HEAD", oid: "h", label: "HEAD" }, refs("x", "h2"))).toContain("HEAD 已移动");
  });
});

describe("fetch time", () => {
  it("only states an exact time for Oris' own fetch and marks later external fetches as unknown", () => {
    const at = Date.UTC(2026, 8, 24, 12, 0, 0);
    expect(fetchTimeText({ remote: "origin", at }, at + 1000, at + 2000)).toContain("上次由 Oris 获取 origin");
    expect(fetchTimeText({ remote: "origin", at }, at + 60_000)).toContain("时间未知");
    expect(fetchTimeText(null, at)).toContain("时间未知");
    expect(fetchTimeText(null, null)).toContain("尚未获取");
  });

  it("shows a short age on the fetch button from the newer of Oris' record and FETCH_HEAD", () => {
    const at = Date.UTC(2026, 8, 28, 10, 0, 0);
    expect(fetchAgeText(null, null, at)).toBeNull();
    expect(fetchAgeText({ remote: "origin", at }, null, at + 30_000)).toBe("刚刚");
    expect(fetchAgeText({ remote: "origin", at }, at + 120_000, at + 5 * 60_000)).toBe("3 分钟前");
    expect(fetchAgeText(null, at, at + 3 * 3_600_000)).toBe("3 小时前");
    expect(fetchAgeText(null, at, at + 50 * 3_600_000)).toBe("2 天前");
  });
});

describe("pull mode", () => {
  it("remembers the pull mode per worktree and falls back to fast-forward only", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(loadPullMode(storage, "C:/a")).toBe("ffOnly");
    savePullMode(storage, "C:/a", "merge");
    expect([loadPullMode(storage, "C:/a"), loadPullMode(storage, "C:/b")]).toEqual(["merge", "ffOnly"]);
    savePullMode(storage, "C:/a", "ffOnly");
    expect(JSON.parse(store.get(PULL_MODE_KEY)!)).toEqual({});
    store.set(PULL_MODE_KEY, "{broken");
    expect(loadPullMode(storage, "C:/a")).toBe("ffOnly");
    savePullMode(storage, "C:/a", "merge");
    expect(loadPullMode(storage, "C:/a")).toBe("merge");
  });
});

describe("progress", () => {
  it("parses the last --progress line including remote-side phases", () => {
    expect(parseProgress(["remote: Counting objects:  50% (5/10)", "Receiving objects:  45% (9/20)"])).toEqual({ phase: "Receiving objects", percent: 45, text: "Receiving objects:  45% (9/20)" });
    expect(parseProgress(["remote: Compressing objects: 100% (3/3), done."])?.percent).toBe(100);
    expect(parseProgress(["From C:/remote.git"])).toEqual({ phase: "", percent: null, text: "From C:/remote.git" });
    expect(parseProgress([])).toBeNull();
  });
  it("maps history statuses onto the reader's file statuses", () => {
    expect(historyStatus("copied")).toBe("added");
    expect(historyStatus("unmerged")).toBe("modified");
    expect(historyStatus("renamed")).toBe("renamed");
  });
});
