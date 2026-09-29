// V2-07 工作区界面验收（B31–B36 的界面部分）：添加即识别、选择器与徽标、按仓库作用、父仓库排除子仓库、指针开关、
// 嵌套仓库说明、历史中的指针跳转、共用 watcher、重启恢复、移除整个工作区。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 点击是 CDP 注入的页面事件，不是真实鼠标、键盘或系统焦点。Git 进程由 GIT_TRACE2_EVENT 逐个记录（argv、起止时间）。
// 用法：node scripts/perf/workspace-acceptance.mjs --exe <oris.exe> [--port 9981] [--only local|real] [--real <工作区路径>] [--keep]
//   --only local（默认）：在 %TEMP%\oris-gui 下生成夹具，界面中只做暂存 / 取消暂存这一类可逆写操作。
//   --only real：只读冒烟真实工作区（打开、切换、浏览、打开选择器），前后比对各成员的 refs / index / HEAD / config 与 status。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
let port = Number(option("port", 9981));
const only = option("only", "local");
const realRoot = option("real", "E:\\Tap4fun\\X20_2\\game-workspace");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", `workspace-acceptance-${only}`));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `workspace-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), only, startedAt: new Date().toISOString(), runDir, method: "CDP 页面事件（点击、键盘事件派发到页面）；不是真实鼠标、键盘或系统焦点。Git 进程来自 GIT_TRACE2_EVENT。", checks: {}, segments: [], timings: {}, failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : q(detail).slice(0, 900)}`); };

// ---------- 页面辅助 ----------
const H = String.raw`
(() => {
  if (window.__w) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  window.__w = {
    picker: () => document.querySelector('.repo-picker-button')?.firstChild?.textContent ?? null,
    tabs: () => qa('.project-tab').map((t) => ({ title: t.title, active: t.classList.contains('active'), workspace: !!t.querySelector('.project-ws-mark'), text: t.querySelector('.project-switch')?.textContent ?? '' })),
    files: () => qa('.file').map((n) => n.getAttribute('aria-label')),
    toast: () => document.querySelector('.sync-toast')?.textContent ?? '',
    nested: () => document.querySelector('.nested-repos summary')?.textContent ?? null,
    nestedRows: () => qa('.nested-repo').map((r) => ({ path: r.querySelector('code')?.textContent, note: r.querySelector('span')?.textContent, button: r.querySelector('button')?.textContent ?? null })),
    rows: () => qa('.repo-row').map((r) => ({ name: r.querySelector('.repo-row-name')?.firstChild?.textContent, disabled: r.getAttribute('aria-disabled') === 'true', current: r.classList.contains('current'), badges: qa('.repo-badge', r).map((b) => b.textContent), hint: r.querySelector('.repo-row-hint')?.textContent ?? null, group: null })),
    groups: () => qa('.repo-picker-list > .log-group').map((g) => g.textContent),
    row: (name) => qa('.repo-row').find((r) => r.querySelector('.repo-row-name')?.firstChild?.textContent === name) ?? null,
    scanning: () => qa('.repo-row:not(.disabled) .repo-badge').some((b) => b.textContent === '读取中…' || b.textContent === '未扫描'),
    pointer: () => document.querySelector('.pointer-switch')?.getAttribute('aria-checked') ?? null,
    gitTab: (prefix) => qa('.git-tabs button').find((b) => b.textContent.startsWith(prefix)) ?? null,
    logRow: (oid) => qa('.log-row').find((r) => r.dataset.oid === oid) ?? null,
    button: (text, root = document) => qa('button', root).find((b) => b.textContent.trim() === text) ?? null,
    compareHead: () => document.querySelector('.log-detail-body .log-head strong')?.textContent ?? null,
    compareMeta: () => qa('.log-detail-body .log-meta').map((m) => m.textContent),
    historyErrors: () => qa('.log-error').map((n) => n.textContent),
    pointerText: (path) => window.__op.row(path)?.querySelector('.submodule-pointer')?.textContent ?? null,
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
  const click = async (expr) => { await evaluate(`(() => { const el = ${expr}; if (!el) throw new Error('找不到元素：' + ${q(expr)}); if (el.disabled) throw new Error('元素不可用：' + ${q(expr)}); el.click(); return true; })()`); await sleep(150); };
  const key = (target, init) => evaluate(`(${target}).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${q(init)} }))`);
  const addProject = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    const t0 = Date.now();
    await evaluate(`window.__op.button('载入/添加').click()`);
    return t0;
  };
  return { app, evaluate, waitUntil, shot, click, key, addProject };
}
async function stop(ctx) {
  try { ctx.app.cdp.close(); } catch { /* 已关闭 */ }
  const result = await killOris({ ...ctx.app });
  log(`测试实例 PID ${ctx.app.pid} 已结束：${result.how}`);
  return result;
}

// ---------- Git 进程记录（GIT_TRACE2_EVENT，每个进程一个文件） ----------
function traceEntries(dir, names) {
  return names.map((name) => {
    try {
      const events = readFileSync(path.join(dir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const startEvent = events.find((e) => e.event === "start");
      const exit = events.find((e) => e.event === "exit" || e.event === "atexit");
      const argv = startEvent?.argv ?? [];
      const at = argv.indexOf("-C");
      const cwd = at >= 0 ? argv[at + 1] : null;
      const rest = argv.slice(1).filter((a, i, all) => !(all[i - 1] === "-C" || a === "-C" || all[i - 1] === "-c" || a === "-c" || a === "--no-optional-locks"));
      return { cwd, command: rest.join(" "), start: startEvent ? Date.parse(startEvent.time) : null, end: exit ? Date.parse(exit.time) : null };
    } catch { return { cwd: null, command: "?", start: null, end: null }; }
  });
}
function tracer(dir) {
  let seen = new Set(readdirSync(dir));
  return {
    /** 自上次调用以来新出现的 Git 进程。 */
    take() { const now = readdirSync(dir); const fresh = now.filter((n) => !seen.has(n)); seen = new Set(now); return traceEntries(dir, fresh); },
  };
}
const maxOverlap = (entries) => {
  const points = entries.filter((e) => e.start && e.end).flatMap((e) => [[e.start, 1], [e.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0, max = 0;
  for (const [, delta] of points) { current += delta; max = Math.max(max, current); }
  return max;
};
const WRITE_COMMANDS = /^(add|commit|checkout|switch|reset|restore|rm|mv|merge|pull|push|fetch|stash|submodule|update-index|update-ref|worktree (add|remove|prune|move)|apply|clean|gc|branch -[dDmM]|tag)\b/;
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ---------- 只读证据：各成员的 refs / index / HEAD / config 与 status（真实工作区用，不遍历工作区文件） ----------
function lightFingerprint(repo) {
  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  const hash = (file) => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return null; } };
  const mtime = (file) => { try { return statSync(file).mtimeMs; } catch { return null; } };
  return {
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: hash(path.join(gitDir, "index")), indexMtime: mtime(path.join(gitDir, "index")),
    head: hash(path.join(gitDir, "HEAD")), config: hash(path.join(gitDir, "config")),
    status: git(repo, ["--no-optional-locks", "status", "--porcelain=v1", "--ignore-submodules=all", "-uno"]),
  };
}

// ================================ 本地夹具 ================================
const put = (repo, rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
const configure = (repo) => { for (const [k, v] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["protocol.file.allow", "always"]]) git(repo, ["config", k, v]); };
const commitAll = (repo, message) => { git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", message]); return git(repo, ["rev-parse", "HEAD"]); };
function initRepo(dir, files) { mkdirSync(dir, { recursive: true }); git(dir, ["init", "-q", "-b", "main"]); configure(dir); for (const [rel, text] of Object.entries(files)) put(dir, rel, text); commitAll(dir, "init"); }

/** 父仓库 game-workspace + 子模块 battle（worktree battle-r2 放在父目录中）、client（有 .gitignore 与独立嵌套仓库）、audio（未初始化）。 */
function fixture() {
  const sources = path.join(runDir, "sources");
  initRepo(path.join(sources, "battle"), { "src/match.rs": "fn main() {}\n" });
  initRepo(path.join(sources, "client"), { ".gitignore": "Library/\n", "Assets/Game.cs": "class Game {}\n" });
  initRepo(path.join(sources, "audio"), { "bank.txt": "a\n" });
  const root = path.join(runDir, "game-workspace");
  initRepo(root, { "AGENTS.md": "# ws\n" });
  for (const name of ["battle", "client", "audio"]) git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", path.join(sources, name).replace(/\\/g, "/"), name]);
  commitAll(root, "add submodules");
  git(root, ["submodule", "deinit", "-q", "-f", "audio"]);
  for (const name of ["battle", "client"]) configure(path.join(root, name));
  git(path.join(root, "battle"), ["worktree", "add", "-q", "--detach", path.join(root, "battle-r2")]);
  initRepo(path.join(root, "client", ".gdconfig_tmp"), { "cfg.json": "{}\n" });
  // 父仓库与 client 各有一个本地改动。
  put(root, "AGENTS.md", "# ws changed\n");
  put(path.join(root, "client"), "Assets/Game.cs", "class Game { int x; }\n");
  return { root, battle: path.join(root, "battle"), client: path.join(root, "client"), r2: path.join(root, "battle-r2"), nested: path.join(root, "client", ".gdconfig_tmp") };
}

async function localSuite() {
  const traceDir = path.join(runDir, "trace");
  mkdirSync(traceDir, { recursive: true });
  const fx = fixture();
  report.fixtures = fx;
  const repos = [fx.root, fx.battle, fx.client, fx.r2, fx.nested];
  // 写操作刚结束时 Git 的 index.lock 可能在遍历途中被删除：遍历失败时稍等重试。
  const fingerprintOf = (repo) => {
    for (let attempt = 0; ; attempt++) {
      try { return repositoryFingerprint(repo); } catch (error) { if (attempt >= 5 || error.code !== "ENOENT") throw error; spawnSync("cmd", ["/c", "ping", "-n", "2", "127.0.0.1"], { stdio: "ignore" }); }
    }
  };
  const fingerprints = () => Object.fromEntries(repos.map((r) => [r, fingerprintOf(r)]));
  const segment = (name, before, allowed = {}) => {
    const after = fingerprints();
    const changes = Object.fromEntries(repos.map((r) => [path.relative(runDir, r), diffFingerprints(before[r], after[r])]).filter(([, c]) => c.length));
    const unexpected = Object.entries(changes).flatMap(([repo, files]) => files.filter((f) => !(allowed[repo] ?? []).some((pattern) => pattern.test(f))).map((f) => `${repo}:${f}`));
    report.segments.push({ name, changes, unexpected });
    check(`${name}：仓库只在预期位置变化`, unexpected.length === 0, unexpected);
    return after;
  };
  const trace = tracer(traceDir);
  let ctx = await start("local", { GIT_TRACE2_EVENT: traceDir });
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    let fp = fingerprints();
    trace.take();
    // ---------- B31 添加即识别 ----------
    const t0 = await ctx.addProject(fx.root);
    await ctx.waitUntil(`window.__w.picker() === 'game-workspace' && window.__op.rows().includes('AGENTS.md')`, 30000);
    report.timings.addWorkspaceMs = Date.now() - t0;
    const tabs = await ctx.evaluate(`window.__w.tabs()`);
    check("B31 工作区只占一个标签，带工作区标识", tabs.length === 1 && tabs[0].workspace && tabs[0].active && samePath(tabs[0].title, fx.root), tabs);
    await ctx.waitUntil(`/7 个子模块|3 个子模块/.test(window.__w.tabs()[0].text)`, 10000).catch(() => {});
    const toastSeen = await ctx.waitUntil(`window.__w.toast().includes('已作为工作区添加 game-workspace')`, 5000).then(() => true, () => false);
    check("B31 提示已作为工作区添加", toastSeen, await ctx.evaluate(`window.__w.toast()`));
    const parentFiles = await ctx.evaluate(`window.__op.rows()`);
    check("B32 父仓库只列自身文件（不含子模块内部文件，指针开关默认关闭时无子模块条目）", q(parentFiles) === q(["AGENTS.md"]), parentFiles);
    check("B34 嵌套仓库折叠说明", (await ctx.evaluate(`window.__w.nested()`)) === "1 个嵌套仓库未显示", await ctx.evaluate(`window.__w.nestedRows()`));
    const opened = trace.take();
    check("B31 打开工作区没有执行 git submodule 子命令，也没有写命令", !opened.some((e) => WRITE_COMMANDS.test(e.command)), opened.filter((e) => WRITE_COMMANDS.test(e.command)));
    const parentStatus = opened.filter((e) => e.command.startsWith("status") && e.cwd && samePath(e.cwd, fx.root));
    check("B33 父仓库 status 带 --ignore-submodules=all", parentStatus.length > 0 && parentStatus.every((e) => e.command.includes("--ignore-submodules=all")), parentStatus.map((e) => e.command));
    check("B31 .gitmodules 只按 --file 读取 path", opened.filter((e) => e.command.startsWith("config")).every((e) => e.command.includes("--file .gitmodules") && e.command.includes(".path$")), opened.filter((e) => e.command.startsWith("config")).map((e) => e.command));
    report.shots = { parent: await ctx.shot("01-parent") };
    // ---------- B35 选择器与徽标 ----------
    trace.take();
    await ctx.click(`document.querySelector('.repo-picker-button')`);
    await ctx.waitUntil(`document.querySelector('.repo-picker') && !window.__w.scanning()`, 30000);
    const rows = await ctx.evaluate(`window.__w.rows()`);
    report.pickerRows = rows;
    check("B31 成员顺序：父仓库、子模块（worktree 在所属仓库下）", q(rows.map((r) => r.name)) === q(["game-workspace", "battle", "battle-r2", "client", "audio"]) || q(rows.map((r) => r.name)) === q(["game-workspace", "audio", "battle", "battle-r2", "client"]), rows.map((r) => r.name));
    const audio = rows.find((r) => r.name === "audio");
    check("B31 未初始化的子模块灰显并给出命令行做法", audio?.disabled && audio.hint?.includes("git submodule update --init -- audio"), audio);
    check("B31 独立嵌套仓库默认不在列表中", !rows.some((r) => r.name === ".gdconfig_tmp"), rows.map((r) => r.name));
    const client = rows.find((r) => r.name === "client");
    check("B35 徽标：client 1 个改动、父仓库 1 个改动", client?.badges.includes("1 个改动") && rows[0].badges.includes("1 个改动"), rows.map((r) => [r.name, r.badges]));
    const scan = trace.take().filter((e) => e.command.startsWith("status"));
    report.pickerScan = scan;
    check("B35 打开选择器时读取改动数的 status 最多同时 2 个", maxOverlap(scan) <= 2 && scan.length >= 2, { count: scan.length, overlap: maxOverlap(scan) });
    report.shots.picker = await ctx.shot("02-picker");
    await sleep(1500);
    check("B35 静置时没有成员扫描进程", trace.take().filter((e) => e.command.startsWith("status")).length === 0);
    // ---------- 切换到 client ----------
    const ts = Date.now();
    await ctx.click(`window.__w.row('client')`);
    await ctx.waitUntil(`window.__w.picker() === 'client' && window.__op.rows().includes('Assets/Game.cs')`, 30000);
    report.timings.firstSwitchToClientMs = Date.now() - ts;
    check("B32 切到 client：文件列表只有 client 的改动，标签仍是工作区", q(await ctx.evaluate(`window.__op.rows()`)) === q(["Assets/Game.cs"]) && (await ctx.evaluate(`window.__w.tabs()[0].active`)), await ctx.evaluate(`window.__op.rows()`));
    check("B34 client 中的独立嵌套仓库可以加入工作区", (await ctx.evaluate(`window.__w.nestedRows()`))[0]?.button === "加入工作区", await ctx.evaluate(`window.__w.nestedRows()`));
    check("B33 没有子模块的仓库不显示指针开关", (await ctx.evaluate(`window.__w.pointer()`)) === null);
    fp = segment("打开、选择器、切换（只读）", fp);
    // 可逆写操作：只影响 client 的 index。
    await ctx.click(`window.__op.row('Assets/Game.cs').querySelector('.file-action')`);
    await ctx.waitUntil(`!window.__op.row('Assets/Game.cs')`, 15000);
    // client 的 Git 目录位于父仓库的 .git/modules/client 下：暂存只改它的 index（及新写入的 blob 对象）。
    const clientIndex = { "game-workspace": [/^\.git\/modules\/client\/(index|objects\/)/] };
    fp = segment("在 client 中暂存", fp, clientIndex);
    await ctx.click(`window.__op.scopeButton('已暂存')`);
    await ctx.waitUntil(`window.__op.row('Assets/Game.cs') && !window.__op.row('Assets/Game.cs').querySelector('.file-action')?.disabled`, 15000);
    await ctx.click(`window.__op.row('Assets/Game.cs').querySelector('.file-action')`);
    await ctx.waitUntil(`!window.__op.row('Assets/Game.cs')`, 15000);
    await ctx.click(`window.__op.scopeButton('未暂存')`);
    fp = segment("在 client 中取消暂存", fp, clientIndex);
    // 热切换回父仓库再回来。
    const hot = [];
    for (let i = 0; i < 5; i++) {
      for (const target of ["game-workspace", "client"]) {
        await ctx.evaluate(`document.querySelector('.repo-picker-button').click()`);
        await ctx.waitUntil(`window.__w.row(${q(target)})`);
        const t = Date.now();
        await ctx.evaluate(`window.__w.row(${q(target)}).click()`);
        await ctx.waitUntil(`window.__w.picker() === ${q(target)} && window.__op.rows().length > 0`, 15000);
        hot.push(Date.now() - t);
      }
    }
    report.timings.hotSwitchMs = hot;
    // ---------- B36 父仓库不因子仓库写入而重扫 ----------
    await ctx.evaluate(`document.querySelector('.repo-picker-button').click()`);
    await ctx.waitUntil(`window.__w.row('game-workspace')`);
    await ctx.evaluate(`window.__w.row('game-workspace').click()`);
    await ctx.waitUntil(`window.__w.picker() === 'game-workspace'`);
    await sleep(2500); trace.take();
    for (let i = 0; i < 2000; i++) put(fx.client, `Library/cache-${i}.bin`, "x");
    for (let i = 0; i < 20; i++) put(fx.client, `Assets/new-${i}.cs`, "class N {}\n");
    await sleep(3000);
    const afterWrites = trace.take();
    check("B36 选中父仓库时子仓库的大量写入不触发父仓库或子仓库扫描", !afterWrites.some((e) => e.command.startsWith("status")), afterWrites.map((e) => `${e.cwd} ${e.command}`));
    await ctx.click(`document.querySelector('.repo-picker-button')`);
    await ctx.waitUntil(`window.__w.row('client')`);
    // 有变化的成员在打开选择器时重新读取（V2-D82）：“有变化”之后改动数更新为新值（Game.cs + 20 个新文件；Library/ 被忽略）。
    await ctx.waitUntil(`!window.__w.scanning()`, 30000);
    const clientBadges = await ctx.evaluate(`window.__w.rows().find((r) => r.name === 'client').badges`);
    check("B35 子仓库外部变化后重新读取，改动数更新（被忽略的 Library/ 不计）", clientBadges.includes("21 个改动"), clientBadges);
    await ctx.key(`document.querySelector('.repo-picker')`, { key: "Escape" });
    // ---------- B33 指针开关 ----------
    const oldBattle = git(fx.battle, ["rev-parse", "HEAD"]);
    put(fx.battle, "src/match.rs", "fn main() { run(); }\n");
    const newBattle = commitAll(fx.battle, "move pointer");
    await sleep(1500);
    fp = fingerprints();
    trace.take();
    check("B33 开关关闭：父仓库不显示子模块条目", !(await ctx.evaluate(`window.__op.rows()`)).includes("battle"), await ctx.evaluate(`window.__op.rows()`));
    await ctx.click(`document.querySelector('.pointer-switch')`);
    await ctx.waitUntil(`window.__op.rows().includes('battle')`, 15000);
    check("B33 开关打开：只显示提交指针变化的 battle（client 只有内部改动，不显示）", q((await ctx.evaluate(`window.__op.rows()`)).sort()) === q(["AGENTS.md", "battle"]), await ctx.evaluate(`window.__op.rows()`));
    const pointerText = await ctx.evaluate(`window.__w.pointerText('battle')`);
    check("B33 指针行显示“记录 → 当前”", pointerText === `${oldBattle.slice(0, 7)} → ${newBattle.slice(0, 7)}`, pointerText);
    const toggled = trace.take().filter((e) => e.command.startsWith("status") && e.cwd && samePath(e.cwd, fx.root));
    check("B33 开关打开后父仓库 status 带 --ignore-submodules=dirty", toggled.length > 0 && toggled.every((e) => e.command.includes("--ignore-submodules=dirty")), toggled.map((e) => e.command));
    report.shots.pointers = await ctx.shot("03-pointers");
    fp = segment("切换子模块指针开关", fp);
    // ---------- B34 历史中的指针变化 ----------
    git(fx.root, ["add", "battle"]);
    git(fx.root, ["commit", "-q", "-m", "bump battle"]);
    const bump = git(fx.root, ["rev-parse", "HEAD"]);
    await sleep(1500);
    await ctx.click(`window.__w.gitTab('历史')`);
    await ctx.waitUntil(`window.__w.logRow(${q(bump)})`, 20000);
    await ctx.click(`window.__w.logRow(${q(bump)})`);
    await ctx.waitUntil(`window.__w.button('在 battle 中比较')`, 15000);
    fp = fingerprints();
    await ctx.click(`window.__w.button('在 battle 中比较')`);
    await ctx.waitUntil(`window.__w.picker() === 'battle' && window.__w.compareHead()`, 20000);
    const meta = await ctx.evaluate(`window.__w.compareMeta()`);
    check("B34 跳到 battle 并比较指针的前后两个提交", meta.some((m) => m.includes(oldBattle)) && meta.some((m) => m.includes(newBattle)), meta);
    await ctx.waitUntil(`document.querySelector('.log-detail-body .log-group')?.textContent.includes('A → B')`, 15000).catch(() => {});
    const historyErrors = await ctx.evaluate(`window.__w.historyErrors()`);
    check("B34 比较与历史读取没有错误（子仓库打开后才挂载历史页）", historyErrors.length === 0, historyErrors);
    report.shots.history = await ctx.shot("04-history-compare");
    fp = segment("历史跳转（只读）", fp);
    await stop(ctx);
    // ---------- 重启恢复与移除 ----------
    ctx = await start("local", { GIT_TRACE2_EVENT: traceDir });
    await ctx.waitUntil(`window.__w.picker() === 'battle'`, 30000);
    check("B32 重启后恢复到上次选中的成员", (await ctx.evaluate(`window.__w.picker()`)) === "battle");
    await ctx.click(`document.querySelector('.project-tab .project-close')`);
    await ctx.waitUntil(`document.querySelector('.project-empty')`, 15000);
    check("移除工作区：只删除应用记录，全部成员一并移出", (await ctx.evaluate(`window.__w.tabs().length`)) === 0);
    segment("重启与移除", fp);
  } catch (error) {
    fail(`本地套件中断：${error.stack ?? error}`);
    try { report.shots = { ...(report.shots ?? {}), failure: await ctx.shot("99-failure") }; } catch { /* 忽略 */ }
  } finally {
    await stop(ctx).catch(() => {});
  }
}

// ================================ 真实工作区只读冒烟 ================================
async function realSuite() {
  const traceDir = path.join(runDir, "trace-real");
  mkdirSync(traceDir, { recursive: true });
  const members = git(realRoot, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]).split("\n").filter(Boolean).map((line) => path.join(realRoot, line.split(" ")[1]));
  const repos = [realRoot, ...members.filter((dir) => { try { return samePath(git(dir, ["rev-parse", "--show-toplevel"]), dir); } catch { return false; } })];
  report.realRepos = repos;
  const before = Object.fromEntries(repos.map((r) => [r, lightFingerprint(r)]));
  const trace = tracer(traceDir);
  const ctx = await start("real", { GIT_TRACE2_EVENT: traceDir });
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    const t0 = await ctx.addProject(realRoot);
    await ctx.waitUntil(`window.__w.picker() === 'game-workspace' && !window.__op.loading()`, 60000);
    report.timings.realAddMs = Date.now() - t0;
    report.realParentFiles = await ctx.evaluate(`window.__op.rows()`);
    report.realNested = await ctx.evaluate(`window.__w.nestedRows()`);
    report.shots = { realParent: await ctx.shot("11-real-parent") };
    const tp = Date.now();
    await ctx.click(`document.querySelector('.repo-picker-button')`);
    await ctx.waitUntil(`document.querySelector('.repo-picker') && !window.__w.scanning()`, 180000);
    report.timings.realPickerBadgesMs = Date.now() - tp;
    report.realRows = await ctx.evaluate(`window.__w.rows()`);
    report.shots.realPicker = await ctx.shot("12-real-picker");
    for (const name of ["client", "gdconfig", "game-workspace"]) {
      if (!(await ctx.evaluate(`!!window.__w.row(${q(name)})`))) { await ctx.evaluate(`document.querySelector('.repo-picker-button').click()`); await ctx.waitUntil(`window.__w.row(${q(name)})`); }
      const row = (await ctx.evaluate(`window.__w.rows()`)).find((r) => r.name === name);
      if (!row || row.disabled) continue;
      const t = Date.now();
      await ctx.evaluate(`window.__w.row(${q(name)}).click()`);
      await ctx.waitUntil(`window.__w.picker() === ${q(name)} && !window.__op.loading()`, 120000);
      report.timings[`realSwitch:${name}`] = Date.now() - t;
      report.shots[`real-${name}`] = await ctx.shot(`13-real-${name}`);
    }
  } catch (error) {
    fail(`真实工作区冒烟中断：${error.stack ?? error}`);
  } finally {
    await stop(ctx).catch(() => {});
  }
  const commands = trace.take();
  report.realCommands = [...new Set(commands.map((e) => e.command.split(" ")[0]))].sort();
  check("真实工作区：没有执行任何写命令或 git submodule 子命令", !commands.some((e) => WRITE_COMMANDS.test(e.command)), commands.filter((e) => WRITE_COMMANDS.test(e.command)).map((e) => `${e.cwd} ${e.command}`));
  const after = Object.fromEntries(repos.map((r) => [r, lightFingerprint(r)]));
  const changed = repos.filter((r) => q(before[r]) !== q(after[r])).map((r) => ({ repo: r, before: before[r], after: after[r] }));
  check("真实工作区：各成员 refs / index / HEAD / config / status 前后一致", changed.length === 0, changed.map((c) => c.repo));
}

try {
  if (only === "local") await localSuite();
  else if (only === "real") await realSuite();
  else throw new Error(`未知 --only ${only}`);
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.failures.length === 0;
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  log(report.passed ? "全部通过" : `${report.failures.length} 项未通过`, path.join(outDir, "report.json"));
  if (!args.includes("--keep")) spawnSync("cmd", ["/c", "rd", "/s", "/q", runDir]);
  process.exitCode = report.passed ? 0 : 1;
}
