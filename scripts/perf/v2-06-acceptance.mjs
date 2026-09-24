// V2-06 界面验收（B19–B22 与 §3 配色 / 设置时延）。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 鼠标 / 键盘为 CDP 注入的页面事件，“跟随系统”为 CDP 媒体特性模拟，都不是真实系统焦点或真实系统主题切换。
// 用法：node scripts/perf/v2-06-acceptance.mjs --exe <oris.exe> [--port 9771]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, encodePng, killOris, launchOris, removeDir, sleep, summarize } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
let port = Number(option("port", 9771));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", "v2-06-acceptance");
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v2-06-acceptance-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const schemeDir = path.join(projectRoot, "src", "themes", "generated");
const schemeIndex = JSON.parse(readFileSync(path.join(schemeDir, "index.json"), "utf8"));
const loadSchemeData = (id) => JSON.parse(readFileSync(path.join(schemeDir, `${id}.json`), "utf8"));

// ---------- 夹具：一个 TS 文件（修改 / 新增 / 删除 / 词级 / 语法）与一张图片 ----------
const repo = path.join(runDir, "repo");
mkdirSync(path.join(repo, "src"), { recursive: true });
mkdirSync(path.join(repo, "img"), { recursive: true });
const base = Array.from({ length: 60 }, (_, i) => i === 4 ? `export const value = computeValue("alpha", ${i});` : i % 7 === 0 ? `// section ${i}: value handling` : `function step${i}(value: number) { return value + ${i}; }`);
writeFileSync(path.join(repo, "src", "app.ts"), base.join("\n") + "\n");
const png = (r, g, b) => encodePng(48, 32, (x, y) => [((x >> 3) + (y >> 3)) % 2 ? r : 255 - r, g, b, 255]);
writeFileSync(path.join(repo, "img", "logo.png"), png(40, 120, 200));
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "base"]);
const changed = [...base];
changed[4] = `export const value = computeValue("beta", 4);`;
changed.splice(10, 3);
changed.splice(20, 0, `const added = value * 2; // new line`, `export function addedHelper(value: number) { return value - 1; }`);
writeFileSync(path.join(repo, "src", "app.ts"), changed.join("\n") + "\n");
writeFileSync(path.join(repo, "img", "logo.png"), png(200, 60, 40));

const report = { exe, method: "CDP 页面事件与媒体特性模拟；不是真实系统焦点 / 真实系统主题切换", checks: {}, timings: {}, schemes: [], failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (!ok) fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail)}`); };

async function start(profile) {
  const app = await launchOris({ exe, profileDir: path.join(runDir, profile), port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, `${profile}-cache`) } });
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const measure = (action, predicate, timeout = 10000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
  const click = (expr) => evaluate(`(() => { const n = ${expr}; if (!n) throw new Error('找不到元素：' + ${q(expr)}); n.click(); return true; })()`);
  const shot = async (name) => {
    await sleep(250);
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    const file = path.join(shotDir, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  };
  // 键盘事件派发给当前焦点元素（与真实按键的 target 一致）；没有焦点时为 body。
  const key = (k, mods = {}) => evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${q(k)}, ctrlKey: ${!!mods.ctrl}, bubbles: true, cancelable: true }))`);
  return { app, call, evaluate, waitUntil, measure, click, shot, key };
}
async function stop(s) { try { s.app.cdp.close(); } catch { /* 已关闭 */ } const r = await killOris(s.app); log(`实例 ${s.app.pid} 已结束：${r.how}`); return r; }

const SETTINGS_BUTTON = `document.querySelector('button[aria-label="设置"]')`;
const CLOSE_SETTINGS = `document.querySelector('button[aria-label="关闭设置"]')`;
const optionFor = (id) => { const name = schemeIndex.find((s) => s.id === id).name; return `[...document.querySelectorAll('[role=option]')].find((n) => n.querySelector('.scheme-name')?.textContent === ${q(name)})`; };
const modeButton = (label) => `[...document.querySelectorAll('.segmented button')].find((n) => n.textContent === ${q(label)})`;
const isDark = (type) => type === "dark" || type === "hcDark";

let s = await start("profile");
try {
  const { evaluate, waitUntil, measure, click, shot, key, call } = s;
  await waitUntil(`document.querySelector('.project-empty')`);
  // 启动后只加载当前方案（默认 Oris 深色）的数据
  report.checks.startupSchemeChunks = await evaluate(`performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()).filter((n) => ${q(schemeIndex.map((x) => x.id))}.some((id) => n.startsWith(id + '-')))`);
  check("B19 旧入口已移除", await evaluate(`!document.querySelector('[aria-label="切换主题"]') && !document.querySelector('.font-control') && ![...document.querySelectorAll('summary')].some((n) => n.textContent.includes('Git 设置'))`));

  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await click(`window.__op.button('载入/添加')`);
  await waitUntil(`window.__op.rows().length === 2 && !window.__op.loading()`);
  await click(`window.__op.row('src/app.ts')`);
  await waitUntil(`window.__op.readyFor('src/app.ts', 'addedHelper') === true`);
  await sleep(500);

  // 阅读状态：滚动、选中一个词（CDP 鼠标双击）、打开搜索
  await evaluate(`(() => { document.querySelectorAll('.cm-editor').forEach((n, i) => { n.__orisMark = 'editor-' + i; }); const sc = document.querySelectorAll('.cm-scroller'); sc.forEach((n) => { n.scrollTop = 60; }); return sc.length; })()`);
  await sleep(300);
  const point = await evaluate(`(() => { const pane = document.querySelector('.oris-split-pane.right .cm-scroller') ?? [...document.querySelectorAll('.cm-scroller')].pop(); const box = pane.getBoundingClientRect(); const lines = [...pane.querySelectorAll('.cm-line')]; for (const line of lines) { const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let t; while ((t = walker.nextNode())) { const i = t.data.indexOf('value'); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 5); const b = r.getBoundingClientRect(); if (b.width > 0 && b.top > box.top + 4 && b.bottom < box.bottom - 4 && b.left > box.left && b.right < box.right) return { x1: b.left + 0.5, x2: b.right - 0.5, y: b.top + b.height / 2 }; } } } return null; })()`);
  if (point) {
    // CDP 注入的拖选（与任务 01 选区检查相同的方式）
    await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x1, y: point.y });
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: point.x2, y: point.y });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x2, y: point.y });
  }
  report.checks.selectionPoint = point;
  await sleep(300);
  await key("f", { ctrl: true });
  await sleep(400);
  const readingState = () => evaluate(`(() => ({ marks: [...document.querySelectorAll('.cm-editor')].map((n) => n.__orisMark ?? null), scroll: [...document.querySelectorAll('.cm-scroller')].map((n) => Math.round(n.scrollTop)), selection: getSelection().toString(), searchVisible: !!document.querySelector('.oris-search-panel:not([hidden])'), query: document.querySelector('.oris-search-input')?.value ?? null, hits: document.querySelectorAll('.oris-search-match').length, sameWord: document.querySelectorAll('.oris-selection-match').length }))()`);
  const before = await readingState();
  report.checks.readingStateBefore = before;
  check("阅读状态已建立（选中词、搜索命中、同词匹配）", before.selection === "value" && before.searchVisible && before.hits > 0, before);

  // ---------- B21 / B22：21 套方案逐套切换与截图 ----------
  const openTimes = [], switchTimes = [], modeTimes = [];
  let currentMode = "dark";
  for (const entry of schemeIndex) {
    const data = loadSchemeData(entry.id);
    const open = await measure(`${SETTINGS_BUTTON}.click()`, `document.querySelector('.settings-dialog [role=option]')`);
    openTimes.push(open);
    const wantMode = isDark(entry.type) ? "dark" : "light";
    if (wantMode !== currentMode) {
      // 模式切换：到根元素换成该模式当前方案并下一帧
      modeTimes.push(await measure(`${modeButton(wantMode === "dark" ? "深色" : "浅色")}.click()`, `document.documentElement.classList.contains(${q(wantMode === "dark" ? "theme-dark" : "theme-light")})`));
      currentMode = wantMode;
    }
    const sw = await measure(`${optionFor(entry.id)}.click()`, `document.documentElement.dataset.scheme === ${q(entry.id)}`);
    switchTimes.push({ id: entry.id, ...sw });
    await sleep(150);
    const dialogShot = await shot(`${entry.id}-settings`);
    await click(CLOSE_SETTINGS);
    await waitUntil(`!document.querySelector('.settings-dialog')`);
    await sleep(200);
    const applied = await evaluate(`(() => { const cs = getComputedStyle(document.documentElement); const want = ${q(data.variables)}; const bad = []; for (const [k, v] of Object.entries(want)) { if (v == null) continue; const got = cs.getPropertyValue(k).trim(); if (got.toLowerCase() !== String(v).toLowerCase()) bad.push([k, v, got]); } return { bad, hc: document.documentElement.classList.contains('theme-high-contrast'), selectedOutline: getComputedStyle(document.querySelector('.file.selected')).outlineStyle, editorBg: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor, appBg: getComputedStyle(document.querySelector('.app')).backgroundColor }; })()`);
    const state = await readingState();
    const hc = entry.type.startsWith("hc");
    const textShot = await shot(`${entry.id}-text`);
    const row = { id: entry.id, type: entry.type, switchMs: Math.round(sw.ms), openMs: Math.round(open.ms), variablesMismatched: applied.bad, hcClass: applied.hc, selectedOutline: applied.selectedOutline, editorBg: applied.editorBg, appBg: applied.appBg, state, shots: [textShot, dialogShot] };
    report.schemes.push(row);
    if (applied.bad.length) fail(`${entry.id} 变量未生效 ${q(applied.bad.slice(0, 3))}`);
    if (hc !== applied.hc) fail(`${entry.id} 高对比类名不符`);
    if (hc && applied.selectedOutline !== "solid") fail(`${entry.id} 高对比未使用描边`);
    const same = JSON.stringify(state.marks) === JSON.stringify(before.marks) && JSON.stringify(state.scroll) === JSON.stringify(before.scroll) && state.selection === before.selection && state.searchVisible && state.query === before.query && state.hits === before.hits;
    if (!same) fail(`${entry.id} 切换后阅读状态变化 ${q(state)}`);
    log(`${entry.id}：切换 ${Math.round(sw.ms)} ms，打开设置 ${Math.round(open.ms)} ms，变量不符 ${applied.bad.length}，阅读状态${same ? "保持" : "变化"}`);
  }

  // 字号：快捷键与设置同步、不重建编辑器
  const fontTimes = [];
  for (const [k, size] of [["=", "14px"], ["=", "15px"], ["-", "14px"], ["0", "13px"]]) fontTimes.push(await measure(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${q(k)}, ctrlKey: true, bubbles: true, cancelable: true }))`, `getComputedStyle(document.querySelector('.cm-content')).fontSize === ${q(size)}`));
  await key("=", { ctrl: true });
  await sleep(300);
  const fontState = await evaluate(`({ size: getComputedStyle(document.querySelector('.cm-content')).fontSize })`);
  await click(SETTINGS_BUTTON);
  await waitUntil(`document.querySelector('#settings-font-size')`);
  const slider = await evaluate(`document.querySelector('#settings-font-size').value`);
  await click(CLOSE_SETTINGS);
  const afterFont = await readingState();
  check("B22 字号快捷键与设置同步", fontState.size === "14px" && slider === "14", { fontState, slider });
  check("B22 字号变化不重建编辑器、保持阅读状态", JSON.stringify(afterFont.marks) === JSON.stringify(before.marks) && afterFont.selection === before.selection && afterFont.searchVisible, afterFont);

  // 跟随系统（CDP 模拟 prefers-color-scheme）
  await click(SETTINGS_BUTTON);
  await waitUntil(`document.querySelector('.settings-dialog')`);
  await click(modeButton("跟随系统"));
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(500);
  const sysDark = await evaluate(`document.documentElement.classList.contains('theme-dark')`);
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const followLight = await evaluate(`window.__op.waitUntil(() => document.documentElement.classList.contains('theme-light'), 3000)`);
  check("B21 跟随系统时实时跟随（CDP 模拟）", sysDark && followLight.ok, { sysDark, followLight });
  await call("Emulation.setEmulatedMedia", { features: [] });

  // 许可声明（B22）
  const notice = await evaluate(`(() => { const d = document.querySelector('.settings-notices'); d.open = true; return d.querySelector('pre').textContent; })()`);
  check("B22 发布包内含 VS Code 与 Colorsublime 许可声明", notice.includes("Microsoft Corporation") && notice.includes("Colorsublime.com"));
  await shot("license-notices");

  // B20：Git 路径
  await click(`[...document.querySelectorAll('.settings-nav button')].find((n) => n.textContent === 'Git')`);
  await waitUntil(`document.querySelector('#settings-git')`);
  const inUse = await evaluate(`[...document.querySelectorAll('.git-facts dd')].map((n) => n.textContent)`);
  const typeGit = (value) => evaluate(`(() => { const f = document.querySelector('#settings-git'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, ${q(value)}); f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await typeGit(path.join(runDir, "no-such-git.exe"));
  await waitUntil(`document.querySelector('.settings-error')`, 15000);
  const invalid = await evaluate(`({ error: document.querySelector('.settings-error').textContent, setting: document.querySelector('.git-facts dd').textContent })`);
  check("B20 无效 Git 路径提示并保留原值", invalid.setting.includes("自动发现"), invalid);
  await shot("git-invalid");
  const actual = inUse[1].split(" · ")[0];
  await typeGit(actual);
  await waitUntil(`document.querySelector('.settings-ok')`, 15000);
  await sleep(1500);
  const valid = await evaluate(`({ ok: document.querySelector('.settings-ok').textContent, setting: document.querySelector('.git-facts dd').textContent })`);
  check("B20 有效 Git 路径被采用", valid.setting === actual, { valid, actual, inUse });
  await click(CLOSE_SETTINGS);
  await waitUntil(`window.__op.rows().length === 2 && !window.__op.loading()`, 20000);

  // 图片阅读器、对话框：逐套截图
  await click(`window.__op.row('img/logo.png')`);
  await waitUntil(`document.querySelector('.image-viewer') && !window.__op.loading()`, 20000);
  for (const entry of schemeIndex) {
    await click(SETTINGS_BUTTON);
    await waitUntil(`document.querySelector('.settings-dialog [role=option]')`);
    await click(modeButton(isDark(entry.type) ? "深色" : "浅色"));
    await click(optionFor(entry.id));
    await waitUntil(`document.documentElement.dataset.scheme === ${q(entry.id)}`);
    await click(CLOSE_SETTINGS);
    await sleep(200);
    report.schemes.find((r) => r.id === entry.id).shots.push(await shot(`${entry.id}-image`));
  }

  report.timings = {
    switchScheme: summarize(switchTimes), openSettings: summarize(openTimes), switchMode: summarize(modeTimes), fontShortcut: summarize(fontTimes)
  };
  check("§3 切换配色 P95 ≤ 100 ms", report.timings.switchScheme.p95 <= 100, report.timings.switchScheme);
  check("§3 切换主题模式 P95 ≤ 100 ms", report.timings.switchMode.p95 <= 100, report.timings.switchMode);
  check("§3 字号 P95 ≤ 100 ms", report.timings.fontShortcut.p95 <= 100, report.timings.fontShortcut);
  check("§3 打开设置窗口 P95 ≤ 100 ms", report.timings.openSettings.p95 <= 100, report.timings.openSettings);

  // B19 / B21：设置在重启后保留、首屏无闪烁
  await click(SETTINGS_BUTTON);
  await waitUntil(`document.querySelector('.settings-dialog [role=option]')`);
  await click(modeButton("浅色"));
  await click(optionFor("solarized-light"));
  await waitUntil(`document.documentElement.dataset.scheme === 'solarized-light'`);
  await click(CLOSE_SETTINGS);
  await sleep(500);
  report.checks.stopBeforeRestart = await stop(s);
  s = await start("profile");
  await s.waitUntil(`document.querySelector('.project-tab')`);
  await s.waitUntil(`document.documentElement.dataset.scheme === 'solarized-light'`, 10000).catch(() => {});
  const restarted = await s.evaluate(`({ scheme: document.documentElement.dataset.scheme, fontSize: JSON.parse(localStorage.getItem('oris.settings.v1')).appearance.fontSize, projects: document.querySelectorAll('.project-tab').length })`);
  check("B19 修改在重启后保留", restarted.scheme === "solarized-light" && restarted.fontSize === 14 && restarted.projects === 1, restarted);
  // 首屏：重新加载页面，在文档创建时记录根元素（boot.js 在样式表之前运行）
  await s.call("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener('DOMContentLoaded', () => { window.__boot = { scheme: document.documentElement.dataset.scheme, bg: getComputedStyle(document.documentElement).backgroundColor, rootChildren: document.getElementById('root')?.childElementCount ?? -1 }; }, { once: true });` });
  await s.call("Page.reload", {});
  await sleep(2500);
  await s.evaluate(PAGE_HELPERS);
  const boot = await s.evaluate(`({ boot: window.__boot ?? null, finalBg: getComputedStyle(document.documentElement).backgroundColor, scheme: document.documentElement.dataset.scheme })`);
  const solarizedBg = loadSchemeData("solarized-light").variables["--bg"];
  check("B21 启动无配色闪烁（React 挂载前根元素已是保存的方案）", boot.boot && boot.boot.scheme === "solarized-light" && boot.boot.bg === boot.finalBg, { ...boot, solarizedBg });

  // B19：设置文件损坏时回退默认并提示，项目列表不受影响
  await s.evaluate(`localStorage.setItem('oris.settings.v1', '{broken')`);
  await s.call("Page.reload", {});
  await sleep(2500);
  await s.evaluate(PAGE_HELPERS);
  await s.waitUntil(`document.querySelector('.project-tab')`);
  await s.click(SETTINGS_BUTTON);
  await s.waitUntil(`document.querySelector('.settings-dialog')`);
  const corrupted = await s.evaluate(`({ notice: document.querySelector('.settings-body .settings-error')?.textContent ?? null, projects: document.querySelectorAll('.project-tab').length, scheme: document.documentElement.dataset.scheme })`);
  check("B19 设置损坏回退默认并提示，项目列表不受影响", corrupted.notice?.includes("已损坏") && corrupted.projects === 1, corrupted);
  await s.shot("settings-corrupted");
  await s.click(CLOSE_SETTINGS);
  // Ctrl+, 打开
  await s.key(",", { ctrl: true });
  check("B19 Ctrl+, 打开设置", await s.evaluate(`window.__op.waitUntil(() => document.querySelector('.settings-dialog'), 2000).then((r) => r.ok)`));
} catch (error) {
  report.error = String(error.stack ?? error);
  log("失败", error);
} finally {
  report.stop = await stop(s);
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  log(`失败项 ${report.failures.length}${report.error ? "，脚本异常" : ""}；报告 ${path.join(outDir, "report.json")}`);
  removeDir(runDir, GUI_ROOT);
}
