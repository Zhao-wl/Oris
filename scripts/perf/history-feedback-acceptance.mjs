// 历史页反馈验收（2026-09-25 用户反馈 8 项）：搜索结果显示提交信息、三栏拖动、路径超框显示末尾、双击切换分支、
// 引用搜索、本地 / 远端分开、分支 / 标签 / 远端 / Stash 四类可折叠（Stash 页签并入）、页签改名“历史”。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 点击、双击、指针拖动与输入都是 CDP 注入的页面事件，不是真实鼠标、键盘或系统焦点。
// 用法：node scripts/perf/history-feedback-acceptance.mjs --exe <oris.exe> [--port 9931] [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const port = Number(option("port", 9931));
const keep = args.includes("--keep");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "history-feedback-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `history-feedback-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), startedAt: new Date().toISOString(), runDir, method: "CDP 页面事件（点击、双击、指针拖动、输入）；不是真实鼠标、键盘或系统焦点。", checks: {}, failures: [], operations: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)}`); };
const evidence = (name, repo, before, after) => { const changed = diffFingerprints(before, after); const entry = { name, changed: changed.slice(0, 40), changedCount: changed.length }; report.operations.push(entry); return entry; };

// ---------- 夹具 ----------
const put = (repo, rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
const configure = (repo) => { for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["tag.gpgsign", "false"]]) git(repo, ["config", key, value]); };
const commitAll = (repo, message) => { git(repo, ["add", "-A"]); const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: repo, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
const LONG = "src/components/very/deeply/nested/directory/structure/for/testing/path/display/the-file-name-that-must-stay-visible.tsx";

function fixture() {
  const seed = path.join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]); configure(seed);
  put(seed, "a.txt", "a\n"); commitAll(seed, "base");
  git(seed, ["tag", "-a", "-m", "release", "v1.0"]);
  git(seed, ["switch", "-q", "-c", "feature"]); put(seed, "f.txt", "f\n"); commitAll(seed, "feature work");
  git(seed, ["switch", "-q", "-c", "remote-only", "main"]); put(seed, "r.txt", "r\n"); commitAll(seed, "remote only");
  git(seed, ["switch", "-q", "main"]);
  // 多条分支交错的提交，搜索词只出现在部分提交中：搜索结果彼此不相连。
  for (let i = 0; i < 40; i++) {
    const branch = `lane-${i % 5}`;
    git(seed, ["switch", "-q", i < 5 ? "-c" : "", branch, ...(i < 5 ? ["main"] : [])].filter(Boolean));
    put(seed, `${branch}.txt`, `${i}\n`); commitAll(seed, i % 3 === 0 ? `地龙 修复 ${i}` : `普通提交 ${i}`);
  }
  git(seed, ["switch", "-q", "main"]);
  for (let i = 0; i < 5; i++) spawnSync("git", ["-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `merge lane-${i}`, `lane-${i}`], { cwd: seed });
  put(seed, LONG, "long\n"); put(seed, "short.txt", "short\n"); commitAll(seed, "long path");
  const bare = path.join(runDir, "remote.git");
  git(runDir, ["clone", "-q", "--bare", seed, bare]);
  const work = path.join(runDir, "work");
  git(runDir, ["-c", "core.autocrlf=false", "clone", "-q", bare, work]); configure(work);
  git(work, ["branch", "-q", "--track", "feature", "origin/feature"]);
  return { work };
}

// ---------- 页面辅助 ----------
const H = String.raw`(() => {
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  window.__f = {
    button(text, root = document) { return qa('button', root).find((b) => b.textContent === text) ?? null; },
    tabs() { return qa('.git-tabs button').map((b) => b.textContent); },
    tab(label) { return qa('.git-tabs button').find((b) => b.textContent === label) ?? null; },
    heads() { return qa('.log-group-head').map((b) => b.textContent); },
    head(group) { return document.querySelector('[data-group="' + group + '"] .log-group-head'); },
    names(group) { return qa('[data-group="' + group + '"] [role=listbox] .log-branch-name').map((n) => n.textContent); },
    row(group, name) { return qa('[data-group="' + group + '"] .log-branch').find((b) => b.querySelector('.log-branch-name')?.textContent.replace(/^● /, '') === name) ?? null; },
    dbl(el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })); },
    setIn(selector, value) { const el = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); },
    rows() { return qa('.log-row').map((r) => ({ subject: r.querySelector('.log-subject')?.textContent ?? '', subjectWidth: Math.round(r.querySelector('.log-subject')?.getBoundingClientRect().width ?? 0), graphWidth: Number(r.querySelector('.log-graph')?.getAttribute('width') ?? 0) })); },
    commits() { const c = document.querySelector('.log-commits'); return { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth }; },
    count() { return document.querySelector('.log-count')?.textContent ?? ''; },
    running() { return !!document.querySelector('.op-status.running'); },
    width(selector) { return Math.round(document.querySelector(selector).getBoundingClientRect().width); },
    drag(side, dx) {
      const el = document.querySelector('.log-splitter[data-side=' + side + ']'); const b = el.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + 20;
      const ev = (type, cx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cx, clientY: y, isPrimary: true }));
      ev('pointerdown', x); ev('pointermove', x + dx / 2); ev('pointermove', x + dx); ev('pointerup', x + dx);
    },
    /** 路径显示：是否溢出、可见的是开头还是末尾、放得下时是否左对齐。 */
    path(el) {
      const box = el.getBoundingClientRect(); const text = (el.querySelector('bdi') ?? el).getBoundingClientRect();
      return { text: el.textContent, overflow: el.scrollWidth > el.clientWidth + 1, tailVisible: Math.abs(text.right - box.right) <= 2, headClipped: text.left < box.left - 1, leftAligned: Math.abs(text.left - box.left) <= 2, dir: el.getAttribute('dir'), style: getComputedStyle(el).textOverflow };
    },
    pathOf(selector, textPart) { const el = qa(selector).find((n) => n.textContent.includes(textPart)); return el ? window.__f.path(el) : null; }
  };
  return true;
})()`;

async function main() {
  const { work } = fixture();
  report.fixtures = { work };
  const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
  const { call, evaluate } = app.cdp;
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const shot = async (name) => { const file = path.join(shotDir, `${name}.png`); writeFileSync(file, await app.cdp.screenshot()); return path.relative(projectRoot, file); };
  const click = async (expr) => { await evaluate(`(() => { const el = ${expr}; if (!el) throw new Error('找不到元素：' + ${q(expr)}); if (el.disabled) throw new Error('元素不可用：' + ${q(expr)} + ' ' + el.title); el.click(); return true; })()`); await sleep(250); };
  const settle = () => waitUntil(`!window.__f.running() && !window.__op.loading()`);
  const refresh = async () => { await evaluate(`window.__op.button('↻ 本地刷新').click()`); await sleep(300); await waitUntil(`!window.__op.loading()`); await sleep(600); };
  try {
    await call("Runtime.enable"); await call("Page.enable");
    await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS + ";" + H });
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await evaluate(PAGE_HELPERS); await evaluate(H);
    log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
    await evaluate(`window.__op.setInput('仓库路径', ${q(work)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(work)}) && !window.__op.loading()`);
    await sleep(500);

    // 8. 页签名称；7. Stash 页签去掉
    const tabs = await evaluate(`window.__f.tabs()`);
    check("反馈 8 / 7：页签为“历史 / 提交 / 操作输出”，没有 Stash 页签", tabs[0] === "历史" && !tabs.some((t) => t.startsWith("Stash") || t === "日志"), { tabs });
    await click(`window.__f.tab('历史')`);
    await waitUntil(`window.__f.rows().length > 0 && window.__f.names('local').length > 0 && window.__f.names('remote:origin').length > 0 && !window.__f.count().includes('读取中')`);
    const before = repositoryFingerprint(work);

    // 6 / 7. 四类分组、本地与远端分开、远端按 remote 分组
    const heads = await evaluate(`window.__f.heads()`);
    const local = await evaluate(`window.__f.names('local')`);
    const remote = await evaluate(`window.__f.names('remote:origin')`);
    check("反馈 6 / 7：本地分支、标签、远端分支（按 remote）、Stash 四类分组；本地与远端分开列出", ["本地分支", "标签", "远端分支", "origin", "Stash"].every((label) => heads.some((h) => h.includes(label))) && local.includes("● main") && local.includes("feature") && !local.some((n) => n.includes("/")) && remote.includes("remote-only") && remote.includes("main"), { heads, local, remote, shot: await shot("sidebar-groups") });
    // 折叠 / 展开
    await click(`window.__f.head('tags')`);
    const tagsOpen = await evaluate(`window.__f.names('tags')`);
    await click(`window.__f.head('local')`);
    const localFolded = await evaluate(`window.__f.names('local').length === 0 && window.__f.head('local').getAttribute('aria-expanded') === 'false'`);
    await click(`window.__f.head('local')`);
    check("反馈 7：分组可折叠 / 展开（标签默认折叠，展开后列出 v1.0）", tagsOpen.includes("v1.0") && localFolded, { tagsOpen });
    await click(`window.__f.row('tags', 'v1.0')`);
    await waitUntil(`window.__f.count().includes('浏览 v1.0') && !window.__f.count().includes('读取中')`);
    check("反馈 7：单击标签筛选历史", (await evaluate(`window.__f.count()`)).includes("浏览 v1.0"), { count: await evaluate(`window.__f.count()`) });
    await click(`window.__f.button('全部分支')`);

    // 4. 没有“获取”按钮
    const fetchInSidebar = await evaluate(`[...document.querySelectorAll('.log-branches button')].some((b) => b.textContent.includes('获取'))`);
    check("反馈 4：左侧没有“获取…”按钮", !fetchInSidebar);

    // 5. 引用搜索
    await evaluate(`window.__f.setIn('input[aria-label=搜索分支]', 'feat')`); await sleep(300);
    const searched = { heads: await evaluate(`window.__f.heads()`), local: await evaluate(`window.__f.names('local')`), remote: await evaluate(`window.__f.names('remote:origin')`) };
    check("反馈 5：分支搜索只列出匹配项，无匹配的分组隐藏", searched.local.join() === "feature" && searched.remote.join() === "feature" && !searched.heads.some((h) => h.includes("Stash") || h.includes("标签")), { searched, shot: await shot("sidebar-search") });
    await evaluate(`window.__f.setIn('input[aria-label=搜索分支]', '')`); await sleep(300);

    // 1. 提交搜索后显示提交信息
    await evaluate(`window.__op.setInput('搜索提交', '地龙')`);
    await click(`window.__f.button('搜索')`);
    await waitUntil(`window.__f.rows().length > 0 && !window.__f.count().includes('读取中') && window.__f.rows().every((r) => r.subject.includes('地龙'))`);
    const found = await evaluate(`window.__f.rows()`);
    const scroll = await evaluate(`window.__f.commits()`);
    check("反馈 1：搜索结果显示提交信息（图宽 1 条泳道，提交信息列有宽度，没有横向滚动）", found.length >= 10 && found.every((r) => r.graphWidth === 12 && r.subjectWidth > 150 && r.subject.includes("地龙")) && scroll.scrollWidth <= scroll.clientWidth + 1, { count: found.length, sample: found.slice(0, 3), scroll, shot: await shot("search-subjects") });
    await click(`window.__f.button('清除')`);
    await waitUntil(`!window.__f.count().includes('读取中') && window.__f.rows().some((r) => r.subject.endsWith('long path'))`);

    // 2. 三栏拖动
    const w0 = { left: await evaluate(`window.__f.width('.log-branches')`), right: await evaluate(`window.__f.width('.log-detail')`) };
    await evaluate(`window.__f.drag('left', 120)`); await sleep(200);
    await evaluate(`window.__f.drag('right', -100)`); await sleep(200);
    const w1 = { left: await evaluate(`window.__f.width('.log-branches')`), right: await evaluate(`window.__f.width('.log-detail')`) };
    const saved = await evaluate(`localStorage.getItem('oris.historyColumns.v1')`);
    check("反馈 2：拖动分隔条调整左右两栏宽度并保存", Math.abs(w1.left - w0.left - 120) <= 2 && Math.abs(w1.right - w0.right - 100) <= 2 && JSON.parse(saved).left === w1.left, { w0, w1, saved, shot: await shot("columns-dragged") });

    // 3. 路径：超框时显示末尾，放得下时左对齐
    await evaluate(`[...document.querySelectorAll('.log-row')].find((r) => r.querySelector('.log-subject').textContent.endsWith('long path')).click()`);
    await waitUntil(`[...document.querySelectorAll('.log-detail .log-file-path')].some((n) => n.textContent.includes('the-file-name'))`);
    await evaluate(`window.__f.drag('right', 180)`); await sleep(300); // 收窄详情栏，让长路径超框
    const longPath = await evaluate(`window.__f.pathOf('.log-detail .log-file-path', 'the-file-name')`);
    const shortPath = await evaluate(`window.__f.pathOf('.log-detail .log-file-path', 'short.txt')`);
    check("反馈 3：详情栏路径超框时显示末尾（省略号在开头），放得下时左对齐", longPath?.overflow && longPath.tailVisible && longPath.headClipped && shortPath && !shortPath.overflow && shortPath.leftAligned, { longPath, shortPath, shot: await shot("path-tail") });
    // 以上都是浏览：仓库不变。
    const unchanged = evidence("浏览（单击筛选、搜索、折叠、拖动、选择提交）", work, before, repositoryFingerprint(work));
    // 其他位置：主阅读器标题、左侧文件列表
    put(work, LONG, "long changed\n"); put(work, "short.txt", "short changed\n");
    await refresh();
    await waitUntil(`!!window.__op.row(${q(LONG)})`, 20000);
    await evaluate(`window.__op.row(${q(LONG)}).click()`); await sleep(600);
    const inTree = await evaluate(`window.__f.pathOf('.file .file-path', 'the-file-name')`);
    const inTabbar = await evaluate(`window.__f.path(document.querySelector('.tabbar .path-text'))`);
    const shortInTree = await evaluate(`window.__f.pathOf('.file .file-path', 'short.txt')`);
    check("反馈 3（举一反三）：文件列表与阅读器标题的路径同样左对齐 / 超框显示末尾", inTree && (!inTree.overflow || inTree.tailVisible) && inTabbar && (!inTabbar.overflow || inTabbar.tailVisible) && inTabbar.leftAligned === !inTabbar.overflow && shortInTree?.leftAligned, { inTree, inTabbar, shortInTree, shot: await shot("path-elsewhere") });

    // 7. Stash 并入左侧：储藏、查看、弹出
    let stashBefore = repositoryFingerprint(work);
    await click(`window.__f.button('储藏…')`);
    await waitUntil(`!!document.querySelector('.stash-form')`);
    await evaluate(`window.__f.setIn('.stash-form input[aria-label="stash 说明"]', 'from sidebar')`);
    await click(`window.__f.button('储藏', document.querySelector('.stash-form'))`); await settle();
    await waitUntil(`window.__f.names('stash').some((n) => n.includes('from sidebar'))`, 15000);
    const stashed = git(work, ["stash", "list"]);
    evidence("储藏", work, stashBefore, repositoryFingerprint(work));
    await click(`[...document.querySelectorAll('.log-stash')][0]`);
    await waitUntil(`document.querySelector('.stash-detail')?.textContent.includes('已跟踪文件 · 2')`);
    const detail = await evaluate(`document.querySelector('.stash-detail').textContent`);
    stashBefore = repositoryFingerprint(work);
    await click(`window.__f.button('弹出', document.querySelector('.stash-detail'))`); await settle();
    await waitUntil(`window.__f.names('stash').length === 0`, 15000);
    evidence("弹出", work, stashBefore, repositoryFingerprint(work));
    check("反馈 7：Stash 在左侧分组中储藏、查看内容、弹出", stashed.includes("from sidebar") && detail.includes("stash@{0}") && git(work, ["stash", "list"]) === "" && readFileSync(path.join(work, "short.txt"), "utf8") === "short changed\n", { stashed, shot: await shot("stash-sidebar") });
    git(work, ["checkout", "--", "."]); await refresh();

    // 4. 双击切换分支（单击只筛选）
    const clickBefore = repositoryFingerprint(work);
    await click(`window.__f.row('local', 'feature')`); await sleep(400);
    const clickOnly = evidence("单击本地分支", work, clickBefore, repositoryFingerprint(work));
    const afterClick = git(work, ["branch", "--show-current"]);
    await evaluate(`window.__f.dbl(window.__f.row('local', 'feature'))`); await settle();
    await waitUntil(`document.querySelector('.log-current')?.textContent.includes('feature')`, 15000);
    const afterDbl = git(work, ["branch", "--show-current"]);
    await evaluate(`window.__f.dbl(window.__f.row('remote:origin', 'remote-only'))`); await settle();
    await waitUntil(`document.querySelector('.log-current')?.textContent.includes('remote-only')`, 15000);
    const tracked = git(work, ["rev-parse", "--abbrev-ref", "remote-only@{u}"], { allowFail: true });
    check("反馈 4：单击只筛选（不改仓库），双击本地分支切换，双击远端分支建立跟踪分支并切换", unchanged.changedCount === 0 && clickOnly.changedCount === 0 && afterClick === "main" && afterDbl === "feature" && git(work, ["branch", "--show-current"]) === "remote-only" && tracked === "origin/remote-only", { unchanged, clickOnly, afterClick, afterDbl, tracked, shot: await shot("double-click-switch") });
  } catch (error) {
    fail(`验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await shot("failure"); } catch { /* ignore */ }
  } finally {
    try { app.cdp.close(); } catch { /* 已关闭 */ }
    const result = await killOris({ ...app });
    log(`测试实例 PID ${app.pid} 已结束：${result.how}`);
    report.stop = result;
  }
}

await main();
report.finishedAt = new Date().toISOString();
report.passed = report.failures.length === 0;
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
log(report.passed ? "全部检查通过" : `失败 ${report.failures.length} 项`, path.join(outDir, "report.json"));
if (!keep) log(removeDir(runDir, GUI_ROOT) ? `已清理 ${runDir}` : `未能完全清理 ${runDir}`);
process.exitCode = report.passed ? 0 : 1;
