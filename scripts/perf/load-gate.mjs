// 负载闸门（长链 lc5）：在被测构建开跑前空载测量一段时间（默认 300 s），报告外部进程 CPU 的 P50 / P95 / 最高与占用最高的进程，
// 并列出其他会话可能正在运行的 Oris 测试实例、cargo / rustc 编译与 node 测试进程（按命令行识别，只读，不结束任何进程）。
// 判定：外部进程 CPU 的 P95 > 5% 或发现上述进程 → 不通过（退出码 2），由人决定如何处理。
// 用法：node scripts/perf/load-gate.mjs [--seconds 300] [--out <json>]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startLoadMonitor } from "./load-monitor.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const seconds = Number(option("seconds", 300));
const out = option("out", null);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

function suspects() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(oris|cargo|rustc|node|msedgewebview2)\\.exe$' } | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  let list = [];
  try { list = JSON.parse(r.stdout || "[]"); } catch { list = []; }
  if (!Array.isArray(list)) list = [list];
  const self = process.pid;
  // 用户日常使用的 Oris（安装目录启动、默认应用数据目录）不是测试进程：单独列出，不作为不通过的依据。
  const userInstance = (cmd) => /\\com\.oris\.viewer\\EBWebView/i.test(cmd) || (/oris\.exe/i.test(cmd) && !/Oris-builds|Oris-target|worktrees|Oris-lc|target\\(release|debug)/i.test(cmd));
  return list.filter((p) => p.ProcessId !== self && p.ParentProcessId !== self).filter((p) => {
    const cmd = String(p.CommandLine ?? "");
    if (/^oris\.exe$/i.test(p.Name)) return true;
    if (/^(cargo|rustc)\.exe$/i.test(p.Name)) return true;
    if (/^msedgewebview2\.exe$/i.test(p.Name)) return /--webview-exe-name=oris\.exe/i.test(cmd);
    // node：只列出 Oris 的测试 / 构建脚本（vitest、vite、scripts/perf、tauri）
    return /vitest|vite(\.js)?\b|scripts[\\/]perf|tauri|Oris/i.test(cmd);
  }).map((p) => ({ pid: p.ProcessId, name: p.Name, userInstance: userInstance(String(p.CommandLine ?? "")), commandLine: String(p.CommandLine ?? "").slice(0, 300) }));
}

const monitor = startLoadMonitor({ log });
const before = suspects();
log(`空载测量 ${seconds} s；开始时的可疑进程 ${before.length} 个`);
await new Promise((r) => setTimeout(r, (seconds + 6) * 1000));
const summary = monitor.summary();
const after = suspects();
monitor.stop();
const blocking = (list) => list.filter((p) => !p.userInstance);
const pass = (summary.externalCpu.p95 ?? 100) <= 5 && blocking(before).length === 0 && blocking(after).length === 0;
const result = { at: new Date().toISOString(), seconds, pass, summary, suspectsAtStart: before, suspectsAtEnd: after };
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
log(`外部 CPU P50 ${summary.externalCpu.p50}% / P95 ${summary.externalCpu.p95}% / 最高 ${summary.externalCpu.max}%，超过 10% 的采样 ${summary.overThreshold} 个`);
log(`占用最高：${summary.topExternal.map((p) => `${p.name} ${p.maxCpu}%（${p.samples} 次）`).join("，")}`);
if (blocking(after).length) log(`其他会话的测试 / 编译进程：${blocking(after).map((p) => `${p.name}#${p.pid} ${p.commandLine}`).join(" | ")}`);
if (after.some((p) => p.userInstance)) log(`用户自己的 Oris 实例（不计为测试进程）：${after.filter((p) => p.userInstance).map((p) => `${p.name}#${p.pid}`).join("，")}`);
log(pass ? "负载闸门：通过" : "负载闸门：不通过");
process.exitCode = pass ? 0 : 2;
