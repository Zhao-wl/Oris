// CDP 只操作当前运行创建的专用 Oris 实例。使用 focus:false、focusable:false 的测试构建。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GUI_ROOT, assertOutside, git as fixtureGit } from "./gui-fixtures.mjs";
import { killOris, launchOris, machineInfo, PAGE_HELPERS, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";

const { values } = parseArgs({ options: {
  manifest: { type: "string" }, output: { type: "string" },
  samples: { type: "string", default: "30" }, port: { type: "string", default: "9913" },
  "file-view": { type: "string", default: "flat" },
} });
const samples = Number(values.samples);
const port = Number(values.port);
assert.ok(process.platform === "win32" && values.manifest && values.output,
  "请提供 --manifest 和 --output。清单由 build-change-set-test.ps1 生成。");
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 30, "--samples 必须在 1–30 之间");
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65532, "--port 无效，需预留连续四个端口");
assert.ok(["flat", "tree"].includes(values["file-view"]), "--file-view 仅接受 flat 或 tree");
const artifacts = fileURLToPath(new URL("../../artifacts/", import.meta.url));
const manifestPath = realpathSync(values.manifest);
assert.ok(manifestPath.toLowerCase().startsWith(artifacts.toLowerCase()) && path.basename(manifestPath) === "test-build.json",
  "构建清单必须位于当前仓库的 artifacts 子目录。");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
assert.ok(manifest.format === "oris-change-set-test-v1" && manifest.identifier === "com.oris.viewer.perf" &&
  manifest.focus === false && manifest.focusable === false && /^[0-9a-f]{40,64}$/.test(manifest.source), "无效的专用测试构建清单");
const expectedExe = path.join(path.dirname(manifestPath), "oris.exe");
const exe = realpathSync(expectedExe);
assert.equal(exe.toLowerCase(), expectedExe.toLowerCase(), "测试程序不能重定向到其他位置");
const binarySha256 = sha256File(exe);
assert.equal(binarySha256, manifest.sha256, "测试程序和清单 SHA-256 不匹配");
const output = path.resolve(values.output);
const report = { source: manifest.source, version: manifest.version, binarySha256, startedAt: new Date().toISOString(),
  machine: machineInfo(), samples, viewport: [1440, 900], fileView: values["file-view"], scenarios: {}, load: {},
  cache: { filters: "暖进程，交替输入两个等量路径组", coldDiff: "空 Oris 内容缓存对应条目，系统文件缓存未清",
    stageToNext: "当前文件预读，正常邻行预取策略", cachedSwitch: "两个历史夹具预读后交替切换" } };

mkdirSync(GUI_ROOT, { recursive: true });
assert.equal(realpathSync(GUI_ROOT).toLowerCase(), GUI_ROOT.toLowerCase(), "性能工作目录不能重定向");
const runDir = realpathSync(mkdtempSync(path.join(GUI_ROOT, "change-set-")));
assertOutside(runDir);
let stopped = false;
let testProcessClosed = true;
const interrupt = () => { stopped = true; };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const q = JSON.stringify;
const gitIsolation = Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_/i.test(key)).map(key => [key, undefined]));
Object.assign(gitIsolation, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" });
const git = (repo, args) => fixtureGit(repo, args, { extraEnv: {
  ...gitIsolation, GIT_AUTHOR_NAME: "Oris performance fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Oris performance fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000",
} });
const filterLabel = "按完整相对路径筛选";
const textOf = file => `fixture changed ${path.posix.basename(file)}`;
const sizes = [100, 1000, 5000, "cached-large-diff"];

try {
  for (const size of sizes) await runScenario(size);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  report.cleaned = testProcessClosed && removeDir(runDir, GUI_ROOT);
  writeFileSync(output, q(report, null, 2) + "\n", { flag: "wx" });
  if (testProcessClosed) assert.ok(report.cleaned, `性能夹具清理失败：${runDir}`);
  else console.error(`测试进程退出未确认，保留性能夹具：${runDir}`);
}

function createFixture(repo, size) {
  const paths = [];
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  for (const group of ["group-00", "group-01"]) {
    mkdirSync(path.join(repo, group));
    for (let i = 0; i < size / 2; i++) {
      const file = `${group}/file-${group.at(-1)}-${String(i).padStart(4, "0")}.txt`;
      paths.push(file);
      writeFileSync(path.join(repo, file), `fixture base ${file}\n`);
    }
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "change-set baseline"]);
  for (const file of paths) writeFileSync(path.join(repo, file), `${textOf(file)}\n`);
  assert.equal(git(repo, ["status", "--porcelain"]).split("\n").length, size);
  return paths;
}

function createHistoricalFixture(repo) {
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  const paths = ["000-lc4-3000-0.ts", "001-every5-10000-0.ts"];
  const after = new Map();
  for (const [index, file] of paths.entries()) {
    const n = index ? 10000 : 3000;
    const base = [`// copy ${index}`, ...Array.from({ length: n }, (_, i) => i % 11 === 0 ? `// block ${i}`
      : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`)];
    const changed = [...base];
    for (let i = 31; i < changed.length; i += index ? 5 : 50) changed[i] = changed[i].replace("retry", "retries").replace("await", "await  ");
    if (!index) {
      for (let i = 1200; i < 1260; i += 7) changed[i] += ` // ${"long wrapped comment ".repeat(12)}`;
      changed.splice(1500, 0, "  // inserted block", "  const extra = true;");
    }
    writeFileSync(path.join(repo, file), `${base.join("\n")}\n`);
    after.set(file, `${changed.join("\n")}\n`);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "historical cached diff fixture"]);
  for (const [file, text] of after) writeFileSync(path.join(repo, file), text);
  return paths;
}

function systemCpuTimes() {
  return cpus().reduce((sum, core) => ({ idle: sum.idle + core.times.idle,
    total: sum.total + Object.values(core.times).reduce((total, value) => total + value, 0) }), { idle: 0, total: 0 });
}

async function runScenario(size) {
  assert.ok(!stopped, "性能验证已中断");
  const scenarioDir = path.join(runDir, String(size));
  mkdirSync(scenarioDir);
  const repo = path.join(scenarioDir, "repo");
  const historical = size === "cached-large-diff";
  const files = historical ? createHistoricalFixture(repo) : createFixture(repo, size);
  const app = await launchOris({ exe, profileDir: path.join(scenarioDir, "profile"), port: port + sizes.indexOf(size),
    trackCleanup: true,
    extraEnv: { ...gitIsolation, ORIS_APP_CACHE_DIR: path.join(scenarioDir, "cache"), ORIS_APP_DATA_DIR: path.join(scenarioDir, "data") } }).catch(error => {
    if (error instanceof AggregateError) testProcessClosed = false;
    throw error;
  });
  testProcessClosed = false;
  const { call, evaluate } = app.cdp;
  const cpuStart = systemCpuTimes();
  const timings = historical ? { cachedSwitch: [] } : { filters: [], coldDiff: [], stageToNext: [] };
  const list = `document.querySelectorAll('.active-scope .file')`;
  const count = `Number(document.querySelector('.active-scope .change-heading .dim')?.textContent ?? -1)`;
  const ready = file => `window.__op.readyFor(${q(file)}, ${q(historical ? null : textOf(file))}) === true${historical
    ? " && /^\\d+ \\/ [1-9]/.test(document.querySelector('.diff-position')?.textContent ?? '')" : ""}`;
  const row = file => `document.querySelector('.active-scope .file[aria-label="${file}"]')`;
  const actionButton = (file, action) => `document.querySelector('.file[aria-label="${file}"] button[aria-label="${action}"]')`;
  const writeReady = `window.__op.button('丢弃') && !window.__op.button('丢弃').disabled`;
  const verifyMeasurement = async (result, label) => {
    if (!result.ok) {
      const state = await evaluate(`({
        path: window.__op.tab(),
        selected: window.__op.selected(),
        operation: document.querySelector('.op-status')?.textContent,
        counts: Array.from(document.querySelectorAll('.change-heading .dim'), node => node.textContent),
        reading: !!document.querySelector('.cm-editor'),
        loading: window.__op.loading(),
      })`);
      assert.fail(`${size} 文件 / ${label}：${result.error} (${JSON.stringify(state)})`);
    }
    return result;
  };
  const measure = async (action, predicate, label) => {
    assert.ok(!stopped, "性能验证已中断");
    const result = await evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), 30000)`, 35000);
    return verifyMeasurement(result, label);
  };
  const wait = (predicate, label) => measure("", predicate, label);
  const reveal = async (file, index) => {
    await evaluate(`(() => {
      if (${row(file)}) return;
      const scroller = document.querySelector('.active-scope .files');
      const host = scroller?.querySelector('.virtual-rows');
      if (!host) throw new Error('无法定位虚拟文件列表');
      const rowHeight = host.getBoundingClientRect().height / Number(host.dataset.virtualCount);
      scroller.scrollTop = Math.max(0, (${index} - 3) * rowHeight);
    })()`);
    await app.cdp.waitFor(row(file));
  };
  const click = async (target, predicate, label) => {
    assert.ok(!stopped, "性能验证已中断");
    const result = await evaluate(`(() => {
      const target = ${target};
      if (!target || target.disabled) throw new Error(${q(`找不到可用的 ${label} 按钮或列表行`)});
      return window.__op.measure(() => target.click(), () => (${predicate}), 30000);
    })()`, 35000);
    return verifyMeasurement(result, label);
  };
  try {
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(PAGE_HELPERS);
    assert.equal(await evaluate("window.__op.focused()"), false, "专用 Oris 测试窗获得了焦点");
    await wait("document.querySelector('.project-empty')", "项目入口");
    await evaluate(`(async () => {
      const { repo } = await window.__TAURI_INTERNALS__.invoke('open_repository', {
        path: ${q(repo)}, scope: 'unstaged', gitExecutable: null, requestId: crypto.randomUUID(), submodulePointers: false,
      });
      localStorage.setItem('oris.settings.v1', JSON.stringify({ version: 1, update: { autoCheck: false } }));
      localStorage.setItem('oris.workspace.v2', JSON.stringify({ version: 2, activeRepoId: repo.repoId, projects: [{ repo,
        anchor: { scope: 'unstaged', fileView: ${q(values["file-view"])} }
      }] }));
      return true;
    })()`, 60000);
    await call("Page.enable");
    await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
    let reloadTimer;
    const pageLoaded = new Promise((resolve, reject) => {
      reloadTimer = setTimeout(() => reject(new Error("测试页面重新载入超时")), 30000);
      app.cdp.on("Page.loadEventFired", resolve);
    });
    try { await Promise.all([call("Page.reload"), pageLoaded]); }
    finally { clearTimeout(reloadTimer); }
    await app.cdp.waitFor(`!!window.__op && ${count} === ${files.length} && ${ready(files[0])}`, 60000);

    if (historical) {
      const [anchor, large] = files;
      await click(row(large), ready(large), "预热历史大文件");
      report.historicalHunks = await evaluate(`Number(document.querySelector('.diff-position').textContent.split('/')[1])`);
      for (let i = 0; i < samples; i++) {
        await click(row(anchor), ready(anchor), "切到对照文件");
        await sleep(400);
        timings.cachedSwitch.push(await click(row(large), ready(large), "已缓存大文件切换"));
        await sleep(400);
      }
      console.log(size, "cachedSwitch", summarize(timings.cachedSwitch));
      return;
    }

    // 间隔至少两行，跳过初始文件及相邻预取。先测冷 diff，再测会改变阅读位置的其他操作。
    for (let i = 0; i < samples; i++) {
      const index = 9 + i * 3;
      const file = files[index];
      await reveal(file, index);
      timings.coldDiff.push(await click(row(file), ready(file), `冷读取 ${file}`));
    }
    for (let i = 0; i < samples; i++) {
      const group = `group-0${i % 2}`;
      const matches = `(row => row?.getAttribute('aria-label').startsWith(${q(group + "/")}))`;
      timings.filters.push(await measure(`window.__op.setInput(${q(filterLabel)}, ${q(group)})`,
        `(() => { const rows = ${list}; return ${count} === ${size / 2} && ${matches}(rows[0]) && ${matches}(rows[rows.length - 1]); })()`, `筛选 ${group}`));
      assert.ok(await evaluate(`Array.from(${list}).every(${matches})`));
    }
    await measure(`window.__op.setInput(${q(filterLabel)}, '')`, `${count} === ${size}`, "清除筛选");

    const [file, next] = files;
    for (let i = 0; i < samples; i++) {
      assert.ok(!stopped, "性能验证已中断");
      const stage = actionButton(file, "暂存");
      const unstage = actionButton(file, "取消暂存");
      await reveal(file, 0);
      await click(row(file), ready(file), `预读 ${file}`);
      await wait(`${writeReady} && ${stage} && !(${stage}).disabled`, "暂存可用");
      timings.stageToNext.push(await click(stage,
        `document.querySelector('.op-status.succeeded') && ${ready(next)} && ${unstage}`, `暂存 ${file} 后显示 ${next}`));
      assert.equal(git(repo, ["diff", "--cached", "--name-only"]), file);
      await wait(`${writeReady} && ${unstage} && !(${unstage}).disabled`, "取消暂存可用");
      await click(unstage, `${writeReady} && ${count} === ${size} && ${stage} && !(${stage}).disabled`, `复位 ${file}`);
      assert.equal(git(repo, ["diff", "--cached", "--name-only"]), "");
    }
    for (const [name, data] of Object.entries(timings)) console.log(size, name, summarize(data));
  } finally {
    const cpuEnd = systemCpuTimes();
    const total = cpuEnd.total - cpuStart.total;
    report.load[size] = { averageSystemCpuPercent: total > 0 ? Number(((1 - (cpuEnd.idle - cpuStart.idle) / total) * 100).toFixed(1)) : null };
    report.scenarios[size] = Object.fromEntries(Object.entries(timings).map(([name, data]) => [name, { summary: summarize(data), samples: data }]));
    try { app.cdp.close(); } finally {
      const closed = await killOris({ ...app, force: true });
      testProcessClosed = closed.closed;
      assert.ok(closed.closed, `Oris 性能测试实例结束失败：PID ${app.pid}`);
    }
  }
}
