import { Text } from "@codemirror/state";
import { Change, Chunk, diff } from "@codemirror/merge";
import type { DiffHunk, WhitespaceMode } from "./types";

/** 行内空白（空格、制表符等，不含换行）。 */
const INLINE_WHITESPACE = /^[^\S\n]*$/u;

// 分级 diff 的预算（V2-D75，研究 10）。行级：锚点之间各段的 diff 共用一个截止时间，只是兜底，常见文件远用不到。
const LINE_TIMEOUT_MS = 200;
/** 区间内字符级 diff 的限制，与原先整文件字符级 diff 的 scanLimit 相同。 */
const REGION_SCAN_LIMIT = 5000;
const REGION_TIMEOUT_MS = 20;
/** 区间较短一侧超过该字符数时不做整区间字符级 diff（Myers 在此之上开始退化为粗匹配）。 */
const REGION_MAX_CHARS = 40_000;
/** 一次 diff 中区间字符级 diff 的总预算。 */
const REGION_BUDGET_MS = 150;

/**
 * 计算阅读用的差异。`ignore` 与 `git diff -w` 一致：两侧都只是行内空白的差异（增删或替换空格、制表符）
 * 被略去；空行的增删仍然显示（涉及换行）。计数、高亮、导航都来自同一份结果（R-DIFF）。
 * 只影响显示，不改变仓库状态。
 */
export function computeDiff(left: string, right: string, whitespace: WhitespaceMode = "keep"): { changes: DiffHunk[]; hunks: DiffHunk[]; ignoredWhitespace: number } {
  let raw = tieredDiff(left, right);
  let ignoredWhitespace = 0;
  if (whitespace === "ignore") {
    raw = raw.filter((change) => {
      const ignorable = INLINE_WHITESPACE.test(left.slice(change.fromA, change.toA)) && INLINE_WHITESPACE.test(right.slice(change.fromB, change.toB));
      if (ignorable) ignoredWhitespace += 1;
      return !ignorable;
    });
  }
  const changes = raw.map((change) => ({
    fromA: change.fromA,
    toA: change.toA,
    fromB: change.fromB,
    toB: change.toB
  }));
  const asChanges = () => changes.map((change) => new Change(change.fromA, change.toA, change.fromB, change.toB));
  const hunks = Chunk.build(Text.of(left.split("\n")), Text.of(right.split("\n")), {
    override: asChanges
  }).map((chunk) => ({
    fromA: Math.min(left.length, chunk.fromA),
    toA: Math.min(left.length, chunk.toA),
    fromB: Math.min(right.length, chunk.fromB),
    toB: Math.min(right.length, chunk.toB)
  }));
  return { changes, hunks, ignoredWhitespace };
}

/**
 * 分级 diff：先按行对齐，再只在改动的行区间内做字符级 diff。
 * 整文件字符级 diff 在首尾改动相距超过约 160,000 字符时会把整段当作一处改动（研究 10），分级后块与 Git 的 hunk 一致。
 */
export function tieredDiff(left: string, right: string): DiffHunk[] {
  if (left === right) return [];
  const [start, endA, endB] = trimCommonLines(left, right);
  const a = splitLines(left, start, endA);
  const b = splitLines(right, start, endB);
  const pairs = equalLinePairs(left, a, right, b);
  const out: DiffHunk[] = [];
  const budget = { ms: REGION_BUDGET_MS };
  let lineA = 0;
  let lineB = 0;
  for (const [pairA, pairB] of pairs) {
    if (pairA > lineA || pairB > lineB) {
      regionDiff(left, a.starts[lineA], a.starts[pairA], right, b.starts[lineB], b.starts[pairB], pairA - lineA === pairB - lineB ? [a, lineA, b, lineB, pairA - lineA] : null, budget, out);
    }
    lineA = pairA + 1;
    lineB = pairB + 1;
  }
  // 首尾相接的改动合并为一处（逐行回退会产生相邻的整行改动）
  const merged: DiffHunk[] = [];
  for (const change of out) {
    const last = merged[merged.length - 1];
    if (last && last.toA === change.fromA && last.toB === change.fromB) merged[merged.length - 1] = { ...last, toA: change.toA, toB: change.toB };
    else merged.push(change);
  }
  return merged;
}

interface Lines {
  /** 每行起点，末尾多一项为区间终点；行包含其换行符。 */
  starts: number[];
  count: number;
}

/** 去掉两侧相同的前缀行与后缀行，返回中间区间 [start, endA) / [start, endB)，边界都在行首。 */
function trimCommonLines(left: string, right: string): [number, number, number] {
  const max = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < max && left.charCodeAt(prefix) === right.charCodeAt(prefix)) prefix += 1;
  const start = prefix === 0 ? 0 : left.lastIndexOf("\n", prefix - 1) + 1;
  let suffix = 0;
  const suffixMax = max - start;
  while (suffix < suffixMax && left.charCodeAt(left.length - 1 - suffix) === right.charCodeAt(right.length - 1 - suffix)) suffix += 1;
  let endA = left.length - suffix;
  if (endA > start && left.charCodeAt(endA - 1) !== 10) {
    const next = left.indexOf("\n", endA);
    endA = next < 0 ? left.length : next + 1;
  }
  return [start, endA, endA + (right.length - left.length)];
}

function splitLines(text: string, from: number, to: number): Lines {
  const starts = [from];
  for (let pos = from; pos < to;) {
    const newline = text.indexOf("\n", pos);
    pos = newline < 0 || newline >= to ? to : newline + 1;
    starts.push(pos);
  }
  return { starts, count: starts.length - 1 };
}

/**
 * 两侧相等的行对（按行号递增），末尾追加哨兵 [a.count, b.count]。
 * 1. 只在一侧出现的行必然是改动，先剔除（与 Git xdiff 的 cleanup_records 同理）；
 * 2. 两侧各只出现一次的行作为锚点，取行号递增的最长链（patience diff），把问题切成锚点之间的小段；
 * 3. 每段剩下的行各编码为一个码点后做 diff，所有小段共用一个截止时间，超时的段整段当作改动。
 */
function equalLinePairs(left: string, a: Lines, right: string, b: Lines): Array<[number, number]> {
  const ids = new Map<string, number>();
  const idsA = new Int32Array(a.count);
  const idsB = new Int32Array(b.count);
  for (let i = 0; i < a.count; i += 1) {
    const line = left.slice(a.starts[i], a.starts[i + 1]);
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size + 1;
      ids.set(line, id);
    }
    idsA[i] = id;
  }
  const countA = new Int32Array(ids.size + 1);
  for (const id of idsA) countA[id] += 1;
  const countB = new Int32Array(ids.size + 1);
  const uniqueLineB = new Int32Array(ids.size + 1);
  for (let i = 0; i < b.count; i += 1) {
    // 右侧只查已有编号：右侧独有的行记为 0
    const id = ids.get(right.slice(b.starts[i], b.starts[i + 1])) ?? 0;
    idsB[i] = id;
    countB[id] += 1;
    uniqueLineB[id] = i;
  }
  const anchors = uniqueAnchorChain(idsA, countA, countB, uniqueLineB);
  anchors.push([a.count, b.count]);
  const pairs: Array<[number, number]> = [];
  const deadline = performance.now() + LINE_TIMEOUT_MS;
  let fromA = 0;
  let fromB = 0;
  for (const anchor of anchors) {
    segmentPairs(idsA, fromA, anchor[0], countB, idsB, fromB, anchor[1], countA, deadline, pairs);
    pairs.push(anchor);
    fromA = anchor[0] + 1;
    fromB = anchor[1] + 1;
  }
  return pairs;
}

/** 两侧各出现一次的行按左侧行号排列，取右侧行号严格递增的最长子序列。 */
function uniqueAnchorChain(idsA: Int32Array, countA: Int32Array, countB: Int32Array, uniqueLineB: Int32Array): Array<[number, number]> {
  const lineA: number[] = [];
  const lineB: number[] = [];
  idsA.forEach((id, line) => {
    if (id && countA[id] === 1 && countB[id] === 1) {
      lineA.push(line);
      lineB.push(uniqueLineB[id]);
    }
  });
  // 耐心排序求 LIS：tails[k] 为长度 k + 1 的链的末项下标
  const tails: number[] = [];
  const previous = new Int32Array(lineB.length);
  for (let i = 0; i < lineB.length; i += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lineB[tails[middle]] < lineB[i]) low = middle + 1;
      else high = middle;
    }
    previous[i] = low > 0 ? tails[low - 1] : -1;
    tails[low] = i;
  }
  const chain: Array<[number, number]> = new Array(tails.length);
  for (let k = tails.length - 1, i = tails.length ? tails[tails.length - 1] : -1; k >= 0; k -= 1, i = previous[i]) chain[k] = [lineA[i], lineB[i]];
  return chain;
}

/** 锚点之间的一段 [fromA, toA) / [fromB, toB)：剔除只在一侧出现的行后编码为码点做 diff，追加相等的行对。 */
function segmentPairs(
  idsA: Int32Array, fromA: number, toA: number, countB: Int32Array,
  idsB: Int32Array, fromB: number, toB: number, countA: Int32Array,
  deadline: number, pairs: Array<[number, number]>
) {
  const encode = (lineIds: Int32Array, from: number, to: number, other: Int32Array) => {
    const chars: string[] = [];
    const lines: number[] = [];
    for (let line = from; line < to; line += 1) {
      const id = lineIds[line];
      if (!id || !other[id]) continue;
      const char = String.fromCodePoint(id < 0xd800 ? id : id + 0x800);
      chars.push(char);
      for (let k = 0; k < char.length; k += 1) lines.push(line);
    }
    return { text: chars.join(""), lines };
  };
  const encodedA = encode(idsA, fromA, toA, countB);
  if (!encodedA.text) return;
  const encodedB = encode(idsB, fromB, toB, countA);
  if (!encodedB.text) return;
  const remaining = deadline - performance.now();
  if (remaining <= 0) return;
  let posA = 0;
  let posB = 0;
  const takeEqual = (endA: number) => {
    for (; posA < endA; posA += 1, posB += 1) {
      const lineA = encodedA.lines[posA];
      const lineB = encodedB.lines[posB];
      const last = pairs[pairs.length - 1];
      // 码点超出基本平面时一行占两个码元，diff 可能只匹配其中一个：只接受编号相同且严格递增的行对
      if (idsA[lineA] === idsB[lineB] && (!last || (lineA > last[0] && lineB > last[1]))) pairs.push([lineA, lineB]);
    }
  };
  for (const change of diff(encodedA.text, encodedB.text, { timeout: remaining })) {
    takeEqual(change.fromA);
    posA = change.toA;
    posB = change.toB;
  }
  takeEqual(encodedA.text.length);
}

/** 一个改动的行区间：优先整区间字符级 diff；区间过大或预算用完时，两侧行数相同则逐行取公共前后缀，否则整段按行标记。 */
function regionDiff(
  left: string, fromA: number, toA: number,
  right: string, fromB: number, toB: number,
  sameLineCount: [Lines, number, Lines, number, number] | null,
  budget: { ms: number },
  out: DiffHunk[]
) {
  if (fromA === toA || fromB === toB) {
    out.push({ fromA, toA, fromB, toB });
    return;
  }
  if (Math.min(toA - fromA, toB - fromB) <= REGION_MAX_CHARS && budget.ms > 0) {
    const started = performance.now();
    pushOffset(diff(left.slice(fromA, toA), right.slice(fromB, toB), { scanLimit: REGION_SCAN_LIMIT, timeout: Math.min(REGION_TIMEOUT_MS, budget.ms) }), fromA, fromB, out);
    budget.ms -= performance.now() - started;
    return;
  }
  if (sameLineCount) {
    const [a, lineA, b, lineB, count] = sameLineCount;
    for (let k = 0; k < count; k += 1) lineEdit(left, a.starts[lineA + k], a.starts[lineA + k + 1], right, b.starts[lineB + k], b.starts[lineB + k + 1], out);
    return;
  }
  out.push({ fromA, toA, fromB, toB });
}

/** 同位置的一对行只取公共前缀与后缀之间的部分（缩进、改一个词这类批量修改足够）；改动超过一半时整行标记。 */
function lineEdit(left: string, fromA: number, toA: number, right: string, fromB: number, toB: number, out: DiffHunk[]) {
  const max = Math.min(toA - fromA, toB - fromB);
  let prefix = 0;
  while (prefix < max && left.charCodeAt(fromA + prefix) === right.charCodeAt(fromB + prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && left.charCodeAt(toA - 1 - suffix) === right.charCodeAt(toB - 1 - suffix)) suffix += 1;
  // 不拆开代理对
  if (prefix > 0 && isHighSurrogate(left.charCodeAt(fromA + prefix - 1))) prefix -= 1;
  if (suffix > 0 && isLowSurrogate(left.charCodeAt(toA - suffix))) suffix -= 1;
  const changedA = toA - fromA - prefix - suffix;
  const changedB = toB - fromB - prefix - suffix;
  if (!changedA && !changedB) return;
  if (Math.max(changedA, changedB) * 2 > Math.max(toA - fromA, toB - fromB)) out.push({ fromA, toA, fromB, toB });
  else out.push({ fromA: fromA + prefix, toA: toA - suffix, fromB: fromB + prefix, toB: toB - suffix });
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function pushOffset(changes: readonly Change[], offsetA: number, offsetB: number, out: DiffHunk[]) {
  for (const change of changes) out.push({ fromA: change.fromA + offsetA, toA: change.toA + offsetA, fromB: change.fromB + offsetB, toB: change.toB + offsetB });
}
