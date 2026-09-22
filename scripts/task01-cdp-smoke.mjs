import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 9223);
const repository = process.argv[3];
const screenshotPath = process.argv[4];
const resultPath = process.argv[5];
if (!repository) throw new Error("Usage: node scripts/task01-cdp-smoke.mjs <port> <repository>");

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
  const response = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
};
const waitFor = async (expression, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${expression}`);
};

await call("Runtime.enable");
try {
  await call("Browser.grantPermissions", {
    origin: "http://tauri.localhost",
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
  });
} catch {
  // Clipboard support is asserted below; unsupported permission APIs remain visible as a failed assertion.
}
await evaluate(`(() => {
  const input = document.querySelector('input[aria-label="仓库路径"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(repository)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '载入').click();
  return true;
})()`);
await waitFor(`document.querySelector('.file.selected') && document.querySelectorAll('.cm-content').length === 2`);
await evaluate(`(() => {
  const mode = document.querySelector('select[aria-label="Diff 布局"]');
  if (mode.value !== 'split') {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(mode, 'split');
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const highlight = document.querySelector('select[aria-label="高亮粒度"]');
  if (highlight.value !== 'words') {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(highlight, 'words');
    highlight.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const fold = [...document.querySelectorAll('.toolbar button')].find((button) => button.textContent.includes('折叠上下文'));
  if (!fold.classList.contains('active')) fold.click();
  const wrap = [...document.querySelectorAll('.toolbar button')].find((button) => button.textContent.includes('自动换行'));
  if (wrap.classList.contains('active')) wrap.click();
  const align = [...document.querySelectorAll('.toggle-button')].find((button) => button.textContent.includes('对齐变化'));
  if (align?.getAttribute('aria-pressed') !== 'true') align.click();
  const slider = document.querySelector('.font-control input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '13');
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  const tree = document.querySelector('.file-view-select');
  if (tree?.value !== 'tree') {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(tree, 'tree');
    tree.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
})()`);
await waitFor(`document.querySelectorAll('.cm-editor').length === 2 && document.querySelectorAll('.cm-collapsedLines').length > 0 && document.querySelectorAll('.tree-directory').length > 0`);
await waitFor(`document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'`, 20000);

const split = await evaluate(`(() => ({
  title: document.title,
  repository: document.querySelector('.statusbar span')?.textContent,
  selectedFile: document.querySelector('.file.selected .file-path')?.textContent,
  selectedFilePath: document.querySelector('.file.selected')?.getAttribute('aria-label'),
  directoryLabels: [...document.querySelectorAll('.tree-directory > summary')].map((node) => node.textContent.trim()),
  endpointLabels: [...document.querySelectorAll('.endpoints > span')].map((node) => node.textContent),
  editorCount: document.querySelectorAll('.cm-editor').length,
  hunkPosition: document.querySelector('.toolbar > span')?.textContent,
  changedLines: document.querySelectorAll('.oris-modified-line,.oris-inserted-line,.oris-deleted-line').length,
  changedWords: document.querySelectorAll('.oris-changed-text').length,
  collapsedRegions: document.querySelectorAll('.cm-collapsedLines').length,
  connectorPaths: document.querySelectorAll('.diff-connectors path').length,
  hasOldPolicy: [...document.querySelectorAll('.cm-content')].some((node) => node.textContent.includes('old-policy')),
  hasNewPolicy: [...document.querySelectorAll('.cm-content')].some((node) => node.textContent.includes('new-policy')),
  readOnly: [...document.querySelectorAll('.cm-content')].every((node) => node.getAttribute('contenteditable') === 'false')
}))()`);

const foldedGeometry = await evaluate(`(() => {
  const editors = [...document.querySelectorAll('.oris-split-view .cm-editor')];
  const left = editors[0].getBoundingClientRect();
  const right = editors[1].getBoundingClientRect();
  const viewport = document.querySelector('.oris-split-view').getBoundingClientRect();
  const svg = document.querySelector('.diff-connectors');
  const svgRect = svg.getBoundingClientRect();
  const scaleY = svgRect.height / svg.viewBox.baseVal.height;
  const leftLines = [...editors[0].querySelectorAll('.oris-modified-line,.oris-inserted-line,.oris-deleted-line')].map((line) => line.getBoundingClientRect());
  const rightLines = [...editors[1].querySelectorAll('.oris-modified-line,.oris-inserted-line,.oris-deleted-line')].map((line) => line.getBoundingClientRect());
  const near = (value, values) => values.some((candidate) => Math.abs(value - candidate) <= 2);
  const paths = [...document.querySelectorAll('.diff-connectors path')].map((path) => {
    const rect = path.getBoundingClientRect();
    const aHeight = Number(path.dataset.aBottom) - Number(path.dataset.aTop);
    const bHeight = Number(path.dataset.bBottom) - Number(path.dataset.bTop);
    const zeroA = Number(path.dataset.fromA) === Number(path.dataset.toA);
    const zeroB = Number(path.dataset.fromB) === Number(path.dataset.toB);
    const topAligned = Math.abs(Number(path.dataset.aTop) - Number(path.dataset.bTop)) <= 1;
    const bottomAligned = Math.abs(Number(path.dataset.aPaintBottom) - Number(path.dataset.bPaintBottom)) <= 1;
    return {
      hunkIndex: Number(path.dataset.hunkIndex),
      visible: rect.bottom >= viewport.top && rect.top <= viewport.bottom,
      insideGap: rect.left >= left.right - 10 && rect.right <= right.left + 10,
      positiveHeight: rect.height > 0,
      finite: [rect.left, rect.right, rect.top, rect.bottom, aHeight, bHeight].every(Number.isFinite),
      unequalSides: (Number(path.dataset.toA) - Number(path.dataset.fromA)) !==
        (Number(path.dataset.toB) - Number(path.dataset.fromB)),
      verticalAligned: topAligned && bottomAligned &&
        (!zeroA || Number(path.dataset.aTop) === Number(path.dataset.aBottom)) &&
        (!zeroB || Number(path.dataset.bTop) === Number(path.dataset.bBottom)),
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      gap: { left: left.right, right: right.left },
      projected: {
        aTop: svgRect.top + Number(path.dataset.aTop) * scaleY,
        aBottom: svgRect.top + Number(path.dataset.aBottom) * scaleY,
        bTop: svgRect.top + Number(path.dataset.bTop) * scaleY,
        bBottom: svgRect.top + Number(path.dataset.bBottom) * scaleY
      },
      lineEdges: {
        leftTops: leftLines.map((line) => line.top),
        leftBottoms: leftLines.map((line) => line.bottom),
        rightTops: rightLines.map((line) => line.top),
        rightBottoms: rightLines.map((line) => line.bottom)
      }
    };
  });
  return {
    paths: paths.length,
    visiblePaths: paths.filter((path) => path.visible).length,
    allInsideGap: paths.every((path) => path.insideGap),
    allPositiveAndFinite: paths.every((path) => path.positiveHeight && path.finite),
    visibleVerticallyAligned: paths.filter((path) => path.visible).every((path) => path.verticalAligned),
    visibleUnequalAligned: paths.some((path) => path.visible && path.unequalSides && path.verticalAligned),
    hasUnequalConnector: paths.some((path) => path.unequalSides),
    details: paths
  };
})()`);

const scrollSync = await evaluate(`new Promise((resolve) => {
  const scrollers = [...document.querySelectorAll('.oris-split-view .cm-scroller')];
  const contents = [...document.querySelectorAll('.oris-split-view .cm-content')];
  const before = contents.map((node) => node.getBoundingClientRect().top);
  scrollers[0].scrollTop = Math.min(60, Math.max(1, scrollers[0].scrollHeight - scrollers[0].clientHeight));
  scrollers[0].dispatchEvent(new Event('scroll', { bubbles: true }));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const after = contents.map((node) => node.getBoundingClientRect().top);
    const leftDelta = after[0] - before[0];
    const rightDelta = after[1] - before[1];
    resolve({
      scrollTop: scrollers[0].scrollTop,
      targetScrollTop: scrollers[1].scrollTop,
      leftDelta,
      rightDelta,
      synchronized: scrollers[0].scrollTop > 0 && scrollers[1].scrollTop > 0 && Math.abs(leftDelta - rightDelta) <= 1
    });
  }));
})`);

await evaluate(`(() => {
  const select = document.querySelector('select[aria-label="Diff 布局"]');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'unified');
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await waitFor(`document.querySelectorAll('.cm-editor').length === 1`);
const unified = await evaluate(`(() => ({
  editorCount: document.querySelectorAll('.cm-editor').length,
  deletedChunks: document.querySelectorAll('.cm-deletedChunk').length,
  writeControls: document.querySelectorAll('.cm-chunkButtons, .cm-merge-revert').length
}))()`);

await evaluate(`(() => {
  const select = document.querySelector('select[aria-label="Diff 布局"]');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'split');
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await waitFor(`document.querySelectorAll('.cm-editor').length === 2`);
await evaluate(`(() => {
  globalThis.__orisBeforeTransformRoot = document.querySelector('.oris-split-view');
  const fold = [...document.querySelectorAll('.toolbar button')].find((button) => button.textContent.includes('折叠上下文'));
  if (fold.classList.contains('active')) fold.click();
  const wrap = [...document.querySelectorAll('.toolbar button')].find((button) => button.textContent.includes('自动换行'));
  if (!wrap.classList.contains('active')) wrap.click();
  const slider = document.querySelector('.font-control input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '17');
  slider.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor(`document.querySelector('.oris-split-view') !== globalThis.__orisBeforeTransformRoot &&
  document.querySelectorAll('.cm-collapsedLines').length === 0 &&
  document.querySelectorAll('.cm-lineWrapping').length === 2 &&
  getComputedStyle(document.querySelector('.cm-editor')).fontSize === '17px' &&
  document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'`, 20000);
await evaluate(`(() => {
  globalThis.__orisAlignmentGenerationBeforeF7 = Number(document.querySelector('.oris-split-view')?.dataset.alignmentGeneration ?? 0);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', bubbles: true }));
  return true;
})()`);
await waitFor(`document.querySelector('.toolbar > span')?.textContent.trim() === '2 / 6'`, 10000);
await waitFor(`Number(document.querySelector('.oris-split-view')?.dataset.alignmentGeneration ?? 0) > globalThis.__orisAlignmentGenerationBeforeF7 &&
  document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'`, 20000);
await waitFor(`document.querySelectorAll('.diff-connectors path').length > 0`, 10000);
const interactions = await evaluate(`(async () => {
  const changedWord = document.querySelector('.oris-changed-text');
  const range = document.createRange();
  range.selectNodeContents(changedWord);
  const selection = getSelection();
  changedWord.closest('.cm-content').focus();
  selection.removeAllRanges();
  selection.addRange(range);
  const wordRect = changedWord.getBoundingClientRect();
  const selectionRect = range.getBoundingClientRect();
  const editors = [...document.querySelectorAll('.oris-split-view .cm-editor')];
  const left = editors[0].getBoundingClientRect();
  const right = editors[1].getBoundingClientRect();
  const viewport = document.querySelector('.oris-split-view').getBoundingClientRect();
  const svg = document.querySelector('.diff-connectors');
  const svgRect = svg.getBoundingClientRect();
  const scaleY = svgRect.height / svg.viewBox.baseVal.height;
  const leftLines = [...editors[0].querySelectorAll('.oris-modified-line,.oris-inserted-line,.oris-deleted-line')].map((line) => line.getBoundingClientRect());
  const rightLines = [...editors[1].querySelectorAll('.oris-modified-line,.oris-inserted-line,.oris-deleted-line')].map((line) => line.getBoundingClientRect());
  const near = (value, values) => values.some((candidate) => Math.abs(value - candidate) <= 2);
  const connectorGeometry = [...document.querySelectorAll('.diff-connectors path')].map((path) => {
    const rect = path.getBoundingClientRect();
    const aHeight = Number(path.dataset.aBottom) - Number(path.dataset.aTop);
    const bHeight = Number(path.dataset.bBottom) - Number(path.dataset.bTop);
    const zeroA = Number(path.dataset.fromA) === Number(path.dataset.toA);
    const zeroB = Number(path.dataset.fromB) === Number(path.dataset.toB);
    return {
      visible: rect.bottom >= viewport.top && rect.top <= viewport.bottom,
      hunkIndex: Number(path.dataset.hunkIndex),
      insideGap: rect.left >= left.right - 10 && rect.right <= right.left + 10,
      positiveHeight: rect.height > 0,
      finite: [rect.left, rect.right, rect.top, rect.bottom, aHeight, bHeight].every(Number.isFinite),
      unequalSides: (Number(path.dataset.toA) - Number(path.dataset.fromA)) !==
        (Number(path.dataset.toB) - Number(path.dataset.fromB)),
      verticalAligned:
        Math.abs(Number(path.dataset.aTop) - Number(path.dataset.bTop)) <= 1 &&
        Math.abs(Number(path.dataset.aPaintBottom) - Number(path.dataset.bPaintBottom)) <= 1 &&
        (!zeroA || Number(path.dataset.aTop) === Number(path.dataset.aBottom)) &&
        (!zeroB || Number(path.dataset.bTop) === Number(path.dataset.bBottom)),
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      endpoints: {
        aTop: Number(path.dataset.aTop), aBottom: Number(path.dataset.aBottom), aPaintBottom: Number(path.dataset.aPaintBottom),
        bTop: Number(path.dataset.bTop), bBottom: Number(path.dataset.bBottom), bPaintBottom: Number(path.dataset.bPaintBottom)
      },
      gap: { left: left.right, right: right.left }
    };
  });
  return {
    collapsedRegionsAfterExpand: document.querySelectorAll('.cm-collapsedLines').length,
    wrappedEditors: document.querySelectorAll('.cm-lineWrapping').length,
    fontSize: getComputedStyle(document.querySelector('.cm-editor')).fontSize,
    hunkPositionAfterF7: document.querySelector('.toolbar > span')?.textContent,
    connectorPathsAfterTransform: connectorGeometry.length,
    visibleConnectorsAfterTransform: connectorGeometry.filter((path) => path.visible).length,
    connectorsInsideGapAfterTransform: connectorGeometry.every((path) => path.insideGap),
    connectorsFiniteAfterTransform: connectorGeometry.every((path) => path.positiveHeight && path.finite),
    visibleConnectorsVerticallyAlignedAfterTransform: connectorGeometry
      .filter((path) => path.visible)
      .every((path) => path.verticalAligned),
    visibleUnequalConnectorAlignedAfterTransform: connectorGeometry.some(
      (path) => path.visible && path.unequalSides && path.verticalAligned
    ),
    hasUnequalConnectorAfterTransform: connectorGeometry.some((path) => path.unequalSides),
    connectorDetailsAfterTransform: connectorGeometry,
    alignmentSpacersAfterTransform: [...document.querySelectorAll('.oris-alignment-spacer')].map((spacer) => ({
      side: spacer.closest('.oris-split-pane')?.classList.contains('left') ? 'a' : 'b',
      chunkIndex: Number(spacer.dataset.chunkIndex),
      role: spacer.dataset.alignmentRole,
      height: Number(spacer.dataset.alignmentHeight),
      top: spacer.getBoundingClientRect().top
    })),
    selectionText: selection.toString(),
    wordCenter: { x: wordRect.left + wordRect.width / 2, y: wordRect.top + wordRect.height / 2 },
    selectionMatchesWord: selection.toString() === changedWord.textContent &&
      Math.abs(selectionRect.left - wordRect.left) <= 1 &&
      Math.abs(selectionRect.right - wordRect.right) <= 1
  };
})()`);
await call("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: interactions.wordCenter.x,
  y: interactions.wordCenter.y,
  button: "left",
  clickCount: 1
});
await call("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: interactions.wordCenter.x,
  y: interactions.wordCenter.y,
  button: "left",
  clickCount: 1
});
await evaluate(`(() => {
  const changedWord = document.querySelector('.oris-changed-text');
  const range = document.createRange();
  range.selectNodeContents(changedWord);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  globalThis.__orisCopyEvent = null;
  document.addEventListener('copy', (event) => {
    globalThis.__orisCopyEvent = {
      selectionText: getSelection().toString(),
      clipboardText: event.clipboardData?.getData('text/plain') ?? null,
      defaultPrevented: event.defaultPrevented,
      trusted: event.isTrusted
    };
  }, { once: true });
  return selection.toString();
})()`);
for (let attempt = 0; attempt < 3; attempt += 1) {
  await call("Page.bringToFront");
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed", x: interactions.wordCenter.x, y: interactions.wordCenter.y,
    button: "left", clickCount: 1
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: interactions.wordCenter.x, y: interactions.wordCenter.y,
    button: "left", clickCount: 1
  });
  await evaluate(`(() => {
    const changedWord = document.querySelector('.oris-changed-text');
    const range = document.createRange();
    range.selectNodeContents(changedWord);
    changedWord.closest('.cm-content').focus();
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
    key: "c",
    code: "KeyC"
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
    key: "c",
    code: "KeyC"
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (await evaluate(`globalThis.__orisCopyEvent !== null`)) break;
}
interactions.clipboardText = await evaluate(`navigator.clipboard.readText().catch(() => null)`);
interactions.copyEvent = await evaluate(`globalThis.__orisCopyEvent`);
interactions.copied = interactions.copyEvent?.trusted === true &&
  interactions.copyEvent?.selectionText === interactions.selectionText &&
  interactions.copyEvent?.clipboardText === interactions.selectionText &&
  interactions.copyEvent?.defaultPrevented === true;

const result = {
  platform: await evaluate(`navigator.userAgent`),
  url: target.url,
  split,
  foldedGeometry,
  scrollSync,
  unified,
  interactions,
  passed:
    split.selectedFile === "中文 diff.ts" &&
    split.selectedFilePath === "src/中文 diff.ts" &&
    split.directoryLabels.some((label) => label.endsWith("src")) &&
    split.editorCount === 2 &&
    split.connectorPaths > 0 &&
    split.changedWords > 0 &&
    split.collapsedRegions > 0 &&
    split.hasOldPolicy &&
    split.hasNewPolicy &&
    split.readOnly &&
    foldedGeometry.paths > 0 &&
    foldedGeometry.allInsideGap &&
    foldedGeometry.allPositiveAndFinite &&
    foldedGeometry.visiblePaths > 0 &&
    foldedGeometry.visibleVerticallyAligned &&
    foldedGeometry.visibleUnequalAligned &&
    foldedGeometry.hasUnequalConnector &&
    scrollSync.synchronized &&
    unified.editorCount === 1 &&
    unified.deletedChunks > 0 &&
    unified.writeControls === 0 &&
    interactions.collapsedRegionsAfterExpand === 0 &&
    interactions.wrappedEditors > 0 &&
    interactions.fontSize === "17px" &&
    interactions.connectorPathsAfterTransform > 0 &&
    interactions.connectorsInsideGapAfterTransform &&
    interactions.connectorsFiniteAfterTransform &&
    interactions.visibleConnectorsAfterTransform > 0 &&
    interactions.visibleConnectorsVerticallyAlignedAfterTransform &&
    interactions.visibleUnequalConnectorAlignedAfterTransform &&
    interactions.hasUnequalConnectorAfterTransform &&
    interactions.selectionText.length > 0 &&
    interactions.selectionMatchesWord &&
    interactions.copied &&
    interactions.clipboardText === interactions.selectionText
};
console.log(JSON.stringify(result, null, 2));
if (resultPath) writeFileSync(resultPath, JSON.stringify(result, null, 2));
if (screenshotPath) {
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
}
socket.close();
if (!result.passed) process.exitCode = 1;
