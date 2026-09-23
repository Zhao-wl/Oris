// Oris GUI 测量公共库：只启动并操作本轮创建的 Oris 测试实例。
// 安全边界（AGENTS.md）：不调用 SetForegroundWindow / ShowWindow / AppActivate，不枚举或操作其他应用窗口；
// 所有交互通过 CDP 在页面内派发 DOM 事件；原生层只做只读查询（进程、端口、主窗口句柄）与结束本实例进程树。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { inflateSync, deflateSync, crc32 } from "node:zlib";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

export function summarize(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms);
  return {
    n: samples.length,
    ok: ok.length,
    failed: samples.length - ok.length,
    p50: round(percentile(ok, 0.5)),
    p95: round(percentile(ok, 0.95)),
    max: round(ok.length ? Math.max(...ok) : null)
  };
}

export const round = (value, digits = 1) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

function powershell(script) {
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`powershell failed: ${result.stderr}`);
  return result.stdout;
}

/** 读取全部进程（只读 CIM 查询），返回以 rootPid 为根的进程树及内存合计。 */
export function processTree(rootPid) {
  const raw = powershell("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,WorkingSetSize,PrivatePageCount,CreationDate | ConvertTo-Json -Compress");
  const all = JSON.parse(raw);
  const children = new Map();
  for (const p of all) {
    if (!children.has(p.ParentProcessId)) children.set(p.ParentProcessId, []);
    children.get(p.ParentProcessId).push(p);
  }
  const root = all.find((p) => p.ProcessId === rootPid);
  if (!root) return { alive: false, processes: [], workingSetMiB: 0, privateMiB: 0, git: 0 };
  const tree = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next.ProcessId)) continue;
    seen.add(next.ProcessId);
    tree.push(next);
    for (const child of children.get(next.ProcessId) ?? []) stack.push(child);
  }
  const mib = (bytes) => bytes / 1024 / 1024;
  return {
    alive: true,
    processes: tree.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, workingSetMiB: round(mib(Number(p.WorkingSetSize))), privateMiB: round(mib(Number(p.PrivatePageCount))) })),
    workingSetMiB: round(mib(tree.reduce((sum, p) => sum + Number(p.WorkingSetSize), 0))),
    privateMiB: round(mib(tree.reduce((sum, p) => sum + Number(p.PrivatePageCount), 0))),
    git: tree.filter((p) => /^git(-remote.*)?\.exe$/i.test(p.Name) || /^git\.exe$/i.test(p.Name)).length,
    catFile: null
  };
}

/** 统计进程树中常驻 git 子进程（含命令行，只读）。 */
export function gitChildren(rootPid) {
  const tree = processTree(rootPid);
  const pids = tree.processes.filter((p) => /^git\.exe$/i.test(p.name)).map((p) => p.pid);
  if (!pids.length) return [];
  const raw = powershell(`Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object { @(${pids.join(",")}) -contains $_.ProcessId } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`);
  const parsed = raw.trim() ? JSON.parse(raw) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, commandLine: p.CommandLine }));
}

export function machineInfo() {
  const raw = powershell(`
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$wv = $null
foreach ($key in 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') { try { $wv = (Get-ItemProperty -Path $key -ErrorAction Stop).pv; break } catch {} }
$disk = Get-PhysicalDisk | Select-Object -First 1 FriendlyName,MediaType,BusType
[pscustomobject]@{ os = "$($os.Caption) $($os.Version)"; cpu = $cpu.Name.Trim(); logicalProcessors = $cpu.NumberOfLogicalProcessors; memoryGiB = [math]::Round($os.TotalVisibleMemorySize/1MB,1); webView2Runtime = $wv; disk = "$($disk.FriendlyName) $($disk.MediaType) $($disk.BusType)" } | ConvertTo-Json -Compress`);
  const info = JSON.parse(raw);
  info.git = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
  info.node = process.version;
  return info;
}

export function sha256File(file) {
  return powershell(`(Get-FileHash -Algorithm SHA256 -LiteralPath '${file.replace(/'/g, "''")}').Hash`).trim();
}

async function fetchJson(url) {
  const response = await fetch(url);
  return response.json();
}

/**
 * 启动一个隔离的 Oris 测试实例：独立 WebView2 profile、CDP 端口；
 * 核验 PID、可执行文件完整路径、主窗口句柄以及 CDP 端口属于本实例进程树。
 */
export async function launchOris({ exe, profileDir, port, extraEnv = {}, log = () => {} }) {
  const exePath = path.resolve(exe);
  if (!existsSync(exePath)) throw new Error(`exe 不存在：${exePath}`);
  mkdirSync(profileDir, { recursive: true });
  const listening = powershell(`@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).Count`).trim();
  if (listening !== "0") throw new Error(`CDP 端口 ${port} 已被占用，拒绝连接非本轮实例`);
  const browserArgs = [
    `--remote-debugging-port=${port}`,
    // 测试窗口可能被其他窗口遮挡；关闭遮挡/后台节流，保证 rAF 与计时器不被暂停。两次测量使用同一配置。
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling"
  ].join(" ");
  const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profileDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs, ...extraEnv };
  const spawnedAt = Date.now();
  const child = spawn(exePath, [], { env, stdio: "ignore", detached: false, windowsHide: false });
  const pid = child.pid;
  if (!pid) throw new Error("Oris 启动失败");
  let exited = false;
  child.on("exit", () => { exited = true; });
  let target = null;
  const deadline = Date.now() + 30000;
  while (!target && Date.now() < deadline) {
    if (exited) throw new Error("Oris 测试实例提前退出");
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      target = targets.find((item) => item.type === "page" && item.title === "Oris" && /^(https?|tauri):\/\//.test(item.url)) ?? null;
    } catch { /* not ready */ }
    if (!target) await sleep(20);
  }
  if (!target) throw new Error("未找到 Oris WebView2 CDP 页面");
  const cdpFoundAt = Date.now();
  // 身份核验（只读）：可执行文件路径、主窗口句柄、端口归属。
  let identity = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const raw = powershell(`
$p = Get-Process -Id ${pid} -ErrorAction Stop
$owner = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
[pscustomobject]@{ path = $p.Path; mainWindowHandle = [int64]$p.MainWindowHandle; mainWindowTitle = $p.MainWindowTitle; portOwner = $owner } | ConvertTo-Json -Compress`);
    identity = JSON.parse(raw);
    if (identity.mainWindowHandle !== 0) break;
    await sleep(100);
  }
  const tree = processTree(pid);
  const ownsPort = tree.processes.some((p) => p.pid === identity.portOwner);
  const verified = path.resolve(identity.path).toLowerCase() === exePath.toLowerCase() && identity.mainWindowHandle !== 0 && identity.mainWindowTitle === "Oris" && ownsPort;
  if (!verified) {
    log(`身份核验失败：${JSON.stringify(identity)}`);
    await killOris({ pid, exePath, child, force: true, skipWindowCheck: true });
    throw new Error("测试实例身份核验失败，已结束本实例");
  }
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  return { pid, exePath, child, cdp, profileDir, port, spawnedAt, cdpFoundAt, identity: { ...identity, verified, ownsPort } };
}

/** 结束本轮测试实例：再次核验 PID 与可执行文件路径后，先温和关闭，超时再强制结束整棵进程树。 */
export async function killOris({ pid, exePath, child, force = false }) {
  if (!pid) return { closed: true, how: "none" };
  let current;
  try {
    current = JSON.parse(powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ path = $p.Path; handle = [int64]$p.MainWindowHandle } | ConvertTo-Json -Compress } else { 'null' }`));
  } catch { current = null; }
  if (!current) return { closed: true, how: "already-exited" };
  if (path.resolve(current.path).toLowerCase() !== path.resolve(exePath).toLowerCase()) throw new Error(`PID ${pid} 已不是本轮 Oris 实例，拒绝结束`);
  const waitExit = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (child && child.exitCode !== null) return true;
      const alive = powershell(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`).trim();
      if (alive === "False") return true;
      await sleep(200);
    }
    return false;
  };
  if (!force && current.handle !== 0) {
    // taskkill 无 /F：只向该 PID 的顶层窗口发送关闭消息，让 WebView2 正常落盘 localStorage。
    spawnSync("taskkill", ["/PID", String(pid)], { encoding: "utf8" });
    if (await waitExit(10000)) return { closed: true, how: "graceful" };
  }
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  return { closed: await waitExit(10000), how: "forced-tree" };
}

export function removeDir(dir, allowedRoot) {
  const resolved = path.resolve(dir);
  if (!resolved.toLowerCase().startsWith(path.resolve(allowedRoot).toLowerCase() + path.sep)) throw new Error(`拒绝删除允许范围外的目录：${resolved}`);
  for (let attempt = 0; attempt < 10; attempt++) {
    try { rmSync(resolved, { recursive: true, force: true }); return true; } catch { spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]); }
  }
  return false;
}

export async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, timeoutMs = 120000) => {
    const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
    if (response.exceptionDetails) throw new Error(`${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}\n表达式：${expression.slice(0, 400)}`);
    return response.result.value;
  };
  const waitFor = async (expression, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return true;
      await sleep(50);
    }
    throw new Error(`等待超时：${expression.slice(0, 300)}`);
  };
  const screenshot = async (clip) => {
    const result = await call("Page.captureScreenshot", clip ? { format: "png", clip: { ...clip, scale: 1 } } : { format: "png" });
    return Buffer.from(result.data, "base64");
  };
  const on = (method, listener) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(listener); };
  return { socket, call, evaluate, waitFor, screenshot, on, close: () => socket.close() };
}

/** 页面内测量辅助：动作 → 断言首次成立（DOM 变化或 5 ms 轮询）→ 下一帧（含绘制）记为完成时间。 */
export const PAGE_HELPERS = String.raw`
(() => {
  if (window.__op) return true;
  const qa = (s) => [...document.querySelectorAll(s)];
  window.__op = {
    status: () => document.querySelector('.statusbar > span')?.textContent ?? '',
    loading: () => qa('.state').some((n) => n.textContent.includes('正在读取')),
    rows: () => qa('.file').map((n) => n.getAttribute('aria-label')),
    selected: () => document.querySelector('.file.selected')?.getAttribute('aria-label') ?? null,
    tab: () => document.querySelector('.tabbar strong')?.textContent ?? '',
    editorText: () => qa('.cm-content').map((n) => n.textContent).join('\n'),
    footer: () => document.querySelector('.sidebar > footer')?.textContent ?? '',
    row: (p) => qa('.file').find((n) => n.getAttribute('aria-label') === p) ?? null,
    projectTab: (p) => qa('.project-tab').find((n) => n.title === p) ?? null,
    scopeButton: (label) => qa('.scope').find((n) => n.textContent.trim() === label) ?? null,
    button: (text) => qa('button').find((n) => n.textContent.trim() === text) ?? null,
    epoch: () => performance.timeOrigin + performance.now(),
    setInput(aria, value) {
      const input = document.querySelector('input[aria-label="' + aria + '"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    setSelect(aria, value) {
      const select = document.querySelector('select[aria-label="' + aria + '"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    },
    readyFor(path, expect) {
      if (window.__op.tab() !== path || window.__op.loading()) return false;
      if (document.querySelector('.state.error')) return 'error';
      if (!document.querySelector('.cm-editor')) return false;
      return !expect || window.__op.editorText().includes(expect);
    },
    measure(action, predicate, timeoutMs = 10000) {
      return new Promise((resolve) => {
        const t0 = performance.now();
        let done = false, domAt = null, observer, poll, timer;
        const finish = (ok, extra) => {
          if (done) return; done = true;
          observer.disconnect(); clearInterval(poll); clearTimeout(timer);
          if (!ok) { resolve({ ok: false, ms: performance.now() - t0, ...extra }); return; }
          domAt = performance.now();
          requestAnimationFrame(() => setTimeout(() => resolve({ ok: true, ms: performance.now() - t0, domMs: domAt - t0, epoch: performance.timeOrigin + performance.now() }), 0));
        };
        const check = () => {
          if (done) return;
          let value = false;
          try { value = predicate(); } catch { value = false; }
          if (value === 'error') finish(false, { error: document.querySelector('.state.error')?.textContent ?? 'error' });
          else if (value) finish(true);
        };
        observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        poll = setInterval(check, 5);
        timer = setTimeout(() => finish(false, { error: 'timeout' }), timeoutMs);
        try { action(); } catch (error) { finish(false, { error: String(error) }); return; }
        check();
      });
    },
    waitUntil(predicate, timeoutMs = 10000) { return window.__op.measure(() => {}, predicate, timeoutMs); },
    async focused() {
      try { return await window.__TAURI_INTERNALS__.invoke('plugin:window|is_focused', { label: 'main' }); } catch (error) { return 'unknown:' + String(error).slice(0, 80); }
    }
  };
  return true;
})()`;

// ---------------- PNG 编解码（无第三方依赖） ----------------
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** pixel(x,y) 返回 [r,g,b,a]；extraChunks 可插入 acTL 等块。 */
export function encodePng(width, height, pixel, extraChunks = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extraChunks.map(([type, data]) => chunk(type, data)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export function decodePng(buffer) {
  let offset = 8, width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`不支持的 PNG 格式 ${bitDepth}/${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * channels];
      out[(y * width + x) * 4 + 1] = line[x * channels + 1];
      out[(y * width + x) * 4 + 2] = line[x * channels + 2];
      out[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    previous = line;
  }
  return { width, height, pixel: (x, y) => [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

/** 在 JPEG 的 APP0 之后插入只含 Orientation 的 EXIF APP1。 */
export function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  let insertAt = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) insertAt = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, insertAt), segment, jpeg.subarray(insertAt)]);
}

/** 最小二乘斜率（每样本单位）。 */
export function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2, my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  values.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
  return num / den;
}
