import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 9250);
const repository = process.argv[3];
const outputPrefix = process.argv[4] ?? "artifacts/task-01/runtime/scroll-model";
if (!repository) throw new Error("Usage: node scripts/task01-scroll-smoke.mjs <port> <repo> [output-prefix]");

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
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`${message.error.message} during ${waiter.label}`));
  else waiter.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject, label: `${method} ${JSON.stringify(params).slice(0, 180)}` });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await wait(100);
  }
  throw new Error(`Timed out: ${expression}`);
};
const clickPoint = async (point) => {
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
};
const pointFor = (selector) => evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
const capture = async (suffix) => {
  const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${outputPrefix}-${suffix}.png`, Buffer.from(shot.data, "base64"));
};

await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
await evaluate(`localStorage.removeItem('oris.recentRepository.v1'); location.reload()`);
await waitFor(`document.querySelector('input[aria-label="仓库路径"]')`);
await evaluate(`(() => {
  const input=document.querySelector('input[aria-label="仓库路径"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(repository)});
  input.dispatchEvent(new Event('input',{bubbles:true}));
  [...document.querySelectorAll('.openbar button')].find((b)=>b.textContent.trim()==='载入').click();
})()`);
await waitFor(`document.querySelector('.oris-split-view') && document.querySelectorAll('.file').length === 3`);

const selectFile = async (path, viewSelector = ".oris-split-view") => {
  await evaluate(`([...document.querySelectorAll('.file')].find((b)=>b.getAttribute('aria-label')===${JSON.stringify(path)})).click()`);
  await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label')===${JSON.stringify(path)} && document.querySelector('.tabbar strong')?.textContent===${JSON.stringify(path)} && document.querySelector('.endpoints .encoding') && document.querySelector(${JSON.stringify(viewSelector)})`);
  await wait(500);
};

await selectFile("src/mixed.ts");
const initial = await evaluate(`(() => {
  const root=document.querySelector('.oris-split-view');
  const scrollers=[...root.querySelectorAll('.cm-scroller')];
  const rails=[...root.querySelectorAll('.diff-overview-rail')];
  return {
    mergeViews:document.querySelectorAll('.cm-mergeView').length,
    mergeSpacers:document.querySelectorAll('.cm-mergeSpacer').length,
    orisSpacers:document.querySelectorAll('.oris-alignment-spacer').length,
    scrollers:scrollers.map((s)=>({top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,overflow:getComputedStyle(s).overflowY})),
    rails:rails.map((r)=>{const marker=r.querySelector('.diff-overview-marker')?.getBoundingClientRect();const band=r.querySelector('.diff-overview-viewport').getBoundingClientRect();const bandNode=r.querySelector('.diff-overview-viewport');return{label:r.getAttribute('aria-label'),width:r.getBoundingClientRect().width,max:Number(r.getAttribute('aria-valuemax')),now:Number(r.getAttribute('aria-valuenow')),markers:r.querySelectorAll('.diff-overview-marker').length,noTraditionalThumb:!r.querySelector('.diff-overview-thumb'),band:{height:band.height,from:Number(bandNode.dataset.lineFrom),to:Number(bandNode.dataset.lineTo),total:Number(bandNode.dataset.lineTotal)},merged:!!marker&&marker.left<band.right&&marker.right>band.left}}),
    connectors:document.querySelectorAll('.diff-connectors path').length,
    zeroLines:document.querySelectorAll('.diff-zero-line').length,
    toolbar:document.querySelector('.toolbar').getBoundingClientRect().top,
    workspaceTop:document.querySelector('.workspace').scrollTop,
    alignment:root.dataset.alignmentEnabled
  };
})()`);

const scrollerPoints = await evaluate(`([...document.querySelectorAll('.oris-split-pane .cm-scroller')].map((s)=>{const r=s.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}}))`);
await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...scrollerPoints[0] });
await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...scrollerPoints[0], deltaX: 0, deltaY: 420 });
await wait(500);
const leftWheel = await evaluate(`(() => { const r=document.querySelector('.oris-split-view'); const s=[...r.querySelectorAll('.cm-scroller')]; return {master:r.dataset.masterSide,epoch:Number(r.dataset.syncEpoch),segment:Number(r.dataset.syncSegment),left:s[0].scrollTop,right:s[1].scrollTop,workspace:document.querySelector('.workspace').scrollTop}; })()`);
await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...scrollerPoints[1] });
await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...scrollerPoints[1], deltaX: 0, deltaY: 510 });
await wait(500);
const rightWheel = await evaluate(`(() => { const r=document.querySelector('.oris-split-view'); const s=[...r.querySelectorAll('.cm-scroller')]; return {master:r.dataset.masterSide,epoch:Number(r.dataset.syncEpoch),segment:Number(r.dataset.syncSegment),left:s[0].scrollTop,right:s[1].scrollTop,workspace:document.querySelector('.workspace').scrollTop}; })()`);
await wait(350);
const settled = await evaluate(`(() => { const r=document.querySelector('.oris-split-view'); const s=[...r.querySelectorAll('.cm-scroller')]; return {epoch:Number(r.dataset.syncEpoch),left:s[0].scrollTop,right:s[1].scrollTop}; })()`);

const leftViewport = await pointFor(".diff-overview-rail.left .diff-overview-viewport");
await call("Input.dispatchMouseEvent", { type: "mousePressed", ...leftViewport, button: "left", clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: leftViewport.x, y: leftViewport.y + 80, button: "left" });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: leftViewport.x, y: leftViewport.y + 80, button: "left", clickCount: 1 });
await wait(350);
const viewportDrag = await evaluate(`(() => { const r=document.querySelector('.oris-split-view'); const s=[...r.querySelectorAll('.cm-scroller')]; return {master:r.dataset.masterSide,left:s[0].scrollTop,right:s[1].scrollTop,aria:Number(document.querySelector('.diff-overview-rail.left').getAttribute('aria-valuenow'))}; })()`);

const rightRail = await pointFor(".diff-overview-rail.right");
await clickPoint(rightRail);
await wait(250);
await call("Input.dispatchKeyEvent", { type: "keyDown", key: "PageDown", code: "PageDown" });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "PageDown", code: "PageDown" });
await wait(350);
const keyboardRail = await evaluate(`(() => { const r=document.querySelector('.oris-split-view'); const s=[...r.querySelectorAll('.cm-scroller')]; return {master:r.dataset.masterSide,left:s[0].scrollTop,right:s[1].scrollTop,aria:Number(document.querySelector('.diff-overview-rail.right').getAttribute('aria-valuenow'))}; })()`);

const markerPoint = await pointFor(".diff-overview-rail.left .diff-overview-marker");
const beforeMarkerEpoch = await evaluate(`Number(document.querySelector('.oris-split-view').dataset.navigationEpoch ?? 0)`);
await clickPoint(markerPoint);
await wait(350);
const markerNavigation = await evaluate(`(() => { const r=document.querySelector('.oris-split-view'); return {before:${beforeMarkerEpoch},after:Number(r.dataset.navigationEpoch),label:document.querySelector('.diff-footer span')?.textContent,connectors:r.querySelectorAll('.diff-connectors path').length,zeroLines:r.querySelectorAll('.diff-zero-line').length}; })()`);
await capture("unaligned");

const toolbarBefore = await evaluate(`(() => ['.tabbar','.toolbar','.endpoints'].map((q)=>document.querySelector(q).getBoundingClientRect().top))()`);
for (let index = 0; index < 12; index += 1) {
  await evaluate(`([...document.querySelectorAll('.toolbar button')].find((b)=>b.title.startsWith('下一处差异'))).click()`);
}
await wait(350);
const navigation = await evaluate(`(() => ({positions:['.tabbar','.toolbar','.endpoints'].map((q)=>document.querySelector(q).getBoundingClientRect().top),workspace:document.querySelector('.workspace').scrollTop,navigationEpoch:Number(document.querySelector('.oris-split-view').dataset.navigationEpoch)}))()`);

await evaluate(`([...document.querySelectorAll('.toolbar button')].find((b)=>b.textContent.trim()==='对齐变化')).click()`);
await waitFor(`document.querySelector('.oris-split-view')?.dataset.alignmentReady==='true' && document.querySelectorAll('.oris-alignment-spacer').length>0`, 30000);
await evaluate(`(() => {
  globalThis.__orisScrollSmokeAlignmentGeneration = Number(document.querySelector('.oris-split-view')?.dataset.alignmentGeneration ?? 0);
  ([...document.querySelectorAll('.toolbar button')].find((b)=>b.title.startsWith('下一处差异'))).click();
})()`);
await waitFor(`Number(document.querySelector('.oris-split-view')?.dataset.alignmentGeneration ?? 0) > globalThis.__orisScrollSmokeAlignmentGeneration &&
  document.querySelector('.oris-split-view')?.dataset.alignmentReady==='true'`, 30000);
const aligned = await evaluate(`(() => ({spacers:document.querySelectorAll('.oris-alignment-spacer').length,mergeSpacers:document.querySelectorAll('.cm-mergeSpacer').length,ready:document.querySelector('.oris-split-view').dataset.alignmentReady,connectors:document.querySelectorAll('.diff-connectors path').length}))()`);
await capture("aligned");
await evaluate(`([...document.querySelectorAll('.toolbar button')].find((b)=>b.textContent.trim()==='对齐变化')).click()`);
await waitFor(`document.querySelector('.oris-split-view')?.dataset.alignmentEnabled==='false' && document.querySelectorAll('.oris-alignment-spacer').length===0`);
await evaluate(`([...document.querySelectorAll('.toolbar button')].find((b)=>b.title.startsWith('下一处差异'))).click()`);
await wait(350);
const toggledOff = await evaluate(`({spacers:document.querySelectorAll('.oris-alignment-spacer').length,mergeSpacers:document.querySelectorAll('.cm-mergeSpacer').length,zeroLines:document.querySelectorAll('.diff-zero-line').length})`);
const alignmentCycles = [];
for (let index = 0; index < 8; index += 1) {
  await evaluate(`([...document.querySelectorAll('.toolbar button')].find((b)=>b.textContent.trim()==='对齐变化')).click()`);
  const active = index % 2 === 0;
  if (active) await waitFor(`document.querySelector('.oris-split-view')?.dataset.alignmentReady==='true'`);
  else await waitFor(`document.querySelector('.oris-split-view')?.dataset.alignmentEnabled==='false' && document.querySelectorAll('.oris-alignment-spacer').length===0`);
  alignmentCycles.push(await evaluate(`({active:document.querySelector('.oris-split-view').dataset.alignmentEnabled==='true',spacers:document.querySelectorAll('.oris-alignment-spacer').length,mergeSpacers:document.querySelectorAll('.cm-mergeSpacer').length})`));
}

await selectFile("src/insert-only.ts", ".oris-single-view.inserted");
const insertOnly = await evaluate(`(() => { const r=document.querySelector('.oris-single-view'); const rail=r.querySelector('.diff-overview-rail'); const band=rail.querySelector('.diff-overview-viewport'); return {side:r.dataset.singleSide,editors:r.querySelectorAll('.cm-editor').length,rails:r.querySelectorAll('.diff-overview-rail').length,split:!!document.querySelector('.oris-split-view'),connectors:r.querySelectorAll('.diff-connectors').length,markers:rail.querySelectorAll('.diff-overview-marker.inserted').length,noTraditionalThumb:!rail.querySelector('.diff-overview-thumb'),bandVisible:band.getBoundingClientRect().height>0,endpoint:document.querySelector('.single-endpoint')?.textContent,layoutDisabled:document.querySelector('select[aria-label="Diff 布局"]')?.disabled,alignDisabled:[...document.querySelectorAll('.toggle-button')].find(b=>b.textContent.includes('对齐变化'))?.disabled}; })()`);
await selectFile("src/delete-only.ts", ".oris-single-view.deleted");
const deleteOnly = await evaluate(`(() => { const r=document.querySelector('.oris-single-view'); const rail=r.querySelector('.diff-overview-rail'); return {side:r.dataset.singleSide,editors:r.querySelectorAll('.cm-editor').length,rails:r.querySelectorAll('.diff-overview-rail').length,split:!!document.querySelector('.oris-split-view'),connectors:r.querySelectorAll('.diff-connectors').length,markers:rail.querySelectorAll('.diff-overview-marker.deleted').length,noTraditionalThumb:!rail.querySelector('.diff-overview-thumb'),endpoint:document.querySelector('.single-endpoint')?.textContent}; })()`);

const result = {
  initial,
  leftWheel,
  rightWheel,
  settled,
  viewportDrag,
  keyboardRail,
  markerNavigation,
  toolbarBefore,
  navigation,
  aligned,
  toggledOff,
  alignmentCycles,
  insertOnly,
  deleteOnly
};
result.passed = initial.mergeViews === 0 && initial.mergeSpacers === 0 && initial.orisSpacers === 0 &&
  initial.scrollers.length === 2 && initial.scrollers.every((item) => item.height > item.client && item.overflow === "auto") &&
  initial.rails.length === 2 && initial.rails.every((rail) => rail.width === 24 && rail.markers > 0 && rail.max > 0 && rail.noTraditionalThumb && rail.merged && rail.band.total > 0 && rail.band.to > rail.band.from) &&
  leftWheel.master === "a" && leftWheel.left > 0 && leftWheel.right >= 0 && leftWheel.workspace === 0 &&
  rightWheel.master === "b" && rightWheel.epoch > leftWheel.epoch && rightWheel.workspace === 0 &&
  settled.epoch === rightWheel.epoch && Math.abs(settled.left - rightWheel.left) < 1 && Math.abs(settled.right - rightWheel.right) < 1 &&
  viewportDrag.master === "a" && viewportDrag.left > leftWheel.left && Math.abs(viewportDrag.aria - viewportDrag.left) <= 1 &&
  keyboardRail.master === "b" && Math.abs(keyboardRail.aria - keyboardRail.right) <= 1 &&
  markerNavigation.after > markerNavigation.before && markerNavigation.connectors > 0 && markerNavigation.zeroLines > 0 &&
  navigation.workspace === 0 && navigation.positions.every((value, index) => Math.abs(value - toolbarBefore[index]) < 1) &&
  aligned.spacers > 0 && aligned.mergeSpacers === 0 && aligned.ready === "true" && aligned.connectors > 0 &&
  toggledOff.spacers === 0 && toggledOff.mergeSpacers === 0 && toggledOff.zeroLines > 0 &&
  alignmentCycles.every((cycle, index) => cycle.mergeSpacers === 0 && (index % 2 === 0 ? cycle.active && cycle.spacers > 0 : !cycle.active && cycle.spacers === 0)) &&
  insertOnly.side === "b" && insertOnly.editors === 1 && insertOnly.rails === 1 && !insertOnly.split && insertOnly.connectors === 0 && insertOnly.markers > 0 && insertOnly.noTraditionalThumb && insertOnly.bandVisible && insertOnly.endpoint?.includes("Working Tree") && insertOnly.layoutDisabled && insertOnly.alignDisabled &&
  deleteOnly.side === "a" && deleteOnly.editors === 1 && deleteOnly.rails === 1 && !deleteOnly.split && deleteOnly.connectors === 0 && deleteOnly.markers > 0 && deleteOnly.noTraditionalThumb && deleteOnly.endpoint?.includes("Index");

writeFileSync(`${outputPrefix}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
socket.close();
if (!result.passed) process.exitCode = 1;
