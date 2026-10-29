export interface ConflictBlock { line: number; endLine: number; ours: string; theirs: string; base: string | null; oursLabel: string; theirsLabel: string }
/** Only complete, consistently-sized Git marker groups are accepted. */
export function parseConflictBlocks(text: string): ConflictBlock[] {
  const lines = text.split(/\r?\n/); const blocks: ConflictBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^(<{7,})(?: (.*))?$/.exec(lines[i]);
    if (!start) continue;
    const width = start[1].length; let base = -1, separator = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^<{7,}(?: |$)/.test(lines[j])) break;
      if (lines[j] === '='.repeat(width) && separator < 0) separator = j;
      else if (new RegExp(`^\\|{${width}}(?: |$)`).test(lines[j]) && separator < 0 && base < 0) base = j;
      else if (new RegExp(`^>{${width}}(?: |$)`).test(lines[j]) && separator >= 0) { end = j; break; }
    }
    if (end < 0) continue;
    blocks.push({ line: i + 1, endLine: end + 1, ours: lines.slice(i + 1, base < 0 ? separator : base).join('\n'), base: base < 0 ? null : lines.slice(base + 1, separator).join('\n'), theirs: lines.slice(separator + 1, end).join('\n'), oursLabel: start[2] || 'stage 2', theirsLabel: lines[end].slice(width).trim() || 'stage 3' });
    i = end;
  }
  return blocks;
}
