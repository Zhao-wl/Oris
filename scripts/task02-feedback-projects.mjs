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
  console.log(await evaluate(`({focus:document.hasFocus(),events:window.focusEvents,path:document.querySelector('.statusbar').textContent,value:document.querySelector('input[aria-label="仓库路径"]').value,state:[...document.querySelectorAll('.state')].map(n=>n.textContent),tabs:[...document.querySelectorAll('.project-tab')].map(n=>n.textContent),disabled:[...document.querySelectorAll('.openbar button')].map(n=>[n.textContent,n.disabled])})`));
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




if (phase === "restore") {
  await waitFor(`document.querySelectorAll('.cm-editor').length===2`);
  const expected=JSON.parse(readFileSync('artifacts/task-02-feedback/projects.json','utf8'));
  const restored=await evaluate(`({order:[...document.querySelectorAll('.project-tab')].map(n=>n.title),names:[...document.querySelectorAll('.project-switch > span')].map(n=>n.textContent),active:document.querySelector('.project-tab.active').title})`);
  const passed=JSON.stringify(restored.order)===JSON.stringify(expected.afterDrag) && restored.active===expected.activeAfter && restored.names.some(n=>n.includes('我的中文项目 #'));
  save({passed,...restored});await capture(screenshotPath);socket.close();if(!passed)process.exitCode=1;
} else {
await evaluate(`window.focusEvents=[];for(const name of ['focus','blur'])window.addEventListener(name,e=>window.focusEvents.push({name,target:e.target.tagName,focus:document.hasFocus()}))`);
await openProject(fixture.root);await waitFor(`document.querySelectorAll('.cm-editor').length===2`);
await evaluate(`${buttonByText('重命名')}.click()`);await setInput('项目显示名称','我的中文项目 #');await evaluate(`document.querySelector('input[aria-label="项目显示名称"]').blur()`);
const renamed=await evaluate(`document.querySelector('.project-switch > span').textContent`);
const previous=JSON.parse(readFileSync('artifacts/task-02/runtime/fixture.json','utf8'));
await openProject(previous.projects[1]);
const order=()=>evaluate(`[...document.querySelectorAll('.project-tab')].map(n=>n.title)`);
const initialOrder=await order();
await evaluate(`document.querySelectorAll('.project-tab')[1].querySelectorAll('.project-action')[1].click()`);
await switchProject(fixture.root);await new Promise(r=>setTimeout(r,1200));
const afterAccess=await order();
// Use native WebView drag initiation from the dedicated handle; selection stays unchanged.
const activeBefore=await evaluate(`document.querySelector('.project-tab.active').title`);
let dragData;
const dragListener=({data})=>{const message=JSON.parse(data);if(message.method==='Input.dragIntercepted')dragData=message.params.data};
socket.addEventListener('message',dragListener);await call('Input.setInterceptDrags',{enabled:true});
const points=await evaluate(`(()=>{const tabs=document.querySelectorAll('.project-tab');const from=tabs[1].querySelector('.project-drag').getBoundingClientRect();const to=tabs[0].getBoundingClientRect();return {from:{x:from.x+from.width/2,y:from.y+from.height/2},to:{x:to.x+to.width/2,y:to.y+to.height/2}}})()`);
await call('Input.dispatchMouseEvent',{type:'mouseMoved',...points.from});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.from});
for(let i=1;i<=12;i++)await call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:points.from.x+(points.to.x-points.from.x)*i/12,y:points.from.y+(points.to.y-points.from.y)*i/12});
await new Promise(r=>setTimeout(r,250));if(!dragData)throw Error('Native drag did not start');
for(const type of ['dragEnter','dragOver','drop'])await call('Input.dispatchDragEvent',{type,...points.to,data:dragData});
await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...points.to});await call('Input.setInterceptDrags',{enabled:false});socket.removeEventListener('message',dragListener);
const afterDrag=await order();const activeAfter=await evaluate(`document.querySelector('.project-tab.active').title`);
await evaluate(`${buttonByText('↻ 本地刷新')}.click()`);await new Promise(r=>setTimeout(r,1500));
const afterRefresh=await order();
const names=await evaluate(`[...document.querySelectorAll('.project-switch > span')].map(n=>n.textContent)`);
const persisted=await evaluate(`JSON.parse(localStorage.getItem('oris.workspace.v2'))`);
const passed=renamed.includes('我的中文项目 #') && JSON.stringify(initialOrder)===JSON.stringify(afterAccess) && afterDrag[0]===initialOrder[1] && activeAfter===activeBefore && JSON.stringify(afterRefresh)===JSON.stringify(afterDrag);
save({passed,renamed,initialOrder,afterAccess,afterDrag,activeBefore,activeAfter,afterRefresh,names,persisted});await capture(screenshotPath);socket.close();if(!passed)process.exitCode=1;

}
