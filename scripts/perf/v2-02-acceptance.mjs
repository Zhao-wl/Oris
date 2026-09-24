// V2-02 界面验收：B05–B08、B16、B17 与 §3 stage / unstage、commit 时延。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 点击与输入是 CDP 注入的页面事件，不是真实鼠标、键盘或系统焦点。
// 每个写操作都记录操作前后的仓库指纹（index、HEAD 与 refs、config、工作区；不含 .git/objects 与 .git/logs）。
// 用法：node scripts/perf/v2-02-acceptance.mjs --exe <oris.exe> [--port 9811] [--iterations 30] [--only functional|latency] [--keep]
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, prepareCoreRepos, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, gitChildren, killOris, launchOris, processTree, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
let port = Number(option("port", 9811));
const iterations = Number(option("iterations", 30));
const only = option("only", "all");
const keep = args.includes("--keep");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v2-02-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v2-02-acceptance-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), startedAt: new Date().toISOString(), runDir, method: "CDP 页面事件（点击、输入）；不是真实鼠标、键盘或系统焦点。仓库指纹为 .git（不含 objects/logs）与工作区逐文件 SHA-256。", checks: {}, operations: [], timings: {}, processes: {}, failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)}`); };

// ---------- 仓库指纹与状态对比 ----------
const fingerprint = (repo) => repositoryFingerprint(repo);
function categorize(keys) {
  return [...new Set(keys.map((k) => k === ".git/index" ? "index" : (k === ".git/HEAD" || k.startsWith(".git/refs/") || k === ".git/packed-refs") ? "refs" : k === ".git/config" ? "config" : k.startsWith(".git/") ? `git:${k.slice(5)}` : "worktree"))].sort();
}
/** 记录一次写操作的前后对比：expected 为允许变化的类别（git:* 中 COMMIT_EDITMSG / ORIG_HEAD 视为提交副产物）。 */
function evidence(name, repo, before, after, expected) {
  const changed = diffFingerprints(before, after);
  const categories = categorize(changed);
  const benign = new Set(["git:COMMIT_EDITMSG", "git:ORIG_HEAD", "git:AUTO_MERGE"]);
  const unexpected = categories.filter((c) => !expected.includes(c) && !benign.has(c));
  const entry = { name, repo, beforeDigest: before.digest, afterDigest: after.digest, changed: changed.slice(0, 40), changedCount: changed.length, categories, expected, unexpected };
  report.operations.push(entry);
  return entry;
}

// ---------- 夹具（全部在 %TEMP%\oris-gui 下） ----------
const put = (repo, rel, bytes) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), bytes); };
function initRepo(name) {
  const repo = path.join(runDir, name);
  assertOutside(repo);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, ["config", key, value]);
  return repo;
}
const commitAll = (repo, message) => { git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", message]); };
const gitOut = (repo, argv) => git(repo, ["-c", "core.quotepath=false", ...argv]);

function stageFixture() {
  const repo = initRepo("stage");
  put(repo, "a.txt", "a\n"); put(repo, "del.txt", "delete me\n"); put(repo, "keep.txt", "keep\n");
  put(repo, "old-name.txt", "rename me with enough shared content\nline 2\nline 3\nline 4\n");
  put(repo, "空 格/中文 #[x].txt", "special\n");
  commitAll(repo, "base");
  put(repo, "a.txt", "a changed\n");
  unlinkSync(path.join(repo, "del.txt"));
  renameSync(path.join(repo, "old-name.txt"), path.join(repo, "new-name.txt"));
  put(repo, "空 格/中文 #[x].txt", "special changed\n");
  put(repo, "untracked file.txt", "new\n");
  return repo;
}
function unbornFixture() {
  const repo = initRepo("unborn");
  put(repo, "first.txt", "first\n"); put(repo, "second.txt", "second\n");
  git(repo, ["add", "-A"]);
  return repo;
}
function discardFixture() {
  const repo = initRepo("discard");
  put(repo, "a.txt", "a\n"); put(repo, "bin.dat", Buffer.from([1, 2, 3, 0, 4])); put(repo, "del.txt", "delete me\n"); put(repo, "keep.txt", "keep\n");
  const sub = path.join(repo, "sub");
  mkdirSync(sub, { recursive: true });
  git(sub, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["user.name", "Sub"], ["user.email", "sub@example.invalid"], ["commit.gpgsign", "false"]]) git(sub, ["config", key, value]);
  put(sub, "s.txt", "1\n"); commitAll(sub, "s1");
  commitAll(repo, "base");
  put(sub, "s.txt", "2\n"); git(sub, ["commit", "-q", "-am", "s2"]);
  put(repo, "a.txt", "worktree edit\r\nwith CRLF\r\n");
  put(repo, "bin.dat", Buffer.from([0, 159, 146, 150, 13, 10, 255]));
  unlinkSync(path.join(repo, "del.txt"));
  put(repo, "fresh/dir/new.bin", Buffer.from([9, 8, 7, 0, 6]));
  return repo;
}
function discardAllFixture() {
  const repo = initRepo("discard-all");
  put(repo, "s.txt", "base\n"); put(repo, "old.txt", "rename source with enough content\nline 2\nline 3\n"); put(repo, "gone.txt", "gone\n");
  commitAll(repo, "base");
  put(repo, "s.txt", "staged\n"); git(repo, ["add", "s.txt"]); put(repo, "s.txt", "staged, then edited\n");
  put(repo, "added.txt", "added in index\n"); git(repo, ["add", "added.txt"]);
  git(repo, ["mv", "old.txt", "moved.txt"]);
  git(repo, ["rm", "-q", "gone.txt"]);
  put(repo, "untracked.txt", "u\n");
  return repo;
}
function commitFixture() {
  const repo = initRepo("commit");
  put(repo, "base.txt", "base\n"); commitAll(repo, "base");
  const bare = path.join(runDir, "commit-remote.git");
  git(runDir, ["init", "-q", "--bare", "-b", "main", bare]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  put(repo, "one.txt", "one\n");
  return repo;
}
function mergeFixture() {
  const repo = initRepo("merge");
  put(repo, "m.txt", "base\n"); commitAll(repo, "base");
  put(repo, "main.txt", "main\n"); commitAll(repo, "main work");
  git(repo, ["switch", "-q", "-c", "side", "HEAD~1"]);
  put(repo, "side.txt", "side\n"); commitAll(repo, "side");
  git(repo, ["switch", "-q", "main"]);
  git(repo, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
  return repo;
}
function rootFixture() {
  const repo = initRepo("root");
  put(repo, "root.txt", "root\n"); commitAll(repo, "root commit");
  return repo;
}
function hooksFixture() {
  const repo = initRepo("hooks");
  put(repo, "h.txt", "base\n"); commitAll(repo, "base");
  put(repo, "h.txt", "change\n"); git(repo, ["add", "h.txt"]);
  return repo;
}
function readonlyFixture() {
  const repo = initRepo("readonly");
  for (let i = 0; i < 200; i++) put(repo, `files/${String(i).padStart(3, "0")}.txt`, `file ${i}\n`);
  put(repo, "change.txt", "base\n");
  commitAll(repo, "base");
  put(repo, "change.txt", "changed\n"); put(repo, "new.txt", "new\n");
  return repo;
}
function touchStat(repo) {
  // 只改 mtime、不改内容：index 的 stat 信息过期（只读路径若回写 index 会被发现）。
  for (let i = 0; i < 200; i++) { const f = path.join(repo, `files/${String(i).padStart(3, "0")}.txt`); writeFileSync(f, readFileSync(f)); }
}

// ---------- 实例与页面辅助 ----------
const V2_HELPERS = String.raw`
(() => {
  if (window.__v2) return true;
  const qa = (s) => [...document.querySelectorAll(s)];
  window.__v2 = {
    rowButton(path, label) { const r = window.__op.row(path); return r ? [...r.querySelectorAll('button')].find((b) => b.textContent === label) ?? null : null; },
    clickRow(path, label) { const b = window.__v2.rowButton(path, label); if (!b) throw new Error('行上没有按钮 ' + label + '：' + path); b.click(); },
    clickWith(path, init) { const r = window.__op.row(path); if (!r) throw new Error('没有行 ' + path); r.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })); },
    /** 多选：先普通点击第一个，其余 Ctrl + 点击。 */
    select(paths) { paths.forEach((p, i) => window.__v2.clickWith(p, i ? { ctrlKey: true } : {})); },
    selectedRows() { return qa('.file.selected').map((n) => n.getAttribute('aria-label')); },
    dialog() { const d = document.querySelector('.confirm-dialog'); return d ? { title: d.querySelector('h3')?.textContent, text: d.textContent, warning: d.querySelector('.confirm-warning')?.textContent ?? null, items: qa('.confirm-items li').map((n) => n.textContent) } : null; },
    dialogButton(label) { const b = qa('.confirm-dialog button').find((b) => b.textContent === label); if (!b) throw new Error('确认框没有按钮 ' + label); b.click(); },
    opStatus() { const n = document.querySelector('.op-status'); return n ? { cls: n.className, text: n.textContent } : null; },
    running() { return !!document.querySelector('.op-status.running'); },
    pending() { return document.querySelectorAll('.file.pending').length; },
    revision() { return /revision (\w+)/.exec(document.querySelector('.diff-footer')?.textContent ?? '')?.[1] ?? null; },
    setCommit(text) { const t = document.querySelector('textarea[aria-label="提交信息"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, text); t.dispatchEvent(new Event('input', { bubbles: true })); },
    commitText() { return document.querySelector('textarea[aria-label="提交信息"]')?.value ?? null; },
    tab(prefix) { return qa('.git-tabs button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    staged() { return Number(/提交 · (\d+)/.exec(window.__v2.tab('提交')?.textContent ?? '')?.[1] ?? NaN); },
    counts() { return document.querySelector('.branch-counts')?.textContent ?? null; },
    commitResult() { const n = document.querySelector('.commit-result'); return n ? { cls: n.className, text: n.textContent } : null; },
    commitReason() { return document.querySelector('.commit-reason')?.textContent ?? null; },
    button(text) { return qa('button').find((b) => b.textContent === text) ?? null; },
    banner() { return document.querySelector('.op-banner')?.textContent ?? null; },
    backups() { return qa('.backup-row').map((n) => n.textContent); },
    openMenu(path) { const r = window.__op.row(path); if (!r) throw new Error('没有行 ' + path); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 10 })); },
    menu() { const m = document.querySelector('.file-menu'); return m ? qa('.file-menu button').map((b) => ({ text: b.textContent, disabled: b.disabled, title: b.title })) : null; },
    menuItem(prefix) { return qa('.file-menu button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    closeMenu() { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); },
    async menuAction(path, prefix) { window.__v2.openMenu(path); await new Promise((r) => setTimeout(r, 50)); const b = window.__v2.menuItem(prefix); if (!b) throw new Error('右键菜单没有 ' + prefix); if (b.disabled) throw new Error('菜单项不可用 ' + prefix + '：' + b.title); b.click(); }
  };
  return true;
})()`;

async function start(profile, extraEnv = {}) {
  const app = await launchOris({ exe, profileDir: path.join(runDir, "profiles", profile), port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, `${profile}-cache`), ...extraEnv } });
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS + ";" + V2_HELPERS });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS); await evaluate(V2_HELPERS);
  // 按时间记录前端发出的 IPC（CDP Network 捕获 ipc.localhost 请求），用于解释等待。
  const ipc = [];
  app.cdp.on("Network.requestWillBeSent", (p) => { if (p.request.url.includes("ipc.localhost")) { const cmd = decodeURIComponent(new URL(p.request.url).pathname.slice(1)); if (!cmd.startsWith("plugin:")) { ipc.push({ at: Date.now(), cmd, id: p.requestId }); if (ipc.length > 400) ipc.shift(); } } });
  app.cdp.on("Network.loadingFinished", (p) => { const e = ipc.find((x) => x.id === p.requestId && x.ms === undefined); if (e) e.ms = Date.now() - e.at; });
  await call("Network.enable");
  log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const measure = (action, predicate, timeout = 15000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
  const shot = async (name) => { const file = path.join(shotDir, `${name}.png`); writeFileSync(file, await app.cdp.screenshot()); return path.relative(projectRoot, file); };
  const settle = () => waitUntil(`!window.__v2.running() && window.__v2.pending() === 0 && !window.__op.loading()`, 30000);
  const addProject = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 30000);
    await sleep(400);
  };
  const scope = async (label) => {
    const footer = await evaluate(`window.__op.footer()`);
    if (!footer.includes(label)) await measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) || document.querySelector('.batch-bar')`, 15000);
    await sleep(250);
  };
  const openTab = async (prefix) => { const active = await evaluate(`window.__v2.tab(${q(prefix)})?.classList.contains('active')`); if (!active) await evaluate(`window.__v2.tab(${q(prefix)}).click()`); await sleep(300); };
  const recentIpc = (n = 20) => ipc.slice(-n).map((e) => ({ ago: Date.now() - e.at, cmd: e.cmd, ms: e.ms ?? "pending" }));
  return { app, recentIpc, evaluate, waitUntil, measure, shot, settle, addProject, scope, openTab };
}
async function stop(ctx, force = false) {
  try { ctx.app.cdp.close(); } catch { /* 已关闭 */ }
  const result = await killOris({ ...ctx.app, force });
  log(`测试实例 PID ${ctx.app.pid} 已结束：${result.how}`);
  return result;
}
const rows = (ctx) => ctx.evaluate(`window.__op.rows()`);

// ================================ 功能验收 ================================
async function functional() {
  const traceDir = path.join(runDir, "trace2");
  mkdirSync(traceDir, { recursive: true });
  const repos = { stage: stageFixture(), unborn: unbornFixture(), discard: discardFixture(), discardAll: discardAllFixture(), commit: commitFixture(), merge: mergeFixture(), root: rootFixture(), hooks: hooksFixture(), readonly: readonlyFixture() };
  report.fixtures = repos;
  const env = { GIT_TRACE2_EVENT: traceDir };
  let ctx = await start("functional", env);
  const traceFiles = () => new Set(readdirSync(traceDir));
  const traceCommands = (names) => [...names].map((name) => { try { const first = readFileSync(path.join(traceDir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.event === "start"); return (first?.argv ?? []).slice(1).filter((a) => !a.startsWith("-c") && !/^core\.|^diff\.|^C:|^D:/.test(a) && a !== "-C" && a !== "--no-optional-locks").join(" "); } catch { return "?"; } });
  /** 统计一个动作（含其后 1.5 s 内的后台补齐）启动的 Git 进程。 */
  const traced = async (name, action) => {
    const before = traceFiles();
    const result = await action();
    await sleep(1500);
    const added = [...traceFiles()].filter((f) => !before.has(f));
    report.processes[name] = { count: added.length, commands: traceCommands(added).sort() };
    return result;
  };
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);

    // ---------- B05 stage / unstage ----------
    await ctx.addProject(repos.stage);
    await ctx.settle();
    const initialRows = await rows(ctx);
    check("B05 初始未暂存列表含修改 / 删除 / rename 两端 / 特殊字符 / 未跟踪", ["a.txt", "del.txt", "old-name.txt", "new-name.txt", "空 格/中文 #[x].txt", "untracked file.txt"].every((p) => initialRows.includes(p)) && initialRows.length === 6, initialRows);
    let before = fingerprint(repos.stage);
    const single = await traced("stage 单文件", () => ctx.measure(`window.__v2.clickRow('a.txt', '暂存')`, `!window.__op.row('a.txt')`, 5000));
    await ctx.settle();
    let e = evidence("stage a.txt", repos.stage, before, fingerprint(repos.stage), ["index"]);
    check("B05 单文件暂存：乐观反馈并由 Git 确认，只改 index", single.ok && e.unexpected.length === 0 && e.categories.join() === "index" && gitOut(repos.stage, ["diff", "--cached", "--name-only"]) === "a.txt", { single, e, shot: await ctx.shot("b05-after-single-stage") });
    before = fingerprint(repos.stage);
    // Shift 连续选择 + Ctrl 取消一项再加回，验证多选行为。
    await ctx.evaluate(`window.__v2.select(["del.txt", "old-name.txt", "new-name.txt", "空 格/中文 #[x].txt", "untracked file.txt"])`);
    await sleep(200);
    const multi = await ctx.evaluate(`window.__v2.selectedRows()`);
    check("Ctrl + 点击多选（无复选框）", multi.length === 5 && (await ctx.evaluate(`!document.querySelector('.file-check')`)), multi);
    await sleep(200);
    const batchShot = await ctx.shot("b05-batch-selection");
    await traced("stage 批量 5 个（右键菜单）", () => ctx.measure(`window.__v2.openMenu('del.txt'); setTimeout(() => window.__v2.menuItem('暂存').click(), 30)`, `window.__op.rows().length === 0`, 5000));
    await ctx.settle();
    e = evidence("stage 批量（删除、rename 两端、特殊字符、未跟踪）", repos.stage, before, fingerprint(repos.stage), ["index"]);
    const cached = gitOut(repos.stage, ["diff", "--cached", "--name-status", "-M"]);
    check("B05 多选批量暂存：删除、rename（暂存后配对）、特殊字符、未跟踪全部进入暂存区", e.unexpected.length === 0 && /D\tdel\.txt/.test(cached) && /R\d*\told-name\.txt\tnew-name\.txt/.test(cached) && cached.includes("空 格/中文 #[x].txt") && cached.includes("A\tuntracked file.txt"), { cached, e, batchShot });
    await ctx.scope("已暂存");
    const stagedRows = await rows(ctx);
    const renameRow = await ctx.evaluate(`window.__op.row('new-name.txt')?.textContent ?? ''`);
    check("B05 已暂存范围显示 rename（原路径）", renameRow.includes("old-name.txt") && stagedRows.length === 5, { stagedRows, renameRow, shot: await ctx.shot("b05-staged-scope") });
    before = fingerprint(repos.stage);
    await traced("unstage 单文件（rename）", () => ctx.measure(`window.__v2.clickRow('new-name.txt', '取消暂存')`, `!window.__op.row('new-name.txt')`, 5000));
    await ctx.settle();
    e = evidence("unstage rename", repos.stage, before, fingerprint(repos.stage), ["index"]);
    check("B05 取消暂存 rename：两端都回到未暂存", e.unexpected.length === 0 && !/name/.test(gitOut(repos.stage, ["diff", "--cached", "--name-only"])), { e });
    before = fingerprint(repos.stage);
    await ctx.evaluate(`window.__v2.clickWith("a.txt", {}); window.__v2.clickWith("untracked file.txt", { shiftKey: true })`);
    await sleep(200);
    const shiftRows = await ctx.evaluate(`window.__v2.selectedRows()`);
    check("Shift + 点击按显示顺序连续选择", shiftRows.length === 4, shiftRows);
    await ctx.measure(`window.__v2.openMenu('a.txt'); setTimeout(() => window.__v2.menuItem('取消暂存').click(), 30)`, `window.__op.rows().length === 0`, 5000);
    await ctx.settle();
    e = evidence("unstage 批量", repos.stage, before, fingerprint(repos.stage), ["index"]);
    check("B05 多选批量取消暂存后 index 回到 HEAD，工作区始终未变", e.unexpected.length === 0 && gitOut(repos.stage, ["diff", "--cached", "--name-only"]) === "", { e });
    // 乐观更新失败回滚：外部 index.lock（B16）。
    await ctx.scope("未暂存");
    const lock = path.join(repos.stage, ".git", "index.lock");
    writeFileSync(lock, "held by test");
    before = fingerprint(repos.stage);
    await traced("stage 遇到外部 index.lock（失败）", () => ctx.measure(`window.__v2.clickRow('a.txt', '暂存')`, `window.__v2.opStatus()?.cls.includes('failed')`, 5000));
    await sleep(300);
    const lockStatus = await ctx.evaluate(`window.__v2.opStatus()`);
    const rolledBack = await ctx.evaluate(`!!window.__op.row('a.txt') && window.__v2.pending() === 0`);
    e = evidence("stage 遇到外部 index.lock", repos.stage, before, fingerprint(repos.stage), []);
    check("B16 外部 index.lock：报错说明、不删除锁、仓库不变；B05 乐观更新回滚", rolledBack && existsSync(lock) && readFileSync(lock, "utf8") === "held by test" && e.changedCount === 0 && /index\.lock/.test(lockStatus?.text ?? ""), { lockStatus, rolledBack, e, processes: report.processes["stage 遇到外部 index.lock（失败）"], shot: await ctx.shot("b16-external-lock") });
    unlinkSync(lock);
    // 空 HEAD 取消暂存。
    await ctx.addProject(repos.unborn);
    await ctx.scope("已暂存");
    before = fingerprint(repos.unborn);
    await ctx.measure(`window.__v2.clickRow('first.txt', '取消暂存')`, `!window.__op.row('first.txt')`, 5000);
    await ctx.settle();
    e = evidence("空 HEAD 取消暂存", repos.unborn, before, fingerprint(repos.unborn), ["index"]);
    check("B05 空 HEAD 取消暂存：从 index 移除，工作区不变", e.unexpected.length === 0 && gitOut(repos.unborn, ["ls-files"]) === "second.txt" && existsSync(path.join(repos.unborn, "first.txt")), { e });
    before = fingerprint(repos.unborn);
    await ctx.scope("未暂存");
    await ctx.measure(`window.__v2.clickRow('first.txt', '暂存')`, `!window.__op.row('first.txt')`, 5000);
    await ctx.settle();
    e = evidence("空 HEAD 暂存", repos.unborn, before, fingerprint(repos.unborn), ["index"]);
    check("B05 空 HEAD 暂存", e.unexpected.length === 0 && gitOut(repos.unborn, ["ls-files"]).split("\n").length === 2, { e });

    // ---------- B06 discard ----------
    await ctx.addProject(repos.discard);
    await ctx.settle();
    const noRowDiscard = await ctx.evaluate(`!window.__v2.rowButton('a.txt', '丢弃…') && !window.__v2.button('丢弃所选…')`);
    await ctx.evaluate(`window.__v2.openMenu('sub')`); await sleep(100);
    const gitlinkMenu = await ctx.evaluate(`window.__v2.menu()`);
    const gitlinkShot = await ctx.shot("b06-gitlink-menu");
    await ctx.evaluate(`window.__v2.closeMenu()`); await sleep(100);
    const gitlinkItem = gitlinkMenu?.find((i) => i.text.startsWith("丢弃"));
    check("B06 丢弃只在右键菜单提供（文件行与批量栏没有丢弃按钮）；gitlink 的丢弃菜单项不可用并说明原因", noRowDiscard && gitlinkItem?.disabled && /gitlink/.test(gitlinkItem.title), { gitlinkMenu, gitlinkShot });
    before = fingerprint(repos.discard);
    await ctx.evaluate(`window.__v2.select(["a.txt", "bin.dat", "del.txt", "fresh/dir/new.bin"])`);
    await sleep(200);
    await ctx.evaluate(`window.__v2.openMenu('bin.dat')`); await sleep(100);
    const batchMenu = await ctx.evaluate(`window.__v2.menu()`);
    const batchMenuShot = await ctx.shot("b06-batch-context-menu");
    check("右键菜单支持多选批量：右键点在选中项上时对全部选中项暂存与丢弃", batchMenu?.some((i) => i.text === "暂存（4 个文件）" && !i.disabled) && batchMenu?.some((i) => i.text === "丢弃…（4 个文件）" && !i.disabled), { batchMenu, batchMenuShot });
    await ctx.evaluate(`window.__v2.menuItem('丢弃…').click()`);
    await ctx.waitUntil(`window.__v2.dialog()`, 10000);
    const discardDialog = await ctx.evaluate(`window.__v2.dialog()`);
    const discardShot = await ctx.shot("b06-discard-confirm");
    check("B06 丢弃确认框列出文件数与未跟踪文件，默认可撤销", discardDialog.title === "丢弃 4 个文件的改动" && discardDialog.text.includes("1 个是未跟踪文件") && !discardDialog.warning && discardDialog.items.length === 4, { discardDialog, discardShot });
    check("B17 打开丢弃确认框（只读计算）不改动仓库", fingerprint(repos.discard).digest === before.digest);
    await traced("discard 未暂存 4 个（含备份）", async () => { await ctx.evaluate(`window.__v2.dialogButton('丢弃')`); await ctx.waitUntil(`window.__v2.opStatus()?.text.includes('已丢弃')`, 15000); });
    await ctx.settle();
    e = evidence("discard 未暂存（已跟踪修改、二进制、删除、未跟踪）", repos.discard, before, fingerprint(repos.discard), ["worktree", "index"]);
    const statusAfterDiscard = gitOut(repos.discard, ["status", "--porcelain", "--untracked-files=all"]);
    check("B06 未暂存范围丢弃：已跟踪恢复到 index、未跟踪删除（空目录清理）", statusAfterDiscard === "M sub" || statusAfterDiscard === " M sub", { statusAfterDiscard, freshExists: existsSync(path.join(repos.discard, "fresh")), e });
    const undoButton = await ctx.evaluate(`!!document.querySelector('.op-undo')`);
    await ctx.shot("b06-after-discard-statusbar");
    const beforeUndo = fingerprint(repos.discard);
    await traced("撤销丢弃 4 个", async () => { await ctx.evaluate(`document.querySelector('.op-undo').click()`); await ctx.waitUntil(`window.__v2.opStatus()?.text.includes('已撤销丢弃')`, 15000); });
    await ctx.settle();
    const restored = fingerprint(repos.discard);
    e = evidence("撤销丢弃（未暂存）", repos.discard, beforeUndo, restored, ["worktree", "index"]);
    const worktreeOnly = (f) => Object.fromEntries(Object.entries(f.entries).filter(([k]) => !k.startsWith(".git") && !k.startsWith("sub/.git")));
    check("B06 撤销丢弃：工作区逐字节恢复（CRLF、二进制、删除状态、未跟踪）", undoButton && q(worktreeOnly(restored)) === q(worktreeOnly(before)) && readFileSync(path.join(repos.discard, "a.txt")).equals(Buffer.from("worktree edit\r\nwith CRLF\r\n")), { e });
    // 丢弃后又被修改：再次确认。
    await ctx.evaluate(`window.__v2.menuAction('a.txt', '丢弃…')`);
    await ctx.waitUntil(`window.__v2.dialog()`, 10000);
    await ctx.evaluate(`window.__v2.dialogButton('丢弃')`);
    await ctx.waitUntil(`window.__v2.opStatus()?.text.includes('已丢弃')`, 15000);
    await ctx.settle();
    writeFileSync(path.join(repos.discard, "a.txt"), "edited again after discard\n");
    await sleep(1200);
    before = fingerprint(repos.discard);
    await ctx.evaluate(`document.querySelector('.op-undo').click()`);
    await ctx.waitUntil(`window.__v2.dialog()`, 10000);
    const modifiedDialog = await ctx.evaluate(`window.__v2.dialog()`);
    await ctx.shot("b06-undo-modified-confirm");
    await ctx.evaluate(`window.__v2.dialogButton('取消')`);
    await sleep(300);
    const cancelledSame = fingerprint(repos.discard).digest === before.digest;
    await ctx.evaluate(`document.querySelector('.op-undo').click()`);
    await ctx.waitUntil(`window.__v2.dialog()`, 10000);
    await ctx.evaluate(`window.__v2.dialogButton('覆盖并撤销')`);
    await ctx.waitUntil(`window.__v2.opStatus()?.text.includes('已撤销丢弃')`, 15000);
    await ctx.settle();
    e = evidence("撤销丢弃（文件在丢弃后又被修改，确认覆盖）", repos.discard, before, fingerprint(repos.discard), ["worktree", "index"]);
    check("B06 丢弃后文件又被修改：撤销前再次确认，取消不改动，确认后恢复", /又被修改/.test(modifiedDialog?.text ?? "") && cancelledSame && readFileSync(path.join(repos.discard, "a.txt"), "utf8") === "worktree edit\r\nwith CRLF\r\n", { modifiedDialog, cancelledSame, e });
    // 超出备份预算：不可撤销。
    writeFileSync(path.join(repos.discard, "huge.log.bin"), Buffer.alloc(50 * 1024 * 1024 + 1, 120));
    await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await ctx.waitUntil(`!!window.__op.row('huge.log.bin')`, 20000);
    await ctx.settle();
    before = fingerprint(repos.discard);
    await ctx.evaluate(`window.__v2.menuAction('huge.log.bin', '丢弃…')`);
    await ctx.waitUntil(`window.__v2.dialog()`, 15000);
    const hugeDialog = await ctx.evaluate(`window.__v2.dialog()`);
    const hugeShot = await ctx.shot("b06-unrecoverable-confirm");
    await ctx.evaluate(`window.__v2.dialogButton('丢弃（含不可撤销）')`);
    await ctx.waitUntil(`window.__v2.opStatus()?.text.includes('已丢弃')`, 20000);
    await ctx.settle();
    e = evidence("discard 超出备份预算的文件", repos.discard, before, fingerprint(repos.discard), ["worktree", "index"]);
    await ctx.openTab("操作输出");
    const backupRows = await ctx.evaluate(`window.__v2.backups()`);
    check("B06 超出 50 MiB 备份预算：确认框标注不可撤销，丢弃记录标注不可撤销", /不可撤销/.test(hugeDialog?.warning ?? "") && !existsSync(path.join(repos.discard, "huge.log.bin")) && /不可撤销/.test(backupRows[0] ?? ""), { hugeDialog, backupRows, hugeShot, e, outputShot: await ctx.shot("b06-output-tab-backups") });
    // “全部”范围。
    await ctx.addProject(repos.discardAll);
    await ctx.scope("全部");
    await ctx.settle();
    const allRows = await rows(ctx);
    const indexBefore = gitOut(repos.discardAll, ["ls-files", "-s"]);
    before = fingerprint(repos.discardAll);
    await ctx.evaluate(`window.__v2.select(${q(allRows)})`);
    await sleep(200);
    await ctx.evaluate(`window.__v2.menuAction(${q(allRows[0])}, '丢弃…')`);
    await ctx.waitUntil(`window.__v2.dialog()`, 10000);
    const allDialog = await ctx.evaluate(`window.__v2.dialog()`);
    await traced("discard 全部范围", async () => { await ctx.evaluate(`window.__v2.dialogButton('丢弃')`); await ctx.waitUntil(`window.__v2.opStatus()?.text.includes('已丢弃')`, 15000); });
    await ctx.settle();
    e = evidence("discard 全部范围（暂存+工作区修改、index 新增、暂存 rename、暂存删除、未跟踪）", repos.discardAll, before, fingerprint(repos.discardAll), ["worktree", "index"]);
    const cleanAll = gitOut(repos.discardAll, ["status", "--porcelain", "--untracked-files=all"]);
    check("B06 “全部”范围丢弃：index 与工作区都回到 HEAD", cleanAll === "" && /HEAD/.test(allDialog?.text ?? ""), { allRows, allDialog, cleanAll, e });
    const beforeAllUndo = fingerprint(repos.discardAll);
    await ctx.openTab("操作输出");
    await ctx.evaluate(`document.querySelector('.backup-row button').click()`);
    await ctx.waitUntil(`window.__v2.opStatus()?.text.includes('已撤销丢弃')`, 15000);
    await ctx.settle();
    const afterAllUndo = fingerprint(repos.discardAll);
    e = evidence("撤销丢弃（全部范围）", repos.discardAll, beforeAllUndo, afterAllUndo, ["worktree", "index"]);
    check("B06 撤销“全部”范围丢弃：暂存内容（ls-files -s）与工作区都恢复", gitOut(repos.discardAll, ["ls-files", "-s"]) === indexBefore && q(worktreeOnly(afterAllUndo)) === q(worktreeOnly(before)), { e });

    // ---------- B07 commit / amend / undo ----------
    await ctx.addProject(repos.commit);
    await ctx.settle();
    await ctx.openTab("提交");
    await ctx.waitUntil(`(window.__v2.button('撤销最近提交…')?.title ?? '').includes('origin/main')`, 10000).catch(() => {});
    check("B07 已推送的 HEAD：撤销与 amend 不可用并说明原因", await ctx.evaluate(`(() => { const b = window.__v2.button('撤销最近提交…'); return b.disabled && /origin\\/main/.test(b.title); })()`), { title: await ctx.evaluate(`window.__v2.button('撤销最近提交…')?.title`), debug: await ctx.evaluate(`(async () => { const ws = JSON.parse(localStorage.getItem('oris.workspace.v2')); try { return { active: ws.activeRepoId, head: await window.__TAURI_INTERNALS__.invoke('head_commit_info', { repoId: ws.activeRepoId }), ipc: IPCLOG, side: { loaded: document.querySelector('.commit-side')?.dataset.headOid, snapshot: document.querySelector('.commit-side')?.dataset.snapshotHead }, git: gitHead }; } catch (e) { return { error: String(e?.message ?? JSON.stringify(e)) }; } })()`.replace("gitHead", q(gitOut(repos.commit, ["rev-parse", "HEAD"]))).replace("IPCLOG", q(ctx.recentIpc()))) });
    const pushedShot = await ctx.shot("b07-pushed-protection");
    await ctx.evaluate(`window.__v2.clickRow('one.txt', '暂存')`);
    await ctx.settle();
    await ctx.evaluate(`window.__v2.setCommit(${q("feat: 第一个本地提交\n\n正文 & \"引号\"")})`);
    before = fingerprint(repos.commit);
    const commitRun = await traced("commit（无 hooks）", () => ctx.measure(`window.__v2.button('提交').click()`, `window.__v2.commitResult()?.cls.includes('succeeded') && window.__v2.staged() === 0 && (window.__v2.counts() ?? '').includes('↑1')`, 15000));
    e = evidence("commit", repos.commit, before, fingerprint(repos.commit), ["index", "refs"]);
    check("B07 commit：信息原样写入，文件列表、分支领先计数刷新，草稿清空", commitRun.ok && gitOut(repos.commit, ["log", "-1", "--format=%B"]) === "feat: 第一个本地提交\n\n正文 & \"引号\"" && (await ctx.evaluate(`window.__v2.commitText()`)) === "" && e.unexpected.length === 0, { commitRun, e, pushedShot, shot: await ctx.shot("b07-after-commit") });
    // amend 只改信息。
    await ctx.evaluate(`document.querySelector('input[aria-label="修订最近一次提交（amend）"]').click()`);
    await sleep(200);
    const prefill = await ctx.evaluate(`window.__v2.commitText()`);
    await ctx.evaluate(`window.__v2.setCommit('feat: 改过的信息')`);
    const parentBefore = gitOut(repos.commit, ["rev-parse", "HEAD~1"]);
    before = fingerprint(repos.commit);
    await ctx.measure(`window.__v2.button('修订提交').click()`, `window.__v2.commitResult()?.text.includes('已修订提交')`, 15000);
    await ctx.settle();
    e = evidence("amend（只改信息）", repos.commit, before, fingerprint(repos.commit), ["index", "refs"]);
    check("B07 amend 只改信息：默认填入原信息，父提交不变", prefill === "feat: 第一个本地提交\n\n正文 & \"引号\"" && gitOut(repos.commit, ["log", "-1", "--format=%s"]) === "feat: 改过的信息" && gitOut(repos.commit, ["rev-parse", "HEAD~1"]) === parentBefore && e.unexpected.length === 0, { prefill, e });
    // amend 并入暂存（信息不改 → --no-edit）。
    put(repos.commit, "two.txt", "two\n");
    await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await ctx.waitUntil(`!!window.__op.row('two.txt')`, 20000);
    await ctx.settle();
    await ctx.evaluate(`window.__v2.clickRow('two.txt', '暂存')`);
    await ctx.settle();
    await ctx.evaluate(`document.querySelector('input[aria-label="修订最近一次提交（amend）"]').click()`);
    await sleep(200);
    before = fingerprint(repos.commit);
    await ctx.measure(`window.__v2.button('修订提交').click()`, `window.__v2.commitResult()?.text.includes('已修订提交') && window.__v2.staged() === 0`, 15000);
    await ctx.settle();
    e = evidence("amend（并入暂存，信息不变）", repos.commit, before, fingerprint(repos.commit), ["index", "refs"]);
    check("B07 amend 并入暂存：信息不变，提交包含新文件", gitOut(repos.commit, ["log", "-1", "--format=%s"]) === "feat: 改过的信息" && gitOut(repos.commit, ["ls-tree", "--name-only", "HEAD"]).includes("two.txt") && e.unexpected.length === 0, { e });
    // 撤销普通提交。
    const headBeforeUndo = gitOut(repos.commit, ["rev-parse", "HEAD"]);
    await ctx.waitUntil(`!window.__v2.button('撤销最近提交…').disabled && window.__v2.button('撤销最近提交…').title.includes(${q(headBeforeUndo.slice(0, 8))})`, 10000);
    before = fingerprint(repos.commit);
    await ctx.evaluate(`window.__v2.button('撤销最近提交…').click()`);
    await ctx.waitUntil(`window.__v2.dialog()`, 10000);
    const undoDialog = await ctx.evaluate(`window.__v2.dialog()`);
    const undoShot = await ctx.shot("b07-undo-confirm");
    await traced("撤销最近提交", async () => { await ctx.evaluate(`window.__v2.dialogButton('撤销提交')`); await ctx.waitUntil(`window.__v2.commitResult()?.text.includes('已撤销提交')`, 15000); });
    await ctx.settle();
    e = evidence("撤销最近提交（普通）", repos.commit, before, fingerprint(repos.commit), ["refs", "index"]);
    check("B07 撤销普通提交：HEAD 回到上游，改动回到暂存区，工作区不变", /回退一个提交/.test(undoDialog?.text ?? "") && gitOut(repos.commit, ["rev-parse", "HEAD"]) === gitOut(repos.commit, ["rev-parse", "origin/main"]) && gitOut(repos.commit, ["diff", "--cached", "--name-only"]).split("\n").sort().join() === "one.txt,two.txt" && !e.categories.includes("worktree") && headBeforeUndo !== gitOut(repos.commit, ["rev-parse", "HEAD"]), { undoDialog, undoShot, e });
    // 草稿按项目保存、重启后恢复。
    await ctx.evaluate(`window.__v2.setCommit('草稿：重启后应恢复')`);
    await sleep(300);
    await stop(ctx);
    ctx = await start("functional", env);
    await ctx.waitUntil(`window.__op.status().startsWith(${q(repos.commit)}) && !window.__op.loading()`, 30000);
    await ctx.settle();
    await ctx.openTab("提交");
    check("B07 草稿按项目保存并在重启后恢复", (await ctx.evaluate(`window.__v2.commitText()`)) === "草稿：重启后应恢复", await ctx.evaluate(`window.__v2.commitText()`));
    // 合并提交与根提交的撤销。
    for (const [key, name, expectHead, text] of [["merge", "撤销合并提交", () => gitOut(repos.merge, ["rev-parse", "HEAD^1"]), "第一个父提交"], ["root", "撤销根提交", () => null, "根提交"]]) {
      const repo = repos[key];
      const expected = expectHead();
      await ctx.addProject(repo);
      await ctx.settle();
      await ctx.openTab("提交");
      await ctx.waitUntil(`window.__v2.button('撤销最近提交…') && !window.__v2.button('撤销最近提交…').disabled`, 10000);
      before = fingerprint(repo);
      await ctx.evaluate(`window.__v2.button('撤销最近提交…').click()`);
      await ctx.waitUntil(`window.__v2.dialog()`, 10000);
      const dialog = await ctx.evaluate(`window.__v2.dialog()`);
      await ctx.evaluate(`window.__v2.dialogButton('撤销提交')`);
      await ctx.waitUntil(`window.__v2.commitResult()?.text.includes('已撤销')`, 15000);
      await ctx.settle();
      e = evidence(name, repo, before, fingerprint(repo), ["refs", "index"]);
      const head = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true });
      check(`B07 ${name}：确认框说明后果，结果正确`, dialog?.text.includes(text) && (expected ? head === expected : head === "") && !e.categories.includes("worktree"), { dialog: dialog?.text, head, e, shot: await ctx.shot(`b07-${key}-undo`) });
    }
    check("B07 根提交撤销后文件保留在暂存区", gitOut(repos.root, ["ls-files"]) === "root.txt" && existsSync(path.join(repos.root, "root.txt")));

    // ---------- B08 hooks、取消、签名 ----------
    await ctx.addProject(repos.hooks);
    await ctx.settle();
    await ctx.openTab("提交");
    writeFileSync(path.join(repos.hooks, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'HOOK-FAIL-MARKER: lint failed' >&2\necho 'second line of hook output'\nexit 1\n");
    const hooksHead = gitOut(repos.hooks, ["rev-parse", "HEAD"]);
    await ctx.evaluate(`window.__v2.setCommit('will be blocked by hook')`);
    before = fingerprint(repos.hooks);
    await ctx.measure(`window.__v2.button('提交').click()`, `window.__v2.commitResult()?.cls.includes('failed')`, 15000);
    await ctx.settle();
    const hookResult = await ctx.evaluate(`window.__v2.commitResult()`);
    e = evidence("commit 被 pre-commit 拒绝", repos.hooks, before, fingerprint(repos.hooks), ["index"]);
    check("B08 pre-commit 失败：展示 hook 输出，没有生成提交，草稿保留", /HOOK-FAIL-MARKER/.test(hookResult.text) && /second line/.test(hookResult.text) && /没有生成提交/.test(hookResult.text) && gitOut(repos.hooks, ["rev-parse", "HEAD"]) === hooksHead && (await ctx.evaluate(`window.__v2.commitText()`)) === "will be blocked by hook", { hookResult, e, shot: await ctx.shot("b08-hook-failed") });
    // 长时间运行的 hook：运行中其他写入口不可用（B16），取消后整个进程树结束。
    const marker = path.join(repos.hooks, ".git", "hook-finished").replace(/\\/g, "/");
    const startedMarker = path.join(repos.hooks, ".git", "hook-started").replace(/\\/g, "/");
    writeFileSync(path.join(repos.hooks, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho started > '${startedMarker}'\necho 'long hook running'\nsleep 20\necho finished > '${marker}'\n`);
    put(repos.hooks, "other.txt", "other\n");
    await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await ctx.waitUntil(`!!window.__op.row('other.txt')`, 20000);
    await ctx.settle();
    before = fingerprint(repos.hooks);
    await ctx.evaluate(`window.__v2.button('提交').click()`);
    const deadline = Date.now() + 20000;
    while (!existsSync(startedMarker) && Date.now() < deadline) await sleep(50);
    await sleep(300);
    const busy = await ctx.evaluate(`(() => { const b = window.__v2.rowButton('other.txt', '暂存'); return { running: window.__v2.running(), stageDisabled: b?.disabled, title: b?.title, progress: document.querySelector('.commit-progress')?.textContent ?? '' }; })()`);
    const runningShot = await ctx.shot("b08-hook-running");
    const treeBefore = processTree(ctx.app.pid).processes.map((p) => p.name.toLowerCase());
    const cancel = await ctx.measure(`window.__v2.button('取消').click()`, `window.__v2.commitResult()?.cls.includes('cancelled')`, 15000);
    await sleep(1500);
    const treeAfter = processTree(ctx.app.pid).processes.map((p) => p.name.toLowerCase());
    const gitAfter = gitChildren(ctx.app.pid).map((p) => p.commandLine ?? "");
    const hookChildren = (names) => names.filter((n) => ["sh.exe", "bash.exe", "sleep.exe"].includes(n));
    await sleep(2500);
    // hook-started 是测试 hook 自己写入 .git 的标记文件。
    e = evidence("commit 在 hook 运行中取消", repos.hooks, before, fingerprint(repos.hooks), ["index", "git:hook-started"]);
    const cancelResult = await ctx.evaluate(`window.__v2.commitResult()`);
    check("B16 写操作运行期间同仓库其他写入口不可用", busy.running && busy.stageDisabled && /正在执行/.test(busy.title ?? ""), { busy, runningShot });
    check("B08 运行中取消：进程树（git → sh → sleep）全部结束，没有生成提交", cancel.ok && hookChildren(treeBefore).length > 0 && hookChildren(treeAfter).length === 0 && !gitAfter.some((c) => / commit /.test(c)) && !existsSync(marker) && gitOut(repos.hooks, ["rev-parse", "HEAD"]) === hooksHead && /没有生成提交/.test(cancelResult?.text ?? ""), { cancelMs: cancel.ms, treeBefore: hookChildren(treeBefore), treeAfter: hookChildren(treeAfter), gitAfter, cancelResult, e, shot: await ctx.shot("b08-cancelled") });
    rmSync(path.join(repos.hooks, ".git", "hooks", "pre-commit"));
    // 签名：配置了但不可用 → 清晰错误；可用的签名程序（测试替身）→ 提交带签名。
    git(repos.hooks, ["config", "commit.gpgsign", "true"]);
    git(repos.hooks, ["config", "gpg.program", path.join(runDir, "no-such-gpg.exe")]);
    await ctx.evaluate(`window.__v2.setCommit('needs signature')`);
    await ctx.measure(`window.__v2.button('提交').click()`, `window.__v2.commitResult()?.cls.includes('failed')`, 15000);
    const signFail = await ctx.evaluate(`window.__v2.commitResult()`);
    check("B08 签名配置不可用：给出清晰错误，没有生成提交", /gpg/i.test(signFail.text) && gitOut(repos.hooks, ["rev-parse", "HEAD"]) === hooksHead, { signFail, shot: await ctx.shot("b08-sign-error") });
    const fakeGpg = path.join(runDir, "fake-gpg.sh");
    writeFileSync(fakeGpg, "#!/bin/sh\ncat >/dev/null\necho >&2\necho '[GNUPG:] SIG_CREATED D 1 8 00 1700000000 FAKE' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n");
    git(repos.hooks, ["config", "gpg.program", fakeGpg.replace(/\\/g, "/")]);
    await ctx.measure(`window.__v2.button('提交').click()`, `window.__v2.commitResult()?.cls.includes('succeeded')`, 15000);
    await ctx.settle();
    check("B08 签名按 git config 生效（提交对象带 gpgsig）", /gpgsig -----BEGIN PGP SIGNATURE-----/.test(gitOut(repos.hooks, ["cat-file", "commit", "HEAD"])));
    git(repos.hooks, ["config", "commit.gpgsign", "false"]);

    // ---------- B16 不支持的进行中状态 ----------
    mkdirSync(path.join(repos.hooks, ".git", "rebase-merge"), { recursive: true });
    await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await ctx.waitUntil(`window.__v2.banner()`, 20000);
    put(repos.hooks, "later.txt", "x\n");
    await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await ctx.waitUntil(`!!window.__op.row('later.txt')`, 20000);
    const rebaseState = await ctx.evaluate(`({ banner: window.__v2.banner(), stage: window.__v2.rowButton('later.txt', '暂存')?.disabled, title: window.__v2.rowButton('later.txt', '暂存')?.title })`);
    check("B16 外部 rebase 进行中：横幅说明，写入口全部不可用，阅读正常", /rebase/.test(rebaseState.banner ?? "") && rebaseState.stage === true, { rebaseState, shot: await ctx.shot("b16-rebase-banner") });
    rmSync(path.join(repos.hooks, ".git", "rebase-merge"), { recursive: true });

    // ---------- B17 只读回归 ----------
    touchStat(repos.readonly);
    await sleep(1100);
    const roBefore = fingerprint(repos.readonly);
    await ctx.addProject(repos.readonly);
    await ctx.settle();
    for (const label of ["已暂存", "全部", "未暂存"]) await ctx.scope(label);
    for (const p of (await rows(ctx)).slice(0, 2)) { await ctx.evaluate(`window.__op.row(${q(p)}).click()`); await sleep(400); }
    await ctx.openTab("提交");
    await sleep(600);
    await ctx.openTab("操作输出");
    await ctx.evaluate(`window.__v2.menuAction('change.txt', '丢弃…')`);
    await ctx.waitUntil(`window.__v2.dialog()`, 10000);
    await ctx.evaluate(`window.__v2.dialogButton('取消')`);
    await ctx.evaluate(`window.__op.projectTab(${q(repos.hooks)}).querySelector('.project-switch').click()`);
    await sleep(800);
    await ctx.evaluate(`window.__op.projectTab(${q(repos.readonly)}).querySelector('.project-switch').click()`);
    await sleep(1500);
    const roAfterBrowse = fingerprint(repos.readonly);
    // 重启：快照恢复与校验。
    await stop(ctx);
    ctx = await start("functional", env);
    await ctx.waitUntil(`window.__op.status().startsWith(${q(repos.readonly)}) && !document.querySelector('.stale-badge.verifying')`, 30000);
    await sleep(1500);
    const roAfterRestart = fingerprint(repos.readonly);
    const browseChanged = diffFingerprints(roBefore, roAfterBrowse);
    const restartChanged = diffFingerprints(roBefore, roAfterRestart);
    check("B17 浏览、切换范围 / 文件 / 项目、打开提交页与丢弃确认框、重启与快照恢复：工作区、index、refs、config 都不变", browseChanged.length === 0 && restartChanged.length === 0, { browseChanged, restartChanged });
    await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await sleep(2500);
    const manualChanged = diffFingerprints(roBefore, fingerprint(repos.readonly));
    check("B17 stat 缓存回写只出现在限定时机：手动刷新只改 .git/index", manualChanged.join() === ".git/index", manualChanged);
  } catch (error) {
    fail(`功能验收中断：${String(error.stack ?? error).slice(0, 800)}`);
    try { await ctx.shot("functional-failure"); } catch { /* ignore */ }
  } finally {
    report.stopFunctional = await stop(ctx);
  }
}

// ================================ 时延 ================================
async function latency() {
  const [s1] = await prepareCoreRepos(path.join(runDir, "latency"), 1);
  const repo = s1.path;
  // 提交时延需要上游，以便测到“分支状态（领先计数）刷新”。
  const bare = path.join(runDir, "latency-remote.git");
  git(runDir, ["clone", "-q", "--bare", repo, bare]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["fetch", "-q", "origin"]);
  const branch = git(repo, ["symbolic-ref", "--short", "HEAD"]);
  git(repo, ["branch", "-q", "-u", `origin/${branch}`]);
  for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"]]) git(repo, ["config", key, value]);
  const ctx = await start("latency");
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    await ctx.addProject(repo);
    await ctx.settle();
    await sleep(1500);
    const unstagedOnly = s1.manifest.manifest.filter((m) => m.type === "unstaged").map((m) => m.path);
    const listed = await rows(ctx);
    const target = listed.find((p) => unstagedOnly.includes(p));
    const stage = [], unstage = [], stageConfirm = [], unstageConfirm = [];
    for (let i = 0; i < iterations; i++) {
      await ctx.scope("未暂存");
      await sleep(300);
      const rev = await ctx.evaluate(`window.__v2.revision()`);
      const optimistic = ctx.measure(`window.__v2.clickRow(${q(target)}, '暂存')`, `!window.__op.row(${q(target)})`, 5000);
      const confirmed = ctx.measure(``, `window.__v2.pending() === 0 && !window.__v2.running() && window.__v2.revision() !== ${q(rev)} && window.__v2.opStatus()?.text.includes('已暂存')`, 10000);
      stage.push(await optimistic); stageConfirm.push(await confirmed);
      await ctx.settle();
      await ctx.scope("已暂存");
      await sleep(300);
      const rev2 = await ctx.evaluate(`window.__v2.revision()`);
      const optimistic2 = ctx.measure(`window.__v2.clickRow(${q(target)}, '取消暂存')`, `!window.__op.row(${q(target)})`, 5000);
      const confirmed2 = ctx.measure(``, `window.__v2.pending() === 0 && !window.__v2.running() && window.__v2.revision() !== ${q(rev2)} && window.__v2.opStatus()?.text.includes('已取消暂存')`, 10000);
      unstage.push(await optimistic2); unstageConfirm.push(await confirmed2);
      await ctx.settle();
    }
    report.timings.stageOptimistic = { what: "点击行上“暂存”到该行离开未暂存列表（下一帧）", target, samples: stage, summary: summarize(stage) };
    report.timings.stageConfirm = { what: "点击到 Git 确认（确认中标记消失、revision 更新、状态栏显示结果）", samples: stageConfirm, summary: summarize(stageConfirm) };
    report.timings.unstageOptimistic = { samples: unstage, summary: summarize(unstage) };
    report.timings.unstageConfirm = { samples: unstageConfirm, summary: summarize(unstageConfirm) };
    log("stage 乐观 / 确认", report.timings.stageOptimistic.summary, report.timings.stageConfirm.summary);
    log("unstage 乐观 / 确认", report.timings.unstageOptimistic.summary, report.timings.unstageConfirm.summary);
    // commit（无 hooks）：到文件列表与分支状态刷新。数据集中用 update-index 构造的冲突条目会阻止提交，
    // 先在夹具中解决并提交已暂存的改动（不计入测量），之后每次提交一个新文件。
    const conflicted = s1.manifest.manifest.filter((m) => m.type === "conflicted").map((m) => m.path);
    for (let i = 0; i < conflicted.length; i += 200) git(repo, ["add", "--", ...conflicted.slice(i, i + 200)]);
    git(repo, ["commit", "-q", "-m", "fixture: commit staged dataset changes"]);
    await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await ctx.waitUntil(`window.__v2.staged() === 0`, 20000);
    await ctx.settle();
    await ctx.scope("未暂存");
    await ctx.openTab("提交");
    const commits = [];
    for (let i = 0; i < iterations; i++) {
      const rel = `probe-commit/c-${String(i).padStart(3, "0")}.txt`;
      put(repo, rel, `commit probe ${i}\n`);
      await ctx.evaluate(`window.__op.button('↻ 本地刷新').click()`);
      await ctx.waitUntil(`!!window.__op.row(${q(rel)})`, 20000);
      await ctx.settle();
      await ctx.evaluate(`window.__v2.clickRow(${q(rel)}, '暂存')`);
      await ctx.settle();
      await ctx.evaluate(`window.__v2.setCommit(${q(`probe commit ${i}`)})`);
      await sleep(300);
      const ahead = Number(/↑(\d+)/.exec((await ctx.evaluate(`window.__v2.counts()`)) ?? "")?.[1] ?? NaN);
      commits.push({ i, aheadBefore: ahead, ...(await ctx.measure(`window.__v2.button('提交').click()`, `window.__v2.commitResult()?.cls.includes('succeeded') && window.__v2.staged() === 0 && (window.__v2.counts() ?? '').includes('↑${ahead + 1} ') && !window.__op.row(${q(rel)})`, 15000)) });
      await ctx.settle();
      await sleep(300);
    }
    report.timings.commit = { what: "点击“提交”到文件列表与分支领先计数刷新（下一帧），无 hooks，S 数据集", samples: commits, summary: summarize(commits) };
    log("commit", report.timings.commit.summary);
  } catch (error) {
    fail(`时延测量中断：${String(error.stack ?? error).slice(0, 800)}`);
    try { await ctx.shot("latency-failure"); } catch { /* ignore */ }
  } finally {
    report.stopLatency = await stop(ctx);
  }
}

if (only === "all" || only === "functional") await functional();
if (only === "all" || only === "latency") await latency();
report.finishedAt = new Date().toISOString();
report.passed = report.failures.length === 0;
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
log(report.passed ? "全部检查通过" : `失败 ${report.failures.length} 项`, path.join(outDir, "report.json"));
if (!keep) log(removeDir(runDir, GUI_ROOT) ? `已清理 ${runDir}` : `未能完全清理 ${runDir}`);
process.exitCode = report.passed ? 0 : 1;
