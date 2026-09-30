// V2-D75 GUI 测量：分级 diff 让改动分散的大文件从 1 块变成几十到上千块，测量块数变多后的阅读器代价。
// 场景：3,000 行 lc4 夹具（65 块）、3,000 行每 5 行（540 块）、3,000 行整文件缩进（273 块）、10,000 行每 50 行（182 块）、10,000 行每 5 行（1,813 块）。
// 每个场景 R 份内容不同的副本，互相之间隔 2 个小文件（预取只取上下相邻各 1 个），逐个点击测“未缓存文件切换”；
// 再在第一份副本上测已缓存切换、开启“对齐变化”（含对齐时滚动与可见边界误差）、F7 导航、滚轮滚动帧间隔、块操作按钮（块映射是否对得上）、切到统一视图与进程树内存。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris / killOris），不调用任何窗口激活 API；按键为页面内派发的 KeyboardEvent，滚轮为 CDP 输入事件。
// 用法：node scripts/perf/p-v2-10-gui.mjs --exe <oris.exe> --label <名称> [--port 9887] [--copies 6] [--cached 5] [--profile <场景>]
// --profile：在该场景的已缓存切换期间录制 CPU 剖析，输出自身耗时最高的函数（位置为打包产物中的行:列）。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, percentile, processTree, removeDir, round, sha256File, sleep, summarize } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const label = option("label", "p-v2-10-gui");
const copies = Number(option("copies", 6));
// 已缓存切换每场景的次数（研究 10 为 5 次；发布性能会话用 30 次）。
const cachedN = Number(option("cached", 5));
const profileScenario = option("profile", null);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `${label}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

// ---------- 夹具（与 p-v2-10-scanlimit-probe.mjs 相同的生成方式） ----------
const baseLines = (n, copy) => [`// copy ${copy}`, ...Array.from({ length: n }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`)];
function makeCase(n, kind, copy) {
  const base = baseLines(n, copy);
  const changed = [...base];
  if (kind === "lc4") {
    for (let i = 31; i < changed.length; i += 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
    const s0 = Math.floor(n * 0.4);
    for (let i = s0; i < s0 + 60; i += 7) changed[i] = `${changed[i]} // ${"long wrapped comment ".repeat(12)}`;
    changed.splice(Math.floor(n / 2), 0, "  // inserted block", "  const extra = true;");
  } else if (kind === "reindent") {
    for (let i = 1; i < changed.length; i++) changed[i] = changed[i].replace(/^ {2}/, "\t");
  } else {
    const step = Number(kind.slice(6));
    for (let i = 31; i < changed.length; i += step) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
  }
  return { left: base.join("\n") + "\n", right: changed.join("\n") + "\n" };
}
const SCENARIOS = [
  { key: "lc4-3000", n: 3000, kind: "lc4" },
  { key: "every5-3000", n: 3000, kind: "every-5" },
  { key: "reindent-3000", n: 3000, kind: "reindent" },
  { key: "every50-10000", n: 10000, kind: "every-50" },
  { key: "every5-10000", n: 10000, kind: "every-5" }
];
const repo = path.join(runDir, "repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "core.autocrlf", "false"]);
const targets = [];
let index = 0;
const name = (suffix) => `${String(index++).padStart(3, "0")}-${suffix}.ts`;
const right = new Map();
for (let copy = 0; copy < copies; copy++) {
  for (const s of SCENARIOS) {
    const file = name(`${s.key}-${copy}`);
    const { left, right: after } = makeCase(s.n, s.kind, copy);
    writeFileSync(path.join(repo, file), left);
    right.set(file, after);
    targets.push({ file, scenario: s.key, copy });
    for (let f = 0; f < 2; f++) { const filler = name("filler"); writeFileSync(path.join(repo, filler), `export const x = ${index};\n`); right.set(filler, `export const x = ${index + 1};\n`); }
  }
}
git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
for (const [file, content] of right) writeFileSync(path.join(repo, file), content);

const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port: Number(option("port", 9887)), log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
// 实例被外部结束时 CDP 连接断开，未完成的 evaluate 永远不会返回：记录并清理后以失败退出
let closing = false;
app.cdp.socket.addEventListener("close", () => {
  if (closing) return;
  log("CDP 连接意外断开（测试实例已退出？），清理后退出");
  removeDir(runDir, GUI_ROOT);
  process.exit(1);
});
const result = { exe: path.resolve(exe), exeSha256: sha256File(exe), startedAt: new Date().toISOString(), copies, method: "CDP 页面内测量：动作 → 断言首次成立 → 下一帧；滚轮为 CDP Input.dispatchMouseEvent；不调用窗口激活 API", uncached: {}, cached: {} };
try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const measure = (action, predicate, timeout = 20000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const rendered = (file) => `window.__op.readyFor(${q(file)}, null) === true && document.querySelector('[data-hunk-count]') && /^\\d+ \\/ [1-9]/.test(document.querySelector('.diff-position')?.textContent ?? '')`;
  const readState = () => evaluate(`({ hunkCount: Number(document.querySelector('[data-hunk-count]')?.dataset.hunkCount ?? -1), position: document.querySelector('.diff-position')?.textContent ?? null, worker: Number((document.querySelector('.tabbar')?.textContent.match(/Worker ([\\d.]+) ms/) ?? [])[1] ?? NaN) })`);
  const toggle = (text) => `[...document.querySelectorAll('.toolbar .toggle-button')].find((n) => n.textContent === ${q(text)})`;

  /** 右侧滚轮滚动 ms 毫秒（到底后反向），返回 rAF 帧间隔统计。 */
  const wheelScroll = async (ms) => {
    const box = await evaluate(`(() => { const b = document.querySelector('.oris-split-pane.right .cm-scroller').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller'); sc.scrollTop = 0; window.__frames = []; window.__scrolling = true; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__scrolling) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
    const until = Date.now() + ms;
    let direction = 1;
    while (Date.now() < until) {
      await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 120 * direction });
      const atEnd = await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller'); return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 ? 1 : sc.scrollTop <= 0 ? -1 : 0; })()`);
      if (atEnd === 1) direction = -1; else if (atEnd === -1 && direction === -1) direction = 1;
      await sleep(16);
    }
    const frames = await evaluate(`(() => { window.__scrolling = false; return window.__frames.slice(2); })()`);
    return { frames: frames.length, p50: round(percentile(frames, 0.5)), p95: round(percentile(frames, 0.95)), max: round(Math.max(...frames)), longFrames50: frames.filter((f) => f > 50).length };
  };

  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.rows().length === ${right.size} && !window.__op.loading()`, 60000);
  await sleep(1500);

  // 1. 未缓存文件切换
  for (const t of targets) {
    const r = await measure(`window.__op.row(${q(t.file)}).click()`, rendered(t.file), 30000);
    const state = await readState();
    (result.uncached[t.scenario] ??= []).push({ copy: t.copy, ...r, ...state });
    log("未缓存", t.file, r.ok ? `${r.ms.toFixed(1)} ms` : r.error, `块 ${state.hunkCount}`, `Worker ${state.worker} ms`);
    await sleep(700);
  }
  for (const [key, samples] of Object.entries(result.uncached)) result.uncached[key] = { summary: summarize(samples), workerP50: round(percentile(samples.map((s) => s.worker), 0.5)), hunkCount: samples[0]?.hunkCount, samples };

  // 2. 第一份副本上的已缓存切换与交互
  for (const s of SCENARIOS) {
    const file = targets.find((t) => t.scenario === s.key && t.copy === 0).file;
    const entry = {};
    const cached = [];
    const profiling = profileScenario === s.key;
    if (profiling) { await call("Profiler.enable"); await call("Profiler.setSamplingInterval", { interval: 200 }); await call("Profiler.start"); }
    for (let i = 0; i < cachedN; i++) {
      const other = targets.find((t) => t.scenario !== s.key && t.copy === 0).file;
      await measure(`window.__op.row(${q(other)}).click()`, rendered(other), 30000); await sleep(400);
      cached.push(await measure(`window.__op.row(${q(file)}).click()`, rendered(file), 30000)); await sleep(400);
    }
    entry.cachedSwitch = summarize(cached);
    if (profiling) {
      const { profile } = await call("Profiler.stop");
      const byId = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
      const self = new Map();
      profile.samples.forEach((id, i) => { const f = byId.get(id); const key = `${f.functionName || "(anon)"} ${path.basename(f.url)}:${f.lineNumber + 1}:${f.columnNumber}`; self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
      entry.profileTop = [...self].filter(([key]) => !key.startsWith("(idle)")).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([key, us]) => `${(us / 1000).toFixed(1)} ms ${key}`);
      writeFileSync(path.join(outDir, `${s.key}.cpuprofile`), JSON.stringify(profile));
    }
    await sleep(800);
    // 开启对齐变化：点击到 alignmentReady === 'true'
    const align = await measure(`${toggle("对齐变化")}.click()`, `document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'`, 30000);
    entry.alignOn = { ok: align.ok, ms: round(align.ms), error: align.error };
    await sleep(600);
    entry.alignedHunkCount = (await readState()).hunkCount;
    // 开启对齐时滚动 4 s，停下后等对齐完成，记录最大边界误差（连接带两侧上下边之差）
    entry.alignedScroll = await wheelScroll(4000);
    const settledAlign = await measure(``, `document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'`, 30000);
    await sleep(1500);
    entry.alignedScroll.settleMs = round(settledAlign.ms);
    entry.alignedScroll.maxVisibleError = await evaluate(`(() => { const e = [...document.querySelectorAll('.diff-connectors path')].map((p) => Math.max(Math.abs(Number(p.dataset.aTop) - Number(p.dataset.bTop)), Math.abs(Number(p.dataset.aBottom) - Number(p.dataset.bBottom)))); return e.length ? Math.round(Math.max(...e) * 10) / 10 : null; })()`);
    await evaluate(`${toggle("对齐变化")}.click()`); await sleep(800);
    // F7 导航 10 次
    await evaluate(`document.querySelector('.oris-split-pane.right .cm-content')?.focus()`);
    const nav = [];
    // 只有 1 块时 F7 不会改变位置，跳过
    const total = Number(((await readState()).position ?? "0 / 0").split("/")[1]);
    for (let i = 0; i < (total > 1 ? 10 : 0); i++) {
      const before = await evaluate(`document.querySelector('.diff-position')?.textContent`);
      nav.push(await measure(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', bubbles: true, cancelable: true }))`, `document.querySelector('.diff-position')?.textContent !== ${q(before)}`, 10000));
      await sleep(150);
    }
    entry.f7 = summarize(nav);
    entry.positionAfterF7 = (await readState()).position;
    // 滚轮滚动 6 s，rAF 帧间隔
    entry.scroll = await wheelScroll(6000);
    // 块操作按钮：块映射在键盘聚焦 / 指针移入 diff 时读取（V2-D55）
    await evaluate(`document.querySelector('.oris-split-pane.right .cm-scroller').scrollTop = 0`);
    await evaluate(`document.querySelector('.diff-host').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))`);
    const titles = await measure(``, `document.querySelectorAll('.diff-host .hunk-title.ready, .diff-host .hunk-title.unmatched').length > 0`, 20000);
    await sleep(500);
    entry.hunkTitles = { ok: titles.ok, ...(await evaluate(`({ ready: document.querySelectorAll('.diff-host .hunk-title.ready').length, unmatched: document.querySelectorAll('.diff-host .hunk-title.unmatched').length, pending: document.querySelectorAll('.diff-host .hunk-title.pending').length })`)) };
    // 统一视图：切换布局到正文与块计数就绪
    const unified = await measure(`window.__op.setSelect('Diff 布局', 'unified')`, `!document.querySelector('.oris-split-view') && document.querySelector('.diff-host .cm-editor') && !(document.querySelector('.diff-position')?.textContent ?? '0 / 0').endsWith('/ 0')`, 30000);
    entry.unifiedSwitch = { ok: unified.ok, ms: round(unified.ms), error: unified.error, position: (await readState()).position };
    await sleep(800);
    await measure(`window.__op.setSelect('Diff 布局', 'split')`, `document.querySelector('.oris-split-view') && !(document.querySelector('.diff-position')?.textContent ?? '0 / 0').endsWith('/ 0')`, 30000);
    await sleep(600);
    // 先强制 GC 再取值：私有内存受回收时机影响很大
    await call("HeapProfiler.collectGarbage"); await sleep(1500);
    const heap = await call("Runtime.getHeapUsage");
    entry.memory = { privateMiB: processTree(app.pid).privateMiB, pageJsHeapUsedMiB: round(heap.usedSize / 1048576), pageJsHeapTotalMiB: round(heap.totalSize / 1048576) };
    result.cached[s.key] = entry;
    log("交互", s.key, JSON.stringify(entry));
  }
} catch (error) {
  result.error = String(error.stack ?? error); log("失败", error);
} finally {
  closing = true;
  try { app.cdp.close(); } catch { /* ignore */ }
  result.stop = await killOris(app);
  const file = path.join(outDir, "result.json");
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`报告：${file}${result.error ? "（有错误）" : ""}`);
  removeDir(runDir, GUI_ROOT);
  process.exitCode = result.error ? 1 : 0;
}
