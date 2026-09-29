import { describe, expect, it } from "vitest";
import { fitInViewport } from "./menu-position";

describe("fitInViewport", () => {
  it("空间足够时保持在锚点右下方", () => {
    expect(fitInViewport(100, 100, 160, 120, 800, 600)).toEqual({ left: 100, top: 100 });
  });
  it("下方放不下时翻到锚点上方", () => {
    expect(fitInViewport(100, 550, 160, 120, 800, 600)).toEqual({ left: 100, top: 430 });
  });
  it("右侧放不下时向左移到视口内", () => {
    expect(fitInViewport(750, 100, 160, 120, 800, 600)).toEqual({ left: 636, top: 100 });
  });
  it("上下都放不下时贴住视口顶部", () => {
    expect(fitInViewport(100, 80, 160, 300, 800, 200)).toEqual({ left: 100, top: 4 });
  });
});
