// 自动换行 + 两侧对齐的滚动对齐误差探针（长链 lc4 阶段 2）。不计时，只采集状态。
// 夹具：--fixture single（默认）与 v2-d58-font-equivalence 相同（3,000 行；diff 的 scanLimit 使它退化为 1 个大块，只能比较块的上下边界）；
//       --fixture multi：1,000 行、约 37 个块，块内有折行的长修改行与长插入行，块外也有折行的长上下文行。
// 真实错位的量法：两侧可见区域中不在改动块内（没有 oris-*-line 标记）且文字完全相同的行逐对比较屏幕顶部位置，取最大差值（夹具中每行文字唯一）；
// 另记连接带（高度表坐标）的误差，以及“窗口宽度 +1 px 再恢复”触发重新对齐之后的误差，用于判断误差是否来自滚动后没有重新对齐。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris），不调用任何窗口激活 API；滚动是直接设置 scrollTop 触发的滚动事件，按键为页面内派发的 KeyboardEvent。
// 用法：node scripts/perf/wrap-align-probe.mjs --exe <oris.exe> --label <名称> [--port 9887] [--no-realign]
//       node scripts/perf/wrap-align-probe.mjs --compare <before.json> <after.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

if (args[0] === "--compare") {
  const [a, b] = [JSON.parse(readFileSync(args[1], "utf8")), JSON.parse(readFileSync(args[2], "utf8"))];
  console.log(`| 场景 | 位置 | 修复前 DOM 误差 / 连接带 | 修复后 DOM 误差 / 连接带 |`);
  console.log(`| --- | --- | --- | --- |`);
  let worstA = 0, worstB = 0;
  for (const [i, sa] of a.samples.entries()) {
    const sb = b.samples[i];
    worstA = Math.max(worstA, sa.dom.max ?? 0); worstB = Math.max(worstB, sb?.dom.max ?? 0);
    console.log(`| ${sa.scenario} | ${sa.position} | ${sa.dom.max} / ${sa.connectorError} | ${sb?.dom.max} / ${sb?.connectorError} |`);
  }
  console.log(`\n最大 DOM 误差：修复前 ${worstA} px，修复后 ${worstB} px`);
  process.exit(0);
}

const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const label = option("label", "wrap-align-probe");
const realign = !args.includes("--no-realign");
const fixture = option("fixture", "single");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `${label}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const lines = fixture === "multi" ? 1000 : 3000;
const repo = path.join(runDir, "repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
const base = Array.from({ length: lines }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`);
if (fixture === "multi") for (let i = 45; i < lines; i += 100) base[i] = `${base[i]} // ${"context-only long ".repeat(12)}`;
writeFileSync(path.join(repo, "typical.ts"), base.join("\n") + "\n");
git(repo, ["config", "core.autocrlf", "false"]);
git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
const changed = [...base];
if (fixture === "multi") {
  for (let i = 20; i < lines; i += 50) changed[i] = `${changed[i].replace("retry", "retries")} // ${"long wrapped comment ".repeat(10)}`;
  for (let i = 60; i < lines; i += 150) changed.splice(i, 0, `  // inserted ${i} ${"wrapped insert ".repeat(15)}`);
} else {
  for (let i = 30; i < changed.length; i += 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
  for (let i = 1200; i < 1260; i += 7) changed[i] = `${changed[i]} // ${"long wrapped comment ".repeat(12)}`;
  changed.splice(Math.floor(lines / 2), 0, "  // inserted block", "  const extra = true;");
}
writeFileSync(path.join(repo, "typical.ts"), changed.join("\n") + "\n");

// 两侧可见的相同文字行逐对比较；另记连接带误差、可见的对齐间隔与最差的一对行的高度（折行）。
const STATE = String.raw`(() => {
  const round = (v) => Math.round(v * 10) / 10;
  const panes = ['left', 'right'].map((side) => document.querySelector('.oris-split-pane.' + side + ' .cm-scroller'));
  if (panes.some((p) => !p)) return null;
  const visibleLines = (sc, contextOnly = false) => { const box = sc.getBoundingClientRect(); return [...sc.querySelectorAll('.cm-content > .cm-line')].filter((el) => !contextOnly || !/\boris-\w+-line\b/.test(el.className)).map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.bottom > box.top + 1 && r.top < box.bottom - 1); };
  const [la, lb] = panes.map((p) => visibleLines(p, true));
  const byText = new Map();
  for (const item of la) { const t = item.el.textContent; byText.set(t, byText.has(t) ? null : item); }
  let max = 0, pairs = 0, worst = null;
  for (const item of lb) {
    const other = byText.get(item.el.textContent);
    if (!other) continue;
    pairs++;
    const d = Math.abs(other.r.top - item.r.top);
    if (d > max) { max = d; worst = { text: item.el.textContent.slice(0, 40), aTop: round(other.r.top), bTop: round(item.r.top), aHeight: round(other.r.height), bHeight: round(item.r.height) }; }
  }
  const paths = [...document.querySelectorAll('.diff-connectors path')];
  // 连接带实际绘制的上边与下边（paint bottom：纯插入 / 删除块在空的一侧以对齐间隔的底为下边）两侧之差；
  // 只计入落在视口内的一端（坐标相对连接带图层，0 到可视高度）：视口外的一端不会画到屏幕上。另记含视口外端点的误差。
  const visibleHeight = panes[1].clientHeight;
  const inView = (a, b) => Math.max(a, b) >= -2 && Math.min(a, b) <= visibleHeight + 2;
  const edgeError = (p, all) => {
    const top = [Number(p.dataset.aTop), Number(p.dataset.bTop)], bottom = [Number(p.dataset.aPaintBottom), Number(p.dataset.bPaintBottom)];
    return Math.max(all || inView(...top) ? Math.abs(top[0] - top[1]) : 0, all || inView(...bottom) ? Math.abs(bottom[0] - bottom[1]) : 0);
  };
  const connectorError = paths.length ? round(Math.max(...paths.map((p) => edgeError(p, false)))) : null;
  const connectorErrorAll = paths.length ? round(Math.max(...paths.map((p) => edgeError(p, true)))) : null;
  const spacers = ['left', 'right'].flatMap((side) => [...document.querySelectorAll('.oris-split-pane.' + side + ' .oris-alignment-spacer')].map((el) => ({ side, chunk: Number(el.dataset.chunkIndex), role: el.dataset.alignmentRole, height: round(Number(el.dataset.alignmentHeight)) })));
  return {
    hunks: Number(document.querySelector('.oris-split-view')?.dataset.hunkCount ?? 0),
    alignment: (({ alignmentGeneration, alignmentRefines, alignmentRefinesSkipped, alignmentAnchor, masterSide }) => ({ generation: alignmentGeneration, refines: alignmentRefines, skipped: alignmentRefinesSkipped, anchor: alignmentAnchor, master: masterSide }))(document.querySelector('.oris-split-view')?.dataset ?? {}),
    dom: { max: round(max), pairs, worst },
    connectorError,
    connectorErrorAll,
    scrollTop: panes.map((p) => round(p.scrollTop)),
    scrollHeight: panes.map((p) => p.scrollHeight),
    firstLine: panes.map((p) => (visibleLines(p)[0]?.el.textContent ?? '').slice(0, 30)),
    wrapping: !!document.querySelector('.diff-host .cm-lineWrapping'),
    aligned: document.querySelector('.oris-split-view')?.dataset.alignmentReady !== undefined,
    fontSize: getComputedStyle(document.querySelector('.cm-content')).fontSize,
    visibleSpacers: spacers.length
  };
})()`;

const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port: Number(option("port", 9887)), log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
const result = { exe: path.resolve(exe), exeSha256: sha256File(exe), fixture, startedAt: new Date().toISOString(), method: "CDP 页面事件；滚动为设置 scrollTop；每次滚动 / 字号切换后等 900 ms 并等对齐完成再读取", samples: [] };
try {
  await call("Runtime.enable");
  const WIDTH = 1440, HEIGHT = 900;
  await call("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const key = (k) => evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${q(k)}, ctrlKey: true, bubbles: true, cancelable: true }))`);
  const toggle = (label) => `[...document.querySelectorAll('.toolbar .toggle-button')].find((n) => n.textContent === ${q(label)})`;
  // 等对齐完成且稳定：完成后 500 ms 内没有开始新一轮（对齐完成后行高再被测量时会增量重新对齐）。
  const alignmentState = `(() => { const d = document.querySelector('.oris-split-view')?.dataset ?? {}; return (d.alignmentReady ?? 'true') + ':' + (d.alignmentGeneration ?? ''); })()`;
  const settle = async () => {
    await sleep(900);
    for (let i = 0; i < 20; i++) {
      await waitUntil(`(document.querySelector('.oris-split-view')?.dataset.alignmentReady ?? 'true') === 'true'`, 15000);
      const before = await evaluate(alignmentState);
      await sleep(500);
      if (await evaluate(alignmentState) === before) return;
    }
  };
  const scroll = (selector, fraction) => evaluate(`(() => { const sc = document.querySelector(${q(selector)}); sc.scrollTop = ${fraction === "bottom" ? "sc.scrollHeight" : `sc.scrollHeight * ${fraction}`}; return sc.scrollTop; })()`);
  const nudge = async () => { await call("Emulation.setDeviceMetricsOverride", { width: WIDTH + 1, height: HEIGHT, deviceScaleFactor: 1, mobile: false }); await sleep(300); await call("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }); await settle(); };
  const sample = async (scenario, position) => {
    const state = await evaluate(STATE);
    const entry = { scenario, position, ...state };
    if (realign) entry.afterRealign = await (async () => { await nudge(); const s = await evaluate(STATE); return { dom: s.dom, connectorError: s.connectorError, connectorErrorAll: s.connectorErrorAll }; })();
    result.samples.push(entry);
    log(`${scenario} @${position}：DOM ${state.dom.max} px（${state.dom.pairs} 对）连接带 ${state.connectorError} ${q(state.alignment)}${entry.afterRealign ? ` → 重新对齐后 DOM ${entry.afterRealign.dom.max} / 连接带 ${entry.afterRealign.connectorError}` : ""}`);
  };
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.readyFor('typical.ts', null) === true`, 30000);
  await sleep(1200);
  const right = ".oris-split-pane.right .cm-scroller", left = ".oris-split-pane.left .cm-scroller";
  await evaluate(`${toggle("自动换行")}.click()`); await sleep(300);
  await evaluate(`${toggle("对齐变化")}.click()`); await settle();
  const positions = [0, 0.1, 0.2, 0.3, 0.4, 0.41, 0.5, 0.6, 0.7, 0.8, 0.9, "bottom"];
  for (const [name, selector] of [["右侧主控", right], ["左侧主控", left]]) {
    await scroll(right, 0); await scroll(left, 0); await settle();
    for (const position of positions) { await scroll(selector, position); await settle(); await sample(`换行 + 对齐 · ${name}`, position); }
  }
  // 字号切换（v2-d58 的 3 条误差）：右侧滚到 41% 后 13 → 14 → 15 → 14 → 13。
  await key("0"); await settle();
  await scroll(right, 0.41); await settle();
  await sample("换行 + 对齐 · 字号 13（41%）", 0.41);
  for (const k of ["=", "=", "-", "-"]) { await key(k); await settle(); await sample(`换行 + 对齐 · 字号切换 ${k}`, 0.41); }
  await key("0");
} catch (error) {
  result.error = String(error.stack ?? error); log("失败", error);
} finally {
  try { app.cdp.close(); } catch { /* ignore */ }
  result.stop = await killOris(app);
  const file = path.join(outDir, "wrap-align.json");
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`报告：${file}${result.error ? "（有错误）" : ""}`);
  removeDir(runDir, GUI_ROOT);
  process.exitCode = result.error ? 1 : 0;
}
