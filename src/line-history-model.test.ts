import { describe, expect, it } from "vitest";
import { lineQuery, relativeCommitTime, type LineHistoryContext } from "./line-history-model";
import type { TextSide } from "./types";

const side = (endpoint: TextSide["endpoint"], text = "one\ntwo\n"): TextSide => ({ endpoint, text, contentId: endpoint, encoding: "utf-8", byteLength: text.length, eol: "lf", hasFinalNewline: true });
function context(): LineHistoryContext {
  return { head: "head-oid", history: null, file: { pathId: "new", oldPathId: "old", displayPath: "new.txt", oldDisplayPath: "old.txt", status: "renamed", additions: 1, deletions: 1 },
    pair: { repoId: "r", pathId: "new", displayPath: "new.txt", requestId: "req", revision: "snapshot", stale: false, degradation: null, left: side("index"), right: side("workingTree", "one\nchanged\n") } };
}

describe("行归属的版本与行边界", () => {
  it("本地 rename 两侧都以 HEAD 的原路径追溯，但分别使用各自的阅读快照", () => {
    const c = context();
    expect(lineQuery(c, { side: "a", line: 2 })).toEqual({ pathId: "old", revision: "head-oid", contents: "one\ntwo\n", line: 2 });
    expect(lineQuery(c, { side: "b", line: 2 })).toEqual({ pathId: "old", revision: "head-oid", contents: "one\nchanged\n", line: 2 });
  });
  it("历史 rename 左右侧使用不同路径与固定 OID，不混入工作区", () => {
    const c = context(); c.pair.left = side("commit"); c.pair.right = side("commit");
    c.history = { key: "k", source: "历史", file: { path: "new.txt", oldPath: "old.txt", pathId: "new", oldPathId: "old", status: "renamed" }, left: { oid: "left-oid", label: "旧版本" }, right: { oid: "right-oid", label: "新版本" } };
    expect(lineQuery(c, { side: "a", line: 2 })).toEqual({ pathId: "old", revision: "left-oid", contents: null, line: 2 });
    expect(lineQuery(c, { side: "b", line: 2 })).toEqual({ pathId: "new", revision: "right-oid", contents: null, line: 2 });
  });
  it("不查询末尾占位行、冲突阶段或不支持的编码；BOM 保留在快照中", () => {
    const c = context();
    expect(lineQuery(c, { side: "b", line: 3 })).toContain("占位行");
    c.pair.left.endpoint = "stage2";
    expect(lineQuery(c, { side: "a", line: 1 })).toContain("冲突");
    c.pair.right.encoding = "utf-16le";
    expect(lineQuery(c, { side: "b", line: 1 })).toContain("编码");
    c.pair.right.encoding = "utf-8"; c.pair.right.bom = true;
    expect(lineQuery(c, { side: "b", line: 1 })).toMatchObject({ contents: "\uFEFFone\nchanged\n" });
  });
  it("相对时间保留周与完整详情时间的分工", () => {
    expect(relativeCommitTime(0, 28 * 86_400_000)).toBe("4 周前");
  });
});
