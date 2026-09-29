import { Text } from "@codemirror/state";
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

  describe("分级 diff（V2-D75，研究 10）", () => {
    /** 与 v2-d58-font-equivalence.mjs 第 60–68 行相同的 3,000 行夹具：每 50 行改一个单词，一段长行，中部插入 2 行。 */
    const lc4 = () => {
      const base = Array.from({ length: 3000 }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`);
      const changed = [...base];
      for (let i = 30; i < changed.length; i += 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
      for (let i = 1200; i < 1260; i += 7) changed[i] = `${changed[i]} // ${"long wrapped comment ".repeat(12)}`;
      changed.splice(1500, 0, "  // inserted block", "  const extra = true;");
      return { left: base.join("\n") + "\n", right: changed.join("\n") + "\n" };
    };
    /** 用 changes 把左侧改写，应得到右侧。 */
    const apply = (left: string, right: string, changes: { fromA: number; toA: number; fromB: number; toB: number }[]) => {
      let out = "";
      let pos = 0;
      for (const change of changes) {
        expect(change.fromA).toBeGreaterThanOrEqual(pos);
        out += left.slice(pos, change.fromA) + right.slice(change.fromB, change.toB);
        pos = change.toA;
      }
      return out + left.slice(pos);
    };

    it("改动分散的 3,000 行文件逐处成块（整文件字符级 diff 在此退化为 1 块）", () => {
      const { left, right } = lc4();
      const { changes, hunks } = computeDiff(left, right);
      // 与 git diff -U0 的 65 个 hunk 相同
      expect(hunks).toHaveLength(65);
      const b = Text.of(right.split("\n"));
      expect(Math.max(...hunks.map((hunk) => b.lineAt(Math.max(hunk.fromB, hunk.toB - 1)).number - b.lineAt(hunk.fromB).number + 1))).toBeLessThanOrEqual(2);
      // 行内仍是词级范围：与不设 scanLimit 的整文件字符级 diff 相同（120 处）
      expect(changes).toHaveLength(120);
      expect(apply(left, right, changes)).toBe(right);
    });

    it("整文件重写在预算内完成，仍是 1 块", () => {
      const left = Array.from({ length: 3000 }, (_, i) => `  const a${i} = old(${i});`).join("\n") + "\n";
      const right = Array.from({ length: 3000 }, (_, i) => `  let z${(i * 7919) % 100003} = fresh(${i * 3});`).join("\n") + "\n";
      const started = performance.now();
      const { changes, hunks } = computeDiff(left, right);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(hunks).toHaveLength(1);
      expect(apply(left, right, changes)).toBe(right);
    });

    it("超过 6 万个不同的行（行编号超出基本平面）时仍逐处对齐", () => {
      const base = Array.from({ length: 70_000 }, (_, i) => `v${i}`);
      const changed = [...base];
      for (let i = 100; i < changed.length; i += 1000) changed[i] = `${changed[i]}x`;
      const left = base.join("\n") + "\n";
      const right = changed.join("\n") + "\n";
      const { changes, hunks } = computeDiff(left, right);
      expect(hunks).toHaveLength(70);
      expect(apply(left, right, changes)).toBe(right);
    });

    it("重复行（大量相同的括号行）中间插入一段", () => {
      const block = (name: string) => [`function ${name}() {`, "  return 1;", "}", ""];
      const baseLines = ["a", "b", "c", "d", "e", "f"].flatMap(block);
      const changedLines = [...baseLines];
      changedLines.splice(8, 0, ...block("inserted"));
      const left = baseLines.join("\n");
      const right = changedLines.join("\n");
      const { changes, hunks } = computeDiff(left, right);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].toA - hunks[0].fromA).toBe(0);
      expect(apply(left, right, changes)).toBe(right);
    });

    it("大段缩进变化（超过区间字符上限）在忽略空白后没有差异块", () => {
      const base = Array.from({ length: 2000 }, (_, i) => `  item(${i}, "value-${i}");`);
      const left = base.join("\n") + "\n";
      const right = base.map((line) => `\t${line.trim()}`).join("\n") + "\n";
      expect(computeDiff(left, right).hunks).toHaveLength(1);
      const ignore = computeDiff(left, right, "ignore");
      expect(ignore.hunks).toEqual([]);
      expect(ignore.ignoredWhitespace).toBeGreaterThan(0);
    });

    it("末行没有换行符", () => {
      expect(computeDiff("a\nb", "a\nc").hunks).toEqual([{ fromA: 2, toA: 3, fromB: 2, toB: 3 }]);
      const added = computeDiff("a\nb", "a\nb\n");
      expect(apply("a\nb", "a\nb\n", added.changes)).toBe("a\nb\n");
      expect(added.hunks).toHaveLength(1);
    });

    it("随机文本：changes 能把左侧还原为右侧，块范围合法且递增", () => {
      let seed = 42;
      const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
      const vocabulary = ["a", "b", "}", "", "  x = 1;", "中文", "😀", "a b", "\tq"];
      for (let round = 0; round < 300; round += 1) {
        const lines = Array.from({ length: Math.floor(random() * 30) }, () => pick(vocabulary));
        const edited = lines.flatMap((line) => {
          const r = random();
          if (r < 0.1) return [];
          if (r < 0.2) return [line, pick(vocabulary)];
          if (r < 0.3) return [`${line}${pick(vocabulary)}`];
          return [line];
        });
        const left = lines.join("\n") + (random() < 0.5 ? "\n" : "");
        const right = edited.join("\n") + (random() < 0.5 ? "\n" : "");
        const { changes, hunks } = computeDiff(left, right);
        expect(apply(left, right, changes)).toBe(right);
        let lastA = 0;
        let lastB = 0;
        for (const hunk of hunks) {
          expect(hunk.fromA).toBeGreaterThanOrEqual(lastA);
          expect(hunk.fromB).toBeGreaterThanOrEqual(lastB);
          expect(hunk.toA).toBeGreaterThanOrEqual(hunk.fromA);
          expect(hunk.toB).toBeGreaterThanOrEqual(hunk.fromB);
          lastA = hunk.toA;
          lastB = hunk.toB;
        }
        if (left === right) expect(hunks).toEqual([]);
      }
    });
  });

  it("整文件新增和删除保持真实零长度半开范围", () => {
    const inserted = computeDiff("", "one\ntwo").hunks;
    expect(inserted).toEqual([{ fromA: 0, toA: 0, fromB: 0, toB: 7 }]);
    const deleted = computeDiff("one\ntwo", "").hunks;
    expect(deleted).toEqual([{ fromA: 0, toA: 7, fromB: 0, toB: 0 }]);
  });
});
