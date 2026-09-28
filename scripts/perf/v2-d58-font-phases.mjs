// V2-D58：把一次字号切换拆成阶段（派发与 React 提交、CSS 变量生效、CodeMirror 重新测量、滚动 / 外缘色标、装饰、绘制）。
// 场景与 appearance-probe --scrolled 相同：3,000 行文件的并排 diff，右侧滚到 60%；字号为页面内派发的 Ctrl+= / Ctrl+-。
// 方法：CDP Tracing 记录渲染主线程事件，按每次切换的时间窗口汇总：keydown 派发、每个 rAF 回调（按注册调用栈归类）及其中的
// 强制样式 / 布局、窗口内其余样式 / 布局、绘制与合成；另用 CPU 采样按源文件 / 函数汇总自身时间。
// 压缩代码的位置用同一份源码构建的 sourcemap 映射回源文件（--maps <带 .map 的前端输出目录>，资源文件名中的内容哈希必须与被测构建一致）。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris），不调用任何窗口激活 API。
// 用法：node scripts/perf/v2-d58-font-phases.mjs --exe <oris.exe> --maps <dir> [--switches 8] [--label v2-d58-phases] [--port 9881]
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const mapsDir = option("maps");
const switches = Number(option("switches", 8));
const label = option("label", "v2-d58-phases");
const port = Number(option("port", 9881));
const lines = 3000;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `${label}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

// ---------- sourcemap ----------
const maps = new Map();
if (mapsDir) {
  const assets = path.join(mapsDir, "assets");
  for (const file of readdirSync(assets)) if (file.endsWith(".js.map")) maps.set(file.replace(/\.map$/, ""), new TraceMap(readFileSync(path.join(assets, file), "utf8")));
}
/** url + 0 起的行列 → “源文件:行 函数名”；没有 sourcemap 时原样返回。 */
function where(url, line0, col0) {
  const file = (url ?? "").split("/").pop();
  const map = maps.get(file);
  if (!map) return `${file}:${line0 + 1}:${col0 + 1}`;
  const pos = originalPositionFor(map, { line: line0 + 1, column: col0 });
  if (!pos.source) return `${file}:${line0 + 1}:${col0 + 1}`;
  const source = pos.source.replace(/^(\.\.\/)+/, "").replace(/^node_modules\//, "");
  return `${source}:${pos.line}${pos.name ? ` ${pos.name}` : ""}`;
}
const area = (text) => text.startsWith("@codemirror/view") ? "CodeMirror view" : text.startsWith("@codemirror/") ? "CodeMirror 其他" : /react-dom|scheduler|^react\//.test(text) ? "React" : text.startsWith("src/") ? text.split(":")[0] : text.startsWith("(") ? text : "其他";

// ---------- 夹具（与 appearance-probe 相同）----------
const repo = path.join(runDir, "repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
const base = Array.from({ length: lines }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`);
writeFileSync(path.join(repo, "typical.ts"), base.join("\n") + "\n");
git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
const changed = [...base];
for (let i = 30; i < changed.length; i += 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
changed.splice(Math.floor(lines / 2), 0, "  // inserted block", "  const extra = true;");
writeFileSync(path.join(repo, "typical.ts"), changed.join("\n") + "\n");

const result = { exe: path.resolve(exe), exeSha256: sha256File(exe), maps: mapsDir ?? null, switches, startedAt: new Date().toISOString(), method: "CDP Tracing（渲染主线程）+ CPU 采样；字号为页面内派发的 KeyboardEvent，窗口从派发到 .cm-content 字号改变后的下一帧再加 100 ms" };
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
try {
  await call("Runtime.enable"); await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${JSON.stringify(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.readyFor('typical.ts', null) === true`, 30000);
  await sleep(1500);
  await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller'); sc.scrollTop = sc.scrollHeight * 0.6; return sc.scrollTop; })()`);
  await sleep(1500);
  result.scrolled = await evaluate(`[...document.querySelectorAll('.cm-scroller')].map((n) => Math.round(n.scrollTop))`);
  const font = (i) => evaluate(`(async () => {
    const key = ${i % 2 === 0 ? "'='" : "'-'"}, want = ${i % 2 === 0 ? "'14px'" : "'13px'"};
    const start = performance.timeOrigin + performance.now();
    performance.mark('font-${i}-start');
    const r = await window.__op.measure(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })); }, () => getComputedStyle(document.querySelector('.cm-content')).fontSize === want, 15000);
    performance.mark('font-${i}-end');
    return { ...r, start };
  })()`, 20000);

  // ---------- Tracing ----------
  const events = [];
  app.cdp.on("Tracing.dataCollected", (params) => events.push(...params.value));
  const done = new Promise((resolve) => app.cdp.on("Tracing.tracingComplete", resolve));
  await call("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.user_timing,v8.execute", transferMode: "ReportEvents" });
  const samples = [];
  for (let i = 0; i < switches; i++) { await sleep(400); samples.push(await font(i)); }
  await sleep(300);
  await call("Tracing.end");
  await done;
  result.samples = samples.map((s) => Math.round(s.ms * 10) / 10);
  // 渲染主线程
  const threadName = events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  const marks = events.filter((e) => e.cat?.includes("blink.user_timing") && /^font-\d+-(start|end)$/.test(e.name));
  const pid = marks[0]?.pid;
  const main = threadName.find((t) => t.pid === pid)?.tid ?? marks[0]?.tid;
  const onMain = events.filter((e) => e.pid === pid && e.tid === main && e.ph === "X" && e.dur);
  const rafStacks = new Map();
  for (const e of events) if (e.name === "RequestAnimationFrame" && e.args?.data?.id !== undefined) rafStacks.set(`${e.pid}:${e.args.data.id}`, e.args.data.stackTrace ?? e.args?.beginData?.stackTrace ?? []);
  const frameText = (stack, depth = 4) => (stack ?? []).slice(0, depth).map((f) => where(f.url, f.lineNumber - 1, f.columnNumber - 1)).join(" ← ");
  const perSwitch = [];
  for (let i = 0; i < switches; i++) {
    const start = marks.find((m) => m.name === `font-${i}-start`)?.ts;
    const endMark = marks.find((m) => m.name === `font-${i}-end`)?.ts;
    if (start === undefined || endMark === undefined) continue;
    const end = endMark + 100_000;
    const inWindow = onMain.filter((e) => e.ts >= start && e.ts < end);
    const within = (outer) => inWindow.filter((e) => e !== outer && e.ts >= outer.ts && e.ts + e.dur <= outer.ts + outer.dur);
    const ms = (list) => Math.round(list.reduce((s, e) => s + e.dur, 0) / 100) / 10;
    const layoutish = (list) => list.filter((e) => e.name === "Layout" || e.name === "UpdateLayoutTree");
    const keydown = inWindow.filter((e) => e.name === "EventDispatch" && e.args?.data?.type === "keydown");
    const rafs = inWindow.filter((e) => e.name === "FireAnimationFrame").map((e) => {
      const nested = layoutish(within(e));
      return { label: frameText(rafStacks.get(`${e.pid}:${e.args?.data?.id}`)), ms: Math.round(e.dur / 100) / 10, forcedLayouts: nested.filter((n) => n.name === "Layout").length, forcedStyles: nested.filter((n) => n.name === "UpdateLayoutTree").length, forcedMs: ms(nested) };
    });
    const insideScripts = new Set([...keydown, ...inWindow.filter((e) => e.name === "FireAnimationFrame")].flatMap((e) => within(e)));
    const otherLayout = layoutish(inWindow).filter((e) => !insideScripts.has(e));
    const paintNames = ["Paint", "PrePaint", "Layerize", "UpdateLayerTree", "Commit", "CompositeLayers", "RasterTask"];
    // 逐事件明细（每次切换）：脚本回调、样式、布局、绘制的先后与规模，定位重复的强制布局。
    const detailNames = new Set(["FireAnimationFrame", "EventDispatch", "TimerFire", "Layout", "UpdateLayoutTree", "Paint", "PrePaint", "FunctionCall"]);
    const detail = inWindow.filter((e) => detailNames.has(e.name)).map((e) => ({
      at: Math.round((e.ts - start) / 100) / 10, ms: Math.round(e.dur / 100) / 10, name: e.name,
      objects: e.name === "Layout" ? `${e.args?.beginData?.dirtyObjects ?? "?"}/${e.args?.beginData?.totalObjects ?? "?"}` : e.name === "UpdateLayoutTree" ? e.args?.elementCount ?? null : undefined,
      by: frameText(e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace ?? (e.name === "FireAnimationFrame" ? rafStacks.get(`${e.pid}:${e.args?.data?.id}`) : null), 2) || undefined
    }));
    perSwitch.push({ detail,
      i, totalMs: result.samples[i],
      keydown: { ms: ms(keydown), forced: layoutish(keydown.flatMap(within)).length, forcedMs: ms(layoutish(keydown.flatMap(within))) },
      rafs,
      otherLayout: { count: otherLayout.length, ms: ms(otherLayout), stacks: otherLayout.map((e) => frameText(e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace, 3)).filter(Boolean).slice(0, 4) },
      paint: Object.fromEntries(paintNames.map((n) => [n, ms(inWindow.filter((e) => e.name === n))])),
      timers: inWindow.filter((e) => e.name === "TimerFire").map((e) => ({ ms: Math.round(e.dur / 100) / 10 }))
    });
  }
  result.perSwitch = perSwitch;
  // 按 rAF 回调归类取平均
  const byLabel = new Map();
  for (const s of perSwitch) for (const r of s.rafs) { const t = byLabel.get(r.label) ?? { count: 0, ms: 0, forcedLayouts: 0, forcedStyles: 0, forcedMs: 0 }; t.count++; t.ms += r.ms; t.forcedLayouts += r.forcedLayouts; t.forcedStyles += r.forcedStyles; t.forcedMs += r.forcedMs; byLabel.set(r.label, t); }
  const n = perSwitch.length || 1;
  result.rafSummary = [...byLabel.entries()].sort((a, b) => b[1].ms - a[1].ms).map(([labelText, t]) => ({ label: labelText, perSwitch: Math.round(t.count / n * 10) / 10, msPerSwitch: Math.round(t.ms / n * 10) / 10, forcedLayoutsPerSwitch: Math.round(t.forcedLayouts / n * 10) / 10, forcedStylesPerSwitch: Math.round(t.forcedStyles / n * 10) / 10, forcedMsPerSwitch: Math.round(t.forcedMs / n * 10) / 10 }));
  const avg = (f) => Math.round(perSwitch.reduce((s, x) => s + f(x), 0) / n * 10) / 10;
  result.phaseAverages = {
    keydownMs: avg((s) => s.keydown.ms), keydownForcedMs: avg((s) => s.keydown.forcedMs),
    rafMs: avg((s) => s.rafs.reduce((a, r) => a + r.ms, 0)), rafForcedMs: avg((s) => s.rafs.reduce((a, r) => a + r.forcedMs, 0)),
    otherLayoutMs: avg((s) => s.otherLayout.ms), paintMs: avg((s) => Object.values(s.paint).reduce((a, b) => a + b, 0)), totalMs: avg((s) => s.totalMs)
  };
  log("阶段平均", result.phaseAverages);
  log("rAF 回调", result.rafSummary.slice(0, 8));

  // ---------- CPU 采样 ----------
  await call("Profiler.enable");
  await call("Profiler.setSamplingInterval", { interval: 100 });
  await call("Profiler.start");
  for (let i = 0; i < switches; i++) { await sleep(400); await font(i); }
  const { profile: cpu } = await call("Profiler.stop");
  const byId = new Map(cpu.nodes.map((node) => [node.id, node]));
  const counts = new Map();
  for (const id of cpu.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
  const interval = (cpu.endTime - cpu.startTime) / Math.max(1, cpu.samples.length) / 1000;
  const fn = new Map(), areas = new Map();
  for (const [id, c] of counts) {
    const f = byId.get(id).callFrame;
    const text = f.url ? where(f.url, f.lineNumber, f.columnNumber) : `(${f.functionName || "native"})`;
    const key = f.url ? `${text}${f.functionName ? ` [${f.functionName}]` : ""}` : text;
    fn.set(key, (fn.get(key) ?? 0) + c * interval);
    const a = area(text);
    areas.set(a, (areas.get(a) ?? 0) + c * interval);
  }
  result.cpu = {
    note: `${switches} 次切换及其间 400 ms 静置的全部采样（含空闲）；每次切换平均`,
    areasMsPerSwitch: [...areas.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / switches * 10) / 10]),
    topSelfMsPerSwitch: [...fn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(v / switches * 10) / 10])
  };
  log("CPU 区域（每次）", result.cpu.areasMsPerSwitch.slice(0, 8));
  log("CPU 函数（每次）", result.cpu.topSelfMsPerSwitch.slice(0, 12));
  result.summary = summarize(samples);
} catch (error) {
  result.error = String(error.stack ?? error);
  log("失败", error);
} finally {
  try { app.cdp.close(); } catch { /* ignore */ }
  result.stop = await killOris(app);
  writeFileSync(path.join(outDir, "font-phases.json"), JSON.stringify(result, null, 2));
  log(`报告：${path.join(outDir, "font-phases.json")}`);
  removeDir(runDir, GUI_ROOT);
  if (!existsSync(outDir)) process.exitCode = 1;
}
