// 外观切换（字号 / 配色 / 主题模式）时延探针：在一个典型大小的 diff 上测量，并记录长任务与 CPU 采样，定位瓶颈。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例；按键为页面内派发的 KeyboardEvent，不是真实系统输入。
// 用法：node scripts/perf/appearance-probe.mjs --exe <oris.exe> [--label name] [--lines 3000] [--iterations 30] [--port 9861] [--profile]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git, prepareCoreRepos } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const label = option("label", "appearance-probe");
const lines = Number(option("lines", 3000));
const iterations = Number(option("iterations", 30));
const port = Number(option("port", 9861));
const profile = args.includes("--profile");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `${label}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const repo = path.join(runDir, "repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
const base = Array.from({ length: lines }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`);
writeFileSync(path.join(repo, "typical.ts"), base.join("\n") + "\n");
// --heavy：另建 3 个 80,000 行文件，测量前先各读一次（与 v1-05 性能复测的会话一致）。
const heavy = args.includes("--heavy");
const bigText = (seed) => Array.from({ length: 80000 }, (_, i) => `export const value_${seed}_${i} = compute(${i}, "${(i * 2654435761 % 1000000).toString(36)}");`);
if (heavy) for (const n of [1, 2, 3]) writeFileSync(path.join(repo, `large${n}.ts`), bigText(n).join("\n") + "\n");
git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
if (heavy) for (const n of [1, 2, 3]) { const l = bigText(n); for (let i = 50; i < l.length; i += 400) l[i] = l[i].replace("compute", "recompute"); writeFileSync(path.join(repo, `large${n}.ts`), l.join("\n") + "\n"); }
const changed = [...base];
for (let i = 30; i < changed.length; i += 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
changed.splice(Math.floor(lines / 2), 0, "  // inserted block", "  const extra = true;");
writeFileSync(path.join(repo, "typical.ts"), changed.join("\n") + "\n");

const index = JSON.parse(readFileSync(path.join(projectRoot, "src", "themes", "generated", "index.json"), "utf8"));
const schemes = ["dark-modern", "monokai"].map((id) => index.find((e) => e.id === id));
const result = { exe: path.resolve(exe), exeSha256: sha256File(exe), lines, iterations, startedAt: new Date().toISOString(), method: "CDP；字号为页面内派发 Ctrl+= / Ctrl+- 的 KeyboardEvent，到 .cm-content 计算字号改变再下一帧；配色 / 模式为点击设置窗口选项到根元素换成新方案 / 类名再下一帧" };
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
try {
  await call("Runtime.enable"); await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const measure = (action, predicate, timeout = 15000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
  await waitUntil(`document.querySelector('.project-empty')`);
  // --projects N：先添加 N 个 S 数据集项目（与 v1-05 性能复测一致），再添加被测仓库。
  const extraProjects = Number(option("projects", 0));
  if (extraProjects) {
    const repos = await prepareCoreRepos(runDir, extraProjects);
    for (const r of repos) {
      await evaluate(`window.__op.setInput('仓库路径', ${q(r.path)})`);
      await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
      await evaluate(`window.__op.button('载入/添加').click()`);
      await waitUntil(`window.__op.status().startsWith(${q(r.path)}) && window.__op.rows().length > 0 && !window.__op.loading()`, 30000);
    }
    result.extraProjects = repos.map((r) => r.path);
  }
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  if (heavy) {
    await waitUntil(`window.__op.rows().includes('large3.ts') && !window.__op.loading()`, 30000);
    for (const n of [1, 2, 3, 1, 2, 3]) { await evaluate(`window.__op.row('large${n}.ts').click()`); await waitUntil(`window.__op.readyFor('large${n}.ts', null) === true`, 60000); await sleep(300); }
    await evaluate(`window.__op.row('typical.ts').click()`);
    result.primedHeavy = "large1..3 各读两次";
  }
  await waitUntil(`window.__op.readyFor('typical.ts', null) === true`, 30000);
  await sleep(1500);
  // --scrolled：把阅读位置滚到文件中部（长时间阅读后的常见状态）。
  if (args.includes("--scrolled")) {
    await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller'); sc.scrollTop = sc.scrollHeight * 0.6; return sc.scrollTop; })()`);
    await sleep(1500);
    result.scrolled = await evaluate(`[...document.querySelectorAll('.cm-scroller')].map((n) => Math.round(n.scrollTop))`);
  }
  // --caret：在右侧编辑器可见的第一行放一个折叠选区（真实鼠标点击正文后的常见状态）。
  if (args.includes("--caret")) {
    result.caret = await evaluate(`(() => { const line = [...document.querySelectorAll('.oris-split-pane.right .cm-line')].find((n) => n.firstChild); const node = line.firstChild.nodeType === 3 ? line.firstChild : line.querySelector('*').firstChild ?? line.firstChild; getSelection().collapse(node, 0); return !!getSelection().focusNode; })()`);
    await sleep(500);
  }
  // --prime：先切到统一视图再切回并排，使复用池中留下一个已脱离页面的统一视图编辑器（与长会话一致）。
  if (args.includes("--prime")) {
    await evaluate(`window.__op.setSelect('Diff 布局', 'unified')`); await sleep(1200);
    await evaluate(`window.__op.setSelect('Diff 布局', 'split')`); await sleep(1200);
    result.primed = "unified → split";
  }
  // 长任务记录
  await evaluate(`(() => { window.__long = []; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: false }); return true; })()`);
  const withLong = async (sample) => { const t0 = await evaluate(`performance.now()`); const r = await sample(); const long = await evaluate(`window.__long.filter((e) => e.start >= ${t0}).map((e) => Math.round(e.duration))`); return { ...r, longTasks: long }; };
  const font = async (i) => withLong(() => measure(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${i % 2 === 0 ? "'='" : "'-'"}, ctrlKey: true, bubbles: true, cancelable: true }))`, `getComputedStyle(document.querySelector('.cm-content')).fontSize === ${i % 2 === 0 ? "'14px'" : "'13px'"}`));
  if (profile) {
    await call("Profiler.enable");
    await call("Profiler.setSamplingInterval", { interval: 200 });
    await call("Profiler.start");
    for (let i = 0; i < 6; i++) { await font(i); await sleep(300); }
    const { profile: cpu } = await call("Profiler.stop");
    const self = new Map();
    const byId = new Map(cpu.nodes.map((n) => [n.id, n]));
    const counts = new Map();
    for (const id of cpu.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
    const interval = (cpu.endTime - cpu.startTime) / Math.max(1, cpu.samples.length) / 1000;
    for (const [id, n] of counts) { const node = byId.get(id); const f = node.callFrame; const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber}`; self.set(key, (self.get(key) ?? 0) + n * interval); }
    result.cpuSelfMs = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, Math.round(v)]);
    writeFileSync(path.join(outDir, "font.cpuprofile"), JSON.stringify(cpu));
    log("CPU 自身时间前 15", result.cpuSelfMs.slice(0, 15));
  }
  // --trace：记录 3 次字号切换的渲染时间线（样式重算、布局、脚本），按事件汇总。
  if (args.includes("--trace")) {
    const events = [];
    app.cdp.on("Tracing.dataCollected", (params) => events.push(...params.value));
    const done = new Promise((resolve) => app.cdp.on("Tracing.tracingComplete", resolve));
    await call("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.stack,blink,v8.execute", transferMode: "ReportEvents" });
    for (let i = 0; i < 4; i++) { await font(i); await sleep(300); }
    await call("Tracing.end");
    await done;
    const totals = new Map();
    for (const e of events) {
      if (e.ph !== "X" || !e.dur) continue;
      const key = e.name;
      const t = totals.get(key) ?? { count: 0, ms: 0, max: 0, detail: null };
      t.count++; t.ms += e.dur / 1000; t.max = Math.max(t.max, e.dur / 1000);
      if (e.name === "UpdateLayoutTree" && e.args?.elementCount) t.detail = Math.max(t.detail ?? 0, e.args.elementCount);
      if (e.name === "Layout" && e.args?.beginData?.dirtyObjects) t.detail = Math.max(t.detail ?? 0, e.args.beginData.totalObjects ?? 0);
      totals.set(key, t);
    }
    result.trace = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25).map(([name, t]) => ({ name, count: t.count, ms: Math.round(t.ms), max: Math.round(t.max), detail: t.detail }));
    // 强制样式 / 布局的 JS 调用栈：按最内层两帧汇总
    const forced = new Map();
    for (const e of events) {
      if (e.ph !== "X" || (e.name !== "Layout" && e.name !== "UpdateLayoutTree")) continue;
      const stack = e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace;
      if (!stack?.length) continue;
      const key = stack.slice(0, Number(option("stack-depth", 3))).map((f) => `${f.functionName || "(anon)"}@${f.lineNumber}:${f.columnNumber}`).join(" <- ");
      const t = forced.get(key) ?? { count: 0, ms: 0 };
      t.count++; t.ms += (e.dur ?? 0) / 1000;
      forced.set(key, t);
    }
    result.forcedStacks = [...forced.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20).map(([stack, t]) => ({ stack, count: t.count, ms: Math.round(t.ms) }));
    log("强制布局调用栈（前 12）", result.forcedStacks.slice(0, 12));
  }
  const fontSamples = [];
  for (let i = 0; i < iterations; i++) { await sleep(250); fontSamples.push(await font(i)); }
  result.font = { samples: fontSamples, summary: summarize(fontSamples) };
  await evaluate(`document.querySelector('button[aria-label="设置"]').click()`);
  await waitUntil(`document.querySelector('.settings-dialog [role=option]')`);
  const schemeSamples = [];
  for (let i = 0; i < iterations; i++) {
    const entry = schemes[i % 2 ? 1 : 0];
    await sleep(250);
    schemeSamples.push(await withLong(() => measure(`[...document.querySelectorAll('[role=option]')].find((n) => n.querySelector('.scheme-name')?.textContent === ${q(entry.name)}).click()`, `document.documentElement.dataset.scheme === ${q(entry.id)}`)));
  }
  result.scheme = { samples: schemeSamples, summary: summarize(schemeSamples) };
  const modeSamples = [];
  for (let i = 0; i < iterations; i++) {
    const light = i % 2 === 0;
    await sleep(250);
    modeSamples.push(await withLong(() => measure(`[...document.querySelectorAll('.segmented button')].find((n) => n.textContent === ${light ? "'浅色'" : "'深色'"}).click()`, `document.documentElement.classList.contains(${light ? "'theme-light'" : "'theme-dark'"})`)));
  }
  result.mode = { samples: modeSamples, summary: summarize(modeSamples) };
  log("字号", result.font.summary, "配色", result.scheme.summary, "模式", result.mode.summary);
} catch (error) {
  result.error = String(error.stack ?? error);
  log("失败", error);
} finally {
  try { app.cdp.close(); } catch { /* ignore */ }
  result.stop = await killOris(app);
  writeFileSync(path.join(outDir, "appearance.json"), JSON.stringify(result, null, 2));
  removeDir(runDir, GUI_ROOT);
}
