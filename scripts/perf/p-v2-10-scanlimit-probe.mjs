// P-V2-10 调研：computeDiff 的 scanLimit 5000 在不同文件规模 / 改动密度下何时退化为单块，以及去掉或分级后的耗时。
// 只在 Node 中直接调用 @codemirror/merge（与 diff Worker 相同的算法；V8 版本与 WebView2 不同，只作量级参考）。
// 用法：node scripts/perf/p-v2-10-scanlimit-probe.mjs [--quick] [--methods current,tiered] [--densities lc4,shuffle] [--json out.json]
// current 为修改前的整文件字符级 diff（scanLimit 5000）；tiered 为产品实现 src/diff-core.ts 的 tieredDiff。
// 夹具写到系统临时目录，只用于 `git diff --no-index -U0` 求 Git 的块作为对照，结束时删除。
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@codemirror/state";
import { Change, Chunk, diff } from "@codemirror/merge";
// 产品实现（V2-D75）：Node 22.18 起可直接去掉类型运行 .ts
import { tieredDiff } from "../../src/diff-core.ts";

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
  } else if (density === "shuffle") {
    // 每 20 行一段，段的顺序随机打乱（行级 diff 的病态场景：几乎所有行两侧都有，但顺序不同）
    const r = rng(n + 1);
    const blocks = [];
    for (let i = 0; i < n; i += 20) blocks.push(base.slice(i, i + 20));
    for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; }
    changed.splice(0, n, ...blocks.flat());
  } else if (density === "reindent") {
    // 整文件缩进改为制表符（区间超过字符上限，走逐行回退）
    for (let i = 0; i < n; i++) changed[i] = changed[i].replace(/^ {2}/, "	");
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
const METHODS = {
  current: (l, r) => { const c = diff(l, r, { scanLimit: 5000 }); return { changes: c }; },
  none: (l, r) => { const c = diff(l, r); return { changes: c }; },
  timeout300: (l, r) => { const c = diff(l, r, { timeout: 300 }); return { changes: c }; },
  scan50k: (l, r) => { const c = diff(l, r, { scanLimit: 50000 }); return { changes: c }; },
  tiered: (l, r) => ({ changes: tieredDiff(l, r) })
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
  const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1].split(",") : null;
  const DENSITIES = arg("--densities") ?? ["ends", "every-500", "every-50", "lc4", "block-200", "every-5", "rewrite", "shuffle", "reindent"];
  const METHOD_NAMES = arg("--methods") ?? Object.keys(METHODS);
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
      const skip = (m) => (density === "rewrite" || density === "shuffle") && n > 500 && (m === "none" || m === "scan50k");
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
