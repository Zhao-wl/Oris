// V2-D58 定位辅助：统计字号切换场景（3,000 行并排 diff，右侧滚到 60%）中 diff 区域的 DOM 构成与 CodeMirror 视口。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris），不调用任何窗口激活 API。
// 用法：node scripts/perf/v2-d58-dom-census.mjs --exe <oris.exe> [--label v2-d58-census] [--port 9883]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const label = option("label", "v2-d58-census");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `${label}-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const lines = 3000;
const repo = path.join(runDir, "repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
const base = Array.from({ length: lines }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`);
writeFileSync(path.join(repo, "typical.ts"), base.join("\n") + "\n");
git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
const changed = [...base];
for (let i = 30; i < changed.length; i += 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
changed.splice(Math.floor(lines / 2), 0, "  // inserted block", "  const extra = true;");
writeFileSync(path.join(repo, "typical.ts"), changed.join("\n") + "\n");

const CENSUS = String.raw`(() => {
  const host = document.querySelector('.diff-host');
  const count = (root, sel) => root ? root.querySelectorAll(sel).length : 0;
  const byTag = {}; for (const el of host.querySelectorAll('*')) byTag[el.tagName.toLowerCase()] = (byTag[el.tagName.toLowerCase()] ?? 0) + 1;
  const byClass = {}; for (const el of host.querySelectorAll('[class]')) for (const c of el.classList) byClass[c] = (byClass[c] ?? 0) + 1;
  const editors = [...host.querySelectorAll('.cm-editor')].map((ed) => ({
    lines: count(ed, '.cm-line'), gutterElements: count(ed, '.cm-gutterElement'), spans: count(ed.querySelector('.cm-content'), 'span'), widgets: count(ed, '.cm-widgetBuffer, [contenteditable=false]'),
    all: ed.querySelectorAll('*').length, textNodes: (() => { let n = 0; const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); while (w.nextNode()) n++; return n; })(),
    scrollTop: Math.round(ed.querySelector('.cm-scroller').scrollTop), clientHeight: ed.querySelector('.cm-scroller').clientHeight
  }));
  return { hostElements: host.querySelectorAll('*').length, pageElements: document.querySelectorAll('*').length, editors, topTags: Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 12), topClasses: Object.entries(byClass).sort((a, b) => b[1] - a[1]).slice(0, 25) };
})()`;

const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port: Number(option("port", 9883)), log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
const result = { exe };
try {
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${JSON.stringify(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.readyFor('typical.ts', null) === true`, 30000);
  await sleep(1500);
  result.top = await evaluate(CENSUS);
  await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller'); sc.scrollTop = sc.scrollHeight * 0.6; })()`);
  await sleep(1500);
  result.scrolled = await evaluate(CENSUS);
  // 一次字号切换期间的 DOM 变更：按目标、属性名与增删节点汇总（区分“全量重绘”与“属性 / 样式变更”）。
  for (const [i, key] of [["0", "="], ["1", "-"]]) {
    result[`mutations${i}`] = await evaluate(`(async () => {
      const host = document.querySelector('.diff-host');
      const stats = { attributes: {}, added: {}, removed: {}, text: 0 };
      const tag = (n) => n.nodeType === 3 ? '#text' : (n.classList?.[0] ?? n.tagName?.toLowerCase() ?? '?');
      const obs = new MutationObserver((list) => { for (const m of list) {
        if (m.type === 'attributes') { const k = tag(m.target) + '@' + m.attributeName; stats.attributes[k] = (stats.attributes[k] ?? 0) + 1; }
        else if (m.type === 'characterData') stats.text++;
        else { for (const n of m.addedNodes) stats.added[tag(n)] = (stats.added[tag(n)] ?? 0) + 1; for (const n of m.removedNodes) stats.removed[tag(n)] = (stats.removed[tag(n)] ?? 0) + 1; }
      } });
      obs.observe(host, { subtree: true, attributes: true, childList: true, characterData: true });
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 600));
      obs.takeRecords(); obs.disconnect();
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 15);
      return { attributes: top(stats.attributes), added: top(stats.added), removed: top(stats.removed), text: stats.text };
    })()`);
    log(`切换 ${key}`, JSON.stringify(result[`mutations${i}`]));
    await sleep(800);
  }
} catch (error) {
  result.error = String(error.stack ?? error); log("失败", error);
} finally {
  try { app.cdp.close(); } catch { /* ignore */ }
  result.stop = await killOris(app);
  writeFileSync(path.join(outDir, "census.json"), JSON.stringify(result, null, 2));
  removeDir(runDir, GUI_ROOT);
}
