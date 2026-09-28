// V2-04 界面验收：B11（pull / push）、B12（进度、取消、超时、认证失败）、B13（merge）、B14（不支持的进行中状态）、
// B16（外部锁）、B17（只读回归）、B18（凭据脱敏），以及真实远端 AgentHub 的 SSH / HTTPS fetch、pull、push 与推送被拒绝。
// 同步入口按 V2-D64（docs/design/06-sync-toolbar-ui.md）：标题栏获取 / 拉取 / 推送分体按钮，主按钮一键执行，▾ 放选项；
// 无法确定 remote 时弹出 .remote-choice-dialog，结果显示在 .sync-toast。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 点击与输入是 CDP 注入的页面事件，不是真实鼠标、键盘或系统焦点。
// 用法：node scripts/perf/v2-04-acceptance.mjs --exe <oris.exe> [--port 9951] [--only local|real] [--run-id 20260924-2031] [--keep]
//   --only real 需要 --run-id：在 %TEMP%\oris-remote\<run-id>\v2-04 下克隆 AgentHub，只创建 / 推送 / 删除 oris-test/<run-id>/ 分支。
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, processTree, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
let port = Number(option("port", 9951));
const only = option("only", "local");
const runId = option("run-id", null);
const keep = args.includes("--keep");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v2-04-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v2-04-acceptance-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const REMOTE_ROOT = realpathSync.native(tmpdir()) + path.sep + "oris-remote";
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), startedAt: new Date().toISOString(), runDir, method: "CDP 页面事件（点击、输入）；不是真实鼠标、键盘或系统焦点。仓库指纹为 .git（不含 objects/logs）与工作区逐文件 SHA-256。", environment: { GCM_INTERACTIVE: process.env.GCM_INTERACTIVE ?? null, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null, GIT_ASKPASS: process.env.GIT_ASKPASS ?? null }, checks: {}, operations: [], failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)}`); };

const fingerprint = (repo) => ({ ...repositoryFingerprint(repo), indexEntries: git(repo, ["ls-files", "-s"]) });
function categorize(keys) {
  return [...new Set(keys.map((k) => k === ".git/index" ? "index"
    : (k === ".git/HEAD" || k.startsWith(".git/refs/heads/")) ? "head"
    : k === ".git/refs/stash" ? "stash"
    : (k.startsWith(".git/refs/remotes/") || k.startsWith(".git/refs/tags/") || k === ".git/packed-refs") ? "remote-refs"
    : k === ".git/config" ? "config"
    : k.startsWith(".git/") ? `git:${k.slice(5)}` : "worktree"))].sort();
}
const BENIGN = new Set(["git:ORIG_HEAD", "git:AUTO_MERGE", "git:FETCH_HEAD"]);
/** 网络与合并类操作结束时的刷新允许回写 index 的 stat 缓存（V2-D09）：只有 `ls-files -s` 条目完全不变时才允许 index 字节变化。 */
const indexEntries = (repo) => git(repo, ["ls-files", "-s"]);
function evidence(name, repo, before, allowed, extra = {}) {
  if (before.indexEntries !== undefined && !allowed.includes("index") && indexEntries(repo) === before.indexEntries) allowed = [...allowed, "index"];
  const after = fingerprint(repo);
  const changed = diffFingerprints(before, after);
  const categories = categorize(changed);
  const unexpected = categories.filter((c) => !allowed.includes(c) && !BENIGN.has(c));
  const entry = { name, repo, beforeDigest: before.digest, afterDigest: after.digest, changed: changed.slice(0, 40), changedCount: changed.length, categories, allowed, unexpected, ...extra };
  report.operations.push(entry);
  return entry;
}

// ---------- 夹具 ----------
const put = (repo, rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
const read = (repo, rel) => readFileSync(path.join(repo, rel), "utf8");
const configure = (repo) => { for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, ["config", key, value]); };
const commitAll = (repo, message) => { git(repo, ["add", "-A"]); const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: repo, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return git(repo, ["rev-parse", "HEAD"]); };
const bareRef = (bare, name) => { const r = spawnSync("git", ["--git-dir", bare, "rev-parse", "-q", "--verify", name], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const parents = (repo, rev) => git(repo, ["rev-list", "--parents", "-n", "1", rev, "--"]).split(/\s+/).length - 1;

function localFixture() {
  const seed = path.join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]); configure(seed);
  put(seed, "a.txt", "base\n"); commitAll(seed, "base");
  const bare = path.join(runDir, "remote.git");
  git(runDir, ["clone", "-q", "--bare", seed, bare]);
  const local = path.join(runDir, "local");
  const other = path.join(runDir, "other");
  for (const clone of [local, other]) { git(runDir, ["clone", "-q", bare, clone]); configure(clone); }
  return { bare, local, other };
}

// ---------- 页面辅助 ----------
const H = String.raw`
(() => {
  if (window.__s) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const setValue = (el, value) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  window.__s = {
    button(text, root = document) { return qa('button', root).find((b) => b.textContent === text) ?? null; },
    /** 标题栏分体按钮（V2-D64）：kind 为 fetch / pull / push；main 直接执行，more 为 ▾。 */
    main(kind) { return document.querySelector('.sync-' + kind + ' .sync-main'); },
    more(kind) { return document.querySelector('.sync-' + kind + ' .sync-more'); },
    menu() { return document.querySelector('.sync-menu'); },
    menuText() { return window.__s.menu()?.textContent ?? ''; },
    /** 菜单项按主文字匹配（不含 ● 与说明小字）。 */
    menuItem(text) { return qa('.sync-menu [role^=menuitem]').find((b) => (b.lastElementChild?.firstChild?.textContent ?? '') === text) ?? null; },
    menuItems() { return qa('.sync-menu [role^=menuitem]').map((b) => ({ text: b.lastElementChild?.firstChild?.textContent ?? '', checked: b.getAttribute('aria-checked'), disabled: b.disabled })); },
    toast() { const t = document.querySelector('.sync-toast'); return t ? { cls: t.className, text: t.querySelector('.sync-toast-text')?.textContent ?? '', actions: qa('button', t).map((b) => b.textContent).filter((x) => x !== '×') } : null; },
    toastButton(text) { const t = document.querySelector('.sync-toast'); return t ? window.__s.button(text, t) : null; },
    remoteChoice() { return document.querySelector('.remote-choice-dialog'); },
    dialog(cls) { return document.querySelector(cls ?? '.branch-dialog, .confirm-dialog'); },
    setIn(root, selector, value) { const el = root.querySelector(selector); if (!el) throw new Error('没有 ' + selector); setValue(el, value); },
    opStatus() { const n = document.querySelector('.op-status'); return n ? { cls: n.className, text: n.textContent } : null; },
    running() { return !!document.querySelector('.op-status.running'); },
    /** 领先 / 落后（原 .branch-counts，V2-D64 后在推送 / 拉取主按钮上）：格式 "↑a ↓b"；没有上游或执行中时为 null。 */
    counts() { const up = document.querySelector('.sync-push .sync-main .sync-count')?.textContent; const down = document.querySelector('.sync-pull .sync-main .sync-count')?.textContent; return up && down ? up + ' ' + down : null; },
    banner() { return document.querySelector('.merge-banner')?.textContent ?? null; },
    opBanner() { return document.querySelector('.op-banner')?.textContent ?? null; },
    branchRow(name) { return qa('.branch-row').find((r) => r.querySelector('.branch-row-name')?.textContent.replace(/^● /, '') === name) ?? null; },
    rowButton(name, text) { const row = window.__s.branchRow(name); return row ? qa('button', row).find((b) => b.textContent === text) ?? null : null; },
    fileRowButton(path, text) { const row = window.__op.row(path); return row ? qa('button', row).find((b) => b.textContent === text) ?? null : null; },
    outputText() { return document.querySelector('.output-main')?.textContent ?? ''; },
    gitTab(prefix) { return qa('.git-tabs button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    conflictToolbar() { return !!document.querySelector('.conflict-toolbar'); }
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
  const click = async (expr) => { await evaluate(`(() => { const el = ${expr}; if (!el) throw new Error('找不到元素：' + ${q(expr)}); if (el.disabled) throw new Error('元素不可用：' + ${q(expr)} + ' ' + el.title + ' 原因：' + (document.querySelector('.dialog-overlay .fetch-reason')?.textContent ?? '—') + ' 状态：' + (document.querySelector('.op-status')?.textContent ?? '—')); el.click(); return true; })()`); await sleep(150); };
  const settle = (timeout = 60000) => waitUntil(`!window.__s.running() && !window.__op.loading()`, timeout);
  const addProject = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 30000);
    await sleep(400);
  };
  const refresh = async () => { await evaluate(`window.__op.button('↻ 本地刷新').click()`); await sleep(300); await waitUntil(`!window.__op.loading()`); await sleep(700); };
  /** 打开某个 ▾ 菜单（获取 ▾ 会读取 remote 列表，等读取结束）；再点同一个 ▾ 关闭。 */
  const openMenu = async (kind) => {
    if ((await evaluate(`window.__s.more(${q(kind)})?.getAttribute('aria-expanded')`)) !== "true") await click(`window.__s.more(${q(kind)})`);
    await waitUntil(`!!window.__s.menu() && !window.__s.menuText().includes('正在读取')`);
  };
  const closeMenu = async () => { const open = await evaluate(`['fetch', 'pull', 'push'].find((k) => window.__s.more(k)?.getAttribute('aria-expanded') === 'true') ?? null`); if (open) await click(`window.__s.more(${q(open)})`); await waitUntil(`!window.__s.menu()`); };
  const confirmDialog = async (label, timeout = 30000) => { await waitUntil(`!!document.querySelector('.confirm-dialog')`, timeout); await click(`window.__s.button(${q(label)}, document.querySelector('.confirm-dialog'))`); };
  // 主按钮一键执行（V2-D64）：获取默认 remote、按本仓库记住的方式拉取、推送到上游（没有上游时发布到仅有的 remote）。
  const fetch = async () => { await click(`window.__s.main('fetch')`); await settle(); };
  const pull = async () => { await click(`window.__s.main('pull')`); };
  const push = async () => { await click(`window.__s.main('push')`); };
  /** 在 拉取 ▾ 中选择拉取方式（menuitemradio，选中即设为本仓库默认）。 */
  const setPullMode = async (mode) => { await openMenu("pull"); await click(`window.__s.menuItem(${q(mode === "merge" ? "合并远端改动" : "仅快进")})`); await waitUntil(`!window.__s.menu()`); };
  const openBranches = async () => { if (!(await evaluate(`!!document.querySelector('.branch-popover')`))) await click(`document.querySelector('.branch-button')`); await waitUntil(`document.querySelectorAll('.branch-row').length > 0`); };
  return { app, evaluate, waitUntil, shot, click, settle, addProject, refresh, openMenu, closeMenu, confirmDialog, fetch, pull, push, setPullMode, openBranches };
}
async function stop(ctx) {
  try { ctx.app.cdp.close(); } catch { /* 已关闭 */ }
  const result = await killOris({ ...ctx.app });
  log(`测试实例 PID ${ctx.app.pid} 已结束：${result.how}`);
  return result;
}
function unauthorizedServer() {
  const server = createServer((request, response) => { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="oris-test"', "Content-Length": "0", Connection: "close" }); response.end(); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
const slowScript = (name, seconds, exec) => {
  const marker = path.join(runDir, `${name}-finished`);
  const script = path.join(runDir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\necho done > '${marker.replace(/\\/g, "/")}'\nexec ${exec} "$@"\n`);
  return { script: script.replace(/\\/g, "/"), marker };
};

// ================================ 本地 bare remote ================================
async function localSuite() {
  const r = localFixture();
  report.fixtures = r;
  const traceDir = path.join(runDir, "trace");
  mkdirSync(traceDir, { recursive: true });
  const ctx = await start("local", { ORIS_NETWORK_IDLE_TIMEOUT_MS: "4000", GIT_TRACE2_EVENT: traceDir });
  report.processes = {};
  const traces = () => new Set(readdirSync(traceDir));
  const commandOf = (name) => { try { const first = readFileSync(path.join(traceDir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.event === "start"); return (first?.argv ?? []).slice(1).filter((a) => !a.startsWith("-c") && !/^core\.|^diff\.|^[A-Z]:/i.test(a) && a !== "-C" && a !== "--no-optional-locks").slice(0, 3).join(" "); } catch { return "?"; } };
  /** 统计一个动作（含其后 1.5 s 内的后台补齐）启动的 Git 进程（包括 Git 自己派生的传输进程）。 */
  const traced = async (name, action) => { const before = traces(); const result = await action(); await sleep(1500); const added = [...traces()].filter((f) => !before.has(f)); report.processes[name] = { count: added.length, commands: added.map(commandOf).sort() }; return result; };
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    await ctx.addProject(r.local);
    // ---------- B17：浏览同步按钮、展开三个 ▾ 菜单后关闭 ----------
    let before = fingerprint(r.local);
    const summary = await ctx.evaluate(`({ counts: window.__s.counts(), pull: window.__s.main('pull').title, push: window.__s.main('push').title, labels: ['fetch', 'pull', 'push'].map((k) => window.__s.main(k).textContent) })`);
    await ctx.openMenu("fetch");
    summary.fetchMenu = await ctx.evaluate(`window.__s.menuItems()`);
    await ctx.closeMenu();
    await ctx.openMenu("pull");
    summary.pullMenu = await ctx.evaluate(`window.__s.menuItems()`);
    await ctx.closeMenu();
    await ctx.openMenu("push");
    summary.pushHead = await ctx.evaluate(`document.querySelector('.sync-menu-head')?.textContent ?? ''`);
    const menuShot = await ctx.shot("b11-sync-toolbar");
    await ctx.closeMenu();
    let e = evidence("B17 展开获取 / 拉取 / 推送 ▾ 后关闭", r.local, before, []);
    check("B11 同步按钮：当前分支、上游与领先 / 落后持续可见（推送 / 拉取按钮计数与 ▾ 说明）；B17 展开三个菜单不改仓库",
      summary.counts === "↑0 ↓0" && summary.pull.includes("从 origin/main 拉取（仅快进）") && summary.push.includes("推送到 origin/main") && summary.pushHead.includes("推送 main → origin/main：领先 0 个提交")
      && summary.fetchMenu.length === 1 && summary.fetchMenu[0].text === "origin" && summary.pullMenu.find((m) => m.text === "仅快进")?.checked === "true" && e.changedCount === 0, { summary, e, shot: menuShot });
    // ---------- B11 获取 → 仅快进 ----------
    put(r.other, "b.txt", "remote 1\n"); const remote1 = commitAll(r.other, "remote 1"); git(r.other, ["push", "-q", "origin", "main"]);
    await traced("fetch", () => ctx.fetch());
    await ctx.waitUntil(`window.__s.counts() === '↑0 ↓1'`, 15000);
    const fetchView = await ctx.evaluate(`({ toast: window.__s.toast(), label: window.__s.main('fetch').textContent, title: window.__s.main('fetch').title })`);
    check("B11 一键获取：主按钮直接获取上游 remote，结果提示成功，按钮显示获取时间", fetchView.toast?.cls.includes("succeeded") && fetchView.toast.text.includes("origin") && fetchView.label.includes("刚刚") && fetchView.title.includes("上次由 Oris 获取 origin") && git(r.local, ["rev-parse", "origin/main"]) === remote1, fetchView);
    before = fingerprint(r.local);
    await traced("pull 仅快进", async () => { await ctx.pull(); await ctx.settle(); });
    let status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("pull 仅快进", r.local, before, ["head", "index", "worktree", "remote-refs"]);
    check("B11 拉取（仅快进，默认）：HEAD 快进到上游，领先 / 落后刷新为 0/0", status.cls.includes("succeeded") && status.text.includes("快进") && git(r.local, ["rev-parse", "HEAD"]) === remote1 && e.unexpected.length === 0 && (await ctx.evaluate(`window.__s.counts()`)) === "↑0 ↓0", { status, e });
    // ---------- B11 分叉：仅快进失败 → 改用合并；pull.rebase=true 仍以合并执行 ----------
    git(r.local, ["config", "pull.rebase", "true"]);
    put(r.other, "c.txt", "remote 2\n"); commitAll(r.other, "remote 2"); git(r.other, ["push", "-q", "origin", "main"]);
    put(r.local, "d.txt", "local\n"); const localCommit = commitAll(r.local, "local work");
    await ctx.refresh();
    // V2-D64 后拉取说明固定写在 拉取 ▾ 中（不再按 pull.rebase 配置条件显示）；是否真的以合并执行由下面的仓库状态核对。
    await ctx.openMenu("pull");
    const rebaseNote = await ctx.evaluate(`window.__s.menuText()`);
    await ctx.closeMenu();
    before = fingerprint(r.local);
    await ctx.pull();
    await ctx.waitUntil(`document.querySelector('.confirm-dialog')?.textContent.includes('已分叉')`, 30000);
    const diverged = await ctx.evaluate(`document.querySelector('.confirm-dialog').textContent`);
    const unchangedHead = git(r.local, ["rev-parse", "HEAD"]) === localCommit;
    await ctx.confirmDialog("改用合并拉取"); await ctx.settle();
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("pull 分叉后改用合并", r.local, before, ["head", "index", "worktree", "remote-refs"]);
    check("B11 分叉时仅快进失败并说明原因，改用合并；配置 pull.rebase=true 时界面说明并仍以合并执行", rebaseNote.includes("配置了 pull.rebase 时也以合并执行") && diverged.includes("无法仅快进") && unchangedHead && parents(r.local, "HEAD") === 2 && git(r.local, ["rev-parse", "HEAD^1"]) === localCommit && !existsSync(path.join(r.local, ".git", "rebase-merge")) && status.cls.includes("succeeded") && e.unexpected.length === 0, { rebaseNote: rebaseNote.slice(0, 200), diverged: diverged.slice(0, 200), status, e, shot: await ctx.shot("b11-diverged-merged") });
    // ---------- B11 拉取方式：拉取 ▾ 选“合并远端改动”后按仓库记住，已分叉时直接合并、不再询问 ----------
    await ctx.setPullMode("merge");
    await ctx.openMenu("pull");
    const modeView = await ctx.evaluate(`({ items: window.__s.menuItems(), title: window.__s.main('pull').title, stored: JSON.parse(localStorage.getItem('oris.pullMode.v1') ?? '{}') })`);
    await ctx.closeMenu();
    put(r.other, "c2.txt", "remote 2b\n"); git(r.other, ["pull", "-q", "--no-rebase"]); commitAll(r.other, "remote 2b"); git(r.other, ["push", "-q", "origin", "main"]);
    put(r.local, "d2.txt", "local b\n"); const localCommit2 = commitAll(r.local, "local work b");
    await ctx.refresh();
    before = fingerprint(r.local);
    await ctx.pull(); await ctx.settle();
    const askedAgain = await ctx.evaluate(`!!document.querySelector('.confirm-dialog')`);
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("pull 合并方式（已记住）", r.local, before, ["head", "index", "worktree", "remote-refs"]);
    check("B11 拉取 ▾ 选择“合并远端改动”：单选项选中、按仓库记住，主按钮已分叉时直接生成合并提交（仍不做 rebase）",
      modeView.items.find((m) => m.text === "合并远端改动")?.checked === "true" && modeView.items.find((m) => m.text === "仅快进")?.checked === "false" && modeView.title.includes("合并远端改动") && Object.values(modeView.stored).includes("merge")
      && !askedAgain && parents(r.local, "HEAD") === 2 && git(r.local, ["rev-parse", "HEAD^1"]) === localCommit2 && !existsSync(path.join(r.local, ".git", "rebase-merge")) && status.cls.includes("succeeded") && e.unexpected.length === 0, { modeView, askedAgain, status, e });
    await ctx.setPullMode("ffOnly");
    git(r.local, ["config", "--unset", "pull.rebase"]);
    // ---------- B11 推送（有上游）与被拒绝 ----------
    before = fingerprint(r.local);
    await traced("push 到上游", async () => { await ctx.push(); await ctx.settle(); });
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("push 到上游", r.local, before, ["remote-refs"]);
    check("B11 推送当前分支到上游", status.cls.includes("succeeded") && bareRef(r.bare, "refs/heads/main") === git(r.local, ["rev-parse", "HEAD"]) && e.unexpected.length === 0, { status, e });
    // ---------- B07 / V2-D37 提交并推送（已有上游：提交成功后直接推送） ----------
    put(r.local, "cp.txt", "commit and push\n"); git(r.local, ["add", "cp.txt"]);
    await ctx.refresh();
    if (!(await ctx.evaluate(`window.__s.gitTab('提交')?.classList.contains('active')`))) await ctx.click(`window.__s.gitTab('提交')`);
    await ctx.waitUntil(`!!document.querySelector('textarea[aria-label="提交信息"]') && /提交 · 1/.test(window.__s.gitTab('提交')?.textContent ?? '')`);
    await ctx.evaluate(`(() => { const t = document.querySelector('textarea[aria-label="提交信息"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '提交并推送检查'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ctx.click(`document.querySelector('input[aria-label="提交并推送"]')`);
    before = fingerprint(r.local);
    await traced("提交并推送", async () => { await ctx.click(`window.__s.button('提交并推送', document.querySelector('.commit-side'))`); await ctx.settle(); await ctx.waitUntil(`window.__s.counts() === '↑0 ↓0'`, 30000); });
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("提交并推送", r.local, before, ["head", "index", "remote-refs", "git:COMMIT_EDITMSG"]);
    check("B07 提交并推送（V2-D37，已有上游）：提交成功后推送当前分支，远端与本地一致", git(r.local, ["log", "-1", "--format=%s"]) === "提交并推送检查" && bareRef(r.bare, "refs/heads/main") === git(r.local, ["rev-parse", "HEAD"]) && e.unexpected.length === 0, { status, e, shot: await ctx.shot("b07-commit-and-push") });
    if (await ctx.evaluate(`!!document.querySelector('input[aria-label="提交并推送"]')?.checked`)) await ctx.click(`document.querySelector('input[aria-label="提交并推送"]')`);
    put(r.other, "e.txt", "remote 3\n"); git(r.other, ["pull", "-q", "--no-rebase"]); const remote3 = commitAll(r.other, "remote 3"); git(r.other, ["push", "-q", "origin", "main"]);
    put(r.local, "f.txt", "local 2\n"); commitAll(r.local, "local 2");
    git(r.local, ["tag", "v-local"]); git(r.local, ["config", "push.followTags", "true"]);
    await ctx.refresh();
    before = fingerprint(r.local);
    await ctx.push(); await ctx.settle();
    status = await ctx.evaluate(`window.__s.opStatus()`);
    const rejectedUi = await ctx.evaluate(`({ toast: window.__s.toast(), statusPull: document.querySelector('.push-rejected-pull')?.textContent ?? null })`);
    // 可操作的入口（按钮 / 菜单项，含展开的 推送 ▾）中不应出现强制推送；状态栏说明文字除外。
    const forceIn = () => ctx.evaluate(`[...document.querySelectorAll('button:not(.op-status), [role=menuitem]')].some((b) => /强制|force/i.test(b.textContent))`);
    let forceMentioned = await forceIn();
    await ctx.openMenu("push"); forceMentioned ||= await forceIn(); await ctx.closeMenu();
    e = evidence("push 被拒绝", r.local, before, ["remote-refs"]);
    check("B11 推送被拒绝：提示先拉取（结果提示与状态栏均提供“拉取”），不提供任何强推入口，远端未被改写；不推送 tag",
      status.cls.includes("failed") && status.text.includes("被拒绝") && status.text.includes("先拉取") && rejectedUi.toast?.cls.includes("failed") && rejectedUi.toast.text.includes("被拒绝") && rejectedUi.toast.actions.join() === "拉取" && rejectedUi.statusPull === "拉取"
      && !forceMentioned && bareRef(r.bare, "refs/heads/main") === remote3 && !bareRef(r.bare, "refs/tags/v-local") && e.unexpected.length === 0, { status, rejectedUi, forceMentioned, e, shot: await ctx.shot("b11-push-rejected") });
    // ---------- B11 stash 后拉取（从状态栏“拉取”直接拉取） ----------
    put(r.other, "a.txt", "remote edits a\n"); const remote4 = commitAll(r.other, "remote edits a"); git(r.other, ["push", "-q", "origin", "main"]);
    git(r.local, ["reset", "-q", "--hard", "origin/main"]);
    put(r.local, "a.txt", "local uncommitted a\n");
    await ctx.refresh();
    before = fingerprint(r.local);
    const viaStatusBar = await ctx.evaluate(`document.querySelector('.push-rejected-pull')?.textContent === '拉取'`);
    await ctx.click(`document.querySelector('.push-rejected-pull') ?? window.__s.main('pull')`);
    await ctx.waitUntil(`document.querySelector('.confirm-dialog')?.textContent.includes('stash 后拉取')`, 30000);
    const stashAsk = await ctx.evaluate(`document.querySelector('.confirm-dialog').textContent`);
    await ctx.confirmDialog("stash 后拉取"); await ctx.settle();
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("stash 后拉取", r.local, before, ["head", "index", "worktree", "remote-refs", "stash"]);
    check("B11 推送被拒绝后状态栏“拉取”直接拉取；工作区改动阻止拉取：提供“stash 后拉取”，拉取后不自动恢复", viaStatusBar && stashAsk.includes("a.txt") && status.cls.includes("succeeded") && status.text.includes("没有自动恢复") && git(r.local, ["rev-parse", "HEAD"]) === remote4 && read(r.local, "a.txt") === "remote edits a\n" && git(r.local, ["stash", "list"]).includes("拉取前储藏") && e.unexpected.length === 0, { viaStatusBar, stashAsk: stashAsk.slice(0, 200), status, e });
    // ---------- B11 无上游：拉取不可用；首次推送设置上游 ----------
    git(r.local, ["switch", "-q", "-c", "feature"]); put(r.local, "g.txt", "feature\n"); const feature = commitAll(r.local, "feature");
    await ctx.refresh();
    await ctx.openMenu("pull");
    const noUpstream = await ctx.evaluate(`({ pull: window.__s.main('pull').disabled, pullTitle: window.__s.main('pull').title, pullLabel: window.__s.main('pull').textContent, push: window.__s.main('push').textContent, setUpstream: window.__s.menuItems().some((m) => m.text === '设置上游…' && !m.disabled), counts: window.__s.counts() })`);
    await ctx.closeMenu();
    await ctx.openMenu("push");
    noUpstream.pushHead = await ctx.evaluate(`document.querySelector('.sync-menu-head')?.textContent ?? ''`);
    await ctx.closeMenu();
    before = fingerprint(r.local);
    await ctx.push(); await ctx.settle();
    const askedRemote = await ctx.evaluate(`!!window.__s.remoteChoice()`);
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("首次推送设置上游", r.local, before, ["remote-refs", "config"]);
    check("B11 无上游时拉取不可用并引导设置上游（拉取 ▾ 提供“设置上游…”）；“发布分支”在只有一个 remote 时直接推送到它并设置上游",
      noUpstream.pull && noUpstream.pullTitle.includes("没有上游") && noUpstream.setUpstream && noUpstream.counts === null && noUpstream.push.includes("发布分支") && noUpstream.pushHead.includes("还没有上游")
      && !askedRemote && status.cls.includes("succeeded") && bareRef(r.bare, "refs/heads/feature") === feature && git(r.local, ["rev-parse", "--abbrev-ref", "feature@{u}"]) === "origin/feature" && e.unexpected.length === 0, { noUpstream, askedRemote, status, e });
    // ---------- B11 无上游且有多个 remote：一键获取 / 发布要求选择 remote ----------
    const backupBare = path.join(runDir, "backup.git");
    git(runDir, ["clone", "-q", "--bare", r.bare, backupBare]);
    git(r.local, ["remote", "add", "backup", backupBare]);
    git(r.local, ["switch", "-q", "-c", "feature2"]); put(r.local, "g2.txt", "feature 2\n"); const feature2 = commitAll(r.local, "feature 2");
    await ctx.refresh();
    before = fingerprint(r.local);
    await ctx.click(`window.__s.main('fetch')`);
    await ctx.waitUntil(`!!window.__s.remoteChoice()`, 15000);
    const fetchChoice = await ctx.evaluate(`({ title: window.__s.remoteChoice().querySelector('h3').textContent, text: window.__s.remoteChoice().textContent, remotes: [...window.__s.remoteChoice().querySelectorAll('input[type=radio]')].map((i) => i.getAttribute('aria-label')) })`);
    await ctx.click(`window.__s.button('取消', window.__s.remoteChoice())`);
    await ctx.settle();
    e = evidence("无上游多个 remote：获取时取消选择", r.local, before, []);
    const fetchCancelled = e.unexpected.length === 0 && !e.categories.includes("remote-refs");
    before = fingerprint(r.local);
    await ctx.push();
    await ctx.waitUntil(`!!window.__s.remoteChoice()`, 15000);
    const pushChoice = await ctx.evaluate(`({ title: window.__s.remoteChoice().querySelector('h3').textContent, text: window.__s.remoteChoice().textContent, remotes: [...window.__s.remoteChoice().querySelectorAll('input[type=radio]')].map((i) => i.getAttribute('aria-label')) })`);
    const choiceShot = await ctx.shot("b11-remote-choice");
    await ctx.click(`window.__s.remoteChoice().querySelector('input[aria-label="backup"]')`);
    await ctx.click(`window.__s.button('发布', window.__s.remoteChoice())`); await ctx.settle();
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("无上游多个 remote：选择 backup 后发布", r.local, before, ["remote-refs", "config"]);
    check("B11 无上游且有多个 remote：一键获取 / 发布不自行决定，列出 remote 请用户选择；取消不联网，选择后只推送到所选 remote 并设为上游",
      fetchChoice.title === "选择要获取的 remote" && fetchChoice.text.includes("请选择要获取的 remote") && fetchChoice.remotes.sort().join() === "backup,origin" && fetchCancelled
      && pushChoice.title === "选择要发布到的 remote" && pushChoice.remotes.sort().join() === "backup,origin" && status.cls.includes("succeeded") && bareRef(backupBare, "refs/heads/feature2") === feature2 && !bareRef(r.bare, "refs/heads/feature2") && git(r.local, ["rev-parse", "--abbrev-ref", "feature2@{u}"]) === "backup/feature2" && e.unexpected.length === 0,
      { fetchChoice, pushChoice, status, e, shot: choiceShot });
    git(r.local, ["switch", "-q", "feature"]); git(r.local, ["branch", "-q", "-D", "feature2"]); git(r.local, ["remote", "remove", "backup"]);
    // ---------- B12 进度（操作输出）、取消、超时、认证 ----------
    put(r.local, "big.bin", randomBytes(3 * 1024 * 1024).toString("base64")); commitAll(r.local, "big");
    await ctx.refresh();
    await ctx.push(); await ctx.settle();
    await ctx.click(`window.__s.gitTab('操作输出')`); await sleep(300);
    const output = await ctx.evaluate(`window.__s.outputText()`);
    check("B12 进度：推送输出包含 --progress 的进度行（状态栏在运行中显示最新一行）", /Writing objects|Counting objects|Compressing objects/.test(output), { output: output.slice(0, 400) });
    const up = slowScript("slow-upload", 12, "git-upload-pack");
    git(r.local, ["switch", "-q", "main"]); git(r.local, ["stash", "clear"]); git(r.local, ["reset", "-q", "--hard", "origin/main"]);
    git(r.local, ["config", "remote.origin.uploadpack", up.script]);
    put(r.other, "h.txt", "remote 5\n"); git(r.other, ["pull", "-q", "--no-rebase"]); commitAll(r.other, "remote 5"); git(r.other, ["push", "-q", "origin", "main"]);
    await ctx.refresh();
    before = fingerprint(r.local);
    const headBeforeCancel = git(r.local, ["rev-parse", "HEAD"]);
    await ctx.pull();
    await ctx.waitUntil(`window.__s.running()`, 10000); await sleep(1500);
    const during = processTree(ctx.app.pid).processes.map((p) => p.name);
    // 执行中主按钮变为“拉取中… ✕ 取消”，其余按钮的 ▾ 不可用（V2-D64）；取消走标题栏主按钮。
    const runningUi = await ctx.evaluate(`({ label: window.__s.main('pull').textContent, fetchMore: window.__s.more('fetch').disabled, pushMore: window.__s.more('push').disabled })`);
    await ctx.click(`window.__s.main('pull')`);
    await ctx.settle();
    status = await ctx.evaluate(`window.__s.opStatus()`);
    const cancelToast = await ctx.evaluate(`window.__s.toast()`);
    await sleep(800);
    const after = processTree(ctx.app.pid).processes.map((p) => p.name);
    e = evidence("pull 取消", r.local, before, []);
    check("B12 取消拉取（标题栏“拉取中… ✕ 取消”）：结束整个进程树，重读实际状态如实报告，HEAD 未变化", runningUi.label.includes("拉取中") && runningUi.label.includes("取消") && runningUi.fetchMore && runningUi.pushMore && status.cls.includes("cancelled") && status.text.includes("HEAD 未变化") && cancelToast?.cls.includes("cancelled") && git(r.local, ["rev-parse", "HEAD"]) === headBeforeCancel && during.some((n) => /^(sh|sleep|bash)\.exe$/i.test(n)) && !after.some((n) => /^(sh|sleep)\.exe$/i.test(n)) && e.unexpected.length === 0, { runningUi, status, cancelToast, during, after, e });
    before = fingerprint(r.local);
    await ctx.pull(); await ctx.settle(20000);
    status = await ctx.evaluate(`window.__s.opStatus()`);
    const timeoutToast = await ctx.evaluate(`window.__s.toast()`);
    e = evidence("pull 无输出超时", r.local, before, []);
    await ctx.click(`window.__s.toastButton('查看输出')`); await sleep(300);
    const outputOpened = await ctx.evaluate(`!!window.__s.gitTab('操作输出')?.classList.contains('active') && !window.__s.toast()`);
    check("B12 无输出超时（测试实例 4 s）：终止并提示可能需要先在终端完成首次认证；失败提示提供“重试”“查看输出”", status.cls.includes("failed") && status.text.includes("没有任何输出") && timeoutToast?.cls.includes("failed") && timeoutToast.actions.join() === "重试,查看输出" && outputOpened && git(r.local, ["rev-parse", "HEAD"]) === headBeforeCancel && e.unexpected.length === 0, { status, timeoutToast, outputOpened, e });
    git(r.local, ["config", "--unset", "remote.origin.uploadpack"]);
    await sleep(12000);
    check("B12 取消 / 超时后被终止的 upload-pack 没有继续运行", !existsSync(up.marker), {});
    const { server, url } = await unauthorizedServer();
    try {
      git(r.local, ["config", "credential.helper", ""]);
      const originUrl = git(r.local, ["remote", "get-url", "origin"]);
      git(r.local, ["remote", "set-url", "origin", url.replace("http://", "http://alice:s3cret-token@") + "/repo.git"]);
      before = fingerprint(r.local);
      await ctx.pull(); await ctx.settle(30000);
      status = await ctx.evaluate(`window.__s.opStatus()`);
      const authToast = await ctx.evaluate(`window.__s.toast()`);
      const authShot = await ctx.shot("b12-auth-failed");
      await ctx.click(`window.__s.gitTab('操作输出')`); await sleep(300);
      const authOutput = await ctx.evaluate(`window.__s.outputText()`);
      const names = processTree(ctx.app.pid).processes.map((p) => p.name);
      e = evidence("pull 认证失败", r.local, before, []);
      check("B12 / B18 认证失败：可操作提示、不弹出凭据输入（进程树中没有凭据助手）、URL 凭据已脱敏（状态栏、结果提示、操作输出）", status.cls.includes("failed") && /认证失败|没有访问权限/.test(status.text) && !status.text.includes("s3cret") && authToast?.cls.includes("failed") && /认证失败|没有访问权限/.test(authToast.text) && !authToast.text.includes("s3cret") && !authOutput.includes("s3cret") && !names.some((n) => /credential/i.test(n)) && e.unexpected.length === 0, { status: status.text.slice(0, 300), authToast, names, e, shot: authShot });
      git(r.local, ["remote", "set-url", "origin", originUrl]);
    } finally { server.close(); }
    // ---------- B13 合并：快进、总是创建合并提交、冲突 → 中止 / 解决 → 完成 ----------
    git(r.local, ["fetch", "-q"]); git(r.local, ["reset", "-q", "--hard", "origin/main"]);
    git(r.local, ["switch", "-q", "-c", "topic"]); put(r.local, "t.txt", "topic\n"); const topic = commitAll(r.local, "topic work"); git(r.local, ["switch", "-q", "main"]);
    await ctx.refresh();
    const mergeVia = async (branch, noFf) => {
      await ctx.openBranches();
      await ctx.click(`window.__s.rowButton(${q(branch)}, '更多 ▾')`);
      await ctx.click(`window.__s.button('合并到当前分支…')`);
      await ctx.waitUntil(`!!document.querySelector('.merge-dialog')`);
      if (noFf) await ctx.evaluate(`document.querySelector('.merge-dialog input[aria-label=总是创建合并提交]').click()`);
      await ctx.click(`window.__s.button('合并', document.querySelector('.merge-dialog'))`); await ctx.settle();
    };
    before = fingerprint(r.local);
    await mergeVia("topic", false);
    e = evidence("merge 快进", r.local, before, ["head", "index", "worktree"]);
    check("B13 合并（遵循 merge.ff）：可快进时快进", git(r.local, ["rev-parse", "HEAD"]) === topic && e.unexpected.length === 0, { e, status: await ctx.evaluate(`window.__s.opStatus()`) });
    git(r.local, ["reset", "-q", "--hard", "origin/main"]); await ctx.refresh();
    before = fingerprint(r.local);
    await traced("merge（总是创建合并提交）", () => mergeVia("topic", true));
    e = evidence("merge 总是创建合并提交", r.local, before, ["head", "index", "worktree"]);
    check("B13 合并（总是创建合并提交）：生成两个父节点的合并提交", parents(r.local, "HEAD") === 2 && git(r.local, ["log", "-1", "--format=%s"]) === "Merge branch 'topic'" && e.unexpected.length === 0, { e });
    git(r.local, ["reset", "-q", "--hard", "origin/main"]);
    git(r.local, ["switch", "-q", "-c", "clash"]); put(r.local, "a.txt", "clash side\n"); commitAll(r.local, "clash edits a"); git(r.local, ["switch", "-q", "main"]);
    put(r.local, "a.txt", "main side\n"); const mainHead = commitAll(r.local, "main edits a");
    await ctx.refresh();
    const indexBefore = git(r.local, ["ls-files", "-s"]);
    before = fingerprint(r.local);
    await mergeVia("clash", false);
    await ctx.waitUntil(`window.__s.banner()?.includes('1 个冲突')`, 15000);
    await ctx.click(`window.__s.button('查看冲突', document.querySelector('.merge-banner'))`);
    await ctx.waitUntil(`window.__op.tab() === 'a.txt' && window.__s.conflictToolbar()`, 15000);
    const conflictShot = await ctx.shot("b13-merge-conflict");
    await ctx.click(`window.__s.button('中止合并…', document.querySelector('.merge-banner'))`);
    await traced("中止合并", async () => { await ctx.confirmDialog("中止合并"); await ctx.settle(); });
    e = evidence("中止合并", r.local, before, ["index"]);
    check("B13 冲突：横幅显示冲突数，“查看冲突”进入只读冲突阅读；中止合并后恢复到合并前（HEAD、index 条目、工作区）", !existsSync(path.join(r.local, ".git", "MERGE_HEAD")) && git(r.local, ["rev-parse", "HEAD"]) === mainHead && git(r.local, ["ls-files", "-s"]) === indexBefore && read(r.local, "a.txt") === "main side\n" && e.unexpected.length === 0 && !(await ctx.evaluate(`window.__s.banner()`)), { e, conflictShot });
    await mergeVia("clash", false);
    await ctx.waitUntil(`window.__s.banner()?.includes('1 个冲突')`, 15000);
    await ctx.click(`window.__s.fileRowButton('a.txt', '标记已解决')`);
    await ctx.waitUntil(`document.querySelector('.confirm-dialog')?.textContent.includes('冲突标记')`, 15000);
    await ctx.click(`window.__s.button('取消', document.querySelector('.confirm-dialog'))`);
    put(r.local, "a.txt", "resolved outside Oris\n");
    await ctx.refresh();
    await ctx.click(`window.__s.fileRowButton('a.txt', '标记已解决')`); await ctx.settle();
    await ctx.waitUntil(`window.__s.banner()?.includes('0 个冲突')`, 15000);
    await ctx.click(`window.__s.button('完成合并…', document.querySelector('.merge-banner'))`);
    await ctx.waitUntil(`document.querySelector('.merge-commit-dialog textarea')?.value.startsWith('Merge branch')`);
    const defaultMessage = await ctx.evaluate(`document.querySelector('.merge-commit-dialog textarea').value`);
    await ctx.evaluate(`window.__s.setIn(document.querySelector('.merge-commit-dialog'), 'textarea', ${q("Merge branch 'clash'\n\n在外部解决了 a.txt")})`);
    await traced("完成合并", async () => { await ctx.click(`window.__s.button('完成合并', document.querySelector('.merge-commit-dialog'))`); await ctx.settle(); });
    check("B13 在外部解决 → 标记已解决（残留冲突标记时先警告）→ 完成合并（默认信息可编辑）", defaultMessage.startsWith("Merge branch 'clash'") && parents(r.local, "HEAD") === 2 && git(r.local, ["log", "-1", "--format=%B"]).includes("在外部解决了 a.txt") && !existsSync(path.join(r.local, ".git", "MERGE_HEAD")) && !(await ctx.evaluate(`window.__s.banner()`)), { defaultMessage });
    // ---------- B14 外部 rebase 进行中 ----------
    // rb 从合并前的 main（a.txt = main side）出发，变基到 clash（a.txt = clash side）时冲突。
    git(r.local, ["switch", "-q", "-c", "rb", mainHead]);
    spawnSync("git", ["-c", "core.editor=true", "rebase", "clash"], { cwd: r.local, encoding: "utf8" });
    const rebasing = existsSync(path.join(r.local, ".git", "rebase-merge")) || existsSync(path.join(r.local, ".git", "rebase-apply"));
    await ctx.refresh();
    before = fingerprint(r.local);
    // 写入口：三个主按钮，以及 获取 ▾ 的 remote 项、推送 ▾ 的“推送 / 发布分支”项（▾ 本身只展开选项，可以打开）。
    const mainsDisabled = await ctx.evaluate(`['fetch', 'pull', 'push'].map((k) => ({ kind: k, disabled: window.__s.main(k).disabled, title: window.__s.main(k).title }))`);
    await ctx.openMenu("fetch");
    const fetchItems = await ctx.evaluate(`window.__s.menuItems()`);
    await ctx.closeMenu();
    await ctx.openMenu("push");
    const pushItems = await ctx.evaluate(`window.__s.menuItems()`);
    await ctx.closeMenu();
    const syncDisabled = mainsDisabled.every((m) => m.disabled) && fetchItems.length > 0 && fetchItems.every((m) => m.disabled) && pushItems.length > 0 && pushItems.every((m) => m.disabled);
    const banner14 = await ctx.evaluate(`window.__s.opBanner()`);
    e = evidence("rebase 进行中浏览", r.local, before, []);
    check("B14 外部 rebase 进行中：横幅说明，获取 / 拉取 / 推送等写入口全部禁用，阅读正常", rebasing && banner14?.includes("rebase 进行中") && syncDisabled && e.changedCount === 0, { rebasing, banner14, mainsDisabled, fetchItems, pushItems, shot: await ctx.shot("b14-rebase") });
    spawnSync("git", ["rebase", "--abort"], { cwd: r.local });
    git(r.local, ["switch", "-q", "main"]);
    await ctx.refresh();
    // ---------- B16 外部 index.lock ----------
    const lock = path.join(r.local, ".git", "index.lock");
    writeFileSync(lock, "held");
    before = fingerprint(r.local);
    await ctx.pull(); await ctx.settle();
    status = await ctx.evaluate(`window.__s.opStatus()`);
    e = evidence("外部 index.lock 时拉取", r.local, before, []);
    // V2-D65（用户已确认）：同步遇到 Git 锁文件时，前置检查返回确认（说明锁文件、可删除后重试），不启动 Git；
    // 用户确认之前不删除锁、不重试。原检查按“报错”判定，随该决策更新。
    check("B16 外部 index.lock（V2-D65）：拉取在启动写进程前停下并请用户确认（可删除锁后重试）；确认前不删除锁、不重试，仓库不变", (status.cls.includes("needsConfirmation") || status.cls.includes("failed")) && status.text.includes("index.lock") && readFileSync(lock, "utf8") === "held" && e.changedCount === 0, { status, e });
    unlinkSync(lock);
  } catch (error) {
    fail(`本地验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await ctx.shot("local-failure"); } catch { /* ignore */ }
  } finally {
    report.stopLocal = await stop(ctx);
  }
}

// ================================ 真实远端 AgentHub ================================
const AGENTHUB = { ssh: "git@github.com:Zhao-wl/AgentHub.git", https: "https://github.com/Zhao-wl/AgentHub.git" };
function netGit(cwd, argv, { allowFail = false, https = false } = {}) {
  const result = spawnSync("git", [...(https ? ["-c", "credential.https://github.com.username=Zhao-wl"] : []), ...argv], { cwd, encoding: "utf8", timeout: 180000 });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${argv.join(" ")} 失败：${result.stderr}`);
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}
async function realSuite() {
  if (!runId) throw new Error("真实远端需要 --run-id");
  const base = path.join(REMOTE_ROOT, runId, "v2-04");
  mkdirSync(base, { recursive: true });
  report.real = { base, created: [], deleted: [], protocols: {} };
  const helper = path.join(base, "helper");
  // 克隆时就固定 core.autocrlf=false：避免系统配置 autocrlf=true 检出 CRLF 后再改配置，使整个工作区显示为已修改。
  netGit(base, ["clone", "-q", "-c", "core.autocrlf=false", AGENTHUB.ssh, helper]); configure(helper);
  const mainBefore = netGit(base, ["ls-remote", AGENTHUB.ssh, "refs/heads/main"]).out.split(/\s+/)[0];
  const record = (branch) => { report.real.created.push(branch); writeFileSync(path.join(base, "created-branches.json"), JSON.stringify(report.real.created)); };
  const lsRemote = (branch) => netGit(base, ["ls-remote", AGENTHUB.ssh, `refs/heads/${branch}`]).out.split(/\s+/)[0] || null;
  const helperCommit = (branch, name) => { netGit(helper, ["fetch", "-q", "origin"]); git(helper, ["switch", "-q", "-C", `h-${branch.split("/").pop()}`, `origin/${branch}`]); put(helper, `oris-test-${name}.txt`, `${name} ${Date.now()}\n`); const oid = commitAll(helper, `oris test ${name}`); netGit(helper, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]); return oid; };
  const ctx = await start("real");
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    for (const proto of ["ssh", "https"]) {
      const branch = `oris-test/${runId}/v2-04-${proto}`;
      const fresh = `${branch}-new`;
      const clone = path.join(base, `agenthub-${proto}`);
      netGit(base, ["clone", "-q", "-c", "core.autocrlf=false", AGENTHUB[proto], clone], { https: proto === "https" });
      configure(clone);
      if (proto === "https") git(clone, ["config", "credential.https://github.com.username", "Zhao-wl"]);
      netGit(helper, ["push", "-q", "origin", `refs/remotes/origin/main:refs/heads/${branch}`]); record(branch);
      const result = { branch, fresh };
      report.real.protocols[proto] = result;
      await ctx.addProject(clone);
      // fetch：获取到本次测试分支。
      let before = fingerprint(clone);
      await ctx.fetch();
      result.fetch = { status: await ctx.evaluate(`window.__s.opStatus()`), e: evidence(`AgentHub ${proto} fetch`, clone, before, ["remote-refs"]) };
      check(`B12 真实远端 AgentHub ${proto.toUpperCase()} 获取：得到本次测试分支`, result.fetch.status.cls.includes("succeeded") && git(clone, ["for-each-ref", `refs/remotes/origin/${branch}`]).includes(branch) && result.fetch.e.unexpected.length === 0, result.fetch);
      // 检出为本地跟踪分支（V2-03 入口）。
      await ctx.openBranches();
      await ctx.click(`window.__s.rowButton(${q(`origin/${branch}`)}, '检出')`); await ctx.settle();
      // pull：远端新增提交后仅快进。
      const remoteOid = helperCommit(branch, `${proto}-pull`);
      before = fingerprint(clone);
      await ctx.pull(); await ctx.settle(180000);
      result.pull = { status: await ctx.evaluate(`window.__s.opStatus()`), e: evidence(`AgentHub ${proto} pull`, clone, before, ["head", "index", "worktree", "remote-refs"]) };
      check(`B12 真实远端 AgentHub ${proto.toUpperCase()} 拉取（仅快进）`, result.pull.status.cls.includes("succeeded") && git(clone, ["rev-parse", "HEAD"]) === remoteOid && result.pull.e.unexpected.length === 0, result.pull);
      // push：本地提交推送到测试分支。
      put(clone, `oris-test-${proto}-push.txt`, `push ${Date.now()}\n`); const localOid = commitAll(clone, `oris test ${proto} push`);
      await ctx.refresh();
      before = fingerprint(clone);
      await ctx.push(); await ctx.settle(180000);
      result.push = { status: await ctx.evaluate(`window.__s.opStatus()`), e: evidence(`AgentHub ${proto} push`, clone, before, ["remote-refs"]) };
      check(`B12 真实远端 AgentHub ${proto.toUpperCase()} 推送到 ${branch}`, result.push.status.cls.includes("succeeded") && lsRemote(branch) === localOid && result.push.e.unexpected.length === 0, result.push);
      // 推送被拒绝：远端又有新提交。
      const remoteNewer = helperCommit(branch, `${proto}-reject`);
      put(clone, `oris-test-${proto}-reject.txt`, `reject ${Date.now()}\n`); commitAll(clone, `oris test ${proto} rejected`);
      await ctx.refresh();
      before = fingerprint(clone);
      await ctx.push(); await ctx.settle(180000);
      result.rejected = { status: await ctx.evaluate(`window.__s.opStatus()`), toast: await ctx.evaluate(`window.__s.toast()`), e: evidence(`AgentHub ${proto} push 被拒绝`, clone, before, ["remote-refs"]) };
      check(`B11 / B12 真实远端 AgentHub ${proto.toUpperCase()} 推送被拒绝：提示先拉取（结果提示提供“拉取”），远端未被改写`, result.rejected.status.cls.includes("failed") && result.rejected.status.text.includes("被拒绝") && result.rejected.toast?.actions.join() === "拉取" && lsRemote(branch) === remoteNewer && result.rejected.e.unexpected.length === 0, result.rejected);
      // 首次推送新分支并设置上游：没有上游时推送主按钮为“发布分支”，只有 origin 一个 remote，直接发布。
      git(clone, ["switch", "-q", "-c", fresh]);
      await ctx.refresh();
      await ctx.waitUntil(`window.__s.main('push')?.textContent.includes('发布分支')`);
      before = fingerprint(clone);
      record(fresh);
      await ctx.push(); await ctx.settle(180000);
      result.firstPush = { status: await ctx.evaluate(`window.__s.opStatus()`), askedRemote: await ctx.evaluate(`!!window.__s.remoteChoice()`), e: evidence(`AgentHub ${proto} 首次推送`, clone, before, ["remote-refs", "config"]) };
      check(`B11 真实远端 AgentHub ${proto.toUpperCase()} 首次推送新分支（发布分支）并设置上游`, result.firstPush.status.cls.includes("succeeded") && !result.firstPush.askedRemote && !!lsRemote(fresh) && git(clone, ["rev-parse", "--abbrev-ref", `${fresh}@{u}`]) === `origin/${fresh}`, result.firstPush);
      result.shot = await ctx.shot(`real-${proto}`);
    }
  } catch (error) {
    fail(`真实远端验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await ctx.shot("real-failure"); } catch { /* ignore */ }
  } finally {
    report.stopReal = await stop(ctx);
    for (const branch of report.real.created) {
      const deleted = netGit(helper, ["push", "-q", "origin", `:refs/heads/${branch}`], { allowFail: true });
      if (deleted.ok || !lsRemote(branch)) report.real.deleted.push(branch); else fail(`删除测试分支失败：${branch} ${deleted.err}`);
    }
    const remaining = netGit(base, ["ls-remote", AGENTHUB.ssh]).out;
    report.real.lsRemoteAfter = remaining;
    check("AgentHub 清理：只删除本次创建的测试分支，main 未变，远端只剩开工时的分支", !remaining.includes("oris-test/") && remaining.split("\n").filter((l) => l.includes("refs/heads/")).length === 1 && remaining.includes(`${mainBefore}\trefs/heads/main`), { remaining, mainBefore });
    if (!keep) removeDir(base, REMOTE_ROOT);
  }
}

if (only === "local") await localSuite();
if (only === "real") await realSuite();
report.finishedAt = new Date().toISOString();
report.passed = report.failures.length === 0;
const reportFile = path.join(outDir, `report-${only}.json`);
writeFileSync(reportFile, JSON.stringify(report, null, 2));
log(report.passed ? "全部检查通过" : `失败 ${report.failures.length} 项`, reportFile);
if (!keep) log(removeDir(runDir, GUI_ROOT) ? `已清理 ${runDir}` : `未能完全清理 ${runDir}`);
process.exitCode = report.passed ? 0 : 1;
