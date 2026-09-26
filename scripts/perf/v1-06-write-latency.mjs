// 一期 06 发布性能测试：没有预先预算的写操作（fetch、pull、merge、push、切换分支、stash push / pop）的时延与 Git 进程数，只记录。
// S 数据集（prepareCoreRepos 的 S1 副本）+ 本地 bare remote + 另一个克隆（制造远端提交）；网络操作走本地文件路径，不联网。
// 计时：点击最后一个按钮 → 操作状态经过“进行中”后变为成功、界面刷新完成（且满足每个操作自己的结束条件）的下一帧。
// --trace：设置 GIT_TRACE2_EVENT，按操作统计启动的 Git 进程数（trace 会增加开销，计时以不带 --trace 的运行为准）。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API。
// 用法：node scripts/perf/v1-06-write-latency.mjs --exe <oris.exe> [--iterations 30] [--trace] [--port 9861] [--label perf-write]
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git, prepareCoreRepos } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, machineInfo, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";
import { measuredSegment, startLoadMonitor } from "./load-monitor.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
let port = Number(option("port", 9861));
const iterations = Number(option("iterations", 30));
const trace = args.includes("--trace");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "perf-write"));
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-06-write-latency-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), machine: machineInfo(), startedAt: new Date().toISOString(), iterations, trace, method: "CDP 页面事件；计时到操作成功且界面刷新后的下一帧", timings: {}, processes: {}, commands: {}, failures: [] };

const cfg = (repo) => { for (const [k, v] of [["user.name", "Oris Perf"], ["user.email", "oris-perf@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["pull.rebase", "false"]]) git(repo, ["config", k, v]); };
const put = (repo, rel, text) => { const full = path.join(repo, rel); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, text); };
const commit = (repo, message) => { git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", message]); return git(repo, ["rev-parse", "HEAD"]); };

// ---------- 夹具 ----------
const [s1] = await prepareCoreRepos(path.join(runDir, "repos"), 1);
const repo = s1.path;
cfg(repo);
// 数据集中用 update-index 构造的冲突条目会阻止分支切换 / 合并：先在夹具中解决并提交全部数据集改动（不计入测量）。
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "fixture: commit dataset changes"]);
const bare = path.join(runDir, "remote.git");
git(runDir, ["clone", "-q", "--bare", repo, bare]);
git(repo, ["remote", "add", "origin", bare]);
git(repo, ["fetch", "-q", "origin"]);
git(repo, ["branch", "-q", "-u", "origin/main"]);
const other = path.join(runDir, "other");
git(runDir, ["clone", "-q", bare, other]); cfg(other);
// 切换分支的另一端：改动 20 个已跟踪文件
git(repo, ["switch", "-q", "-c", "perf-alt"]);
for (let i = 0; i < 20; i++) put(repo, `tracked/${String(9000 + i).padStart(6, "0")}.txt`, `alt ${i}\n`);
commit(repo, "perf-alt: 20 files");
git(repo, ["switch", "-q", "main"]);
report.fixture = { dataset: "S1（generate-datasets.mjs S，seed 20260923）", repo, bare, other, trackedFiles: s1.manifest.tracked, commits: s1.manifest.commits };

const H = String.raw`
(() => {
  if (window.__w) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const setValue = (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
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
    /** 点击前复位：只有观察到“进行中”之后的成功状态才算本次操作完成。 */
    arm() { window.__sawRun = false; },
    done(extra) { window.__sawRun = window.__sawRun || !!document.querySelector('.op-status.running'); return window.__sawRun && !window.__w.running() && window.__w.succeeded() && !window.__op.loading() && extra(); }
  };
  return true;
})()`;

const traceDir = path.join(runDir, "trace2");
mkdirSync(traceDir, { recursive: true });
const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache"), ...(trace ? { GIT_TRACE2_EVENT: traceDir } : {}) } });
const { call, evaluate } = app.cdp;
await call("Runtime.enable"); await call("Page.enable");
await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS + ";" + H });
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(PAGE_HELPERS); await evaluate(H);
log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
report.identity = app.identity;
const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
const click = async (expr) => { await evaluate(`(() => { const el = ${expr}; if (!el) throw new Error('找不到元素：' + ${q(expr)}); if (el.disabled) throw new Error('元素不可用：' + ${q(expr)} + ' ' + el.title); el.click(); return true; })()`); await sleep(150); };
const settle = (timeout = 60000) => waitUntil(`!window.__w.running() && !window.__op.loading()`, timeout);
const refresh = async () => { await evaluate(`window.__op.button('↻ 本地刷新').click()`); await sleep(300); await settle(); await sleep(500); };
const traces = () => new Set(readdirSync(traceDir));
/** trace2 文件中第一个 start 事件的 argv（去掉 -c / -C 等全局参数），用于说明每次操作启动了哪些 Git 命令。 */
const commandOf = (name) => { try { const first = readFileSync(path.join(traceDir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.event === "start"); const argv = (first?.argv ?? []).slice(1); const out = []; for (let k = 0; k < argv.length; k++) { if (argv[k] === "-c" || argv[k] === "-C") { k++; continue; } if (argv[k] === "--no-optional-locks") continue; out.push(argv[k]); } return out.slice(0, 3).join(" "); } catch { return "?"; } };
let samples = {};
/** 点击 expr（最后一个按钮）并计时到 done(extra)；--trace 时统计本次启动的 Git 进程（含其后 1.5 s 内的后台补齐）。 */
async function timed(name, expr, extra, timeout = 60000) {
  const before = trace ? traces() : null;
  const r = await evaluate(`window.__op.measure(() => { window.__w.arm(); const el = ${expr}; if (!el) throw new Error('找不到 ' + ${q(expr)}); if (el.disabled) throw new Error('不可用 ' + el.title); el.click(); }, () => window.__w.done(() => (${extra})), ${timeout})`, timeout + 5000);
  if (!r.ok) { report.failures.push(`${name}：${q(r).slice(0, 300)} 状态 ${await evaluate(`window.__w.status()`)}`); log("✗", name, r); }
  (samples[name] ??= []).push(r);
  if (trace) { await sleep(1500); const added = [...traces()].filter((f) => !before.has(f)); (report.processes[name] ??= []).push(added.length); (report.commands[name] ??= []).push(added.map(commandOf).sort()); }
  await settle();
  await sleep(400);
  return r;
}
const openSync = async () => { if (!(await evaluate(`!!document.querySelector('.sync-popover')`))) await click(`document.querySelector('.sync-button')`); await waitUntil(`(document.querySelector('.sync-popover')?.textContent ?? '').includes('获取远端状态') && !document.querySelector('.sync-popover').textContent.includes('正在读取')`); };
const syncDialog = async (label, cls) => { await openSync(); await click(`window.__w.button(${q(label)}, document.querySelector('.sync-popover'))`); await waitUntil(`!!document.querySelector(${q(cls)}) && !document.querySelector(${q(cls)}).textContent.includes('正在读取')`); };
const openBranches = async () => { if (!(await evaluate(`!!document.querySelector('.branch-popover:not(.sync-popover)')`))) await click(`document.querySelector('.branch-button')`); await waitUntil(`document.querySelectorAll('.branch-row').length > 0`); };
const openTab = async (prefix) => { if (!(await evaluate(`window.__w.gitTab(${q(prefix)})?.classList.contains('active')`))) await click(`window.__w.gitTab(${q(prefix)})`); await sleep(300); };

const monitor = startLoadMonitor({ log });
monitor.addOwnPid(app.pid);
const allSamples = {};
const rounds = [];
try {
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 60000);
  await settle();
  await sleep(1500);
  const segmentStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    // 每一轮在负载监测下运行：受外部负载干扰时丢弃该轮样本并重测，最多 2 次。
    const seg = await measuredSegment(monitor, `第 ${i + 1} 轮`, async (attempt) => { samples = {}; await round(`${i}-${attempt}`, i); return samples; }, { log });
    rounds.push({ i, verdict: seg.verdict, attempts: seg.attempts });
    for (const [name, list] of Object.entries(seg.result)) (allSamples[name] ??= []).push(...list.map((s) => ({ ...s, round: i, verdict: seg.verdict })));
    log(`第 ${i + 1}/${iterations} 轮完成（${seg.verdict}）`);
  }
  report.rounds = rounds;
  report.load = monitor.summary(segmentStart, Date.now());
  for (const [name, list] of Object.entries(allSamples)) report.timings[name] = { samples: list, summary: summarize(list.filter((s) => s.verdict === "ok")), disturbedRounds: list.filter((s) => s.verdict !== "ok").length };
  for (const [name, counts] of Object.entries(report.processes)) report.processes[name] = { counts, min: Math.min(...counts), max: Math.max(...counts) };
  for (const [name, t] of Object.entries(report.timings)) log(name, t.summary, trace ? report.processes[name] : "");
} catch (error) {
  report.failures.push(`异常：${String(error.stack ?? error).slice(0, 800)}`);
  log("异常", error);
} finally {
  report.loadSamples = monitor.samples;
  monitor.stop();
  try { app.cdp.close(); } catch { /* 已关闭 */ }
  report.stop = await killOris(app);
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, trace ? "write-latency-trace.json" : "write-latency.json"), JSON.stringify(report, null, 2));
  log(`报告：${path.join(outDir, trace ? "write-latency-trace.json" : "write-latency.json")}；失败 ${report.failures.length}`);
  if (!args.includes("--keep")) { await sleep(1000); removeDir(runDir, GUI_ROOT); }
  process.exitCode = report.failures.length ? 1 : 0;
}

async function round(tag, i) {
  {
    // 1. 获取与拉取（仅快进）：另一个克隆先推送一个提交
    git(other, ["pull", "-q", "--ff-only"]);
    put(other, `remote/r-${tag}.txt`, `remote ${tag}\n`); commit(other, `remote ${tag}`); git(other, ["push", "-q", "origin", "main"]);
    await syncDialog("获取…", ".fetch-dialog");
    await timed("fetch", `window.__w.button('获取', document.querySelector('.fetch-dialog'))`, `window.__w.counts().includes('↓1')`);
    let rev = await evaluate(`window.__w.revision()`);
    await syncDialog("选项…", ".pull-dialog");
    await timed("pull（仅快进）", `window.__w.button('拉取', document.querySelector('.pull-dialog'))`, `window.__w.counts().includes('↑0 ↓0') && window.__w.revision() !== ${q(rev)}`);
    // 2. 合并本地 topic（快进）
    git(repo, ["switch", "-q", "-c", `topic-${tag}`]); put(repo, `topic/t-${tag}.txt`, `topic ${tag}\n`); commit(repo, `topic ${tag}`); git(repo, ["switch", "-q", "main"]);
    await refresh();
    rev = await evaluate(`window.__w.revision()`);
    await openBranches();
    await click(`window.__w.rowButton(${q(`topic-${tag}`)}, '更多 ▾')`);
    await click(`window.__w.button('合并到当前分支…')`);
    await waitUntil(`!!document.querySelector('.merge-dialog')`);
    await timed("merge（快进）", `window.__w.button('合并', document.querySelector('.merge-dialog'))`, `window.__w.counts().includes('↑1') && window.__w.revision() !== ${q(rev)}`);
    // 3. 推送到上游
    await syncDialog("预览…", ".push-dialog");
    await timed("push", `window.__w.button('推送', document.querySelector('.push-dialog'))`, `window.__w.counts().includes('↑0 ↓0')`);
    // 4. 切换分支（main → perf-alt → main，每次 20 个文件变化）
    for (const target of ["perf-alt", "main"]) {
      await openBranches();
      await timed(`切换分支（20 个文件变化）`, `window.__w.rowButton(${q(target)}, '切换')`, `window.__w.branchLabel().includes(${q(target)})`);
    }
    // 5. stash push / pop（一个已跟踪文件的改动）
    const rel = `tracked/${String(100 + i).padStart(6, "0")}.txt`;
    put(repo, rel, `stash probe ${i}\n`);
    await refresh();
    await waitUntil(`!!window.__op.row(${q(rel)})`, 20000);
    await openTab("历史");
    await waitUntil(`!!window.__w.button('储藏…')`, 20000);
    await click(`window.__w.button('储藏…')`);
    await waitUntil(`!!document.querySelector('.stash-form')`);
    await evaluate(`window.__w.setIn(document.querySelector('.stash-form'), 'input[aria-label="stash 说明"]', 'perf ${tag}')`);
    await timed("stash push", `window.__w.button('储藏', document.querySelector('.stash-form'))`, `!window.__op.row(${q(rel)})`);
    await openTab("历史");
    await waitUntil(`window.__w.stashCount() > 0`, 20000);
    await click(`window.__w.stashRow(0)`);
    await waitUntil(`!!document.querySelector('.stash-detail') && !!window.__w.button('弹出', document.querySelector('.stash-detail'))`, 20000);
    rev = await evaluate(`window.__w.revision()`);
    await timed("stash pop", `window.__w.button('弹出', document.querySelector('.stash-detail'))`, `window.__w.stashCount() === 0`);
    const back = await evaluate(`!!window.__w.button('← 返回本地变化')`);
    if (back) await click(`window.__w.button('← 返回本地变化')`);
    git(repo, ["checkout", "-q", "--", rel]);
    // 回到默认的“提交”页：历史页打开时每次改动 refs 的操作都会重读日志（见报告），其余操作按默认界面状态测量。
    await openTab("提交");
  }
}
