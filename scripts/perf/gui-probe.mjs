#!/usr/bin/env node
// Oris 端到端 GUI 性能与界面探针（CDP / DOM 模拟，不是真实 Windows 焦点测试）。
// 用法：node scripts/perf/gui-probe.mjs --exe <oris.exe> --label <名称> --suite core|restart|trace|task03|all [--iterations 30] [--port 9361]
// 输出：artifacts/gui-probe/<label>/<suite>.json 与截图；测试仓库与 profile 在 %TEMP%\oris-gui\<label>-<时间>\。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_HELPERS, decodePng, gitChildren, killOris, launchOris, machineInfo, percentile, processTree, processTreeDetailed, removeDir, round, sha256File, slope, sleep, summarize } from "./gui-lib.mjs";
import { GUI_ROOT, diffFingerprints, git, prepareCoreRepos, prepareTask03Repos, repositoryFingerprint } from "./gui-fixtures.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const exe = option("exe");
const label = option("label", "run");
const suite = option("suite", "all");
const iterations = Number(option("iterations", 30));
const basePort = Number(option("port", 9361));
const keep = args.includes("--keep");
const mixedOps = Number(option("mixed", 200));
const idleSeconds = Number(option("idle", 65));
// 追加给测试实例的 WebView2 参数（内存优化试验用）；产品默认参数始终保留。
const extraBrowserArgs = option("browser-args", "");
if (!exe) throw new Error("缺少 --exe");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(GUI_ROOT, `${label}-${stamp}`);
mkdirSync(runDir, { recursive: true });
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const save = (name, value) => { writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2)); log(`已写入 ${path.join(outDir, name)}`); };
const header = { browserArgs: extraBrowserArgs, label, exe: path.resolve(exe), exeSha256: sha256File(exe), webView2LoaderSha256: existsSync(path.join(path.dirname(exe), "WebView2Loader.dll")) ? sha256File(path.join(path.dirname(exe), "WebView2Loader.dll")) : null, machine: machineInfo(), startedAt: new Date().toISOString(), runDir, method: "CDP 页面内派发 DOM 事件；MutationObserver/5 ms 轮询检测断言成立后，再等下一帧（rAF + setTimeout 0）记为完成。进程树内存来自 Win32_Process（工作集、私有字节），包含 oris.exe、WebView2 与 git 子进程。不调用任何窗口激活 API。" };
let portCounter = 0;
const nextPort = () => basePort + (portCounter++);

async function start(profileName, extraEnv = {}) {
  const profileDir = path.join(runDir, "profiles", profileName);
  const app = await launchOris({ exe, profileDir, port: nextPort(), extraEnv, log, browserArgs: extraBrowserArgs });
  await app.cdp.call("Runtime.enable");
  await app.cdp.call("Page.enable");
  await app.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
  await app.cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 850, deviceScaleFactor: 1, mobile: false });
  await app.cdp.evaluate(PAGE_HELPERS);
  log(`已启动测试实例 PID ${app.pid}，端口 ${app.port}，核验 ${JSON.stringify(app.identity)}`);
  return app;
}
async function stop(app, force = false) {
  try { app.cdp.close(); } catch { /* closed */ }
  const result = await killOris({ ...app, force });
  log(`测试实例 PID ${app.pid} 已结束：${result.how}`);
  return result;
}

const q = JSON.stringify;
function helpers(app) {
  const { evaluate } = app.cdp;
  const measure = (action, predicate, timeout = 15000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
  const waitUntil = (predicate, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${predicate}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${predicate} ${r.error ?? ""}`); return r; });
  const focused = () => evaluate(`window.__op.focused()`);
  const readyExpr = (p, expect) => `window.__op.readyFor(${q(p)}, ${expect ? q(expect) : "null"}) === true`;
  const selectFileAction = (p) => `window.__op.row(${q(p)}).click()`;
  const projectReady = (p) => `window.__op.status().startsWith(${q(p)}) && window.__op.selected() && window.__op.readyFor(window.__op.selected(), null) === true`;
  const addProject = async (p, expectRows) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(p)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    return measure(`window.__op.button('载入/添加').click()`, `window.__op.status().startsWith(${q(p)}) && window.__op.rows().length ${expectRows ? `=== ${expectRows}` : "> 0"} && !window.__op.loading()`, 30000);
  };
  const removeProject = async (p) => {
    const before = await evaluate(`document.querySelectorAll('.project-tab').length`);
    await evaluate(`window.__op.projectTab(${q(p)}).querySelector('.project-close').click()`);
    await waitUntil(`document.querySelectorAll('.project-tab').length === ${before - 1}`);
  };
  const switchProject = (p, predicate = projectReady(p)) => measure(`window.__op.projectTab(${q(p)}).querySelector('.project-switch').click()`, predicate, 20000);
  const rows = () => evaluate(`window.__op.rows()`);
  return { measure, waitUntil, focused, readyExpr, selectFileAction, projectReady, addProject, removeProject, switchProject, rows, evaluate };
}

const textOf = (repo, rel) => readFileSync(path.join(repo, rel), "utf8").split("\n")[0];
const modifiedTextFiles = (repo) => repo.manifest.manifest.filter((m) => m.type === "unstaged" || m.type === "both").map((m) => m.path);
const memorySample = (app) => {
  const tree = processTree(app.pid);
  const byName = {};
  for (const p of tree.processes) {
    const key = p.name.toLowerCase();
    byName[key] ??= { count: 0, workingSetMiB: 0, privateMiB: 0 };
    byName[key].count++;
    byName[key].workingSetMiB = Math.round((byName[key].workingSetMiB + p.workingSetMiB) * 10) / 10;
    byName[key].privateMiB = Math.round((byName[key].privateMiB + p.privateMiB) * 10) / 10;
  }
  return { at: Date.now(), workingSetMiB: tree.workingSetMiB, privateMiB: tree.privateMiB, processes: tree.processes.length, git: tree.git, byName };
};

// ------------------------------ core ------------------------------
async function runCore() {
  const repos = await prepareCoreRepos(runDir);
  const P = repos.map((r) => r.path);
  const app = await start("core", { ORIS_APP_CACHE_DIR: path.join(runDir, "app-cache-core") });
  const h = helpers(app);
  const result = { ...header, suite: "core", repos: repos.map((r) => ({ path: r.path, head: r.manifest.head, tracked: r.manifest.tracked, changed: r.manifest.changed, warmupStatusMs: r.warmup })), identity: app.identity, scenarios: {}, notes: [] };
  const fingerprintsBefore = repos.map((r) => repositoryFingerprint(r.path, { includeWorktree: false }));
  try {
    await h.waitUntil(`document.querySelector('.project-empty')`);
    result.focusAtStart = await h.focused();
    // 首次打开：S1 添加 → 移除，重复。
    const firstOpen = [];
    for (let i = 0; i < iterations; i++) {
      const sample = await h.addProject(P[0], 65);
      firstOpen.push({ i, ...sample });
      if (i < iterations - 1) { await sleep(300); await h.removeProject(P[0]); await sleep(300); }
    }
    result.scenarios.firstOpen = { what: "添加项目（应用已运行、OS 缓存热）到文件列表 65 行可交互", samples: firstOpen, summary: summarize(firstOpen) };
    log("首次打开", result.scenarios.firstOpen.summary);
    const others = [];
    for (const p of P.slice(1)) { others.push(await h.addProject(p, 65)); await sleep(300); }
    result.scenarios.firstOpenOthers = { samples: others, summary: summarize(others) };

    // 热项目切换：循环 S1..S5，先预热一轮。
    for (const p of [...P, P[0]]) { const r = await h.switchProject(p); if (!r.ok) throw new Error(`预热切换失败 ${p} ${r.error}`); await sleep(200); }
    const hot = [];
    let active = 0;
    for (let i = 0; i < iterations; i++) {
      active = (active + 1) % P.length;
      await sleep(400);
      hot.push({ i, project: active, ...(await h.switchProject(P[active])) });
    }
    result.scenarios.hotSwitch = { what: "点击项目标签到目标项目的文件列表、选中文件与 diff 可读", samples: hot, summary: summarize(hot) };
    log("热项目切换", result.scenarios.hotSwitch.summary);
    await sleep(3000);
    const steady = [];
    for (let i = 0; i < 5; i++) { steady.push(memorySample(app)); await sleep(1000); }
    result.scenarios.memoryFiveProjects = { what: "5 项目各切换 ≥6 次后静置 3 s，再每秒采样 5 次（整个进程树）", samples: steady, workingSetMedianMiB: percentile(steady.map((s) => s.workingSetMiB), 0.5), privateMedianMiB: percentile(steady.map((s) => s.privateMiB), 0.5) };

    // 切换显示区域（S1）。
    await h.switchProject(P[0]); await sleep(500);
    const scopes = ["已暂存", "全部", "未暂存"];
    const counts = {};
    for (const label of scopes) { await h.measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) && !window.__op.loading() && window.__op.selected() && window.__op.readyFor(window.__op.selected(), null) === true`, 20000); await sleep(800); counts[label] = (await h.rows()).length; }
    const scopeSamples = [];
    for (let i = 0; i < iterations; i++) {
      const label = scopes[i % 3];
      await sleep(400);
      scopeSamples.push({ i, scope: label, ...(await h.measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) && window.__op.rows().length === ${counts[label]} && !window.__op.loading() && window.__op.selected() && window.__op.readyFor(window.__op.selected(), null) === true`, 20000)) });
    }
    result.scenarios.scopeSwitch = { what: "点击范围按钮到新范围列表（行数正确）与选中文件 diff 可读；Git 进程数见 trace 套件", rowCounts: counts, samples: scopeSamples, summary: summarize(scopeSamples) };
    log("切换显示区域", result.scenarios.scopeSwitch.summary);

    // 已缓存文件切换（S1 未暂存）。
    await h.measure(`window.__op.scopeButton('未暂存').click()`, `window.__op.footer().includes('未暂存') && !window.__op.loading() && window.__op.selected()`, 20000);
    await sleep(800);
    const s1Rows = await h.rows();
    const s1Modified = new Set(modifiedTextFiles(repos[0]));
    const modifiedInOrder = (list, set) => list.filter((p) => set.has(p));
    const s1Order = modifiedInOrder(s1Rows, s1Modified);
    const [fileA, fileB] = s1Order;
    for (const p of [fileA, fileB]) { await h.measure(h.selectFileAction(p), h.readyExpr(p, textOf(P[0], p))); await sleep(500); }
    const cached = [];
    for (let i = 0; i < iterations; i++) {
      const p = i % 2 ? fileB : fileA;
      await sleep(300);
      cached.push({ i, path: p, ...(await h.measure(h.selectFileAction(p), h.readyExpr(p, textOf(P[0], p)))) });
    }
    result.scenarios.cachedFile = { what: "两个已读文件来回切换到正文显示（含期望文本）", samples: cached, summary: summarize(cached) };
    log("已缓存文件切换", result.scenarios.cachedFile.summary);

    // 相邻文件切换：先选 i，静置 800 ms，再测 i+1（V2 应已预取；V1 无预取功能，等同未缓存）。
    const neighbour = [];
    const neighbourPlan = [];
    await h.switchProject(P[1]); await sleep(800);
    const s2Order = modifiedInOrder(await h.rows(), new Set(modifiedTextFiles(repos[1])));
    for (let i = 2; i + 1 < s2Order.length && neighbourPlan.length < 20; i += 2) neighbourPlan.push([1, s2Order[i], s2Order[i + 1]]);
    for (let i = 4; i + 1 < s1Order.length && neighbourPlan.length < iterations; i += 2) neighbourPlan.push([0, s1Order[i], s1Order[i + 1]]);
    let current = 1;
    for (const [repoIndex, first, second] of neighbourPlan) {
      if (repoIndex !== current) { await h.switchProject(P[repoIndex]); current = repoIndex; await sleep(800); }
      await h.measure(h.selectFileAction(first), h.readyExpr(first, textOf(P[repoIndex], first)));
      await sleep(800);
      neighbour.push({ repo: repoIndex, path: second, ...(await h.measure(h.selectFileAction(second), h.readyExpr(second, textOf(P[repoIndex], second)))) });
    }
    result.scenarios.adjacentFile = { what: "选中文件并静置 800 ms 后切到列表下一文件（预取场景）", samples: neighbour, summary: summarize(neighbour) };
    log("相邻文件切换", result.scenarios.adjacentFile.summary);

    // 未缓存常用文件：S3–S5，间隔 ≥2 行，避开已读与其相邻文件。
    const uncached = [];
    for (const repoIndex of [2, 3, 4]) {
      await h.switchProject(P[repoIndex]); await sleep(1000);
      const order = await h.rows();
      const modified = new Set(modifiedTextFiles(repos[repoIndex]));
      const touched = new Set();
      const mark = (p) => { const k = order.indexOf(p); for (const d of [-1, 0, 1]) touched.add(order[(k + d + order.length) % order.length]); };
      mark(await h.evaluate(`window.__op.selected()`));
      for (const p of order) {
        if (uncached.filter((s) => s.repo === repoIndex).length >= Math.ceil(iterations / 3)) break;
        if (!modified.has(p) || touched.has(p)) continue;
        await sleep(500);
        uncached.push({ repo: repoIndex, path: p, ...(await h.measure(h.selectFileAction(p), h.readyExpr(p, textOf(P[repoIndex], p)))) });
        mark(p);
      }
    }
    result.scenarios.uncachedFile = { what: "从未读取且非相邻的常用文本文件，点击到正文显示", samples: uncached, summary: summarize(uncached) };
    log("未缓存文件", result.scenarios.uncachedFile.summary);

    // 后台 dirty 项目切回：在后台项目写入未跟踪文件，等待 1.2 s 后切回，直到新文件出现在列表中。
    await h.switchProject(P[0]); await sleep(1000);
    const dirty = [];
    for (let i = 0; i < iterations; i++) {
      const target = 1 + (i % 4);
      const rel = `probe-dirty/dirty-${String(i).padStart(3, "0")}.txt`;
      mkdirSync(path.join(P[target], "probe-dirty"), { recursive: true });
      writeFileSync(path.join(P[target], rel), `dirty ${i}\n`);
      await sleep(1200);
      dirty.push({ i, project: target, ...(await h.switchProject(P[target], `window.__op.status().startsWith(${q(P[target])}) && window.__op.row(${q(rel)})`)) });
      await sleep(300);
      await h.switchProject(P[0]);
      await sleep(600);
    }
    result.scenarios.dirtySwitchBack = { what: "后台项目写入新未跟踪文件 1.2 s 后切回，到该文件出现在列表", samples: dirty, summary: summarize(dirty) };
    log("后台 dirty 切回", result.scenarios.dirtySwitchBack.summary);

    // 外部变化到界面更新（S1 选中文件被外部改写）。
    const target = s1Order[2];
    await h.measure(h.selectFileAction(target), h.readyExpr(target, textOf(P[0], target)));
    await sleep(2500);
    const external = [];
    for (let i = 0; i < iterations; i++) {
      const focus = await h.focused();
      const expect = `external change ${i} ${Date.now()}`;
      const pending = h.measure(``, h.readyExpr(target, expect), 8000);
      await sleep(50);
      const writtenAt = Date.now();
      writeFileSync(path.join(P[0], target), `${expect}\n`);
      const r = await pending;
      external.push({ i, focusedBeforeWrite: focus, ok: r.ok, error: r.error, ms: r.ok ? r.epoch - writtenAt : null, pageMs: r.ms });
      await sleep(2500);
    }
    result.scenarios.externalChange = { what: "外部写入选中文件到界面显示新内容（从写入时刻计时）；V1 仅在原生窗口获得焦点时自动刷新", samples: external, summary: summarize(external) };
    log("外部变化", result.scenarios.externalChange.summary);

    // 200 次混合切换内存趋势。
    let seed = 20260923;
    const rand = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const mixed = [];
    const memory = [];
    let activeProject = 0;
    await h.switchProject(P[0]); await sleep(1000);
    for (let i = 1; i <= mixedOps; i++) {
      const kind = ["project", "file", "scope"][rand(3)];
      let r;
      if (kind === "project") {
        activeProject = (activeProject + 1 + rand(P.length - 1)) % P.length;
        r = await h.switchProject(P[activeProject]);
      } else if (kind === "scope") {
        const label = ["未暂存", "已暂存", "全部"][rand(3)];
        r = await h.measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) && !window.__op.loading() && (window.__op.rows().length === 0 || (window.__op.selected() && window.__op.readyFor(window.__op.selected(), null) === true))`, 20000);
      } else {
        const list = (await h.rows()).slice(0, 30);
        const p = list[rand(list.length)];
        r = p ? await h.measure(h.selectFileAction(p), `window.__op.tab() === ${q(p)} && !window.__op.loading() && (document.querySelector('.cm-editor') || document.querySelector('.image-viewer') || document.querySelector('.state'))`) : { ok: true, ms: 0, skipped: true };
      }
      mixed.push({ i, kind, ok: r.ok, ms: r.ms, error: r.error });
      if (i % 10 === 0) { await sleep(300); memory.push({ afterOps: i, ...memorySample(app) }); }
      await sleep(120);
    }
    const ws = memory.map((m) => m.workingSetMiB);
    const from20 = memory.filter((m) => m.afterOps >= 20);
    result.scenarios.mixed200 = {
      what: "200 次项目 / 文件 / 范围混合切换（种子 20260923），每 10 次采样进程树内存",
      ops: mixed, memory,
      summary: {
        ...summarize(mixed.filter((m) => !m.skipped)),
        workingSetAt20MiB: from20[0]?.workingSetMiB, workingSetFinalMiB: ws.at(-1), workingSetPeakMiB: Math.max(...ws),
        growthVs20Pct: round(((ws.at(-1) - from20[0].workingSetMiB) / from20[0].workingSetMiB) * 100),
        slopeMiBPer100Ops: round(slope(from20.map((m) => m.workingSetMiB)) * 10, 2),
        privateAt20MiB: from20[0]?.privateMiB, privateFinalMiB: memory.at(-1).privateMiB,
        privateGrowthVs20Pct: round(((memory.at(-1).privateMiB - from20[0].privateMiB) / from20[0].privateMiB) * 100),
        privateSlopeMiBPer100Ops: round(slope(from20.map((m) => m.privateMiB)) * 10, 2)
      }
    };
    log("200 次混合", result.scenarios.mixed200.summary);
    await sleep(idleSeconds * 1000);
    result.idleGitChildren = { what: `混合切换结束静置 ${idleSeconds} s 后仍存活的 git 子进程`, processes: gitChildren(app.pid), tree: memorySample(app) };
    result.focusAtEnd = await h.focused();
  } catch (error) {
    result.error = String(error.stack ?? error);
    log("core 失败", error);
    try { writeFileSync(path.join(outDir, "core-failure.png"), await app.cdp.screenshot()); } catch { /* ignore */ }
  } finally {
    try { writeFileSync(path.join(outDir, "core-final.png"), await app.cdp.screenshot()); } catch { /* ignore */ }
    result.stop = await stop(app);
    const after = repos.map((r) => repositoryFingerprint(r.path, { includeWorktree: false }));
    result.readonlyGitDir = repos.map((r, i) => ({ repo: r.path, changed: diffFingerprints(fingerprintsBefore[i], after[i]) }));
    result.finishedAt = new Date().toISOString();
    save("core.json", result);
  }
  return result;
}

// ------------------------------ restart ------------------------------
/** 在新文档上安装的时间点记录：列表出现、校验完成（无“校验中”标记）。时间相对导航开始（窗口就绪）。 */
const restartMarks = (worktree) => `(() => {
  const marks = window.__restartMarks = {};
  const check = () => {
    const status = document.querySelector('.statusbar > span')?.textContent ?? '';
    const list = status.startsWith(${JSON.stringify(worktree)}) && document.querySelectorAll('.file').length > 0;
    const verifying = [...document.querySelectorAll('.stale-badge, .restore-status')].some((n) => /校验中/.test(n.textContent));
    if (list && marks.list === undefined) marks.list = performance.now();
    if (list && !verifying && marks.verified === undefined) marks.verified = performance.now();
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})()`;

async function runRestart() {
  const repos = await prepareCoreRepos(path.join(runDir, "restart-repos"));
  const P = repos.map((r) => r.path);
  const result = { ...header, suite: "restart", warmup: repos.map((r) => r.warmup), samples: [], notes: [
    "windowReady*：同一测试进程内页面重载（Page.reload），在新文档中用 MutationObserver 记录列表出现与校验完成时刻，相对导航开始；后端进程、登记表与 OS 文件缓存为热。V1 没有持久化快照，列表出现即校验完成。",
    "coldSpawnUpperBound：冷进程启动到首次 CDP 轮询看到列表的时间，包含测试框架的身份核验与 CDP 连接开销，只作上界参考。"
  ] };
  let app = await start("restart", { ORIS_APP_CACHE_DIR: path.join(runDir, "app-cache-restart") });
  const h = helpers(app);
  try {
    await h.waitUntil(`document.querySelector('.project-empty')`);
    for (const p of P) { await h.addProject(p, 65); await sleep(300); }
    await h.switchProject(P[0]);
    await sleep(3000);
  } finally { await stop(app); }
  for (let i = 0; i < iterations; i++) {
    app = await start("restart", { ORIS_APP_CACHE_DIR: path.join(runDir, "app-cache-restart") });
    try {
      const firstPoll = await app.cdp.evaluate(`({ list: (document.querySelector('.statusbar > span')?.textContent ?? '').startsWith(${q(P[0])}) && document.querySelectorAll('.file').length > 0, epoch: performance.timeOrigin + performance.now() })`);
      await app.cdp.waitFor(`(document.querySelector('.statusbar > span')?.textContent ?? '').startsWith(${q(P[0])}) && document.querySelectorAll('.file').length > 0 && ![...document.querySelectorAll('.stale-badge, .restore-status')].some((n) => /校验中/.test(n.textContent))`, 30000);
      await sleep(1500);
      const { identifier } = await app.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: restartMarks(P[0]) });
      await app.cdp.call("Page.reload", { ignoreCache: false });
      await sleep(200);
      await app.cdp.waitFor(`window.__restartMarks && window.__restartMarks.verified !== undefined`, 30000);
      const marks = await app.cdp.evaluate(`window.__restartMarks`);
      await app.cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      result.samples.push({ i, ok: true, windowReadyToListMs: marks.list, windowReadyToVerifiedMs: marks.verified, coldSpawnUpperBoundMs: firstPoll.list ? firstPoll.epoch - app.spawnedAt : null, coldListVisibleAtFirstPoll: firstPoll.list, spawnToCdpMs: app.cdpFoundAt - app.spawnedAt });
      log(`重启 ${i}`, JSON.stringify(result.samples.at(-1)));
    } catch (error) {
      result.samples.push({ i, ok: false, error: String(error).slice(0, 300) });
      log(`重启 ${i} 失败`, error);
    } finally { await stop(app); await sleep(1000); }
  }
  const pick = (key) => result.samples.map((s) => ({ ok: s.ok && s[key] !== null && s[key] !== undefined, ms: s[key] }));
  result.summary = { windowReadyToList: summarize(pick("windowReadyToListMs")), windowReadyToVerified: summarize(pick("windowReadyToVerifiedMs")), coldSpawnUpperBound: summarize(pick("coldSpawnUpperBoundMs")) };
  save("restart.json", result);
  return result;
}

// ------------------------------ trace（Git 进程计数） ------------------------------
async function runTrace() {
  const repos = await prepareCoreRepos(path.join(runDir, "trace-repos"), 2);
  const P = repos.map((r) => r.path);
  const traceDir = path.join(runDir, "trace2");
  mkdirSync(traceDir, { recursive: true });
  const app = await start("trace", { GIT_TRACE2_EVENT: traceDir, ORIS_APP_CACHE_DIR: path.join(runDir, "app-cache-trace") });
  const h = helpers(app);
  const result = { ...header, suite: "trace", notes: ["GIT_TRACE2_EVENT 指向目录时每个 Git 进程写一个文件；每个动作完成后再静置 1.5 s 统计新增文件（含后台补齐统计的进程）。"], actions: [] };
  const files = () => new Set(readdirSync(traceDir));
  // 同时按动作记录前端发出的 IPC 命令（CDP Network 捕获 ipc.localhost 请求），用于解释 Git 进程来源。
  const ipc = [];
  app.cdp.on("Network.requestWillBeSent", (p) => {
    if (!p.request.url.includes("ipc.localhost") || !p.request.postData) return;
    const command = decodeURIComponent(new URL(p.request.url).pathname.slice(1));
    if (!command.startsWith("plugin:")) ipc.push(command);
  });
  await app.cdp.call("Network.enable");
  const commands = (names) => [...names].map((name) => { try { const first = readFileSync(path.join(traceDir, name), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.event === "start"); return (first?.argv ?? []).slice(1).filter((a) => !a.startsWith("-c") && !/^core\.|^diff\./.test(a) && a !== "--no-optional-locks").join(" "); } catch { return "?"; } });
  const counted = async (name, action) => {
    const before = files();
    ipc.length = 0;
    const r = await action();
    await sleep(1500);
    const added = [...files()].filter((f) => !before.has(f));
    result.actions.push({ name, ok: r?.ok ?? true, ms: r?.ms, gitProcesses: added.length, commands: commands(added), ipc: [...ipc] });
    log(name, added.length);
  };
  try {
    await h.waitUntil(`document.querySelector('.project-empty')`);
    await counted("首次打开 S1", () => h.addProject(P[0], 65));
    await counted("首次打开 S2", () => h.addProject(P[1], 65));
    await counted("热切换到 S1", () => h.switchProject(P[0]));
    await sleep(3500);
    await counted("热切换到 S2（>3 s 后）", () => h.switchProject(P[1]));
    await counted("热切换到 S1（<3 s）", () => h.switchProject(P[0]));
    for (const label of ["已暂存", "全部", "未暂存", "已暂存", "全部", "未暂存"]) {
      await sleep(3500);
      await counted(`切换显示区域：${label}`, () => h.measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) && !window.__op.loading() && window.__op.selected() && window.__op.readyFor(window.__op.selected(), null) === true`, 20000));
    }
    const order = (await h.rows()).filter((p) => new Set(modifiedTextFiles(repos[0])).has(p));
    for (const p of order.slice(3, 9)) await counted(`切换文件 ${p}`, () => h.measure(h.selectFileAction(p), h.readyExpr(p, textOf(P[0], p))));
    await counted("手动刷新", () => h.measure(`window.__op.button('↻ 本地刷新').click()`, `!window.__op.button('↻ 本地刷新').disabled`, 20000));
    await counted("静置 10 s", () => sleep(10000));
  } catch (error) {
    result.error = String(error.stack ?? error);
  } finally {
    result.stop = await stop(app);
    save("trace.json", result);
  }
  return result;
}

// ------------------------------ task03 ------------------------------
async function runTask03() {
  const app = await start("task03", { ORIS_APP_CACHE_DIR: path.join(runDir, "app-cache-task03") });
  const h = helpers(app);
  const result = { ...header, suite: "task03", checks: [], notes: ["图片由 WebView2 实际解码（naturalWidth / 截图像素）；DOM 事件由 CDP 派发，不是原生鼠标与真实焦点。"] };
  const check = (name, pass, detail = {}) => { result.checks.push({ name, pass: !!pass, ...detail }); log(pass ? "通过" : "失败", name, JSON.stringify(detail).slice(0, 300)); };
  const shot = async (name, clip) => { const file = path.join(outDir, `task03-${name}.png`); writeFileSync(file, await app.cdp.screenshot(clip)); return file; };
  let fixtures;
  try {
    await h.waitUntil(`document.querySelector('.project-empty')`);
    fixtures = await prepareTask03Repos(runDir, app.cdp);
    result.fixtures = fixtures;
    const before = [fixtures.images, fixtures.conflict].map((r) => repositoryFingerprint(r));
    await h.addProject(fixtures.images);
    await h.addProject(fixtures.conflict);
    await h.switchProject(fixtures.images, `window.__op.status().startsWith(${q(fixtures.images)}) && !window.__op.loading()`);
    await sleep(800);
    const imageInfo = `(() => { const imgs = [...document.querySelectorAll('.image-viewer img')]; return { imgs: imgs.map((i) => ({ complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, width: i.getBoundingClientRect().width, height: i.getBoundingClientRect().height })), reasons: [...document.querySelectorAll('.image-reason')].map((n) => n.textContent), canvases: document.querySelectorAll('.image-canvas').length, meta: document.querySelector('.image-metadata')?.textContent ?? '', zoom: document.querySelector('.image-tools output')?.textContent, overlay: !!document.querySelector('.image-overlay'), slider: !!document.querySelector('input[aria-label="滑动分界"]'), slideOption: document.querySelector('select[aria-label="图片布局"] option[value="slide"]')?.disabled === false }; })()`;
    const openImage = async (p, scope = "未暂存", loaded = 2) => {
      const footer = await h.evaluate(`window.__op.footer()`);
      if (!footer.includes(scope)) {
        await h.measure(`window.__op.scopeButton(${q(scope)}).click()`, `window.__op.footer().includes(${q(scope)}) && !window.__op.loading()`, 20000);
        // 范围切换后应用会自动选中首个文件并读取；等它稳定后再操作。
        await h.waitUntil(`!window.__op.loading() && (document.querySelector('.image-viewer') || document.querySelector('.cm-editor') || document.querySelector('.state'))`, 20000);
        await sleep(300);
      }
      const shown = `window.__op.tab() === ${q(p)} && document.querySelector('.image-viewer') && [...document.querySelectorAll('.image-viewer img')].filter((i) => i.complete && i.naturalWidth > 0).length >= ${loaded} && [...document.querySelectorAll('.image-viewer img')].every((i) => i.complete) && !window.__op.loading()`;
      const already = await h.evaluate(`window.__op.selected() === ${q(p)}`);
      const r = await h.measure(already ? "" : h.selectFileAction(p), shown, 15000);
      await sleep(300);
      const info = await h.evaluate(imageInfo);
      if (!r.ok) log(`打开图片 ${p} 未达成：${r.error}`, JSON.stringify(info).slice(0, 300));
      return { r, info, alreadySelected: already };
    };
    const imgRect = (index) => h.evaluate(`(() => { const r = document.querySelectorAll('.image-viewer img')[${index}].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const pixelAt = async (rect, fx, fy) => { const png = decodePng(await app.cdp.screenshot({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.max(1, Math.floor(rect.width)), height: Math.max(1, Math.floor(rect.height)) })); return png.pixel(Math.min(png.width - 1, Math.floor(png.width * fx)), Math.min(png.height - 1, Math.floor(png.height * fy))); };

    // 1 并排（不同尺寸）
    let s = await openImage("img/photo.png");
    check("并排：两侧 PNG 由 WebView2 解码（HEAD 64×48 / WT 96×64）", s.r.ok && s.info.imgs.length === 2 && s.info.imgs[0].naturalWidth === 64 && s.info.imgs[1].naturalWidth === 96 && s.info.canvases === 2 && /64×48/.test(s.info.meta) && /96×64/.test(s.info.meta), { ms: s.r.ms, info: s.info, screenshot: await shot("split-sizes") });
    // 2 滑动
    await h.evaluate(`window.__op.setSelect('图片布局', 'slide')`); await sleep(300);
    await h.evaluate(`(() => { const r = document.querySelector('input[aria-label="滑动分界"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, '30'); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(300);
    const slide = await h.evaluate(`({ ...${imageInfo}, clip: document.querySelector('.image-overlay')?.style.clipPath, canvasWidth: document.querySelector('.image-canvas')?.getBoundingClientRect().width })`);
    check("滑动：单画布叠层、分界 30% 裁剪、共用坐标（画布宽按较大图）", slide.overlay && slide.slider && slide.canvases === 2 && /inset\(0(px)? 70% 0(px)? 0(px)?\)/.test(slide.clip ?? ""), { slide, screenshot: await shot("slide-30") });
    // 3 缩放
    await h.evaluate(`window.__op.button('原始尺寸').click()`); await sleep(300);
    const z1 = await h.evaluate(imageInfo);
    await h.evaluate(`document.querySelector('button[aria-label="放大"]').click()`); await sleep(300);
    const z2 = await h.evaluate(imageInfo);
    await h.evaluate(`document.querySelector('button[aria-label="缩小"]').click()`); await sleep(300);
    const z3 = await h.evaluate(imageInfo);
    check("缩放：原始尺寸 100%（WT 显示宽 96px）→ 放大 125% → 缩小回 100%", z1.zoom === "100%" && Math.abs(z1.imgs[1].width - 96) < 1 && z2.zoom === "125%" && Math.abs(z2.imgs[1].width - 120) < 1 && z3.zoom === "100%", { z1: z1.zoom, z2: z2.zoom, z3: z3.zoom, widths: [z1.imgs.map((i) => i.width), z2.imgs.map((i) => i.width)], screenshot: await shot("zoom-125") });
    await h.evaluate(`window.__op.button('适应视图').click(); window.__op.setSelect('图片布局', 'split')`); await sleep(300);
    // 4 透明
    s = await openImage("img/alpha.png", "已暂存");
    let rect = await imgRect(1);
    const checkerPixel = await pixelAt(rect, 0.02, 0.02);
    const centrePixel = await pixelAt(rect, 0.5, 0.5);
    await h.evaluate(`window.__op.setSelect('透明背景', 'dark')`); await sleep(300);
    const darkPixel = await pixelAt(await imgRect(1), 0.02, 0.02);
    const darkShot = await shot("alpha-dark");
    await h.evaluate(`window.__op.setSelect('透明背景', 'light')`); await sleep(300);
    const lightPixel = await pixelAt(await imgRect(1), 0.02, 0.02);
    await h.evaluate(`window.__op.setSelect('透明背景', 'checker')`); await sleep(300);
    const grey = (p) => Math.abs(p[0] - p[1]) < 8 && Math.abs(p[1] - p[2]) < 8;
    check("透明：透明像素显示背景（棋盘格灰 / 深色 / 浅色），不透明像素显示图片颜色", s.r.ok && grey(checkerPixel) && checkerPixel[0] > 150 && darkPixel[0] < 60 && lightPixel[0] > 240 && centrePixel[2] > 150 && centrePixel[0] < 150, { checkerPixel, darkPixel, lightPixel, centrePixel, screenshots: [await shot("alpha-checker"), darkShot] });
    // 5 方向
    s = await openImage("img/orient.jpg");
    const leftRect = await imgRect(0), rightRect = await imgRect(1);
    const leftTL = await pixelAt(leftRect, 0.1, 0.15), leftTR = await pixelAt(leftRect, 0.9, 0.15);
    const rightTL = await pixelAt(rightRect, 0.15, 0.1), rightTR = await pixelAt(rightRect, 0.85, 0.1);
    const red = (p) => p[0] > 180 && p[1] < 90 && p[2] < 90, blue = (p) => p[2] > 180 && p[0] < 90;
    check("方向：EXIF 1 存储 40×20 红块左上；EXIF 6 展示为 20×40 且红块在右上", s.r.ok && Math.abs(leftRect.width / leftRect.height - 2) < 0.1 && Math.abs(rightRect.height / rightRect.width - 2) < 0.1 && red(leftTL) && blue(leftTR) && red(rightTR) && blue(rightTL) && /EXIF 6/.test(s.info.meta), { leftRect, rightRect, leftTL, leftTR, rightTL, rightTR, meta: s.info.meta, screenshot: await shot("orientation") });
    // 6 WebP
    s = await openImage("img/pic.webp");
    check("WebP：两侧由 WebView2 解码", s.r.ok && s.info.imgs.every((i) => i.naturalWidth === 48), { info: s.info, screenshot: await shot("webp") });
    // 7 坏图
    s = await openImage("img/broken.png", "未暂存", 1);
    check("坏图降级：WT 截断 PNG 显示原因，HEAD 侧仍显示", s.r.ok && s.info.imgs.length === 1 && s.info.reasons.length === 1, { info: s.info, screenshot: await shot("broken") });
    // 8 动画
    s = await openImage("img/anim.png", "未暂存", 1);
    check("动画 APNG 降级并说明原因", s.r.ok && s.info.imgs.length === 1 && s.info.reasons.some((t) => /动画/.test(t)), { info: s.info, screenshot: await shot("apng") });
    // 9 新增 / 删除单栏
    s = await openImage("img/added.png", "未暂存", 1);
    check("新增（未跟踪）单栏，无可用滑动", s.r.ok && s.info.canvases === 1 && !s.info.slideOption, { info: s.info, screenshot: await shot("added-single") });
    s = await openImage("img/removed.png", "未暂存", 1);
    check("删除单栏", s.r.ok && s.info.canvases === 1 && !s.info.slideOption, { info: s.info, screenshot: await shot("removed-single") });

    // 冲突
    await h.switchProject(fixtures.conflict, `window.__op.status().startsWith(${q(fixtures.conflict)}) && !window.__op.loading()`);
    await sleep(800);
    const conflictText = async (p, versions, expect) => {
      if (versions) { await h.evaluate(`window.__op.setSelect('冲突左版本', ${q(versions[0])})`); await sleep(50); await h.evaluate(`window.__op.setSelect('冲突右版本', ${q(versions[1])})`); }
      else await h.measure(h.selectFileAction(p), `window.__op.tab() === ${q(p)} && document.querySelector('.conflict-toolbar')`, 15000);
      const r = await h.waitUntil(`window.__op.tab() === ${q(p)} && !window.__op.loading() && window.__op.editorText().includes(${q(expect[0])}) && window.__op.editorText().includes(${q(expect[1])})`, 15000).catch((e) => ({ ok: false, error: String(e) }));
      return { r, text: await h.evaluate(`window.__op.editorText()`), identities: await h.evaluate(`document.querySelector('.conflict-identities')?.textContent ?? ''`), selects: await h.evaluate(`[...document.querySelectorAll('.conflict-toolbar select')].map((s) => s.value)`) };
    };
    let c = await conflictText("c.txt", null, ["ours change", "theirs change"]);
    check("冲突 UU 文本：默认 stage 2 → stage 3", c.r.ok && c.selects.join() === "stage2,stage3", { ...c, screenshot: await shot("conflict-default") });
    c = await conflictText("c.txt", ["stage1", "stage2"], ["base line 2", "ours change"]);
    check("冲突：选择 Base(stage 1) → stage 2", c.r.ok, { ...c, screenshot: await shot("conflict-base-ours") });
    c = await conflictText("c.txt", ["stage3", "workingTree"], ["theirs change", "<<<<<<<"]);
    check("冲突：选择 stage 3 → 当前工作区（含冲突标记）", c.r.ok, { ...c, screenshot: await shot("conflict-theirs-wt") });
    const imgConflict = await h.measure(h.selectFileAction("img.png"), `window.__op.tab() === 'img.png' && [...document.querySelectorAll('.image-viewer img')].filter((i) => i.complete && i.naturalWidth > 0).length === 2`, 15000);
    const imgConflictInfo = await h.evaluate(imageInfo);
    check("冲突图片：stage 2（24×32 红）与 stage 3（32×24 蓝）由图片阅读器显示", imgConflict.ok && imgConflictInfo.imgs[0].naturalWidth === 24 && imgConflictInfo.imgs[1].naturalWidth === 32, { info: imgConflictInfo, screenshot: await shot("conflict-image") });
    const ud = await h.measure(h.selectFileAction("md.txt"), `window.__op.tab() === 'md.txt' && document.querySelector('.conflict-identities') && !window.__op.loading()`, 15000);
    await sleep(300);
    const udText = await h.evaluate(`document.querySelector('.conflict-identities').textContent`);
    check("冲突 UD：stage 3 缺失明确显示为“缺失 / 删除”，stage 2 可读", ud.ok && /缺失 \/ 删除/.test(udText), { udText, screenshot: await shot("conflict-ud") });

    // 30 次图片 / 文本 / 冲突混合切换
    const plan = [[fixtures.images, "img/photo.png", "image"], [fixtures.images, "notes.txt", "text"], [fixtures.conflict, "c.txt", "conflict"], [fixtures.images, "img/orient.jpg", "image"], [fixtures.conflict, "img.png", "conflict-image"], [fixtures.images, "img/pic.webp", "image"], [fixtures.conflict, "plain.txt", "text"]];
    const ready = (p, kind) => kind.includes("image") ? `window.__op.tab() === ${q(p)} && [...document.querySelectorAll('.image-viewer img')].filter((i) => i.complete && i.naturalWidth > 0).length === 2` : kind === "conflict" ? `window.__op.tab() === ${q(p)} && document.querySelector('.conflict-toolbar') && !window.__op.loading() && window.__op.editorText().includes('ours change')` : `window.__op.readyFor(${q(p)}, null) === true`;
    const mixed = [], memory = [memorySample(app)];
    let activeRepo = await h.evaluate(`window.__op.status()`);
    for (let i = 0; i < 30; i++) {
      const [repo, p, kind] = plan[i % plan.length];
      if (!activeRepo.startsWith(repo)) {
        await h.switchProject(repo, `window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`);
        activeRepo = repo;
        await sleep(200);
      }
      const footer = await h.evaluate(`window.__op.footer()`);
      if (!footer.includes("未暂存")) await h.measure(`window.__op.scopeButton('未暂存').click()`, `window.__op.footer().includes('未暂存') && !window.__op.loading()`, 20000);
      const r = await h.measure(h.selectFileAction(p), ready(p, kind), 15000);
      mixed.push({ i, kind, path: p, ok: r.ok, ms: r.ms, error: r.error });
      memory.push(memorySample(app));
      await sleep(250);
    }
    await sleep(3000);
    memory.push(memorySample(app));
    const ws = memory.map((m) => m.workingSetMiB);
    result.mixed30 = { samples: mixed, summary: summarize(mixed), memory, workingSetStartMiB: ws[0], workingSetPeakMiB: Math.max(...ws), workingSetEndMiB: ws.at(-1), privatePeakMiB: Math.max(...memory.map((m) => m.privateMiB)) };
    check("30 次图片 / 文本 / 冲突混合切换全部完成", mixed.every((m) => m.ok), { summary: result.mixed30.summary, workingSetStartMiB: ws[0], workingSetPeakMiB: Math.max(...ws), workingSetEndMiB: ws.at(-1) });

    const after = [fixtures.images, fixtures.conflict].map((r) => repositoryFingerprint(r));
    result.readonly = [fixtures.images, fixtures.conflict].map((r, i) => ({ repo: r, files: before[i].files, changed: diffFingerprints(before[i], after[i]) }));
    check("只读：两个夹具仓库的工作区与 .git（不含 objects/logs）逐字节不变", result.readonly.every((r) => r.changed.length === 0), { readonly: result.readonly });
  } catch (error) {
    result.error = String(error.stack ?? error);
    log("task03 失败", error);
    try { await shot("failure"); } catch { /* ignore */ }
  } finally {
    result.stop = await stop(app);
    result.passed = !result.error && result.checks.every((c) => c.pass);
    save("task03.json", result);
  }
  return result;
}


// ------------------------------ memory（V2-D28 分层内存） ------------------------------
async function runMemory() {
  const repos = await prepareCoreRepos(path.join(runDir, "memory-repos"));
  const P = repos.map((r) => r.path);
  const app = await start("memory", { ORIS_APP_CACHE_DIR: path.join(runDir, "app-cache-memory") });
  await app.cdp.call("Performance.enable");
  const h = helpers(app);
  const result = { ...header, suite: "memory", notes: ["framework = WebView2 进程组；tools = Git 子进程（含 conhost）；oris = oris.exe；jsHeap 为页面 JS 堆（位于 WebView2 渲染进程内，已含在 framework 中，单列供参考）。privateWorkingSet 不含共享页，是各进程独占的物理内存；workingSet 相加会重复计算共享的运行库。"], samples: {} };
  const sample = async (tag) => {
    const tree = processTreeDetailed(app.pid);
    const metrics = (await app.cdp.call("Performance.getMetrics")).metrics;
    const pick = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { tag, at: Date.now(), layers: tree.layers, processes: tree.processes, jsHeapUsedMiB: round(pick("JSHeapUsedSize") / 1048576), jsHeapTotalMiB: round(pick("JSHeapTotalSize") / 1048576), domNodes: pick("Nodes") };
  };
  try {
    await h.waitUntil(`document.querySelector('.project-empty')`);
    result.samples.start = await sample("启动后空项目");
    for (const p of P) { await h.addProject(p, 65); await sleep(300); }
    for (const p of [...P, P[0]]) { await h.switchProject(p); await sleep(200); }
    let active = 0;
    for (let i = 0; i < 30; i++) { active = (active + 1) % P.length; await sleep(400); await h.switchProject(P[active]); }
    await sleep(3000);
    const steady = [];
    for (let i = 0; i < 5; i++) { steady.push(await sample(`稳态 ${i}`)); await sleep(1000); }
    result.samples.steady = steady;
    const median = (list, pickValue) => percentile(list.map(pickValue), 0.5);
    result.steadyMedian = Object.fromEntries(["framework", "tools", "oris", "total"].map((layer) => [layer, {
      workingSetMiB: median(steady, (x) => x.layers[layer].workingSetMiB),
      privateWorkingSetMiB: median(steady, (x) => x.layers[layer].privateWorkingSetMiB),
      privateMiB: median(steady, (x) => x.layers[layer].privateMiB)
    }]));
    result.steadyMedian.jsHeapUsedMiB = median(steady, (x) => x.jsHeapUsedMiB);
    let seed = 20260923;
    const rand = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const trend = [];
    let activeProject = 0;
    await h.switchProject(P[0]); await sleep(1000);
    for (let i = 1; i <= mixedOps; i++) {
      const kind = ["project", "file", "scope"][rand(3)];
      if (kind === "project") { activeProject = (activeProject + 1 + rand(P.length - 1)) % P.length; await h.switchProject(P[activeProject]); }
      else if (kind === "scope") { const label = ["未暂存", "已暂存", "全部"][rand(3)]; await h.measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) && !window.__op.loading() && (window.__op.rows().length === 0 || (window.__op.selected() && window.__op.readyFor(window.__op.selected(), null) === true))`, 20000); }
      else { const list = (await h.rows()).slice(0, 30); const p = list[rand(list.length)]; if (p) await h.measure(h.selectFileAction(p), `window.__op.tab() === ${q(p)} && !window.__op.loading() && (document.querySelector('.cm-editor') || document.querySelector('.image-viewer') || document.querySelector('.state'))`); }
      if (i % 20 === 0) { await sleep(300); trend.push({ afterOps: i, ...(await sample(`混合 ${i}`)) }); }
      await sleep(120);
    }
    result.samples.mixed = trend;
    const growth = (layer, key) => { const a = trend[0]?.layers[layer][key], b = trend.at(-1)?.layers[layer][key]; return a ? round(((b - a) / a) * 100) : null; };
    result.mixedGrowthPct = Object.fromEntries(["framework", "tools", "oris", "total"].map((layer) => [layer, { workingSet: growth(layer, "workingSetMiB"), privateWorkingSet: growth(layer, "privateWorkingSetMiB"), private: growth(layer, "privateMiB") }]));
    await sleep(idleSeconds * 1000);
    result.samples.idle = await sample(`静置 ${idleSeconds} s`);
  } catch (error) {
    result.error = String(error.stack ?? error);
    log("memory 失败", error);
  } finally {
    result.stop = await stop(app);
    save("memory.json", result);
  }
  return result;
}

const suites = suite === "all" ? ["core", "trace", "restart", "task03"] : suite.split(",");
const summary = {};
for (const name of suites) {
  log(`=== 套件 ${name} ===`);
  const run = { core: runCore, restart: runRestart, trace: runTrace, task03: runTask03, memory: runMemory }[name];
  if (!run) throw new Error(`未知套件 ${name}`);
  const r = await run();
  summary[name] = r.error ? `失败：${r.error.split("\n")[0]}` : "完成";
}
save("summary.json", { ...header, suites: summary, finishedAt: new Date().toISOString() });
if (!keep) {
  const removed = removeDir(runDir, GUI_ROOT);
  log(removed ? `已清理运行目录 ${runDir}` : `运行目录未能完全清理：${runDir}`);
}
