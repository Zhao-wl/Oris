import { describe, expect, it } from "vitest";
import { chainedWheelDelta, diffMarkerGeometry, mapDiffPosition, railViewportStartLine } from "./diff-scroll";

describe("分段 Diff 滚动映射", () => {
  it("N:N 段内保持 1:1", () => {
    const boundaries = [{ a: 0, b: 0 }, { a: 100, b: 100 }];
    expect(mapDiffPosition(boundaries, "a", 37).value).toBe(37);
    expect(mapDiffPosition(boundaries, "b", 82).value).toBe(82);
  });

  it("长侧到短侧在端点前截停并精确落到端点", () => {
    const boundaries = [{ a: 0, b: 0 }, { a: 120, b: 40 }, { a: 200, b: 120 }];
    expect(mapDiffPosition(boundaries, "a", 30).value).toBe(30);
    expect(mapDiffPosition(boundaries, "a", 90).value).toBe(40);
    expect(mapDiffPosition(boundaries, "a", 120).value).toBe(40);
  });

  it("短侧跨过 0:N 边界时跳到长侧端点", () => {
    const boundaries = [
      { a: 0, b: 0 },
      { a: 20, b: 20 },
      { a: 20, b: 80 },
      { a: 100, b: 160 }
    ];
    expect(mapDiffPosition(boundaries, "a", 19.5).value).toBe(19.5);
    expect(mapDiffPosition(boundaries, "a", 20).value).toBe(80);
    expect(mapDiffPosition(boundaries, "b", 50).value).toBe(20);
  });

  it("N:0 删除与 M:N 反向映射保持单调端点", () => {
    const deleted = [
      { a: 0, b: 0 },
      { a: 30, b: 30 },
      { a: 90, b: 30 },
      { a: 140, b: 80 }
    ];
    expect(mapDiffPosition(deleted, "a", 60).value).toBe(30);
    expect(mapDiffPosition(deleted, "b", 30).value).toBe(90);

    const unequal = [{ a: 0, b: 0 }, { a: 40, b: 100 }, { a: 90, b: 150 }];
    expect(mapDiffPosition(unequal, "a", 20).value).toBe(20);
    expect(mapDiffPosition(unequal, "a", 40).value).toBe(100);
    expect(mapDiffPosition(unequal, "b", 70).value).toBe(40);
  });
});

describe("Diff 外缘轨道几何", () => {
  it("单轨 viewport 无可移动范围时停在首行", () => {
    expect(railViewportStartLine(300, 300, 180, 40, 20, 20)).toEqual({ top: 0, line: 0 });
  });

  it("单轨 viewport 拖动映射到逻辑可见行范围", () => {
    expect(railViewportStartLine(300, 75, 37.5, 37.5, 100, 25)).toEqual({ top: 0, line: 0 });
    expect(railViewportStartLine(300, 75, 150, 37.5, 100, 25)).toEqual({ top: 112.5, line: 37.5 });
    expect(railViewportStartLine(300, 75, 300, 37.5, 100, 25)).toEqual({ top: 225, line: 75 });
  });

  it("单轨 viewport 拖动连续跟手，不按整行跳变", () => {
    const a = railViewportStartLine(300, 150, 76, 0, 10, 5);
    const b = railViewportStartLine(300, 150, 77, 0, 10, 5);
    expect(b.top - a.top).toBe(1);
    expect(b.line).toBeGreaterThan(a.line);
  });

  it("零行 marker 保持最小可见刻度且不借用相邻整行", () => {
    expect(diffMarkerGeometry(200, 4, 4, 10, 2)).toEqual({ top: 80, height: 2 });
    expect(diffMarkerGeometry(200, 4, 6, 10, 2)).toEqual({ top: 80, height: 40 });
  });
});

describe("分栏滚轮接力", () => {
  it("当前侧未到边界时不接力", () => {
    expect(chainedWheelDelta(100, { top: 50, max: 500 }, { top: 50, max: 900 })).toBe(0);
    expect(chainedWheelDelta(-100, { top: 50, max: 500 }, { top: 50, max: 900 })).toBe(0);
  });

  it("当前侧到底后把滚动交给另一侧，并按剩余空间截断", () => {
    expect(chainedWheelDelta(100, { top: 500, max: 500 }, { top: 300, max: 900 })).toBe(100);
    expect(chainedWheelDelta(100, { top: 499.5, max: 500 }, { top: 860, max: 900 })).toBe(40);
  });

  it("当前侧到顶后向上滚动交给另一侧", () => {
    expect(chainedWheelDelta(-120, { top: 0, max: 500 }, { top: 80, max: 900 })).toBe(-80);
  });

  it("两侧都到边界或无增量时不接力", () => {
    expect(chainedWheelDelta(100, { top: 500, max: 500 }, { top: 900, max: 900 })).toBe(0);
    expect(chainedWheelDelta(-100, { top: 0, max: 500 }, { top: 0, max: 900 })).toBe(0);
    expect(chainedWheelDelta(0, { top: 500, max: 500 }, { top: 0, max: 900 })).toBe(0);
  });
});
