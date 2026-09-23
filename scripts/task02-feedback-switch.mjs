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
const second=JSON.parse(readFileSync('artifacts/task-02/runtime/fixture.json','utf8')).projects[1];
await openProject(fixture.root);await openProject(second);await switchProject(fixture.root);await waitFor(`document.querySelectorAll('.cm-editor').length===2`);
const samples=await evaluate(`(async()=>{const paths=${JSON.stringify([second,fixture.root])};const samples=[];for(let i=0;i<30;i++){const path=paths[i%2];const t=performance.now();[...document.querySelectorAll('.project-tab')].find(n=>n.title===path).querySelector('.project-switch').click();while(!document.querySelector('.statusbar > span')?.textContent.startsWith(path)||document.querySelectorAll('.cm-editor').length!==2||document.querySelector('.state')?.textContent.includes('正在读取')){if(performance.now()-t>10000)throw Error('switch timed out');await new Promise(r=>setTimeout(r,4))}await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));samples.push(performance.now()-t)}return samples})()`);
save({samples,p50:percentile(samples,.5),p95:percentile(samples,.95),scope:'large 10000 files/100 changes/1800 lines and a second real Git repository; click to two editors plus two animation frames'});socket.close();
