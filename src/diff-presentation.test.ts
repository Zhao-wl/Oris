import { describe, expect, it } from "vitest";
import { availableDiffModes, resolveDiffPresentation } from "./diff-presentation";
import type { FileChange, TextSide } from "./types";

const side = (encoding: TextSide["encoding"], byteLength = 0, endpoint: TextSide["endpoint"] = "workingTree") =>
  ({ encoding, byteLength, endpoint });

describe("纯新增/删除呈现判定", () => {
  it("普通比较只提供 split/unified，纯文件只显示单文件模式", () => {
    expect(availableDiffModes({ kind: "compare" })).toEqual(["split", "unified"]);
    expect(availableDiffModes({ kind: "single", side: "b", tone: "inserted", empty: false })).toEqual(["single"]);
  });

  it.each<FileChange["status"]>(["added", "untracked"])("%s 使用右侧全宽新增视图", (status) => {
    expect(resolveDiffPresentation(status, side("missing", 0, "emptyTree"), side("utf-8", 12))).toEqual({
      kind: "single", side: "b", tone: "inserted", empty: false
    });
  });

  it("删除使用左侧全宽删除视图", () => {
    expect(resolveDiffPresentation("deleted", side("utf-8", 12, "head"), side("missing"))).toEqual({
      kind: "single", side: "a", tone: "deleted", empty: false
    });
  });

  it("空新增与空删除仍由端点缺失语义识别", () => {
    expect(resolveDiffPresentation("added", side("missing", 0, "emptyTree"), side("utf-8", 0))).toMatchObject({ kind: "single", tone: "inserted", empty: true });
    expect(resolveDiffPresentation("deleted", side("utf-8", 0, "head"), side("missing", 0))).toMatchObject({ kind: "single", tone: "deleted", empty: true });
  });

  it("现有文件清空或空文件写入内容都保持比较视图", () => {
    expect(resolveDiffPresentation("modified", side("utf-8", 18, "index"), side("utf-8", 0))).toEqual({ kind: "compare" });
    expect(resolveDiffPresentation("modified", side("utf-8", 0, "index"), side("utf-8", 18))).toEqual({ kind: "compare" });
  });

  it.each<FileChange["status"]>(["renamed", "conflicted", "typeChanged", "modified"])("%s 不因空内容或缺失编码误入纯文件模式", (status) => {
    expect(resolveDiffPresentation(status, side("missing"), side("utf-8", 0))).toEqual({ kind: "compare" });
    expect(resolveDiffPresentation(status, side("utf-8", 0), side("missing"))).toEqual({ kind: "compare" });
  });
});
