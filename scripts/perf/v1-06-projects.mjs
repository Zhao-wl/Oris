// 一期 06 多项目界面验收（A02，A03 的重启恢复与失效路径）：同名不同路径、重复添加、搜索、双击别名、拖动排序、× 移除只删记录，
// 重启后恢复别名与顺序，关闭期间被移走的项目有提示。只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 +
// 端口归属），不调用任何窗口激活 API；拖动为 CDP 注入的鼠标事件（产生页面 Pointer Events），不是真实鼠标。
// 用法：node scripts/perf/v1-06-projects.mjs --exe <oris.exe> [--port 9851] [--label v1-06-projects]
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
let port = Number(option("port", 9851));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v1-06-projects"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-06-projects-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), method: "CDP 页面事件与 CDP 鼠标事件；不是真实鼠标、键盘或系统焦点", checks: {}, failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)}`); };

// ---------- 夹具：两个同名仓库（不同父目录）与第三个仓库 ----------
const makeRepo = (dir, file) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, file), "base\n"); git(dir, ["init", "-q", "-b", "main"]); git(dir, ["add", "-A"]); git(dir, ["-c", "user.name=Oris GUI", "-c", "user.email=oris-gui@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]); writeFileSync(path.join(dir, file), "base\nchanged\n"); return dir; };
const sameA = makeRepo(path.join(runDir, "alpha", "same"), "a.txt");
const sameB = makeRepo(path.join(runDir, "beta", "same"), "b.txt");
const third = makeRepo(path.join(runDir, "gamma", "third 项目"), "c.txt");
const repos = [sameA, sameB, third];
const before = Object.fromEntries(repos.map((r) => [r, repositoryFingerprint(r)]));

const profile = path.join(runDir, "profile");
async function start() {
  const app = await launchOris({ exe, profileDir: profile, port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const click = (expr) => evaluate(`(() => { const n = ${expr}; if (!n) throw new Error('找不到元素：' + ${q(expr)}); n.click(); return true; })()`);
  const shot = async (name) => { await sleep(250); const { data } = await call("Page.captureScreenshot", { format: "png" }); const file = path.join(shotDir, `${name}.png`); writeFileSync(file, Buffer.from(data, "base64")); return path.relative(projectRoot, file); };
  const tabs = () => evaluate(`[...document.querySelectorAll('.project-tab')].map((t) => ({ name: t.querySelector('.project-switch span, .project-label input')?.textContent ?? '', path: t.title, active: t.classList.contains('active') }))`);
  const add = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await click(`window.__op.button('载入/添加')`);
    await waitUntil(`!window.__op.loading() && document.querySelector('.project-tab.active')?.title === ${q(repo)}`, 30000);
    await sleep(300);
    return evaluate(`document.querySelector('.restore-status')?.textContent ?? ''`);
  };
  const tabCenter = (index) => evaluate(`(() => { const r = document.querySelectorAll('.project-tab')[${index}].querySelector('.project-drag').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  return { app, call, evaluate, waitUntil, click, shot, tabs, add, tabCenter };
}
async function stop(s) { try { s.app.cdp.close(); } catch { /* 已关闭 */ } const r = await killOris(s.app); log(`实例 ${s.app.pid} 已结束：${r.how}`); }

let s = null;
try {
  s = await start();
  await s.waitUntil(`document.querySelector('.project-empty')`);
  for (const repo of repos) await s.add(repo);
  let tabs = await s.tabs();
  check("A02 同名不同路径的两个项目各有页签，显示名相同、路径区分", tabs.length === 3 && tabs.filter((t) => t.name === "same").length === 2 && new Set(tabs.map((t) => t.path)).size === 3, { tabs, shot: await s.shot("a02-same-name") });
  const again = await s.add(sameA);
  tabs = await s.tabs();
  check("A02 重复添加同一路径：不新增页签，切换到已有项目并说明", tabs.length === 3 && /已存在/.test(again) && tabs.find((t) => t.active)?.path === sameA, { again, tabs });
  check("A02 没有 pin（固定）入口", await s.evaluate(`![...document.querySelectorAll('button, [role=menuitem]')].some((b) => /固定|pin/i.test((b.textContent ?? '') + (b.getAttribute('aria-label') ?? '') + (b.title ?? ''))) `));
  // 搜索：按完整路径筛选
  await s.evaluate(`window.__op.setInput('搜索项目', ${q(path.join(runDir, "beta"))})`);
  await sleep(300);
  const filtered = await s.tabs();
  await s.evaluate(`window.__op.setInput('搜索项目', '')`);
  await sleep(300);
  check("A02 搜索按完整路径筛选页签，清空后恢复", filtered.length === 1 && filtered[0].path === sameB && (await s.tabs()).length === 3, { filtered });
  // 双击别名
  await s.evaluate(`(() => { const span = [...document.querySelectorAll('.project-tab')].find((t) => t.title === ${q(sameB)}).querySelector('.project-switch span'); span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await s.waitUntil(`!!document.querySelector('input.project-rename')`);
  await s.evaluate(`(() => { const f = document.querySelector('input.project-rename'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, '别名 B'); f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); f.blur(); })()`);
  await sleep(400);
  tabs = await s.tabs();
  check("A02 双击页签名称设置别名，只改显示名", tabs.find((t) => t.path === sameB)?.name === "别名 B" && tabs.find((t) => t.path === sameA)?.name === "same", tabs);
  // 拖动排序：把第 3 个页签拖到第 1 个页签上
  const order0 = tabs.map((t) => t.path);
  const from = await s.tabCenter(2), to = await s.tabCenter(0);
  await s.evaluate(`(() => { window.__ptr = []; for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, (e) => { if (window.__ptr.length < 40) window.__ptr.push([type, e.pointerId, Math.round(e.clientX), e.buttons, e.target?.className ?? '', document.elementFromPoint(e.clientX, e.clientY)?.closest('.project-tab')?.dataset.repoId?.slice(0, 6) ?? null]); }, true); })()`);
  await s.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await s.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, x: from.x, y: from.y });
  // 与真实鼠标一样先在被拖页签内小步移动（超过 4 px 阈值后开始拖动并捕获指针），再移到目标页签。
  for (const dx of [-2, -5, -8]) { await s.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: from.x + dx, y: from.y }); await sleep(30); }
  for (let i = 1; i <= 8; i++) { await s.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: from.x + (to.x - from.x) * i / 8, y: from.y }); await sleep(30); }
  await s.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, x: to.x, y: to.y });
  await sleep(500);
  tabs = await s.tabs();
  const order1 = tabs.map((t) => t.path);
  check("A02 拖动页签调整顺序（CDP 鼠标事件）", order1.join() !== order0.join() && order1.length === 3 && order1[0] !== order0[0] && order1.includes(third), { order0, order1, from, to, pointerEvents: await s.evaluate(`window.__ptr`), shot: await s.shot("a02-reordered") });
  await stop(s); s = null;

  // 重启：别名与顺序恢复
  s = await start();
  await s.waitUntil(`document.querySelectorAll('.project-tab').length === 3`);
  await s.waitUntil(`!window.__op.loading()`);
  tabs = await s.tabs();
  check("A03 重启后恢复项目列表、别名与顺序", tabs.map((t) => t.path).join() === order1.join() && tabs.find((t) => t.path === sameB)?.name === "别名 B", { tabs });
  // × 移除：只移除记录，目录保留
  const removedName = await s.evaluate(`[...document.querySelectorAll('.project-tab')].find((t) => t.title === ${q(sameA)}).querySelector('.project-close').getAttribute('aria-label')`);
  await s.click(`[...document.querySelectorAll('.project-tab')].find((t) => t.title === ${q(sameA)}).querySelector('.project-close')`);
  await sleep(500);
  tabs = await s.tabs();
  check("A02 × 移除项目：只移除 Oris 记录，仓库目录与内容不变", tabs.length === 2 && !tabs.some((t) => t.path === sameA) && existsSync(path.join(sameA, ".git")) && diffFingerprints(before[sameA], repositoryFingerprint(sameA)).length === 0, { removedName, tabs, shot: await s.shot("a02-removed") });
  await stop(s); s = null;

  // 关闭期间项目目录被移走：重启后有提示，不显示为无变化
  const moved = `${third}-moved`;
  renameSync(third, moved);
  s = await start();
  await s.waitUntil(`document.querySelectorAll('.project-tab').length === 2`);
  await s.click(`[...document.querySelectorAll('.project-tab')].find((t) => t.title === ${q(third)})?.querySelector('.project-switch')`);
  await s.waitUntil(`!window.__op.loading() && (document.querySelector('.state.error') || /失效|不存在|无法|失败/.test(document.querySelector('.restore-status')?.textContent ?? '') || /失效|不存在|无法|失败/.test(document.querySelector('.selection-notice')?.textContent ?? ''))`, 30000);
  const invalid = await s.evaluate(`({ error: document.querySelector('.state.error')?.textContent ?? null, status: document.querySelector('.restore-status')?.textContent ?? null, notice: document.querySelector('.selection-notice')?.textContent ?? null, rows: window.__op.rows() })`);
  check("A03 关闭期间项目目录被移走：切换到该项目时明确提示，不显示为无变化", (invalid.error || invalid.notice || /失效|不存在|无法|失败/.test(invalid.status ?? "")) && invalid.rows.length === 0, { invalid, shot: await s.shot("a03-invalid-path") });
  await stop(s); s = null;
  renameSync(moved, third);
  // B17：整个过程中两个保留的仓库不变（被移走的仓库已移回原处后再比较）
  const changed = repos.flatMap((r) => diffFingerprints(before[r], repositoryFingerprint(r)).map((k) => `${path.basename(path.dirname(r))}/${path.basename(r)}:${k}`));
  check("B17 添加 / 切换 / 搜索 / 别名 / 排序 / 移除 / 重启：三个仓库的工作区与 .git 都不变", changed.length === 0, changed);
} catch (error) {
  fail(`异常：${error?.stack ?? error}`);
} finally {
  if (s) await stop(s).catch((e) => fail(`结束实例失败：${e}`));
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const names = Object.keys(report.checks);
  log(`完成：${names.filter((n) => report.checks[n].ok).length}/${names.length} 项通过；报告 ${path.join(outDir, "report.json")}`);
  if (!args.includes("--keep")) { await sleep(1000); removeDir(runDir, GUI_ROOT); log(`已删除测试目录 ${runDir}`); }
  process.exitCode = report.failures.length ? 1 : 0;
}
