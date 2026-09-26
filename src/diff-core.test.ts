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
    expect(computeDiff("中文路径/文件.ts\n", "中文路径/文件.ts\n")).toEqual({ changes: [], hunks: [], ignoredWhitespace: 0 });
  });

  describe("空白规则（任务 05）", () => {
    const left = "function a() {\n  return 1;\n}\nconst b = 2;\n";
    const right = "function a() {\n\treturn  1;\n}\nconst b = 3;\n";

    it("保留空白（默认）：缩进与行内空白差异都计入", () => {
      const keep = computeDiff(left, right);
      expect(keep.hunks).toHaveLength(2);
      expect(keep.ignoredWhitespace).toBe(0);
    });

    it("忽略空白：只略去行内空白差异，计数 / 高亮 / 导航来自同一份结果", () => {
      const ignore = computeDiff(left, right, "ignore");
      expect(ignore.hunks).toHaveLength(1);
      expect(ignore.ignoredWhitespace).toBeGreaterThan(0);
      // 剩下的差异块就是 b = 2 → 3 所在行
      const [hunk] = ignore.hunks;
      expect(right.slice(hunk.fromB, hunk.toB)).toContain("const b = 3;");
      expect(ignore.changes.every((change) => /\S/.test(left.slice(change.fromA, change.toA) + right.slice(change.fromB, change.toB)))).toBe(true);
    });

    it("忽略空白时，空行的增删仍然显示（与 git diff -w 一致）", () => {
      const result = computeDiff("a\nb\n", "a\n\nb\n", "ignore");
      expect(result.hunks).toHaveLength(1);
      expect(result.ignoredWhitespace).toBe(0);
    });

    it("只有空白不同的文件在忽略空白后没有差异块", () => {
      const result = computeDiff("x = 1\ny = 2\n", "x  =  1 \n\ty = 2\n", "ignore");
      expect(result.hunks).toEqual([]);
      expect(result.ignoredWhitespace).toBeGreaterThan(0);
    });
  });

  it("整文件新增和删除保持真实零长度半开范围", () => {
    const inserted = computeDiff("", "one\ntwo").hunks;
    expect(inserted).toEqual([{ fromA: 0, toA: 0, fromB: 0, toB: 7 }]);
    const deleted = computeDiff("one\ntwo", "").hunks;
    expect(deleted).toEqual([{ fromA: 0, toA: 7, fromB: 0, toB: 0 }]);
  });
});
