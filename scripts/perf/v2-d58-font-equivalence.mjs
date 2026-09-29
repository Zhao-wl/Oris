// V2-D58：字号切换后的阅读状态对照（优化前后必须一致）。在同一夹具上依次运行多个场景，每次切换字号后记录：
// 每个可见编辑器顶部的行号与像素偏移、scrollTop、首行文本、字号；对齐误差（开启对齐时）；可见的块标题行；搜索命中与当前命中。
// 场景：并排右侧滚到 60%（右侧主控）、并排左侧滚到 30%（左侧主控）、自动换行 + 对齐变化、搜索打开、统一视图、滚到底部、顶部。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris），不调用任何窗口激活 API；按键为页面内派发的 KeyboardEvent。
// 用法：node scripts/perf/v2-d58-font-equivalence.mjs --exe <oris.exe> --label <名称> [--port 9885]
//       node scripts/perf/v2-d58-font-equivalence.mjs --compare <a.json> <b.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

if (args[0] === "--compare") {
  const [a, b] = [JSON.parse(readFileSync(args[1], "utf8")), JSON.parse(readFileSync(args[2], "utf8"))];
  const differences = [];
  let compared = 0;
  for (const [name, stepsA] of Object.entries(a.scenarios)) {
    const stepsB = b.scenarios[name];
    if (!stepsB) { differences.push(`${name}：另一份报告没有该场景`); continue; }
    stepsA.forEach((sa, i) => {
      const sb = stepsB[i];
      compared++;
      if (!sb) { differences.push(`${name} #${i}：缺少步骤`); return; }
      const where = `${name} #${i}（${sa.fontSize}）`;
      if (sa.editors.length !== sb.editors.length) differences.push(`${where}：可见编辑器数 ${sa.editors.length} ≠ ${sb.editors.length}`);
      sa.editors.forEach((ea, k) => {
        const eb = sb.editors[k] ?? {};
        for (const key of ["fontSize", "topLine", "firstText"]) if (ea[key] !== eb[key]) differences.push(`${where} 编辑器 ${k} ${key}：${ea[key]} ≠ ${eb[key]}`);
        if (Math.abs((ea.offset ?? 0) - (eb.offset ?? 0)) > 1) differences.push(`${where} 编辑器 ${k} 偏移：${ea.offset} ≠ ${eb.offset}`);
        if (Math.abs(ea.scrollTop - eb.scrollTop) > 1) differences.push(`${where} 编辑器 ${k} scrollTop：${ea.scrollTop} ≠ ${eb.scrollTop}`);
      });
      for (const key of ["hunkTitles", "searchStatus", "searchHits", "searchCurrent", "wrapping", "connectors"]) if (JSON.stringify(sa[key]) !== JSON.stringify(sb[key])) differences.push(`${where} ${key}：${JSON.stringify(sa[key])} ≠ ${JSON.stringify(sb[key])}`);
      if (sa.aligned && ((sa.alignError ?? 0) > 1.5 || (sb.alignError ?? 0) > 1.5)) differences.push(`${where} 对齐误差：${sa.alignError} / ${sb.alignError}（> 1.5 px）`);
    });
  }
  console.log(`比较 ${compared} 个状态；差异 ${differences.length}`);
  for (const d of differences) console.log(" -", d);
  process.exit(differences.length ? 1 : 0);
}

const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const label = option("label", "v2-d58-equivalence");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `${label}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

// 夹具：与 appearance-probe 相同的 3,000 行文件，另把一段改成长行（自动换行时会折成多行）。
const lines = 3000;
const repo = path.join(runDir, "repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
const base = Array.from({ length: lines }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`);
writeFileSync(path.join(repo, "typical.ts"), base.join("\n") + "\n");
git(repo, ["config", "core.autocrlf", "false"]);
git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
const changed = [...base];
for (let i = 30; i < changed.length; i += 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
for (let i = 1200; i < 1260; i += 7) changed[i] = `${changed[i]} // ${"long wrapped comment ".repeat(12)}`;
changed.splice(Math.floor(lines / 2), 0, "  // inserted block", "  const extra = true;");
writeFileSync(path.join(repo, "typical.ts"), changed.join("\n") + "\n");

const STATE = String.raw`(() => {
  const editors = [...document.querySelectorAll('.diff-host .cm-editor')].filter((ed) => ed.offsetParent !== null);
  const round = (v) => Math.round(v * 10) / 10;
  const state = editors.map((ed) => {
    const sc = ed.querySelector('.cm-scroller');
    const top = sc.getBoundingClientRect().top;
    const gutter = [...ed.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter((g) => g.textContent.trim() && g.getBoundingClientRect().height > 0);
    const first = gutter.find((g) => g.getBoundingClientRect().bottom > top + 0.5);
    const line = [...ed.querySelectorAll('.cm-content > .cm-line')].find((l) => l.getBoundingClientRect().bottom > top + 0.5);
    return { scrollTop: round(sc.scrollTop), topLine: first?.textContent ?? null, offset: first ? round(top - first.getBoundingClientRect().top) : null, firstText: (line?.textContent ?? '').slice(0, 48), fontSize: getComputedStyle(ed.querySelector('.cm-content')).fontSize };
  });
  const paths = [...document.querySelectorAll('.diff-connectors path')];
  const alignOn = document.querySelector('.oris-split-view')?.dataset.alignmentReady !== undefined;
  const err = paths.map((p) => Math.max(Math.abs(Number(p.dataset.aTop) - Number(p.dataset.bTop)), Math.abs(Number(p.dataset.aBottom) - Number(p.dataset.bBottom))));
  const visible = (el) => { const r = el.getBoundingClientRect(); const host = el.closest('.cm-scroller')?.getBoundingClientRect(); return host && r.bottom > host.top && r.top < host.bottom; };
  return {
    fontSize: state[0]?.fontSize ?? null,
    editors: state,
    wrapping: !!document.querySelector('.diff-host .cm-lineWrapping'),
    connectors: paths.length,
    aligned: !!document.querySelector('.toolbar .toggle-button.active, .toolbar .toggle-button[aria-pressed=true]') && [...document.querySelectorAll('.toolbar .toggle-button')].some((n) => n.textContent === '对齐变化' && (n.classList.contains('active') || n.getAttribute('aria-pressed') === 'true')),
    alignError: alignOn && err.length ? round(Math.max(...err)) : null,
    hunkTitles: [...document.querySelectorAll('.diff-host .hunk-title')].filter(visible).map((n) => n.querySelector('.hunk-label')?.textContent ?? n.textContent.slice(0, 30)),
    searchStatus: document.querySelector('.oris-search-panel:not([hidden]) .oris-search-status')?.textContent ?? null,
    searchHits: [...document.querySelectorAll('.oris-search-match')].filter(visible).length,
    searchCurrent: [...document.querySelectorAll('.oris-search-match.current')].filter(visible).length
  };
})()`;

const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port: Number(option("port", 9885)), log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
const result = { exe: path.resolve(exe), exeSha256: sha256File(exe), startedAt: new Date().toISOString(), method: "CDP 页面事件；每次字号切换后等 900 ms（开启对齐时再等对齐完成）后读取", scenarios: {} };
try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const key = (k, extra = {}) => evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${q(k)}, ctrlKey: true, bubbles: true, cancelable: true, ...${q(extra)} }))`);
  const toggle = (label) => `[...document.querySelectorAll('.toolbar .toggle-button')].find((n) => n.textContent === ${q(label)})`;
  // 等对齐完成且稳定：完成后 500 ms 内没有开始新一轮（对齐完成后行高再被测量时会增量重新对齐，长链 lc4 阶段 2）。
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
  /** fraction：0–1 按总高度比例；"bottom" 滚到底。 */
  const scroll = (selector, fraction) => evaluate(`(() => { const sc = document.querySelector(${q(selector)}); sc.scrollTop = ${fraction === "bottom" ? "sc.scrollHeight" : `sc.scrollHeight * ${fraction}`}; return sc.scrollTop; })()`);
  // 字号序列：13 → 14 → 15 → 14 → 13 → 12 → 13
  const sequence = ["=", "=", "-", "-", "-", "="];
  const run = async (name, prepare) => {
    await key("0"); await settle();
    await prepare();
    await settle();
    const steps = [await evaluate(STATE)];
    for (const k of sequence) { await key(k); await settle(); steps.push(await evaluate(STATE)); }
    result.scenarios[name] = steps;
    log(name, steps.map((s) => `${s.fontSize}:${s.editors.map((e) => `${e.topLine}+${e.offset}`).join("/")}`).join("  "));
  };
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.readyFor('typical.ts', null) === true`, 30000);
  await sleep(1200);
  // 块标题行：块映射在键盘聚焦 / 指针移入 diff 时读取（V2-D55）。
  await evaluate(`document.querySelector('.diff-host').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))`);
  await waitUntil(`document.querySelectorAll('.diff-host .hunk-title').length > 0`, 20000);
  await sleep(800);
  const right = ".oris-split-pane.right .cm-scroller", left = ".oris-split-pane.left .cm-scroller";
  await run("并排 · 右侧滚到 60%", () => scroll(right, 0.6));
  await run("并排 · 左侧滚到 30%", () => scroll(left, 0.3));
  await run("并排 · 右侧滚到底部", () => scroll(right, "bottom"));
  await run("并排 · 顶部", () => scroll(right, 0));
  await evaluate(`${toggle("自动换行")}.click()`); await sleep(300);
  await run("并排 · 自动换行 · 右侧滚到 41%（长行附近）", () => scroll(right, 0.41));
  await evaluate(`${toggle("自动换行")}.click()`); await sleep(300);
  await evaluate(`${toggle("对齐变化")}.click()`); await sleep(300);
  await run("并排 · 对齐变化 · 右侧滚到 60%", () => scroll(right, 0.6));
  await evaluate(`${toggle("自动换行")}.click()`); await sleep(300);
  await run("并排 · 自动换行 + 对齐变化 · 右侧滚到 41%（长行附近）", () => scroll(right, 0.41));
  await evaluate(`${toggle("对齐变化")}.click()`); await sleep(300);
  await evaluate(`${toggle("自动换行")}.click()`); await sleep(300);
  await run("并排 · 搜索 service · 右侧滚到 50%", async () => {
    await key("f");
    await waitUntil(`document.querySelector('.oris-search-panel:not([hidden])')`);
    await evaluate(`(() => { const input = document.querySelector('.oris-search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'service.load(15'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitUntil(`/^1\\/\\d+/.test(document.querySelector('.oris-search-status')?.textContent ?? '')`);
    await sleep(300);
    await scroll(right, 0.5);
  });
  await evaluate(`(() => { const input = document.querySelector('.oris-search-input'); input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(300);
  await evaluate(`window.__op.setSelect('Diff 布局', 'unified')`);
  await sleep(1200);
  await run("统一视图 · 滚到 60%", () => scroll(".diff-host .cm-scroller", 0.6));
  await evaluate(`window.__op.setSelect('Diff 布局', 'split')`);
  await sleep(1000);
  await key("0");
} catch (error) {
  result.error = String(error.stack ?? error); log("失败", error);
} finally {
  try { app.cdp.close(); } catch { /* ignore */ }
  result.stop = await killOris(app);
  const file = path.join(outDir, "equivalence.json");
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`报告：${file}${result.error ? "（有错误）" : ""}`);
  removeDir(runDir, GUI_ROOT);
  process.exitCode = result.error ? 1 : 0;
}
