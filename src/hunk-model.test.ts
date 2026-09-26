import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computeDiff } from "./diff-core";
import { fileLevelBlock, latin1View, lineRange, matchHunks, UNMATCHED_REASON } from "./hunk-model";
import type { HunkMap } from "./operations-api";
import type { DiffDocument, TextSide } from "./types";

const doc = (left: string, right: string): DiffDocument => ({ requestId: "r", contentIds: ["a", "b"], elapsedMs: 0, ...computeDiff(left, right) });
const map = (hunks: [number, number, number, number][], blocked: string | null = null): HunkMap => ({
  scope: "unstaged", pathId: "p", contentIds: ["a", "b"], blocked, note: null,
  hunks: hunks.map(([oldStart, oldEnd, newStart, newEnd], i) => ({ oldStart, oldEnd, newStart, newEnd, digest: `d${i}` }))
});

describe("显示的差异块 → 行范围（V2-05）", () => {
  it("覆盖整行的块、插入点与文件末尾", () => {
    const text = Text.of("a\nb\nc\n".split("\n"));
    expect(lineRange(text, 2, 4)).toEqual([1, 2]); // 第 2 行（含行尾）
    expect(lineRange(text, 4, 4)).toEqual([2, 2]); // 第 3 行之前的插入点
    expect(lineRange(text, 4, 6)).toEqual([2, 3]); // 最后一行
    const noFinal = Text.of("a\nb".split("\n"));
    expect(lineRange(noFinal, 2, 3)).toEqual([1, 2]); // 无末尾换行的最后一行
  });

  it("与 git diff -U0 的块范围逐一对应（修改、插入、删除、相邻块）", () => {
    const left = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n") + "\n";
    const right = ["l1", "L2", "l3", "L4", "l5", "new a", "new b", "l6", "l7", "l9", "l10"].join("\n") + "\n";
    const document = doc(left, right);
    // git diff -U0：@@ -2 +2 @@、@@ -4 +4 @@、@@ -5,0 +6,2 @@、@@ -8 +9,0 @@ → 0 起左闭右开
    const git = map([[1, 2, 1, 2], [3, 4, 3, 4], [5, 5, 5, 7], [7, 8, 9, 9]]);
    const items = matchHunks(document, left, right, git);
    expect(items.map((item) => item.state)).toEqual(Array(document.hunks.length).fill("ready"));
    expect(items.map((item) => item.ref?.digest)).toEqual(["d0", "d1", "d2", "d3"]);
  });

  it("对应不上的块不给操作并说明原因；未读取时为 pending", () => {
    const left = "a\nb\nc\n", right = "a\nB\nc\n";
    const document = doc(left, right);
    expect(matchHunks(document, left, right, map([[0, 1, 0, 1]]))[0]).toMatchObject({ state: "unmatched", reason: UNMATCHED_REASON });
    expect(matchHunks(document, left, right, null)[0].state).toBe("pending");
  });

  it("末尾换行的增删映射到最后一行", () => {
    const left = "x\ny\n", right = "x\ny";
    const document = doc(left, right);
    expect(matchHunks(document, left, right, map([[1, 2, 1, 2]]))[0].state).toBe("ready");
  });
});

describe("文件级禁用条件", () => {
  const base = { scope: "unstaged" as const, history: false, whitespace: "keep", readable: true, partial: false, single: false, conflicted: false, pair: {} as never };
  it("“全部”范围、冲突、只有一侧可读、不可读、新增 / 删除、忽略空白都有原因", () => {
    expect(fileLevelBlock({ ...base, scope: "all" })).toContain("“全部”范围");
    expect(fileLevelBlock({ ...base, conflicted: true })).toContain("冲突");
    expect(fileLevelBlock({ ...base, partial: true })).toContain("只有一侧");
    expect(fileLevelBlock({ ...base, readable: false })).toContain("二进制");
    expect(fileLevelBlock({ ...base, single: true })).toContain("新增");
    expect(fileLevelBlock({ ...base, whitespace: "ignore" })).toContain("忽略空白");
    expect(fileLevelBlock(base)).toBeNull();
  });
});

describe("单字节（Latin-1）显示", () => {
  const side = (patch: Partial<TextSide>): TextSide => ({ endpoint: "index", text: "ab", byteLength: 2, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: "c", ...patch });
  it("UTF-8 文本还原为原始字节逐字节显示，BOM 保留为 3 个字符；编码不支持的一侧用后端给出的逐字节文本", () => {
    expect(latin1View(side({ text: "é" }))).toBe("Ã©");
    expect(latin1View(side({ text: "a", bom: true }))).toBe("ï»¿a");
    expect(latin1View(side({ text: null, encoding: "binary-or-unsupported", kind: "unsupportedEncoding", latin1: "café" }))).toBe("café");
    expect(latin1View(side({ encoding: "utf-16le" }))).toBeNull();
    expect(latin1View(side({ encoding: "missing", text: "" }))).toBe("");
  });
});
