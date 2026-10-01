// 汇总一次发布性能会话（release-perf-session.mjs 的 run-id）的各套件结果，对照预算输出 Markdown 表格与负载判定。
// 用法：node scripts/perf/summarize-release-session.mjs --run-id f4 [--l-run-id f4-L] [--ab ab-f4-ab-hunk.json] [--out <md>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const runId = option("run-id");
const lRunId = option("l-run-id", null);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = path.join(root, "artifacts", "gui-probe");
const read = (dir, file) => { const p = path.join(probe, dir, file); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
const label = (suite, id = runId) => `perf-${id}-${suite}`;
const r1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v ?? "—");
const pct = (list, q) => { const a = list.filter((x) => typeof x === "number").sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * q) - 1)] : null; };
const st = (samples, pick = (s) => (s?.ok === false ? null : s?.ms)) => { const v = (samples ?? []).map(pick).filter((x) => typeof x === "number"); return { n: v.length, p50: r1(pct(v, 0.5)), p95: r1(pct(v, 0.95)), max: r1(v.length ? Math.max(...v) : null) }; };
const fmt = (s) => (s && s.n ? `${s.p50} / ${s.p95} / ${s.max}（n = ${s.n}）` : "未测");
const rows = [];
const row = (area, scene, budget, stat, pass) => rows.push({ area, scene, budget, value: typeof stat === "string" ? stat : fmt(stat), pass: pass === null ? "—" : pass === "unverified" ? "**未验证**" : pass === "V2-D59" ? "未达标（V2-D59 已知限制，按现状登记）" : pass === true ? "达标" : "**未达标**" });
const le = (s, limit) => (s && s.n ? s.p95 <= limit : false);

// 会话负载判定
const sessions = (id) => { const dir = path.join(probe, `perf-${id}`); return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("session-")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))) : []; };
const loadRows = [];
for (const s of [...sessions(runId), ...(lRunId ? sessions(lRunId) : [])]) for (const e of s.suites) for (const a of e.attempts) loadRows.push(`| ${e.suite}${a.attempt ? `（重测 ${a.attempt}）` : ""} | ${a.seconds} s | ${r1(e.preCheck?.externalCpu?.p50)} / ${r1(e.preCheck?.externalCpu?.p95)}% | ${r1(a.load?.externalCpu?.p50)} / ${r1(a.load?.externalCpu?.p95)} / ${r1(a.load?.externalCpu?.max)}% | ${a.disturbed ? "受干扰" : "有效"} |`);

const core = read(label("core"), "core.json");
if (core) {
  const s = (k) => st(core.scenarios[k]?.samples);
  row("S 数据集", "首次打开到文件列表可交互", "P95 ≤ 1,500", s("firstOpen"), le(s("firstOpen"), 1500));
  row("S 数据集", "热项目切换", "P95 ≤ 100", s("hotSwitch"), le(s("hotSwitch"), 100));
  row("S 数据集", "后台 dirty 项目切回", "P95 ≤ 800", s("dirtySwitchBack"), le(s("dirtySwitchBack"), 800));
  row("S 数据集", "切换显示区域", "P95 ≤ 50，且不启动 Git 进程", s("scopeSwitch"), le(s("scopeSwitch"), 50));
  row("S 数据集", "已缓存文件切换", "P95 ≤ 100", s("cachedFile"), le(s("cachedFile"), 100));
  row("S 数据集", "相邻预取文件切换", "P95 ≤ 100", s("adjacentFile"), le(s("adjacentFile"), 100));
  row("S 数据集", "未缓存常用文件", "P95 ≤ 400", s("uncachedFile"), le(s("uncachedFile"), 400));
  row("S 数据集", "外部变化 → 界面更新", "P95 ≤ 1,000", "30 次都未在 8 s 内自动更新（自动刷新只在原生前台焦点下进行；AGENTS.md 不允许抢焦点）", "unverified");
  const mixed = core.scenarios.mixed200?.summary;
  row("S 数据集", "200 次混合切换（参考）", "—", mixed ? { n: mixed.n, p50: r1(mixed.p50), p95: r1(mixed.p95), max: r1(mixed.max) } : null, null);
}
const restart = read(label("restart"), "restart.json");
if (restart) {
  const s = (k) => st(restart.samples, (x) => (x.ok ? x[`${k}Ms`] : null));
  row("S 数据集", "再次打开：窗口就绪 → 显示上次快照", "P95 ≤ 300", s("windowReadyToList"), le(s("windowReadyToList"), 300));
  row("S 数据集", "再次打开：快照校验完成", "P95 ≤ 1,500", s("windowReadyToVerified"), le(s("windowReadyToVerified"), 1500));
}
const trace = read(label("trace"), "trace.json");
if (trace) {
  const zero = trace.actions.filter((a) => /热切换|切换显示区域|切换文件|静置/.test(a.name));
  const ok = zero.every((a) => a.gitProcesses === 0);
  row("S 数据集", "切换显示区域 / 热切换 / 切换文件时的 Git 进程（trace）", "0", `${zero.length} 个动作共 ${zero.reduce((n, a) => n + a.gitProcesses, 0)} 个；首次打开 ${trace.actions.filter((a) => a.name.startsWith("首次打开")).map((a) => a.gitProcesses).join(" / ")} 个；手动刷新 ${trace.actions.find((a) => a.name === "手动刷新")?.gitProcesses} 个`, ok);
}
const v202 = read(label("latency-v202"), "report.json");
if (v202) {
  const s = (k) => st(v202.timings[k]?.samples);
  row("写操作", "stage 单文件：乐观反馈", "≤ 50", s("stageOptimistic"), le(s("stageOptimistic"), 50));
  row("写操作", "stage 单文件：Git 确认", "P95 ≤ 500", s("stageConfirm"), le(s("stageConfirm"), 500));
  row("写操作", "unstage 单文件：乐观反馈", "≤ 50", s("unstageOptimistic"), le(s("unstageOptimistic"), 50));
  row("写操作", "unstage 单文件：Git 确认", "P95 ≤ 500", s("unstageConfirm"), le(s("unstageConfirm"), 500));
  row("写操作", "commit（无 hooks）到刷新", "P95 ≤ 1,000", s("commit"), le(s("commit"), 1000));
}
const write = read(label("write"), "write-latency.json");
if (write) {
  const bad = new Set(write.rounds.filter((x) => x.verdict !== "ok" || (x.attempts.at(-1)?.samples ?? 0) < 2).map((x) => x.i));
  const budgets = { "fetch": 1500, "pull（仅快进）": 1500, "merge（快进）": 1000, "push": 1500, "切换分支（20 个文件变化）": 1000, "stash push": 1000, "stash pop": 1500 };
  for (const [k, v] of Object.entries(write.timings)) { const s = st(v.samples.filter((x) => !bad.has(x.round))); row("写操作（V2-D61）", k, `P95 ≤ ${budgets[k] ?? "—"}`, s, budgets[k] ? le(s, budgets[k]) : null); }
  if (bad.size) rows.push({ area: "写操作（V2-D61）", scene: `排除的轮次（受干扰或负载采样不足）`, budget: "—", value: [...bad].join("、"), pass: "—" });
}
const hunk = read(label("hunk"), "report.json");
if (hunk?.perf) {
  for (const [k, name] of [["hunkStage", "暂存此块"], ["hunkUnstage", "取消暂存此块"], ["hunkDiscard", "丢弃此块"]]) {
    const r = hunk.perf[k]?.result ?? hunk.perf[k];
    const fb = st(r?.samples, (x) => (x.ok === false ? null : x.feedbackMs)); const cf = st(r?.samples, (x) => (x.ok === false ? null : x.confirmMs ?? x.ms));
    const failed = (r?.samples ?? []).filter((x) => x.ok === false).length;
    if (failed) rows.push({ area: "块操作（V2-D61）", scene: `${name}：未完成的样本`, budget: "0", value: `${failed} 次`, pass: "**未达标**" });
    row("块操作（V2-D61）", `${name}：乐观反馈`, "≤ 50", fb, le(fb, 50));
    row("块操作（V2-D61）", `${name}：Git 确认`, "P95 ≤ 1,000", cf, le(cf, 1000));
  }
}
const appearance = read(label("appearance"), "report.json");
if (appearance?.timings) {
  for (const [k, name] of [["switchScheme", "切换配色方案（60 行）"], ["switchMode", "切换主题模式（60 行）"], ["fontShortcut", "字号快捷键（60 行）"], ["openSettings", "打开设置到可交互"]]) { const t = appearance.timings[k]; if (t) row("外观", name, "P95 ≤ 100", `${r1(t.p50)} / ${r1(t.p95)} / ${r1(t.max)}（n = ${t.n}）`, t.p95 <= 100); }
  row("外观", "v2-06 检查", "—", `失败 ${appearance.failures?.length ?? "?"} 项`, (appearance.failures?.length ?? 1) === 0);
}
const reading = read(label("reading"), "report.json");
if (reading?.perf) {
  const p = reading.perf; const s = (o) => o?.summary ? { n: o.summary.n ?? o.samples?.length, p50: r1(o.summary.p50), p95: r1(o.summary.p95), max: r1(o.summary.max) } : null;
  row("阅读（v1-05）", "已缓存文件切换", "P95 ≤ 100", s(p.cachedFile.result), le(s(p.cachedFile.result), 100));
  row("阅读（v1-05）", "未缓存文件切换", "P95 ≤ 400", s(p.uncachedFile.result), le(s(p.uncachedFile.result), 400));
  for (const run of p.scroll.result.runs) row("阅读（v1-05）", `典型 diff 滚动 12 s：${run.name ?? ""}`, "P95 帧间隔 ≤ 33", `P95 ${r1(run.p95)}，长帧 ${run.longFrames50 ?? run.longFrames ?? "?"}`, run.p95 <= 33);
  const a = p.appearance.result;
  for (const [k, name] of [["font", "切换字号（3,000 行滚动到中部）"], ["scheme", "切换配色（同上）"], ["mode", "切换主题模式（同上）"]]) row("阅读（v1-05）", name, "P95 ≤ 100，不重建编辑器", `${fmt(s(a[k]))}；${a.notRebuilt ? "未重建" : "**重建**"}`, le(s(a[k]), 100) && a.notRebuilt);
}
for (const [suite, name] of [["memory5", "5 项目"], ["memory5-low", "5 项目（强制 Low，失焦近似）"], ["memory10", "10 项目"]]) {
  const m = read(label(suite), "memory.json");
  if (!m) continue;
  const L = (x, k) => r1(x[k].privateWorkingSetMiB);
  const steady = m.steadyMedian;
  const ext = r1(steady.framework.privateWorkingSetMiB + steady.tools.privateWorkingSetMiB);
  const peak = Object.fromEntries(["framework", "tools", "oris", "total"].map((k) => [k, Math.max(...m.samples.mixed.map((q) => q.layers[k].privateWorkingSetMiB))]));
  const idle = m.samples.idle.layers;
  if (suite === "memory5") {
    row("内存（V2-D29）", `${name} 前台稳态：外部框架与工具 / Oris 自身 / 总开销`, "≤ 200 / ≤ 15 / ≤ 210", `${ext} / ${L(steady, "oris")} / ${L(steady, "total")}`, ext <= 200 && steady.oris.privateWorkingSetMiB <= 15 && steady.total.privateWorkingSetMiB <= 210);
    row("内存（V2-D29）", "200 次混合切换峰值：外部框架与工具 / 总开销", "≤ 220 / ≤ 230", `${r1(peak.framework + peak.tools)} / ${r1(peak.total)}`, peak.framework + peak.tools <= 220 && peak.total <= 230);
    row("内存（V2-D29）", "混合后静置 65 s：总开销", "≤ 稳态的 115%", `${L(idle, "total")}（稳态的 ${Math.round(idle.total.privateWorkingSetMiB / steady.total.privateWorkingSetMiB * 1000) / 10}%）`, idle.total.privateWorkingSetMiB <= steady.total.privateWorkingSetMiB * 1.15);
  } else if (suite === "memory5-low") {
    row("内存（V2-D29 / V2-D59）", `${name}：静置 65 s 外部框架与工具 / 总开销`, "≤ 130 / ≤ 140", `${r1(idle.framework.privateWorkingSetMiB + idle.tools.privateWorkingSetMiB)} / ${L(idle, "total")}`, idle.framework.privateWorkingSetMiB + idle.tools.privateWorkingSetMiB <= 130 && idle.total.privateWorkingSetMiB <= 140);
    row("内存（V2-D29 / V2-D59）", `${name}：操作结束 3 s 外部框架与工具 / 总开销（V2-D59 已知限制）`, "≤ 130 / ≤ 140", `${ext} / ${L(steady, "total")}`, ext <= 130 && steady.total.privateWorkingSetMiB <= 140 ? true : "V2-D59");
  } else {
    const m5 = read(label("memory5"), "memory.json");
    const delta = m5 ? r1(steady.oris.privateWorkingSetMiB - m5.steadyMedian.oris.privateWorkingSetMiB) : null;
    row("内存", `${name} 稳态：Oris 自身（比 5 项目）/ 总开销`, "每项目 ≤ 2 MiB 量级", `${L(steady, "oris")}（+${delta}）/ ${L(steady, "total")}`, delta !== null && delta <= 10);
  }
}
const gc = (() => { const dir = path.join(probe, label("git-children")); if (!existsSync(dir)) return null; const f = readdirSync(dir).find((x) => x.endsWith(".json")); return f ? JSON.parse(readFileSync(path.join(dir, f), "utf8")) : null; })();
if (gc) row("资源", "常驻 Git 子进程：空闲数 / 移除项目后回收", "≤ 5 / ≤ 60 s", `${gc.idleGitChildren} / ${r1(gc.reclaimedMs / 1000)} s`, gc.verdict.idleWithin5 && gc.verdict.reclaimedWithin60s);
for (const [suite, title] of [["diff-blocks", "大文件（研究 10，30 份副本）"], ["diff-cached", "大文件（1 份副本）"]]) {
  const r = read(label(suite), "result.json");
  if (!r) continue;
  for (const [k, v] of Object.entries(r.uncached ?? {})) if (v.summary) row(title, `未缓存：${k}（${v.hunkCount} 块）`, "P95 ≤ 400", { n: v.summary.n, p50: v.summary.p50, p95: v.summary.p95, max: v.summary.max }, v.summary.p95 <= 400);
  for (const [k, v] of Object.entries(r.cached ?? {})) {
    const c = v.cachedSwitch; row(title, `已缓存：${k}`, "P95 ≤ 100", { n: c.n, p50: c.p50, p95: c.p95, max: c.max }, c.p95 <= 100);
    if (v.scroll) row(title, `滚动帧间隔 / F7 / 对齐收敛：${k}`, "—（滚动 ≤ 33）", `滚动 P95 ${r1(v.scroll.p95)}（长帧 ${v.scroll.longFrames50}）；F7 P95 ${r1(v.f7?.p95)}；对齐停下后 ${r1(v.alignedScroll?.settleMs)} ms、可见误差 ${v.alignedScroll?.maxVisibleError ?? "—"} px`, v.scroll.p95 <= 33);
  }
}
const ws = read(label("workspace"), "report.json");
if (ws?.timings?.summary) {
  const s = ws.timings.summary; const d = ws.timings.openDelta; const m = ws.memory?.steadyMedian;
  row("工作区（V2-07）", "打开工作区比普通项目首次打开增加（P95 差）", "≤ 300", `P50 差 ${d.p50}、P95 差 ${d.p95}（普通 ${s.normalOpen.p50} / ${s.normalOpen.p95}，工作区 ${s.workspaceOpen.p50} / ${s.workspaceOpen.p95}）`, d.p95 <= 300);
  row("工作区（V2-07）", "热成员切换", "P95 ≤ 100", s.hotMemberSwitch, s.hotMemberSwitch.p95 <= 100);
  row("工作区（V2-07）", "首次切到某成员", "P95 ≤ 1,500", s.firstMemberSwitch, s.firstMemberSwitch.p95 <= 1500);
  row("工作区（V2-07）", "打开仓库选择器", "P95 ≤ 100", s.pickerOpen, s.pickerOpen.p95 <= 100);
  if (m) row("工作区（V2-07）", "内存：外部框架与工具 / Oris 自身 / 总开销", "≤ 200 / ≤ 15 / ≤ 210", `${r1(m.framework.privateWorkingSetMiB + m.tools.privateWorkingSetMiB)} / ${r1(m.oris.privateWorkingSetMiB)} / ${r1(m.total.privateWorkingSetMiB)}`, m.framework.privateWorkingSetMiB + m.tools.privateWorkingSetMiB <= 200 && m.oris.privateWorkingSetMiB <= 15 && m.total.privateWorkingSetMiB <= 210);
}
for (const fixture of ["single", "multi"]) {
  const w = read(label(`wrap-align-${fixture}`), "wrap-align.json");
  if (w) row("换行 + 对齐", `wrap-align ${fixture}：两侧同文行最大错位`, "—（无预算）", `${Math.max(...w.samples.map((x) => x.dom?.max ?? 0))} px（${w.samples.length} 个状态）`, null);
}
const ai = read(label("ai-latency"), "report.json");
if (ai) {
  row("AI（无预算）", "打开 AI 入口到可输入", "—", ai.timings.openAiInput.summary, null);
  row("AI（无预算）", "计划执行：假模型回复 → 界面刷新", "—", ai.timings.planToRefresh.summary, null);
  row("AI", "v1-06-ai-acceptance 检查", "—", `${ai.checks.length - ai.failures.length}/${ai.checks.length}`, ai.failures.length === 0);
}
if (lRunId) {
  const g = read(label("git-probe-L", lRunId), "git-level-probe.json");
  if (g) row("L 数据集", "`git status --porcelain=v2`（100,000 文件）", "—（V2-D10 依据）", `${r1(g.warm.newStatusOnly.p50Ms)} / ${r1(g.warm.newStatusOnly.p95Ms)}`, null);
  const L = read(label("large", lRunId), "large.json");
  if (L) {
    for (const [k, name] of [["firstOpen", "首次打开（参考）"], ["scopeSwitch", "切换显示区域"], ["cachedFile", "已缓存文件"], ["uncachedFile", "未缓存文件"], ["projectSwitch", "小仓库 ↔ L 热切换"], ["mixed100", "100 次混合切换"]]) if (L.timings[k]?.samples) row("L 数据集", name, "—（有界、可取消、不崩溃）", st(L.timings[k].samples), null);
    row("L 数据集", "有界 / 可取消 / 不崩溃 / 内存有界", "全部满足", `失败 ${L.failures.length} 项；实例存活 ${L.aliveAtEnd}；静置 / 混合前 ${L.memoryBounded?.ratio}`, L.failures.length === 0 && L.aliveAtEnd);
  }
}
const abFile = option("ab", null);
if (abFile && existsSync(path.join(probe, abFile))) {
  const ab = JSON.parse(readFileSync(path.join(probe, abFile), "utf8"));
  const pool = { A: {}, B: {} };
  for (const r of ab.rounds) { const h = read(`${r.id}-hunk`.replace(/^/, "perf-"), "report.json"); if (!h?.perf) continue; for (const k of ["hunkStage", "hunkUnstage", "hunkDiscard"]) (pool[r.side][k] ??= []).push(...((h.perf[k]?.result ?? h.perf[k]).samples)); }
  const okMs = (x) => (x.ok === false ? null : x.confirmMs ?? x.ms);
  for (const k of ["hunkStage", "hunkUnstage", "hunkDiscard"]) { const failed = (side) => (pool[side][k] ?? []).filter((x) => x.ok === false).length; row("块操作 A/B", `${k}：Git 确认 A（ae08225）/ B（被测）；未完成 A ${failed("A")} / B ${failed("B")}`, "P95 ≤ 1,000", `${fmt(st(pool.A[k], okMs))} ／ ${fmt(st(pool.B[k], okMs))}`, le(st(pool.B[k], okMs), 1000) && failed("B") === 0); }
}

const md = [
  `## 预算与结果（run-id ${runId}${lRunId ? ` / ${lRunId}` : ""}）`, "", "单位 ms（内存 MiB），P50 / P95 / 最大。", "",
  "| 类别 | 场景 | 预算 | 实测 | 结果 |", "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.area} | ${r.scene} | ${r.budget} | ${r.value} | ${r.pass} |`),
  "", "## 负载记录", "", "| 套件 | 用时 | 开始前 60 s 外部 CPU P50 / P95 | 期间外部 CPU P50 / P95 / 最高 | 判定 |", "| --- | --- | --- | --- | --- |", ...loadRows, ""
].join("\n");
const out = option("out", null);
if (out) writeFileSync(out, md);
console.log(md);
