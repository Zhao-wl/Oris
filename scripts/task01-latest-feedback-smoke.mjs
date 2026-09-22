import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 9245);
const repository = process.argv[3];
const navigationRepository = process.argv[4];
const phase = process.argv[5] ?? "full";
const screenshotPath = process.argv[6];
const resultPath = process.argv[7];
if (!repository || !navigationRepository) {
  throw new Error("Usage: node scripts/task01-latest-feedback-smoke.mjs <port> <large-repo> <navigation-repo> <full|restore|invalid> [screenshot] [result-json]");
}

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
    throw new Error(`${String(error)} while evaluating: ${expression.slice(0, 180)}`);
  }
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}`);
};
const capture = async (path) => {
  if (!path) return;
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(screenshot.data, "base64"));
};
const save = (result) => {
  console.log(JSON.stringify(result, null, 2));
  if (resultPath) writeFileSync(resultPath, JSON.stringify(result, null, 2));
};
const load = async (path) => {
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="仓库路径"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(path)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`![...document.querySelectorAll('.openbar button')].find((button) => button.textContent.trim() === '载入').disabled`);
  await evaluate(`([...document.querySelectorAll('.openbar button')].find((button) => button.textContent.trim() === '载入')).click()`);
  await waitFor(`document.querySelector('.statusbar > span')?.textContent.startsWith(${JSON.stringify(path)}) && document.querySelector('.file.selected') && document.querySelectorAll('.cm-editor').length > 0`);
};

await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1050, height: 650, deviceScaleFactor: 1, mobile: false });

if (phase === "restore") {
  await waitFor(`document.querySelector('.file.selected') && document.querySelector('.restore-status')?.textContent.includes('已恢复')`);
  const result = await evaluate(`(() => ({
    phase: 'restore',
    path: document.querySelector('input[aria-label="仓库路径"]').value,
    status: document.querySelector('.restore-status')?.textContent,
    selectedPath: document.querySelector('.file.selected')?.getAttribute('aria-label'),
    error: document.querySelector('.state.error')?.textContent ?? null,
    stored: JSON.parse(localStorage.getItem('oris.recentRepository.v1') ?? 'null')
  }))()`);
  result.passed = result.path === navigationRepository && result.status.includes("已恢复") &&
    !!result.selectedPath && !result.error && result.stored?.path === navigationRepository;
  await capture(screenshotPath);
  save(result);
  socket.close();
  if (!result.passed) process.exitCode = 1;
} else if (phase === "invalid") {
  const invalidPath = `${navigationRepository}-missing`;
  await evaluate(`(() => {
    localStorage.setItem('oris.recentRepository.v1', JSON.stringify({ path: ${JSON.stringify(invalidPath)}, gitExecutable: '' }));
    location.reload();
  })()`);
  await waitFor(`document.querySelector('.state.error')?.textContent.includes('上次仓库恢复失败')`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const result = await evaluate(`(() => ({
    phase: 'invalid',
    inputPath: document.querySelector('input[aria-label="仓库路径"]').value,
    error: document.querySelector('.state.error')?.textContent,
    restoreStatus: document.querySelector('.restore-status')?.textContent,
    selectedCount: document.querySelectorAll('.file.selected').length,
    stored: JSON.parse(localStorage.getItem('oris.recentRepository.v1') ?? 'null')
  }))()`);
  result.passed = result.inputPath === invalidPath && result.error.includes("请选择或输入一个有效仓库") &&
    result.restoreStatus.includes("未能恢复") && result.selectedCount === 0 && result.stored?.path === invalidPath;
  await capture(screenshotPath);
  await evaluate(`localStorage.setItem('oris.recentRepository.v1', JSON.stringify({ path: ${JSON.stringify(navigationRepository)}, gitExecutable: '' }))`);
  save(result);
  socket.close();
  if (!result.passed) process.exitCode = 1;
} else {
  await evaluate(`(() => { localStorage.removeItem('oris.recentRepository.v1'); location.reload(); })()`);
  await waitFor(`document.querySelector('.toolbar') && !document.querySelector('.restore-status')`);
  const defaults = await evaluate(`(() => {
    const button = (label) => [...document.querySelectorAll('.toggle-button')].find((node) => node.textContent.includes(label));
    return Object.fromEntries(['折叠上下文', '自动换行', '对齐变化'].map((label) => {
      const node = button(label);
      return [label, { pressed: node.getAttribute('aria-pressed'), text: node.textContent, className: node.className }];
    }));
  })()`);

  await load(repository);
  await waitFor(`document.querySelectorAll('.file').length === 96`);
  const flat = await evaluate(`(() => ({
    flatActive: document.querySelector('.file-view-select')?.value,
    fileCount: document.querySelectorAll('.files .file').length,
    directoryCount: document.querySelectorAll('.files .tree-directory').length,
    labels: [...document.querySelectorAll('.files .file')].map((node) => node.getAttribute('aria-label')),
    visibleTexts: [...document.querySelectorAll('.files .file-path')].map((node) => node.textContent),
    footer: document.querySelector('.sidebar > footer').textContent
  }))()`);

  const toggles = await evaluate(`(async () => {
    const labels = ['折叠上下文', '自动换行', '对齐变化'];
    const results = {};
    for (const label of labels) {
      const button = [...document.querySelectorAll('.toggle-button')].find((node) => node.textContent.includes(label));
      const off = getComputedStyle(button);
      const offStyle = { background: off.backgroundColor, border: off.borderColor, color: off.color, text: button.textContent };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      document.querySelector('.filter').focus();
      const on = getComputedStyle(button);
      const onStyle = { background: on.backgroundColor, border: on.borderColor, color: on.color, text: button.textContent };
      results[label] = {
        pressedOn: button.getAttribute('aria-pressed'),
        offStyle, onStyle,
        distinct: offStyle.background !== onStyle.background || offStyle.border !== onStyle.border,
        onText: button.textContent
      };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return results;
  })()`);
  const lightToggles = await evaluate(`(async () => {
    document.querySelector('button[aria-label="切换主题"]').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const results = {};
    for (const label of ['折叠上下文', '自动换行', '对齐变化']) {
      const button = [...document.querySelectorAll('.toggle-button')].find((node) => node.textContent.includes(label));
      const off = getComputedStyle(button);
      const offStyle = { background: off.backgroundColor, border: off.borderColor, color: off.color };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector('.filter').focus();
      const on = getComputedStyle(button);
      const onStyle = { background: on.backgroundColor, border: on.borderColor, color: on.color };
      results[label] = { distinct: offStyle.background !== onStyle.background || offStyle.border !== onStyle.border, offStyle, onStyle };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    document.querySelector('button[aria-label="切换主题"]').click();
    return results;
  })()`);
  await evaluate(`([...document.querySelectorAll('.toggle-button')].find((node) => node.textContent.includes('折叠上下文'))).focus()`);
  await call("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, key: " ", code: "Space" });
  await call("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, key: " ", code: "Space" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const keyboardToggle = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.toggle-button')].find((node) => node.textContent.includes('折叠上下文'));
    const value = { pressed: button.getAttribute('aria-pressed'), text: button.textContent };
    button.click();
    return value;
  })()`);

  const beforeWheel = await evaluate(`(() => {
    const files = document.querySelector('.files');
    const panel = document.querySelector('.panel-title').getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    const rect = files.getBoundingClientRect();
    return { filesTop: files.scrollTop, panelTop: panel.top, toolbarTop: toolbar.top, x: rect.left + rect.width / 2, y: rect.top + Math.min(100, rect.height / 2) };
  })()`);
  await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: beforeWheel.x, y: beforeWheel.y, deltaX: 0, deltaY: 620 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterWheel = await evaluate(`(() => ({
    filesTop: document.querySelector('.files').scrollTop,
    panelTop: document.querySelector('.panel-title').getBoundingClientRect().top,
    toolbarTop: document.querySelector('.toolbar').getBoundingClientRect().top,
    workspaceTop: document.querySelector('.workspace').scrollTop,
    overflowY: getComputedStyle(document.querySelector('.files')).overflowY
  }))()`);

  const unicodePath = "src/group-04/nested-00/中文 空格 file-37.ts";
  await evaluate(`document.querySelector('.file[aria-label=${JSON.stringify(unicodePath)}]').click()`);
  await waitFor(`document.querySelector('.file.selected')?.getAttribute('aria-label') === ${JSON.stringify(unicodePath)} && document.querySelector('.tabbar strong')?.textContent === ${JSON.stringify(unicodePath)} && document.querySelector('.cm-content') && !document.querySelector('.state')`);
  const beforeTreePair = await evaluate(`document.querySelector('.cm-content')?.textContent`);
  await evaluate(`(() => {
    const select = document.querySelector('.file-view-select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'tree');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(`document.querySelectorAll('.tree-directory').length > 0`);
  const tree = await evaluate(`(() => ({
    directoryCount: document.querySelectorAll('.tree-directory').length,
    selectedPath: document.querySelector('.file.selected')?.getAttribute('aria-label'),
    tabPath: document.querySelector('.tabbar strong')?.textContent,
    content: document.querySelector('.cm-content')?.textContent,
    scrollHeight: document.querySelector('.files').scrollHeight,
    clientHeight: document.querySelector('.files').clientHeight
  }))()`);
  await evaluate(`(() => {
    const select = document.querySelector('.file-view-select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'flat');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.filter').focus();
  })()`);
  await capture(screenshotPath?.replace(/\.png$/i, "-flat.png"));
  await evaluate(`(() => {
    for (const label of ['自动换行', '对齐变化']) {
      [...document.querySelectorAll('.toggle-button')].find((node) => node.textContent === label).click();
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await evaluate(`document.querySelector('.filter').focus()`);
  await capture(screenshotPath?.replace(/\.png$/i, "-toggle-active.png"));
  await evaluate(`(() => {
    for (const label of ['自动换行', '对齐变化']) {
      [...document.querySelectorAll('.toggle-button')].find((node) => node.textContent === label).click();
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));

  await load(navigationRepository);
  const navigation = await evaluate(`(async () => {
    const rect = (selector) => {
      const value = document.querySelector(selector).getBoundingClientRect();
      return { top: value.top, bottom: value.bottom, left: value.left, right: value.right };
    };
    const before = { toolbar: rect('.toolbar'), tabbar: rect('.tabbar'), endpoints: rect('.endpoints'), workspaceScrollTop: document.querySelector('.workspace').scrollTop };
    const next = [...document.querySelectorAll('.toolbar button')].find((node) => node.title?.includes('下一处差异'));
    const previous = [...document.querySelectorAll('.toolbar button')].find((node) => node.title?.includes('上一处差异'));
    for (let index = 0; index < 14; index += 1) {
      next.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', shiftKey: true, bubbles: true }));
    previous.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = { toolbar: rect('.toolbar'), tabbar: rect('.tabbar'), endpoints: rect('.endpoints'), workspaceScrollTop: document.querySelector('.workspace').scrollTop };
    return {
      before, after,
      nextClickable: !next.disabled,
      previousClickable: !previous.disabled,
      toolbarVisible: after.toolbar.top >= document.querySelector('.workspace').getBoundingClientRect().top && after.toolbar.bottom <= innerHeight,
      stable: Math.abs(before.toolbar.top - after.toolbar.top) <= 1 && Math.abs(before.tabbar.top - after.tabbar.top) <= 1 && Math.abs(before.endpoints.top - after.endpoints.top) <= 1,
      diffScrollTop: document.querySelector('.cm-mergeView')?.scrollTop ?? document.querySelector('.cm-scroller')?.scrollTop ?? 0
    };
  })()`);
  await capture(screenshotPath?.replace(/\.png$/i, "-navigation.png"));

  const stored = await evaluate(`JSON.parse(localStorage.getItem('oris.recentRepository.v1') ?? 'null')`);
  const failedManualPath = `${navigationRepository}-manual-missing`;
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="仓库路径"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(failedManualPath)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.openbar button')].find((button) => button.textContent.trim() === '载入').click();
  })()`);
  await waitFor(`!!document.querySelector('.state.error')`);
  const failedManualLoad = await evaluate(`(() => ({
    error: document.querySelector('.state.error').textContent,
    stored: JSON.parse(localStorage.getItem('oris.recentRepository.v1') ?? 'null')
  }))()`);
  const result = {
    phase: "full", defaults, flat, toggles, lightToggles, keyboardToggle, beforeWheel, afterWheel, tree,
    selectedContentPreserved: tree.content === beforeTreePair,
    navigation, stored, failedManualLoad,
    passed:
      defaults["折叠上下文"].pressed === "false" && defaults["折叠上下文"].text === "折叠上下文" &&
      defaults["自动换行"].pressed === "false" && defaults["自动换行"].text === "自动换行" &&
      defaults["对齐变化"].pressed === "false" && defaults["对齐变化"].text === "对齐变化" &&
      Object.entries(toggles).every(([label, item]) => item.pressedOn === "true" && item.distinct && item.onText === label) &&
      Object.values(lightToggles).every((item) => item.distinct) && keyboardToggle.pressed === "true" && keyboardToggle.text === "折叠上下文" &&
      flat.flatActive === "flat" && flat.fileCount === 96 && flat.directoryCount === 0 &&
      flat.labels.includes(unicodePath) && flat.visibleTexts.includes(unicodePath) && flat.footer === "96 个文件" &&
      afterWheel.filesTop > beforeWheel.filesTop && afterWheel.workspaceTop === 0 && afterWheel.overflowY === "scroll" &&
      Math.abs(afterWheel.panelTop - beforeWheel.panelTop) <= 1 && Math.abs(afterWheel.toolbarTop - beforeWheel.toolbarTop) <= 1 &&
      tree.directoryCount > 0 && tree.selectedPath === unicodePath && tree.tabPath === unicodePath && tree.scrollHeight > tree.clientHeight &&
      tree.content === beforeTreePair && navigation.stable && navigation.before.workspaceScrollTop === 0 &&
      navigation.after.workspaceScrollTop === 0 && navigation.toolbarVisible && navigation.nextClickable && navigation.previousClickable &&
      navigation.diffScrollTop > 0 && stored?.path === navigationRepository &&
      failedManualLoad.error.length > 0 && failedManualLoad.stored?.path === navigationRepository
  };
  save(result);
  socket.close();
  if (!result.passed) process.exitCode = 1;
}
