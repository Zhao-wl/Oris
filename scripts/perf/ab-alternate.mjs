// 同机交替 A/B（长链 lc5）：按 A1 → B1 → A2 → B2 … 顺序用 release-perf-session.mjs 运行同一个套件（每轮只跑一次，不重测），
// 每轮记录负载监测摘要；结束后汇总 diff-cached 套件的已缓存切换 P50 / P95。只经会话脚本启动测试实例，不调用任何窗口激活 API。
// 用法：node scripts/perf/ab-alternate.mjs --a <A 的 oris.exe> --b <B 的 oris.exe> --run-id <编号> [--rounds 3] [--suite diff-cached]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exes = { A: option("a"), B: option("b") };
const runId = option("run-id");
const rounds = Number(option("rounds", 3));
const suite = option("suite", "diff-cached");
if (!exes.A || !exes.B || !runId) throw new Error("需要 --a、--b、--run-id");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const probeDir = path.join(projectRoot, "artifacts", "gui-probe");
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const summary = { runId, suite, exes, rounds: [] };
const pooled = { A: {}, B: {} };

for (let round = 1; round <= rounds; round++) {
  for (const side of ["A", "B"]) {
    const id = `${runId}-${side}${round}`;
    log(`开始 ${id}：${exes[side]}`);
    const r = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "perf", "release-perf-session.mjs"), "--exe", exes[side], "--run-id", id, "--suites", suite, "--retries", "0", "--pause", "5"], { cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const sessionDir = path.join(probeDir, `perf-${id}`);
    const sessionFile = existsSync(sessionDir) ? readdirSync(sessionDir).find((f) => f.startsWith("session-")) : null;
    const session = sessionFile ? JSON.parse(readFileSync(path.join(sessionDir, sessionFile), "utf8")) : null;
    const attempt = session?.suites?.[0]?.attempts?.[0];
    const result = existsSync(path.join(probeDir, `perf-${id}-${suite}`, "result.json")) ? JSON.parse(readFileSync(path.join(probeDir, `perf-${id}-${suite}`, "result.json"), "utf8")) : null;
    // 逐样本过滤：样本前后 5 s 内的负载采样外部 CPU 都 ≤ 10% 才计入“干净”统计（与“受干扰段落作废”同一口径，粒度到单次切换）。
    const load = session?.loadSamples ?? [];
    const clean = (at) => { const near = load.filter((s) => s.at >= at - 5000 && s.at <= at + 5000); return near.length > 0 && near.every((s) => s.externalCpu <= 10); };
    const stat = (list) => { const ms = list.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b); const pick = (q) => ms.length ? ms[Math.min(ms.length - 1, Math.ceil(ms.length * q) - 1)] : null; return { n: ms.length, p50: pick(0.5), p95: pick(0.95), max: ms.at(-1) ?? null }; };
    const cached = result ? Object.fromEntries(Object.entries(result.cached).map(([k, v]) => [k, { all: v.cachedSwitch, clean: v.cachedSamples ? stat(v.cachedSamples.filter((x) => clean(x.at))) : null, samples: v.cachedSamples }])) : null;
    const entry = { round, side, id, exit: r.status, exeSha256: result?.exeSha256, seconds: attempt?.seconds, disturbed: attempt?.disturbed, externalCpu: attempt?.load?.externalCpu, topExternal: attempt?.load?.topExternal?.slice(0, 5), cached, error: result?.error ?? null };
    summary.rounds.push(entry);
    log(`结束 ${id}：exit ${r.status}，外部 CPU ${JSON.stringify(entry.externalCpu)}，${JSON.stringify(Object.fromEntries(Object.entries(cached ?? {}).map(([k, v]) => [k, `全部 ${v.all.p50} / ${v.all.p95}；干净 n=${v.clean?.n} ${v.clean?.p50} / ${v.clean?.p95}`])))}`);
    for (const [k, v] of Object.entries(cached ?? {})) (pooled[side][k] ??= []).push(...(v.samples ?? []).filter((x) => clean(x.at)));
    summary.pooledClean = Object.fromEntries(["A", "B"].map((x) => [x, Object.fromEntries(Object.entries(pooled[x]).map(([k, v]) => [k, stat(v)]))]));
    writeFileSync(path.join(probeDir, `ab-${runId}.json`), JSON.stringify(summary, null, 2));
  }
}
log(`各侧合并的干净样本：${JSON.stringify(summary.pooledClean)}`);
log(`汇总：${path.join(probeDir, `ab-${runId}.json`)}`);
