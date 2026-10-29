import { describe, expect, it } from "vitest";
import { parseConflictBlocks } from "./conflict-blocks";
describe("actual conflict markers", () => {
  it("excludes clean differences and retains both sources and working-file lines", () => {
    const blocks = parseConflictBlocks("clean\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nclean");
    expect(blocks).toEqual([{ line: 2, endLine: 6, ours: "ours", theirs: "theirs", base: null, oursLabel: "HEAD", theirsLabel: "feature" }]);
  });
  it("reads diff3 ancestors, empty sides, CRLF and custom marker widths", () => {
    const blocks = parseConflictBlocks("<<<<<<<< HEAD\r\n|||||||| base\r\nold\r\n========\r\nnew\r\n>>>>>>>> topic");
    expect(blocks[0]).toMatchObject({ ours: "", base: "old", theirs: "new" });
  });
  it("does not invent blocks from incomplete or mismatched markers", () => {
    expect(parseConflictBlocks("<<<<<<< HEAD\na\n=======\nb")).toEqual([]);
    expect(parseConflictBlocks("<<<<<<< HEAD\na\n========\nb\n>>>>>>> topic")).toEqual([]);
    expect(parseConflictBlocks("already resolved")).toEqual([]);
  });
  it("keeps separate blocks for navigation", () => {
    const one = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> topic";
    expect(parseConflictBlocks(one + "\ncontext\n" + one).map(b => b.line)).toEqual([1, 7]);
  });
});

