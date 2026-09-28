// V2-D60：写操作后历史页后台重读的定位与修复前后对比（只记录，不计时）。
// 场景：历史页打开过一次后切回“提交”页，依次执行 fetch、pull（仅快进）、merge（快进）、push、切换分支、提交；
// stash push / pop 的入口在历史页左侧，只能在历史页可见时执行（单独标注）。
// 每个操作记录：GIT_TRACE2_EVENT 统计的 Git 进程数与命令（点击 → 成功后 1.5 s 内）；CDP Network 记录的
// 只读 IPC（read_refs / read_log / commit_changes / stash_list 等）与 repository-invalidated 事件，据此归因每一次历史重读。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris：PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API。
// 用法：node scripts/perf/v2-d60-history-reread.mjs --exe <oris.exe> [--iterations 3] [--port 9871] [--label v2-d60-before]
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git, prepareCoreRepos } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, machineInfo, removeDir, sha256File, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const port = Number(option("port", 9871));
const iterations = Number(option("iterations", 3));
const label = option("label", "v2-d60");
// --history-visible：写操作期间历史页保持可见（提交需要“提交”页，提交后回到历史页）。
const historyVisible = args.includes("--history-visible");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v2-d60-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), machine: machineInfo(), startedAt: new Date().toISOString(), iterations, method: "CDP 页面事件；Git 进程为 GIT_TRACE2_EVENT 文件数（点击 → 成功后 1.5 s 内）", ops: {}, historyVisibleMode: historyVisible, failures: [] };

const cfg = (repo) => { for (const [k, v] of [["user.name", "Oris Perf"], ["user.email", "oris-perf@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["pull.rebase", "false"]]) git(repo, ["config", k, v]); };
const put = (repo, rel, text) => { const full = path.join(repo, rel); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, text); };
const commit = (repo, message) => { git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", message]); return git(repo, ["rev-parse", "HEAD"]); };

// ---------- 夹具（与 v1-06-write-latency 相同）----------
const [s1] = await prepareCoreRepos(path.join(runDir, "repos"), 1);
const repo = s1.path;
cfg(repo);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "fixture: commit dataset changes"]);
const bare = path.join(runDir, "remote.git");
git(runDir, ["clone", "-q", "--bare", repo, bare]);
git(repo, ["remote", "add", "origin", bare]);
git(repo, ["fetch", "-q", "origin"]);
git(repo, ["branch", "-q", "-u", "origin/main"]);
const other = path.join(runDir, "other");
git(runDir, ["clone", "-q", bare, other]); cfg(other);
git(repo, ["switch", "-q", "-c", "perf-alt"]);
for (let i = 0; i < 20; i++) put(repo, `tracked/${String(9000 + i).padStart(6, "0")}.txt`, `alt ${i}\n`);
commit(repo, "perf-alt: 20 files");
git(repo, ["switch", "-q", "main"]);
report.fixture = { dataset: "S1（generate-datasets.mjs S，seed 20260923）", repo, bare, other };

const H = String.raw`
(() => {
  if (window.__w) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const setValue = (el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
  window.__w = {
    button(text, root = document) { return qa('button', root).find((b) => b.textContent === text) ?? null; },
    running() { return !!document.querySelector('.op-status.running'); },
    succeeded() { return !!document.querySelector('.op-status.succeeded'); },
    status() { return document.querySelector('.op-status')?.textContent ?? ''; },
    counts() { return document.querySelector('.branch-counts')?.textContent ?? ''; },
    revision() { return /revision (\w+)/.exec(document.querySelector('.diff-footer')?.textContent ?? '')?.[1] ?? null; },
    branchLabel() { return document.querySelector('.branch-button')?.textContent ?? ''; },
    branchRow(name) { return qa('.branch-row').find((r) => r.querySelector('.branch-row-name')?.textContent.replace(/^● /, '') === name) ?? null; },
    rowButton(name, text) { const row = window.__w.branchRow(name); return row ? qa('button', row).find((b) => b.textContent === text) ?? null : null; },
    gitTab(prefix) { return qa('.git-tabs button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    stashRow(i) { return qa('.log-stash')[i] ?? null; },
    stashCount() { return qa('.log-stash').length; },
    setIn(root, selector, value) { const el = root.querySelector(selector); if (!el) throw new Error('没有 ' + selector); setValue(el, value); },
    arm() { window.__sawRun = false; },
    done(extra) { window.__sawRun = window.__sawRun || !!document.querySelector('.op-status.running'); return window.__sawRun && !window.__w.running() && window.__w.succeeded() && !window.__op.loading() && extra(); }
  };
  return true;
})()`;

// 记录：只读 IPC 用 CDP Network 域（Tauri 2 在 Windows 上经 http://ipc.localhost/<命令> 发送，initiator 自带发起调用栈），
// repository-invalidated 事件在页面内自行订阅（不修改应用代码）。时间统一为 epoch 毫秒。
const RECORDER = String.raw`
(() => {
  if (window.__rr) return true;
  const I = window.__TAURI_INTERNALS__;
  const entries = [];
  const handler = I.transformCallback((event) => entries.push({ t: performance.timeOrigin + performance.now(), kind: 'event', payload: event.payload }));
  I.invoke('plugin:event|listen', { event: 'repository-invalidated', target: { kind: 'Any' }, handler });
  window.__rr = { take() { return entries.splice(0); } };
  return true;
})()`;
const network = [];
const pendingOps = new Map();
let clockOffset = null;
const frameText = (stack) => { const frames = []; for (let s = stack; s && frames.length < 6; s = s.parent) for (const f of s.callFrames ?? []) if (frames.length < 6) frames.push(`${f.functionName || "(匿名)"}@${f.lineNumber + 1}:${f.columnNumber + 1}`); return frames.join(" < "); };
const traceDir = path.join(runDir, "trace2");
mkdirSync(traceDir, { recursive: true });
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache"), GIT_TRACE2_EVENT: traceDir } });
const { call, evaluate } = app.cdp;
await call("Runtime.enable"); await call("Page.enable");
app.cdp.on("Network.requestWillBeSent", (p) => {
  const m = /^https?:\/\/ipc\.localhost\/([^?#]+)/.exec(p.request.url);
  if (!m || p.request.method === "OPTIONS") return;
  const cmd = decodeURIComponent(m[1]);
  if (cmd.startsWith("plugin")) return;
  clockOffset = p.wallTime * 1000 - p.timestamp * 1000;
  network.push({ t: p.wallTime * 1000, kind: "invoke", cmd, stack: frameText(p.initiator?.stack) });
  if (cmd === "run_operation") pendingOps.set(p.requestId, true);
});
app.cdp.on("Network.loadingFinished", (p) => { if (pendingOps.delete(p.requestId) && clockOffset !== null) network.push({ t: p.timestamp * 1000 + clockOffset, kind: "opDone", op: "run_operation" }); });
await call("Network.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(PAGE_HELPERS); await evaluate(H);
report.recorderInstalled = await evaluate(RECORDER);
log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
report.identity = app.identity;
const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
const click = async (expr) => { await evaluate(`(() => { const el = ${expr}; if (!el) throw new Error('找不到元素：' + ${q(expr)}); if (el.disabled) throw new Error('元素不可用：' + ${q(expr)} + ' ' + el.title); el.click(); return true; })()`); await sleep(150); };
const settle = (timeout = 60000) => waitUntil(`!window.__w.running() && !window.__op.loading()`, timeout);
const refresh = async () => { await evaluate(`window.__op.button('↻ 本地刷新').click()`); await sleep(300); await settle(); await sleep(800); };
const traces = () => new Set(readdirSync(traceDir));
const commandOf = (name) => { try { const first = readFileSync(path.join(traceDir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.event === "start"); const argv = (first?.argv ?? []).slice(1); const out = []; for (let k = 0; k < argv.length; k++) { if (argv[k] === "-c" || argv[k] === "-C") { k++; continue; } if (argv[k] === "--no-optional-locks") continue; out.push(argv[k]); } return out.slice(0, 2).join(" "); } catch { return "?"; } };
const HISTORY_READS = new Set(["read_refs", "read_log", "commit_changes", "stash_list", "stash_changes"]);

/** 把一次操作窗口内的页面记录整理为：历史重读次数与每次的触发来源。 */
function analyze(entries) {
  const reads = entries.filter((e) => e.kind === "invoke" && HISTORY_READS.has(e.cmd));
  const logs = reads.filter((e) => e.cmd === "read_log");
  const triggers = logs.map((entry) => {
    // 最近一个先于本次读取的触发点：操作完成（runOp 递增 refsVersion）或 watcher 事件。
    const before = entries.filter((e) => (e.kind === "opDone" || e.kind === "event") && e.t <= entry.t + 1).at(-1);
    if (!before) return "未知（窗口内没有先行触发点）";
    if (before.kind === "opDone") return `操作完成（run_operation 返回 ${Math.round(entry.t - before.t)} ms 后）`;
    const p = before.payload ?? {};
    return `watcher 事件 kinds=${(p.kinds ?? []).join("+") || "（无）"}${p.global ? " global" : ""}（${Math.round(entry.t - before.t)} ms 后）`;
  });
  const byCmd = {};
  for (const e of reads) byCmd[e.cmd] = (byCmd[e.cmd] ?? 0) + 1;
  return {
    historyRereads: logs.length,
    triggers,
    readCounts: byCmd,
    events: entries.filter((e) => e.kind === "event").map((e) => ({ kinds: e.payload?.kinds, global: e.payload?.global, paths: (e.payload?.paths ?? []).length })),
    timeline: entries.map((e) => `${Math.round(e.t - (entries[0]?.t ?? 0))} ${e.kind === "invoke" ? e.cmd : e.kind === "event" ? `event ${(e.payload?.kinds ?? []).join("+")}${e.payload?.global ? " global" : ""} paths=${(e.payload?.paths ?? []).length}` : e.kind}`)
  };
}

async function probe(name, expr, extra, { historyVisible = false } = {}) {
  await evaluate(`window.__rr.take()`); network.length = 0;
  const before = traces();
  const r = await evaluate(`window.__op.measure(() => { window.__w.arm(); const el = ${expr}; if (!el) throw new Error('找不到 ' + ${q(expr)}); if (el.disabled) throw new Error('不可用 ' + el.title); el.click(); }, () => window.__w.done(() => (${extra})), 60000)`, 65000);
  if (!r.ok) { report.failures.push(`${name}：${q(r).slice(0, 300)} 状态 ${await evaluate(`window.__w.status()`)}`); log("✗", name, r); }
  await sleep(1500);
  const added = [...traces()].filter((f) => !before.has(f));
  const commands = {};
  for (const c of added.map(commandOf)) commands[c] = (commands[c] ?? 0) + 1;
  const page = analyze([...network.splice(0), ...(await evaluate(`window.__rr.take()`))].sort((a, b) => a.t - b.t));
  const entry = (report.ops[name] ??= { historyVisible, samples: [] });
  entry.samples.push({ ok: r.ok, gitProcesses: added.length, commands, ...page });
  log(name, `Git 进程 ${added.length}，历史重读 ${page.historyRereads}`, page.triggers.join("；"));
  await settle();
  await sleep(400);
}

/** 切回历史页：统计切换后 1.5 s 内的 Git 进程与历史读取（修复后，不可见期间的失效在这里补读一次）。 */
async function probeTab(name) {
  await evaluate(`window.__rr.take()`); network.length = 0;
  const before = traces();
  await click(`window.__w.gitTab('历史')`);
  await sleep(1500);
  const added = [...traces()].filter((f) => !before.has(f));
  const commands = {};
  for (const c of added.map(commandOf)) commands[c] = (commands[c] ?? 0) + 1;
  const page = analyze([...network.splice(0), ...(await evaluate(`window.__rr.take()`))].sort((a, b) => a.t - b.t));
  (report.ops[name] ??= { historyVisible: true, samples: [] }).samples.push({ ok: true, gitProcesses: added.length, commands, ...page });
  log(name, `Git 进程 ${added.length}，历史读取 ${page.historyRereads}`);
}

const openSync = async () => { if (!(await evaluate(`!!document.querySelector('.sync-popover')`))) await click(`document.querySelector('.sync-button')`); await waitUntil(`(document.querySelector('.sync-popover')?.textContent ?? '').includes('获取远端状态') && !document.querySelector('.sync-popover').textContent.includes('正在读取')`); };
const syncDialog = async (text, cls) => { await openSync(); await click(`window.__w.button(${q(text)}, document.querySelector('.sync-popover'))`); await waitUntil(`!!document.querySelector(${q(cls)}) && !document.querySelector(${q(cls)}).textContent.includes('正在读取')`); };
const openBranches = async () => { if (!(await evaluate(`!!document.querySelector('.branch-popover:not(.sync-popover)')`))) await click(`document.querySelector('.branch-button')`); await waitUntil(`document.querySelectorAll('.branch-row').length > 0`); };
const openTab = async (prefix) => { if (!(await evaluate(`window.__w.gitTab(${q(prefix)})?.classList.contains('active')`))) await click(`window.__w.gitTab(${q(prefix)})`); await sleep(300); };

try {
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 60000);
  await settle();
  // 历史页打开过一次，再切回“提交”页（V2-D60 的触发条件）。
  await openTab("历史");
  await waitUntil(`document.querySelectorAll('.log-row').length > 0`, 30000);
  await sleep(800);
  if (!historyVisible) await openTab("提交");
  await sleep(1500);
  const V = { historyVisible };
  const home = async () => { if (historyVisible) await openTab("历史"); else await openTab("提交"); };
  for (let i = 0; i < iterations; i++) {
    const tag = `${i}`;
    git(other, ["pull", "-q", "--ff-only"]);
    put(other, `remote/r-${tag}.txt`, `remote ${tag}\n`); commit(other, `remote ${tag}`); git(other, ["push", "-q", "origin", "main"]);
    await syncDialog("获取…", ".fetch-dialog");
    await probe("fetch", `window.__w.button('获取', document.querySelector('.fetch-dialog'))`, `window.__w.counts().includes('↓1')`, V);
    let rev = await evaluate(`window.__w.revision()`);
    await syncDialog("选项…", ".pull-dialog");
    await probe("pull（仅快进）", `window.__w.button('拉取', document.querySelector('.pull-dialog'))`, `window.__w.counts().includes('↑0 ↓0') && window.__w.revision() !== ${q(rev)}`, V);
    git(repo, ["switch", "-q", "-c", `topic-${tag}`]); put(repo, `topic/t-${tag}.txt`, `topic ${tag}\n`); commit(repo, `topic ${tag}`); git(repo, ["switch", "-q", "main"]);
    await refresh();
    rev = await evaluate(`window.__w.revision()`);
    await openBranches();
    await click(`window.__w.rowButton(${q(`topic-${tag}`)}, '更多 ▾')`);
    await click(`window.__w.button('合并到当前分支…')`);
    await waitUntil(`!!document.querySelector('.merge-dialog')`);
    await probe("merge（快进）", `window.__w.button('合并', document.querySelector('.merge-dialog'))`, `window.__w.counts().includes('↑1') && window.__w.revision() !== ${q(rev)}`, V);
    await syncDialog("预览…", ".push-dialog");
    await probe("push", `window.__w.button('推送', document.querySelector('.push-dialog'))`, `window.__w.counts().includes('↑0 ↓0')`, V);
    for (const target of ["perf-alt", "main"]) {
      await openBranches();
      await probe("切换分支", `window.__w.rowButton(${q(target)}, '切换')`, `window.__w.branchLabel().includes(${q(target)})`, V);
    }
    // 提交：在终端暂存一个改动（不计入），界面中提交。
    const crel = `commit/c-${tag}.txt`;
    put(repo, crel, `commit ${tag}\n`); git(repo, ["add", "--", crel]);
    await refresh();
    await openTab("提交");
    // 终端暂存的改动在界面中出现后再提交。
    await waitUntil(`!(window.__w.gitTab('提交')?.textContent ?? '').endsWith('· 0')`, 20000);
    await evaluate(`(() => { const box = document.querySelector('input[aria-label="提交并推送"]'); if (box?.checked) box.click(); return true; })()`);
    await evaluate(`window.__w.setIn(document, 'textarea[aria-label="提交信息"]', 'v2-d60 commit ${tag}')`);
    rev = await evaluate(`window.__w.revision()`);
    await probe("提交", `window.__w.button('提交', document.querySelector('.commit-editor')?.parentElement ?? document)`, `window.__w.revision() !== ${q(rev)}`);
    // 推送到远端（终端，不计入），避免下一轮远端新提交与本地提交分叉。
    git(repo, ["push", "-q", "origin", "main"]);
    await refresh();
    await home();
    // stash push / pop：入口在历史页左侧（历史页可见）。
    const rel = `tracked/${String(100 + i).padStart(6, "0")}.txt`;
    put(repo, rel, `stash probe ${i}\n`);
    await refresh();
    await waitUntil(`!!window.__op.row(${q(rel)})`, 20000);
    if (historyVisible) await openTab("历史"); else await probeTab("切回历史页（此前 7 个写操作在“提交”页执行）");
    await waitUntil(`!!window.__w.button('储藏…')`, 20000);
    await click(`window.__w.button('储藏…')`);
    await waitUntil(`!!document.querySelector('.stash-form')`);
    await evaluate(`window.__w.setIn(document.querySelector('.stash-form'), 'input[aria-label="stash 说明"]', 'v2-d60 ${tag}')`);
    await probe("stash push（历史页可见）", `window.__w.button('储藏', document.querySelector('.stash-form'))`, `!window.__op.row(${q(rel)})`, { historyVisible: true });
    await waitUntil(`window.__w.stashCount() > 0`, 20000);
    await click(`window.__w.stashRow(0)`);
    await waitUntil(`!!document.querySelector('.stash-detail') && !!window.__w.button('弹出', document.querySelector('.stash-detail'))`, 20000);
    await probe("stash pop（历史页可见）", `window.__w.button('弹出', document.querySelector('.stash-detail'))`, `window.__w.stashCount() === 0`, { historyVisible: true });
    if (await evaluate(`!!window.__w.button('← 返回本地变化')`)) await click(`window.__w.button('← 返回本地变化')`);
    git(repo, ["checkout", "-q", "--", rel]);
    await home();
    await refresh();
    log(`第 ${i + 1}/${iterations} 轮完成`);
  }
  report.summary = Object.fromEntries(Object.entries(report.ops).map(([name, entry]) => {
    const g = entry.samples.map((s) => s.gitProcesses), h = entry.samples.map((s) => s.historyRereads);
    return [name, { historyVisible: entry.historyVisible, gitProcesses: [Math.min(...g), Math.max(...g)], historyRereads: [Math.min(...h), Math.max(...h)] }];
  }));
  for (const [name, s] of Object.entries(report.summary)) log(name, q(s));
} catch (error) {
  report.failures.push(`异常：${String(error.stack ?? error).slice(0, 800)}`);
  log("异常", error);
} finally {
  try { app.cdp.close(); } catch { /* 已关闭 */ }
  report.stop = await killOris(app);
  report.finishedAt = new Date().toISOString();
  const file = path.join(outDir, "history-reread.json");
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`报告：${file}；失败 ${report.failures.length}`);
  if (!args.includes("--keep")) { await sleep(1000); removeDir(runDir, GUI_ROOT); }
  process.exitCode = report.failures.length ? 1 : 0;
}
