import { describe, expect, it } from "vitest";
import { computeDiff } from "./diff-core";

describe("DiffDocument 核心", () => {
  it("从同一算法生成不等长块与导航锚点", () => {
    const left = "header\nconst policy = 'old';\nremoved\nfooter\n";
    const right = "header\nconst policy = 'new';\nadded one\nadded two\nfooter\n";
    const { changes, hunks } = computeDiff(left, right);
    expect(hunks.length).toBeGreaterThan(0);
    expect(changes.some((change) => change.toA - change.fromA !== change.toB - change.fromB)).toBe(true);
    expect(hunks.every((hunk) => hunk.fromA <= hunk.toA && hunk.fromB <= hunk.toB)).toBe(true);
  });

  it("相同 Unicode 文本没有变化块", () => {
    expect(computeDiff("中文路径/文件.ts\n", "中文路径/文件.ts\n")).toEqual({ changes: [], hunks: [] });
  });

  it("整文件新增和删除保持真实零长度半开范围", () => {
    const inserted = computeDiff("", "one\ntwo").hunks;
    expect(inserted).toEqual([{ fromA: 0, toA: 0, fromB: 0, toB: 7 }]);
    const deleted = computeDiff("one\ntwo", "").hunks;
    expect(deleted).toEqual([{ fromA: 0, toA: 7, fromB: 0, toB: 0 }]);
  });
});
