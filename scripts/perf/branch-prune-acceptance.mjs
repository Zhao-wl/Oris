// B30 界面验收（V2-D74）：历史页“本地分支”的“清理…”（fetch --prune 后删除上游已消失的本地分支）与右键“删除分支…”。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
// 点击是 CDP 注入的页面事件，不是真实鼠标、键盘或系统焦点。
// 每个写操作前后都记录仓库指纹（.git 不含 objects/logs、工作区逐文件 SHA-256）与全部引用（for-each-ref），核对只在预期的引用上变化。
// 用法：node scripts/perf/branch-prune-acceptance.mjs --exe <oris.exe> [--port 9971] [--only local|real] [--run-id <运行编号>] [--keep]
//   --only local（默认）：本地 bare remote，不联网。
//   --only real 需要 --run-id：在 %TEMP%\oris-remote\<run-id>\branch-prune 下克隆 AgentHub，只创建 / 删除 oris-test/<run-id>/ 分支。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
let port = Number(option("port", 9971));
const only = option("only", "local");
const runId = option("run-id", null);
const keep = args.includes("--keep");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "branch-prune-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `branch-prune-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const REMOTE_ROOT = realpathSync.native(tmpdir()) + path.sep + "oris-remote";
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), only, runId, startedAt: new Date().toISOString(), runDir, method: "CDP 页面事件（点击）；不是真实鼠标、键盘或系统焦点。仓库指纹为 .git（不含 objects/logs）与工作区逐文件 SHA-256；引用用 for-each-ref 全量比对。", checks: {}, operations: [], processes: {}, failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 900)}`); };

// ---------- 指纹与引用 ----------
function categorize(keys) {
  return [...new Set(keys.map((k) => k === ".git/index" ? "index"
    : (k === ".git/HEAD" || k.startsWith(".git/refs/heads/")) ? "head"
    : k === ".git/refs/stash" ? "stash"
    : (k.startsWith(".git/refs/remotes/") || k.startsWith(".git/refs/tags/") || k === ".git/packed-refs") ? "refs"
    : k === ".git/config" ? "config"
    : k.startsWith(".git/") ? `git:${k.slice(5)}` : "worktree"))].sort();
}
const refsOf = (repo) => Object.fromEntries(git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n").filter(Boolean).map((line) => line.split(" ")));
function refDelta(before, after) {
  const removed = Object.keys(before).filter((name) => !(name in after)).sort();
  const added = Object.keys(after).filter((name) => !(name in before)).sort();
  const moved = Object.keys(after).filter((name) => name in before && before[name] !== after[name]).sort();
  return { removed, added, moved };
}
const snapshot = (repo) => ({ fp: repositoryFingerprint(repo), refs: refsOf(repo), stash: git(repo, ["stash", "list"], { allowFail: true }), status: git(repo, ["status", "--porcelain=v1", "-uall"]) });
/** 一次操作的证据：文件类别只允许 allowed（FETCH_HEAD 总是允许），引用只允许删除 expectRemoved 中的项、不新增不移动。 */
function evidence(name, repo, before, allowed, expectRemoved) {
  const after = snapshot(repo);
  const changed = diffFingerprints(before.fp, after.fp);
  const categories = categorize(changed);
  const unexpected = categories.filter((c) => !allowed.includes(c) && c !== "git:FETCH_HEAD");
  const refs = refDelta(before.refs, after.refs);
  const refsOk = refs.added.length === 0 && refs.moved.length === 0 && q(refs.removed) === q([...expectRemoved].sort());
  const entry = { name, repo, changedCount: changed.length, changed: changed.slice(0, 40), categories, allowed, unexpected, refs, expectRemoved: [...expectRemoved].sort(), refsOk, stashSame: before.stash === after.stash, statusSame: before.status === after.status };
  entry.ok = unexpected.length === 0 && refsOk && entry.stashSame && entry.statusSame;
  report.operations.push(entry);
  return entry;
}

// ---------- 夹具 ----------
const put = (repo, rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
const configure = (repo) => { for (const [key, value] of [["user.name", "Oris GUI"], ["user.email", "oris-gui@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, ["config", key, value]); };
const commitAll = (repo, message) => { git(repo, ["add", "-A"]); const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: repo, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return git(repo, ["rev-parse", "HEAD"]); };

/**
 * origin（bare）：main、gone-a / gone-b（与 main 相同，已合并）、gone-c（多一个提交，未合并）、alive、stale-x（本地不跟踪）与标签 v1；
 * mirror（第二个 bare）：mgone。work 克隆 origin、获取 mirror，建立 gone-a / gone-b / gone-c / alive 的跟踪分支和本地分支 solo（无上游）、side（无上游、未合并）。
 * 之后在远端删除 gone-a / gone-b / gone-c / stale-x 与标签 v1，在 mirror 删除 mgone；work 尚未获取，界面上它们的上游还“存在”。
 */
function fixture() {
  const seed = path.join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]); configure(seed);
  put(seed, "a.txt", "base\n"); const base = commitAll(seed, "base");
  for (const name of ["gone-a", "gone-b", "alive", "stale-x"]) git(seed, ["branch", "-q", name, base]);
  git(seed, ["switch", "-q", "-c", "gone-c"]); put(seed, "c.txt", "only on gone-c\n"); const goneC = commitAll(seed, "gone-c work");
  git(seed, ["switch", "-q", "main"]);
  git(seed, ["tag", "v1", base]);
  const origin = path.join(runDir, "origin.git");
  git(runDir, ["clone", "-q", "--bare", seed, origin]);
  const mirror = path.join(runDir, "mirror.git");
  git(runDir, ["init", "-q", "--bare", mirror]);
  git(seed, ["push", "-q", mirror, `${base}:refs/heads/mgone`, `${base}:refs/heads/mkeep`]);
  const work = path.join(runDir, "work");
  git(runDir, ["clone", "-q", "-c", "core.autocrlf=false", origin, work]); configure(work);
  git(work, ["remote", "add", "mirror", mirror]);
  git(work, ["fetch", "-q", "mirror"]);
  for (const name of ["gone-a", "gone-b", "gone-c", "alive"]) git(work, ["branch", "-q", "--track", name, `origin/${name}`]);
  git(work, ["branch", "-q", "solo", base]);
  git(work, ["switch", "-q", "-c", "side"]); put(work, "s.txt", "side\n"); const side = commitAll(work, "side work"); git(work, ["switch", "-q", "main"]);
  // 用户配置要求 prune（含标签）：普通获取仍不 prune，清理也不 prune 标签。
  git(work, ["config", "fetch.prune", "true"]);
  git(work, ["config", "remote.origin.pruneTags", "true"]);
  // 远端删除。
  git(runDir, ["--git-dir", origin, "branch", "-q", "-D", "gone-a", "gone-b", "gone-c", "stale-x"]);
  git(runDir, ["--git-dir", origin, "tag", "-d", "v1"]);
  git(runDir, ["--git-dir", mirror, "branch", "-q", "-D", "mgone"]);
  return { origin, mirror, work, goneC, side };
}

// ---------- 页面辅助 ----------
const H = String.raw`
(() => {
  if (window.__p) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  window.__p = {
    button(text, root = document) { return qa('button', root).find((b) => b.textContent === text) ?? null; },
    gitTab(prefix) { return qa('.git-tabs button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    pruneButton() { return document.querySelector('[data-group="local"] .log-group-action'); },
    localRow(name) { return document.querySelector('[data-group="local"] [data-ref="refs/heads/' + name + '"]'); },
    localNames() { return qa('[data-group="local"] [data-ref^="refs/heads/"]').map((n) => n.dataset.ref.slice(11)); },
    remoteNames() { return qa('[data-ref^="refs/remotes/"]').map((n) => n.dataset.ref.slice(13)); },
    tagNames() { return qa('[data-ref^="refs/tags/"]').map((n) => n.dataset.ref.slice(10)); },
    confirm() { const d = document.querySelector('.confirm-dialog'); return d ? { text: d.textContent, items: qa('.confirm-items li', d).map((li) => li.textContent), warning: d.querySelector('.confirm-warning')?.textContent ?? null } : null; },
    opStatus() { const n = document.querySelector('.op-status'); return n ? { cls: n.className, text: n.textContent } : null; },
    running() { return !!document.querySelector('.op-status.running'); },
    main(kind) { return document.querySelector('.sync-' + kind + ' .sync-main'); },
    remoteChoice() { return document.querySelector('.remote-choice-dialog'); },
    context(el) { const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 8 })); },
    menuItem(prefix) { return qa('.log-menu button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    closeMenu() { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); },
    logRows() { return qa('.log-row').map((r) => ({ oid: r.dataset.oid, selected: r.classList.contains('selected') || r.getAttribute('aria-selected') === 'true' })); },
    browsing() { return document.querySelector('.log-branch.browsing')?.dataset.ref ?? null; },
    jumpNote() { return document.querySelector('.log-jump-note')?.textContent ?? null; },
    /** 从现在起记录状态栏出现过的文字（MutationObserver），用于区分点击之后的新结果与上一步留下的旧文字。 */
    watchStatus() { window.__p.seen = [document.querySelector('.op-status')?.textContent ?? '']; window.__p.observer?.disconnect(); const push = () => { const t = document.querySelector('.op-status')?.textContent ?? ''; if (t && window.__p.seen[window.__p.seen.length - 1] !== t) window.__p.seen.push(t); }; window.__p.observer = new MutationObserver(push); window.__p.observer.observe(document.body, { subtree: true, childList: true, characterData: true }); },
    seenStatus(fragment) { return (window.__p.seen ?? []).slice(1).some((t) => t.includes(fragment)); },
    logError() { return document.querySelector('.log-commits-pane .error, .log-commits-pane .log-note.error')?.textContent ?? null; }
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
  const settle = (timeout = 60000) => waitUntil(`!window.__p.running() && !window.__op.loading()`, timeout);
  const addProject = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await evaluate(`window.__op.button('载入/添加').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 30000);
    await sleep(400);
  };
  const openHistory = async () => { if (!(await evaluate(`window.__p.gitTab('历史')?.classList.contains('active')`))) await click(`window.__p.gitTab('历史')`); await waitUntil(`window.__p.localNames().length > 0`); await sleep(300); };
  const confirmDialog = async (label) => { await waitUntil(`!!document.querySelector('.confirm-dialog')`); await click(`window.__p.button(${q(label)}, document.querySelector('.confirm-dialog'))`); };
  /** 点“清理…”并等到出现确认框，或出现“没有需要清理的本地分支”（此时不弹框）。获取刚结束时状态栏先显示“已获取…”，不能当作清理结束。 */
  const prune = async (timeout = 120000) => { await evaluate(`window.__p.watchStatus()`); await click(`window.__p.pruneButton()`); await waitUntil(`!!document.querySelector('.confirm-dialog') || (!window.__p.running() && window.__p.seenStatus('没有需要清理的本地分支'))`, timeout); await sleep(300); };
  return { app, evaluate, waitUntil, shot, click, settle, addProject, openHistory, confirmDialog, prune };
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

// ================================ 本地 bare remote ================================
async function localSuite() {
  const traceDir = path.join(runDir, "trace");
  mkdirSync(traceDir, { recursive: true });
  const { work, origin, goneC, side } = fixture();
  report.fixtures = { work, origin };
  const ctx = await start("local", { GIT_TRACE2_EVENT: traceDir });
  const traces = () => new Set(readdirSync(traceDir));
  const traced = async (name, action) => {
    const before = traces();
    const result = await action();
    await sleep(1500);
    const commands = traceCommands(traceDir, [...traces()].filter((f) => !before.has(f))).sort();
    report.processes[name] = { count: commands.length, commands };
    return { result, fetches: commands.filter((c) => c.startsWith("fetch")) };
  };
  try {
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    await ctx.addProject(work);
    // ---------- 入口与只读 ----------
    let before = snapshot(work);
    await ctx.openHistory();
    const entry = await ctx.evaluate(`({ prune: !!window.__p.pruneButton(), title: window.__p.pruneButton()?.title ?? null, local: window.__p.localNames() })`);
    let e = evidence("打开历史页", work, before, [], []);
    check("B30 入口：存在有上游的非当前分支时“本地分支”分组显示“清理…”（提示会 fetch --prune）；打开历史页不改仓库", entry.prune && entry.title.includes("fetch --prune") && e.ok && e.changedCount === 0, { entry, e });

    // ---------- 普通获取不 prune（覆盖 fetch.prune=true） ----------
    before = snapshot(work);
    const plain = await traced("普通获取", async () => {
      await ctx.click(`window.__p.main('fetch')`); await sleep(400);
      if (await ctx.evaluate(`!!window.__p.remoteChoice()`)) { await ctx.evaluate(`window.__p.remoteChoice().querySelector('input[aria-label="origin"]').click()`); await sleep(100); await ctx.click(`window.__p.button('获取', window.__p.remoteChoice())`); }
      await ctx.settle();
    });
    e = evidence("普通获取 origin", work, before, ["refs"], []);
    check("B30 普通获取：参数为 --no-prune（用户配置 fetch.prune=true 也不 prune），不删除任何远端跟踪引用与标签", plain.fetches.length === 1 && plain.fetches[0].includes("--no-prune") && !/--prune(\s|$)/.test(plain.fetches[0]) && e.ok, { fetches: plain.fetches, e });

    // ---------- 清理：列表范围、取消不删 ----------
    before = snapshot(work);
    const first = await traced("清理（取消）", async () => { await ctx.prune(); });
    const dialog1 = await ctx.evaluate(`window.__p.confirm()`);
    const shot1 = await ctx.shot("b30-prune-confirm");
    await ctx.confirmDialog("取消"); await sleep(500);
    const afterCancelLocal = await ctx.evaluate(`window.__p.localNames()`);
    const pruned = ["refs/remotes/origin/gone-a", "refs/remotes/origin/gone-b", "refs/remotes/origin/gone-c", "refs/remotes/origin/stale-x"];
    e = evidence("清理：fetch --prune 后取消确认", work, before, ["refs"], pruned);
    check("B30 清理只获取有上游的本地分支所在的 remote（origin），参数 --prune --no-prune-tags（覆盖 pruneTags=true）；mirror 不获取", first.fetches.length === 1 && first.fetches[0].includes("--prune") && first.fetches[0].includes("--no-prune-tags") && first.fetches[0].endsWith("origin") && !first.fetches.some((c) => c.includes("mirror")), { fetches: first.fetches });
    check("B30 prune 只删除 origin 的 stale 跟踪引用（含本地不跟踪的 stale-x）；标签 v1（远端已删）与 mirror/mgone 保留", e.refsOk && "refs/tags/v1" in refsOf(work) && "refs/remotes/mirror/mgone" in refsOf(work), { refs: e.refs });
    check("B30 确认框只列上游已消失的非当前本地分支（不含 main、alive、solo、side），说明未合并会再次确认、远端不受影响", q(dialog1?.items) === q(["gone-a", "gone-b", "gone-c"]) && dialog1.text.includes("未合并的会再次确认") && dialog1.text.includes("远端分支不受影响") && !dialog1.warning, { dialog1, shot: shot1 });
    check("B30 取消确认：不删除任何本地分支；工作区、index、stash 不变", e.ok && ["gone-a", "gone-b", "gone-c", "alive", "solo", "side", "main"].every((n) => afterCancelLocal.includes(n)), { afterCancelLocal, e });

    // ---------- 清理：已合并直接删，未合并强确认后拒绝 ----------
    before = snapshot(work);
    await ctx.prune();
    await ctx.confirmDialog("删除");
    await ctx.waitUntil(`window.__p.confirm()?.text.includes('reflog')`, 30000);
    const strong = await ctx.evaluate(`window.__p.confirm()`);
    const shot2 = await ctx.shot("b30-prune-unmerged");
    await ctx.confirmDialog("取消");
    await ctx.settle(); await sleep(800);
    const summary = await ctx.evaluate(`window.__p.opStatus()`);
    e = evidence("清理：删除已合并的 gone-a / gone-b，拒绝未合并的 gone-c", work, before, ["head", "config", "refs"], ["refs/heads/gone-a", "refs/heads/gone-b"]);
    check("B30 未合并的分支汇总后强确认（列出 gone-c，说明只能从 reflog 找回）", q(strong?.items) === q(["gone-c"]) && strong.text.includes("reflog"), { strong, shot: shot2 });
    check("B30 已合并的直接删除；拒绝强确认时保留 gone-c 并如实汇总；只删除这两个本地分支（及其上游配置）", e.ok && git(work, ["rev-parse", "refs/heads/gone-c"]) === goneC && summary?.text.includes("已删除 2 个分支：gone-a、gone-b") && summary.text.includes("gone-c（未合并，已保留）"), { summary, e });

    // ---------- 清理：未合并强确认后删除 ----------
    before = snapshot(work);
    await ctx.prune();
    const dialog3 = await ctx.evaluate(`window.__p.confirm()`);
    await ctx.confirmDialog("删除");
    await ctx.waitUntil(`window.__p.confirm()?.text.includes('reflog')`, 30000);
    await ctx.confirmDialog("仍然删除");
    await ctx.settle(); await sleep(800);
    e = evidence("清理：强确认后删除未合并的 gone-c", work, before, ["head", "config", "refs"], ["refs/heads/gone-c"]);
    const tipKept = spawnSync("git", ["cat-file", "-e", `${goneC}^{commit}`], { cwd: work }).status === 0;
    check("B30 强确认后删除未合并分支 gone-c（提交对象仍在，可从 reflog 找回）", q(dialog3?.items) === q(["gone-c"]) && e.ok && tipKept, { dialog3, e, tipKept });

    // ---------- 没有可清理的分支 ----------
    before = snapshot(work);
    await ctx.prune();
    const nothing = { dialog: await ctx.evaluate(`window.__p.confirm()`), status: await ctx.evaluate(`window.__p.opStatus()`) };
    e = evidence("清理：没有需要清理的分支", work, before, ["refs"], []);
    check("B30 没有上游已消失的分支：不弹确认框，说明“没有需要清理的本地分支”，不删除任何引用", !nothing.dialog && nothing.status?.text.includes("没有需要清理的本地分支") && e.ok, { nothing, e });

    // ---------- 获取失败：不自动删除，确认框说明 ----------
    git(work, ["branch", "-q", "gone-d", "main"]);
    git(work, ["config", "branch.gone-d.remote", "origin"]); git(work, ["config", "branch.gone-d.merge", "refs/heads/gone-d"]);
    const originUrl = git(work, ["remote", "get-url", "origin"]);
    // 用 file:// URL：Windows 上带盘符的普通路径不存在时，Git 可能把它当成 ssh 的“主机:路径”去连接，而不是立即失败。
    git(work, ["remote", "set-url", "origin", "file:///" + path.join(runDir, "missing.git").replaceAll("\\", "/")]);
    await sleep(1500);
    before = snapshot(work);
    await ctx.prune();
    const failedDialog = await ctx.evaluate(`window.__p.confirm()`);
    const shot4 = await ctx.shot("b30-prune-fetch-failed");
    if (failedDialog) await ctx.confirmDialog("取消");
    await ctx.settle(); await sleep(500);
    e = evidence("清理：获取失败后取消", work, before, [], []);
    check("B30 获取失败：不自动删除；确认框说明“获取 origin 失败，以下结果基于本地已知的远端状态”，取消后不删除任何分支", failedDialog?.warning === "获取 origin 失败，以下结果基于本地已知的远端状态" && q(failedDialog.items) === q(["gone-d"]) && e.ok, { failedDialog, e, shot: shot4 });
    git(work, ["remote", "set-url", "origin", originUrl]);
    git(work, ["branch", "-q", "-D", "gone-d"]);
    await sleep(1500);

    // ---------- 右键删除 ----------
    await ctx.openHistory();
    await ctx.evaluate(`window.__p.context(window.__p.localRow('main'))`); await sleep(200);
    const currentItem = await ctx.evaluate(`(() => { const b = window.__p.menuItem('删除分支'); return b ? { disabled: b.disabled, title: b.title } : null; })()`);
    await ctx.evaluate(`window.__p.closeMenu()`); await sleep(200);
    check("B30 右键删除：当前分支的“删除分支…”不可用，并说明需先切换", currentItem?.disabled && currentItem.title.includes("不能删除当前分支"), currentItem);
    // 已合并的 solo：先在侧栏选中它作为历史筛选，再删除；之后“跳到 HEAD”仍可用。
    await ctx.click(`window.__p.localRow('solo')`); await sleep(600);
    const filteredBefore = await ctx.evaluate(`window.__p.browsing()`);
    before = snapshot(work);
    await ctx.evaluate(`window.__p.context(window.__p.localRow('solo'))`); await sleep(200);
    await ctx.click(`window.__p.menuItem('删除分支')`);
    const plainDialog = await ctx.evaluate(`window.__p.confirm()`);
    await ctx.confirmDialog("删除"); await ctx.settle(); await sleep(800);
    const strongAsked = await ctx.evaluate(`!!window.__p.confirm()`);
    e = evidence("右键删除已合并分支 solo", work, before, ["head", "refs"], ["refs/heads/solo"]);
    // 删除的正是当前筛选的分支：记录历史列表恢复（筛选回到全部分支、重新列出提交）所需时间与期间的提示。
    const recoverStart = Date.now();
    const recovered = await ctx.evaluate(`window.__op.waitUntil(() => window.__p.logRows().length > 0, 15000)`, 20000);
    report.filteredDeleteRecoveryMs = Date.now() - recoverStart;
    report.filteredDeletePane = await ctx.evaluate(`document.querySelector('.log-commits-pane')?.textContent.slice(0, 200) ?? null`);
    const afterSolo = await ctx.evaluate(`({ local: window.__p.localNames(), browsing: window.__p.browsing(), rows: window.__p.logRows().length, error: window.__p.logError() })`);
    check("B30 右键删除已合并分支：一次确认后删除，只删除 refs/heads/solo；侧栏不再列出，历史列表可用", filteredBefore === "refs/heads/solo" && plainDialog?.text.includes("远端分支不受影响") && !strongAsked && e.ok && !afterSolo.local.includes("solo") && recovered.ok && afterSolo.rows > 0 && !afterSolo.error, { filteredBefore, plainDialog, afterSolo, recoveryMs: report.filteredDeleteRecoveryMs, pane: report.filteredDeletePane, e });
    if (strongAsked) await ctx.confirmDialog("取消");
    // 未合并的 side：强确认后删除。
    before = snapshot(work);
    await ctx.evaluate(`window.__p.context(window.__p.localRow('side'))`); await sleep(200);
    await ctx.click(`window.__p.menuItem('删除分支')`);
    await ctx.confirmDialog("删除");
    await ctx.waitUntil(`window.__p.confirm()?.text.includes('reflog')`, 30000);
    const sideStrong = await ctx.evaluate(`window.__p.confirm()`);
    const unchangedBeforeForce = evidence("右键删除 side：强确认前", work, before, [], []).ok;
    await ctx.confirmDialog("仍然删除"); await ctx.settle(); await sleep(800);
    e = evidence("右键强制删除未合并分支 side", work, before, ["head", "refs"], ["refs/heads/side"]);
    check("B30 右键删除未合并分支：强确认（说明只能从 reflog 找回）前仓库不变，确认后只删除 refs/heads/side", sideStrong?.text.includes("reflog") && sideStrong.text.includes(side.slice(0, 8)) && unchangedBeforeForce && e.ok, { sideStrong, e });
    // 跳到 HEAD（V2-D39）。
    await ctx.click(`window.__p.button('跳到 HEAD')`); await sleep(800);
    const head = git(work, ["rev-parse", "HEAD"]);
    const jumped = await ctx.evaluate(`({ rows: window.__p.logRows().slice(0, 50), note: window.__p.jumpNote(), browsing: window.__p.browsing() })`);
    check("B30 删除分支后“跳到 HEAD”定位到 HEAD 提交", jumped.rows.some((r) => r.oid === head && r.selected), { head, jumped: { ...jumped, rows: jumped.rows.filter((r) => r.selected) }, shot: await ctx.shot("b30-after-delete-jump-head") });
  } catch (error) {
    fail(`验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { await ctx.shot("failure"); } catch { /* ignore */ }
  } finally {
    report.stop = await stop(ctx);
  }
}

// ================================ 真实远端 AgentHub（阶段 3，只在 --only real 时调用） ================================
const AGENTHUB = { ssh: "git@github.com:Zhao-wl/AgentHub.git" };
function netGit(cwd, argv, { allowFail = false } = {}) {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8", timeout: 180000 });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${argv.join(" ")} 失败：${result.stderr}`);
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}
async function realSuite() {
  if (!runId) throw new Error("真实远端需要 --run-id");
  const base = path.join(REMOTE_ROOT, runId, "branch-prune");
  mkdirSync(base, { recursive: true });
  report.real = { base, created: [], deleted: [] };
  const lsAll = () => netGit(base, ["ls-remote", AGENTHUB.ssh]).out;
  const lsRemote = (branch) => netGit(base, ["ls-remote", AGENTHUB.ssh, `refs/heads/${branch}`]).out.split(/\s+/)[0] || null;
  report.real.lsRemoteBefore = lsAll();
  const clone = path.join(base, "agenthub");
  netGit(base, ["clone", "-q", "-c", "core.autocrlf=false", AGENTHUB.ssh, clone]); configure(clone);
  const branches = ["prune-a", "prune-b"].map((name) => `oris-test/${runId}/${name}`);
  const record = (branch) => { report.real.created.push(branch); writeFileSync(path.join(base, "created-branches.json"), JSON.stringify(report.real.created)); };
  let ctx = null;
  try {
    for (const branch of branches) { record(branch); netGit(clone, ["push", "-q", "origin", `refs/remotes/origin/main:refs/heads/${branch}`]); }
    netGit(clone, ["fetch", "-q", "origin"]);
    for (const branch of branches) git(clone, ["branch", "-q", "--track", branch, `origin/${branch}`]);
    // 远端删除（真实 GitHub 上的删除），本地尚未获取。
    for (const branch of branches) { netGit(clone, ["push", "-q", "origin", `:refs/heads/${branch}`], { allowFail: true }); if (!lsRemote(branch)) report.real.deleted.push(branch); }
    ctx = await start("real");
    await ctx.waitUntil(`document.querySelector('.project-empty')`);
    await ctx.addProject(clone);
    await ctx.openHistory();
    const before = snapshot(clone);
    await ctx.prune(180000);
    const dialog = await ctx.evaluate(`window.__p.confirm()`);
    if (dialog) await ctx.confirmDialog("删除");
    await ctx.settle(180000); await sleep(800);
    const expectRemoved = branches.flatMap((b) => [`refs/heads/${b}`, `refs/remotes/origin/${b}`]);
    const e = evidence("AgentHub：清理远端已删除的测试分支", clone, before, ["head", "config", "refs"], expectRemoved);
    check("B30 / B12 真实远端 AgentHub（SSH）清理：fetch --prune 后只列出并删除本次的两个测试分支，标签与其他引用不变", q(dialog?.items) === q(branches) && e.ok, { dialog, e, status: await ctx.evaluate(`window.__p.opStatus()`), shot: await ctx.shot("real-prune") });
  } catch (error) {
    fail(`真实远端验收中断：${String(error.stack ?? error).slice(0, 1200)}`);
    try { if (ctx) await ctx.shot("real-failure"); } catch { /* ignore */ }
  } finally {
    if (ctx) report.stopReal = await stop(ctx);
    for (const branch of report.real.created) {
      if (report.real.deleted.includes(branch)) continue;
      const deleted = netGit(clone, ["push", "-q", "origin", `:refs/heads/${branch}`], { allowFail: true });
      if (deleted.ok || !lsRemote(branch)) report.real.deleted.push(branch); else fail(`删除测试分支失败：${branch} ${deleted.err}`);
    }
    const remaining = lsAll();
    report.real.lsRemoteAfter = remaining;
    check("AgentHub 清理：远端引用与开工时一致（没有遗留 oris-test/ 分支）", remaining === report.real.lsRemoteBefore && !remaining.includes("oris-test/"), { before: report.real.lsRemoteBefore, after: remaining });
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
