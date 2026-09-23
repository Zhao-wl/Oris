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


await evaluate(`localStorage.removeItem('oris.workspace.v2'); localStorage.removeItem('oris.recentRepository.v1'); location.reload()`);
await waitFor(`document.querySelector('.project-empty')?.textContent.includes('尚未添加项目')`);
await evaluate(`(() => { window.metrics=[]; const send=Worker.prototype.postMessage; Worker.prototype.postMessage=function(message, ...rest){ const t=performance.now(); const done=e=>{if(e.data.requestId===message.requestId){window.metrics.push({cmd:'diff_worker',ms:performance.now()-t,computeMs:e.data.elapsedMs});this.removeEventListener('message',done)}};this.addEventListener('message',done);return send.call(this,message,...rest)}; })()`);
const root=fixture.root;

const started=Date.now(); await openProject(root); await waitFor(`document.querySelectorAll('.cm-editor').length===2`,60000);
const opening=Date.now()-started;
const samples=[];
for(let i=1;i<=30;i++){
 const t=Date.now(); await evaluate(`document.querySelectorAll('.file')[${i}].click()`);
 await waitFor(`document.querySelectorAll('.cm-editor').length===2 && !document.querySelector('.state')?.textContent.includes('正在读取')`);
 samples.push(Date.now()-t);
}
const cachedSamples=[];
for(let i=0;i<30;i++){const t=Date.now();await evaluate(`document.querySelectorAll('.file')[${29+i%2}].click()`);await waitFor(`document.querySelectorAll('.cm-editor').length===2 && !document.querySelector('.state')?.textContent.includes('正在读取')`);cachedSamples.push(Date.now()-t)}
for (const label of ['已暂存','全部','未暂存']) { await chooseScope(label); await waitFor(`document.querySelectorAll('.cm-editor').length===2`); }
const scopes=[];
for(const label of Array.from({length:30},(_,i)=>['已暂存','全部','未暂存'][i%3])){const t=Date.now();await chooseScope(label);await waitFor(`document.querySelectorAll('.cm-editor').length===2`);scopes.push(Date.now()-t)}
await evaluate(`(()=>{window.originalEditors=[...document.querySelectorAll('.cm-editor')];document.querySelectorAll('.cm-scroller').forEach(n=>n.scrollTop=12000)})()`);
await new Promise(r=>setTimeout(r,500));
const positions=()=>evaluate(`({tops:[...document.querySelectorAll('.cm-scroller')].map(n=>n.scrollTop),same:window.originalEditors.every(n=>n.isConnected)})`);
const initial=await positions();
await new Promise(r=>setTimeout(r,11000)); const idle=await positions();
const selected=await evaluate(`document.querySelector('.file.selected').getAttribute('aria-label')`);
const original=readFileSync(root+'/'+selected);appendFileSync(root+'/'+selected,'external appended line\n');await new Promise(r=>setTimeout(r,3500));const changed=await positions();
const metrics=await evaluate('window.metrics');
const nameFit=await evaluate(`([...document.querySelectorAll('.file')].slice(0,3).map(row=>({full:row.getAttribute('aria-label'),label:row.querySelector('.file-path').textContent,title:row.querySelector('.file-path').title,width:row.querySelector('.file-path').clientWidth,scrollWidth:row.querySelector('.file-path').scrollWidth})))`);
await capture(screenshotPath);save({opening,fileSamples:samples,cachedSamples,scopeSamples:scopes,initial,idle,focus,changed,nameFit,metrics});socket.close();writeFileSync(root+'/'+selected,original);
