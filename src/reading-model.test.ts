import { describe, expect, it } from "vitest";
import { describeSpecial, lfsNotice, metaChanges, noVisibleDifferenceReason, shortcut, sideLabel } from "./reading-model";
import type { ContentPair, DiffDocument, TextSide } from "./types";

const side = (patch: Partial<TextSide> = {}): TextSide => ({
  endpoint: "index", text: "a\n", byteLength: 2, encoding: "utf-8", bom: false, kind: "text", eol: "lf", hasFinalNewline: true, contentId: "c1",
  details: { state: "ready", reason: null, oid: null, mode: "100644", image: null }, ...patch
});
const pair = (left: TextSide, right: TextSide, degradation: string | null = null): ContentPair => ({
  requestId: "r", repoId: "repo", revision: "rev", pathId: "p", displayPath: "file.txt", left, right, stale: false, degradation
});
const doc = (hunks: number, whitespace: DiffDocument["whitespace"] = "keep"): DiffDocument => ({
  requestId: "r", contentIds: ["c1", "c2"], whitespace, changes: [], hunks: Array.from({ length: hunks }, () => ({ fromA: 0, toA: 1, fromB: 0, toB: 1 })), elapsedMs: 0
});

describe("端点状态文字（A12）", () => {
  it("显示编码、BOM、换行符与无末尾换行", () => {
    expect(sideLabel(side())).toBe("UTF-8 · LF");
    expect(sideLabel(side({ bom: true, eol: "crlf", hasFinalNewline: false }))).toBe("UTF-8 · BOM · CRLF · 无末尾换行");
    expect(sideLabel(side({ encoding: "utf-16le", bom: true }))).toBe("UTF-16 LE · BOM · LF");
    expect(sideLabel(side({ kind: "missing", encoding: "missing", text: "" }))).toBe("不存在");
    expect(sideLabel(side({ kind: "unsupportedEncoding", text: null, encoding: "binary-or-unsupported", byteLength: 5 }))).toBe("编码不支持 · 5 字节");
    expect(sideLabel(side({ kind: "binary", text: null, encoding: "binary-or-unsupported", byteLength: 3 * 1024 }))).toBe("二进制 · 3.0 KiB");
  });
});

describe("文本之外的变化与“看起来没有差异”（R-DIFF）", () => {
  it("列出换行符、BOM、末尾换行与 mode 变化", () => {
    const changes = metaChanges(side(), side({ eol: "crlf", bom: true, hasFinalNewline: false, details: { state: "ready", reason: null, oid: null, mode: "100755", image: null } }));
    expect(changes).toEqual(["新增 BOM", "换行符：LF → CRLF", "移除末尾换行（新版本无末尾换行）", "文件模式：100644 → 100755（可执行）"]);
  });

  it("没有差异块但字节不同：说明原因，不说“无变化”", () => {
    const crlf = pair(side(), side({ eol: "crlf", contentId: "c2" }));
    expect(noVisibleDifferenceReason(crlf, doc(0))).toBe("文本内容相同，只有换行符：LF → CRLF。");
    const whitespace = pair(side(), side({ contentId: "c2" }));
    expect(noVisibleDifferenceReason(whitespace, doc(0, "ignore"))).toMatch(/忽略空白后没有差异/);
    expect(noVisibleDifferenceReason(whitespace, doc(0))).toMatch(/字节不同/);
    expect(noVisibleDifferenceReason(pair(side(), side()), doc(0))).toBeNull();
    expect(noVisibleDifferenceReason(whitespace, doc(2))).toBeNull();
  });
});

describe("特殊文件说明（A11）", () => {
  const labels: [string, string] = ["Index", "Working Tree"];

  it("二进制：大小与是否变化，不显示为无差异", () => {
    const result = describeSpecial(pair(side({ kind: "binary", text: null, byteLength: 3 }), side({ kind: "binary", text: null, byteLength: 4, contentId: "c2" })), labels)!;
    expect(result.title).toBe("二进制文件 · 内容不同");
    expect(result.lines).toContain("Index：二进制 · 3 字节");
  });

  it("编码不支持与超预算都带原因", () => {
    const unsupported = describeSpecial(pair(side(), side({ kind: "unsupportedEncoding", text: null, contentId: "c2" }), "编码不受支持：不是有效的 UTF-8"), labels)!;
    expect(unsupported.title).toBe("编码不受支持 · 内容不同");
    expect(unsupported.lines.at(-1)).toContain("不是有效的 UTF-8");
    const large = describeSpecial(pair(side({ kind: "tooLarge", text: null }), side({ kind: "tooLarge", text: null, contentId: "c2" }), "超过显示预算"), labels)!;
    expect(large.lines.join("\n")).toMatch(/已显示范围：无/);
  });

  it("子模块：两侧提交与未初始化状态", () => {
    const gitlink = (commit: string | null, initialized: boolean | null) => side({ kind: "gitlink", text: null, details: { state: "ready", reason: null, oid: commit, mode: "160000", image: null, submodule: { commit, initialized, commitChanged: false, trackedChanges: false, untrackedChanges: initialized === true } } });
    const changed = describeSpecial(pair(gitlink("a".repeat(40), null), { ...gitlink("b".repeat(40), true), contentId: "c2" }), labels)!;
    expect(changed.title).toBe("子模块（gitlink）· 子模块指向的提交已改变");
    expect(changed.lines[1]).toBe(`Working Tree：提交 ${"b".repeat(12)}（子模块工作区有未跟踪文件）`);
    const uninitialized = describeSpecial(pair(gitlink("a".repeat(40), null), gitlink(null, false)), labels)!;
    expect(uninitialized.lines[1]).toContain("子模块未初始化");
  });

  it("符号链接显示目标，不跟随", () => {
    const link = (target: string, id: string) => side({ kind: "symlink", text: null, contentId: id, details: { state: "ready", reason: null, oid: null, mode: "120000", image: null, linkTarget: target } });
    const result = describeSpecial(pair(link("a.txt", "c1"), link("b.txt", "c2")), labels)!;
    expect(result.title).toBe("符号链接 · 目标已改变");
    expect(result.lines.slice(0, 2)).toEqual(["Index：→ a.txt", "Working Tree：→ b.txt"]);
  });

  it("新增的二进制文件只描述存在的一侧", () => {
    const result = describeSpecial(pair(side({ kind: "missing", encoding: "missing", text: "" }), side({ kind: "binary", text: null })), labels)!;
    expect(result.title).toBe("二进制文件 · 新增文件");
    expect(result.lines[0]).toBe("Index：不存在");
  });

  it("普通文本与 LFS 指针不算特殊文件；LFS 指针另有说明", () => {
    expect(describeSpecial(pair(side(), side({ contentId: "c2" })), labels)).toBeNull();
    const lfs = side({ kind: "lfsPointer", details: { state: "ready", reason: null, oid: null, mode: "100644", image: null, lfsOid: "f".repeat(64), lfsSize: 2048, lfsLocal: false } });
    expect(describeSpecial(pair(lfs, lfs), labels)).toBeNull();
    expect(lfsNotice(pair(lfs, lfs))).toMatch(/不会自动下载.*2\.0 KiB.*本地缓存中没有对象/);
  });
});

describe("平台快捷键文字（R-UX）", () => {
  it("macOS 用 ⌘ / ⇧，其他平台用 Ctrl / Shift", () => {
    expect(shortcut("Ctrl+Shift+Enter", false)).toBe("Ctrl+Shift+Enter");
    expect(shortcut("Ctrl+Shift+Enter", true)).toBe("⌘⇧Enter");
  });
});
