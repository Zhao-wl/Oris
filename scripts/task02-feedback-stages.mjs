import "./task02-gui-disabled.mjs";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const port = Number(process.argv[2] ?? 9252);
const fixture = JSON.parse(readFileSync(process.argv[3], "utf8"));
const phase = process.argv[4] ?? "full";
const screenshotPath = process.argv[5];
const resultPath = process.argv[6];
const target = await (async () => {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find(item => item.type === "page" && item.title === "Oris");
      if (page) return page;
    } catch { /* cold WebView startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Oris WebView2 CDP target not found after startup wait");
})();
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
    if (await evaluate(`(async () => Boolean(${expression}))()` )) return;
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
  await waitFor(`(() => { const button = ${buttonByText("载入/添加")}; if (!button || button.disabled) return false; button.click(); return true; })()`);
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
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

await call("Runtime.enable");

await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 850, deviceScaleFactor: 1, mobile: false });




await evaluate(`localStorage.removeItem('oris.workspace.v2');localStorage.removeItem('oris.recentRepository.v1');location.reload()`);await waitFor(`document.querySelector('.project-empty')`);
const timings=await evaluate(`(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const stages=[];let t=performance.now();let snapshot=await invoke('open_repository',{path:${JSON.stringify(fixture.root)},scope:'unstaged',gitExecutable:null,requestId:crypto.randomUUID()});stages.push({stage:'open',ms:performance.now()-t});for(let i=0;i<30;i++){t=performance.now();const pair=await invoke('read_content_pair',{repoId:snapshot.repo.repoId,scope:'unstaged',revision:snapshot.revision,pathId:snapshot.files[i].pathId,gitExecutable:null,requestId:crypto.randomUUID()});stages.push({stage:'content',ms:performance.now()-t,valid:pair.left.text!==null&&pair.right.text!==null});}for(const scope of ['staged','all','unstaged']){t=performance.now();snapshot=await invoke('refresh_repository',{repoId:snapshot.repo.repoId,scope,requestId:crypto.randomUUID()});stages.push({stage:'snapshot-'+scope,ms:performance.now()-t});}return stages})()`);
save({timings});socket.close();
