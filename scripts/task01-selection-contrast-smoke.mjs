import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 9250);
const repository = process.argv[3];
const outputPrefix = process.argv[4] ?? "artifacts/task-01/runtime/selection-contrast";
if (!repository) throw new Error("Usage: node scripts/task01-selection-contrast-smoke.mjs <port> <repo> [output-prefix]");

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
  const handlers = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) handlers.reject(new Error(message.error.message));
  else handlers.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await wait(120);
  }
  throw new Error(`Timed out: ${expression}`);
};
const pointFor = async (selector) => evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
const click = async (selector) => {
  const point = await pointFor(selector);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
};
const capture = async (suffix) => {
  const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  writeFileSync(`${outputPrefix}-${suffix}.png`, Buffer.from(shot.data, "base64"));
};

await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 820, deviceScaleFactor: 1, mobile: false });
await evaluate(`(() => {
  const input=document.querySelector('input[aria-label="仓库路径"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(repository)});
  input.dispatchEvent(new Event('input',{bubbles:true}));
  [...document.querySelectorAll('button')].find((button)=>button.textContent.trim()==='载入').click();
})()`);
await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label')==='src/reading.ts' && document.querySelectorAll('.oris-split-pane').length===2`);
await evaluate(`(() => {
  const layout=document.querySelector('select[aria-label="Diff 布局"]');
  if(layout.value!=='split'){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(layout,'split');layout.dispatchEvent(new Event('change',{bubbles:true}));}
  const toggle=(label,desired)=>{const button=[...document.querySelectorAll('.toggle-button')].find((node)=>node.textContent.includes(label));if(button?.classList.contains('active')!==desired)button.click();};
  toggle('折叠上下文',false);toggle('自动换行',false);toggle('对齐变化',false);
})()`);
await waitFor(`document.querySelectorAll('.oris-split-pane').length===2 && document.querySelectorAll('.cm-collapsedLines').length===0`);

const ensureTheme = async (theme) => {
  const current = await evaluate(`document.querySelector('.app').classList.contains('light')?'light':'dark'`);
  if (current !== theme) {
    await click('button[aria-label="切换主题"]');
    await waitFor(`document.querySelector('.app').classList.contains(${JSON.stringify(theme)}) && document.querySelectorAll('.oris-split-pane').length===2`);
  }
};

const selectRealText = async ({ theme, hunk, side, lineText, text, tone }) => {
  await ensureTheme(theme);
  await click(`.diff-overview-rail.${side === 'left' ? 'left' : 'right'} .diff-overview-marker[data-hunk-index="${hunk}"]`);
  await wait(320);
  const selector = `.oris-split-pane.${side} .cm-line`;
  const target = await evaluate(`(() => {
    const line=[...document.querySelectorAll(${JSON.stringify(selector)})].find((node)=>node.textContent.includes(${JSON.stringify(lineText)}));
    if(!line)return null;
    const nodes=[],walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);while(walker.nextNode())nodes.push(walker.currentNode);
    const joined=nodes.map((node)=>node.nodeValue).join(''),index=joined.indexOf(${JSON.stringify(text)});
    let offset=0,startNode,startOffset,endNode,endOffset;
    for(const node of nodes){const next=offset+node.nodeValue.length;if(!startNode&&index>=offset&&index<next){startNode=node;startOffset=index-offset;}if(index+${text.length}>offset&&index+${text.length}<=next){endNode=node;endOffset=index+${text.length}-offset;break;}offset=next;}
    if(!startNode||!endNode)return null;
    const first=document.createRange(),last=document.createRange();first.setStart(startNode,startOffset);first.setEnd(startNode,startOffset+1);last.setStart(endNode,endOffset-1);last.setEnd(endNode,endOffset);
    const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();return{x1:a.left+1,x2:b.right-1,y:a.top+a.height/2};
  })()`);
  if (!target) throw new Error(`Visible target not found: ${theme}/${tone}/${text}`);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: target.x1, y: target.y });
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: target.x2, y: target.y });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: target.x2, y: target.y });
  await waitFor(`getSelection().toString()===${JSON.stringify(text)} && document.querySelector('.cm-selectionBackground')`);
  const evidence = await evaluate(`(() => {
    const selection=getSelection(),range=selection.getRangeAt(0),rect=range.getBoundingClientRect();
    const pane=document.querySelector(${JSON.stringify(`.oris-split-pane.${side}`)}).getBoundingClientRect();
    const node=range.commonAncestorContainer.nodeType===Node.TEXT_NODE?range.commonAncestorContainer.parentElement:range.commonAncestorContainer;
    const line=node.closest('.cm-line'),layer=[...document.querySelectorAll('.cm-selectionBackground')].map((item)=>item.getBoundingClientRect()).find((item)=>item.right>=rect.left-1&&item.left<=rect.right+1&&item.bottom>=rect.top-1&&item.top<=rect.bottom+1);
    return{text:selection.toString(),tone:line.className,selectionColor:layer?getComputedStyle(document.querySelector('.cm-selectionBackground')).backgroundColor:'none',lineColor:getComputedStyle(line).backgroundColor,rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width},pane:{left:pane.left,right:pane.right},full:rect.width>0&&rect.left>=pane.left&&rect.right<=pane.right};
  })()`);
  await capture(`${theme}-${tone}`);
  return evidence;
};

const cases = [];
for (const theme of ["dark", "light"]) {
  cases.push({ theme, tone: "modified", evidence: await selectRealText({ theme, hunk: 1, side: "right", lineText: "modifiedWins", text: "wins", tone: "modified" }) });
  cases.push({ theme, tone: "deleted", evidence: await selectRealText({ theme, hunk: 0, side: "left", lineText: "removedWins", text: "removedWins", tone: "deleted" }) });
  cases.push({ theme, tone: "inserted-cn", evidence: await selectRealText({ theme, hunk: 2, side: "right", lineText: "chineseWins", text: "胜利", tone: "inserted" }) });
}

const expectedClass = { modified: "oris-modified-line", deleted: "oris-deleted-line", "inserted-cn": "oris-inserted-line" };
const result = { release: await evaluate(`document.querySelector('.app')!==null`), cases };
result.passed = cases.every((item) => item.evidence.text && item.evidence.full && item.evidence.selectionColor !== "none" && item.evidence.selectionColor !== item.evidence.lineColor && item.evidence.tone.includes(expectedClass[item.tone]));
writeFileSync(`${outputPrefix}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
socket.close();
if (!result.passed) process.exitCode = 1;
