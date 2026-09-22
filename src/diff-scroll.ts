export type DiffSide = "a" | "b";

export interface DiffBoundaryPair {
  a: number;
  b: number;
}

export interface MappedDiffPosition {
  value: number;
  segment: number;
}

export interface ScrollThumbGeometry {
  top: number;
  height: number;
  scrollable: boolean;
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

export function scrollThumbGeometry(
  trackHeight: number,
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
  minimumThumb = 24
): ScrollThumbGeometry {
  const track = Math.max(0, trackHeight);
  const content = Math.max(0, scrollHeight);
  const viewport = Math.max(0, clientHeight);
  if (!track || content <= viewport || !content) return { top: 0, height: track, scrollable: false };
  const height = Math.min(track, Math.max(minimumThumb, track * viewport / content));
  const maximumTop = Math.max(0, track - height);
  const maximumScroll = Math.max(1, content - viewport);
  return {
    top: maximumTop * Math.min(1, Math.max(0, scrollTop / maximumScroll)),
    height,
    scrollable: true
  };
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
