// V2-03 界面验收：B09（stash）、B10（分支与检出、stash 后切换）、B16（外部锁）、B17（只读回归）、切换后刷新（M4）。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 点击与输入是 CDP 注入的页面事件，不是真实鼠标、键盘或系统焦点。
// 每个写操作都记录操作前后的仓库指纹（index、HEAD 与本地分支、stash、远端跟踪引用、config、工作区；不含 .git/objects 与 .git/logs）。
// 用法：node scripts/perf/v2-03-acceptance.mjs --exe <oris.exe> [--port 9901] [--keep]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
let port = Number(option("port", 9901));
const keep = args.includes("--keep");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v2-03-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v2-03-acceptance-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), startedAt: new Date().toISOString(), runDir, method: "CDP 页面事件（点击、输入）；不是真实鼠标、键盘或系统焦点。仓库指纹为 .git（不含 objects/logs）与工作区逐文件 SHA-256。", checks: {}, operations: [], processes: {}, failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)}`); };

const fingerprint = (repo) => repositoryFingerprint(repo);
function categorize(keys) {
  return [...new Set(keys.map((k) => k === ".git/index" ? "index"
    : (k === ".git/HEAD" || k.startsWith(".git/refs/heads/")) ? "head"
    : k === ".git/refs/stash" ? "stash"
    : (k.startsWith(".git/refs/remotes/") || k.startsWith(".git/refs/tags/") || k === ".git/packed-refs") ? "remote-refs"
    : k === ".git/config" ? "config"
    : k.startsWith(".git/") ? `git:${k.slice(5)}` : "worktree"))].sort();
}
const BENIGN = new Set(["git:ORIG_HEAD", "git:AUTO_MERGE"]);
function evidence(name, repo, before, after, allowed) {
  const changed = diffFingerprints(before, after);
  const categories = categorize(changed);
  const unexpected = categories.filter((c) => !allowed.includes(c) && !BENIGN.has(c));
  const entry = { name, repo, beforeDigest: before.digest, afterDigest: after.digest, changed: changed.slice(0, 40), changedCount: changed.length, categories, allowed, unexpected };
  report.operations.push(entry);
  return entry;
}

// ---------- 夹具 ----------
const put = (repo, rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
const read = (repo, rel) => readFileSync(path.join(repo, rel), "utf8");
const configure = (repo) => { for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, ["config", key, value]); };
const commitAll = (repo, message) => { git(repo, ["add", "-A"]); const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: repo, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return git(repo, ["rev-parse", "HEAD"]); };
const stashLines = (repo) => git(repo, ["stash", "list"], { allowFail: true }).split("\n").filter(Boolean);

function fixture() {
  const seed = path.join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]); configure(seed);
  put(seed, "a.txt", "a base\n"); put(seed, "b.txt", "b base\n"); put(seed, "only-main.txt", "main only\n"); commitAll(seed, "base");
  git(seed, ["switch", "-q", "-c", "feature"]); put(seed, "a.txt", "a on feature\n"); git(seed, ["rm", "-q", "only-main.txt"]); commitAll(seed, "feature work");
  git(seed, ["switch", "-q", "-c", "remote-only", "main"]); put(seed, "r.txt", "remote only\n"); commitAll(seed, "remote only");
  git(seed, ["switch", "-q", "main"]);
  const bare = path.join(runDir, "remote.git");
  git(runDir, ["clone", "-q", "--bare", seed, bare]);
  const work = path.join(runDir, "work");
  git(runDir, ["clone", "-q", bare, work]); configure(work);
  git(work, ["branch", "-q", "--track", "feature", "origin/feature"]);
  return { bare, work };
}

// ---------- 页面辅助 ----------
const H = String.raw`
(() => {
  if (window.__b) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const setValue = (el, value) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  window.__b = {
    button(text, root = document) { return qa('button', root).find((b) => b.textContent === text) ?? null; },
    gitTab(prefix) { return qa('.git-tabs button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    branchButton() { return document.querySelector('.branch-button'); },
    popover() { return document.querySelector('.branch-popover'); },
    branchRow(name) { return qa('.branch-row').find((r) => r.querySelector('.branch-row-name')?.textContent.replace(/^● /, '') === name) ?? null; },
    branchNames() { return qa('.branch-row .branch-row-name').map((n) => n.textContent); },
    rowButton(name, text) { const row = window.__b.branchRow(name); return row ? qa('button', row).find((b) => b.textContent === text) ?? null : null; },
    dialog() { return document.querySelector('.branch-dialog') ?? document.querySelector('.confirm-dialog'); },
    dialogText() { return window.__b.dialog()?.textContent ?? null; },
    setIn(root, selector, value) { const el = root.querySelector(selector); if (!el) throw new Error('没有 ' + selector); setValue(el, value); },
    check(root, selector, on) { const el = root.querySelector(selector); if (el.checked !== on) el.click(); },
    opStatus() { const n = document.querySelector('.op-status'); return n ? { cls: n.className, text: n.textContent } : null; },
    running() { return !!document.querySelector('.op-status.running'); },
    branchLabel() { return window.__b.branchButton()?.textContent ?? ''; },
    stashRows() { return qa('.log-stash').map((r) => ({ text: r.textContent ?? '', selected: r.getAttribute('aria-selected') === 'true' })); },
    stashRow(i) { return qa('.log-stash')[i] ?? null; },
    stashDetail() { return document.querySelector('.stash-detail'); },
    stashForm() { return document.querySelector('.stash-form'); },
    stashFiles() { return qa('.stash-detail .log-file').map((b) => b.textContent); },
    stashFile(name) { return qa('.stash-detail .log-file').find((b) => b.querySelector('.log-file-path')?.textContent === name) ?? null; },
    detail() { return document.querySelector('.stash-detail')?.textContent ?? ''; },
    badge() { return document.querySelector('.history-badge')?.textContent ?? null; },
    banner() { return document.querySelector('.detached-banner')?.textContent ?? null; },
    notice() { return document.querySelector('.selection-notice, .notice')?.textContent ?? document.querySelector('.content')?.textContent ?? ''; },
    editorText() { return qa('.cm-content').map((n) => n.textContent).join('\n'); },
    conflictToolbar() { return !!document.querySelector('.conflict-toolbar'); },
    logRow() { return document.querySelector('.log-row'); },
    context(el) { const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 8 })); },
    menuItem(prefix) { return qa('.log-menu button').find((b) => b.textContent.startsWith(prefix)) ?? null; }
  };
  return true;
})()`;

async function start(profile, extraEnv = {}) {
  const app = await launchOris({ exe, profileDir: path.join(runDir, "profiles", profile), port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, `${profile}-cache`), ...extraEnv } });
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS + ";" + H });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS); await evaluate(H);
  log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const shot = async (name) => { const file = path.join(shotDir, `${name}.png`); writeFileSync(file, await app.cdp.screenshot()); return path.relative(projectRoot, file); };
  const click = async (expr) => { await evaluate(`(() => { const el = ${expr}; if (!el) throw new Error('找不到元素：' + ${q(expr)}); if (el.disabled) throw new Error('元素不可用：' + ${q(expr)} + ' ' + el.title); el.click(); return true; })()`); await sleep(150); };
  const settle = (timeout = 30000) => waitUntil(`!window.__b.running() && !window.__op.loading()`, timeout);
  const addProject = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 30000);
    await sleep(400);
  };
  const refresh = async () => { await evaluate(`window.__op.button('↻ 本地刷新').click()`); await sleep(300); await waitUntil(`!window.__op.loading()`); await sleep(600); };
  const openPopover = async () => { if (!(await evaluate(`!!window.__b.popover()`))) await click(`window.__b.branchButton()`); await waitUntil(`window.__b.branchNames().length > 0`); };
  const openTab = async (prefix) => { if (!(await evaluate(`window.__b.gitTab(${q(prefix)})?.classList.contains('active')`))) await click(`window.__b.gitTab(${q(prefix)})`); await sleep(300); };
  const confirmDialog = async (label) => { await waitUntil(`!!document.querySelector('.confirm-dialog')`); await click(`window.__b.button(${q(label)}, document.querySelector('.confirm-dialog'))`); };
  return { app, evaluate, waitUntil, shot, click, settle, addProject, refresh, openPopover, openTab, confirmDialog };
}
async function stop(ctx) {
  try { ctx.app.cdp.close(); } catch { /* 已关闭 */ }
  const result = await killOris({ ...ctx.app });
  log(`测试实例 PID ${ctx.app.pid} 已结束：${result.how}`);
  return result;
}
const traceCommands = (dir, names) => [...names].map((name) => {
  try {
    const first = readFileSync(path.join(dir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.event === "start");
    return (first?.argv ?? []).slice(1).filter((a) => !a.startsWith("-c") && !/^core\.|^diff\.|^[A-Z]:/i.test(a) && a !== "-C" && a !== "--no-optional-locks").join(" ");
  } catch { return "?"; }
});

async function main() {
  const traceDir = path.join(runDir, "trace");
  mkdirSync(traceDir, { recursive: true });
  const { work } = fixture();
  report.fixtures = { work };
  const ctx = await start("v2-03", { GIT_TRACE2_EVENT: traceDir });
  const traces = () => new Set(readdirSync(traceDir));
  const traced = async (name, action) => {
    const before = traces();
    const result = await action();
    await sleep(1500);
    const added = [...traces()].filter((f) => !before.has(f));
    report.processes[name] = { count: added.length, commands: traceCommands(traceDir, added).sort() };
    return result;
  };
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    await ctx.addProject(work);
    // ---------- B17 只读：弹层、Stash 页、对话框打开再取消 ----------
    let before = fingerprint(work);
    await ctx.openPopover();
    await ctx.evaluate(`window.__b.setIn(window.__b.popover(), 'input', 'fea')`); await sleep(200);
    const filtered = await ctx.evaluate(`window.__b.branchNames()`);
    await ctx.evaluate(`window.__b.setIn(window.__b.popover(), 'input', '')`); await sleep(200);
    const allNames = await ctx.evaluate(`window.__b.branchNames()`);
    await ctx.click(`window.__b.button('＋ 新建分支…')`);
    await ctx.waitUntil(`!!window.__b.dialog()`);
    await ctx.click(`window.__b.button('取消', window.__b.dialog())`);
    await ctx.openTab("历史");
    await ctx.waitUntil(`!!document.querySelector('[data-group="stash"]')`);
    let e = evidence("B17 浏览分支弹层、打开新建对话框后取消、打开历史页（Stash 分组）", work, before, fingerprint(work), []);
    check("B10 分支弹层：搜索过滤，本地 / 远端分组；B17 浏览与打开对话框不改仓库", filtered.every((n) => n.includes("fea")) && allNames.map((n) => n.replace("● ", "")).includes("main") && allNames.includes("origin/remote-only") && e.changedCount === 0, { filtered, allNames, e, shot: await ctx.shot("b10-popover") });

    // ---------- B09 stash ----------
    put(work, "a.txt", "a local change\n"); put(work, "b.txt", "b staged change\n"); git(work, ["add", "b.txt"]); put(work, "u.txt", "untracked note\n");
    await ctx.refresh();
    before = fingerprint(work);
    await ctx.click(`window.__b.button('储藏…')`); await ctx.waitUntil(`!!window.__b.stashForm()`);
    await ctx.evaluate(`window.__b.setIn(document.querySelector('.stash-form'), 'input[aria-label="stash 说明"]', 'wip one')`);
    await traced("stash push（不含未跟踪）", async () => { await ctx.click(`window.__b.button('储藏', window.__b.stashForm())`); await ctx.settle(); });
    await ctx.waitUntil(`window.__b.stashRows().length === 1`);
    e = evidence("stash push 不含未跟踪", work, before, fingerprint(work), ["index", "stash", "worktree"]);
    check("B09 储藏（说明、不含未跟踪）：已跟踪改动与暂存移入 stash，未跟踪保留", e.unexpected.length === 0 && read(work, "a.txt") === "a base\n" && existsSync(path.join(work, "u.txt")) && git(work, ["status", "--porcelain"]) === "?? u.txt" && stashLines(work)[0].includes("wip one"), { e, rows: await ctx.evaluate(`window.__b.stashRows()`) });
    // 只储藏选中的文件（含未跟踪）：在文件列表中选中 u.txt。
    await ctx.waitUntil(`!!window.__op.row('u.txt')`, 20000); await ctx.evaluate(`window.__op.row('u.txt').click()`); await sleep(300);
    await ctx.click(`window.__b.button('储藏…')`); await ctx.waitUntil(`!!window.__b.stashForm()`);
    await ctx.evaluate(`window.__b.check(document.querySelector('.stash-form'), 'input[aria-label=包含未跟踪文件]', true); window.__b.check(document.querySelector('.stash-form'), 'input[aria-label=只储藏选中的文件]', true)`);
    await ctx.evaluate(`window.__b.setIn(document.querySelector('.stash-form'), 'input[aria-label="stash 说明"]', 'only untracked')`);
    put(work, "a.txt", "a second change\n");
    await ctx.refresh();
    await ctx.waitUntil(`!!window.__op.row('u.txt')`, 20000); await ctx.evaluate(`window.__op.row('u.txt').click()`); await sleep(300);
    before = fingerprint(work);
    await traced("stash push（只储藏选中、含未跟踪）", async () => { await ctx.click(`window.__b.button('储藏', window.__b.stashForm())`); await ctx.settle(); });
    await ctx.waitUntil(`window.__b.stashRows().length === 2`);
    e = evidence("stash push 只储藏选中的未跟踪文件", work, before, fingerprint(work), ["stash", "worktree", "index"]);
    check("B09 只储藏选中的文件（含未跟踪）：只移走 u.txt，a.txt 的改动保留", e.unexpected.length === 0 && !existsSync(path.join(work, "u.txt")) && read(work, "a.txt") === "a second change\n", { e });
    // 查看：未跟踪部分单独列出，在同一个 diff 阅读器中打开。
    await ctx.click(`window.__b.stashRow(0)`);
    await ctx.waitUntil(`window.__b.detail().includes('未跟踪文件 · 1')`);
    await ctx.click(`window.__b.stashFile('u.txt')`);
    await ctx.waitUntil(`window.__op.tab() === 'u.txt' && !window.__op.loading()`);
    await sleep(300);
    const untrackedView = { badge: await ctx.evaluate(`window.__b.badge()`), text: await ctx.evaluate(`window.__b.editorText()`) };
    await ctx.click(`window.__b.stashRow(1)`);
    await ctx.waitUntil(`window.__b.stashFiles().length === 2`);
    await ctx.click(`window.__b.stashFile('a.txt')`);
    await ctx.waitUntil(`window.__op.tab() === 'a.txt' && !window.__op.loading()`);
    await sleep(300);
    const trackedText = await ctx.evaluate(`window.__b.editorText()`);
    check("B09 查看 stash：已跟踪部分相对储藏时的 HEAD，未跟踪部分单独列出，都在同一个 diff 阅读器中", untrackedView.badge?.includes("未跟踪") && untrackedView.text.includes("untracked note") && trackedText.includes("a local change") && trackedText.includes("a base"), { untrackedView, trackedText: trackedText.slice(0, 120), shot: await ctx.shot("b09-stash-view") });
    await ctx.click(`window.__b.button('← 返回本地变化')`).catch(() => {});
    // 应用 stash@{1}（wip one）会与 a.txt 的当前改动冲突：先把当前改动恢复。
    git(work, ["checkout", "--", "a.txt"]);
    await ctx.refresh();
    before = fingerprint(work);
    await traced("stash apply", async () => { await ctx.click(`window.__b.stashRow(1)`); await ctx.click(`window.__b.button('应用', window.__b.stashDetail())`); await ctx.settle(); });
    e = evidence("stash apply stash@{1}", work, before, fingerprint(work), ["worktree", "index"]);
    check("B09 应用：改动恢复，stash 保留在列表中", e.unexpected.length === 0 && read(work, "a.txt") === "a local change\n" && stashLines(work).length === 2 && (await ctx.evaluate(`window.__b.opStatus()?.text`)).includes("已应用"), { e });
    // 列表在外部被修改：命令行再储藏一条，随即在（尚未刷新的）列表上删除原来的 stash@{0}。
    const oldTop = git(work, ["rev-parse", "stash@{0}"]);
    await ctx.click(`window.__b.stashRow(0)`);
    git(work, ["stash", "push", "-q", "-m", "external stash"]);
    before = fingerprint(work);
    await ctx.evaluate(`window.__b.button('删除…', window.__b.stashDetail()).click()`);
    await ctx.confirmDialog("删除 stash");
    await ctx.settle();
    const rejected = await ctx.evaluate(`window.__b.opStatus()`);
    await ctx.waitUntil(`window.__b.stashRows().length === 3`, 15000);
    e = evidence("列表在外部被修改后 drop 被拒绝", work, before, fingerprint(work), []);
    const raced = !rejected?.text.includes("已不是列表中的那一条");
    check("B09 列表在外部被修改：拒绝执行（或列表已先刷新），没有删除任何 stash，列表刷新为 3 条", e.changedCount === 0 && stashLines(work).length === 3 && git(work, ["rev-parse", "stash@{1}"]) === oldTop, { rejected, raced, e });
    report.stashIdentityRace = raced ? "watcher 事件先于点击到达，列表已刷新，界面删除的是刷新后的 stash@{0}？见 e" : "后端核对身份后拒绝";
    // 冲突：stash@{0}（external stash，改 a.txt）在 HEAD 已提交不同内容后弹出。
    put(work, "a.txt", "committed differently\n"); commitAll(work, "diverge a");
    await ctx.refresh();
    const externalOid = git(work, ["rev-parse", "stash@{0}"]);
    before = fingerprint(work);
    await ctx.click(`window.__b.stashRow(0)`);
    await traced("stash pop（冲突）", async () => { await ctx.click(`window.__b.button('弹出', window.__b.stashDetail())`); await ctx.settle(); });
    const conflictStatus = await ctx.evaluate(`window.__b.opStatus()`);
    await ctx.waitUntil(`!!window.__op.row('a.txt')`);
    await ctx.waitUntil(`!!window.__op.row('a.txt')`, 20000); await ctx.evaluate(`window.__op.row('a.txt').click()`); await sleep(800);
    e = evidence("stash pop 冲突", work, before, fingerprint(work), ["worktree", "index"]);
    check("B09 弹出时冲突：stash 保留，进入只读冲突查看（Base / stage 2 / stage 3）", conflictStatus.cls.includes("failed") && conflictStatus.text.includes("冲突") && stashLines(work).length === 3 && git(work, ["rev-parse", "stash@{0}"]) === externalOid && git(work, ["ls-files", "-u"]).length > 0 && (await ctx.evaluate(`window.__b.conflictToolbar()`)) && e.unexpected.length === 0, { conflictStatus, e, shot: await ctx.shot("b09-pop-conflict") });
    // 在外部解决后，用户自行决定删除这条 stash。
    git(work, ["checkout", "--theirs", "--", "a.txt"]); git(work, ["reset", "-q"]); git(work, ["checkout", "--", "a.txt"]);
    await ctx.refresh();
    before = fingerprint(work);
    await ctx.click(`window.__b.stashRow(0)`);
    await ctx.click(`window.__b.button('删除…', window.__b.stashDetail())`);
    const dropDialog = await ctx.evaluate(`document.querySelector('.confirm-dialog')?.textContent ?? ''`);
    await ctx.confirmDialog("删除 stash");
    await ctx.settle();
    e = evidence("stash drop", work, before, fingerprint(work), ["stash"]);
    check("B09 删除（确认，标明无法撤销）：只改 refs/stash", dropDialog.includes("无法撤销") && e.unexpected.length === 0 && stashLines(work).length === 2 && !stashLines(work).some((l) => l.includes("external stash")), { e, dropDialog });
    // 弹出成功：应用并删除。
    git(work, ["reset", "-q", "--hard"]); git(work, ["clean", "-fdq"]);
    await ctx.refresh();
    before = fingerprint(work);
    // 刷新后分支 / stash 列表会重新读取：等列表稳定为 2 条、选中第 0 条且详情可用后再弹出（记录选中到详情可用的时间）。
    await ctx.waitUntil(`window.__b.stashRows().length === 2`, 15000);
    const popSelectAt = Date.now();
    await ctx.click(`window.__b.stashRow(0)`);
    await ctx.waitUntil(`window.__b.stashRows()[0]?.selected && window.__b.stashDetail() && window.__b.button('弹出', window.__b.stashDetail()) && !window.__b.button('弹出', window.__b.stashDetail()).disabled`, 15000);
    report.popDetailReadyMs = Date.now() - popSelectAt;
    await ctx.click(`window.__b.button('弹出', window.__b.stashDetail())`);
    await ctx.settle();
    e = evidence("stash pop 成功", work, before, fingerprint(work), ["stash", "worktree", "index"]);
    check("B09 弹出：应用成功后从列表删除（含未跟踪部分恢复）", e.unexpected.length === 0 && stashLines(work).length === 1 && existsSync(path.join(work, "u.txt")), { e });
    git(work, ["reset", "-q", "--hard"]); git(work, ["clean", "-fdq"]); git(work, ["stash", "clear"]);
    await ctx.refresh();

    // ---------- B10 分支 ----------
    await ctx.openPopover();
    await ctx.click(`window.__b.button('＋ 新建分支…')`);
    await ctx.waitUntil(`!!window.__b.dialog()`);
    await ctx.evaluate(`window.__b.setIn(window.__b.dialog(), 'input[aria-label=新分支名]', 'bad name')`);
    await ctx.waitUntil(`window.__b.dialogText().includes('无效')`);
    const badDisabled = await ctx.evaluate(`window.__b.button('新建并切换', window.__b.dialog()).disabled`);
    await ctx.evaluate(`window.__b.setIn(window.__b.dialog(), 'input[aria-label=新分支名]', 'topic-new')`);
    await ctx.waitUntil(`!window.__b.button('新建并切换', window.__b.dialog()).disabled`);
    // 起点选 origin/main（与远端一致），之后作为“已合并分支”删除。
    await ctx.evaluate(`window.__b.setIn(window.__b.dialog(), 'select', 'refs/remotes/origin/main')`);
    await ctx.evaluate(`window.__b.check(window.__b.dialog(), 'input[aria-label=创建后立即切换]', false)`); await sleep(100);
    before = fingerprint(work);
    await traced("新建分支（不切换）", async () => { await ctx.click(`window.__b.button('新建', window.__b.dialog())`); await ctx.settle(); });
    e = evidence("新建分支 topic-new（不切换）", work, before, fingerprint(work), ["head"]);
    check("B10 新建分支：分支名按 Git 规则校验；从选中的起点（origin/main）新建且不切换，只新增 refs/heads/topic-new", badDisabled && e.unexpected.length === 0 && e.changed.join() === ".git/refs/heads/topic-new" && git(work, ["branch", "--show-current"]) === "main" && git(work, ["rev-parse", "topic-new"]) === git(work, ["rev-parse", "origin/main"]), { e });
    // 切换本地分支 feature：a.txt 在两个分支都存在，阅读位置保持。
    put(work, "notes.txt", "untracked notes\n");
    await ctx.refresh();
    await ctx.waitUntil(`!!window.__op.row('notes.txt')`, 20000); await ctx.evaluate(`window.__op.row('notes.txt').click()`); await sleep(400);
    await ctx.openPopover();
    before = fingerprint(work);
    await traced("切换本地分支", async () => { await ctx.click(`window.__b.rowButton('feature', '切换')`); await ctx.settle(); });
    e = evidence("切换到 feature", work, before, fingerprint(work), ["head", "index", "worktree"]);
    const keptTab = await ctx.evaluate(`window.__op.tab()`);
    check("B10 / M4 切换本地分支：HEAD 与工作区切到 feature；阅读的文件仍存在时保持阅读位置", e.unexpected.length === 0 && git(work, ["branch", "--show-current"]) === "feature" && read(work, "a.txt") === "a on feature\n" && keptTab === "notes.txt" && (await ctx.evaluate(`window.__b.branchLabel()`)).includes("feature"), { e, keptTab, shot: await ctx.shot("b10-switched") });
    // 远端分支：建立同名本地跟踪分支。
    await ctx.openPopover();
    before = fingerprint(work);
    await traced("检出远端分支（跟踪）", async () => { await ctx.click(`window.__b.rowButton('origin/remote-only', '检出')`); await ctx.settle(); });
    e = evidence("检出 origin/remote-only", work, before, fingerprint(work), ["head", "index", "worktree", "config"]);
    check("B10 远端分支检出为同名本地跟踪分支", e.unexpected.length === 0 && git(work, ["branch", "--show-current"]) === "remote-only" && git(work, ["rev-parse", "--abbrev-ref", "remote-only@{u}"]) === "origin/remote-only", { e });
    // 同名本地分支已存在：让用户选择，这里换名新建。
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('origin/feature', '检出')`);
    await ctx.waitUntil(`window.__b.dialogText()?.includes('已存在同名本地分支')`);
    await ctx.evaluate(`window.__b.setIn(window.__b.dialog(), 'input[aria-label=跟踪分支名]', 'feature-2')`);
    await ctx.waitUntil(`!window.__b.button('新建跟踪分支', window.__b.dialog()).disabled`);
    before = fingerprint(work);
    await ctx.click(`window.__b.button('新建跟踪分支', window.__b.dialog())`);
    await ctx.settle();
    e = evidence("同名已存在时换名建立跟踪分支 feature-2", work, before, fingerprint(work), ["head", "index", "worktree", "config"]);
    check("B10 同名本地分支已存在：提示并让用户选择；换名 feature-2 跟踪 origin/feature", e.unexpected.length === 0 && git(work, ["rev-parse", "--abbrev-ref", "feature-2@{u}"]) === "origin/feature" && git(work, ["branch", "--show-current"]) === "feature-2", { e });
    // 重命名、设置上游。
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('feature-2', '更多 ▾')`);
    await ctx.click(`window.__b.button('重命名…')`);
    await ctx.waitUntil(`!!window.__b.dialog()`);
    await ctx.evaluate(`window.__b.setIn(window.__b.dialog(), 'input', 'feature-renamed')`);
    await ctx.waitUntil(`!window.__b.button('重命名', window.__b.dialog()).disabled`);
    before = fingerprint(work);
    await ctx.click(`window.__b.button('重命名', window.__b.dialog())`); await ctx.settle();
    e = evidence("重命名 feature-2 → feature-renamed", work, before, fingerprint(work), ["head", "config"]);
    check("B10 重命名本地分支（当前分支），上游配置随之移动", e.unexpected.length === 0 && git(work, ["branch", "--show-current"]) === "feature-renamed" && git(work, ["rev-parse", "--abbrev-ref", "feature-renamed@{u}"]) === "origin/feature", { e });
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('topic-new', '更多 ▾')`);
    await ctx.click(`window.__b.button('设置上游…')`);
    await ctx.waitUntil(`!!window.__b.dialog()`);
    await ctx.evaluate(`window.__b.setIn(window.__b.dialog(), 'select', 'refs/remotes/origin/main')`); await sleep(150);
    before = fingerprint(work);
    await ctx.click(`window.__b.button('设为上游', window.__b.dialog())`); await ctx.settle();
    e = evidence("设置 topic-new 的上游", work, before, fingerprint(work), ["config"]);
    check("B10 设置上游：只改 config", e.unexpected.length === 0 && git(work, ["rev-parse", "--abbrev-ref", "topic-new@{u}"]) === "origin/main", { e });
    // 删除：已合并（确认）与未合并（强确认）。
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('topic-new', '更多 ▾')`);
    await ctx.click(`window.__b.button('删除…')`);
    before = fingerprint(work);
    await ctx.confirmDialog("删除"); await ctx.settle();
    const mergedStatus = await ctx.evaluate(`window.__b.opStatus()`);
    const strongAsked = await ctx.evaluate(`!!document.querySelector('.confirm-dialog')`);
    e = evidence("删除已合并分支 topic-new", work, before, fingerprint(work), ["head", "config"]);
    check("B10 删除已合并分支：一次确认后删除（不需要强确认）", !strongAsked && e.unexpected.length === 0 && !git(work, ["branch", "--list", "topic-new"]), { e, mergedStatus, strongAsked });
    if (strongAsked) await ctx.click(`window.__b.button('取消', document.querySelector('.confirm-dialog'))`);
    git(work, ["branch", "-q", "unmerged", "HEAD"]);
    const tmp = path.join(runDir, "unmerged-wt"); git(work, ["worktree", "add", "-q", tmp, "unmerged"]); configure(tmp); put(tmp, "x.txt", "x\n"); const unmergedTip = commitAll(tmp, "unmerged work"); git(work, ["worktree", "remove", "--force", tmp]);
    await ctx.refresh();
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('unmerged', '更多 ▾')`);
    await ctx.click(`window.__b.button('删除…')`);
    before = fingerprint(work);
    await ctx.confirmDialog("删除");
    await ctx.waitUntil(`document.querySelector('.confirm-dialog')?.textContent.includes('reflog')`, 15000);
    const strong = await ctx.evaluate(`document.querySelector('.confirm-dialog').textContent`);
    const unchangedBeforeForce = evidence("未合并分支：确认前", work, before, fingerprint(work), []).changedCount === 0;
    await ctx.confirmDialog("仍然删除"); await ctx.settle();
    e = evidence("强制删除未合并分支", work, before, fingerprint(work), ["head"]);
    check("B10 删除未合并分支：二次强确认，说明提交之后只能通过 reflog 找回，确认后才删除", strong.includes(unmergedTip.slice(0, 8)) && unchangedBeforeForce && e.unexpected.length === 0 && !git(work, ["branch", "--list", "unmerged"]), { strong, e, shot: await ctx.shot("b10-delete-unmerged") });
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('feature-renamed', '更多 ▾')`);
    const currentDelete = await ctx.evaluate(`({ disabled: window.__b.button('删除…').disabled, title: window.__b.button('删除…').title })`);
    await ctx.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`); await sleep(200);
    check("B10 不能删除当前分支", currentDelete.disabled && currentDelete.title.includes("不能删除当前分支"), currentDelete);
    if (await ctx.evaluate(`!!window.__b.popover()`)) await ctx.click(`window.__b.branchButton()`);

    // ---------- 检出提交（分离 HEAD）与“从这里新建分支” ----------
    await ctx.openTab("历史");
    await ctx.waitUntil(`!!window.__b.logRow()`);
    const target = await ctx.evaluate(`window.__b.logRow().dataset.oid`);
    before = fingerprint(work);
    await ctx.evaluate(`window.__b.context(window.__b.logRow())`); await sleep(150);
    await traced("检出提交（分离 HEAD）", async () => { await ctx.click(`window.__b.menuItem('检出（分离 HEAD）')`); await ctx.settle(); });
    await ctx.waitUntil(`!!window.__b.banner()`, 15000);
    e = evidence("检出提交", work, before, fingerprint(work), ["head", "index", "worktree"]);
    const banner = await ctx.evaluate(`window.__b.banner()`);
    check("B10 日志右键“检出”：进入分离 HEAD，横幅常驻并提供“从这里新建分支”", e.unexpected.length === 0 && git(work, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }) === "" && git(work, ["rev-parse", "HEAD"]) === target && banner.includes("分离 HEAD"), { e, banner, shot: await ctx.shot("b10-detached") });
    await ctx.click(`window.__b.button('从这里新建分支…', document.querySelector('.detached-banner'))`);
    await ctx.waitUntil(`!!window.__b.dialog()`);
    await ctx.evaluate(`window.__b.setIn(window.__b.dialog(), 'input[aria-label=新分支名]', 'from-detached')`);
    await ctx.waitUntil(`!window.__b.button('新建并切换', window.__b.dialog()).disabled`);
    before = fingerprint(work);
    await ctx.click(`window.__b.button('新建并切换', window.__b.dialog())`); await ctx.settle();
    await ctx.waitUntil(`!window.__b.banner()`, 15000);
    e = evidence("从分离 HEAD 新建分支并切换", work, before, fingerprint(work), ["head"]);
    check("B10 从分离 HEAD 新建分支并切换，横幅消失", e.unexpected.length === 0 && git(work, ["branch", "--show-current"]) === "from-detached" && git(work, ["rev-parse", "HEAD"]) === target, { e });

    // ---------- stash 后切换 ----------
    git(work, ["switch", "-q", "main"]); await ctx.refresh();
    put(work, "a.txt", "local edit conflicting with feature\n");
    await ctx.refresh();
    await ctx.waitUntil(`!!window.__op.row('a.txt')`, 20000); await ctx.evaluate(`window.__op.row('a.txt').click()`); await sleep(300);
    before = fingerprint(work);
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('feature', '切换')`);
    await ctx.waitUntil(`document.querySelector('.confirm-dialog')?.textContent.includes('stash 后切换')`, 15000);
    const refuse = await ctx.evaluate(`document.querySelector('.confirm-dialog').textContent`);
    const untouched = evidence("Git 拒绝切换（尚未确认）", work, before, fingerprint(work), []).changedCount === 0;
    await traced("stash 后切换", async () => { await ctx.confirmDialog("stash 后切换"); await ctx.settle(); });
    const afterSwitch = await ctx.evaluate(`window.__b.opStatus()`);
    e = evidence("stash 后切换到 feature", work, before, fingerprint(work), ["head", "index", "worktree", "stash"]);
    const notice = await ctx.evaluate(`document.querySelector('.editor')?.textContent ?? ''`);
    check("B10 工作区改动阻止切换：说明原因（列出 a.txt）并提供“stash 后切换”；确认后储藏再切换，不自动恢复并提示可恢复", refuse.includes("a.txt") && refuse.includes("不会自动恢复") && untouched && e.unexpected.length === 0 && git(work, ["branch", "--show-current"]) === "feature" && read(work, "a.txt") === "a on feature\n" && stashLines(work)[0].includes("切换到 feature 前储藏") && afterSwitch.text.includes("没有自动恢复"), { refuse: refuse.slice(0, 300), afterSwitch, e });
    check("M4 切换后阅读的文件已不在变化列表：回到合法入口并提示", notice.includes("此前选中的文件已不在当前比较范围中"), { notice: notice.slice(0, 300), shot: await ctx.shot("m4-after-stash-switch") });
    // 未跟踪文件会被覆盖：确认后含未跟踪一并储藏。
    // 当前在 feature（没有 only-main.txt）：放一个同名未跟踪文件，切回 main 时会被覆盖。
    put(work, "only-main.txt", "untracked copy that main would overwrite\n");
    await ctx.refresh();
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('main', '切换')`);
    await ctx.waitUntil(`document.querySelector('.confirm-dialog')?.textContent.includes('包含未跟踪文件')`, 15000);
    before = fingerprint(work);
    await ctx.confirmDialog("stash 后切换"); await ctx.settle();
    e = evidence("stash（含未跟踪）后切换到 main", work, before, fingerprint(work), ["head", "index", "worktree", "stash"]);
    check("B10 未跟踪文件会被覆盖：确认后含未跟踪一并储藏再切换", e.unexpected.length === 0 && git(work, ["branch", "--show-current"]) === "main" && read(work, "only-main.txt") === "main only\n" && git(work, ["rev-parse", "-q", "--verify", "stash@{0}^3"], { allowFail: true }).length === 40, { e });

    // ---------- B16 外部 index.lock ----------
    const lock = path.join(work, ".git", "index.lock");
    writeFileSync(lock, "held by test");
    before = fingerprint(work);
    await ctx.openPopover();
    await ctx.click(`window.__b.rowButton('feature', '切换')`);
    await ctx.settle();
    const lockStatus = await ctx.evaluate(`window.__b.opStatus()`);
    e = evidence("外部 index.lock 时切换", work, before, fingerprint(work), []);
    check("B16 外部 index.lock：说明原因、不删除锁、仓库不变、不重试", lockStatus.cls.includes("failed") && lockStatus.text.includes("index.lock") && readFileSync(lock, "utf8") === "held by test" && e.changedCount === 0, { lockStatus, e });
    unlinkSync(lock);
  } catch (error) {
    fail(`验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await ctx.shot("failure"); } catch { /* ignore */ }
  } finally {
    report.stop = await stop(ctx);
  }
}

await main();
report.finishedAt = new Date().toISOString();
report.passed = report.failures.length === 0;
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
log(report.passed ? "全部检查通过" : `失败 ${report.failures.length} 项`, path.join(outDir, "report.json"));
if (!keep) log(removeDir(runDir, GUI_ROOT) ? `已清理 ${runDir}` : `未能完全清理 ${runDir}`);
process.exitCode = report.passed ? 0 : 1;
