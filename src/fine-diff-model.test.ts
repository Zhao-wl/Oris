import { describe, expect, it } from "vitest";
import { computeDiff } from "./diff-core";
import { changeLines, lineKey, readingAnnotations, splitHunkLines, toggleChangeLines, toLineSelections } from "./fine-diff-model";
import type { HunkMap } from "./operations-api";
import type { DiffDocument } from "./types";
const map: HunkMap = { scope: "unstaged", pathId: "p", contentIds: ["a", "b"], blocked: null, note: null, hunks: [
  { oldStart: 1, oldEnd: 4, newStart: 1, newEnd: 3, digest: "replace" },
  { oldStart: 6, oldEnd: 6, newStart: 5, newEnd: 7, digest: "add" },
  { oldStart: 9, oldEnd: 11, newStart: 10, newEnd: 10, digest: "delete" }
] };
const doc = (a: string, b: string): DiffDocument => ({ requestId: "test", contentIds: ["a", "b"], elapsedMs: 0, ...computeDiff(a, b) });
describe("Git 行选区映射与阅读筛选", () => {
  it("只提交选中的实际变化行，保留侧别、块摘要与原始块内偏移", () => {
    const selected = toggleChangeLines([], changeLines(map), { side: "b", line: 3 }, null, false);
    expect(toLineSelections(map, selected)).toEqual([{ hunk: map.hunks[0], oldLines: [], newLines: [1] }]);
    expect(toLineSelections(map, [{ side: "a", line: 1 }])).toEqual([]);
  });
  it("Shift 选择跨相邻块只选同侧变化行，忽略上下文和另一侧", () => {
    const selected = toggleChangeLines([{ side: "a", line: 2 }], changeLines(map), { side: "b", line: 7 }, { side: "b", line: 2 }, true);
    expect(selected.map(lineKey)).toEqual(["a:2", "b:2", "b:3", "b:6", "b:7"]);
    expect(toggleChangeLines(selected, changeLines(map), { side: "a", line: 2 }, null, false).map(lineKey)).not.toContain("a:2");
  });
  it("拆分不对称替换、纯增和纯删；拆分只是可独立选择的单元", () => {
    expect(splitHunkLines(map, 0)).toEqual([[{ side: "a", line: 2 }, { side: "b", line: 2 }], [{ side: "a", line: 3 }, { side: "b", line: 3 }], [{ side: "a", line: 4 }]]);
    expect(splitHunkLines(map, 1).flat().map(lineKey)).toEqual(["b:6", "b:7"]);
    expect(splitHunkLines(map, 2).flat().map(lineKey)).toEqual(["a:10", "a:11"]);
  });
  it("真实 diff 输入识别移动候选，普通差异和导航计数不变", () => {
    const a = "start\nmove alpha();\nmove beta();\nanchor 1\nanchor 2\nanchor 3\nend\n";
    const b = "start\nanchor 1\nanchor 2\nanchor 3\nmove alpha();\nmove beta();\nend\n";
    const document = doc(a, b), before = JSON.stringify(document);
    const notes = readingAnnotations(document, a, b);
    expect(notes.filter(n => n.move).map(n => `${n.side}:${n.line}:${n.move}`)).toEqual(["a:2:1", "a:3:1", "b:5:1", "b:6:1"]);
    expect(JSON.stringify(document)).toBe(before);
    expect(document.hunks).toHaveLength(2);
  });
  it("单行、修改过的移动和重复候选保持普通 diff", () => {
    const a = "start\nonly one line\nanchor 1\nanchor 2\nanchor 3\nend\n";
    const b = "start\nanchor 1\nanchor 2\nanchor 3\nonly one line\nend\n";
    expect(readingAnnotations(doc(a, b), a, b).filter(n => n.move)).toEqual([]);
    const document: DiffDocument = { requestId: "x", contentIds: ["a", "b"], elapsedMs: 0, changes: [], hunks: [
      { fromA: 0, toA: 14, fromB: 0, toB: 0 }, { fromA: 14, toA: 28, fromB: 0, toB: 0 }, { fromA: 28, toA: 28, fromB: 0, toB: 14 }
    ] };
    expect(readingAnnotations(document, "move 1\nmove 2\nmove 1\nmove 2\n", "move 1\nmove 2\n").filter(n => n.move)).toEqual([]);
  });
  it("格式筛选只标注空白变化；功能修改和导航保持原样", () => {
    const a = "start\nconst x = 1;\nanchor\nvalue old\nend\n", b = "start\n  const x=1;\nanchor\nvalue new\nend\n";
    const document = doc(a, b), before = JSON.stringify(document);
    const notes = readingAnnotations(document, a, b);
    expect(notes.filter(n => n.format).map(lineKey)).toEqual(["a:2", "b:2"]);
    expect(JSON.stringify(document)).toBe(before);
    expect(document.hunks.length).toBe(2);
  });
  it("100,000 行输入和大型拆分只做线性分析，按页生成可见行组", () => {
    const a = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const b = a.replace("line 40000", "  line 40000"); const document = doc(a, b);
    const start = performance.now(); expect(readingAnnotations(document, a, b).filter(n => n.format)).toHaveLength(2);
    expect(performance.now() - start).toBeLessThan(1500);
    const large = { ...map, hunks: [{ oldStart: 0, oldEnd: 100_000, newStart: 0, newEnd: 100_000, digest: "large" }] };
    expect(splitHunkLines(large, 0, 800, 1000)).toHaveLength(200);
    expect(splitHunkLines(large, 0, 800, 1000)[0]).toEqual([{ side: "a", line: 801 }, { side: "b", line: 801 }]);
  });
});
