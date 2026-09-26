// 一期 06 发布性能测试：常驻 Git 子进程（V2 验收计划 §4：空闲 ≤ 5 个；关闭项目后 60 s 内回收）。
// 打开 5 个 S 项目并在每个项目中阅读若干文件（启动常驻 cat-file），空闲 10 s 后计数；再逐个移除项目，每 2 s 统计一次
// Oris 进程树下的 git 进程，直到全部回收（最多 120 s）。只经 CDP 操作本轮启动并核验过的 Oris 实例，不调用窗口激活 API。
// 用法：node scripts/perf/v1-06-git-children.mjs --exe <oris.exe> [--port 9871] [--label perf-git-children]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, prepareCoreRepos } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, gitChildren, killOris, launchOris, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
const port = Number(option("port", 9871));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "perf-git-children"));
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-06-git-children-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), method: "CDP 页面事件；git 进程为 Oris 进程树中的 git.exe（含 cat-file）", samples: [], failures: [] };

const repos = await prepareCoreRepos(path.join(runDir, "repos"), 5);
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
await call("Runtime.enable"); await call("Page.enable");
await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
await evaluate(PAGE_HELPERS);
const waitUntil = (expr, timeout = 60000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
const count = () => gitChildren(app.pid).length;
const sample = (tag) => { const s = { tag, at: Date.now(), git: count() }; report.samples.push(s); log(tag, s.git); return s; };
try {
  await waitUntil(`document.querySelector('.project-empty')`);
  for (const r of repos) {
    await evaluate(`window.__op.setInput('仓库路径', ${q(r.path)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(r.path)}) && !window.__op.loading() && window.__op.rows().length > 0`);
    // 阅读 5 个文件：内容按 OID 经常驻 cat-file 读取
    const rows = (await evaluate(`window.__op.rows()`)).slice(0, 5);
    for (const p of rows) { await evaluate(`window.__op.row(${q(p)}).click()`); await waitUntil(`window.__op.tab() === ${q(p)} && !window.__op.loading()`); await sleep(200); }
  }
  await sleep(10000);
  const idle = sample("5 个项目打开并阅读后空闲 10 s");
  report.idleGitChildren = idle.git;
  // 移除全部项目（× 按钮只删除 Oris 记录）
  const removedAt = Date.now();
  for (let i = 0; i < repos.length; i++) {
    await evaluate(`document.querySelector('.project-tab .project-close').click()`);
    await sleep(300);
  }
  await waitUntil(`document.querySelectorAll('.project-tab').length === 0`);
  let reclaimedMs = null;
  while (Date.now() - removedAt < 120000) {
    const s = sample(`移除全部项目后 ${Math.round((Date.now() - removedAt) / 1000)} s`);
    if (s.git === 0) { reclaimedMs = s.at - removedAt; break; }
    await sleep(2000);
  }
  report.reclaimedMs = reclaimedMs;
  report.verdict = { idleWithin5: idle.git <= 5, reclaimedWithin60s: reclaimedMs !== null && reclaimedMs <= 60000 };
  log("结论", report.verdict, `回收用时 ${reclaimedMs} ms`);
} catch (error) {
  report.failures.push(String(error.stack ?? error));
  log("异常", error);
} finally {
  try { app.cdp.close(); } catch { /* 已关闭 */ }
  report.stop = await killOris(app);
  writeFileSync(path.join(outDir, "git-children.json"), JSON.stringify(report, null, 2));
  await sleep(1000);
  removeDir(runDir, GUI_ROOT);
  process.exitCode = report.failures.length ? 1 : 0;
}
