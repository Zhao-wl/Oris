import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { collectQueryMatches, createReadingQuery } from "./search-model";

const options = { caseSensitive: false, wholeWord: false, regexp: false };

describe("reading search model", () => {
  it("uses one literal matcher for selections even when regex mode is enabled", () => {
    const state = EditorState.create({ doc: "a+b aaab A+B" });
    const query = createReadingQuery("a+b", { ...options, regexp: true }, true);
    expect(collectQueryMatches(state, query).matches).toEqual([{ from: 0, to: 3 }, { from: 9, to: 12 }]);
  });

  it("supports case, whole-word, and explicit regular-expression queries", () => {
    const state = EditorState.create({ doc: "cat Cat scatter cat42 cat" });
    const literal = createReadingQuery("cat", { caseSensitive: true, wholeWord: true, regexp: false });
    expect(collectQueryMatches(state, literal).matches).toEqual([{ from: 0, to: 3 }, { from: 22, to: 25 }]);
    const regexp = createReadingQuery("c.t", { caseSensitive: false, wholeWord: true, regexp: true });
    expect(collectQueryMatches(state, regexp).matches).toHaveLength(3);
  });

  it("reports invalid regex and skips zero-length matches without looping", () => {
    const state = EditorState.create({ doc: "abc" });
    const invalid = createReadingQuery("[", { ...options, regexp: true });
    expect(invalid.valid).toBe(false);
    const zero = createReadingQuery("^", { ...options, regexp: true });
    expect(collectQueryMatches(state, zero).matches).toEqual([]);
  });

  it("uses CodeMirror Unicode word boundaries", () => {
    const state = EditorState.create({ doc: "café cafe cafés" });
    const query = createReadingQuery("café", { caseSensitive: true, wholeWord: true, regexp: false });
    expect(collectQueryMatches(state, query).matches).toEqual([{ from: 0, to: 4 }]);
  });
});
