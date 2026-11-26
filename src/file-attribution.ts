import { useEffect, useMemo, useState } from "react";
import { errorText } from "./error-message";
import { readFileAttribution, type AttributionRange, type DiffAttributions } from "./history-api";
import { fileAttributionQuery, type LineHistoryContext } from "./line-history-model";

export function useFileAttribution(context: LineHistoryContext | null, enabled: boolean) {
  const query = useMemo(() => {
    if (!context) return null;
    const left = fileAttributionQuery(context, "a");
    const right = fileAttributionQuery(context, "b");
    if (typeof left === "string" && typeof right === "string") return null;
    return { repoId: context.pair.repoId, left: typeof left === "string" ? null : left, right: typeof right === "string" ? null : right };
  }, [context]);
  const [result, setResult] = useState<{ query: typeof query; ranges?: DiffAttributions; error?: string } | null>(null);
  useEffect(() => {
    if (!enabled || !query) return;
    let live = true;
    void readFileAttribution(query.repoId, query.left, query.right).then(
      ranges => { if (live) setResult({ query, ranges }); },
      error => { if (live) setResult({ query, error: errorText(error) }); }
    );
    return () => { live = false; };
  }, [enabled, query]);
  const current = enabled && result?.query === query ? result : null;
  return { available: !!query, pending: enabled && !!query && !current, ranges: current?.ranges, error: current?.error };
}

export function attributionAt(ranges: readonly AttributionRange[], line: number) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const range = ranges[mid];
    if (line < range.firstLine) high = mid;
    else if (line >= range.firstLine + range.lineCount) low = mid + 1;
    else return range;
  }
}
