// 一期 06 RC：AI 功能界面验收（V2 验收 B23–B29，R-AI）。
// - 假模型服务：本脚本内启动的 node HTTP 服务，只监听 127.0.0.1，按场景返回脚本化结果；不调用任何真实模型服务。
// - 假命令行工具：临时目录中的 .cmd，记录收到的参数与工作目录、输出预设结果；不启动用户已安装的 codex / claude。
// - 测试密钥：本轮随机生成，通过 Oris 的设置界面写入 Windows 凭据管理器，条目为“Oris AI”/ oris-test-<运行编号>；
//   结束时通过设置界面删除该配置（同时删除凭据），并用 cmdkey /list 核对没有残留。不读取、不修改用户已有的 AI 配置或凭据。
// - 只经 CDP 操作本轮启动并核验过的 Oris 实例（launchOris：PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API；
//   按键、点击为页面内派发的事件，不是真实键盘、鼠标或 Windows 焦点。
// 用法：node scripts/perf/v1-06-ai-acceptance.mjs --exe <oris.exe> [--run-id 20260928-ai] [--port 9991] [--label v1-06-ai-acceptance] [--keep]
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, externalConnections, killOris, launchOris, machineInfo, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const runId = option("run-id", new Date().toISOString().replace(/\D/g, "").slice(0, 12));
if (!/^[0-9A-Za-z-]{1,60}$/.test(runId)) throw new Error("运行编号只能含字母、数字与 -");
const profileId = `oris-test-${runId}`;
const cliProfileId = `oris-test-${runId}-cli`;
let port = Number(option("port", 9991));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v1-06-ai-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-06-ai-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
// 测试用 API Key：本轮随机生成，不是任何真实服务的密钥；不写进报告与日志（报告只记录其 SHA-256 前缀）。
const testKey = `sk-oris-test-${randomBytes(12).toString("hex")}`;
const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), machine: machineInfo(), runId, profileId, keyFingerprint: sha256Text(testKey).slice(0, 12), startedAt: new Date().toISOString(), method: "CDP 页面事件；假模型服务只监听 127.0.0.1；假命令行工具为临时目录中的 .cmd", checks: [], timings: {}, network: [], failures: [] };
function sha256Text(text) { return createHash("sha256").update(text).digest("hex"); }
const check = (name, ok, detail = null) => { report.checks.push({ name, ok: !!ok, detail }); log(ok ? "✓" : "✗", name); if (!ok) report.failures.push(name); };
const fail = (message) => { report.failures.push(message); log("✗", message); };

// ---------- 夹具 ----------
const repo = path.join(runDir, "repo");
mkdirSync(repo, { recursive: true });
const put = (rel, text) => { const full = path.join(repo, rel); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, text); };
git(repo, ["init", "-q", "-b", "main"]);
for (const [k, v] of [["user.name", "Oris AI Test"], ["user.email", "oris-ai@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, ["config", k, v]);
put("src/app.ts", Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n");
put("docs/readme.md", "# 说明\n\n初始内容\n");
put("notes/todo.md", "- 待办 1\n");
git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
git(repo, ["branch", "feature"]);
let round = 0;
/** 写入一轮新的本地改动（每轮内容不同，避免与已提交的修改相同而没有差异）。 */
const dirty = () => {
  round++;
  put("src/app.ts", Array.from({ length: 30 }, (_, i) => i === 5 ? `export const value5 = ${round}55; // AI 测试修改 ${round}` : `export const value${i} = ${i};`).join("\n") + "\n");
  put("docs/readme.md", "# 说明\n\n修改后的说明（readme 相关改动）\n");
  put("untracked/new-note.txt", `未跟踪文件开头\n${"x".repeat(3000)}\n结尾不应发送\n`);
};
dirty();
git(repo, ["add", "--", "docs/readme.md"]);
const pathId = (rel) => Buffer.from(rel, "utf8").toString("base64url");
report.fixture = { repo };

// ---------- 假模型服务（127.0.0.1） ----------
const requests = [];
let responder = null;
const server = http.createServer((req, res) => {
  let body = "";
  let entry = null;
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    entry = { at: Date.now(), method: req.method, path: req.url, auth: req.headers.authorization ?? null, body: (() => { try { return JSON.parse(body); } catch { return body; } })(), aborted: false, respondedAt: null };
    requests.push(entry);
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "fake-model" }] })); entry.respondedAt = Date.now(); return; }
    const reply = responder ? responder(entry) : { content: JSON.stringify({ kind: "answer", message: "（假模型服务没有预设回复）" }) };
    const send = () => {
      if (entry.aborted) return;
      entry.respondedAt = Date.now();
      if (reply.raw !== undefined) { res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" }); res.end(reply.raw); return; }
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
  });
  // 回复之前连接被关闭：Oris 取消了请求（关闭输入框 / 超时）。
  res.on("close", () => { if (!res.writableEnded && entry) entry.aborted = true; });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const modelPort = server.address().port;
report.fakeServer = { host: "127.0.0.1", port: modelPort };
log(`假模型服务 127.0.0.1:${modelPort}`);
const lastRequest = () => requests.at(-1);
const reply = (value) => { responder = typeof value === "function" ? value : () => value; };
const plan = (value) => ({ content: JSON.stringify(value) });

// ---------- 假命令行工具（临时目录中的 .cmd） ----------
const cliDir = path.join(runDir, "fake-cli");
mkdirSync(cliDir, { recursive: true });
const cliRecord = path.join(cliDir, "record");
mkdirSync(cliRecord, { recursive: true });
const pingMarker = 3000 + (process.pid % 5000);
const fakeCodex = path.join(cliDir, "fake-codex.cmd");
// 解析 --output-last-message 后写入预设结果；mode.txt 为 slow 时先启动一个带唯一标记的孙进程（ping -w <标记>）再等待。
writeFileSync(fakeCodex, [
  "@echo off",
  `cd > "${cliRecord}\\cwd.txt"`,
  `echo %* > "${cliRecord}\\args.txt"`,
  "set OUT=",
  ":loop",
  "if \"%~1\"==\"\" goto done",
  "if \"%~1\"==\"--output-last-message\" set \"OUT=%~2\"",
  "shift",
  "goto loop",
  ":done",
  `set /p MODE=<"${cliRecord}\\mode.txt"`,
  `if "%MODE%"=="slow" ping -n 60 -w ${pingMarker} 127.0.0.1 > nul`,
  `copy /y "${cliRecord}\\result.json" "%OUT%" > nul`,
  "exit /b 0",
  ""
].join("\r\n"));
const fakeClaude = path.join(cliDir, "fake-claude.cmd");
writeFileSync(fakeClaude, ["@echo off", `cd > "${cliRecord}\\claude-cwd.txt"`, `echo %* > "${cliRecord}\\claude-args.txt"`, `type "${cliRecord}\\result.json"`, "exit /b 0", ""].join("\r\n"));
const cliMode = (mode, result) => { writeFileSync(path.join(cliRecord, "mode.txt"), `${mode}\r\n`); writeFileSync(path.join(cliRecord, "result.json"), JSON.stringify(result)); };
const markedPings = () => {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -match ' -w ${pingMarker} ' } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8" });
  return r.stdout.split(/\r?\n/).map((l) => Number(l.trim())).filter(Boolean);
};

// ---------- 进程级网络核对与凭据核对 ----------
const credentialLines = () => {
  const r = spawnSync("cmdkey", ["/list"], { encoding: "utf8" });
  return (r.stdout ?? "").split(/\r?\n/).filter((l) => l.includes("oris-test-"));
};

const H = String.raw`
(() => {
  if (window.__ai) return true;
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const setText = (el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
  window.__ai = {
    dialog: () => document.querySelector('.ai-commit-dialog'),
    input: () => document.querySelector('textarea[aria-label="输入 AI 指令"]'),
    type(text) { const el = window.__ai.input(); el.focus(); setText(el, text); el.setSelectionRange(text.length, text.length); el.dispatchEvent(new Event('select', { bubbles: true })); return true; },
    submit() { document.querySelector('[aria-label="确认 AI 指令"]').click(); return true; },
    error: () => document.querySelector('.ai-commit-dialog [role=alert]')?.textContent ?? '',
    answer: () => document.querySelector('.ai-commit-preview p')?.textContent ?? null,
    busy: () => !!document.querySelector('.ai-input-progress'),
    tags: () => qa('#ai-prompt-options [role=option] span').map((n) => n.textContent),
    open() { document.querySelector('.titlebar .commit-entry').click(); return true; },
    esc() { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; },
    gitTab(prefix) { return qa('.git-tabs button').find((b) => b.textContent.startsWith(prefix)) ?? null; },
    staged() { return Number(/提交 · (\d+)/.exec(window.__ai.gitTab('提交')?.textContent ?? '')?.[1] ?? NaN); },
    branch: () => document.querySelector('.branch-button')?.textContent ?? '',
    opStatus: () => document.querySelector('.op-status')?.textContent ?? '',
    setIn(selector, value) { const el = document.querySelector(selector); if (!el) throw new Error('没有 ' + selector); setText(el, value); return true; }
  };
  return true;
})()`;

let app = null;
async function start(name, seed) {
  app = await launchOris({ exe, profileDir: path.join(runDir, `profile-${name}`), port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, `cache-${name}`) } });
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  app.console = [];
  app.cdp.on("Runtime.consoleAPICalled", (e) => app.console.push((e.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")));
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS + ";" + H });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS); await evaluate(H);
  log(`已启动 ${name} PID ${app.pid}，核验 ${q(app.identity)}`);
  (report.instances ??= []).push({ name, pid: app.pid, identity: app.identity });
  // 设置种子：关闭自动更新检查（与 AI 无关的联网），按场景写入 AI 配置；写入后重新载入页面。
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`(() => { const e = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
  await sleep(300);
  await evaluate(`(() => { const key = 'oris.settings.v1'; const s = JSON.parse(localStorage.getItem(key)); s.update = { ...(s.update ?? {}), autoCheck: false }; const seed = ${q(seed ?? null)}; if (seed) s.ai = { ...s.ai, ...seed }; localStorage.setItem(key, JSON.stringify(s)); return true; })()`);
  await call("Page.reload", {});
  await sleep(1500);
  await evaluate(PAGE_HELPERS); await evaluate(H);
  await waitUntil(`document.querySelector('.project-empty')`);
  await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
  await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
  await evaluate(`window.__op.button('载入/添加').click()`);
  await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`, 60000);
  await sleep(800);
}
const evaluate = (expr, timeout) => app.cdp.evaluate(expr, timeout);
const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
const shot = async (name) => { const file = path.join(shotDir, `${name}.png`); writeFileSync(file, await app.cdp.screenshot()); return path.relative(projectRoot, file); };
const stop = async () => { if (!app) return null; try { app.cdp.close(); } catch { /* 已关闭 */ } const r = await killOris(app); app = null; return r; };
const refresh = async () => { await evaluate(`window.__op.button('↻ 本地刷新').click()`); await sleep(300); await waitUntil(`!window.__op.loading() && !document.querySelector('.op-status.running')`, 30000); await sleep(600); };
/** 打开输入框、输入并发送；返回发送时刻（页面 epoch 毫秒）。 */
const send = async (text) => {
  if (!(await evaluate(`!!window.__ai.dialog()`))) { await evaluate(`window.__ai.open()`); await waitUntil(`!!window.__ai.input()`); }
  await evaluate(`window.__ai.type(${q(text)})`);
  await sleep(100);
  return evaluate(`(() => { window.__ai.submit(); return performance.timeOrigin + performance.now(); })()`);
};
/** 等到本次指令结束：输入框关闭（执行成功）、显示错误或显示回答。 */
const settleAi = (timeout = 30000) => waitUntil(`!window.__ai.busy() && (!window.__ai.dialog() || window.__ai.error() || window.__ai.answer() !== null)`, timeout);
const closeAi = async () => { if (await evaluate(`!!window.__ai.dialog()`)) { await evaluate(`window.__ai.esc()`); await sleep(200); } };
const fp = () => repositoryFingerprint(repo);

try {
  // ================= B23：未配置 AI =================
  await start("unconfigured", null);
  const netStart = externalConnections(app.pid);
  await sleep(6000); // 启动 5 s 后的自动更新检查已关闭；在其时点之后再核对一次
  await evaluate(`window.__op.row('src/app.ts').click()`);
  await waitUntil(`window.__op.readyFor('src/app.ts', null) === true`, 20000);
  const beforeCount = requests.length;
  const opened = await evaluate(`window.__op.measure(() => window.__ai.open(), () => document.activeElement === window.__ai.input(), 5000)`);
  await evaluate(`window.__ai.type('暂存所有文件')`); await evaluate(`window.__ai.submit()`);
  await waitUntil(`!!window.__ai.error()`, 10000);
  const unconfiguredError = await evaluate(`window.__ai.error()`);
  await closeAi();
  // 快捷键打开
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }))`);
  const byShortcut = await evaluate(`window.__op.waitUntil(() => !!window.__ai.input(), 3000)`);
  await closeAi();
  const netEnd = externalConnections(app.pid);
  report.network.push({ phase: "未配置 AI：启动 → 打开项目 → 阅读 → 打开 AI 入口并发送指令", start: netStart, end: netEnd });
  check("B23 未配置 AI：入口可见（按钮与 Ctrl+P），发送指令只给出配置说明", opened.ok && byShortcut.ok && unconfiguredError.includes("请在设置 → AI 中选择已配置模型的 AI 组合"), { unconfiguredError, openMs: opened.ms });
  check("B23 未配置 AI：没有发出任何 AI 请求（假模型服务未收到请求）", requests.length === beforeCount, { requests: requests.length - beforeCount });
  // Oris 与 Git 自身不应有任何对外连接；WebView2 运行时进程自身的连接单独列出（不经 Oris 代码发起）。
  const own = [...netStart.external, ...netEnd.external].filter((c) => !String(c.role).startsWith("webview"));
  const webview = [...netStart.external, ...netEnd.external].filter((c) => String(c.role).startsWith("webview"));
  check("B23 未配置 AI：Oris 与 Git 子进程没有对外 TCP 连接，也没有 codex / claude 进程", own.length === 0 && !netStart.codexOrClaude && !netEnd.codexOrClaude, { own, netStart, netEnd });
  check("B23 未配置 AI：WebView2 运行时进程也没有对外 TCP 连接", webview.length === 0, { webview });
  report.timings.openAiInput = opened;
  report.stopUnconfigured = await stop();

  // ================= 配置 AI（兼容接口 → 假模型服务） =================
  const apiProfile = { id: profileId, name: "Oris 测试（假模型服务）", kind: "api", provider: "compatible", executable: "", baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: "fake-model", hasKey: false };
  const cliProfile = { id: cliProfileId, name: "Oris 测试（假 CLI）", kind: "cli", provider: "codex", executable: fakeCodex, baseUrl: "", model: "fake-model", hasKey: false };
  const claudeProfile = { id: `${cliProfileId}-claude`, name: "Oris 测试（假 Claude CLI）", kind: "cli", provider: "claude", executable: fakeClaude, baseUrl: "", model: "claude-haiku-4-5", hasKey: false };
  await start("configured", { profiles: [apiProfile, cliProfile, claudeProfile], activeId: "" });
  // B24：通过设置界面保存密钥（写入系统凭据存储）
  const credentialsBefore = credentialLines();
  await evaluate(`document.querySelector('button[aria-label="设置"]').click()`);
  await waitUntil(`!!document.querySelector('.settings-nav')`);
  await evaluate(`[...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === 'AI').click()`);
  await waitUntil(`!!document.querySelector('[aria-label="编辑 ${apiProfile.name}"]')`);
  await evaluate(`document.querySelector('[aria-label="编辑 ${apiProfile.name}"]').click()`);
  await sleep(200);
  await evaluate(`window.__ai.setIn('#ai-key', ${q(testKey)})`);
  await evaluate(`[...document.querySelectorAll('.ai-settings button')].find((b) => b.textContent === '保存密钥').click()`);
  await waitUntil(`document.querySelector('#ai-key')?.placeholder.includes('已保存')`, 10000);
  await evaluate(`document.querySelector('[aria-label="使用 ${apiProfile.name}"]').click()`);
  await sleep(200);
  const credentialsAfter = credentialLines();
  const settingsText = await evaluate(`localStorage.getItem('oris.settings.v1')`);
  check("B24 密钥经设置界面写入系统凭据存储（Oris AI / 配置 ID），设置中只记录已保存", credentialsAfter.some((l) => l.includes(profileId)) && !credentialsBefore.some((l) => l.includes(profileId)) && JSON.parse(settingsText).ai.profiles.find((p) => p.id === profileId)?.hasKey === true && !settingsText.includes(testKey), { credentialsAfter: credentialsAfter.map((l) => l.replace(/\s+/g, " ").trim()) });
  await evaluate(`document.querySelector('button[aria-label="关闭设置"]').click()`);
  await sleep(300);

  // 入口时延（已配置）
  const openSamples = [];
  for (let i = 0; i < 10; i++) {
    openSamples.push(await evaluate(`window.__op.measure(() => window.__ai.open(), () => document.activeElement === window.__ai.input(), 5000)`));
    await closeAi(); await sleep(150);
  }
  report.timings.openAiInput = { samples: openSamples, summary: summarize(openSamples), what: "点击“✦ AI”到输入框获得焦点（可输入）的下一帧；无预算，只记录" };

  // 标签候选与插入
  await evaluate(`window.__ai.open()`); await waitUntil(`!!window.__ai.input()`);
  await evaluate(`window.__ai.type('@')`); await sleep(150);
  const allTags = await evaluate(`window.__ai.tags()`);
  await evaluate(`window.__ai.type('@G')`); await sleep(150);
  const gTags = await evaluate(`window.__ai.tags()`);
  await evaluate(`window.__ai.input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`); await sleep(200);
  const inserted = await evaluate(`window.__ai.input().value`);
  await evaluate(`window.__ai.type('邮箱 a@b 不是标签')`); await sleep(150);
  const noTag = await evaluate(`window.__ai.tags()`);
  check("B26 @ 标签候选：@ 列出 5 个提示词包，@G 只剩 @Git，Enter 插入“@Git ”；正文中的 @ 不弹出候选", allTags.length === 5 && gTags.length === 1 && gTags[0] === "@Git" && inserted === "@Git " && noTag.length === 0, { allTags, gTags, inserted, noTag });
  await closeAi();

  // ---------- 有效计划直接执行 ----------
  const settings = JSON.parse(await evaluate(`localStorage.getItem('oris.settings.v1')`));
  const prompts = settings.ai.prompts;
  const execTimings = [];
  const runPlan = async (name, text, value, done) => {
    reply(plan(value));
    const before = fp();
    const sentAt = await send(text);
    await settleAi(30000);
    const req = lastRequest();
    const doneResult = await evaluate(`window.__op.waitUntil(() => (${done}), 20000)`, 25000);
    const doneAt = await evaluate(`performance.timeOrigin + performance.now()`);
    const error = await evaluate(`window.__ai.error()`);
    await closeAi();
    await sleep(500);
    const after = fp();
    execTimings.push({ name, ok: doneResult.ok, ms: req?.respondedAt ? doneAt - req.respondedAt : null, sentToDoneMs: doneAt - sentAt });
    return { req, error, ok: doneResult.ok && !error, changed: diffFingerprints(before, after) };
  };
  // 暂存全部（@Git：加载 Git 提示词；上下文中没有 Git 设置与密钥）
  const stage = await runPlan("暂存全部", "@Git 暂存全部改动", { kind: "git", summary: "暂存全部", operation: { kind: "stage", pathIds: "all" } }, `window.__ai.staged() === 3`);
  const system = stage.req?.body?.messages?.[0]?.content ?? "";
  const user = stage.req?.body?.messages?.[1]?.content ?? "";
  check("B26 @Git 只加载提示词：发送的系统提示包含操作中心与 @Git 提示词，用户输入原样传递", system.includes(prompts.commandCenter) && system.includes(prompts.gitActions) && !system.includes(prompts.merge) && user.includes("用户输入：\n@Git 暂存全部改动"), { systemLength: system.length });
  check("B26 / B27 有效计划直接执行（暂存全部），不弹出二次确认；只改变 index", stage.ok && stage.changed.every((k) => k === ".git/index"), { changed: stage.changed, error: stage.error });
  check("B24 / B25 规划请求带密钥（只在 Authorization 头中），上下文不含密钥与 Git 可执行文件设置", stage.req?.auth === `Bearer ${testKey}` && !JSON.stringify(stage.req.body).includes(testKey) && !user.includes("gitSetting"), { auth: stage.req?.auth ? "Bearer <测试密钥>" : null });
  const unstage = await runPlan("取消暂存全部", "取消暂存全部", { kind: "git", summary: "取消暂存", operation: { kind: "unstage", pathIds: "all" } }, `window.__ai.staged() === 0`);
  check("B27 有效计划：取消暂存全部，只改变 index", unstage.ok && unstage.changed.every((k) => k === ".git/index"), { changed: unstage.changed });
  git(repo, ["add", "--", "src/app.ts"]); await refresh();
  const headBefore = git(repo, ["rev-parse", "HEAD"]);
  const commit = await runPlan("提交", "提交已暂存的改动", { kind: "git", summary: "提交", operation: { kind: "commit", message: "AI 测试提交：修改 value5" } }, `window.__ai.staged() === 0`);
  const headAfter = git(repo, ["rev-parse", "HEAD"]);
  const subject = git(repo, ["log", "-1", "--format=%s"]);
  check("B27 有效计划：提交，提交信息来自计划；工作区文件不变（B16 / B17：只有 index、HEAD 所在分支变化）", commit.ok && headAfter !== headBefore && subject === "AI 测试提交：修改 value5" && commit.changed.every((k) => k === ".git/index" || k === ".git/refs/heads/main" || k === ".git/COMMIT_EDITMSG" || k === ".git/ORIG_HEAD"), { changed: commit.changed, subject });
  const switched = await runPlan("切换分支", "切到 feature 分支", { kind: "git", summary: "切换分支", operation: { kind: "branchSwitch", name: "refs/heads/feature" } }, `window.__ai.branch().includes('feature')`);
  check("B27 有效计划：切换分支（HEAD 指向 feature）", switched.ok && git(repo, ["symbolic-ref", "HEAD"]) === "refs/heads/feature", { changed: switched.changed.slice(0, 10), error: switched.error });
  git(repo, ["switch", "-q", "main"]); await refresh();
  const font = await runPlan("设置字号", "@设置 字号调到 15", { kind: "settings", summary: "字号 15", setting: "fontSize", value: 15 }, `getComputedStyle(document.querySelector('.cm-content') ?? document.body).fontSize === '15px' || JSON.parse(localStorage.getItem('oris.settings.v1')).appearance.fontSize === 15`);
  check("B26 @设置：设置计划直接执行（字号 15），仓库不变", font.ok && font.changed.length === 0 && (font.req?.body?.messages?.[0]?.content ?? "").includes(prompts.settingsActions), { changed: font.changed });
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }))`);
  report.timings.planToRefresh = { samples: execTimings, summary: summarize(execTimings.filter((x) => x.ms !== null)), what: "假模型服务发出回复 → 操作完成且界面刷新（扣除模型响应时间）；无预算，只记录" };

  // ---------- 拦截（执行前拦下，不部分执行） ----------
  const intercept = async (name, text, value, expected, extra = {}) => {
    reply(value.raw !== undefined || value.content !== undefined || value.status ? value : plan(value));
    const before = fp();
    const count = requests.length;
    await send(text);
    await settleAi(20000);
    const error = await evaluate(`window.__ai.error()`);
    const answer = await evaluate(`window.__ai.answer()`);
    await closeAi();
    await sleep(400);
    const changed = diffFingerprints(before, fp());
    const sent = requests.length - count;
    const ok = (expected ? error.includes(expected) : answer !== null) && changed.length === 0 && sent === (extra.requests ?? 1);
    check(name, ok, { error, answer, changed, requests: sent });
    return { error, answer, changed };
  };
  await intercept("B26 @Git 单独发送、模型只回答：显示回答，不写入", "@Git", { kind: "answer", message: "请说明要执行的 Git 操作" }, null);
  await intercept("B26 模型输出不是有效 JSON：说明原因，不执行", "暂存 readme", { content: "好的，我会帮你暂存 readme。" }, "AI 未按要求返回 JSON");
  await intercept("B26 越权：不在白名单的 Git 操作（reset --hard）被拦下", "硬重置到上一个提交", { kind: "git", operation: { kind: "reset", mode: "hard", target: "HEAD~1" } }, "不支持的 Git 操作");
  await intercept("B26 越权：未实现的能力（shell 命令）被拦下", "运行 rm -rf", { kind: "shell", command: "rm -rf ." }, "尚未实现");
  await intercept("B26 越权（V2-D67）：修改 Git 可执行文件路径被拦下", "@设置 把 Git 路径改成 C:/evil/git.exe", { kind: "settings", setting: "gitExecutable", value: "C:/evil/git.exe" }, "AI 不能修改 Git 可执行文件路径");
  await intercept("B26 不存在的 pathId：执行前拦下", "暂存 ghost.txt", { kind: "git", operation: { kind: "stage", pathIds: [pathId("ghost.txt")] } }, "文件状态已变化");
  // 过期 revision：模型回复之前仓库发生变化（外部修改 + 手动刷新）
  {
    reply({ ...plan({ kind: "git", operation: { kind: "stage", pathIds: [pathId("docs/readme.md")] } }), delayMs: 4000 });
    const count = requests.length;
    await send("暂存 readme");
    await sleep(800);
    put("notes/todo.md", "- 待办 1\n- 规划期间的外部修改\n");
    await evaluate(`window.__op.button('↻ 本地刷新').click()`);
    await settleAi(20000);
    const error = await evaluate(`window.__ai.error()`);
    await closeAi();
    const stagedReadme = git(repo, ["diff", "--cached", "--name-only"]).includes("docs/readme.md");
    check("B26 过期 revision：规划期间仓库已变化，执行前拦下并要求重新规划，不部分执行", error.includes("仓库状态已变化") && !stagedReadme && requests.length - count === 1, { error });
  }
  // V2-D68：超过 50 MiB 的未跟踪文件，AI 丢弃需要确认 → 停止并说明
  {
    const big = path.join(repo, "big", "huge.bin");
    mkdirSync(path.dirname(big), { recursive: true });
    writeFileSync(big, Buffer.alloc(51 * 1024 * 1024, 7));
    await refresh();
    await intercept("B26 / V2-D68：不可撤销的丢弃（超过 50 MiB）停止并说明，文件保留（模型带的 confirmedUnrecoverable 被丢弃）", "丢弃 huge.bin", { kind: "git", operation: { kind: "discard", scope: "unstaged", pathIds: [pathId("big/huge.bin")], confirmedUnrecoverable: true } }, "AI 不代替你确认");
    check("V2-D68 丢弃被停止后大文件仍在", existsSync(big) && statSync(big).size === 51 * 1024 * 1024);
    removeDir(path.dirname(big), runDir);
    await refresh();
  }
  // 外部 index.lock：AI 写操作与普通按钮同样报错、不删除锁（B16）
  {
    const lock = path.join(repo, ".git", "index.lock");
    writeFileSync(lock, "");
    const r = await intercept("B16 / B27 外部 index.lock：AI 暂存与普通入口一样报错、不删除锁、不重试", "暂存 readme", { kind: "git", operation: { kind: "stage", pathIds: [pathId("docs/readme.md")] } }, "index.lock");
    check("B16 外部 index.lock 未被删除", existsSync(lock), r);
    try { unlinkSync(lock); } catch { /* 已清理 */ }
    await refresh();
  }

  // ---------- 取消与错误说明（B29） ----------
  {
    reply({ ...plan({ kind: "answer", message: "不应显示" }), delayMs: 15000 });
    const count = requests.length;
    await send("解释当前改动");
    await sleep(800);
    const t0 = Date.now();
    await evaluate(`window.__ai.esc()`);
    let aborted = false;
    for (let i = 0; i < 40 && !aborted; i++) { await sleep(100); aborted = requests.at(-1)?.aborted === true; }
    check("B29 关闭输入框中止 HTTP 模型调用（服务端看到连接关闭），不执行", requests.length - count === 1 && aborted && !(await evaluate(`!!window.__ai.dialog()`)), { abortedAfterMs: Date.now() - t0 });
  }
  for (const [status, expected] of [[401, "拒绝了请求（HTTP 401）"], [429, "限流或额度不足（HTTP 429）"]]) {
    await intercept(`B29 HTTP ${status}：中文说明，不自动重试`, "暂存 readme", { status, raw: JSON.stringify({ error: { message: "fake" } }) }, expected);
  }
  await intercept("B29 响应不是 JSON：中文说明，不自动重试", "暂存 readme", { raw: "<html>gateway</html>" }, "AI 响应不是 JSON");

  // ---------- AI 提交辅助与描述驱动提交（B25 发送内容） ----------
  {
    git(repo, ["reset", "-q"]); dirty(); git(repo, ["add", "--", "docs/readme.md"]); await refresh();
    await evaluate(`window.__ai.gitTab('提交').classList.contains('active') || window.__ai.gitTab('提交').click()`);
    await sleep(300);
    reply(plan({ message: "docs: 更新说明" }));
    const count = requests.length;
    await evaluate(`document.querySelector('button[aria-label="根据暂存内容生成提交信息"]').click()`);
    await waitUntil(`document.querySelector('textarea[aria-label="提交信息"]').value === 'docs: 更新说明'`, 20000);
    const req = requests.at(-1);
    const text = req?.body?.messages?.[1]?.content ?? "";
    check("B25 生成提交信息：只发送已暂存的文件与改动（readme），不发送未暂存 / 未跟踪内容；结果只填入输入框、不提交", requests.length - count === 1 && text.includes("docs/readme.md") && text.includes("修改后的说明") && !text.includes("AI 测试修改") && !text.includes("未跟踪文件开头") && git(repo, ["rev-parse", "HEAD"]) === headAfter, { length: text.length });
    await evaluate(`window.__ai.setIn('textarea[aria-label="提交信息"]', '')`);
  }
  {
    // 超出预算：已暂存一个大文件（约 150 KB 的差异），发送内容截断并注明
    put("big-text/large.txt", Array.from({ length: 4000 }, (_, i) => `第 ${i} 行：${"内容".repeat(10)}`).join("\n") + "\n");
    git(repo, ["add", "--", "big-text/large.txt"]); await refresh();
    reply(plan({ message: "chore: 大文件" }));
    await evaluate(`document.querySelector('button[aria-label="根据暂存内容生成提交信息"]').click()`);
    await waitUntil(`document.querySelector('textarea[aria-label="提交信息"]').value === 'chore: 大文件'`, 20000);
    const text = requests.at(-1)?.body?.messages?.[1]?.content ?? "";
    check("B25 超出内容预算：已暂存改动截断并在发送内容中注明“[后续差异已截断]”", text.includes("[后续差异已截断]") && text.length < 120_000, { length: text.length });
    await evaluate(`window.__ai.setIn('textarea[aria-label="提交信息"]', '')`);
    git(repo, ["reset", "-q", "--", "big-text/large.txt"]);
    removeDir(path.join(repo, "big-text"), runDir);
    await refresh();
  }
  {
    // 描述驱动提交：规划返回 commitSelected，生成返回 readme 的编号
    let step = 0;
    let candidatePrompt = "";
    reply((entry) => {
      step++;
      if (step === 1) return plan({ kind: "commitSelected", summary: "按描述提交" });
      candidatePrompt = entry.body?.messages?.[1]?.content ?? "";
      const list = JSON.parse(/候选文件（index 从 1 开始）：\n(\[.*?\])\n/s.exec(candidatePrompt)?.[1] ?? "[]");
      const readme = list.find((c) => c.path === "docs/readme.md");
      return plan({ message: "docs: 按描述提交 readme", fileIndices: readme ? [readme.index] : [] });
    });
    const before = fp();
    const head = git(repo, ["rev-parse", "HEAD"]);
    await send("@提交 提交 readme 相关改动");
    await settleAi(30000);
    const error = await evaluate(`window.__ai.error()`);
    await closeAi(); await sleep(600);
    const committed = git(repo, ["show", "--name-only", "--format=%s", "HEAD"]);
    const changed = diffFingerprints(before, fp());
    check("B25 描述驱动提交：发送候选文件列表、已暂存与未暂存改动、未跟踪文件开头（不超过 2 KB）", candidatePrompt.includes("docs/readme.md") && candidatePrompt.includes("src/app.ts") && candidatePrompt.includes("AI 测试修改") && candidatePrompt.includes("未跟踪文件开头") && !candidatePrompt.includes("结尾不应发送"), { length: candidatePrompt.length });
    check("B27 描述驱动提交：只提交模型选中的整文件（readme），其他改动保留在工作区", !error && git(repo, ["rev-parse", "HEAD"]) !== head && committed.startsWith("docs: 按描述提交 readme") && committed.includes("docs/readme.md") && !committed.includes("src/app.ts") && !changed.some((k) => !k.startsWith(".git")), { committed, changed: changed.filter((k) => !k.startsWith(".git")), error });
  }

  // ---------- 命令行工具路径（B28、B29） ----------
  {
    await evaluate(`(() => { const key = 'oris.settings.v1'; const s = JSON.parse(localStorage.getItem(key)); return s.ai.activeId; })()`);
    // 切换当前组合为假 CLI（通过 AI 设置计划也可，此处直接在设置中选择）
    await evaluate(`document.querySelector('button[aria-label="设置"]').click()`);
    await waitUntil(`!!document.querySelector('.settings-nav')`);
    await evaluate(`[...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === 'AI').click()`);
    await waitUntil(`!!document.querySelector('[aria-label="使用 ${cliProfile.name}"]')`);
    await evaluate(`document.querySelector('[aria-label="使用 ${cliProfile.name}"]').click()`);
    await evaluate(`document.querySelector('button[aria-label="关闭设置"]').click()`);
    await sleep(300);
    cliMode("fast", { kind: "answer", message: "来自假 CLI 的回答" });
    const count = requests.length;
    await send("解释当前改动");
    await settleAi(30000);
    const answer = await evaluate(`window.__ai.answer()`);
    const error = await evaluate(`window.__ai.error()`);
    await closeAi();
    const cwd = existsSync(path.join(cliRecord, "cwd.txt")) ? readFileSync(path.join(cliRecord, "cwd.txt"), "utf8").trim() : "";
    const argv = existsSync(path.join(cliRecord, "args.txt")) ? readFileSync(path.join(cliRecord, "args.txt"), "utf8") : "";
    const temp = process.env.TEMP ?? "";
    check("B28 命令行工具：假 codex 在临时目录运行（不在用户仓库），参数含 exec / --sandbox read-only / --ephemeral / --skip-git-repo-check", answer === "来自假 CLI 的回答" && requests.length === count && cwd && !cwd.toLowerCase().startsWith(repo.toLowerCase()) && cwd.toLowerCase().startsWith(path.resolve(temp).toLowerCase().slice(0, 3)) && /exec/.test(argv) && argv.includes("--sandbox read-only") && argv.includes("--ephemeral") && argv.includes("--skip-git-repo-check"), { cwd, argv: argv.slice(0, 300), error });
    cliMode("slow", { kind: "answer", message: "不应显示" });
    await send("解释当前改动");
    let started = false;
    for (let i = 0; i < 50 && !started; i++) { await sleep(200); started = markedPings().length > 0; }
    await evaluate(`window.__ai.esc()`);
    await sleep(1500);
    const left = markedPings();
    for (const pid of left) spawnSync("taskkill", ["/F", "/PID", String(pid)]);
    check("B29 关闭输入框中止命令行工具：cmd.exe 与其启动的子进程全部结束", started && left.length === 0, { started, left });
    // 假 Claude Code：结果写到 stdout；参数不提供任何工具、单轮、不保存会话。
    await evaluate(`document.querySelector('button[aria-label="设置"]').click()`);
    await waitUntil(`!!document.querySelector('.settings-nav')`);
    await evaluate(`[...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === 'AI').click()`);
    await waitUntil(`!!document.querySelector('[aria-label="使用 ${claudeProfile.name}"]')`);
    await evaluate(`document.querySelector('[aria-label="使用 ${claudeProfile.name}"]').click()`);
    await evaluate(`document.querySelector('button[aria-label="关闭设置"]').click()`);
    await sleep(300);
    cliMode("fast", { kind: "answer", message: "来自假 Claude 的回答" });
    await send("解释当前改动");
    await settleAi(30000);
    const claudeAnswer = await evaluate(`window.__ai.answer()`);
    const claudeError = await evaluate(`window.__ai.error()`);
    await closeAi();
    const claudeCwd = existsSync(path.join(cliRecord, "claude-cwd.txt")) ? readFileSync(path.join(cliRecord, "claude-cwd.txt"), "utf8").trim() : "";
    const claudeArgs = existsSync(path.join(cliRecord, "claude-args.txt")) ? readFileSync(path.join(cliRecord, "claude-args.txt"), "utf8") : "";
    check("B28 命令行工具：假 claude 在临时目录运行，参数含 -p / --tools \"\" / --disallowedTools mcp__* / --max-turns 1 / --no-session-persistence", claudeAnswer === "来自假 Claude 的回答" && claudeCwd && !claudeCwd.toLowerCase().startsWith(repo.toLowerCase()) && claudeArgs.includes("-p") && /--tools ""/.test(claudeArgs) && claudeArgs.includes("mcp__*") && claudeArgs.includes("--max-turns 1") && claudeArgs.includes("--no-session-persistence"), { claudeCwd, claudeArgs: claudeArgs.slice(0, 300), claudeError });
  }

  // ---------- 密钥不落地（B24）与删除配置时删除凭据 ----------
  {
    await evaluate(`window.__ai.gitTab('操作输出')?.click()`);
    await sleep(300);
    const outputText = await evaluate(`document.body.innerText`);
    const localStorageAll = await evaluate(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))`);
    const scanDirs = [path.join(runDir, "profile-configured"), path.join(runDir, "cache-configured")];
    const hits = [];
    const scan = (dir) => { if (!existsSync(dir)) return; for (const name of readdirSync(dir)) { const full = path.join(dir, name); const st = statSync(full); if (st.isDirectory()) scan(full); else if (st.size < 64 * 1024 * 1024) { try { const buf = readFileSync(full); if (buf.includes(testKey) || buf.includes(Buffer.from(testKey, "utf16le"))) hits.push(path.relative(runDir, full)); } catch { /* 被占用的文件跳过 */ } } } };
    for (const dir of scanDirs) scan(dir);
    check("B24 密钥不出现在 localStorage、应用缓存 / 快照、WebView 用户目录文件、控制台日志、界面文本（含操作输出）中", !localStorageAll.includes(testKey) && !outputText.includes(testKey) && !app.console.join("\n").includes(testKey) && hits.length === 0, { hits, consoleLines: app.console.length });
    await evaluate(`document.querySelector('button[aria-label="设置"]').click()`);
    await waitUntil(`!!document.querySelector('.settings-nav')`);
    await evaluate(`[...document.querySelectorAll('.settings-nav button')].find((b) => b.textContent === 'AI').click()`);
    await waitUntil(`!!document.querySelector('[aria-label="删除 ${apiProfile.name} 配置"]')`);
    await evaluate(`document.querySelector('[aria-label="删除 ${apiProfile.name} 配置"]').click()`);
    await sleep(800);
    await evaluate(`document.querySelector('[aria-label="删除 ${cliProfile.name} 配置"]')?.click()`);
    await sleep(300);
    await evaluate(`document.querySelector('[aria-label="删除 ${claudeProfile.name} 配置"]')?.click()`);
    await sleep(500);
    const credentialsLeft = credentialLines();
    check("B24 删除配置时同时删除凭据（cmdkey /list 不再有 oris-test 条目）", !credentialsLeft.some((l) => l.includes(profileId)), { credentialsLeft });
  }
} catch (error) {
  fail(`异常：${String(error.stack ?? error).slice(0, 1200)}`);
  try { if (app) report.failureShot = await shot("failure"); } catch { /* ignore */ }
} finally {
  report.stop = await stop();
  server.close();
  // 兜底清理：本轮写入的凭据若仍在（例如中途失败），按目标名删除；只删除 oris-test-<本轮编号> 条目。
  const left = credentialLines().filter((l) => l.includes(profileId));
  for (const line of left) {
    const target = /[:：]\s*(.+)$/.exec(line)?.[1]?.trim();
    if (target && target.includes(profileId)) spawnSync("cmdkey", [`/delete:${target}`], { encoding: "utf8" });
  }
  report.credentialsAfterCleanup = credentialLines().filter((l) => l.includes(profileId));
  for (const pid of markedPings()) spawnSync("taskkill", ["/F", "/PID", String(pid)]);
  report.requests = requests.map((r) => ({ at: r.at, path: r.path, aborted: r.aborted, respondedAt: r.respondedAt }));
  report.finishedAt = new Date().toISOString();
  const passed = report.checks.filter((c) => c.ok).length;
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  log(`检查 ${report.checks.length} 项，通过 ${passed}，失败 ${report.failures.length}；报告 ${path.join(outDir, "report.json")}`);
  if (!args.includes("--keep")) { await sleep(800); removeDir(runDir, GUI_ROOT); }
  process.exitCode = report.failures.length ? 1 : 0;
}
