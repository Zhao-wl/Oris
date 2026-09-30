// 阶段 2 定位用：搭好 wrap-align-probe 的场景（自动换行 + 对齐），滚到 --at 指定位置后，在页面内执行 --snippet 文件中的表达式并输出结果。
// 页面内可用 window.__views()：返回 { a, b }（左右两侧的 CodeMirror EditorView，经 .cm-content 的 cmView 取得，只读使用）。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例。
// 用法：node scripts/perf/wrap-align-inspect.mjs --exe <oris.exe> --snippet <file.js> [--fixture multi] [--at 0.1] [--side right|left] [--port 9891]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
const snippet = readFileSync(option("snippet"), "utf8");
const at = option("at", "0.1").split(",").map((v) => v === "bottom" ? v : Number(v));
const fixture = option("fixture", "multi");
const paneSide = option("side", "right");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "wrap-align-inspect"));
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `wrap-align-inspect-${Date.now()}`);
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

const VIEWS = String.raw`window.__views = () => { const pick = (side) => { const c = document.querySelector('.oris-split-pane.' + side + ' .cm-content'); let v = c?.cmView; while (v && !v.view) v = v.parent; return v?.view ?? null; }; return { a: pick('left'), b: pick('right') }; }; true`;
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port: Number(option("port", 9891)), log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
const result = { fixture, at, outputs: [] };
try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const toggle = (label) => `[...document.querySelectorAll('.toolbar .toggle-button')].find((n) => n.textContent === ${q(label)})`;
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
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.readyFor('typical.ts', null) === true`, 30000);
  await sleep(1200);
  await evaluate(`${toggle("自动换行")}.click()`); await sleep(300);
  await evaluate(`${toggle("对齐变化")}.click()`); await settle();
  await evaluate(VIEWS);
  result.outputs.push({ at: "initial", value: await evaluate(snippet) });
  for (const fraction of at) {
    await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.${paneSide} .cm-scroller'); sc.scrollTop = ${fraction === "bottom" ? "sc.scrollHeight" : `sc.scrollHeight * ${fraction}`}; })()`);
    await settle();
    result.outputs.push({ at: fraction, value: await evaluate(snippet) });
    if (args.includes("--nudge")) {
      // 窗口宽度 +1 px 再恢复：触发一次完整的重新对齐（与滚轮滚动停下后的行为相同）。
      await call("Emulation.setDeviceMetricsOverride", { width: 1441, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await settle();
      result.outputs.push({ at: `${fraction}（完整重新对齐后）`, value: await evaluate(snippet) });
    }
  }
} catch (error) { result.error = String(error.stack ?? error); log("失败", error); }
finally {
  try { app.cdp.close(); } catch { /* ignore */ }
  await killOris(app);
  const file = path.join(outDir, "inspect.json");
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`报告：${file}`);
  removeDir(runDir, GUI_ROOT);
}
