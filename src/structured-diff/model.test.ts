import { describe, expect, it } from "vitest";
import { compareStructured } from "./model";
import { STRUCTURED_MAX_BYTES } from "./budget";

describe("structured diff", () => {
  it("finds field additions, deletions and type changes at the actual JSON source lines", () => {
    const left = '{\n  "value": 1,\n  "retired": true,\n  "词": "😀"\n}';
    const right = '{\n  "词": "\\ud83d\\ude00",\n  "value": "1",\n  "new": false\n}';
    expect(compareStructured("json", left, right).changes).toEqual([
      { kind: "typeChanged", path: '$["value"]', left: { line: 2, label: "1" }, right: { line: 3, label: '"1"' } },
      { kind: "deleted", path: '$["retired"]', left: { line: 3, label: "true" } },
      { kind: "added", path: '$["new"]', right: { line: 4, label: "false" } },
    ]);
  });

  it("reports key reordering independently and compares arrays in order", () => {
    const result = compareStructured("yaml", "a: [1, 2]\nb: shown\n", "b: shown\na: [2, 1]\n");
    expect(result.reorderedKeys).toEqual(["$"]);
    expect(result.changes.map(change => [change.path, change.left?.line, change.right?.line])).toEqual([
      ['$["a"][0]', 1, 2], ['$["a"][1]', 1, 2],
    ]);
  });

  it("distinguishes exact numeric literals and treats equivalent decimal representations alike", () => {
    expect(compareStructured("json", "9007199254740992", "9007199254740993").changes).toHaveLength(1);
    expect(compareStructured("json", "1.000", "1e0").changes).toEqual([]);
    expect(compareStructured("yaml", "count: 9007199254740992", "count: 9007199254740993").changes).toHaveLength(1);
    expect(compareStructured("yaml", "count: 1", "count: 1.0").changes[0].kind).toBe("typeChanged");
  });

  it("preserves formatting-only distinctions and missing sides", () => {
    expect(compareStructured("json", '{"a":1,"b":2}', '{ "b": 2, "a": 1 }')).toEqual({ changes: [], reorderedKeys: ["$"], originalChanged: true });
    expect(compareStructured("json", null, "{}").changes).toEqual([{ kind: "added", path: "$", right: { line: 1, label: "对象 · 0 项" } }]);
    const mixed = compareStructured("json", '{"a":1,"b":2}', '{"b":2,"a":1,"c":3}');
    expect(mixed.reorderedKeys).toEqual(["$"]);
    expect(mixed.changes.map(change => change.kind)).toEqual(["added"]);
    expect(compareStructured("yaml", null, "parent:\n  child: 1\n").changes.map(change => [change.path, change.right?.line])).toEqual([
      ["$", 1], ['$["parent"]', 1], ['$["parent"]["child"]', 2],
    ]);
  });

  it.each([
    ["json", '{"a":1,"\\u0061":2}'], ["json", '{"a":1,}'], ["json", '/* comment */null'],
    ["yaml", "a: 1\na: 2"], ["yaml", "a: &main 1\nb: *main"], ["yaml", "a: !custom b"],
    ["yaml", "---\na: 1\n---\nb: 2"], ["yaml", "[missing end"],
  ] as const)("falls back for ambiguous or invalid %s input", (format, source) => {
    expect(() => compareStructured(format, source, null)).toThrow();
  });

  it("rejects excessive bytes, depth and total nodes", () => {
    expect(() => compareStructured("json", `"${"界".repeat(STRUCTURED_MAX_BYTES / 3 + 1)}"`, null)).toThrow(/预算/);
    expect(() => compareStructured("json", "[".repeat(42) + "null" + "]".repeat(42), null)).toThrow(/预算/);
    expect(() => compareStructured("json", JSON.stringify(new Array(20_001).fill(1)), null)).toThrow(/预算/);
  });
});
