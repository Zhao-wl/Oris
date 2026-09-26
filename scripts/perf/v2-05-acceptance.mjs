// V2-05 界面验收：B15（hunk 级暂存 / 取消暂存 / 丢弃）、B16（锁）、B17（只读）与块操作时延、Git 进程数。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（gui-lib launchOris：PID + 完整路径 + 主窗口句柄 + 端口归属），
// 不调用任何窗口激活 API；点击 / 按键 / 指针移动都是 CDP 页面事件，不是真实系统输入或真实 Windows 焦点。
// 每个写操作场景都记录操作前后的 git diff / git diff --cached 与工作区、index、refs、stash、config 指纹。
// 用法：node scripts/perf/v2-05-acceptance.mjs --exe <oris.exe> [--only functional,perf] [--iterations 30] [--port 9971]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, machineInfo, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";
import { measuredSegment, startLoadMonitor } from "./load-monitor.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const only = new Set(option("only", "functional,perf").split(","));
const iterations = Number(option("iterations", 30));
let port = Number(option("port", 9971));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v2-05-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v2-05-acceptance-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), machine: machineInfo(), startedAt: new Date().toISOString(), method: "CDP 页面事件；写操作经 Oris 界面发起，前后用 git 命令与文件指纹核对", checks: {}, scenarios: {}, failures: [], perf: {} };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (!ok) fail(`${name} ${detail === undefined ? "" : q(detail).slice(0, 700)}`); else log("✓", name); };
const monitor = startLoadMonitor({ log });

// ------------------------------ 仓库证据 ------------------------------
const write = (repo, rel, bytes) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), bytes); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** 工作区、index、refs、stash、config 分类指纹（不含 .git/objects、.git/logs 中非 stash 的部分、hooks）。 */
function fingerprint(repo) {
  const groups = { worktree: [], index: [], refs: [], stash: [], config: [] };
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
      if (rel === ".git/objects" || rel === ".git/hooks") continue;
      if (statSync(full).isDirectory()) { walk(full, rel); continue; }
      const group = rel === ".git/index" ? "index" : rel === ".git/refs/stash" || rel === ".git/logs/refs/stash" ? "stash" : rel === ".git/HEAD" || rel.startsWith(".git/refs/") || rel === ".git/packed-refs" ? "refs" : rel === ".git/config" ? "config" : rel.startsWith(".git/") ? null : "worktree";
      if (group) groups[group].push([rel, hash(readFileSync(full))]);
    }
  };
  walk(repo, "");
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, hash(JSON.stringify(v.sort()))]));
}
const diffU0 = (repo, cached, file) => git(repo, ["diff", ...(cached ? ["--cached"] : []), "--no-color", "-U0", "--no-ext-diff", "--no-textconv", ...(file ? ["--", file] : [])]);
const bodies = (diff) => { const hunks = []; for (const line of diff.split("\n")) { if (line.startsWith("@@")) hunks.push(""); else if (hunks.length && /^[-+\\]/.test(line)) hunks[hunks.length - 1] += line + "\n"; } return hunks; };
const indexEntries = (repo) => git(repo, ["ls-files", "-s"]);
function evidence(name, repo, before) {
  const after = { diff: diffU0(repo, false), cached: diffU0(repo, true), fp: fingerprint(repo), index: indexEntries(repo) };
  const changed = Object.keys(before.fp).filter((k) => before.fp[k] !== after.fp[k]);
  const e = { name, gitDiffBefore: before.diff, gitDiffCachedBefore: before.cached, gitDiffAfter: after.diff, gitDiffCachedAfter: after.cached, fingerprintBefore: before.fp, fingerprintAfter: after.fp, changedGroups: changed, indexContentChanged: before.index !== after.index };
  report.scenarios[name] = e;
  return e;
}
const snapshot = (repo) => ({ diff: diffU0(repo, false), cached: diffU0(repo, true), fp: fingerprint(repo), index: indexEntries(repo) });

// ------------------------------ 夹具 ------------------------------
const numbered = (n, edit) => Array.from({ length: n }, (_, k) => edit(k + 1) ?? `line ${k + 1}`).join("\n") + "\n";
function prepareRepo(name) {
  const repo = path.join(runDir, `${name}-hunks`);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  write(repo, "a.txt", numbered(40, () => null));
  write(repo, "crlf.txt", "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\n");
  write(repo, "tail.txt", "a\nb\nc\nd\ne\nf\ng\nlast");
  write(repo, "latin1.txt", Buffer.from("caf\xe9 1\nplain 2\nplain 3\nplain 4\nplain 5\nplain 6\nna\xefve 7\n", "latin1"));
  write(repo, "ws.txt", "a = 1\nb = 2\nc = 3\n");
  write(repo, "bin.dat", Buffer.from([0, 1, 2, 3]));
  write(repo, "tool.sh", "#!/bin/sh\necho hi\n");
  write(repo, "big.txt", "x".repeat(5 * 1024 * 1024 + 100) + "\n");
  write(repo, "many.txt", numbered(640, () => null));
  git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
  write(repo, "a.txt", numbered(40, (i) => ({ 3: "line 3 changed", 20: "line 20 changed", 22: "line 22 changed", 34: "line 34\ninserted a\ninserted b" })[i] ?? null));
  write(repo, "crlf.txt", "one\r\nTWO\r\nthree\r\nfour\r\nfive\r\nSIX\r\nseven\r\n");
  write(repo, "tail.txt", "a\nB\nc\nd\ne\nf\ng\nlast changed");
  write(repo, "latin1.txt", Buffer.from("caf\xe9 1 \xa9\nplain 2\nplain 3\nplain 4\nplain 5\nplain 6\nna\xefve 7 \xae\n", "latin1"));
  write(repo, "ws.txt", "a  =  1\nb = 2\nc = 30\n");
  write(repo, "bin.dat", Buffer.from([0, 9, 2, 3]));
  write(repo, "big.txt", "y".repeat(5 * 1024 * 1024 + 100) + "\n");
  // many.txt：64 块，每 10 行改一行（时延测量用）
  write(repo, "many.txt", numbered(640, (i) => (i % 10 === 5 ? `line ${i} changed` : null)));
  git(repo, ["update-index", "--chmod=+x", "tool.sh"]);
  // 冲突仓库
  const conflict = path.join(runDir, `${name}-conflict`);
  mkdirSync(conflict, { recursive: true });
  git(conflict, ["init", "-q", "-b", "main"]);
  write(conflict, "c.txt", "base 1\nbase 2\nbase 3\n"); git(conflict, ["add", "-A"]); git(conflict, ["commit", "-q", "-m", "base"]);
  git(conflict, ["switch", "-q", "-c", "theirs"]); write(conflict, "c.txt", "base 1\ntheirs\nbase 3\n"); git(conflict, ["commit", "-q", "-am", "theirs"]);
  git(conflict, ["switch", "-q", "main"]); write(conflict, "c.txt", "base 1\nours\nbase 3\n"); git(conflict, ["commit", "-q", "-am", "ours"]);
  git(conflict, ["merge", "--no-edit", "theirs"], { allowFail: true });
  return { repo, conflict };
}

// ------------------------------ 实例 ------------------------------
async function start(profile, extraEnv = {}) {
  const app = await launchOris({ exe, profileDir: path.join(runDir, "profiles", profile), port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "profiles", `${profile}-cache`), ...extraEnv } });
  monitor.addOwnPid(app.pid);
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const measure = (action, predicate, timeout = 15000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
  const click = (expr) => evaluate(`(() => { const n = ${expr}; if (!n) throw new Error('找不到元素：' + ${q(expr)}); if (n.disabled) throw new Error('元素不可用：' + ${q(expr)} + ' ' + n.title); n.click(); return true; })()`);
  const shot = async (name) => { await sleep(200); const { data } = await call("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(data, "base64")); };
  const addRepo = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await click(`window.__op.button('载入/添加')`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && window.__op.rows().length > 0 && !window.__op.loading()`, 30000);
  };
  const scopeTo = async (label) => { await click(`window.__op.scopeButton(${q(label)})`); await waitUntil(`window.__op.footer().includes(${q(label)}) && !window.__op.loading()`); };
  const open = async (p, extra = "true") => { await click(`window.__op.row(${q(p)})`); await waitUntil(`window.__op.tab() === ${q(p)} && !window.__op.loading() && (document.querySelector('.cm-editor') || document.querySelector('.special-file')) && (${extra})`, 20000); await sleep(200); };
  // 指针移入 diff（CDP 鼠标移动，触发 pointerenter → 按需读取块映射）
  const hover = async () => {
    const box = await evaluate(`(() => { const b = document.querySelector('.diff-host').getBoundingClientRect(); return { x: b.left + b.width * 0.7, y: b.top + 60 }; })()`);
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  };
  return { app, call, evaluate, waitUntil, measure, click, shot, addRepo, scopeTo, open, hover };
}
async function stop(s) { try { s.app.cdp.close(); } catch { /* 已关闭 */ } const r = await killOris(s.app); monitor.removeOwnPid(s.app.pid); log(`实例 ${s.app.pid} 已结束：${r.how}`); return r; }

const titles = `[...document.querySelectorAll('.hunk-title')]`;
const hunkButton = (index, label) => `${titles}.find((n) => n.dataset.hunkIndex === '${index}')?.querySelector('button[data-action]') && [...${titles}.find((n) => n.dataset.hunkIndex === '${index}').querySelectorAll('button')].find((b) => b.textContent === ${q(label)})`;
const titleStates = `${titles}.map((n) => ({ index: Number(n.dataset.hunkIndex), buttons: [...n.querySelectorAll('button')].map((b) => b.textContent), note: n.querySelector('.hunk-note')?.textContent ?? null }))`;
const noticeText = `[...document.querySelectorAll('.reading-notice p')].map((n) => n.textContent).join('\\n')`;
const statusText = `(document.querySelector('.statusbar .op-status')?.textContent ?? '')`;
const readyMap = `${titles}.length > 0 && ${titles}.every((n) => !n.classList.contains('pending'))`;
const topLine = `(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller'); const box = sc.getBoundingClientRect(); const line = [...sc.querySelectorAll('.cm-line')].find((l) => l.getBoundingClientRect().top >= box.top); return line?.textContent ?? null; })()`;

// ------------------------------ 功能验收 ------------------------------
async function runFunctional({ repo, conflict }) {
  const s = await start("functional");
  const { evaluate, waitUntil, click, shot, open, hover, scopeTo } = s;
  const runOp = async (index, label, done) => {
    await click(hunkButton(index, label));
    if (label === "丢弃此块") { await waitUntil(`document.querySelector('.confirm-dialog')`); await click(`[...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent === '丢弃此块')`); }
    await waitUntil(`!document.querySelector('.op-status.running') && ${statusText}.length > 0 && (${done})`, 20000);
    await sleep(400);
  };
  try {
    await waitUntil(`document.querySelector('.project-empty')`);
    await s.addRepo(repo);
    const b17Before = snapshot(repo);

    // ---------- B17：浏览、切换文件与范围不读取块映射，仓库不变 ----------
    for (const p of ["a.txt", "crlf.txt", "tail.txt", "ws.txt"]) await open(p);
    await scopeTo("已暂存"); await scopeTo("全部"); await scopeTo("未暂存");
    await open("a.txt");
    const b17After = snapshot(repo);
    check("B17 浏览、切换文件与范围前后工作区、index 内容、refs、stash、config 不变", b17Before.index === b17After.index && ["worktree", "refs", "stash", "config"].every((k) => b17Before.fp[k] === b17After.fp[k]), { changed: Object.keys(b17Before.fp).filter((k) => b17Before.fp[k] !== b17After.fp[k]) });

    // ---------- 标题行与按需映射 ----------
    const initial = await evaluate(titleStates);
    check("块标题行：未暂存范围每块有“暂存此块 / 丢弃此块”（完整动作文字）", initial.length === 4 && initial.every((t) => t.buttons.join() === "暂存此块,丢弃此块"), initial);
    await hover();
    await waitUntil(readyMap);
    await shot("b15-hunk-titles");

    // ---------- B15 暂存相邻块（第 22 行，与第 20 行相邻），保持阅读位置 ----------
    const allHunks = bodies(diffU0(repo, false, "a.txt"));
    await evaluate(`document.querySelector('.oris-split-pane.right .cm-scroller').scrollTop = 200`);
    await sleep(500);
    const lineBefore = await evaluate(topLine);
    let before = snapshot(repo);
    await runOp(2, "暂存此块", `${statusText}.includes('已暂存') && ${titles}.length === 3`);
    let e = evidence("stage-adjacent-hunk", repo, before);
    const lineAfter = await evaluate(topLine);
    check("B15 暂存相邻块：已暂存只有目标块，未暂存少了目标块，只改 index", q(bodies(diffU0(repo, true, "a.txt"))) === q([allHunks[2]]) && q(bodies(diffU0(repo, false, "a.txt"))) === q([allHunks[0], allHunks[1], allHunks[3]]) && q(e.changedGroups) === q(["index"]), { changed: e.changedGroups });
    check("写操作后刷新保持阅读位置（右侧顶部可见行不变）", lineBefore !== null && lineAfter === lineBefore, { lineBefore, lineAfter });

    // ---------- B15 取消暂存 ----------
    await scopeTo("已暂存");
    await open("a.txt");
    await hover(); await waitUntil(readyMap);
    const staged = await evaluate(titleStates);
    before = snapshot(repo);
    await runOp(0, "取消暂存此块", `${statusText}.includes('已取消暂存')`);
    e = evidence("unstage-hunk", repo, before);
    check("B15 取消暂存此块：已暂存为空，4 块都回到未暂存，只改 index", staged.length === 1 && staged[0].buttons.join() === "取消暂存此块" && diffU0(repo, true, "a.txt") === "" && q(bodies(diffU0(repo, false, "a.txt"))) === q(allHunks) && q(e.changedGroups) === q(["index"]), { staged, changed: e.changedGroups });

    // ---------- B15 丢弃最后一块 + 撤销 ----------
    await scopeTo("未暂存");
    await open("a.txt"); await hover(); await waitUntil(readyMap);
    const aBefore = readFileSync(path.join(repo, "a.txt"));
    before = snapshot(repo);
    await runOp(3, "丢弃此块", `${statusText}.includes('已丢弃')`);
    e = evidence("discard-hunk", repo, before);
    check("B15 丢弃此块：工作区只还原目标块，index 内容不变，状态栏可撤销", q(bodies(diffU0(repo, false, "a.txt"))) === q(allHunks.slice(0, 3)) && !e.indexContentChanged && e.changedGroups.every((g) => g === "worktree" || g === "index") && (await evaluate(`!![...document.querySelectorAll('.statusbar button')].find((b) => b.textContent === '撤销丢弃')`)), { changed: e.changedGroups });
    await click(`[...document.querySelectorAll('.statusbar button')].find((b) => b.textContent === '撤销丢弃')`);
    await waitUntil(`${statusText}.includes('已撤销丢弃')`, 20000);
    check("B15 撤销丢弃：恢复丢弃前的整个文件", readFileSync(path.join(repo, "a.txt")).equals(aBefore));

    // ---------- B15 CRLF / 末尾无换行 / 非 UTF-8 ----------
    await open("crlf.txt"); await hover(); await waitUntil(readyMap);
    before = snapshot(repo);
    await runOp(1, "暂存此块", `${statusText}.includes('已暂存') && ${titles}.length === 1`);
    e = evidence("crlf-stage-hunk", repo, before);
    const crlfIndex = git(repo, ["show", ":crlf.txt"], { input: undefined });
    check("B15 CRLF：暂存一块后 index 中该行保留 CRLF，另一块仍未暂存", Buffer.from(execBytes(repo, ["show", ":crlf.txt"])).equals(Buffer.from("one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nSIX\r\nseven\r\n")) && bodies(diffU0(repo, false, "crlf.txt")).length === 1 && q(e.changedGroups) === q(["index"]), { changed: e.changedGroups, crlfIndex: crlfIndex.slice(0, 80) });
    await open("tail.txt"); await hover(); await waitUntil(readyMap);
    before = snapshot(repo);
    await runOp(1, "暂存此块", `${statusText}.includes('已暂存') && ${titles}.length === 1`);
    e = evidence("no-final-newline-stage-hunk", repo, before);
    check("B15 末尾无换行：暂存最后一块，index 仍无末尾换行", Buffer.from(execBytes(repo, ["show", ":tail.txt"])).equals(Buffer.from("a\nb\nc\nd\ne\nf\ng\nlast changed")) && q(e.changedGroups) === q(["index"]), { changed: e.changedGroups });
    await open("latin1.txt", `document.querySelector('.special-file')`);
    const latin1Card = await evaluate(`document.querySelector('.special-file')?.textContent ?? ''`);
    await click(`document.querySelector('.special-file-action')`);
    await waitUntil(`document.querySelector('.cm-editor') && ${titles}.length === 2`, 15000);
    const latin1Notice = await evaluate(noticeText);
    await hover(); await waitUntil(readyMap);
    await shot("b15-latin1");
    before = snapshot(repo);
    await runOp(1, "暂存此块", `${statusText}.includes('已暂存')`);
    e = evidence("non-utf8-stage-hunk", repo, before);
    check("B15 非 UTF-8：明确选择单字节显示后暂存一块，index 中是原始字节", latin1Card.includes("编码不受支持") && latin1Notice.includes("按单字节（Latin-1）显示") && Buffer.from(execBytes(repo, ["show", ":latin1.txt"])).equals(Buffer.from("caf\xe9 1\nplain 2\nplain 3\nplain 4\nplain 5\nplain 6\nna\xefve 7 \xae\n", "latin1")) && q(e.changedGroups) === q(["index"]), { changed: e.changedGroups, latin1Notice });

    // ---------- B15 显示后被外部修改：拒绝执行并刷新 ----------
    await open("a.txt"); await hover(); await waitUntil(readyMap);
    write(repo, "a.txt", readFileSync(path.join(repo, "a.txt"), "utf8").replace("line 10\n", "line 10 external\n"));
    before = snapshot(repo);
    await click(hunkButton(0, "暂存此块"));
    await waitUntil(`!document.querySelector('.op-status.running') && /显示之后已被修改|没有找到与显示一致|--check/.test(${statusText})`, 20000);
    const rejected = await evaluate(statusText);
    await waitUntil(`window.__op.editorText().includes('line 10 external')`, 15000);
    e = evidence("modified-after-display-rejected", repo, before);
    check("B15 显示后被外部修改：拒绝执行、说明原因并刷新到新内容，git diff / --cached 与 index 内容不变", e.gitDiffBefore === e.gitDiffAfter && e.gitDiffCachedBefore === e.gitDiffCachedAfter && !e.indexContentChanged, { rejected, changed: e.changedGroups });
    await shot("b15-rejected");

    // ---------- 禁用条件与说明 ----------
    const reasons = {};
    await evaluate(`window.__op.setSelect('空白规则', 'ignore')`);
    await open("ws.txt");
    reasons.ignoreWhitespace = { notice: await evaluate(noticeText), titles: await evaluate(`${titles}.length`) };
    await evaluate(`window.__op.setSelect('空白规则', 'keep')`);
    await open("bin.dat", `document.querySelector('.special-file')`);
    reasons.binary = { notice: await evaluate(noticeText), titles: await evaluate(`${titles}.length`) };
    await open("big.txt", `document.querySelector('.special-file')`);
    reasons.overBudget = { notice: await evaluate(noticeText), titles: await evaluate(`${titles}.length`) };
    await scopeTo("全部");
    await open("a.txt");
    reasons.allScope = { notice: await evaluate(noticeText), titles: await evaluate(`${titles}.length`) };
    await scopeTo("已暂存");
    await open("tool.sh"); await hover();
    await waitUntil(`/只有文件模式变化/.test(${noticeText})`, 10000).catch(() => {});
    reasons.modeOnly = { notice: await evaluate(noticeText), titles: await evaluate(`${titles}.length`) };
    await scopeTo("未暂存");
    check("B15 禁用条件：忽略空白、二进制、超出内容预算、“全部”范围、仅 mode 变化都不显示块操作并给出说明",
      reasons.ignoreWhitespace.notice.includes("忽略空白模式下不提供块操作") && reasons.ignoreWhitespace.titles === 0 &&
      reasons.binary.notice.includes("不提供块操作") && reasons.binary.titles === 0 &&
      reasons.overBudget.notice.includes("不提供块操作") && reasons.overBudget.titles === 0 &&
      reasons.allScope.notice.includes("“全部”范围") && reasons.allScope.titles === 0 &&
      reasons.modeOnly.notice.includes("只有文件模式变化") && reasons.modeOnly.titles === 0, reasons);

    // 冲突
    await s.addRepo(conflict);
    await open("c.txt");
    const conflictNotice = await evaluate(noticeText);
    check("B15 禁用条件：冲突文件不提供块操作并说明", conflictNotice.includes("冲突文件不提供块操作") && (await evaluate(`${titles}.length`)) === 0, conflictNotice);
    await evaluate(`window.__op.projectTab(${q(repo)}).querySelector('.project-switch').click()`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`);

    // ---------- B16：外部 index.lock ----------
    await open("a.txt"); await hover(); await waitUntil(readyMap);
    writeFileSync(path.join(repo, ".git", "index.lock"), "");
    before = snapshot(repo);
    await click(hunkButton(0, "暂存此块"));
    await waitUntil(`!document.querySelector('.op-status.running') && /index\\.lock|锁/.test(${statusText})`, 15000);
    const lockStatus = await evaluate(statusText);
    const lockLeft = existsSync(path.join(repo, ".git", "index.lock"));
    e = evidence("external-index-lock", repo, before);
    unlinkSync(path.join(repo, ".git", "index.lock"));
    check("B16 外部 index.lock：块操作报错说明原因、不删除锁、仓库不变、不重试", lockLeft && e.changedGroups.length === 0 && e.gitDiffBefore === e.gitDiffAfter, { lockStatus, changed: e.changedGroups });
  } catch (error) {
    report.functionalError = String(error.stack ?? error);
    fail(`功能验收脚本异常：${error.message}`);
    try { await shot("functional-failure"); } catch { /* ignore */ }
  } finally {
    report.functionalStop = await stop(s);
  }
}

function execBytes(repo, argv) { return git(repo, argv, { input: Buffer.alloc(0) }); }

// ------------------------------ 时延与 Git 进程数 ------------------------------
async function runPerf({ repo }) {
  const traceDir = path.join(runDir, "trace2");
  mkdirSync(traceDir, { recursive: true });
  const s = await start("perf", { GIT_TRACE2_EVENT: traceDir });
  const { evaluate, waitUntil, measure, click, open, hover, scopeTo } = s;
  const traces = () => new Set(readdirSync(traceDir));
  const commands = (names) => [...names].map((name) => { try { const first = readFileSync(path.join(traceDir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.event === "start"); return (first?.argv ?? []).slice(1).filter((a) => !a.startsWith("-c") && !/^core\.|^diff\.|^color\./.test(a) && a !== "--no-optional-locks").slice(0, 3).join(" "); } catch { return "?"; } });
  try {
    await waitUntil(`document.querySelector('.project-empty')`);
    await s.addRepo(repo);
    // CodeMirror 只渲染视口内的块标题：块总数取工具栏“x / N”，操作对象取视口内第一个可用按钮，没有时跳到下一处差异。
    const totalExpr = `Number((document.querySelector('.diff-position')?.textContent ?? '0 / 0').split('/')[1] ?? 0)`;
    const firstButton = (label) => `[...document.querySelectorAll('.hunk-title button')].find((b) => b.textContent === ${q(label)} && !b.disabled && b.getBoundingClientRect().bottom > 0)`;
    const prepare = async (label) => {
      for (let k = 0; k < 6 && !(await evaluate(`!!${firstButton(label)}`)); k++) {
        await click(`document.querySelector('button[aria-label="下一处差异"]')`);
        await sleep(400);
      }
      await hover();
      await waitUntil(`!document.querySelector('.hunk-title.pending')`, 10000).catch(() => {});
    };
    const cycle = async (label, expected) => {
      await prepare(label);
      const beforeTraces = traces();
      const running = await measure(`${firstButton(label)}.click()`, `document.querySelector('.op-status.running')`, 10000);
      const confirmed = await evaluate(`window.__op.waitUntil(() => !document.querySelector('.op-status.running') && ${totalExpr} === ${expected}, 20000)`, 25000);
      await sleep(1500);
      const added = [...traces()].filter((n) => !beforeTraces.has(n));
      return { feedbackMs: running.ok ? running.ms : null, confirmMs: confirmed.ok ? running.ms + confirmed.ms : null, ok: running.ok && confirmed.ok, gitProcesses: added.length, commands: commands(added) };
    };
    const measureAction = async (label, scopeLabel) => {
      await scopeTo(scopeLabel);
      await open("many.txt");
      const total = await evaluate(totalExpr);
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const r = await cycle(label, total - i - 1);
        samples.push({ i, ...r, ms: r.confirmMs });
        await sleep(300);
      }
      return { total, samples };
    };
    report.perf.hunkStage = await measuredSegment(monitor, "暂存此块", async () => {
      const { total, samples } = await measureAction("暂存此块", "未暂存");
      return { what: `many.txt（${total} 块）逐块暂存：点击到状态栏“正在…”（反馈）与到工具栏块数减一（Git 确认并刷新）`, reference: "stage 单文件：乐观反馈 ≤ 50 ms / Git 确认 P95 ≤ 500 ms（只作参照）", feedback: summarize(samples.map((x) => ({ ok: x.feedbackMs !== null, ms: x.feedbackMs }))), confirm: summarize(samples), samples };
    }, { log });
    log("暂存此块", report.perf.hunkStage.result.feedback, report.perf.hunkStage.result.confirm);
    report.perf.hunkUnstage = await measuredSegment(monitor, "取消暂存此块", async () => {
      const { samples } = await measureAction("取消暂存此块", "已暂存");
      return { what: "已暂存的块逐块取消暂存", feedback: summarize(samples.map((x) => ({ ok: x.feedbackMs !== null, ms: x.feedbackMs }))), confirm: summarize(samples), samples };
    }, { log });
    log("取消暂存此块", report.perf.hunkUnstage.result.feedback, report.perf.hunkUnstage.result.confirm);
    // 丢弃：每次都要确认，测点击“确认”到工具栏块数减一
    await scopeTo("未暂存"); await open("many.txt");
    report.perf.hunkDiscard = await measuredSegment(monitor, "丢弃此块", async () => {
      const samples = [];
      const start = await evaluate(totalExpr);
      for (let i = 0; i < Math.min(iterations, start); i++) {
        await prepare("丢弃此块");
        await click(firstButton("丢弃此块"));
        await waitUntil(`document.querySelector('.confirm-dialog')`);
        const beforeTraces = traces();
        const running = await measure(`[...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent === '丢弃此块').click()`, `document.querySelector('.op-status.running')`, 10000);
        const confirmed = await evaluate(`window.__op.waitUntil(() => !document.querySelector('.op-status.running') && ${totalExpr} === ${start - i - 1}, 20000)`, 25000);
        await sleep(1500);
        const added = [...traces()].filter((n) => !beforeTraces.has(n));
        samples.push({ i, ok: running.ok && confirmed.ok, ms: running.ms + confirmed.ms, feedbackMs: running.ms, gitProcesses: added.length, commands: commands(added) });
        await sleep(300);
      }
      return { what: "确认丢弃到工具栏块数减一（含整文件备份 hash-object）", feedback: summarize(samples.map((x) => ({ ok: x.ok, ms: x.feedbackMs }))), confirm: summarize(samples), samples };
    }, { log });
    log("丢弃此块", report.perf.hunkDiscard.result.feedback, report.perf.hunkDiscard.result.confirm);
    const processes = (segment) => { const counts = segment.result.samples.map((x) => x.gitProcesses); return { min: Math.min(...counts), max: Math.max(...counts), typical: counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)], commands: segment.result.samples[1]?.commands }; };
    report.perf.gitProcesses = { hunkStage: processes(report.perf.hunkStage), hunkUnstage: processes(report.perf.hunkUnstage), hunkDiscard: processes(report.perf.hunkDiscard), note: "每次操作后 1.5 s 内新增的 Git 进程（GIT_TRACE2_EVENT），含按需读取块映射的 git diff、apply --check、apply、刷新 status 等" };
    log("Git 进程数", report.perf.gitProcesses);
  } catch (error) {
    report.perfError = String(error.stack ?? error);
    fail(`时延测量脚本异常：${error.message}`);
  } finally {
    report.perfStop = await stop(s);
  }
}

try {
  if (only.has("functional")) await runFunctional(prepareRepo("functional"));
  if (only.has("perf")) await runPerf(prepareRepo("perf"));
} finally {
  report.load = monitor.summary(Date.parse(report.startedAt), Date.now());
  report.loadSamples = monitor.samples;
  monitor.stop();
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  log(`检查 ${Object.keys(report.checks).length} 项，失败 ${report.failures.length} 项；报告 ${path.join(outDir, "report.json")}`);
  removeDir(runDir, GUI_ROOT);
}
