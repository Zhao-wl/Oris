import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const port = Number(process.argv[2] ?? 9252);
const fixture = JSON.parse(readFileSync(process.argv[3], "utf8"));
const phase = process.argv[4] ?? "full";
const screenshotPath = process.argv[5];
const resultPath = process.argv[6];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((item) => item.type === "page" && item.title === "Oris");
if (!target) throw new Error("Oris WebView2 CDP target not found");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  let response;
  try {
    response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  } catch (error) {
    throw new Error(`${error.message}\nExpression: ${expression}`);
  }
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${expression}`);
};
const capture = async (path) => {
  if (!path) return;
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(screenshot.data, "base64"));
};
const save = (value) => {
  console.log(JSON.stringify(value, null, 2));
  if (resultPath) writeFileSync(resultPath, JSON.stringify(value, null, 2));
};
const setInput = async (aria, value) => evaluate(`(() => {
  const input = document.querySelector('input[aria-label=${JSON.stringify(aria)}]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const buttonByText = (text) => `([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${JSON.stringify(text)}))`;
const openProject = async (path) => {
  await setInput("仓库路径", path);
  await waitFor(`${buttonByText("载入/添加")} && !${buttonByText("载入/添加")}.disabled`);
  await evaluate(`${buttonByText("载入/添加")}.click()`);
  await waitFor(`document.querySelector('.statusbar > span')?.textContent.startsWith(${JSON.stringify(path)}) && !document.querySelector('.state')?.textContent.includes('正在读取')`, 45000);
};
const switchProject = async (path) => {
  await evaluate(`([...document.querySelectorAll('.project-tab')].find((tab) => tab.title === ${JSON.stringify(path)})).querySelector('.project-switch').click()`);
  await waitFor(`document.querySelector('.statusbar > span')?.textContent.startsWith(${JSON.stringify(path)}) && !document.querySelector('.state')?.textContent.includes('正在读取')`);
};
const chooseScope = async (label) => {
  await evaluate(`${buttonByText(label)}.click()`);
  await waitFor(`document.querySelector('.sidebar > footer')?.textContent.includes(${JSON.stringify(label)}) && !document.querySelector('.state')?.textContent.includes('正在读取')`);
};
const fileRows = () => evaluate(`([...document.querySelectorAll('.file')].map((row) => ({ path: row.getAttribute('aria-label'), status: row.querySelector('.status')?.textContent, stats: row.querySelector('.line-stat')?.textContent ?? null })))`);
const git = (repository, args) => {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 850, deviceScaleFactor: 1, mobile: false });

if (phase === "restore") {
  await waitFor(`document.querySelectorAll('.project-tab').length === 5 && document.querySelector('.file.selected') && document.querySelectorAll('.cm-editor').length > 0`, 45000);
  const restored = await evaluate(`(() => ({
    projectCount: document.querySelectorAll('.project-tab').length,
    activePath: document.querySelector('.statusbar > span')?.textContent,
    filter: document.querySelector('.filter')?.value,
    selectedPath: document.querySelector('.file.selected')?.getAttribute('aria-label'),
    scope: [...document.querySelectorAll('.scope')].find((node) => node.classList.contains('selected'))?.textContent,
    editorCount: document.querySelectorAll('.cm-editor').length,
    projectNames: [...document.querySelectorAll('.project-switch > span')].map((node) => node.textContent.trim())
  }))()`);
  await capture(screenshotPath);
  const result = {
    phase,
    restored,
    passed: restored.projectCount === 5 && restored.activePath?.startsWith(fixture.projects[2]) && restored.filter === "file-005" && restored.selectedPath === "files/file-005.txt" && restored.scope === "全部" && restored.editorCount === 2
  };
  save(result);
  socket.close();
  if (!result.passed) process.exitCode = 1;
} else {
  await evaluate(`localStorage.removeItem('oris.workspace.v2'); localStorage.removeItem('oris.recentRepository.v1'); location.reload()`);
  await waitFor(`document.querySelector('.project-empty')?.textContent.includes('尚未添加项目')`);
  for (const project of fixture.projects) await openProject(project);
  const initialProjects = await evaluate(`(() => ({ count: document.querySelectorAll('.project-tab').length, names: [...document.querySelectorAll('.project-switch > span')].map((node) => node.textContent.trim()), paths: [...document.querySelectorAll('.project-tab')].map((node) => node.title) }))()`);
  await openProject(fixture.primary);
  const duplicateCount = await evaluate(`document.querySelectorAll('.project-tab').length`);

  await evaluate(`([...document.querySelectorAll('.project-tab')].find((tab) => tab.title === ${JSON.stringify(fixture.primary)})).querySelector('.project-action').click()`);
  await waitFor(`document.querySelector('.project-switch > span')?.textContent.includes('★')`);
  await setInput("搜索项目", "group-2");
  const searchCount = await evaluate(`document.querySelectorAll('.project-tab').length`);
  await setInput("搜索项目", "");

  const removedPath = fixture.projects[1];
  await evaluate(`([...document.querySelectorAll('.project-tab')].find((tab) => tab.title === ${JSON.stringify(removedPath)})).querySelector('.project-action.danger').click()`);
  await waitFor(`document.querySelectorAll('.project-tab').length === 4`);
  const removeEvidence = { count: await evaluate(`document.querySelectorAll('.project-tab').length`), directoryStillExists: existsSync(removedPath) };
  await openProject(removedPath);

  await switchProject(fixture.primary);
  await chooseScope("未暂存");
  const unstaged = await fileRows();
  await chooseScope("已暂存");
  const staged = await fileRows();
  await evaluate(`([...document.querySelectorAll('.file')].find((node) => node.getAttribute('aria-label') === 'dual.txt')).click()`);
  await waitFor(`document.querySelectorAll('.cm-editor').length === 2`);
  const stagedEndpoints = await evaluate(`document.querySelector('.endpoints').textContent`);
  await chooseScope("全部");
  const all = await fileRows();
  await evaluate(`([...document.querySelectorAll('.file')].find((node) => node.getAttribute('aria-label') === 'dual.txt')).click()`);
  await waitFor(`document.querySelectorAll('.cm-editor').length === 2`);
  const allEndpoints = await evaluate(`document.querySelector('.endpoints').textContent`);
  const allEditorText = await evaluate(`([...document.querySelectorAll('.cm-content')].map((node) => node.innerText))`);

  await switchProject(fixture.empty);
  await chooseScope("全部");
  const emptyHead = await evaluate(`({ endpoints: document.querySelector('.endpoints').textContent, rows: [...document.querySelectorAll('.file')].map((node) => node.getAttribute('aria-label')) })`);
  await switchProject(fixture.conflict);
  await chooseScope("全部");
  await evaluate(`([...document.querySelectorAll('.file')].find((node) => node.getAttribute('aria-label') === 'conflict.txt')).click()`);
  await waitFor(`document.querySelector('.state.warning')?.textContent.includes('未解决冲突')`);
  const conflictText = await evaluate(`document.querySelector('.state.warning').textContent`);

  for (const project of fixture.projects) await switchProject(project);
  const switchSamples = await evaluate(`(async () => {
    const paths = ${JSON.stringify(fixture.projects)};
    const samples = [];
    for (let run = 0; run < 30; run += 1) {
      const path = paths[run % paths.length];
      const started = performance.now();
      [...document.querySelectorAll('.project-tab')].find((tab) => tab.title === path).querySelector('.project-switch').click();
      while (!document.querySelector('.statusbar > span')?.textContent.startsWith(path) || !document.querySelector('.file.selected')) {
        if (performance.now() - started > 5000) throw new Error('switch timeout: ' + path);
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      samples.push(performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    return samples;
  })()`);

  await switchProject(fixture.primary);
  const beforeRevision = await evaluate(`document.querySelector('.diff-footer').textContent`);
  appendFileSync(`${fixture.primary}\\files\\file-000.txt`, "watcher update\n", "utf8");
  await waitFor(`document.querySelector('.restore-status')?.textContent.includes('同步') || document.querySelector('.restore-status')?.textContent.includes('变化')`, 15000);
  await waitFor(`document.querySelector('.diff-footer').textContent !== ${JSON.stringify(beforeRevision)}`, 30000);
  const watcherRevision = await evaluate(`document.querySelector('.diff-footer').textContent`);

  const newPath = `${fixture.primary}\\external watcher.txt`;
  writeFileSync(newPath, "external\n", "utf8");
  await waitFor(`[...document.querySelectorAll('.file')].some((node) => node.getAttribute('aria-label') === 'external watcher.txt')`, 30000);
  git(fixture.primary, ["add", "--", "external watcher.txt"]);
  await chooseScope("已暂存");
  await waitFor(`[...document.querySelectorAll('.file')].some((node) => node.getAttribute('aria-label') === 'external watcher.txt')`, 30000);
  git(fixture.primary, ["commit", "-qm", "external watcher commit"]);
  await waitFor(`![...document.querySelectorAll('.file')].some((node) => node.getAttribute('aria-label') === 'external watcher.txt')`, 30000);
  git(fixture.primary, ["checkout", "-qb", "external-checkout"]);
  await waitFor(`document.querySelector('.branch')?.textContent.includes('external-checkout')`, 30000);
  const externalEvidence = { watcherRevisionChanged: watcherRevision !== beforeRevision, branch: await evaluate(`document.querySelector('.branch').textContent`) };

  const refsBefore = git(fixture.primary, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  await evaluate(`${buttonByText("↻ 本地刷新")}.click()`);
  await waitFor(`!${buttonByText("↻ 本地刷新")}.disabled`);
  const refsAfter = git(fixture.primary, ["for-each-ref", "--format=%(refname) %(objectname)"]);

  await chooseScope("全部");
  await switchProject(fixture.projects[1]);
  const slowRoot = `${fixture.primary}\\slow`;
  mkdirSync(slowRoot, { recursive: true });
  for (let index = 0; index < 500; index += 1) writeFileSync(`${slowRoot}\\file-${String(index).padStart(4, "0")}.txt`, `slow ${index}\n`, "utf8");
  const slowIsolation = await evaluate(`(async () => {
    const slow = ${JSON.stringify(fixture.primary)};
    const fast = ${JSON.stringify(fixture.projects[1])};
    [...document.querySelectorAll('.project-tab')].find((tab) => tab.title === slow).querySelector('.project-switch').click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    [...document.querySelectorAll('.project-tab')].find((tab) => tab.title === fast).querySelector('.project-switch').click();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    return { active: document.querySelector('.statusbar > span')?.textContent, selected: document.querySelector('.file.selected')?.getAttribute('aria-label'), error: document.querySelector('.state.error')?.textContent ?? null };
  })()`);

  await switchProject(fixture.projects[2]);
  await chooseScope("全部");
  await evaluate(`([...document.querySelectorAll('.file')].find((node) => node.getAttribute('aria-label') === 'files/file-011.txt')).click()`);
  await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label') === 'files/file-011.txt'`);
  git(fixture.projects[2], ["checkout", "--", "files/file-011.txt"]);
  await waitFor(`document.querySelector('.selection-notice')?.textContent.includes('此前选中的文件已不在当前比较范围中')`, 30000);
  const invalidationEvidence = await evaluate(`({ notice: document.querySelector('.selection-notice')?.textContent, selected: document.querySelector('.file.selected')?.getAttribute('aria-label') })`);
  await evaluate(`([...document.querySelectorAll('.file')].find((node) => node.getAttribute('aria-label') === 'files/file-005.txt')).click()`);
  await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label') === 'files/file-005.txt' && document.querySelectorAll('.cm-editor').length === 2`);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }))`);
  await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label') === 'files/file-006.txt'`);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }))`);
  await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label') === 'files/file-005.txt'`);
  const fileNavigationEvidence = await evaluate(`({ selected: document.querySelector('.file.selected')?.getAttribute('aria-label') })`);
  await setInput("按完整相对路径筛选", "file-005");
  await evaluate(`document.querySelector('.file').click()`);
  await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label') === 'files/file-005.txt' && document.querySelectorAll('.cm-editor').length === 2`);
  await capture(screenshotPath);
  const result = {
    phase,
    release: await evaluate(`document.querySelector('.app') !== null`),
    initialProjects,
    duplicateCount,
    searchCount,
    removeEvidence,
    scopes: { unstaged, staged, all, stagedEndpoints, allEndpoints, allEditorText, emptyHead, conflictText },
    performance: { samples: switchSamples, p50Ms: percentile(switchSamples, .5), p95Ms: percentile(switchSamples, .95) },
    externalEvidence,
    manualRefreshRefsUnchanged: refsBefore === refsAfter,
    slowIsolation,
    invalidationEvidence,
    fileNavigationEvidence,
  };
  const paths = (rows) => rows.map((row) => row.path);
  result.passed =
    initialProjects.count === 5 && new Set(initialProjects.paths).size === 5 && initialProjects.names.every((name) => name.includes('same-name')) &&
    duplicateCount === 5 && searchCount === 1 && removeEvidence.count === 4 && removeEvidence.directoryStillExists &&
    paths(unstaged).includes('dual.txt') && paths(unstaged).includes('delete-me.txt') && paths(unstaged).includes('未跟踪 [x].txt') &&
    paths(staged).includes('dual.txt') && paths(staged).includes('renamed 中文 #.txt') &&
    paths(all).includes('dual.txt') && paths(all).includes('renamed 中文 #.txt') && paths(all).includes('delete-me.txt') && paths(all).includes('未跟踪 [x].txt') &&
    stagedEndpoints.includes('HEAD') && stagedEndpoints.includes('Index') && allEndpoints.includes('HEAD') && allEndpoints.includes('Working Tree') && allEditorText[0].includes('base') && allEditorText[1].includes('unstaged') &&
    emptyHead.endpoints.includes('空树') && emptyHead.rows.includes('first commit.txt') && conflictText.includes('未解决冲突') &&
    result.performance.p95Ms <= 200 && externalEvidence.watcherRevisionChanged && externalEvidence.branch.includes('external-checkout') && result.manualRefreshRefsUnchanged &&
    slowIsolation.active?.startsWith(fixture.projects[1]) && !slowIsolation.error && invalidationEvidence.notice?.includes('阅读位置已调整') && invalidationEvidence.selected !== 'files/file-011.txt' && fileNavigationEvidence.selected === 'files/file-005.txt';
  save(result);
  socket.close();
  if (!result.passed) process.exitCode = 1;
}
