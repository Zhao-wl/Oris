// 汇总一期 06 发布性能测试的原始报告（artifacts/gui-probe/perf-<运行编号>-*）为一个入库 JSON：每个场景的样本数组、P50 / P95 / 最大、
// 内存分层、进程数、负载摘要与环境。用法：node scripts/perf/aggregate-release-perf.mjs --run-id 20260926-2300 --out docs/validation/data/v1-06-performance-20260926-2300.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const runId = option("run-id");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = path.join(root, "artifacts", "gui-probe");
const out = path.resolve(root, option("out"));
const read = (dir, file) => { const p = path.join(probe, dir, file); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
const round = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);
const pct = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] : null;
/** 样本数组（{ ok, ms } 或数字）→ 统计 + 原始毫秒数组。 */
const stats = (list, filter = () => true) => {
  const ms = (list ?? []).filter(filter).map((s) => (typeof s === "number" ? s : s?.ok === false ? null : s?.ms)).filter((v) => typeof v === "number").map(round);
  const sorted = [...ms].sort((a, b) => a - b);
  return { n: (list ?? []).filter(filter).length, ok: ms.length, p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: sorted.at(-1) ?? null, samplesMs: ms };
};
const layers = (sample) => Object.fromEntries(Object.entries(sample.layers).map(([k, v]) => [k, round(v.privateWorkingSetMiB)]));
const memorySuite = (m) => m && {
  exeSha256: m.exeSha256, projects: m.projects, error: m.error ?? null,
  steadyPrivateWorkingSetMiB: Object.fromEntries(["framework", "tools", "oris", "total"].map((k) => [k, m.steadyMedian[k].privateWorkingSetMiB])),
  mixedPeakPrivateWorkingSetMiB: Object.fromEntries(["framework", "tools", "oris", "total"].map((k) => [k, Math.max(...m.samples.mixed.map((s) => s.layers[k].privateWorkingSetMiB))])),
  idle65sPrivateWorkingSetMiB: layers(m.samples.idle),
  trend: m.samples.mixed.map((s) => ({ afterOps: s.afterOps, ...layers(s) })),
  hotSwitch: stats(m.latency.hotSwitch?.samples ?? []), mixedLatency: Object.fromEntries(Object.entries(m.latency.mixed ?? {}).map(([k, v]) => [k, { p50: v.p50, p95: v.p95, max: v.max, n: v.n }]))
};
const label = (suite) => `perf-${runId}-${suite}`;
const sessionDir = new RegExp(`^perf-${runId}(-L2?|-ab\\d-[AB])?$`);
const sessions = readdirSync(probe).filter((d) => sessionDir.test(d))
  .flatMap((d) => readdirSync(path.join(probe, d)).filter((f) => f.startsWith("session-")).map((f) => ({ dir: d, ...JSON.parse(readFileSync(path.join(probe, d, f), "utf8")) })));

const data = { runId, generatedAt: new Date().toISOString(), note: "原始报告在 artifacts/gui-probe/perf-<运行编号>-*（本地，不入库）；此处为每个场景的样本数组与统计。毫秒为 CDP 页面内计时（动作 → 断言成立后的下一帧）；内存为私有工作集（MiB）。", scenarios: {}, memory: {}, processes: {}, load: {} };

const core = read(label("core"), "core.json");
if (core) {
  data.environment = { exe: core.exe, exeSha256: core.exeSha256, webView2LoaderSha256: core.webView2LoaderSha256, machine: core.machine };
  for (const [k, s] of Object.entries(core.scenarios)) if (Array.isArray(s.samples)) data.scenarios[`core.${k}`] = stats(s.samples);
  data.scenarios["core.externalChange"].note = "自动刷新只在窗口有原生前台焦点时进行；测试窗口没有真实焦点，30 次都未在 8 s 内更新（未验证）";
}
const restart = read(label("restart"), "restart.json");
if (restart) for (const k of ["windowReadyToList", "windowReadyToVerified", "coldSpawnUpperBound"]) data.scenarios[`restart.${k}`] = stats(restart.samples.map((s) => ({ ok: s.ok, ms: s[`${k}Ms`] })));
const trace = read(label("trace"), "trace.json");
if (trace) data.processes.trace = trace.actions.map((a) => ({ name: a.name, ok: a.ok, ms: round(a.ms), gitProcesses: a.gitProcesses }));
const v202 = read(label("latency-v202"), "report.json");
if (v202) for (const [k, v] of Object.entries(v202.timings)) data.scenarios[`v2-02.${k}`] = stats(v.samples);
const write = read(label("write"), "write-latency.json");
if (write) {
  for (const [k, v] of Object.entries(write.timings)) data.scenarios[`write.${k}`] = { cleanRounds: stats(v.samples, (s) => s.verdict === "ok"), allRounds: stats(v.samples) };
  data.load.writeSuite = { rounds: write.rounds.map((r) => ({ i: r.i, verdict: r.verdict, attempts: r.attempts.length })), summary: write.load };
}
const writeTrace = read(label("write-trace"), "write-latency-trace.json");
if (writeTrace) data.processes.write = Object.fromEntries(Object.entries(writeTrace.processes).map(([k, v]) => [k, { perIteration: v.counts ?? v, commands: writeTrace.commands?.[k]?.map((cmds) => { const c = {}; for (const x of cmds) c[x] = (c[x] ?? 0) + 1; return c; }) }]));
const hunk = read(label("hunk"), "report.json");
if (hunk?.perf) {
  for (const k of ["hunkStage", "hunkUnstage", "hunkDiscard"]) { const r = hunk.perf[k]?.result ?? hunk.perf[k]; if (r?.samples) { data.scenarios[`v2-05.${k}.feedback`] = stats(r.samples.map((s) => ({ ok: s.ok, ms: s.feedbackMs }))); data.scenarios[`v2-05.${k}.confirm`] = stats(r.samples.map((s) => ({ ok: s.ok, ms: s.confirmMs ?? s.ms }))); } }
  data.processes.hunk = hunk.perf.gitProcesses;
}
for (const [suite, file] of [["proc-v203", "report.json"], ["proc-v204", "report-local.json"]]) { const r = read(label(suite), file); if (r?.processes) data.processes[suite] = Object.fromEntries(Object.entries(r.processes).map(([k, v]) => [k, v.count])); }
const appearance = read(label("appearance"), "report.json");
if (appearance?.timings) for (const [k, v] of Object.entries(appearance.timings)) data.scenarios[`v2-06.${k}`] = { p50: v.p50, p95: v.p95, max: v.max, n: v.n };
const reading = read(label("reading"), "report.json");
if (reading?.perf) {
  const p = reading.perf;
  for (const k of ["cachedFile", "uncachedFile", "largeText", "largeImage"]) if (p[k]?.result) data.scenarios[`v1-05.${k}`] = stats(p[k].result.samples ?? []);
  if (p.scroll?.result) data.scenarios["v1-05.scroll"] = p.scroll.result.runs.map((r) => ({ label: r.label, frames: r.frames, durationMs: r.durationMs, p50: r.p50, p95: r.p95, max: r.max, longFrames50: r.longFrames50 }));
  if (p.appearance?.result) for (const k of ["font", "scheme", "mode"]) data.scenarios[`v1-05.appearance.${k}`] = stats(p.appearance.result[k].samples);
}
const task03 = read(label("task03"), "task03.json");
if (task03) data.scenarios["task03.mixed30"] = { ...task03.mixed30?.summary, checksPassed: Object.values(task03.checks).filter((c) => c.pass).length, checks: Object.values(task03.checks).length };
data.memory.fiveProjects = memorySuite(read(label("memory5"), "memory.json"));
data.memory.tenProjects = memorySuite(read(label("memory10"), "memory.json"));
data.memory.forcedLow = [
  ["S 会话", label("memory5-low")], ["L 会话", `perf-${runId}-L-memory5-low`], ["L2 会话", `perf-${runId}-L2-memory5-low`],
  ["A/B 1 · V2-01 构建", `perf-${runId}-ab1-A-memory5-low`], ["A/B 1 · 被测构建", `perf-${runId}-ab1-B-memory5-low-retry1`],
  ["A/B 2 · V2-01 构建", `perf-${runId}-ab2-A-memory5-low`], ["A/B 2 · 被测构建", `perf-${runId}-ab2-B-memory5-low`]
].map(([what, dir]) => ({ what, dir, ...memorySuite(read(dir, "memory.json")) }));
data.memory.gitChildren = read(label("git-children"), "git-children.json");
const large = read(`perf-${runId}-L2-large`, "large.json");
if (large) data.large = { dataset: large.dataset, oversizedBytes: large.oversized, footer: large.footer, timings: Object.fromEntries(Object.entries(large.timings).map(([k, v]) => [k, v.samples ? stats(v.samples) : v])), degrade: Object.fromEntries(Object.entries(large.degrade ?? {}).map(([k, v]) => [k, { ok: v.ok, ms: round(v.ms), text: v.text.slice(0, 240) }])), checks: large.checks, memory: large.memory.map((m) => ({ tag: m.tag, ...layers(m) })), memoryBounded: large.memoryBounded, aliveAtEnd: large.aliveAtEnd };
const gitProbe = read(`perf-${runId}-L-git-probe-L`, "git-level-probe.json");
if (gitProbe) data.large.gitLevel = { firstPass: gitProbe.firstPass, warm: Object.fromEntries(Object.entries(gitProbe.warm).map(([k, v]) => [k, { n: v.n, p50: round(v.p50Ms), p95: round(v.p95Ms), max: round(v.maxMs), samplesMs: (v.samplesMs ?? []).map(round) }])), consistency: gitProbe.consistency };
data.load.sessions = sessions.map((s) => ({ dir: s.dir, suites: s.suites.map((e) => ({ suite: e.suite, verdict: e.verdict, attempts: e.attempts.map((a) => ({ label: a.label, seconds: a.seconds, exit: a.exit, disturbed: a.disturbed, maxExternalCpu: a.maxExternalCpu, externalCpuP95: a.load?.externalCpu?.p95, top: a.load?.topExternal?.slice(0, 3) })) })) }));
writeFileSync(out, JSON.stringify(data, null, 1));
console.log(`${out}：${(Buffer.byteLength(JSON.stringify(data, null, 1)) / 1024).toFixed(0)} KiB，场景 ${Object.keys(data.scenarios).length}`);
