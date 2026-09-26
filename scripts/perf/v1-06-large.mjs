// 一期 06 发布性能测试：L 数据集（100,000 tracked 文件、100,000 提交、2,000 个变化文件）的界面测量。
// 在生成器产出的 L 仓库中额外写入未跟踪的超预算内容（8 MiB 文本、30 万字符单行、48 MP 图片、边长 17,000 的图片），检查：
// 有界加载（首次打开时延与内存）、范围 / 文件切换、文件列表滚动、超预算内容明确降级、切换时取消旧请求（旧结果不落屏）、
// 历史分页、混合操作后内存不无限增长、实例不崩溃。只经 CDP 操作本轮启动并核验过的 Oris 实例，不调用任何窗口激活 API。
// 用法：node scripts/perf/v1-06-large.mjs --exe <oris.exe> --repo <L 仓库> [--iterations 30] [--port 9881] [--label perf-large]
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, encodePng, killOris, launchOris, machineInfo, processTreeDetailed, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
// Oris 显示规范化后的长路径；8.3 短路径（如 %TEMP% 中的 ZHAOWE~1）先解析，避免断言按路径匹配失败。
const repo = option("repo") ? realpathSync.native(path.resolve(option("repo"))) : null;
if (!exe || !repo) throw new Error("需要 --exe 与 --repo");
if (!existsSync(path.join(repo, ".git", "oris-perf-manifest.json"))) throw new Error("只接受 generate-datasets.mjs 生成的 L 仓库");
const manifest = JSON.parse(readFileSync(path.join(repo, ".git", "oris-perf-manifest.json"), "utf8"));
if (manifest.kind !== "L") throw new Error("不是 L 数据集");
const port = Number(option("port", 9881));
const iterations = Number(option("iterations", 30));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "perf-large"));
mkdirSync(outDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-06-large-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), machine: machineInfo(), repo, dataset: { kind: manifest.kind, seed: manifest.seed, tracked: manifest.tracked, commits: manifest.commits, changed: manifest.changed, ignored: manifest.ignored }, method: "CDP 页面事件；计时到断言成立后的下一帧；内存为进程树私有工作集分层", timings: {}, memory: [], checks: {}, failures: [] };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; log(ok ? "✓" : "✗", name); if (!ok) report.failures.push(name); };

// ---------- 超预算内容（未跟踪，放在 L 仓库中） ----------
const big = path.join(repo, "perf-large");
mkdirSync(big, { recursive: true });
const bigText = "perf-large/big-8mib.txt", longLine = "perf-large/longline-300k.txt", hugeImage = "perf-large/huge-48mp.png", wideImage = "perf-large/wide-17000.png";
if (!existsSync(path.join(repo, bigText))) {
  const line = "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n";
  writeFileSync(path.join(repo, bigText), line.repeat(Math.ceil((8 * 1024 * 1024) / line.length)));
  writeFileSync(path.join(repo, longLine), "x".repeat(300000) + "\n");
  writeFileSync(path.join(repo, hugeImage), encodePng(8000, 6000, (x, y) => [(x >> 6) & 255, (y >> 6) & 255, 128, 255]));
  writeFileSync(path.join(repo, wideImage), encodePng(17000, 64, (x) => [x & 255, 64, 192, 255]));
}
report.oversized = Object.fromEntries([bigText, longLine, hugeImage, wideImage].map((p) => [p, readFileSync(path.join(repo, p)).length]));
// 小仓库：用于项目切换与取消
const small = path.join(runDir, "small");
mkdirSync(small, { recursive: true });
writeFileSync(path.join(small, "s.txt"), "small\n");
git(small, ["init", "-q", "-b", "main"]); git(small, ["add", "-A"]); git(small, ["-c", "user.name=Oris Perf", "-c", "user.email=oris-perf@example.invalid", "commit", "-q", "-m", "base"]);
writeFileSync(path.join(small, "s.txt"), "small\nchanged\n");
// 预热 status（与 S 数据集相同：复制 / 生成后的首轮 status 偏慢，不计入）
for (let i = 0; i < 3; i++) spawnSync("git", ["--no-optional-locks", "-C", repo, "status", "--porcelain=v2", "-z", "--untracked-files=all"], { maxBuffer: 256 * 1024 * 1024 });

const app = await launchOris({ exe, profileDir: path.join(runDir, "profile"), port, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "cache") } });
const { call, evaluate } = app.cdp;
await call("Runtime.enable"); await call("Page.enable");
await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(PAGE_HELPERS);
log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
const measure = (action, predicate, timeout = 60000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
const waitUntil = (expr, timeout = 60000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
const memory = (tag) => { const t = processTreeDetailed(app.pid); const m = { tag, at: Date.now(), layers: Object.fromEntries(Object.entries(t.layers).map(([k, v]) => [k, { privateWorkingSetMiB: v.privateWorkingSetMiB, workingSetMiB: v.workingSetMiB }])), processes: t.processes.length }; report.memory.push(m); log("内存", tag, m.layers.total); return m; };
const addProject = async (p) => { await evaluate(`window.__op.setInput('仓库路径', ${q(p)})`); await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`); return measure(`window.__op.button('载入/添加').click()`, `window.__op.status().startsWith(${q(p)}) && window.__op.rows().length > 0 && !window.__op.loading()`, 120000); };
const removeProject = async (p) => { const n = await evaluate(`document.querySelectorAll('.project-tab').length`); await evaluate(`window.__op.projectTab(${q(p)}).querySelector('.project-close').click()`); await waitUntil(`document.querySelectorAll('.project-tab').length === ${n - 1}`); };
const selectFile = (p, predicate, timeout = 60000) => measure(`window.__op.row(${q(p)}).click()`, predicate ?? `window.__op.tab() === ${q(p)} && !window.__op.loading() && window.__op.readyFor(${q(p)}, null) === true`, timeout);
const record = (name, list, what) => { report.timings[name] = { what, samples: list, summary: summarize(list) }; log(name, report.timings[name].summary); };
const alive = () => spawnSync("powershell", ["-NoProfile", "-Command", `[bool](Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue)`], { encoding: "utf8" }).stdout.trim() === "True";

try {
  await waitUntil(`document.querySelector('.project-empty')`);
  memory("启动后空项目");
  // 1. 首次打开（添加项目到文件列表可交互），重复 N 次（每次移除后重新添加；OS 文件缓存为热状态）
  const opens = [];
  for (let i = 0; i < iterations; i++) {
    opens.push(await addProject(repo));
    if (i === 0) memory("首次打开 L 后");
    if (i < iterations - 1) { await sleep(500); await removeProject(repo); await sleep(500); }
  }
  record("firstOpen", opens, "添加 L 项目到文件列表可交互（热 OS 缓存；每次移除后重新添加）");
  memory(`第 ${iterations} 次打开后`);
  const listed = await evaluate(`window.__op.footer()`);
  report.footer = listed;
  // 2. 范围切换
  const scopes = [];
  for (let i = 0; i < iterations; i++) {
    const label = ["已暂存", "全部", "未暂存"][i % 3];
    scopes.push(await measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) && !window.__op.loading() && window.__op.rows().length > 0`, 30000));
    await sleep(200);
  }
  record("scopeSwitch", scopes, "切换显示区域到新范围的列表可读");
  await measure(`window.__op.scopeButton('未暂存').click()`, `window.__op.footer().includes('未暂存') && !window.__op.loading()`, 30000);
  // 3. 文件列表滚动（虚拟列表）：10 s 连续滚轮，记录 rAF 帧间隔
  const listBox = await evaluate(`(() => { const n = document.querySelector('.files'); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, rows: n.querySelectorAll('.file').length, scrollHeight: n.scrollHeight }; })()`);
  await evaluate(`(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__framesOn) requestAnimationFrame(tick); }; window.__framesOn = true; requestAnimationFrame(tick); })()`);
  const scrollStart = Date.now();
  let direction = 1;
  while (Date.now() - scrollStart < 10000) {
    await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: listBox.x, y: listBox.y, deltaX: 0, deltaY: 240 * direction });
    await sleep(16);
    if (await evaluate(`(() => { const n = document.querySelector('.files'); return n.scrollTop + n.clientHeight >= n.scrollHeight - 2 || n.scrollTop <= 0; })()`)) direction = -direction;
  }
  const frames = await evaluate(`(() => { window.__framesOn = false; return window.__frames.slice(1); })()`);
  const sorted = [...frames].sort((a, b) => a - b);
  report.timings.fileListScroll = { what: "文件列表连续滚轮 10 s 的 rAF 帧间隔（ms）", domRowsBefore: listBox.rows, frames: frames.length, p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), longFrames: frames.filter((f) => f > 50).length, domRowsAfter: await evaluate(`document.querySelectorAll('.files .file').length`) };
  log("文件列表滚动", report.timings.fileListScroll);
  await evaluate(`document.querySelector('.files').scrollTop = 0`);
  await sleep(300);
  // 4. 文件切换：未缓存（不同文件）与已缓存（再次打开）
  const unstaged = manifest.manifest.filter((m) => m.type === "unstaged" || m.type === "both").map((m) => m.path);
  const targets = unstaged.slice(0, iterations);
  const uncached = [], cached = [];
  for (const p of targets) {
    await evaluate(`window.__op.setInput('按完整相对路径筛选', ${q(p)})`);
    await waitUntil(`!!window.__op.row(${q(p)})`, 20000);
    uncached.push({ path: p, ...(await selectFile(p)) });
  }
  for (const p of targets) {
    await evaluate(`window.__op.setInput('按完整相对路径筛选', ${q(p)})`);
    await waitUntil(`!!window.__op.row(${q(p)})`, 20000);
    cached.push({ path: p, ...(await selectFile(p)) });
  }
  record("uncachedFile", uncached, "筛选到文件后点击，到文本显示（首次读取）");
  record("cachedFile", cached, "再次点击同一文件，到文本显示");
  // 5. 超预算内容：明确降级，不显示为“无变化”
  await measure(`window.__op.scopeButton('全部').click()`, `window.__op.footer().includes('全部') && !window.__op.loading()`, 30000);
  const degrade = {};
  for (const p of [bigText, longLine, hugeImage, wideImage]) {
    await evaluate(`window.__op.setInput('按完整相对路径筛选', ${q(p)})`);
    await waitUntil(`!!window.__op.row(${q(p)})`, 20000);
    const r = await selectFile(p, `window.__op.tab() === ${q(p)} && !window.__op.loading() && !!(document.querySelector('.special-file') || document.querySelector('.state.warning') || document.querySelector('.image-degraded, .image-reason') || /超过|超出|预算|降级/.test(document.querySelector('.content')?.textContent ?? ''))`, 60000);
    const text = await evaluate(`(document.querySelector('.content')?.textContent ?? '').slice(0, 400)`);
    degrade[p] = { ...r, text };
  }
  report.degrade = degrade;
  check("L 超预算内容（8 MiB 文本、30 万字符单行、48 MP 图片、边长 17,000 图片）都明确降级并说明原因", Object.values(degrade).every((d) => d.ok && /超过|超出|预算|MiB|像素|MP|边长|字符/.test(d.text) && !/没有变化|无变化/.test(d.text)), degrade);
  memory("超预算内容之后");
  // 6. 取消：点击 48 MP 图片后立即切到小文本文件；最终只显示小文件（旧请求不落屏）
  const cancels = [];
  const smallTarget = unstaged[iterations + 1];
  for (let i = 0; i < 10; i++) {
    await evaluate(`window.__op.setInput('按完整相对路径筛选', 'perf-large/')`);
    await waitUntil(`!!window.__op.row(${q(hugeImage)})`, 20000);
    await evaluate(`window.__op.row(${q(hugeImage)}).click()`);
    await sleep(5);
    await evaluate(`window.__op.setInput('按完整相对路径筛选', ${q(smallTarget)})`);
    await waitUntil(`!!window.__op.row(${q(smallTarget)})`, 20000);
    const r = await selectFile(smallTarget);
    await sleep(1500);
    const shown = await evaluate(`({ tab: window.__op.tab(), image: !!document.querySelector('.image-viewer') })`);
    cancels.push({ ...r, finalTab: shown.tab, imageShown: shown.image });
  }
  record("cancelSwitch", cancels, "点击 48 MP 图片后立即改选小文本文件，到小文件显示");
  check("L 取消：改选后 1.5 s 内旧的图片结果没有落屏（10/10）", cancels.every((c) => c.ok && c.finalTab === smallTarget && !c.imageShown), cancels.map((c) => ({ tab: c.finalTab, image: c.imageShown })));
  // 7. 项目切换：小仓库 ↔ L
  await addProject(small);
  const switches = [];
  for (let i = 0; i < iterations; i++) {
    const to = i % 2 ? small : repo;
    switches.push(await measure(`window.__op.projectTab(${q(to)}).querySelector('.project-switch').click()`, `window.__op.status().startsWith(${q(to)}) && !window.__op.loading() && window.__op.rows().length > 0`, 60000));
    await sleep(300);
  }
  record("projectSwitch", switches, "小仓库与 L 之间热切换，到文件列表可交互");
  // 8. 历史：首屏与续读
  await measure(`window.__op.projectTab(${q(repo)}).querySelector('.project-switch').click()`, `window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 60000);
  const historyTab = `[...document.querySelectorAll('.git-tabs button')].find((b) => b.textContent.startsWith('历史'))`;
  const firstPage = await measure(`${historyTab}.click()`, `document.querySelectorAll('.log-row').length > 0 && !/读取中/.test(document.querySelector('.log-count')?.textContent ?? '')`, 60000);
  const pages = [];
  for (let i = 0; i < 5; i++) {
    const before = await evaluate(`Number(/(\\d+) 个提交/.exec(document.querySelector('.log-count')?.textContent ?? '')?.[1] ?? 0)`);
    pages.push({ before, ...(await measure(`(() => { const c = document.querySelector('.log-commits'); c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event('scroll')); })()`, `Number(/(\\d+) 个提交/.exec(document.querySelector('.log-count')?.textContent ?? '')?.[1] ?? 0) > ${before} && !/读取中/.test(document.querySelector('.log-count')?.textContent ?? '')`, 60000)) });
  }
  report.timings.historyFirstPage = { what: "打开历史页到首屏提交列表可读（100,000 提交）", ...firstPage, count: await evaluate(`document.querySelector('.log-count')?.textContent`) };
  report.timings.historyNextPage = { what: "滚到列表底部到下一页读入", samples: pages, summary: summarize(pages), domRows: await evaluate(`document.querySelectorAll('.log-row').length`) };
  log("历史", report.timings.historyFirstPage, report.timings.historyNextPage.summary);
  const commitsTab = `[...document.querySelectorAll('.git-tabs button')].find((b) => b.textContent.startsWith('提交'))`;
  await evaluate(`${commitsTab}.click()`);
  memory("历史续读之后");
  // 9. 混合操作 100 次（范围 / 文件切换）后静置 65 s：内存有界
  const mixedStart = memory("混合操作前");
  let seed = 20260923;
  const rand = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  await evaluate(`window.__op.setInput('按完整相对路径筛选', '')`);
  await measure(`window.__op.scopeButton('未暂存').click()`, `window.__op.footer().includes('未暂存') && !window.__op.loading()`, 30000);
  const mixed = [];
  for (let i = 1; i <= 100; i++) {
    if (rand(3) === 0) { const label = ["未暂存", "已暂存", "全部"][rand(3)]; mixed.push(await measure(`window.__op.scopeButton(${q(label)}).click()`, `window.__op.footer().includes(${q(label)}) && !window.__op.loading()`, 30000)); }
    else { const list = (await evaluate(`window.__op.rows()`)).slice(0, 40); const p = list[rand(list.length)]; if (p) mixed.push(await selectFile(p, `window.__op.tab() === ${q(p)} && !window.__op.loading()`, 60000)); }
    if (i % 25 === 0) memory(`混合 ${i}`);
    await sleep(100);
  }
  record("mixed100", mixed, "L 中 100 次范围 / 文件混合切换");
  await sleep(65000);
  const idle = memory("静置 65 s");
  report.memoryBounded = { beforeMixedTotal: mixedStart.layers.total.privateWorkingSetMiB, idleTotal: idle.layers.total.privateWorkingSetMiB, ratio: Math.round((idle.layers.total.privateWorkingSetMiB / mixedStart.layers.total.privateWorkingSetMiB) * 1000) / 1000 };
  check("L 混合操作并静置 65 s 后实例仍在运行（不崩溃）", alive());
} catch (error) {
  report.failures.push(`异常：${String(error.stack ?? error).slice(0, 800)}`);
  log("异常", error);
} finally {
  report.aliveAtEnd = alive();
  try { app.cdp.close(); } catch { /* 已关闭 */ }
  report.stop = await killOris(app);
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, "large.json"), JSON.stringify(report, null, 2));
  log(`报告：${path.join(outDir, "large.json")}；失败 ${report.failures.length}`);
  await sleep(1000);
  removeDir(runDir, GUI_ROOT);
  process.exitCode = report.failures.length ? 1 : 0;
}
