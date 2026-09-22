import { describe, expect, it } from "vitest";
import { diffMarkerGeometry, mapDiffPosition, scrollThumbGeometry } from "./diff-scroll";

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
  it("无溢出时 thumb 占满且不可拖", () => {
    expect(scrollThumbGeometry(300, 200, 300, 0)).toEqual({ top: 0, height: 300, scrollable: false });
  });

  it("thumb 与真实滚动范围一致", () => {
    expect(scrollThumbGeometry(300, 1200, 300, 450)).toEqual({ top: 112.5, height: 75, scrollable: true });
  });

  it("零行 marker 保持最小可见刻度且不借用相邻整行", () => {
    expect(diffMarkerGeometry(200, 4, 4, 10, 2)).toEqual({ top: 80, height: 2 });
    expect(diffMarkerGeometry(200, 4, 6, 10, 2)).toEqual({ top: 80, height: 40 });
  });
});
