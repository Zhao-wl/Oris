// V1-04 界面验收：A07–A10、B17 只读回归、键盘浏览与大量提交渐进加载（只做计数类断言，不计时）。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 点击、按键与输入是 CDP 注入的页面事件，不是真实鼠标、键盘或系统焦点。
// 每个 fetch 都记录操作前后的仓库指纹（index、HEAD 与本地分支、远端跟踪引用、config、工作区；不含 .git/objects 与 .git/logs）。
// 用法：node scripts/perf/v1-04-acceptance.mjs --exe <oris.exe> [--port 9831] [--only history|remote|real] [--run-id 20260924-2031] [--keep]
//   --only real 需要 --run-id：在 %TEMP%\oris-remote\<run-id> 下克隆 AgentHub（SSH 与 HTTPS），只创建 / 删除 oris-test/<run-id>/ 分支。
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, encodePng, killOris, launchOris, processTree, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
let port = Number(option("port", 9831));
const only = option("only", "all");
const runId = option("run-id", null);
const keep = args.includes("--keep");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v1-04-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-04-acceptance-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const REMOTE_ROOT = realpathSync.native(tmpdir()) + path.sep + "oris-remote";
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), startedAt: new Date().toISOString(), runDir, method: "CDP 页面事件（点击、按键、输入、滚动）；不是真实鼠标、键盘或系统焦点。仓库指纹为 .git（不含 objects/logs）与工作区逐文件 SHA-256。", checks: {}, operations: [], processes: {}, failures: [], environment: { GCM_INTERACTIVE: process.env.GCM_INTERACTIVE ?? null, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null, GIT_ASKPASS: process.env.GIT_ASKPASS ?? null } };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)}`); };

// ---------- 仓库指纹 ----------
const fingerprint = (repo) => repositoryFingerprint(repo);
function categorize(keys) {
  return [...new Set(keys.map((k) => k === ".git/index" ? "index"
    : (k === ".git/HEAD" || k.startsWith(".git/refs/heads/")) ? "head"
    : (k.startsWith(".git/refs/remotes/") || k.startsWith(".git/refs/tags/") || k === ".git/packed-refs") ? "remote-refs"
    : k === ".git/config" ? "config"
    : k.startsWith(".git/") ? `git:${k.slice(5)}` : "worktree"))].sort();
}
/** fetch 的对比：操作结束时的刷新允许回写 index 的 stat 缓存（V2-D09），只在 `ls-files -s` 的条目完全不变时允许 index 字节变化。 */
function fetchEvidence(name, repo, before, beforeIndex, allowed) {
  const sameIndex = git(repo, ["ls-files", "-s"]) === beforeIndex;
  const entry = evidence(name, repo, before, fingerprint(repo), sameIndex ? [...allowed, "index"] : allowed);
  entry.indexEntriesUnchanged = sameIndex;
  return entry;
}
function evidence(name, repo, before, after, allowed) {
  const changed = diffFingerprints(before, after);
  const categories = categorize(changed);
  const unexpected = categories.filter((c) => !allowed.includes(c));
  const entry = { name, repo, beforeDigest: before.digest, afterDigest: after.digest, changed: changed.slice(0, 40), changedCount: changed.length, categories, allowed, unexpected };
  report.operations.push(entry);
  return entry;
}

// ---------- 夹具 ----------
const put = (repo, rel, bytes) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), bytes); };
function initRepo(name, base = runDir) {
  const repo = path.join(base, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, ["config", key, value]);
  return repo;
}
const commitAll = (repo, message, env = {}) => {
  git(repo, ["add", "-A"]);
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "Oris GUI", GIT_AUTHOR_EMAIL: "oris-gui@example.invalid", GIT_COMMITTER_NAME: "Oris GUI", GIT_COMMITTER_EMAIL: "oris-gui@example.invalid", ...env }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`commit 失败：${result.stderr}`);
  return git(repo, ["rev-parse", "HEAD"]);
};
const png = (w, h, rgb) => encodePng(w, h, () => [...rgb, 255]);
const BULK = 420;

/** 历史夹具：根提交、420 个线性提交（fast-import）、分叉与带冲突解决的合并、图片变化、rename、特殊字符路径、标签；
 *  最后制造一个“当前 index 中的冲突”，用于证明历史中的合并提交不会用当前冲突 stage 冒充（A09）。 */
function historyFixture() {
  const repo = initRepo("history");
  put(repo, "root.txt", "root\n");
  put(repo, "pic.png", png(2, 2, [220, 30, 30]));
  const root = commitAll(repo, "root commit");
  let stream = "";
  for (let i = 0; i < BULK; i++) {
    const message = `bulk ${String(i).padStart(3, "0")}`;
    const content = `counter ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i + 1}\nauthor Bulk <bulk@example.invalid> ${1700000000 + i * 60} +0000\ncommitter Bulk <bulk@example.invalid> ${1700000000 + i * 60} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${i === 0 ? `from ${root}\n` : ""}M 100644 inline bulk/counter.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  git(repo, ["fast-import", "--quiet"], { input: stream });
  git(repo, ["reset", "-q", "--hard", "main"]);
  put(repo, "shared.txt", "base\n"); const base = commitAll(repo, "add shared");
  git(repo, ["switch", "-q", "-c", "topic"]);
  put(repo, "topic.txt", "topic\n"); put(repo, "pic.png", png(5, 2, [30, 180, 60])); put(repo, "shared.txt", "topic side\n");
  const topic = commitAll(repo, "topic work");
  git(repo, ["switch", "-q", "main"]);
  put(repo, "shared.txt", "main side\n");
  const bob = commitAll(repo, "fix(ui): Bob [brackets] and *stars*", { GIT_AUTHOR_NAME: "Bob Builder", GIT_AUTHOR_EMAIL: "bob@example.invalid" });
  git(repo, ["merge", "-q", "topic"], { allowFail: true });
  put(repo, "shared.txt", "resolved\n");
  const merge = commitAll(repo, "merge topic");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  git(repo, ["mv", "shared.txt", "docs/renamed.txt"]);
  const renamed = commitAll(repo, "rename shared");
  put(repo, "docs/renamed.txt", "resolved\nedited after rename\n");
  put(repo, "root.txt", "root edited on main\n");
  const edited = commitAll(repo, "edit renamed");
  put(repo, "空 格/中文 #[x].txt", "special\n");
  const special = commitAll(repo, "special path");
  git(repo, ["tag", "v1.0", bob]);
  // 当前 index 冲突：later 分支在 merge^1 上新增 docs/renamed.txt（内容 conflict A），合并进 main 形成 add/add 冲突。
  git(repo, ["switch", "-q", "-c", "later", `${merge}^1`]);
  put(repo, "docs/renamed.txt", "conflict A\n");
  commitAll(repo, "later");
  git(repo, ["switch", "-q", "main"]);
  git(repo, ["merge", "-q", "later"], { allowFail: true });
  put(repo, "local-edit.txt", "untracked local\n");
  return { repo, root, base, topic, bob, merge, renamed, edited, special };
}

/** 本地 bare remote 场景：同步 / 领先 / 分叉 / 上游已消失 / 无上游，另有一个会被远端删除的分支（验证不 prune）。 */
function remoteFixture() {
  const bare = path.join(runDir, "remote.git");
  const seed = initRepo("seed");
  put(seed, "a.txt", "base\n"); commitAll(seed, "base");
  git(runDir, ["clone", "-q", "--bare", seed, bare]);
  const local = path.join(runDir, "local");
  const other = path.join(runDir, "other");
  for (const clone of [local, other]) {
    git(runDir, ["clone", "-q", bare, clone]);
    for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(clone, ["config", key, value]);
  }
  for (const name of ["feature", "diverged", "gone", "stale"]) git(other, ["push", "-q", "origin", `HEAD:refs/heads/${name}`]);
  git(local, ["fetch", "-q"]);
  git(local, ["branch", "-q", "--track", "feature", "origin/feature"]);
  git(local, ["branch", "-q", "--track", "diverged", "origin/diverged"]);
  git(local, ["branch", "-q", "--track", "gone", "origin/gone"]);
  git(local, ["branch", "-q", "solo"]);
  // feature 领先 2；diverged 本地 1 个、远端 1 个；gone 的上游被删除并 prune。
  git(local, ["switch", "-q", "feature"]); put(local, "f1.txt", "1\n"); commitAll(local, "f1"); put(local, "f2.txt", "2\n"); commitAll(local, "f2");
  git(local, ["switch", "-q", "diverged"]); put(local, "d-local.txt", "l\n"); commitAll(local, "d local");
  git(local, ["switch", "-q", "main"]);
  git(other, ["switch", "-q", "-c", "diverged", "origin/diverged"]); put(other, "d-remote.txt", "r\n"); commitAll(other, "d remote"); git(other, ["push", "-q", "origin", "diverged"]);
  git(other, ["push", "-q", "origin", ":gone"]);
  git(local, ["fetch", "-q", "--prune"]);
  // 之后远端还会删除 stale：用户配置要求 prune，Oris 的 fetch 仍以 --no-prune 执行。
  git(local, ["config", "fetch.prune", "true"]);
  git(other, ["switch", "-q", "main"]);
  return { bare, local, other };
}

// ---------- 页面辅助 ----------
const H = String.raw`
(() => {
  if (window.__h) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  window.__h = {
    gitTab(label) { return qa('.git-tabs button').find((b) => b.textContent.startsWith(label)) ?? null; },
    branch(name) { return qa('.log-branch').find((b) => b.querySelector('.log-branch-name')?.textContent.replace(/^● /, '') === name) ?? null; },
    branches() { return qa('.log-branch').map((b) => ({ name: b.querySelector('.log-branch-name')?.textContent ?? b.textContent, track: b.querySelector('.log-track')?.textContent ?? null, browsing: b.classList.contains('browsing'), title: b.title })); },
    rows() { return qa('.log-row').map((r) => ({ oid: r.dataset.oid, subject: r.querySelector('.log-subject')?.textContent ?? '', selected: r.classList.contains('selected'), circles: r.querySelectorAll('circle').length, merge: !!r.querySelector('circle.merge'), dashed: r.querySelectorAll('line.dashed').length })); },
    count() { return Number(document.querySelector('[data-commit-count]')?.dataset.commitCount ?? NaN); },
    selected() { return document.querySelector('.log-row.selected')?.dataset.oid ?? null; },
    row(oid) { return document.querySelector('.log-row[data-oid="' + oid + '"]'); },
    /** 虚拟列表只渲染可视行：逐屏滚动直到该提交的行出现。 */
    async reveal(oid) {
      const list = document.querySelector('.log-commits');
      for (let top = 0; top <= list.scrollHeight && !window.__h.row(oid); top += Math.max(100, list.clientHeight / 2)) {
        list.scrollTop = top; list.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }
      return !!window.__h.row(oid);
    },
    detail() { return document.querySelector('.log-detail')?.textContent ?? ''; },
    files() { return qa('.log-detail .log-file').map((b) => b.textContent); },
    file(text) { return qa('.log-detail .log-file').find((b) => b.querySelector('.log-file-path')?.textContent === text) ?? null; },
    historyButton(text) { const li = qa('.log-detail .log-files li').find((l) => l.querySelector('.log-file-path')?.textContent === text); return li?.querySelector('.log-file-history') ?? null; },
    parents() { return qa('.parent-pick').map((b) => ({ text: b.textContent, pressed: b.getAttribute('aria-pressed') })); },
    current() { return document.querySelector('.log-current')?.textContent ?? ''; },
    badge() { return document.querySelector('.history-badge')?.textContent ?? null; },
    endpoints() { return document.querySelector('.endpoints')?.textContent ?? ''; },
    editorText() { return qa('.cm-content').map((n) => n.textContent).join('\n'); },
    ready(pathText) { return window.__op.tab() === pathText && !window.__op.loading() && !document.querySelector('.state.error') && (!!document.querySelector('.cm-editor') || !!document.querySelector('.image-viewer')); },
    error() { return document.querySelector('.state.error')?.textContent ?? document.querySelector('.log-error')?.textContent ?? null; },
    button(text, root = document) { return qa('button', root).find((b) => b.textContent === text) ?? null; },
    context(el) { const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 8 })); },
    menuItem(prefix) { return qa('.log-menu button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    key(el, key) { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); },
    scrollBottom() { const list = document.querySelector('.log-commits'); list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll')); },
    history() { return qa('.log-history li').map((li) => ({ text: li.querySelector('.log-history-row')?.textContent ?? '', boundary: li.querySelector('.log-rename-boundary')?.textContent ?? null })); },
    paneText() { return document.querySelector('.log-commits-pane')?.textContent ?? ''; },
    opStatus() { const n = document.querySelector('.op-status'); return n ? { cls: n.className, text: n.textContent } : null; },
    running() { return !!document.querySelector('.op-status.running'); },
    fetchDialog() { return document.querySelector('.fetch-dialog'); },
    setSelect(el, value) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); },
    setInputEl(el, value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); },
    search(kind, text) { window.__h.setSelect(document.querySelector('select[aria-label="搜索类型"]'), kind); const input = document.querySelector('input[aria-label="搜索提交"]'); window.__h.setInputEl(input, text); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); },
    outputText() { return document.querySelector('.output-main')?.textContent ?? ''; },
    cacheEntries() { return Number(/缓存 (\d+)\//.exec(document.querySelector('.statusbar')?.textContent ?? '')?.[1] ?? NaN); }
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
  const addProject = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 30000);
    await sleep(400);
  };
  const openLog = async () => {
    if (!(await evaluate(`window.__h.gitTab('日志')?.classList.contains('active')`))) await evaluate(`window.__h.gitTab('日志').click()`);
    await waitUntil(`(window.__h.count() > 0 || document.querySelector('.log-commits .log-empty')) && !document.querySelector('.log-count')?.textContent.includes('读取中') && (document.querySelectorAll('.log-branch').length > 1 || !!document.querySelector('.log-branches .log-error'))`, 20000);
    await sleep(300);
  };
  const clickRow = async (oid) => {
    if (!(await evaluate(`window.__h.reveal(${q(oid)})`))) throw new Error(`提交不在列表中：${oid}`);
    await evaluate(`window.__h.row(${q(oid)}).click()`); await sleep(150);
  };
  const click = async (expr) => { await evaluate(`(() => { const el = ${expr}; if (!el) throw new Error('找不到元素：' + ${q(expr)}); el.click(); return true; })()`); await sleep(150); };
  return { app, evaluate, waitUntil, shot, addProject, openLog, click, clickRow };
}
async function stop(ctx, force = false) {
  try { ctx.app.cdp.close(); } catch { /* 已关闭 */ }
  const result = await killOris({ ...ctx.app, force });
  log(`测试实例 PID ${ctx.app.pid} 已结束：${result.how}`);
  return result;
}
const traceCommands = (dir, names) => [...names].map((name) => {
  try {
    const first = readFileSync(path.join(dir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.event === "start");
    return (first?.argv ?? []).slice(1).filter((a) => !a.startsWith("-c") && !/^core\.|^diff\.|^[A-Z]:/i.test(a) && a !== "-C" && a !== "--no-optional-locks").join(" ");
  } catch { return "?"; }
});

// ================================ A07–A09、B17、键盘与渐进加载 ================================
async function historySuite() {
  const traceDir = path.join(runDir, "trace-history");
  mkdirSync(traceDir, { recursive: true });
  const f = historyFixture();
  report.fixtures = { history: f };
  const repo = f.repo;
  const ctx = await start("history", { GIT_TRACE2_EVENT: traceDir });
  const traces = () => new Set(readdirSync(traceDir));
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    await ctx.addProject(repo);
    const before = fingerprint(repo);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const localSelectedBefore = await ctx.evaluate(`window.__op.selected()`);
    const traceBefore = traces();
    await ctx.openLog();
    // ---------- A07 拓扑与分页 ----------
    // 与 Oris 相同的起点（本地 + 远端跟踪分支 + HEAD，按 OID 排序去重），逐行核对 topo-order。
    const tips = [...new Set([...git(repo, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]).split("\n").filter(Boolean), headBefore])].sort();
    const expected = git(repo, ["log", "--topo-order", "--format=%H", "-n", "200", ...tips, "--"]).split("\n");
    let rows = await ctx.evaluate(`window.__h.rows()`);
    const count = await ctx.evaluate(`window.__h.count()`);
    check("A07 第一页按 topo-order 与真实 OID 一致（200 条，只渲染可视范围）", count === 200 && rows.length < 200 && rows.every((r, i) => r.oid === expected[i]), { count, rendered: rows.length, first: rows.slice(0, 3), expected: expected.slice(0, 3) });
    const mergeRow = rows.find((r) => r.oid === f.merge);
    const chips = await ctx.evaluate(`[...document.querySelectorAll('.log-row .ref-chip')].map((n) => n.className + ':' + n.textContent)`);
    check("A07 合并提交节点、分支 / 标签 / HEAD 标注", mergeRow?.merge && rows.every((r) => r.circles === 1) && chips.includes("ref-chip head:HEAD") && chips.includes("ref-chip local current:main") && chips.includes("ref-chip local:topic"), { mergeRow, chips });
    const continuation = await ctx.evaluate(`document.querySelector('.log-continuation')?.textContent ?? ''`);
    check("A07 分页边缘有延续标识", continuation.includes("更早的提交尚未加载"), continuation);
    const firstPage = rows.slice(0, 20).map((r) => r.oid);
    // 渐进加载：滚到底部加载下一页，已显示提交的身份与顺序不变。
    await ctx.evaluate(`window.__h.scrollBottom()`);
    await ctx.waitUntil(`window.__h.count() === 400`, 20000);
    await ctx.evaluate(`window.__h.scrollBottom()`);
    const total = Number(git(repo, ["rev-list", "--count", "--branches", "--remotes", "HEAD"]));
    await ctx.waitUntil(`window.__h.count() === ${total}`, 20000);
    await sleep(300);
    await ctx.evaluate(`(() => { const list = document.querySelector('.log-commits'); list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); })()`);
    await sleep(200);
    rows = await ctx.evaluate(`window.__h.rows()`);
    const added = [...traces()].filter((n) => !traceBefore.has(n));
    const logProcesses = traceCommands(traceDir, added).filter((c) => c.startsWith("log "));
    report.processes["日志三页（首页 + 两次滚动加载）"] = { count: added.length, commands: traceCommands(traceDir, added).sort() };
    check("A07 渐进加载：3 页共 " + total + " 个提交，每页 1 个 log 进程，已显示提交身份不变，结尾不再有延续", logProcesses.length === 3 && rows.slice(0, 20).every((r, i) => r.oid === firstPage[i]) && !(await ctx.evaluate(`!!document.querySelector('.log-continuation')`)), { total, logProcesses: logProcesses.length, processes: report.processes["日志三页（首页 + 两次滚动加载）"] });
    // ---------- 键盘浏览 ----------
    await ctx.evaluate(`document.querySelector('.log-commits').focus()`);
    const first = await ctx.evaluate(`window.__h.selected()`);
    await ctx.evaluate(`window.__h.key(document.querySelector('.log-commits'), 'ArrowDown')`); await sleep(150);
    const second = await ctx.evaluate(`window.__h.selected()`);
    await ctx.evaluate(`window.__h.key(document.querySelector('.log-commits'), 'End')`); await sleep(300);
    const last = await ctx.evaluate(`window.__h.selected()`);
    await ctx.evaluate(`window.__h.key(document.querySelector('.log-commits'), 'Home')`); await sleep(200);
    check("键盘浏览提交列表（CDP 按键事件）：↓ 下一条、End 到最后、Home 回到第一条", first === expected[0] && second === expected[1] && last === f.root && (await ctx.evaluate(`window.__h.selected()`)) === expected[0], { first, second, last });
    // ---------- 提交详情、合并父节点、根提交 ----------
    await ctx.clickRow(f.merge);
    await ctx.waitUntil(`window.__h.parents().length === 2 && window.__h.files().length > 0`);
    const parents = await ctx.evaluate(`window.__h.parents()`);
    const filesFirst = await ctx.evaluate(`window.__h.files()`);
    await ctx.click(`document.querySelectorAll('.parent-pick')[1]`);
    await ctx.waitUntil(`window.__h.parents()[1].pressed === 'true' && window.__h.files().length > 0`);
    const filesSecond = await ctx.evaluate(`window.__h.files()`);
    const gitFirst = git(repo, ["diff-tree", "-r", "--name-only", "--no-commit-id", `${f.merge}^1`, f.merge]).split("\n").sort();
    const gitSecond = git(repo, ["diff-tree", "-r", "--name-only", "--no-commit-id", `${f.merge}^2`, f.merge]).split("\n").sort();
    check("A07 合并提交可选父节点，文件集合与 git diff-tree 一致", parents[0].pressed === "true" && filesFirst.map((t) => t.slice(1)).sort().join() === gitFirst.join() && filesSecond.map((t) => t.slice(1)).sort().join() === gitSecond.join(), { parents, filesFirst, filesSecond, gitFirst, gitSecond, shot: await ctx.shot("a07-merge-parent-2") });
    // A09：合并提交的 shared.txt 相对第 2 个父节点；当前 index 有 docs/renamed.txt 冲突（stage 3 = conflict A），历史内容来自提交树。
    await ctx.click(`window.__h.file('shared.txt')`);
    await ctx.waitUntil(`window.__h.ready('shared.txt')`);
    const mergeText = await ctx.evaluate(`window.__h.editorText()`);
    const mergeEndpoints = await ctx.evaluate(`window.__h.endpoints()`);
    check("A09 历史合并提交按提交树读取（相对第 2 个父节点：topic side → resolved），不读当前 index 冲突 stage", mergeText.includes("topic side") && mergeText.includes("resolved") && !mergeText.includes("conflict A") && mergeEndpoints.includes("第 2 个父节点") && (await ctx.evaluate(`window.__h.badge()`))?.includes("提交"), { mergeText: mergeText.slice(0, 200), mergeEndpoints, shot: await ctx.shot("a09-merge-second-parent") });
    // 根提交在列表末尾（虚拟列表只渲染可视行）：用 End 键选中并滚动到它。
    await ctx.evaluate(`document.querySelector('.log-commits').focus(); window.__h.key(document.querySelector('.log-commits'), 'End')`);
    await ctx.waitUntil(`window.__h.selected() === ${q(f.root)} && window.__h.detail().includes('根提交') && window.__h.files().length === 2`);
    await ctx.click(`window.__h.file('root.txt')`);
    await ctx.waitUntil(`window.__h.ready('root.txt')`);
    const rootEndpoints = await ctx.evaluate(`window.__h.endpoints()`);
    check("A07 / A09 根提交相对空树：详情标注相对空树，主阅读器为单侧新增视图", (await ctx.evaluate(`window.__h.detail()`)).includes("相对空树") && (await ctx.evaluate(`!!document.querySelector('.endpoints.single')`)) && rootEndpoints.includes("提交 ") && (await ctx.evaluate(`window.__h.editorText()`)).includes("root"), { rootEndpoints });
    // A09：图片接入任务 03 的图片阅读器（提交 / OID 双端）。
    await ctx.clickRow(f.topic);
    await ctx.waitUntil(`!!window.__h.file('pic.png')`);
    await ctx.click(`window.__h.file('pic.png')`);
    await ctx.waitUntil(`!!document.querySelector('.image-viewer') && !window.__op.loading()`, 20000);
    const imageMeta = await ctx.evaluate(`document.querySelector('.image-metadata')?.textContent ?? ''`);
    check("A09 历史图片走图片阅读器：两端尺寸 2×2 → 5×2", imageMeta.includes("存储 2×2") && imageMeta.includes("存储 5×2"), { imageMeta, shot: await ctx.shot("a09-history-image") });
    // ---------- 搜索（字面量）与 SHA ----------
    await ctx.evaluate(`window.__h.search('message', 'bob [brackets]')`);
    await ctx.waitUntil(`window.__h.count() === 1`);
    const byMessage = await ctx.evaluate(`window.__h.rows()`);
    await ctx.evaluate(`window.__h.search('author', 'bob builder')`);
    await ctx.waitUntil(`window.__h.count() === 1`);
    const byAuthor = await ctx.evaluate(`window.__h.rows()`);
    await ctx.evaluate(`window.__h.search('sha', ${q(f.bob.slice(0, 8))})`);
    await ctx.waitUntil(`window.__h.count() === 1`);
    const bySha = await ctx.evaluate(`window.__h.rows()`);
    await ctx.evaluate(`window.__h.search('sha', 'xyz')`);
    await ctx.waitUntil(`window.__h.error()?.includes('SHA')`);
    check("A07 搜索消息（字面量，括号不当正则）/ 作者 / SHA；无效 SHA 明确报错", byMessage[0]?.oid === f.bob && byAuthor[0]?.oid === f.bob && bySha[0]?.oid === f.bob && byMessage[0].subject.includes("v1.0"), { byMessage, byAuthor, bySha });
    await ctx.click(`window.__h.button('清除')`);
    await ctx.waitUntil(`window.__h.count() === 200`);
    // ---------- 分支筛选（不切换工作分支）与跳到 HEAD ----------
    await ctx.click(`window.__h.branch('topic')`);
    const topicCount = Number(git(repo, ["rev-list", "--count", "topic"]));
    await ctx.waitUntil(`window.__h.count() === ${Math.min(200, topicCount)} && window.__h.rows()[0]?.oid === ${q(f.topic)}`);
    const current = await ctx.evaluate(`window.__h.current()`);
    check("A08 选择分支只筛选历史：当前工作分支仍为 main，HEAD 不变", current.includes("● main") && git(repo, ["branch", "--show-current"]) === "main" && git(repo, ["rev-parse", "HEAD"]) === headBefore && (await ctx.evaluate(`window.__h.branches().find((b) => b.name === 'topic')?.browsing`)), { current, shot: await ctx.shot("a08-browse-topic") });
    await ctx.click(`window.__h.button('跳到 HEAD')`);
    await ctx.waitUntil(`window.__h.selected() === ${q(headBefore)}`);
    check("A07 跳到 HEAD（HEAD 不在筛选结果中时改为浏览 HEAD 所在分支）", (await ctx.evaluate(`window.__h.branches().find((b) => b.name.replace('● ', '') === 'main')?.browsing`)) && (await ctx.evaluate(`window.__h.rows()[0]?.oid`)) === headBefore, {});
    // ---------- 比较（直接比较、交换方向） ----------
    await ctx.evaluate(`window.__h.context(window.__h.branch('topic'))`); await sleep(100);
    await ctx.click(`window.__h.menuItem('设为比较起点')`);
    await ctx.evaluate(`window.__h.context(window.__h.branch('main'))`); await sleep(100);
    await ctx.click(`window.__h.menuItem('与比较起点比较')`);
    await ctx.waitUntil(`window.__h.detail().includes('A → B 的变化文件')`);
    const compareFiles = await ctx.evaluate(`window.__h.files()`);
    const gitCompare = git(repo, ["-c", "core.quotepath=false", "diff-tree", "-r", "-M", "--name-status", "--no-commit-id", f.topic, headBefore]).split("\n").map((l) => l.split("\t").pop()).sort();
    check("A09 两分支直接比较（非共同基线）：文件与 git diff-tree topic main 一致，端点 OID 固定显示", compareFiles.map((t) => t.replace(/^[A-Z]/, "").split("← ")[0]).sort().join() === gitCompare.join() && (await ctx.evaluate(`window.__h.detail()`)).includes(f.topic) && (await ctx.evaluate(`window.__h.detail()`)).includes(headBefore), { compareFiles, gitCompare });
    await ctx.click(`window.__h.file('root.txt')`);
    await ctx.waitUntil(`window.__h.ready('root.txt')`);
    const compareEndpoints = await ctx.evaluate(`window.__h.endpoints()`);
    const specialName = "空 格/中文 #[x].txt";
    await ctx.click(`window.__h.button('⇄ 交换方向')`);
    await ctx.waitUntil(`window.__h.detail().includes('A：main') && window.__h.files().length > 0`);
    const swappedSpecial = (await ctx.evaluate(`window.__h.files()`)).find((t) => t.includes(specialName));
    check("A09 比较方向：topic → main 中新文件为 A、交换后为 D；两端标注固定的 A / B 端点", compareFiles.find((t) => t.includes(specialName))?.startsWith("A") && swappedSpecial?.startsWith("D") && compareEndpoints.includes("A · topic") && compareEndpoints.includes("B · main"), { compareEndpoints, swappedSpecial, shot: await ctx.shot("a09-compare-swapped") });
    // ---------- 文件历史与 rename 边界、返回阅读位置 ----------
    await ctx.click(`window.__h.button('关闭')`);
    await ctx.clickRow(f.edited);
    await ctx.waitUntil(`!!window.__h.historyButton('docs/renamed.txt')`);
    await ctx.click(`window.__h.historyButton('docs/renamed.txt')`);
    await ctx.waitUntil(`window.__h.history().length > 0 && !window.__h.paneText().includes('读取中')`);
    const fileHistory = await ctx.evaluate(`window.__h.history()`);
    // 与 Oris 相同的跟随规则：--follow、-M、合并提交与第一个父节点比较；只计有文件变化的记录。
    const followed = git(repo, ["log", "--follow", "--diff-merges=first-parent", "--name-only", "-M", "--format=%x1e%H", f.edited, "--", "docs/renamed.txt"]).split("\x1e").filter((record) => record.trim().split("\n").filter(Boolean).length >= 2).length;
    check("A09 文件历史：标注 rename 跟随边界并到达文件起点", fileHistory.length === followed && fileHistory.some((h) => h.boundary?.includes("由 shared.txt 改名而来")) && (await ctx.evaluate(`window.__h.paneText()`)).includes("已到达文件起点"), { fileHistory, followed, shot: await ctx.shot("a09-file-history") });
    const renameIndex = fileHistory.findIndex((h) => h.boundary);
    await ctx.click(`document.querySelectorAll('.log-history-row')[${renameIndex}]`);
    await ctx.waitUntil(`window.__op.tab() === 'docs/renamed.txt' && !window.__op.loading()`);
    await sleep(300);
    const renameEndpoints = await ctx.evaluate(`window.__h.endpoints()`);
    check("A09 文件历史中打开 rename 提交：左侧按原路径读取", (await ctx.evaluate(`document.querySelector('.rename-path')?.textContent ?? ''`)).includes("shared.txt") && renameEndpoints.includes("父提交"), { renameEndpoints });
    // 从本地文件进入文件历史，再返回原阅读位置。
    await ctx.click(`window.__h.button('← 返回提交历史')`);
    await ctx.click(`window.__h.button('← 返回本地变化')`);
    await ctx.waitUntil(`!window.__h.badge() && !window.__op.loading()`);
    const localTab = await ctx.evaluate(`window.__op.tab()`);
    const selectedAfter = await ctx.evaluate(`window.__op.selected()`);
    check("A09 返回本地变化：回到进入历史前的本地文件（侧栏选中项恢复），主阅读器不再标“历史”", !!localSelectedBefore && selectedAfter === localSelectedBefore && localTab === localSelectedBefore, { localSelectedBefore, selectedAfter, localTab });
    // ---------- 资源：进程数与缓存上限 ----------
    for (const oid of [f.special, f.edited, f.renamed, f.merge, f.bob, f.topic, f.base]) {
      await ctx.clickRow(oid);
      await ctx.waitUntil(`window.__h.files().length > 0`);
      for (let i = 0; i < 2; i++) {
        const has = await ctx.evaluate(`document.querySelectorAll('.log-detail .log-file').length > ${i}`);
        if (has) { await ctx.evaluate(`document.querySelectorAll('.log-detail .log-file')[${i}].click()`); await ctx.waitUntil(`!window.__op.loading()`); }
      }
    }
    await sleep(1500);
    const tree = processTree(ctx.app.pid);
    check("资源：打开约 14 个历史文件后常驻 Git 进程 ≤ 2（cat-file 常驻 + 至多 1 个进行中），内容缓存条目 ≤ 12", tree.git <= 2 && (await ctx.evaluate(`window.__h.cacheEntries()`)) <= 12, { git: tree.git, cache: await ctx.evaluate(`window.__h.cacheEntries()`) });
    // ---------- B17 只读回归 ----------
    const after = fingerprint(repo);
    const e = evidence("B17 浏览日志、搜索、筛选、比较、文件历史、图片、键盘", repo, before, after, []);
    check("B17 只读回归：以上全部浏览前后 index、HEAD、refs、config、工作区都不变", e.changedCount === 0 && git(repo, ["rev-parse", "HEAD"]) === headBefore, e);
    // ---------- ref 移动提示（外部在 topic 上提交） ----------
    await ctx.click(`window.__h.button('← 返回本地变化')`).catch(() => {});
    await ctx.evaluate(`window.__h.context(window.__h.branch('topic'))`); await sleep(100);
    await ctx.click(`window.__h.menuItem('设为比较起点')`);
    await ctx.evaluate(`window.__h.context(window.__h.branch('main'))`); await sleep(100);
    await ctx.click(`window.__h.menuItem('与比较起点比较')`);
    await ctx.waitUntil(`window.__h.detail().includes('A → B 的变化文件')`);
    const worktreeTopic = path.join(runDir, "topic-worktree");
    git(repo, ["worktree", "add", "-q", worktreeTopic, "topic"]);
    put(worktreeTopic, "moved.txt", "moved\n");
    commitAll(worktreeTopic, "topic moved externally");
    const moved = git(repo, ["rev-parse", "topic"]);
    await ctx.waitUntil(`document.querySelector('.log-moved')?.textContent.includes('topic 已移动到 ${moved.slice(0, 8)}')`, 20000);
    const stillPinned = (await ctx.evaluate(`window.__h.detail()`)).includes(f.topic);
    await ctx.click(`window.__h.button('按新位置重新比较')`);
    await ctx.waitUntil(`window.__h.detail().includes(${q(moved)})`);
    check("A09 ref 移动：提示可刷新、原比较仍用固定 OID；按新位置重新比较后端点更新（refs 类 watcher 事件触发刷新）", stillPinned && (await ctx.evaluate(`!document.querySelector('.log-moved')`)), { moved, shot: await ctx.shot("a09-ref-moved") });
  } catch (error) {
    fail(`历史验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await ctx.shot("history-failure"); } catch { /* ignore */ }
  } finally {
    report.stopHistory = await stop(ctx);
  }
}

// ================================ A10：本地 bare remote ================================
function unauthorizedServer() {
  const server = createServer((request, response) => { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="oris-test"', "Content-Length": "0", Connection: "close" }); response.end(); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function remoteSuite() {
  const traceDir = path.join(runDir, "trace-remote");
  mkdirSync(traceDir, { recursive: true });
  const r = remoteFixture();
  report.fixtures = { ...(report.fixtures ?? {}), remote: r };
  const ctx = await start("remote", { GIT_TRACE2_EVENT: traceDir, ORIS_NETWORK_IDLE_TIMEOUT_MS: "4000" });
  const traces = () => new Set(readdirSync(traceDir));
  const fetchVia = async (remote, choose = false) => {
    await ctx.click(`window.__op.button('⇣ 获取…')`);
    await ctx.waitUntil(`!!window.__h.fetchDialog() && !window.__h.fetchDialog().textContent.includes('正在读取 remote')`);
    if (choose) await ctx.evaluate(`window.__h.setSelect(window.__h.fetchDialog().querySelector('select'), ${q(remote)})`);
    await sleep(150);
    await ctx.click(`window.__h.button('获取', window.__h.fetchDialog())`);
  };
  const settle = (timeout = 30000) => ctx.waitUntil(`!window.__h.running() && window.__h.opStatus()`, timeout);
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    await ctx.addProject(r.local);
    await ctx.openLog();
    // ---------- A08 上游状态（与 rev-list 可达性核对） ----------
    const branches = await ctx.evaluate(`window.__h.branches()`);
    const counts = (b) => { const [ahead, behind] = git(r.local, ["rev-list", "--left-right", "--count", `${b}...${b}@{u}`]).split(/\s+/).map(Number); return ahead === 0 && behind === 0 ? "已同步" : `↑${ahead} ↓${behind}`; };
    const track = (name) => branches.find((b) => b.name.replace("● ", "") === name)?.track;
    check("A08 领先 / 落后 / 分叉按真实可达性；上游已消失与无上游不显示伪 0/0", track("main") === counts("main") && track("feature") === counts("feature") && track("diverged") === counts("diverged") && track("gone") === "上游已消失" && track("solo") === "无上游" && counts("diverged").includes("↑1 ↓1"), { branches, shot: await ctx.shot("a08-tracking") });
    // ---------- A10 普通刷新不联网 ----------
    put(r.other, "remote-new.txt", "remote\n"); const remoteHead = commitAll(r.other, "remote work");
    git(r.other, ["push", "-q", "origin", "main", ":stale"]);
    const originBefore = git(r.local, ["rev-parse", "refs/remotes/origin/main"]);
    let traceBefore = traces();
    await ctx.click(`window.__op.button('↻ 本地刷新')`);
    await ctx.waitUntil(`!window.__op.loading()`); await sleep(1500);
    const refreshCommands = traceCommands(traceDir, [...traces()].filter((n) => !traceBefore.has(n)));
    check("A10 普通刷新不联网：本地刷新后远端跟踪分支不变，没有 fetch / 远端传输进程", git(r.local, ["rev-parse", "refs/remotes/origin/main"]) === originBefore && !refreshCommands.some((c) => /fetch|remote-|upload-pack|ls-remote/.test(c)), { refreshCommands });
    // ---------- A10 显式 fetch：默认上游 remote，只改远端跟踪引用 ----------
    let before = fingerprint(r.local);
    let beforeIndex = git(r.local, ["ls-files", "-s"]);
    traceBefore = traces();
    await fetchVia("origin");
    await settle();
    let status = await ctx.evaluate(`window.__h.opStatus()`);
    let e = fetchEvidence("fetch origin（上游 remote）", r.local, before, beforeIndex, ["remote-refs", "git:FETCH_HEAD"]);
    const fetchCommands = traceCommands(traceDir, [...traces()].filter((n) => !traceBefore.has(n)));
    report.processes["fetch origin"] = fetchCommands.sort();
    const fetchArgs = fetchCommands.find((c) => c.startsWith("fetch")) ?? "";
    check("A10 显式 fetch：更新远端跟踪分支（不 prune、不递归子模块、不自动维护），工作区 / index / 当前分支 / config 不变", status.cls.includes("succeeded") && git(r.local, ["rev-parse", "refs/remotes/origin/main"]) === remoteHead && git(r.local, ["for-each-ref", "refs/remotes/origin/stale"]).includes("stale") && e.unexpected.length === 0 && /--no-prune/.test(fetchArgs) && /--no-recurse-submodules/.test(fetchArgs) && /--no-auto-maintenance/.test(fetchArgs) && !fetchCommands.some((c) => /^(pull|push|checkout|switch|merge|gc|maintenance)/.test(c)), { status, e, fetchArgs, fetchCommands });
    await ctx.waitUntil(`window.__h.branches().find((b) => b.name.replace('● ', '') === 'main')?.track === '↑0 ↓1'`, 15000);
    const fetchTime = await ctx.evaluate(`document.querySelector('.log-fetch-time')?.textContent ?? ''`);
    check("A10 获取后分支列表与日志刷新；记录 Oris 获取时间", fetchTime.includes("上次由 Oris 获取 origin") && (await ctx.evaluate(`window.__h.rows().length`)) > 0, { fetchTime, shot: await ctx.shot("a10-after-fetch") });
    // 外部 fetch 之后：时间显示为未知。
    await sleep(6000);
    git(r.local, ["fetch", "-q", "--no-prune"]);
    await ctx.click(`window.__op.button('⇣ 获取…')`);
    await ctx.waitUntil(`!!window.__h.fetchDialog() && window.__h.fetchDialog().textContent.includes('时间未知')`, 15000);
    check("A10 外部工具获取后，获取时间显示为未知", true, await ctx.evaluate(`window.__h.fetchDialog().textContent`));
    await ctx.click(`window.__h.button('取消', window.__h.fetchDialog())`);
    // ---------- 无上游：必须选择 remote ----------
    git(r.local, ["remote", "add", "backup", r.bare]);
    git(r.local, ["switch", "-q", "solo"]);
    await ctx.click(`window.__op.button('↻ 本地刷新')`); await ctx.waitUntil(`!window.__op.loading()`); await sleep(800);
    await ctx.click(`window.__op.button('⇣ 获取…')`);
    await ctx.waitUntil(`!!window.__h.fetchDialog() && !window.__h.fetchDialog().textContent.includes('正在读取 remote')`);
    const noUpstream = await ctx.evaluate(`({ text: window.__h.fetchDialog().textContent, disabled: window.__h.button('获取', window.__h.fetchDialog()).disabled })`);
    await ctx.click(`window.__h.button('取消', window.__h.fetchDialog())`);
    before = fingerprint(r.local); beforeIndex = git(r.local, ["ls-files", "-s"]);
    await fetchVia("backup", true);
    await settle();
    status = await ctx.evaluate(`window.__h.opStatus()`);
    e = fetchEvidence("fetch backup（无上游时选择 remote）", r.local, before, beforeIndex, ["remote-refs", "git:FETCH_HEAD"]);
    check("A10 无上游：要求选择已有 remote，选择后只获取该 remote，不自行配置上游", noUpstream.disabled && noUpstream.text.includes("请选择") && status.cls.includes("succeeded") && git(r.local, ["for-each-ref", "refs/remotes/backup/main"]).includes("backup/main") && git(r.local, ["config", "--get", "branch.solo.remote"], { allowFail: true }) === "" && e.unexpected.length === 0, { noUpstream, status, e });
    git(r.local, ["switch", "-q", "main"]);
    await ctx.click(`window.__op.button('↻ 本地刷新')`); await ctx.waitUntil(`!window.__op.loading()`); await sleep(800);
    // ---------- 取消：结束进程树，重读 refs 如实报告 ----------
    put(r.other, "remote-2.txt", "2\n"); commitAll(r.other, "remote 2"); git(r.other, ["push", "-q", "origin", "main"]);
    const marker = path.join(runDir, "upload-pack-finished");
    const script = path.join(runDir, "slow-upload-pack.sh");
    writeFileSync(script, `#!/bin/sh\nsleep 12\necho done > '${marker.replace(/\\/g, "/")}'\nexec git-upload-pack "$@"\n`);
    git(r.local, ["config", "remote.origin.uploadpack", script.replace(/\\/g, "/")]);
    before = fingerprint(r.local); beforeIndex = git(r.local, ["ls-files", "-s"]);
    const originCancel = git(r.local, ["rev-parse", "refs/remotes/origin/main"]);
    await fetchVia("origin");
    await ctx.waitUntil(`window.__h.running()`, 10000);
    await sleep(1200);
    const during = processTree(ctx.app.pid).processes.map((p) => p.name);
    await ctx.click(`[...document.querySelectorAll('.statusbar button')].find((b) => b.textContent === '取消')`);
    await settle(15000);
    status = await ctx.evaluate(`window.__h.opStatus()`);
    await sleep(1000);
    const afterCancel = processTree(ctx.app.pid).processes.map((p) => p.name);
    e = fetchEvidence("fetch 取消", r.local, before, beforeIndex, ["git:FETCH_HEAD"]);
    check("A10 取消 fetch：进程树结束（git / sh / sleep 不再存在），重读实际 refs 如实报告，不承诺回滚", status.cls.includes("cancelled") && status.text.includes("已重新读取实际引用") && git(r.local, ["rev-parse", "refs/remotes/origin/main"]) === originCancel && !afterCancel.some((n) => /^(sh|sleep|git-upload-pack)\.exe$/i.test(n)) && during.some((n) => /^(sh|sleep|bash)\.exe$/i.test(n)) && e.unexpected.length === 0, { status, during, afterCancel, e, shot: await ctx.shot("a10-cancelled") });
    await sleep(12000);
    check("A10 取消后被终止的 upload-pack 没有继续运行（标记文件不存在）", !existsSync(marker), { marker });
    // ---------- 超时（ORIS_NETWORK_IDLE_TIMEOUT_MS=4000） ----------
    before = fingerprint(r.local); beforeIndex = git(r.local, ["ls-files", "-s"]);
    await fetchVia("origin");
    await settle(20000);
    status = await ctx.evaluate(`window.__h.opStatus()`);
    e = fetchEvidence("fetch 无输出超时", r.local, before, beforeIndex, ["git:FETCH_HEAD"]);
    check("A10 无输出超时：终止并提示可能需要先在终端完成首次认证，refs 不变", status.cls.includes("failed") && status.text.includes("没有任何输出") && git(r.local, ["rev-parse", "refs/remotes/origin/main"]) === originCancel && e.unexpected.length === 0, { status, e });
    git(r.local, ["config", "--unset", "remote.origin.uploadpack"]);
    // ---------- 失败：remote 地址无效 ----------
    git(r.local, ["remote", "set-url", "backup", path.join(runDir, "missing.git")]);
    git(r.local, ["switch", "-q", "solo"]);
    await ctx.click(`window.__op.button('↻ 本地刷新')`); await ctx.waitUntil(`!window.__op.loading()`); await sleep(800);
    before = fingerprint(r.local); beforeIndex = git(r.local, ["ls-files", "-s"]);
    await fetchVia("backup", true);
    await settle();
    status = await ctx.evaluate(`window.__h.opStatus()`);
    e = fetchEvidence("fetch 失败（无效地址）", r.local, before, beforeIndex, ["git:FETCH_HEAD"]);
    check("A10 fetch 失败：明确结束并展示 Git 错误摘要，工作区 / index / refs 不变", status.cls.includes("failed") && /获取 backup失败/.test(status.text) && e.unexpected.length === 0, { status, e });
    // ---------- 认证失败（本地 401 服务模拟；清空凭据助手，不调用 GCM） ----------
    const { server, url } = await unauthorizedServer();
    try {
      git(r.local, ["config", "credential.helper", ""]);
      git(r.local, ["remote", "set-url", "backup", url.replace("http://", "http://alice:s3cret-token@") + "/repo.git"]);
      before = fingerprint(r.local); beforeIndex = git(r.local, ["ls-files", "-s"]);
      const started = Date.now();
      await fetchVia("backup", true);
      await settle(30000);
      status = await ctx.evaluate(`window.__h.opStatus()`);
      await ctx.evaluate(`window.__h.gitTab('操作输出').click()`); await sleep(300);
      const output = await ctx.evaluate(`window.__h.outputText()`);
      const names = processTree(ctx.app.pid).processes.map((p) => p.name);
      e = fetchEvidence("fetch 认证失败", r.local, before, beforeIndex, ["git:FETCH_HEAD"]);
      check("A10 / B18 认证失败：给出可操作提示、不弹出凭据输入（进程树中没有凭据助手）、URL 中的凭据已脱敏", status.cls.includes("failed") && /认证失败|没有访问权限/.test(status.text) && Date.now() - started < 25000 && !status.text.includes("s3cret") && !output.includes("s3cret") && !names.some((n) => /credential/i.test(n)) && e.unexpected.length === 0, { status: status.text, output: output.slice(0, 800), names, e, shot: await ctx.shot("a10-auth-failed") });
    } finally { server.close(); }
    git(r.local, ["switch", "-q", "main"]);
    // 分离 HEAD 的当前分支表达。
    git(r.local, ["switch", "-q", "--detach", "HEAD"]);
    await ctx.click(`window.__op.button('↻ 本地刷新')`); await ctx.waitUntil(`!window.__op.loading()`);
    await ctx.waitUntil(`window.__h.current().includes('分离 HEAD')`, 15000);
    check("A08 分离 HEAD 时当前工作分支显示为分离状态", true, await ctx.evaluate(`window.__h.current()`));
  } catch (error) {
    fail(`远端验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await ctx.shot("remote-failure"); } catch { /* ignore */ }
  } finally {
    report.stopRemote = await stop(ctx);
  }
}

// ================================ A10：真实远端 AgentHub（SSH / HTTPS） ================================
const AGENTHUB_SSH = "git@github.com:Zhao-wl/AgentHub.git";
const AGENTHUB_HTTPS = "https://github.com/Zhao-wl/AgentHub.git";
function netGit(cwd, argv, { allowFail = false, https = false } = {}) {
  const result = spawnSync("git", [...(https ? ["-c", "credential.https://github.com.username=Zhao-wl"] : []), ...argv], { cwd, encoding: "utf8", timeout: 120000 });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${argv.join(" ")} 失败：${result.stderr}`);
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}
async function realSuite() {
  if (!runId) throw new Error("真实远端需要 --run-id");
  const base = path.join(REMOTE_ROOT, runId, "v1-04");
  mkdirSync(base, { recursive: true });
  const branch = `oris-test/${runId}/v1-04-fetch`;
  report.real = { base, branch, created: [], deleted: [] };
  const sshClone = path.join(base, "agenthub-ssh");
  const httpsClone = path.join(base, "agenthub-https");
  const helper = path.join(base, "agenthub-helper");
  netGit(base, ["clone", "-q", AGENTHUB_SSH, sshClone]);
  netGit(base, ["clone", "-q", AGENTHUB_SSH, helper]);
  netGit(base, ["clone", "-q", AGENTHUB_HTTPS, httpsClone], { https: true });
  git(httpsClone, ["config", "credential.https://github.com.username", "Zhao-wl"]);
  const mainBefore = netGit(base, ["ls-remote", AGENTHUB_SSH, "refs/heads/main"]).out.split(/\s+/)[0];
  // 用命令行在远端新建本次运行的测试分支（指向 main，不改动 main）。
  netGit(helper, ["push", "-q", "origin", `refs/remotes/origin/main:refs/heads/${branch}`]);
  report.real.created.push(branch);
  writeFileSync(path.join(base, "created-branches.json"), JSON.stringify(report.real.created));
  const ctx = await start("real");
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    for (const [label, clone] of [["SSH", sshClone], ["HTTPS", httpsClone]]) {
      await ctx.addProject(clone);
      const before = fingerprint(clone);
      const beforeIndex = git(clone, ["ls-files", "-s"]);
      const started = Date.now();
      await ctx.click(`window.__op.button('⇣ 获取…')`);
      await ctx.waitUntil(`!!window.__h.fetchDialog() && !window.__h.fetchDialog().textContent.includes('正在读取 remote')`);
      await ctx.click(`window.__h.button('获取', window.__h.fetchDialog())`);
      await ctx.waitUntil(`!window.__h.running() && window.__h.opStatus()`, 120000);
      const status = await ctx.evaluate(`window.__h.opStatus()`);
      const e = fetchEvidence(`AgentHub ${label} fetch`, clone, before, beforeIndex, ["remote-refs", "git:FETCH_HEAD"]);
      const tracked = git(clone, ["for-each-ref", `refs/remotes/origin/${branch}`]);
      report.real[label] = { status, elapsedMs: Date.now() - started, tracked, e };
      check(`A10 真实远端 AgentHub ${label} fetch：成功获取本次测试分支，只改远端跟踪引用`, status.cls.includes("succeeded") && tracked.includes(branch) && e.unexpected.length === 0, { status, tracked, e, shot: await ctx.shot(`a10-agenthub-${label.toLowerCase()}`) });
    }
  } catch (error) {
    fail(`真实远端验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await ctx.shot("real-failure"); } catch { /* ignore */ }
  } finally {
    report.stopReal = await stop(ctx);
    // 只删除本次创建的测试分支，再用 SSH ls-remote 核对远端。
    for (const created of report.real.created) {
      const deleted = netGit(helper, ["push", "-q", "origin", `:refs/heads/${created}`], { allowFail: true });
      if (deleted.ok) report.real.deleted.push(created); else fail(`删除测试分支失败：${created} ${deleted.err}`);
    }
    const remaining = netGit(base, ["ls-remote", AGENTHUB_SSH]).out;
    report.real.lsRemoteAfter = remaining;
    check("AgentHub 清理：只删除本次创建的测试分支，main 未变，远端只剩开工时的分支", !remaining.includes("oris-test/") && remaining.split("\n").filter((l) => l.includes("refs/heads/")).length === 1 && remaining.includes(`${mainBefore}\trefs/heads/main`), { remaining, mainBefore });
    if (!keep) removeDir(base, REMOTE_ROOT);
  }
}

if (only === "all" || only === "history") await historySuite();
if (only === "all" || only === "remote") await remoteSuite();
if (only === "real") await realSuite();
report.finishedAt = new Date().toISOString();
report.passed = report.failures.length === 0;
const reportFile = path.join(outDir, only === "all" ? "report.json" : `report-${only}.json`);
writeFileSync(reportFile, JSON.stringify(report, null, 2));
log(report.passed ? "全部检查通过" : `失败 ${report.failures.length} 项`, reportFile);
if (!keep) log(removeDir(runDir, GUI_ROOT) ? `已清理 ${runDir}` : `未能完全清理 ${runDir}`);
process.exitCode = report.passed ? 0 : 1;
