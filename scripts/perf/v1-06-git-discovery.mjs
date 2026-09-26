// 一期 06 Git 发现与版本验收（A15 的 Windows 部分）：GUI 环境 PATH 自动发现、缺 Git、手动指定路径、低于 2.31.0 的版本。
// 只修改本轮测试实例进程自己的环境变量（PATH）与独立的 WebView2 profile / 应用缓存，不修改系统 PATH，不安装或卸载 Git。
// “低版本 Git”是测试目录下用 rustc 编译的 git.exe，只对 --version 输出 2.30.2，其余参数直接失败退出。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（PID + 完整路径 + 主窗口句柄 + 端口归属），不调用任何窗口激活 API。
// 用法：node scripts/perf/v1-06-git-discovery.mjs --exe <oris.exe> [--port 9841] [--label v1-06-git-discovery]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, git } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, killOris, launchOris, removeDir, sleep } from "./gui-lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
let port = Number(option("port", 9841));
const label = option("label", "v1-06-git-discovery");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", label);
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-06-git-discovery-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;
const report = { exe, method: "CDP 页面事件；PATH 只作用于测试实例进程", environment: {}, checks: {}, failures: [] };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (ok) log("✓", name); else fail(`${name} ${detail === undefined ? "" : JSON.stringify(detail)}`); };

// ---------- 环境 ----------
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const ps = (command) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }).stdout.trim();
// 资源管理器启动的程序得到的是注册表中的 Machine + User PATH（不含开发终端追加的目录）。
const guiPath = ps("[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')");
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const noGitPath = [path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";");
const whereGit = (pathValue) => spawnSync("where.exe", ["git"], { encoding: "utf8", env: { ...process.env, [pathKey]: pathValue } }).stdout.trim().split(/\r?\n/).filter(Boolean);
const realGit = whereGit(guiPath)[0] ?? null;
report.environment = { guiPathGit: whereGit(guiPath), noGitPathGit: whereGit(noGitPath), noGitPath };
check("环境：注册表 PATH 能找到 git.exe，精简 PATH 找不到", !!realGit && whereGit(noGitPath).length === 0, report.environment);

// 低版本 Git（只回答 --version）
const fakeDir = path.join(runDir, "old-git");
mkdirSync(fakeDir, { recursive: true });
const fakeSource = path.join(fakeDir, "fake_git.rs");
writeFileSync(fakeSource, `fn main() {\n    let args: Vec<String> = std::env::args().skip(1).collect();\n    if args.len() == 1 && args[0] == "--version" { println!("git version 2.30.2.windows.1"); return; }\n    eprintln!("fake old git: unsupported arguments {:?}", args);\n    std::process::exit(128);\n}\n`);
const fakeGit = path.join(fakeDir, "git.exe");
const build = spawnSync("rustc", ["-O", "-o", fakeGit, fakeSource], { encoding: "utf8" });
check("环境：低版本 Git 模拟程序已编译并输出 2.30.2", build.status === 0 && spawnSync(fakeGit, ["--version"], { encoding: "utf8" }).stdout.includes("2.30.2"), { status: build.status, stderr: build.stderr?.slice(0, 500) });
report.environment.fakeGit = fakeGit;
report.environment.realGit = realGit;

// ---------- 夹具 ----------
const repo = path.join(runDir, "repo 中文");
mkdirSync(repo, { recursive: true });
writeFileSync(path.join(repo, "a.txt"), "one\n");
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "base"]);
writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");

async function start(profile, pathValue) {
  const app = await launchOris({ exe, profileDir: path.join(runDir, "profiles", profile), port: port++, log, extraEnv: { [pathKey]: pathValue, ORIS_APP_CACHE_DIR: path.join(runDir, "profiles", `${profile}-cache`) } });
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate(PAGE_HELPERS);
  log(`已启动 PID ${app.pid}（${profile}），核验 ${q(app.identity)}`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const click = (expr) => evaluate(`(() => { const n = ${expr}; if (!n) throw new Error('找不到元素：' + ${q(expr)}); n.click(); return true; })()`);
  const shot = async (name) => { await sleep(250); const { data } = await call("Page.captureScreenshot", { format: "png" }); const file = path.join(shotDir, `${name}.png`); writeFileSync(file, Buffer.from(data, "base64")); return file; };
  const addRepo = async () => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await click(`window.__op.button('载入/添加')`);
    await waitUntil(`!window.__op.loading() && (window.__op.rows().length > 0 || document.querySelector('.state.error'))`, 30000);
    return evaluate(`({ rows: window.__op.rows(), error: document.querySelector('.state.error')?.textContent ?? null, footer: document.querySelector('.diff-footer')?.textContent ?? '' })`);
  };
  const openGitSettings = async () => {
    await click(`document.querySelector('button[aria-label="设置"]')`);
    await waitUntil(`document.querySelector('.settings-dialog')`);
    await click(`[...document.querySelectorAll('.settings-nav button')].find((n) => n.textContent === 'Git')`);
    await waitUntil(`document.querySelector('#settings-git')`);
    return evaluate(`[...document.querySelectorAll('.git-facts dd')].map((n) => n.textContent)`);
  };
  // 每次校验的结果文字都不同（路径 / 版本不同）；等结果变化后再读，避免读到上一次的结果。
  const resultText = `(document.querySelector('.settings-ok') ?? document.querySelector('.settings-error'))?.textContent ?? ''`;
  const typeGit = async (value) => {
    const previous = await evaluate(resultText);
    await evaluate(`(() => { const f = document.querySelector('#settings-git'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, ${q(value)}); f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await waitUntil(`(${resultText}) !== '' && (${resultText}) !== ${q(previous)} && !document.querySelector('.settings-page')?.textContent.includes('正在校验')`, 15000);
    return evaluate(`({ ok: document.querySelector('.settings-ok')?.textContent ?? null, error: document.querySelector('.settings-error')?.textContent ?? null, facts: [...document.querySelectorAll('.git-facts dd')].map((n) => n.textContent) })`);
  };
  const closeSettings = () => click(`document.querySelector('button[aria-label="关闭设置"]')`);
  return { app, evaluate, waitUntil, click, shot, addRepo, openGitSettings, typeGit, closeSettings };
}
async function stop(s) { try { s.app.cdp.close(); } catch { /* 已关闭 */ } const r = await killOris(s.app); log(`实例 ${s.app.pid} 已结束：${r.how}`); }

let current = null;
try {
  // 1. GUI 环境的 PATH：自动发现系统 Git
  current = await start("gui-path", guiPath);
  let result = await current.addRepo();
  let facts = await current.openGitSettings();
  check("A15 GUI 环境 PATH：自动发现系统 Git 并打开仓库", result.rows.includes("a.txt") && !result.error && /Git \d/.test(result.footer) && facts[0].includes("自动发现") && /\d+\.\d+/.test(facts[1]), { result, facts, shot: await current.shot("gui-path") });
  await stop(current); current = null;

  // 2. 缺 Git：明确提示；手动指定路径后可用，并在重启后保留
  current = await start("no-git", noGitPath);
  result = await current.addRepo();
  const missingShot = await current.shot("no-git-open");
  check("A15 缺 Git：打开仓库时明确提示找不到 Git 与处理方法（安装 2.31.0+ 或在设置中指定），不显示为无变化", !!result.error && /找不到或无法启动 Git/.test(result.error) && /PATH 中没有 git/.test(result.error) && /2\.31\.0/.test(result.error) && /设置 → Git/.test(result.error) && result.rows.length === 0, { result, missingShot });
  facts = await current.openGitSettings();
  let typed = await current.typeGit(fakeGit);
  check("A15 手动指定低于 2.31.0 的 Git：提示版本不支持，保留原设置", !!typed.error && /2\.30\.2/.test(typed.error) && /2\.31\.0/.test(typed.error) && typed.facts[0].includes("自动发现"), { typed, shot: await current.shot("no-git-old-manual") });
  typed = await current.typeGit(path.join(runDir, "no-such", "git.exe"));
  check("A15 手动指定不存在的路径：提示找不到，保留原设置", !!typed.error && /找不到或无法启动 Git/.test(typed.error) && /不存在/.test(typed.error) && typed.facts[0].includes("自动发现"), typed);
  typed = await current.typeGit(realGit);
  check("A15 手动指定有效 Git 路径：校验通过并采用", !!typed.ok && typed.facts[0] === realGit, { typed, shot: await current.shot("no-git-manual-ok") });
  await current.closeSettings();
  result = await current.addRepo();
  facts = await current.openGitSettings();
  check("A15 PATH 中没有 Git 时，用手动路径打开仓库", result.rows.includes("a.txt") && !result.error && facts[1].startsWith(realGit), { result, facts, shot: await current.shot("no-git-manual-open") });
  await current.closeSettings();
  await stop(current); current = null;
  current = await start("no-git", noGitPath);
  await current.waitUntil(`window.__op.rows().length > 0 || document.querySelector('.state.error')`, 30000);
  await current.waitUntil(`!window.__op.loading()`, 30000);
  facts = await current.openGitSettings();
  const restored = await current.evaluate(`({ rows: window.__op.rows(), error: document.querySelector('.state.error')?.textContent ?? null })`);
  check("A15 手动 Git 路径在重启后保留，项目恢复可用", restored.rows.includes("a.txt") && !restored.error && facts[0] === realGit, { restored, facts, shot: await current.shot("no-git-manual-restart") });
  await current.closeSettings();
  await stop(current); current = null;

  // 3. PATH 中的 Git 低于 2.31.0：打开仓库时明确提示
  current = await start("old-git", `${fakeDir};${noGitPath}`);
  result = await current.addRepo();
  check("A15 PATH 中的 Git 低于 2.31.0：打开仓库时提示版本不支持与处理方法", !!result.error && /2\.30\.2/.test(result.error) && /2\.31\.0/.test(result.error) && /设置 → Git/.test(result.error) && result.rows.length === 0, { result, shot: await current.shot("old-git-open") });
  await stop(current); current = null;
} catch (error) {
  fail(`异常：${error?.stack ?? error}`);
} finally {
  if (current) await stop(current).catch((e) => fail(`结束实例失败：${e}`));
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const total = Object.keys(report.checks).filter((k) => typeof report.checks[k].ok === "boolean").length;
  log(`完成：${total - report.failures.filter((f) => !f.startsWith("异常")).length}/${total} 项通过；报告 ${path.join(outDir, "report.json")}`);
  if (!args.includes("--keep")) { await sleep(1000); removeDir(runDir, GUI_ROOT); log(`已删除测试目录 ${runDir}`); }
  process.exitCode = report.failures.length ? 1 : 0;
}
