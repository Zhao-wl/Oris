import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 9224);
const repository = process.argv[3];
const screenshotPath = process.argv[4];
const resultPath = process.argv[5];
if (!repository) throw new Error("Usage: node scripts/task01-feedback-smoke.mjs <port> <repository> [screenshot] [result-json]");

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
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
};
const waitFor = async (expression, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}`);
};
const waitForAlignment = async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await waitFor(
    `document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'`,
    20000
  );
};
const mouse = async (type, x, y, button = "left") => call("Input.dispatchMouseEvent", {
  type, x, y, button, clickCount: 1
});
const capture = async (path) => {
  if (!path) return;
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(screenshot.data, "base64"));
};
const layout = () => evaluate(`(() => {
  const rect = (selector) => {
    const value = document.querySelector(selector)?.getBoundingClientRect();
    return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
  };
  const panes = [...document.querySelectorAll('.oris-split-pane')].map((node) => {
    const value = node.getBoundingClientRect();
    return { left: value.left, right: value.right, width: value.width };
  });
  const merge = rect('.oris-split-view');
  const editorRoot = rect('.oris-split-editors');
  const host = rect('.diff-host');
  const headers = [...document.querySelectorAll('.endpoints > span')].map((node) => {
    const value = node.getBoundingClientRect();
    return { left: value.left, right: value.right, width: value.width };
  });
  const connectors = [...document.querySelectorAll('.diff-connectors path')].map((node) => {
    const rect = node.getBoundingClientRect();
    const value = (name) => Number(node.dataset[name]);
    const fromA = value('fromA'), toA = value('toA'), fromB = value('fromB'), toB = value('toB');
    return {
      kind: node.classList.contains('inserted') ? 'inserted' : node.classList.contains('deleted') ? 'deleted' : 'modified',
      fromA, toA, fromB, toB,
      zeroA: fromA === toA,
      zeroB: fromB === toB,
      aTop: value('aTop'), aBottom: value('aBottom'), bTop: value('bTop'), bBottom: value('bBottom'),
      aPaintBottom: value('aPaintBottom'), bPaintBottom: value('bPaintBottom'),
      topDelta: Math.abs(value('aTop') - value('bTop')),
      bottomDelta: Math.abs(value('aBottom') - value('bBottom')),
      width: rect.width,
      visible: rect.bottom >= document.querySelector('.oris-split-view').getBoundingClientRect().top &&
        rect.top <= document.querySelector('.oris-split-view').getBoundingClientRect().bottom,
      closed: /Z\\s*$/.test(node.getAttribute('d')),
      finite: [...node.getAttribute('d').matchAll(/-?\\d+(?:\\.\\d+)?/g)].every((match) => Number.isFinite(Number(match[0])))
    };
  });
  const nonZero = connectors.filter((item) => !item.zeroA && !item.zeroB);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    workspace: rect('.workspace'), sidebar: rect('.sidebar'), workspaceResizer: rect('.workspace-resizer'),
    editor: rect('.editor'), host, merge, editorRoot, panes, headers, diffResizer: rect('.diff-pane-resizer'),
    connectorCount: document.querySelectorAll('.diff-connectors path').length,
    connectors,
    connectorWidths: connectors.map((item) => item.width),
    alignmentSpacerCount: document.querySelectorAll('.oris-alignment-spacer').length,
    alignmentReady: document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true',
    alignButtonActive: [...document.querySelectorAll('.toolbar button')]
      .find((button) => button.textContent.includes('对齐变化'))?.classList.contains('active') ?? false,
    nonZeroAligned: nonZero.every((item) => item.topDelta <= 1 && item.bottomDelta <= 1),
    maxNonZeroSkew: nonZero.reduce((maximum, item) => Math.max(maximum, item.topDelta, item.bottomDelta), 0),
    zeroAnchorsValid: connectors.filter((item) => item.zeroA || item.zeroB).every((item) =>
      (!item.zeroA || (item.aTop === item.aBottom && item.aPaintBottom >= item.aBottom + 1 &&
        Math.abs(item.aTop - item.bTop) <= 1 && Math.abs(item.aPaintBottom - item.bPaintBottom) <= 1)) &&
      (!item.zeroB || (item.bTop === item.bBottom && item.bPaintBottom >= item.bBottom + 1 &&
        Math.abs(item.aTop - item.bTop) <= 1 && Math.abs(item.aPaintBottom - item.bPaintBottom) <= 1))
    ),
    leftRatio: panes.length === 2 ? panes[0].width / (panes[0].width + panes[1].width) : null,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    mergeFillsHost: !!merge && !!host && Math.abs(merge.left - host.left) <= 1 && Math.abs(merge.right - host.right) <= 1,
    panesFillMerge: !!editorRoot && panes.length === 2 &&
      Math.abs(panes[0].left - editorRoot.left - 24) <= 1 && Math.abs(editorRoot.right - panes[1].right - 24) <= 1,
    headersAlignPanes: headers.length === 3 && panes.length === 2 &&
      Math.abs(headers[0].right - panes[0].right) <= 1 && Math.abs(headers[2].left - panes[1].left) <= 1,
    visibleCurveGutter: connectors.some((item) => item.width >= 50),
    centralGap: panes.length === 2 ? panes[1].left - panes[0].right : null
  };
})()`);

await call("Runtime.enable");
const loadStarted = await evaluate(`(() => {
  const input = document.querySelector('input[aria-label="仓库路径"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(repository)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  globalThis.__orisFeedbackLoadStarted = performance.now();
  [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '载入').click();
  return globalThis.__orisFeedbackLoadStarted;
})()`);
await waitFor(`document.querySelector('.file.selected') && document.querySelectorAll('.oris-split-pane').length === 2`);
await evaluate(`(() => {
  const button = [...document.querySelectorAll('.toggle-button')].find((node) => node.textContent.includes('对齐变化'));
  if (button?.getAttribute('aria-pressed') !== 'true') button.click();
})()`);
await waitForAlignment();
const openAndFirstFileMs = await evaluate(`performance.now() - globalThis.__orisFeedbackLoadStarted`);
const initial = await layout();

const sidebarHandle = initial.workspaceResizer;
await mouse("mousePressed", sidebarHandle.left + sidebarHandle.width / 2, sidebarHandle.top + 120);
await mouse("mouseMoved", sidebarHandle.left + sidebarHandle.width / 2 + 84, sidebarHandle.top + 120);
await mouse("mouseReleased", sidebarHandle.left + sidebarHandle.width / 2 + 84, sidebarHandle.top + 120);
await waitForAlignment();
const afterSidebarDrag = await layout();

const diffHandle = afterSidebarDrag.diffResizer;
await mouse("mousePressed", diffHandle.left + diffHandle.width / 2, diffHandle.top + 160);
await mouse("mouseMoved", diffHandle.left + diffHandle.width / 2 + 96, diffHandle.top + 160);
await mouse("mouseReleased", diffHandle.left + diffHandle.width / 2 + 96, diffHandle.top + 160);
await waitForAlignment();
const afterDiffDrag = await layout();

await evaluate(`(() => {
  const separator = document.querySelector('.diff-pane-resizer');
  separator.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 999 }));
  const fold = [...document.querySelectorAll('.toolbar button')].find((button) => button.textContent.includes('折叠上下文'));
  if (fold.classList.contains('active')) fold.click();
  const wrap = [...document.querySelectorAll('.toolbar button')].find((button) => button.textContent.includes('自动换行'));
  if (!wrap.classList.contains('active')) wrap.click();
  const slider = document.querySelector('.font-control input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '17');
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await waitForAlignment();
const transformed = await layout();
transformed.wrapCount = await evaluate(`document.querySelectorAll('.cm-lineWrapping').length`);
transformed.fontSize = await evaluate(`getComputedStyle(document.querySelector('.cm-editor')).fontSize`);
transformed.resizerDragging = await evaluate(`document.querySelector('.diff-pane-resizer').classList.contains('dragging')`);

const setDiffRatio = async (ratio) => {
  const current = await layout();
  const available = current.panes[0].width + current.panes[1].width;
  const delta = available * ratio - current.panes[0].width;
  const x = current.diffResizer.left + current.diffResizer.width / 2;
  const y = Math.min(current.diffResizer.top + 160, current.viewport.height - 40);
  await mouse("mousePressed", x, y);
  await mouse("mouseMoved", x + delta, y);
  await mouse("mouseReleased", x + delta, y);
  await waitForAlignment();
};
const toggleAlignment = async () => {
  await evaluate(`([...document.querySelectorAll('.toolbar button')]
    .find((button) => button.textContent.includes('对齐变化'))).click()`);
  const active = await evaluate(`([...document.querySelectorAll('.toolbar button')]
    .find((button) => button.textContent.includes('对齐变化'))).classList.contains('active')`);
  if (active) await waitForAlignment();
  else await new Promise((resolve) => setTimeout(resolve, 300));
};
const focusConnector = async (index) => {
  const alignment = await evaluate(`(() => {
    const root = document.querySelector('.oris-split-view');
    const active = root?.dataset.alignmentEnabled === 'true';
    const generation = Number(root?.dataset.alignmentGeneration ?? 0);
    document.querySelector('.diff-overview-rail.left .diff-overview-marker[data-hunk-index="${index}"]').click();
    return { active, generation };
  })()`);
  if (alignment.active) {
    await waitFor(`Number(document.querySelector('.oris-split-view')?.dataset.alignmentGeneration ?? 0) > ${alignment.generation} &&
      document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true' &&
      document.querySelector('.diff-connectors path[data-hunk-index="${index}"]')`, 30000);
  } else {
    await waitFor(`document.querySelector('.diff-connectors path[data-hunk-index="${index}"]')`, 10000);
  }
  return evaluate(`(() => {
  const merge = document.querySelector('.oris-split-view');
  const path = document.querySelector('.diff-connectors path[data-hunk-index="${index}"]');
  const rect = path.getBoundingClientRect();
  const viewport = merge.getBoundingClientRect();
  const scrollers = [...document.querySelectorAll('.oris-split-pane .cm-scroller')];
  return {
    index: ${index},
    kind: path.classList.contains('inserted') ? 'inserted' : path.classList.contains('deleted') ? 'deleted' : 'modified',
    fromA: Number(path.dataset.fromA), toA: Number(path.dataset.toA),
    fromB: Number(path.dataset.fromB), toB: Number(path.dataset.toB),
    scrollTop: scrollers[1].scrollTop,
    visible: rect.bottom >= viewport.top && rect.top <= viewport.bottom,
    selectedPath: document.querySelector('.file.selected')?.getAttribute('aria-label'),
    endpoints: [...document.querySelectorAll('.endpoints > span')].map((node) => node.textContent),
    fontSize: getComputedStyle(document.querySelector('.cm-editor')).fontSize,
    wrappedEditors: document.querySelectorAll('.cm-lineWrapping').length,
    viewport: { width: innerWidth, height: innerHeight }
  };
})()`);
};

await call("Emulation.setDeviceMetricsOverride", { width: 900, height: 720, deviceScaleFactor: 1, mobile: false });
await waitForAlignment();
const narrowSidebarHandle = (await layout()).workspaceResizer;
await mouse("mousePressed", narrowSidebarHandle.left + narrowSidebarHandle.width / 2, narrowSidebarHandle.top + 120);
await mouse("mouseMoved", 183, narrowSidebarHandle.top + 120);
await mouse("mouseReleased", 183, narrowSidebarHandle.top + 120);
await waitForAlignment();
await setDiffRatio(0.3);
const aligned30 = await layout();
const aligned30Capture = await focusConnector(1);
await capture(screenshotPath?.replace(/\.png$/i, "-aligned-30.png"));
await toggleAlignment();
const unaligned30 = await layout();
const unaligned30Capture = await focusConnector(1);
await capture(screenshotPath?.replace(/\.png$/i, "-unaligned-30.png"));
await toggleAlignment();
const realigned30 = await layout();
await setDiffRatio(0.7);
const aligned70 = await layout();
const aligned70Capture = await focusConnector(1);
await capture(screenshotPath?.replace(/\.png$/i, "-aligned-70.png"));
const pureDeleteCapture = await focusConnector(2);
await capture(screenshotPath?.replace(/\.png$/i, "-aligned-pure-delete.png"));
await focusConnector(0);
const scrolled = await evaluate(`(async () => {
  const merge = document.querySelector('.oris-split-view');
  const scrollers = [...document.querySelectorAll('.oris-split-pane .cm-scroller')];
  const initialPath = document.querySelector('.diff-connectors path[data-hunk-index="0"]');
  const logicalRange = (path) => ({
    fromA: path.dataset.fromA, toA: path.dataset.toA,
    fromB: path.dataset.fromB, toB: path.dataset.toB
  });
  const before = logicalRange(initialPath);
  const initialRect = initialPath.getBoundingClientRect();
  const mergeRect = merge.getBoundingClientRect();
  scrollers[1].scrollTop = Math.max(0, scrollers[1].scrollTop + initialRect.top - mergeRect.top + 20);
  scrollers[1].dispatchEvent(new Event('scroll'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const path = document.querySelector('.diff-connectors path[data-hunk-index="0"]');
  const afterRect = path.getBoundingClientRect();
  const after = logicalRange(path);
  const result = {
    scrollTop: scrollers[1].scrollTop,
    topRelativeToViewport: afterRect.top - merge.getBoundingClientRect().top,
    logicalEndpointsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    overflowY: getComputedStyle(scrollers[1]).overflowY
  };
  scrollers[1].scrollTop = 0;
  return result;
})()`);

await call("Emulation.setDeviceMetricsOverride", { width: 980, height: 720, deviceScaleFactor: 1, mobile: false });
await waitForAlignment();
const narrow = await layout();
await call("Emulation.setDeviceMetricsOverride", { width: 1800, height: 900, deviceScaleFactor: 1, mobile: false });
await waitForAlignment();
const wide = await layout();

const result = {
  platform: await evaluate(`navigator.userAgent`),
  repository,
  loadStarted,
  openAndFirstFileMs,
  expectedGitProcessCount: 5,
  timingScope: "Tauri IPC click through first CodeMirror split render on a warm release process; single sample",
  initial,
  afterSidebarDrag,
  afterDiffDrag,
  transformed,
  aligned30,
  aligned30Capture,
  unaligned30,
  unaligned30Capture,
  realigned30,
  aligned70,
  aligned70Capture,
  pureDeleteCapture,
  scrolled,
  narrow,
  wide,
  passed:
    initial.mergeFillsHost && initial.panesFillMerge && initial.headersAlignPanes &&
    initial.centralGap >= 52 && initial.centralGap <= 60 &&
    initial.connectorCount > 0 && initial.nonZeroAligned && initial.zeroAnchorsValid &&
    initial.visibleCurveGutter && !initial.horizontalOverflow &&
    afterSidebarDrag.sidebar.width - initial.sidebar.width >= 70 &&
    initial.editor.width - afterSidebarDrag.editor.width >= 70 &&
    afterSidebarDrag.mergeFillsHost && afterSidebarDrag.panesFillMerge && afterSidebarDrag.headersAlignPanes &&
    afterDiffDrag.panes[0].width - afterSidebarDrag.panes[0].width >= 80 &&
    afterSidebarDrag.panes[1].width - afterDiffDrag.panes[1].width >= 80 &&
    afterDiffDrag.centralGap >= 52 && afterDiffDrag.centralGap <= 60 &&
    afterDiffDrag.connectorCount > 0 && afterDiffDrag.visibleCurveGutter && afterDiffDrag.headersAlignPanes &&
    transformed.wrapCount === 2 && transformed.fontSize === "17px" && !transformed.resizerDragging &&
    transformed.mergeFillsHost && transformed.panesFillMerge && transformed.headersAlignPanes &&
    transformed.connectorCount > 0 && transformed.visibleCurveGutter &&
    Math.abs(transformed.leftRatio - afterDiffDrag.leftRatio) <= 0.02 &&
    aligned30.alignButtonActive && aligned30.alignmentReady && aligned30.nonZeroAligned &&
    aligned30.zeroAnchorsValid && aligned30Capture.visible &&
    aligned30Capture.fromA !== aligned30Capture.toA && aligned30Capture.fromB !== aligned30Capture.toB &&
    aligned30.connectors.every((item) => item.closed && item.finite) &&
    !unaligned30.alignButtonActive && unaligned30.alignmentSpacerCount === 0 && unaligned30.maxNonZeroSkew > 20 &&
    unaligned30Capture.visible && unaligned30Capture.fromA === aligned30Capture.fromA &&
    unaligned30Capture.fromB === aligned30Capture.fromB &&
    realigned30.alignButtonActive && realigned30.alignmentReady && realigned30.nonZeroAligned && realigned30.maxNonZeroSkew <= 1 &&
    Math.abs(aligned30.leftRatio - 0.3) <= 0.03 &&
    aligned70.alignButtonActive && aligned70.alignmentReady && aligned70.nonZeroAligned && aligned70.zeroAnchorsValid &&
    aligned70Capture.visible && aligned70Capture.fromA === aligned30Capture.fromA &&
    pureDeleteCapture.visible && pureDeleteCapture.kind === "deleted" && pureDeleteCapture.fromB === pureDeleteCapture.toB &&
    Math.abs(aligned70.leftRatio - 0.7) <= 0.03 &&
    scrolled.scrollTop > 0 && scrolled.topRelativeToViewport <= -15 &&
    scrolled.logicalEndpointsUnchanged && scrolled.overflowY !== "visible" &&
    narrow.viewport.width === 980 && narrow.mergeFillsHost && narrow.panesFillMerge && !narrow.horizontalOverflow &&
    narrow.panes.every((pane) => pane.width >= 175) &&
    Math.abs(narrow.leftRatio - aligned70.leftRatio) <= 0.02 &&
    wide.viewport.width === 1800 && wide.mergeFillsHost && wide.panesFillMerge && !wide.horizontalOverflow &&
    Math.abs(wide.leftRatio - aligned70.leftRatio) <= 0.02 &&
    wide.headersAlignPanes && wide.visibleCurveGutter && wide.centralGap >= 52 && wide.centralGap <= 60
};
console.log(JSON.stringify(result, null, 2));
if (resultPath) writeFileSync(resultPath, JSON.stringify(result, null, 2));
await capture(screenshotPath);
await call("Emulation.clearDeviceMetricsOverride");
socket.close();
if (!result.passed) process.exitCode = 1;
