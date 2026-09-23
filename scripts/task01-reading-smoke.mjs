import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 9250);
const repository = process.argv[3];
const outputPrefix = process.argv[4] ?? "artifacts/task-01/runtime/reading";
if (!repository) throw new Error("Usage: node scripts/task01-reading-smoke.mjs <port> <repo> [output-prefix]");

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
const capture = async (suffix) => {
  const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  writeFileSync(`${outputPrefix}-${suffix}.png`, Buffer.from(shot.data, "base64"));
};
const pointFor = async (selector) => evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
const click = async (selector) => {
  const point = await pointFor(selector);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
};
const key = async (keyName, code, modifiers = 0) => {
  const virtualKey = keyName === "Enter" ? 13 : keyName === "Escape" ? 27 : keyName.toLowerCase() === "f" ? 70 : 0;
  await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyName, code, modifiers, windowsVirtualKeyCode: virtualKey });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers, windowsVirtualKeyCode: virtualKey });
};
const setSearch = async (value) => {
  await evaluate(`(() => { const input=document.querySelector('.oris-search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); })()`);
  await wait(180);
};

await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
await evaluate(`(() => {
  const input=document.querySelector('input[aria-label="仓库路径"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(repository)});
  input.dispatchEvent(new Event('input',{bubbles:true}));
  [...document.querySelectorAll('button')].find((button)=>button.textContent.trim()==='载入').click();
})()`);
await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label')==='src/reading.ts' && document.querySelectorAll('.oris-split-pane').length===2`);
await evaluate(`(() => {
  const toggle=(label,desired)=>{const button=[...document.querySelectorAll('.toggle-button')].find((node)=>node.textContent.includes(label));if(button?.classList.contains('active')!==desired)button.click();};
  toggle('折叠上下文',false);toggle('自动换行',false);toggle('对齐变化',false);
})()`);
await waitFor(`document.querySelectorAll('.cm-collapsedLines').length===0 && document.querySelectorAll('.cm-lineWrapping').length===0 && document.querySelector('.oris-split-view')?.dataset.alignmentEnabled==='false'`);

await key("f", "KeyF", 2);
await waitFor(`!document.querySelector('.oris-search-panel').hidden && document.activeElement?.classList.contains('oris-search-input')`);
await setSearch("wins");
await waitFor(`document.querySelector('.oris-search-status').textContent!=='0/0'`);
const insensitive = await evaluate(`(() => ({
  status:document.querySelector('.oris-search-status').textContent,
  panelBackground:getComputedStyle(document.querySelector('.oris-search-panel')).backgroundColor,
  inputBackground:getComputedStyle(document.querySelector('.oris-search-input')).backgroundColor,
  current:document.querySelectorAll('.oris-search-match.current').length,
  others:document.querySelectorAll('.oris-search-match:not(.current)').length,
  nativeInputs:[...document.querySelectorAll('input')].filter((node)=>node!==document.querySelector('.oris-search-input')&&node.value==='wins').length
}))()`);
await capture("dark-search");

await click('.oris-search-option[aria-label="区分大小写"]');
await wait(180);
const caseSensitive = await evaluate(`document.querySelector('.oris-search-status').textContent`);
await click('.oris-search-option[aria-label="全字匹配"]');
await wait(180);
const wholeWord = await evaluate(`document.querySelector('.oris-search-status').textContent`);
await click('.oris-search-option[aria-label="区分大小写"]');
await click('.oris-search-option[aria-label="全字匹配"]');
await click('.oris-search-option[aria-label="使用正则表达式"]');
await setSearch("w.ns");
const regexp = await evaluate(`document.querySelector('.oris-search-status').textContent`);
await setSearch("[");
const invalid = await evaluate(`(() => ({text:document.querySelector('.oris-search-status').textContent,error:document.querySelector('.oris-search-status').classList.contains('error')}))()`);
await setSearch("^");
const zeroLength = await evaluate(`document.querySelector('.oris-search-status').textContent`);
await click('.oris-search-option[aria-label="使用正则表达式"]');
await setSearch("a+b");
await key("Enter", "Enter");
await wait(220);
const literalSearch = await evaluate(`document.querySelector('.oris-search-status').textContent`);
await key("Enter", "Enter", 8);
await wait(120);
const previousSearch = await evaluate(`document.querySelector('.oris-search-status').textContent`);
const searchNavigationScroll = await evaluate(`([...document.querySelectorAll('.oris-split-pane .cm-scroller')].map((node)=>node.scrollTop))`);
await key("Escape", "Escape");
await waitFor(`document.querySelector('.oris-search-panel').hidden`);
await wait(80);
const focusAfterClose = await evaluate(`(() => ({inEditor:Boolean(document.activeElement?.closest?.('.cm-editor')),scroll:[...document.querySelectorAll('.oris-split-pane .cm-scroller')].map((node)=>node.scrollTop)}))()`);
await evaluate(`(() => { const scroller=document.querySelector('.oris-split-pane.right .cm-scroller'); scroller.scrollTop=520; scroller.dispatchEvent(new Event('scroll')); })()`);
await wait(300);

const textRect = await evaluate(`(() => {
  const line=[...document.querySelectorAll('.oris-split-pane.right .cm-line')].find((node)=>node.textContent.includes('a+b'));
  if(!line) return null;
  const nodes=[], walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()) nodes.push(walker.currentNode);
  const text=nodes.map((node)=>node.nodeValue).join(''), index=text.indexOf('a+b');
  let offset=0,startNode,startOffset,endNode,endOffset;
  for(const node of nodes){
    const next=offset+node.nodeValue.length;
    if(!startNode && index>=offset && index<next){startNode=node;startOffset=index-offset;}
    if(index+3>offset && index+3<=next){endNode=node;endOffset=index+3-offset;break;}
    offset=next;
  }
  if(!startNode||!endNode) return null;
    const first=document.createRange(), last=document.createRange();
    first.setStart(startNode,startOffset); first.setEnd(startNode,startOffset+1);
    last.setStart(endNode,endOffset-1); last.setEnd(endNode,endOffset);
    const a=first.getBoundingClientRect(), b=last.getBoundingClientRect();
    return {x1:a.left+1,x2:b.right-1,y:a.top+a.height/2};
})()`);
if (!textRect) {
  const diagnostic = await evaluate(`(() => ({scroll:[...document.querySelectorAll('.oris-split-pane .cm-scroller')].map((node)=>node.scrollTop),lines:[...document.querySelectorAll('.oris-split-pane.right .cm-line')].map((node)=>node.textContent).slice(0,5),status:document.querySelector('.oris-search-status').textContent}))()`);
  throw new Error(`Visible a+b text not found for real pointer selection: ${JSON.stringify(diagnostic)}`);
}
await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: textRect.x1, y: textRect.y });
await call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: textRect.x2, y: textRect.y });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: textRect.x2, y: textRect.y });
await waitFor(`getSelection().toString()==='a+b' && document.querySelectorAll('.oris-selection-match').length>=2`);
const selection = await evaluate(`(() => { const range=getSelection().getRangeAt(0); const selectedElement=range.startContainer.nodeType===Node.TEXT_NODE?range.startContainer.parentElement:range.startContainer; return ({
  text:getSelection().toString(),
  sameMatches:document.querySelectorAll('.oris-selection-match').length,
  matchedTexts:[...document.querySelectorAll('.oris-selection-match')].map((node)=>node.textContent),
  searchOpen:!document.querySelector('.oris-search-panel').hidden,
  activeTag:document.activeElement?.className,
  selectionBackground:selectedElement instanceof Element?getComputedStyle(selectedElement,'::selection').backgroundColor:'unavailable',
  selectionLayerBackground:document.querySelector('.cm-selectionBackground')?getComputedStyle(document.querySelector('.cm-selectionBackground')).backgroundColor:'none',
  changedBackground:getComputedStyle(document.querySelector('.app')).getPropertyValue('--diff-word-bg').trim(),
  selectedStillVisible:getSelection().rangeCount===1 && getSelection().getRangeAt(0).getBoundingClientRect().width>0
});})()`);
await capture("selection-literal");

await click('button[aria-label="切换主题"]');
await waitFor(`document.querySelector('.app.light') && document.querySelectorAll('.oris-split-pane').length===2`);
await key("f", "KeyF", 2);
await setSearch("wins");
const light = await evaluate(`(() => ({panel:getComputedStyle(document.querySelector('.oris-search-panel')).backgroundColor,input:getComputedStyle(document.querySelector('.oris-search-input')).backgroundColor,status:document.querySelector('.oris-search-status').textContent}))()`);
await capture("light-search");
await key("Escape", "Escape");
await click('button[aria-label="切换主题"]');
await waitFor(`document.querySelector('.app.dark') && document.querySelectorAll('.diff-overview-viewport').length===2`);

await click('.diff-overview-rail.right .diff-overview-marker[data-hunk-index="1"]');
await wait(350);
const winsRect = await evaluate(`(() => {
  const line=[...document.querySelectorAll('.oris-split-pane.right .cm-line')].find((node)=>node.textContent.includes('modifiedWins'));
  if(!line) return null;
  const nodes=[], walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()) nodes.push(walker.currentNode);
  const text=nodes.map((node)=>node.nodeValue).join(''), index=text.lastIndexOf('wins');
  let offset=0,startNode,startOffset,endNode,endOffset;
  for(const node of nodes){const next=offset+node.nodeValue.length;if(!startNode&&index>=offset&&index<next){startNode=node;startOffset=index-offset;}if(index+4>offset&&index+4<=next){endNode=node;endOffset=index+4-offset;break;}offset=next;}
  if(!startNode||!endNode) return null;
  const first=document.createRange(),last=document.createRange();first.setStart(startNode,startOffset);first.setEnd(startNode,startOffset+1);last.setStart(endNode,endOffset-1);last.setEnd(endNode,endOffset);
  const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();return{x1:a.left+1,x2:b.right-1,y:a.top+a.height/2};
})()`);
if (!winsRect) throw new Error('Visible modified wins text not found');
await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: winsRect.x1, y: winsRect.y });
await call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: winsRect.x2, y: winsRect.y });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: winsRect.x2, y: winsRect.y });
await waitFor(`getSelection().toString()==='wins' && document.querySelectorAll('.oris-selection-match').length>1`);
const winsSelection = await evaluate(`(() => {const range=getSelection().getRangeAt(0),node=range.commonAncestorContainer.nodeType===Node.TEXT_NODE?range.commonAncestorContainer.parentElement:range.commonAncestorContainer;return{text:getSelection().toString(),sameMatches:document.querySelectorAll('.oris-selection-match').length,inModified:node.closest('.oris-modified-line')!==null,visible:range.getBoundingClientRect().width>0};})()`);
await capture("selection-wins-diff");
const collapsePoint = await evaluate(`(() => {const r=[...document.querySelectorAll('.oris-split-pane.right .cm-line')].find((node)=>node.textContent.includes('modifiedWins')).getBoundingClientRect();return{x:r.left+3,y:r.top+r.height/2};})()`);
await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: collapsePoint.x, y: collapsePoint.y });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: collapsePoint.x, y: collapsePoint.y });
await waitFor(`getSelection().isCollapsed && document.querySelectorAll('.oris-selection-match').length===0`);
const emptySelectionCleared = await evaluate(`getSelection().isCollapsed && document.querySelectorAll('.oris-selection-match').length===0`);

const bandsBefore = await evaluate(`(() => [...document.querySelectorAll('.diff-overview-rail')].map((rail)=>{const band=rail.querySelector('.diff-overview-viewport'),r=band.getBoundingClientRect(),rr=rail.getBoundingClientRect();return{top:r.top-rr.top,height:r.height,from:Number(band.dataset.lineFrom),to:Number(band.dataset.lineTo),total:Number(band.dataset.lineTotal),rail:rr.height,noTraditionalThumb:!rail.querySelector('.diff-overview-thumb')}}))()`);
const leftScroller = await pointFor('.oris-split-pane.left .cm-scroller');
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: leftScroller.x, y: leftScroller.y });
await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: leftScroller.x, y: leftScroller.y, deltaX: 0, deltaY: 620 });
await wait(400);
const bandsAfter = await evaluate(`(() => [...document.querySelectorAll('.diff-overview-rail')].map((rail)=>{const band=rail.querySelector('.diff-overview-viewport'),r=band.getBoundingClientRect(),rr=rail.getBoundingClientRect();const marker=rail.querySelector('.diff-overview-marker');const mr=marker.getBoundingClientRect();return{top:r.top-rr.top,height:r.height,from:Number(band.dataset.lineFrom),to:Number(band.dataset.lineTo),total:Number(band.dataset.lineTotal),rail:rr.height,markerHit:document.elementFromPoint(mr.left+mr.width/2,mr.top+mr.height/2)===marker}}))()`);
await capture("viewport-band-scroll");
await evaluate(`([...document.querySelectorAll('.toggle-button')].find((button)=>button.textContent.includes('自动换行'))).click()`);
await waitFor(`document.querySelectorAll('.cm-lineWrapping').length===2`);
await wait(250);
const wrapBands = await evaluate(`([...document.querySelectorAll('.diff-overview-viewport')].map((band)=>({from:Number(band.dataset.lineFrom),to:Number(band.dataset.lineTo),height:band.getBoundingClientRect().height})))`);
await evaluate(`([...document.querySelectorAll('.toggle-button')].find((button)=>button.textContent.includes('折叠上下文'))).click()`);
await waitFor(`document.querySelectorAll('.cm-collapsedLines').length>0`);
await wait(250);
const foldBands = await evaluate(`([...document.querySelectorAll('.diff-overview-viewport')].map((band)=>({from:Number(band.dataset.lineFrom),to:Number(band.dataset.lineTo),height:band.getBoundingClientRect().height})))`);
await capture("viewport-band");
await evaluate(`([...document.querySelectorAll('.toggle-button')].find((button)=>button.textContent.includes('对齐变化'))).click()`);
await waitFor(`document.querySelector('.oris-split-view')?.dataset.alignmentReady==='true'`);
await key("f", "KeyF", 2);
await setSearch('modifiedWins');
const alignGeneration = await evaluate(`Number(document.querySelector('.oris-split-view')?.dataset.alignmentGeneration??0)`);
await key("Enter", "Enter");
await waitFor(`Number(document.querySelector('.oris-split-view')?.dataset.alignmentGeneration??0)>${alignGeneration} && document.querySelector('.oris-split-view')?.dataset.alignmentReady==='true'`, 30000);
const alignedSearch = await evaluate(`(() => ({status:document.querySelector('.oris-search-status').textContent,ready:document.querySelector('.oris-split-view').dataset.alignmentReady,spacers:document.querySelectorAll('.oris-alignment-spacer').length}))()`);
await key("Escape", "Escape");
await evaluate(`(() => {const select=document.querySelector('select[aria-label="Diff 布局"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'unified');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await waitFor(`document.querySelectorAll('.cm-editor').length===1`);
await key("f", "KeyF", 2);
await waitFor(`!document.querySelector('.oris-search-panel').hidden`);
await setSearch('wins');
const unifiedSearch = await evaluate(`(() => ({status:document.querySelector('.oris-search-status').textContent,editors:document.querySelectorAll('.cm-editor').length,replaceControls:[...document.querySelectorAll('.oris-search-panel input,.oris-search-panel button')].filter((node)=>/替换|replace/i.test(node.getAttribute('aria-label')??node.textContent)).length}))()`);
await key("Escape", "Escape");

const count = (status) => Number(String(status).split('/').at(-1)?.replace('+','') ?? 0);
const bandLogical = (band) => Math.abs(band.top - band.rail * band.from / band.total) <= 2 &&
  Math.abs(band.height - Math.max(2, band.rail * (band.to - band.from) / band.total)) <= 2;
const result = { insensitive, caseSensitive, wholeWord, regexp, invalid, zeroLength, literalSearch, previousSearch, searchNavigationScroll, focusAfterClose, selection, winsSelection, emptySelectionCleared, light, bandsBefore, bandsAfter, wrapBands, foldBands, alignedSearch, unifiedSearch };
result.passed = count(insensitive.status) > count(caseSensitive) && count(caseSensitive) > count(wholeWord) &&
  count(regexp) > 0 && invalid.error && invalid.text.includes('无效') && zeroLength === '0/0' && literalSearch === '2/2' && previousSearch === '1/2' &&
  searchNavigationScroll.some((value)=>value>0) &&
  insensitive.current === 1 && insensitive.others > 0 && insensitive.nativeInputs === 0 &&
  selection.text === 'a+b' && selection.sameMatches >= 2 && selection.matchedTexts.every((text)=>text === 'a+b') &&
  !selection.searchOpen && selection.selectedStillVisible && selection.selectionLayerBackground !== 'none' && selection.selectionLayerBackground !== selection.changedBackground &&
  winsSelection.text === 'wins' && winsSelection.sameMatches > 1 && winsSelection.inModified && winsSelection.visible &&
  focusAfterClose.inEditor && emptySelectionCleared &&
  light.panel !== 'rgb(255, 255, 255)' && light.input !== 'rgb(255, 255, 255)' &&
  bandsBefore.every((band)=>bandLogical(band) && band.noTraditionalThumb) && bandsAfter.every((band,index)=>bandLogical(band) && band.from > bandsBefore[index].from && band.markerHit) &&
  wrapBands.every((band)=>band.to>band.from && band.height>=2) && foldBands.every((band)=>band.to>band.from && band.height>=2) &&
  alignedSearch.ready==='true' && alignedSearch.spacers>0 && count(alignedSearch.status)>0 &&
  unifiedSearch.editors===1 && count(unifiedSearch.status)>0 && unifiedSearch.replaceControls===0;
writeFileSync(`${outputPrefix}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
socket.close();
