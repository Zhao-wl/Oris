import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphCommit } from "./history-graph";

const c = (oid: string, ...parents: string[]): GraphCommit => ({ oid, parents });

describe("commit graph lanes from real parents", () => {
  it("linear history stays in one lane and ends at the root", () => {
    const layout = layoutGraph([c("d", "c"), c("c", "b"), c("b", "a"), c("a")]);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
    expect(layout.rows[0].isTip).toBe(true);
    expect(layout.rows.slice(1).every((r) => !r.isTip)).toBe(true);
    expect(layout.rows[3].edges).toEqual([]);
    expect(layout.continuations).toEqual([]);
    expect(layout.width).toBe(1);
  });

  it("fork and merge: second parent opens a lane, both branches rejoin at the common ancestor", () => {
    // m 合并 x（main）与 y（topic），二者分叉自 base。
    const layout = layoutGraph([c("m", "x", "y"), c("y", "base"), c("x", "base"), c("base")]);
    const row = (oid: string) => layout.rows.find((r) => r.oid === oid)!;
    expect(row("m").edges).toEqual([{ fromLane: 0, toLane: 0, target: "x" }, { fromLane: 0, toLane: 1, target: "y" }]);
    expect(row("y").lane).toBe(1);
    expect(row("x").lane).toBe(0);
    // base 同时被泳道 0（x）与泳道 1（y）等待：在 base 处汇合。
    expect(row("base").lane).toBe(0);
    expect(row("base").mergedLanes).toEqual([1]);
    expect(layout.width).toBe(2);
    expect(layout.continuations).toEqual([]);
  });

  it("an unrelated tip and a pass-through lane do not borrow topology from row order", () => {
    // 两条独立历史交错显示：行号相邻不代表父子关系。
    const layout = layoutGraph([c("a2", "a1"), c("b2", "b1"), c("a1"), c("b1")]);
    const row = (oid: string) => layout.rows.find((r) => r.oid === oid)!;
    expect(row("b2").isTip).toBe(true);
    expect(row("b2").lane).toBe(1);
    expect(row("a1").lane).toBe(0);
    expect(row("b1").lane).toBe(1);
    expect(row("a1").edges).toContainEqual({ fromLane: 1, toLane: 1, target: "b1" });
    expect(row("a2").edges).toEqual([{ fromLane: 0, toLane: 0, target: "a1" }]);
  });

  it("marks continuation at the page edge and keeps earlier rows identical when the next page loads", () => {
    const all = [c("m", "x", "y"), c("y", "y0"), c("x", "x0"), c("y0", "base"), c("x0", "base"), c("base")];
    const firstPage = layoutGraph(all.slice(0, 3));
    expect(firstPage.continuations).toEqual([{ lane: 0, target: "x0" }, { lane: 1, target: "y0" }]);
    const full = layoutGraph(all);
    expect(full.rows.slice(0, 3)).toEqual(firstPage.rows);
    expect(full.continuations).toEqual([]);
  });

  it("parents missing from a filtered result remain continuations instead of fake endpoints", () => {
    const layout = layoutGraph([c("s2", "hidden"), c("s1", "other")]);
    expect(layout.rows.every((r) => r.isTip)).toBe(true);
    expect(layout.continuations.map((x) => x.target).sort()).toEqual(["hidden", "other"]);
  });

  it("octopus merge and duplicate detection", () => {
    const layout = layoutGraph([c("o", "a", "b", "d"), c("a", "r"), c("b", "r"), c("d", "r"), c("r")]);
    expect(layout.rows[0].edges.map((e) => e.toLane)).toEqual([0, 1, 2]);
    expect(layout.rows.find((r) => r.oid === "r")!.mergedLanes).toEqual([1, 2]);
    expect(() => layoutGraph([c("a"), c("a")])).toThrow();
  });
});
