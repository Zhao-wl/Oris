// 通过 WebView2 CDP 驱动测试实例的页面：只在页面内读取 DOM / 调用 click()，不做任何原生窗口或焦点操作。
//   node drive.mjs <port> version            输出应用版本
//   node drive.mjs <port> update <timeoutMs> 记录更新按钮的状态变化，出现「重启以更新」后点击
const [port, mode, timeoutArg = "180000"] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const target = targets.find((item) => item.type === "page" && item.url.startsWith("http://tauri.localhost"));
      if (target) return target;
    } catch { /* 实例尚未启动 */ }
    await sleep(300);
  }
  throw new Error(`CDP 端口 ${port} 上没有 Oris 页面`);
}

const target = await connect();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
});
const evaluate = (expression) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, {
    resolve: (result) => result.exceptionDetails
      ? reject(new Error(JSON.stringify(result.exceptionDetails.exception?.value ?? result.exceptionDetails.text)))
      : resolve(result.result?.value),
    reject
  });
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});

// 页面加载完成后再读取（重启后的实例刚创建页面时 IPC 尚未就绪）。
const loadDeadline = Date.now() + 30_000;
while (Date.now() < loadDeadline && !(await evaluate(`document.readyState === "complete" && !!document.querySelector(".titlebar")`).catch(() => false))) await sleep(200);
const version = await evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:app|version")`).catch((error) => `读取失败：${error.message}`);
if (mode === "version") {
  const button = await evaluate(`document.querySelector(".update-button")?.textContent ?? null`);
  console.log(JSON.stringify({ version, updateButton: button }));
  process.exit(0);
}

const states = [];
const started = Date.now();
while (Date.now() - started < timeoutMs) {
  const state = await evaluate(`(() => { const b = document.querySelector(".update-button"); return b ? { text: b.textContent, title: b.title, disabled: b.disabled } : null; })()`);
  const text = state?.text ?? "(无按钮)";
  if (states.at(-1)?.text !== text) states.push({ atMs: Date.now() - started, text, title: state?.title ?? "" });
  if (text === "重启以更新") {
    await evaluate(`document.querySelector(".update-button").click(), true`);
    states.push({ atMs: Date.now() - started, text: "(已点击)" });
    console.log(JSON.stringify({ version, states }, null, 2));
    process.exit(0);
  }
  if (text === "更新失败") break;
  await sleep(200);
}
console.log(JSON.stringify({ version, states }, null, 2));
process.exit(1);
