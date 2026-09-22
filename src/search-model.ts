import { SearchQuery } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";

export interface ReadingSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export interface TextMatch {
  from: number;
  to: number;
}

export function createReadingQuery(search: string, options: ReadingSearchOptions, fromSelection = false) {
  return new SearchQuery({
    search,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    regexp: fromSelection ? false : options.regexp,
    literal: fromSelection || !options.regexp
  });
}

export function collectQueryMatches(
  state: EditorState,
  query: SearchQuery,
  from = 0,
  to = state.doc.length,
  limit = 10_000
) {
  const matches: TextMatch[] = [];
  if (!query.valid || !query.search || limit <= 0) return { matches, limited: false };
  const cursor = query.getCursor(state, Math.max(0, from), Math.min(state.doc.length, to));
  let limited = false;
  while (true) {
    const next = cursor.next();
    if (next.done) break;
    const match = next.value;
    // Zero-length regular-expression matches are not useful reading targets.
    if (match.to <= match.from) continue;
    if (matches.length >= limit) {
      limited = true;
      break;
    }
    matches.push({ from: match.from, to: match.to });
  }
  return { matches, limited };
}
