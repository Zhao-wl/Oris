// P-V2-10 调研：computeDiff 的 scanLimit 5000 在不同文件规模 / 改动密度下何时退化为单块，以及去掉或分级后的耗时。
// 只在 Node 中直接调用 @codemirror/merge（与 diff Worker 相同的算法；V8 版本与 WebView2 不同，只作量级参考）。
// 用法：node scripts/perf/p-v2-10-scanlimit-probe.mjs [--quick] [--json out.json]
// 夹具写到系统临时目录，只用于 `git diff --no-index -U0` 求 Git 的块作为对照，结束时删除。
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@codemirror/state";
import { Change, Chunk, diff } from "@codemirror/merge";

const SELF = fileURLToPath(import.meta.url);

// ---------- 夹具 ----------
function baseLines(n, width) {
  // width "std"：与 v2-d58-font-equivalence.mjs 第 60 行相同（约 80 字符）；"short"：约 40 字符，使 100,000 行仍在 5 MiB 文本预算内。
  return Array.from({ length: n }, (_, i) => i % 11 === 0 ? `// block ${i}` : width === "std"
    ? `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`
    : `  const v${i} = load(${i}, ${i % 5});`);
}
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function makeCase(n, density, width) {
  const base = baseLines(n, width);
  const changed = [...base];
  if (density === "rewrite") {
    const r = rng(n);
    for (let i = 0; i < n; i++) changed[i] = `  let z${Math.floor(r() * 1e9)} = f(${Math.floor(r() * 1e6)});`;
  } else if (density === "lc4") {
    // lc4 阶段 2 原夹具（v2-d58-font-equivalence.mjs 第 66–68 行），按规模缩放位置
    for (let i = 30; i < n; i += 50) changed[i] = width === "std" ? changed[i].replace("retry", "retries").replace("await", "await  ") : changed[i].replace("load", "fetch");
    const s0 = Math.floor(n * 0.4);
    for (let i = s0; i < s0 + 60 && i < n; i += 7) changed[i] = `${changed[i]} // ${"long wrapped comment ".repeat(12)}`;
    changed.splice(Math.floor(n / 2), 0, "  // inserted block", "  const extra = true;");
  } else if (density === "block-200") {
    // 中部连续 200 行每行都有小改动（改名、重排参数一类的批量修改）
    const s0 = Math.floor(n / 2) - 100;
    for (let i = Math.max(0, s0); i < Math.min(n, s0 + 200); i++) changed[i] = changed[i].replace("load", "fetch").replace(/\d+\)/, "0)");
  } else if (density === "ends") {
    changed[5] = changed[5].replace("load", "fetch");
    changed[n - 5] = changed[n - 5].replace("load", "fetch");
  } else {
    const step = Number(density.slice(6)); // every-N
    // 与 lc4 阶段 2 夹具相同的改法：每 step 行改一个单词（retry → retries，await 后多一个空格；短行改 load → fetch）
    for (let i = 30; i < n; i += step) changed[i] = width === "std" ? changed[i].replace("retry", "retries").replace("await", "await  ") : changed[i].replace("load", "fetch");
  }
  return { left: base.join("\n") + "\n", right: changed.join("\n") + "\n" };
}

// ---------- 各方案 ----------
function chunksOf(left, right, changes) {
  return Chunk.build(Text.of(left.split("\n")), Text.of(right.split("\n")), { override: () => changes.map((c) => new Change(c.fromA, c.toA, c.fromB, c.toB)) });
}
/**
 * 分级（原型，不是产品代码）：
 * 1. 行级：每行编码为一个码点；先剔除只在一侧出现的行（与 Git xdiff 的 cleanup_records 同理，这些行必然是改动），
 *    对剩下的行做 diff（带 timeout 兜底），得到两侧相等的行对；行对之间的空隙就是改动的行区间。
 * 2. 字符级：每个改动的行区间内单独做字符级 diff（区间内仍用 scanLimit 与 timeout），区间过大时整段按行标记。
 */
function tieredDiff(left, right, { lineTimeout = 200, innerScanLimit = 5000, innerTimeout = 20, innerMaxChars = 40_000, totalInnerBudgetMs = 150 } = {}) {
  const split = (text) => { const lines = text.split("\n"); const starts = [0]; for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1); return { lines, starts }; };
  const A = split(left), B = split(right);
  const ids = new Map();
  const idOf = (line) => { let id = ids.get(line); if (id === undefined) { id = ids.size + 1; ids.set(line, id); } return id; };
  const idA = A.lines.map(idOf), idB = B.lines.map(idOf);
  const inA = new Set(idA), inB = new Set(idB);
  const keptA = [], keptB = [];
  idA.forEach((id, i) => { if (inB.has(id)) keptA.push(i); });
  idB.forEach((id, i) => { if (inA.has(id)) keptB.push(i); });
  const cp = (id) => String.fromCodePoint(id < 0xd800 ? id : id + 0x800);
  const encode = (kept, ids_) => { let enc = ""; const pos = []; for (const i of kept) { const ch = cp(ids_[i]); for (let k = 0; k < ch.length; k++) pos.push(i); enc += ch; } return { enc, pos }; };
  const EA = encode(keptA, idA), EB = encode(keptB, idB);
  // 相等行对：编码串中未被 diff 覆盖的片段
  const pairs = [];
  let pa = 0, pb = 0;
  const pushEqual = (toA) => { while (pa < toA) { const la = EA.pos[pa], lb = EB.pos[pb]; if (!pairs.length || pairs[pairs.length - 1][0] !== la) pairs.push([la, lb]); pa++; pb++; } };
  for (const c of diff(EA.enc, EB.enc, { timeout: lineTimeout })) { pushEqual(c.fromA); pa = c.toA; pb = c.toB; }
  pushEqual(EA.enc.length);
  pairs.push([A.lines.length, B.lines.length]); // 哨兵
  const offA = (line) => line >= A.lines.length ? left.length : A.starts[line];
  const offB = (line) => line >= B.lines.length ? right.length : B.starts[line];
  const out = [];
  let innerCoarse = 0, budget = totalInnerBudgetMs;
  let la = 0, lb = 0;
  for (const [ea, eb] of pairs) {
    if (ea > la || eb > lb) {
      const fA = offA(la), tA = offA(ea), fB = offB(lb), tB = offB(eb);
      if (fA === tA || fB === tB) out.push({ fromA: fA, toA: tA, fromB: fB, toB: tB });
      else if (Math.min(tA - fA, tB - fB) > innerMaxChars || budget <= 0) { out.push({ fromA: fA, toA: tA, fromB: fB, toB: tB }); innerCoarse++; }
      else {
        const t0 = performance.now();
        for (const c of diff(left.slice(fA, tA), right.slice(fB, tB), { scanLimit: innerScanLimit, timeout: Math.min(innerTimeout, budget) })) out.push({ fromA: c.fromA + fA, toA: c.toA + fA, fromB: c.fromB + fB, toB: c.toB + fB });
        budget -= performance.now() - t0;
      }
    }
    la = ea + 1; lb = eb + 1;
  }
  return { changes: out, innerCoarse };
}
const METHODS = {
  current: (l, r) => { const c = diff(l, r, { scanLimit: 5000 }); return { changes: c }; },
  none: (l, r) => { const c = diff(l, r); return { changes: c }; },
  timeout300: (l, r) => { const c = diff(l, r, { timeout: 300 }); return { changes: c }; },
  scan50k: (l, r) => { const c = diff(l, r, { scanLimit: 50000 }); return { changes: c }; },
  tiered: (l, r) => tieredDiff(l, r)
};

// ---------- Git 对照 ----------
function gitHunks(left, right) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oris-pv210-"));
  try {
    writeFileSync(path.join(dir, "a"), left); writeFileSync(path.join(dir, "b"), right);
    const res = spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "-U0", "a", "b"], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 30 });
    const hunks = [];
    for (const m of res.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const a = +m[1], b = m[2] === undefined ? 1 : +m[2], c = +m[3], d = m[4] === undefined ? 1 : +m[4];
      const os_ = b === 0 ? a : a - 1, ns = d === 0 ? c : c - 1;
      hunks.push(`${os_}:${os_ + b}:${ns}:${ns + d}`);
    }
    return hunks;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// 与 src/hunk-model.ts lineRange 相同
function lineRange(doc, from, to) {
  const start = doc.lineAt(Math.min(from, doc.length)).number - 1;
  if (to <= from) return [start, start];
  const endLine = doc.lineAt(Math.min(to, doc.length));
  return [start, to === endLine.from ? endLine.number - 1 : endLine.number];
}

// ---------- Worker：跑一个 (case, method) ----------
if (!isMainThread) {
  const { n, density, width, method, repeat } = workerData;
  const { left, right } = makeCase(n, density, width);
  const times = [];
  let result, chunks;
  const heap0 = process.memoryUsage().heapUsed;
  let heapPeak = heap0;
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    result = METHODS[method](left, right);
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    chunks = chunksOf(left, right, result.changes);
    times.push(performance.now() - t0);
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }
  const a = Text.of(left.split("\n")), b = Text.of(right.split("\n"));
  const ranges = chunks.map((ch) => { const [os_, oe] = lineRange(a, ch.fromA, Math.min(ch.toA, left.length)); const [ns, ne] = lineRange(b, ch.fromB, Math.min(ch.toB, right.length)); return `${os_}:${oe}:${ns}:${ne}`; });
  const maxChunkLines = Math.max(0, ...chunks.map((ch) => { const [s, e] = lineRange(b, ch.fromB, Math.min(ch.toB, right.length)); return e - s; }));
  const changedLinesB = chunks.reduce((sum, ch) => { const [s, e] = lineRange(b, ch.fromB, Math.min(ch.toB, right.length)); return sum + (e - s); }, 0);
  times.sort((x, y) => x - y);
  parentPort.postMessage({ changes: result.changes.length, chunks: chunks.length, innerCoarse: result.innerCoarse ?? 0, ranges, maxChunkLines, changedLinesB, medianMs: times[Math.floor(times.length / 2)], maxMs: times[times.length - 1], heapDeltaMiB: (heapPeak - heap0) / 1048576, bytes: left.length + right.length });
} else {
  const quick = process.argv.includes("--quick");
  const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
  const SIZES = quick ? [500, 3000] : [500, 1000, 3000, 10000, 100000];
  const DENSITIES = ["ends", "every-500", "every-50", "lc4", "block-200", "every-5", "rewrite"];
  const METHOD_NAMES = Object.keys(METHODS);
  const CAP_MS = 20_000;
  const runOne = (spec) => new Promise((resolve) => {
    const w = new Worker(SELF, { workerData: spec, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    const timer = setTimeout(() => { w.terminate(); resolve({ timedOut: true }); }, CAP_MS);
    w.once("message", (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.once("error", (e) => { clearTimeout(timer); resolve({ error: String(e) }); });
  });
  const rows = [];
  for (const n of SIZES) {
    const width = n >= 100000 ? "short" : "std";
    for (const density of DENSITIES) {
      if (density === "every-500" && n <= 500) continue;
      // 已知会超时的组合（500 行重写即 > 60 s）不再重复等待
      const skip = (m) => density === "rewrite" && n > 500 && (m === "none" || m === "scan50k");
      const { left, right } = makeCase(n, density, width);
      const git = gitHunks(left, right);
      const gitSet = new Set(git);
      for (const method of METHOD_NAMES) {
        if (skip(method)) { console.log(`${String(n).padStart(6)} 行 ${density.padEnd(9)} | ${method.padEnd(10)} 跳过（500 行已超时）`); continue; }
        const r = await runOne({ n, density, width, method, repeat: n >= 10000 ? 3 : 7 });
        const matched = r.ranges ? r.ranges.filter((x) => gitSet.has(x)).length : null;
        const row = { n, width, density, method, gitHunks: git.length, ...r, matched, ranges: undefined };
        rows.push(row);
        const fmt = r.timedOut ? `超时（> ${CAP_MS / 1000} s）` : r.error ? `错误 ${r.error}` : `changes ${r.changes} 块 ${r.chunks} 最大块 ${r.maxChunkLines} 行 标记行 ${r.changedLinesB}${r.innerCoarse ? ` 区间粗略 ${r.innerCoarse}` : ""} 可块操作 ${matched}/${r.chunks} 中位 ${r.medianMs.toFixed(1)} ms 最大 ${r.maxMs.toFixed(1)} ms 堆 +${r.heapDeltaMiB.toFixed(1)} MiB`;
        console.log(`${String(n).padStart(6)} 行 ${width.padEnd(5)} ${(left.length / 1024).toFixed(0).padStart(5)} KiB ${density.padEnd(9)} Git 块 ${String(git.length).padStart(5)} | ${method.padEnd(10)} ${fmt}`);
      }
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
}
