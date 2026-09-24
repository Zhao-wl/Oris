// V2-06 体验版截图：只经 CDP 操作本轮启动并核验过的 Oris 实例，不调用任何窗口激活 API。
// 用法：node scripts/perf/v2-06-preview-shots.mjs --exe <oris.exe> [--port 9751]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, prepareCoreRepos } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
const port = Number(option("port", 9751));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", "v2-06-preview-shots");
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v2-06-shots-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

const [repo] = await prepareCoreRepos(runDir, 1);
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port, log });
const report = { exe, identity: app.identity, shots: [], checks: {} };
try {
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); });
  const shot = async (name) => {
    await sleep(400);
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    const file = path.join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    report.shots.push(file); log("截图", file);
  };
  const click = (selectorExpr) => evaluate(`(() => { const n = ${selectorExpr}; if (!n) throw new Error('找不到元素'); n.click(); return true; })()`);
  const option = (name) => `[...document.querySelectorAll('[role=option]')].find((n) => n.querySelector('.scheme-name')?.textContent === ${JSON.stringify(name)})`;
  const button = (text) => `[...document.querySelectorAll('button')].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;
  const vars = () => evaluate(`(() => { const s = getComputedStyle(document.documentElement); return { bg: s.getPropertyValue('--bg').trim(), text: s.getPropertyValue('--text').trim(), cls: document.documentElement.className, editorBg: getComputedStyle(document.querySelector('.cm-editor') ?? document.body).backgroundColor }; })()`);

  await evaluate(`window.__op.setInput('仓库路径', ${JSON.stringify(repo.path)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await click(`window.__op.button('载入/添加')`);
  await waitUntil(`window.__op.rows().length > 0 && !window.__op.loading()`);
  const modified = await evaluate(`(() => { const n = [...document.querySelectorAll('.file')].find((f) => /\\.(ts|js|rs|txt|md)$/.test(f.getAttribute('aria-label')) && f.textContent.includes('M')) ?? document.querySelector('.file'); n.click(); return n.getAttribute('aria-label'); })()`);
  await waitUntil(`document.querySelector('.cm-editor') && !window.__op.loading()`);
  report.checks.file = modified;
  report.checks.default = await vars();
  await shot("01-default-oris-dark");

  await click(`document.querySelector('button[aria-label="设置"]')`);
  await waitUntil(`document.querySelector('.settings-dialog')`);
  await shot("02-settings-appearance");

  await click(option("Dark 2026"));
  await sleep(600);
  report.checks.dark2026 = await vars();
  await click(button("B：新增绿"));
  await shot("03-settings-dark-2026-diff-B");

  await click(`document.querySelector('.inline-check input')`);
  await shot("04-settings-first-batch-only");

  await click(`[...document.querySelectorAll('.segmented button')].find((n) => n.textContent === '浅色')`);
  await click(option("Light 2026"));
  await sleep(600);
  report.checks.light2026 = await vars();
  await click(`document.querySelector('button[aria-label="关闭设置"]')`);
  await waitUntil(`!document.querySelector('.settings-dialog')`);
  await shot("05-light-2026-diff-B");

  await click(`document.querySelector('button[aria-label="设置"]')`);
  await waitUntil(`document.querySelector('.settings-dialog')`);
  await click(`document.querySelector('.inline-check input')`);
  await click(option("Light High Contrast"));
  await click(button("A：修改蓝"));
  await sleep(600);
  report.checks.hcLight = await vars();
  await click(`document.querySelector('button[aria-label="关闭设置"]')`);
  await shot("06-hc-light-diff-A");

  await click(`document.querySelector('button[aria-label="设置"]')`);
  await waitUntil(`document.querySelector('.settings-dialog')`);
  await click(`[...document.querySelectorAll('.settings-nav button')].find((n) => n.textContent === 'Git')`);
  await shot("07-settings-git");
  await click(`document.querySelector('button[aria-label="关闭设置"]')`);
  report.checks.consoleErrors = await evaluate(`window.__errors ?? null`);
} finally {
  try { app.cdp.close(); } catch { /* closed */ }
  report.stop = await killOris(app);
  log("实例已结束", report.stop.how);
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  removeDir(runDir, GUI_ROOT);
}
