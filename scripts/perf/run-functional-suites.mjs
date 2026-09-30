// 长链最终复验：按顺序运行全部功能界面套件（不含真实远端、不含计时结论），每个套件的输出写入日志，最后汇总退出码与结尾几行。
// 各套件自行只经 launchOris 启动并核验测试实例，不调用窗口激活 API。
// 用法：node scripts/perf/run-functional-suites.mjs --exe <oris.exe> --run-id <编号> [--only v1-04,v2-03,...]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
const runId = option("run-id");
if (!exe || !runId) throw new Error("需要 --exe 与 --run-id");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const logDir = path.join(projectRoot, "artifacts", "gui-probe", `functional-${runId}`);
mkdirSync(logDir, { recursive: true });
const SUITES = [
  ["v1-04", "v1-04-acceptance.mjs", []],
  ["v2-02-functional", "v2-02-acceptance.mjs", ["--only", "functional"]],
  ["v2-03", "v2-03-acceptance.mjs", []],
  ["v2-04-local", "v2-04-acceptance.mjs", ["--only", "local"]],
  ["v2-05-functional", "v2-05-acceptance.mjs", ["--only", "functional", "--label", `${runId}-v2-05`]],
  ["v1-05-reading", "v1-05-acceptance.mjs", ["--only", "reading", "--label", `${runId}-v1-05`]],
  ["v2-06-skip-timing", "v2-06-acceptance.mjs", ["--skip-timing"]],
  ["history-feedback", "history-feedback-acceptance.mjs", []],
  ["gui-probe-task03", "gui-probe.mjs", ["--suite", "task03", "--label", `${runId}-task03`]],
  ["v1-06-projects-net-audit", "v1-06-projects.mjs", ["--net-audit", "--label", `${runId}-projects`]],
  ["v1-06-git-discovery", "v1-06-git-discovery.mjs", ["--label", `${runId}-git-discovery`]],
  ["branch-prune-local", "branch-prune-acceptance.mjs", ["--only", "local", "--run-id", runId]],
  ["workspace-local", "workspace-acceptance.mjs", ["--only", "local", "--label", `${runId}-workspace`]],
  ["v1-06-ai", "v1-06-ai-acceptance.mjs", ["--run-id", runId, "--label", `${runId}-ai`]]
];
const only = option("only", null)?.split(",") ?? null;
const summary = [];
for (const [name, script, extra] of SUITES.filter(([n]) => !only || only.includes(n))) {
  const started = Date.now();
  console.log(new Date().toISOString().slice(11, 19), "开始", name);
  const r = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "perf", script), "--exe", exe, ...extra], { cwd: projectRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(path.join(logDir, `${name}.log`), output);
  const tail = output.trim().split("\n").slice(-3).join(" | ");
  const failures = output.split("\n").filter((l) => /✗/.test(l)).slice(0, 10);
  summary.push({ name, exit: r.status, seconds: Math.round((Date.now() - started) / 1000), tail, failures });
  console.log(new Date().toISOString().slice(11, 19), "结束", name, `exit ${r.status}`, tail.slice(0, 300));
  writeFileSync(path.join(logDir, "summary.json"), JSON.stringify({ exe, runId, summary }, null, 2));
}
