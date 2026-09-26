// 一期 06 发布性能测试的会话脚本：在同一个负载监测下按顺序运行各测量套件（每个套件是本进程的子进程，因此各套件启动的
// Oris 测试实例及其子进程都算作“本轮进程”，不计入外部负载），套件之间静置。每个套件结束后检查其时间段是否受外部负载干扰
// （外部进程合计 CPU > 10% 持续 ≥ 10 s），受干扰时重测，最多 2 次；仍受干扰时标记“受干扰”。只读查询性能计数器，不结束、
// 不调整任何进程。
// 用法：node scripts/perf/release-perf-session.mjs --exe <oris.exe> --run-id <编号> --suites core,restart,... [--pause 30] [--l-repo <L 仓库>]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLoadMonitor } from "./load-monitor.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = path.resolve(option("exe"));
const runId = option("run-id");
if (!runId) throw new Error("缺少 --run-id");
const pause = Number(option("pause", 30));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = (file) => path.join(projectRoot, "scripts", "perf", file);
const lRepo = () => { const r = option("l-repo"); if (!r) throw new Error("L 套件需要 --l-repo"); return path.resolve(r); };
const label = (suite, attempt) => `perf-${runId}-${suite}${attempt ? `-retry${attempt}` : ""}`;

/** 套件：脚本、参数、额外环境变量，以及固定输出目录的脚本在结束后复制到本轮目录。 */
const SUITES = {
  core: (l) => ({ script: "gui-probe.mjs", argv: ["--label", l, "--suite", "core"] }),
  restart: (l) => ({ script: "gui-probe.mjs", argv: ["--label", l, "--suite", "restart"] }),
  trace: (l) => ({ script: "gui-probe.mjs", argv: ["--label", l, "--suite", "trace"] }),
  "latency-v202": (l) => ({ script: "v2-02-acceptance.mjs", argv: ["--label", l, "--only", "latency"] }),
  // 写操作套件按轮自行检测负载并重测（见脚本），这里不再整体重测。
  write: (l) => ({ script: "v1-06-write-latency.mjs", argv: ["--label", l], selfRetry: true }),
  "write-trace": (l) => ({ script: "v1-06-write-latency.mjs", argv: ["--label", l, "--iterations", "3", "--trace"], selfRetry: true }),
  hunk: (l) => ({ script: "v2-05-acceptance.mjs", argv: ["--label", l, "--only", "perf"], selfRetry: true }),
  appearance: (l) => ({ script: "v2-06-acceptance.mjs", argv: [], copyFrom: "v2-06-acceptance", label: l }),
  reading: (l) => ({ script: "v1-05-acceptance.mjs", argv: ["--label", l, "--only", "perf"], selfRetry: true }),
  task03: (l) => ({ script: "gui-probe.mjs", argv: ["--label", l, "--suite", "task03"] }),
  memory5: (l) => ({ script: "gui-probe.mjs", argv: ["--label", l, "--suite", "memory"] }),
  "memory5-low": (l) => ({ script: "gui-probe.mjs", argv: ["--label", l, "--suite", "memory"], env: { ORIS_WEBVIEW_MEMORY_TARGET: "low" } }),
  memory10: (l) => ({ script: "gui-probe.mjs", argv: ["--label", l, "--suite", "memory", "--projects", "10"] }),
  "git-children": (l) => ({ script: "v1-06-git-children.mjs", argv: ["--label", l] }),
  "proc-v203": (l) => ({ script: "v2-03-acceptance.mjs", argv: ["--label", l] }),
  "proc-v204": (l) => ({ script: "v2-04-acceptance.mjs", argv: ["--label", l, "--only", "local"] }),
  large: (l) => ({ script: "v1-06-large.mjs", argv: ["--label", l, "--repo", lRepo()] }),
  "git-probe-L": (l) => ({ script: "git-level-probe.mjs", noExe: true, argv: [lRepo(), "--iterations", "30", "--out", path.join(projectRoot, "artifacts", "gui-probe", l, "git-level-probe.json")], outDir: l })
};
const suites = option("suites", "").split(",").filter(Boolean);
for (const s of suites) if (!SUITES[s]) throw new Error(`未知套件：${s}`);

const sessionDir = path.join(projectRoot, "artifacts", "gui-probe", `perf-${runId}`);
mkdirSync(sessionDir, { recursive: true });
const logDir = path.join(sessionDir, "logs");
mkdirSync(logDir, { recursive: true });
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const monitor = startLoadMonitor({ log });
const session = { runId, exe, startedAt: new Date().toISOString(), pauseSec: pause, suites: [] };
const save = () => writeFileSync(path.join(sessionDir, `session-${process.pid}.json`), JSON.stringify({ ...session, loadSamples: monitor.samples }, null, 2));

function run(def, logFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probe(def.script), ...(def.noExe ? [] : ["--exe", exe]), ...def.argv], { cwd: projectRoot, env: { ...process.env, ...(def.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => chunks.push(b));
    child.on("exit", (code) => { writeFileSync(logFile, Buffer.concat(chunks)); resolve(code); });
  });
}

try {
  await new Promise((r) => setTimeout(r, 12000)); // 让监测先取得两个采样
  for (const [index, suite] of suites.entries()) {
    const entry = { suite, attempts: [] };
    session.suites.push(entry);
    for (let attempt = 0; attempt <= 2; attempt++) {
      const l = label(suite, attempt);
      const def = SUITES[suite](l);
      if (def.outDir) mkdirSync(path.join(projectRoot, "artifacts", "gui-probe", def.outDir), { recursive: true });
      const from = Date.now();
      log(`开始 ${suite}${attempt ? `（重测 ${attempt}）` : ""} → ${l}`);
      const exit = await run(def, path.join(logDir, `${l}.log`));
      const to = Date.now();
      if (def.copyFrom) { const src = path.join(projectRoot, "artifacts", "gui-probe", def.copyFrom); if (existsSync(src)) cpSync(src, path.join(projectRoot, "artifacts", "gui-probe", def.label), { recursive: true }); }
      await new Promise((r) => setTimeout(r, 6000)); // 等下一次采样覆盖到段末尾
      const { disturbed, samples } = monitor.disturbance(from, to);
      const a = { attempt, label: l, from, to, seconds: Math.round((to - from) / 1000), exit, disturbed, load: monitor.summary(from, to), maxExternalCpu: samples.length ? Math.max(...samples.map((s) => s.externalCpu)) : null };
      entry.attempts.push(a);
      log(`结束 ${suite}：exit ${exit}，${a.seconds} s，外部 CPU 最高 ${a.maxExternalCpu}%${disturbed ? "，受干扰" : ""}`);
      save();
      if (!disturbed || def.selfRetry) { a.note = disturbed && def.selfRetry ? "套件按轮自行检测负载并重测，不整体重测" : undefined; break; }
    }
    entry.verdict = entry.attempts.at(-1).disturbed ? "受干扰，未下结论" : "ok";
    save();
    if (index < suites.length - 1) await new Promise((r) => setTimeout(r, pause * 1000));
  }
} finally {
  session.finishedAt = new Date().toISOString();
  save();
  monitor.stop();
  log(`会话记录：${sessionDir}`);
}
