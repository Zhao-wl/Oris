export type DiffSide = "a" | "b";

export interface DiffBoundaryPair {
  a: number;
  b: number;
}

export interface MappedDiffPosition {
  value: number;
  segment: number;
}

export interface DiffMarkerGeometry {
  top: number;
  height: number;
}

const sourceValue = (boundary: DiffBoundaryPair, side: DiffSide) => boundary[side];
const targetValue = (boundary: DiffBoundaryPair, side: DiffSide) => boundary[side === "a" ? "b" : "a"];

/**
 * Piecewise diff mapping with 1:1 progress inside a segment, clamping at the
 * shorter target endpoint and exact endpoint jumps for unequal/zero ranges.
 */
export function mapDiffPosition(
  boundaries: readonly DiffBoundaryPair[],
  sourceSide: DiffSide,
  sourcePosition: number
): MappedDiffPosition {
  if (!boundaries.length) return { value: sourcePosition, segment: -1 };
  if (boundaries.length === 1) return { value: targetValue(boundaries[0], sourceSide), segment: 0 };

  const firstSource = sourceValue(boundaries[0], sourceSide);
  const firstTarget = targetValue(boundaries[0], sourceSide);
  if (sourcePosition < firstSource) {
    return { value: firstTarget - (firstSource - sourcePosition), segment: 0 };
  }

  // Upper-bound search deliberately advances across equal source endpoints:
  // a 0:N range has no continuous source distance and jumps to its target end.
  let low = 1;
  let high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sourceValue(boundaries[middle], sourceSide) <= sourcePosition) low = middle + 1;
    else high = middle;
  }
  const segment = low - 1;

  if (segment === boundaries.length - 1) {
    const source = sourceValue(boundaries[segment], sourceSide);
    const target = targetValue(boundaries[segment], sourceSide);
    return { value: target + Math.max(0, sourcePosition - source), segment };
  }

  const sourceStart = sourceValue(boundaries[segment], sourceSide);
  const sourceEnd = sourceValue(boundaries[segment + 1], sourceSide);
  const targetStart = targetValue(boundaries[segment], sourceSide);
  const targetEnd = targetValue(boundaries[segment + 1], sourceSide);
  if (sourceEnd <= sourceStart) return { value: targetEnd, segment };
  return {
    value: Math.min(targetStart + Math.max(0, sourcePosition - sourceStart), targetEnd),
    segment
  };
}

export interface ScrollExtent {
  top: number;
  max: number;
}

/**
 * Wheel chaining between split panes: once the hovered pane can no longer move
 * in the wheel direction, hand the remaining delta to the opposite pane.
 * Returns the delta to apply to the opposite pane, or 0 when nothing chains.
 */
export function chainedWheelDelta(deltaY: number, source: ScrollExtent, target: ScrollExtent, epsilon = 1): number {
  if (!deltaY) return 0;
  const sourceBlocked = deltaY > 0 ? source.top >= source.max - epsilon : source.top <= epsilon;
  if (!sourceBlocked) return 0;
  const room = deltaY > 0 ? target.max - target.top : target.top;
  if (room <= epsilon) return 0;
  return Math.sign(deltaY) * Math.min(Math.abs(deltaY), room);
}

export function railViewportStartLine(
  trackHeight: number,
  viewportHeight: number,
  pointerY: number,
  grabOffset: number,
  lineCount: number,
  visibleLineCount: number
): { top: number; line: number } {
  const lines = Math.max(1, Math.floor(lineCount));
  const visible = Math.min(lines, Math.max(1, visibleLineCount));
  const maximumStart = Math.max(0, lines - visible);
  const travel = Math.max(0, trackHeight - viewportHeight);
  if (!travel || !maximumStart) return { top: 0, line: 0 };
  const top = Math.min(travel, Math.max(0, pointerY - grabOffset));
  // Fractional on purpose: rounding to whole lines makes the drag step on short files.
  return { top, line: top / travel * maximumStart };
}

export function diffMarkerGeometry(
  trackHeight: number,
  startLine: number,
  endLine: number,
  lineCount: number,
  minimumMarker = 2
): DiffMarkerGeometry {
  const track = Math.max(0, trackHeight);
  const denominator = Math.max(1, lineCount);
  const start = Math.min(denominator, Math.max(0, startLine));
  const end = Math.min(denominator, Math.max(start, endLine));
  const top = track * start / denominator;
  const naturalHeight = track * (end - start) / denominator;
  return {
    top: Math.min(Math.max(0, track - minimumMarker), top),
    height: Math.min(track, Math.max(minimumMarker, naturalHeight))
  };
}

/**
 * V2-D58：字号变化时编辑器如何保持阅读位置。
 * - "snapshot"：先按 CodeMirror 自己的锚点规则（视口顶部那一行保持相同的像素偏移）给出滚动快照，第一轮测量就按该行选视口；
 * - "measure"：只请求重新测量，由 CodeMirror 的测量循环自行锚定。在顶部（锚点为 0）、滚到底部（CodeMirror 锚定底部）、
 *   自动换行（折行数随字号变化，两种锚定会差一行左右）时使用，与优化前的行为逐项一致。
 */
export function fontChangeScroll(scroll: { scrollTop: number; scrollHeight: number; clientHeight: number; lineWrapping: boolean }): "snapshot" | "measure" {
  const atTop = scroll.scrollTop < 1;
  const atBottom = scroll.scrollTop > Math.max(1, scroll.scrollHeight - scroll.clientHeight - 4);
  return atTop || atBottom || scroll.lineWrapping ? "measure" : "snapshot";
}

/** 一个块在两侧的行范围（1 起）：first 为块的第一行（空的一侧为插入点之后的那一行），next 为块之后的第一行。 */
export interface ChunkLines { firstA: number; firstB: number; nextA: number; nextB: number }

/**
 * 对齐锚点：主控侧第 line 行落在两块之间的上下文（区域 k：块 k-1 之后、块 k 之前；k = 0 为第一个块之前）中、且不是该区域的第一行时，
 * 返回区域序号与两侧对应的行（上下文两侧行数相同，按行序对应）；在块内、正好是区域第一行或超出文档时返回 null。
 */
export function contextAnchor(master: DiffSide, line: number, chunks: readonly ChunkLines[], lines: { a: number; b: number }) {
  let region = 0;
  while (region < chunks.length && line >= (master === "a" ? chunks[region].firstA : chunks[region].firstB)) region += 1;
  const previous = region > 0 ? chunks[region - 1] : null;
  const startA = previous ? previous.nextA : 1;
  const startB = previous ? previous.nextB : 1;
  const offset = line - (master === "a" ? startA : startB);
  if (offset <= 0) return null;
  const lineA = startA + offset;
  const lineB = startB + offset;
  if (lineA > lines.a || lineB > lines.b) return null;
  return { region, lineA, lineB };
}
