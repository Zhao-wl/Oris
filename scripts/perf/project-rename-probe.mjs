// 定位用：项目页签双击改名（v1-06-projects A02）。添加两个临时仓库，双击非当前页签的名称，输入别名并回车，逐步记录输入框、焦点、页签名与页面错误。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris），不调用任何窗口激活 API；事件为页面内派发。
// 用法：node scripts/perf/project-rename-probe.mjs --exe <oris.exe> [--port 9893]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
const runDir = path.join(GUI_ROOT, `project-rename-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const repos = ["alpha", "beta"].map((name) => {
  const repo = path.join(runDir, name, "same");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, ["add", "-A"]); git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "a"]);
  return repo;
});
const STATE = `(() => ({ input: !!document.querySelector('input.project-rename'), inputValue: document.querySelector('input.project-rename')?.value ?? null, active: document.activeElement?.className ?? document.activeElement?.tagName, tabs: [...document.querySelectorAll('.project-tab')].map((t) => ({ path: t.title, name: t.querySelector('.project-switch span')?.textContent ?? null, active: t.classList.contains('active') })), errors: window.__errors ?? [] }))()`;
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port: Number(option("port", 9893)), log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
const steps = [];
try {
  await call("Runtime.enable");
  await evaluate(PAGE_HELPERS);
  await evaluate(`window.__errors = []; window.addEventListener('error', (e) => window.__errors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason?.message ?? e.reason))); true`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  await waitUntil(`document.querySelector('.project-empty')`);
  for (const repo of repos) {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 30000);
    await sleep(600);
  }
  // 回到第一个项目，使第二个页签为非当前页签（与 v1-06-projects 相同）。
  await evaluate(`[...document.querySelectorAll('.project-tab')].find((t) => t.title === ${q(repos[0])}).click()`);
  await sleep(1500);
  steps.push({ step: "准备", ...(await evaluate(STATE)) });
  await evaluate(`[...document.querySelectorAll('.project-tab')].find((t) => t.title === ${q(repos[1])}).querySelector('.project-switch span').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
  steps.push({ step: "双击后", ...(await evaluate(STATE)) });
  await evaluate(`(() => { const f = document.querySelector('input.project-rename'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, '别名 B'); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);
  steps.push({ step: "输入后", ...(await evaluate(STATE)) });
  await evaluate(`document.querySelector('input.project-rename')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(300);
  steps.push({ step: "回车后", ...(await evaluate(STATE)) });
  await evaluate(`document.querySelector('input.project-rename')?.blur()`);
  await sleep(300);
  steps.push({ step: "blur 后", ...(await evaluate(STATE)) });
  await sleep(2000);
  steps.push({ step: "2 s 后", ...(await evaluate(STATE)) });
} catch (error) { steps.push({ error: String(error.stack ?? error) }); }
finally {
  try { app.cdp.close(); } catch { /* ignore */ }
  await killOris(app);
  removeDir(runDir, GUI_ROOT);
  for (const s of steps) console.log(JSON.stringify(s));
}
