// 一期 05 界面验收：A06（完整阅读体验）、A11（特殊文件）、A12（内容 / 编码 / EOL）与本阶段性能复测。
// 只经 CDP 操作本轮启动并核验过的 Oris 实例（gui-lib launchOris：PID + 完整路径 + 主窗口句柄 + 端口归属），
// 不调用任何窗口激活 API。鼠标 / 键盘 / 滚轮都是 CDP 注入的页面事件，不是真实系统输入或真实 Windows 焦点；
// 高 DPI 只用测试实例自己的设备像素比模拟（Emulation.setDeviceMetricsOverride），不是真实系统缩放。
// 用法：node scripts/perf/v1-05-acceptance.mjs --exe <oris.exe> [--only reading,perf] [--iterations 30] [--port 9781]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ROOT, assertOutside, diffFingerprints, git, prepareCoreRepos, repositoryFingerprint } from "./gui-fixtures.mjs";
import { PAGE_HELPERS, encodePng, killOris, launchOris, machineInfo, removeDir, sha256File, sleep, summarize } from "./gui-lib.mjs";
import { measuredSegment, startLoadMonitor } from "./load-monitor.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const exe = option("exe");
if (!exe) throw new Error("缺少 --exe");
const only = new Set(option("only", "reading,perf").split(","));
const iterations = Number(option("iterations", 30));
let port = Number(option("port", 9781));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(projectRoot, "artifacts", "gui-probe", option("label", "v1-05-acceptance"));
const shotDir = path.join(outDir, "shots");
mkdirSync(shotDir, { recursive: true });
const runDir = path.join(GUI_ROOT, `v1-05-acceptance-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
assertOutside(runDir);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const q = JSON.stringify;

const report = { exe: path.resolve(exe), exeSha256: sha256File(exe), machine: machineInfo(), startedAt: new Date().toISOString(), method: "CDP 页面事件（点击、按键、滚轮、拖选）；不是真实系统输入、真实 Windows 焦点或真实系统高 DPI", checks: {}, failures: [], perf: {} };
const fail = (what) => { report.failures.push(what); log("✗", what); };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; if (!ok) fail(`${name} ${detail === undefined ? "" : q(detail).slice(0, 600)}`); else log("✓", name); };
const monitor = startLoadMonitor({ log });

// ------------------------------ 夹具 ------------------------------
const write = (repo, rel, bytes) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), bytes); };
const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const appLines = () => Array.from({ length: 240 }, (_, i) => {
  if (i === 10) return `export const alpha = computeValue("old", ${i});`;
  if (i === 40) return "  return normalize(value);";
  if (i === 41) return "  // indentation only";
  if (i === 60) return "const spacing = 1;";
  if (i === 200) return `const longLine = "${"lorem ipsum dolor sit amet ".repeat(24)}";`;
  if (i === 220) return "// 中文注释：阅读体验";
  return i % 9 === 0 ? `// section ${i}` : `function step${i}(value: number) { return computeValue("x", value + ${i}); }`;
});

function prepareReadingRepo() {
  const upstream = path.join(runDir, "upstream");
  mkdirSync(upstream, { recursive: true });
  git(upstream, ["init", "-q", "-b", "main"]);
  write(upstream, "lib.txt", "v1\n"); git(upstream, ["add", "-A"]); git(upstream, ["commit", "-q", "-m", "v1"]);
  const first = git(upstream, ["rev-parse", "HEAD"]);
  write(upstream, "lib.txt", "v2\n"); git(upstream, ["commit", "-q", "-am", "v2"]);
  const second = git(upstream, ["rev-parse", "HEAD"]);

  const repo = path.join(runDir, "reading");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  const base = appLines();
  write(repo, "src/app.ts", base.join("\n") + "\n");
  write(repo, "src/ws.ts", "export function f(a: number) {\n  return a + 1;\n}\n");
  write(repo, "crlf.txt", "line one\r\nline two\r\n");
  write(repo, "final.txt", "x\ny\n");
  write(repo, "bom.txt", "same text\n");
  write(repo, "gbk.txt", "plain\n");
  write(repo, "utf16.txt", utf16le("第一行\n第二行\n"));
  write(repo, "data.bin", Buffer.from([0, 1, 2, 3, 4]));
  write(repo, "icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__orisSvgRan = 1</script><circle r="4"/></svg>\n');
  write(repo, "model.bin", `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1234\n`);
  write(repo, "tool.sh", "#!/bin/sh\necho hi\n");
  write(repo, "中文 目录/说明 文件.md", "# 标题\n\n原始段落\n");
  write(repo, "big.txt", Array.from({ length: 120000 }, (_, i) => `row ${i}`).join("\n") + "\n");
  write(repo, "longline.txt", "z".repeat(120000) + "\n");
  write(repo, "img/logo.png", encodePng(48, 32, (x, y) => [x * 5, y * 7, 120, 255]));
  git(repo, ["add", "-A"]);
  const linkTarget = git(repo, ["hash-object", "-w", "--stdin"], { input: "docs/old.md" });
  git(repo, ["update-index", "--add", "--cacheinfo", `120000,${linkTarget},link`]);
  git(repo, ["clone", "-q", upstream, "sub"]);
  git(path.join(repo, "sub"), ["checkout", "-q", first]);
  git(repo, ["add", "sub"]);
  git(repo, ["commit", "-q", "-m", "base"]);

  // 工作区（未暂存）改动
  const changed = [...base];
  changed[10] = `export const alpha = computeValue("new", 10);`;
  changed[40] = "\treturn normalize(value);";
  changed[41] = "\t// indentation only";
  changed[60] = "const spacing = 1;   ";
  changed.splice(100, 3);
  changed.splice(150, 0, "const inserted1 = 1;", "const inserted2 = 2;", "const inserted3 = 3;");
  changed[197] = `const longLine = "${"lorem ipsum dolor sit amet ".repeat(24)}CHANGED";`;
  changed[217] = "// 中文注释：阅读体验（已修改）";
  write(repo, "src/app.ts", changed.join("\n") + "\n");
  write(repo, "src/ws.ts", "export function f(a: number) {\n\treturn a  +  1;\n}\n");
  write(repo, "crlf.txt", "line one\nline two\n");
  write(repo, "final.txt", "x\ny");
  write(repo, "bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("same text\n")]));
  write(repo, "gbk.txt", Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  write(repo, "utf16.txt", utf16le("第一行\n第二行（修改）\n"));
  write(repo, "data.bin", Buffer.from([0, 1, 2, 9, 9, 9]));
  write(repo, "icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__orisSvgRan = 2</script><circle r="8"/></svg>\n');
  write(repo, "model.bin", `version https://git-lfs.github.com/spec/v1\noid sha256:${"b".repeat(64)}\nsize 5678\n`);
  write(repo, "中文 目录/说明 文件.md", "# 标题\n\n修改后的段落\n");
  write(repo, "big.txt", Array.from({ length: 120000 }, (_, i) => i === 5 ? "row changed" : `row ${i}`).join("\n") + "\n");
  write(repo, "longline.txt", "z".repeat(119999) + "y\n");
  write(repo, "img/logo.png", encodePng(48, 32, (x, y) => [200, x * 5, y * 7, 255]));
  git(path.join(repo, "sub"), ["checkout", "-q", second]);
  // 暂存区改动：仅 mode、符号链接改目标
  git(repo, ["update-index", "--chmod=+x", "tool.sh"]);
  const newTarget = git(repo, ["hash-object", "-w", "--stdin"], { input: "docs/new.md" });
  git(repo, ["update-index", "--cacheinfo", `120000,${newTarget},link`]);
  return { repo, first, second };
}

// ------------------------------ 实例 ------------------------------
async function start(profile, { deviceScaleFactor = 1 } = {}) {
  const app = await launchOris({ exe, profileDir: path.join(runDir, "profiles", profile), port: port++, log, extraEnv: { ORIS_APP_CACHE_DIR: path.join(runDir, "profiles", `${profile}-cache`) } });
  monitor.addOwnPid(app.pid);
  const { call, evaluate } = app.cdp;
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor, mobile: false });
  await evaluate(PAGE_HELPERS);
  log(`已启动 PID ${app.pid}，核验 ${q(app.identity)}`);
  const waitUntil = (expr, timeout = 30000) => evaluate(`window.__op.waitUntil(() => (${expr}), ${timeout})`, timeout + 5000).then((r) => { if (!r.ok) throw new Error(`等待失败：${expr}`); return r; });
  const measure = (action, predicate, timeout = 15000) => evaluate(`window.__op.measure(() => { ${action} }, () => (${predicate}), ${timeout})`, timeout + 5000);
  const click = (expr) => evaluate(`(() => { const n = ${expr}; if (!n) throw new Error('找不到元素：' + ${q(expr)}); n.click(); return true; })()`);
  const shot = async (name) => { await sleep(200); const { data } = await call("Page.captureScreenshot", { format: "png" }); const file = path.join(shotDir, `${name}.png`); writeFileSync(file, Buffer.from(data, "base64")); return file; };
  // 键盘：CDP Input.dispatchKeyEvent（浏览器按真实按键路径分发到焦点元素，但仍是页面注入事件）
  const press = async (key, { ctrl = false, shift = false, alt = false, code, keyCode } = {}) => {
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const vk = keyCode ?? ({ Enter: 13, Escape: 27, Tab: 9, F7: 118, ArrowDown: 40, ArrowUp: 38 }[key] ?? key.toUpperCase().charCodeAt(0));
    const base = { key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const addRepo = async (repo) => {
    await evaluate(`window.__op.setInput('仓库路径', ${q(repo)})`);
    await waitUntil(`window.__op.button('载入/添加') && !window.__op.button('载入/添加').disabled`);
    await click(`window.__op.button('载入/添加')`);
    await waitUntil(`window.__op.status().startsWith(${q(repo)}) && window.__op.rows().length > 0 && !window.__op.loading()`, 30000);
  };
  const shown = (p) => `window.__op.tab() === ${q(p)} && !window.__op.loading() && (document.querySelector('.cm-editor') || document.querySelector('.special-file') || document.querySelector('.image-viewer') || document.querySelector('.state'))`;
  const open = async (p, extra = "true") => { await click(`window.__op.row(${q(p)})`); await waitUntil(`${shown(p)} && (${extra})`, 20000); await sleep(150); };
  return { app, call, evaluate, waitUntil, measure, click, shot, press, addRepo, open, shown };
}
async function stop(s) { try { s.app.cdp.close(); } catch { /* 已关闭 */ } const r = await killOris(s.app); monitor.removeOwnPid(s.app.pid); log(`实例 ${s.app.pid} 已结束：${r.how}`); return r; }

const text = (selector) => `(document.querySelector(${q(selector)})?.textContent ?? '')`;
const notice = `[...document.querySelectorAll('.reading-notice p')].map((n) => n.textContent).join('\\n')`;
const special = `(document.querySelector('.special-file')?.textContent ?? '')`;
const position = `(document.querySelector('.diff-position')?.textContent ?? '')`;
const total = `Number((${position}).split('/')[1] ?? 0)`;
const current = `Number((${position}).split('/')[0] ?? 0)`;
const toggle = (label) => `[...document.querySelectorAll('.toolbar .toggle-button')].find((n) => n.textContent === ${q(label)})`;
const marks = `[...document.querySelectorAll('.cm-editor')].map((n) => n.__orisMark ?? null)`;

// ------------------------------ 阅读验收 ------------------------------
async function runReading() {
  const { repo } = prepareReadingRepo();
  const before = repositoryFingerprint(repo);
  const s = await start("reading");
  const { evaluate, waitUntil, click, shot, press, open, call } = s;
  try {
    await waitUntil(`document.querySelector('.project-empty')`);
    await s.addRepo(repo);
    const rows = await evaluate(`window.__op.rows()`);
    report.checks.rows = rows;

    // ---------- A12：中文路径与内容 ----------
    const chinese = "中文 目录/说明 文件.md";
    check("A12 中文 / 空格路径出现在列表", rows.includes(chinese), rows);
    await open(chinese, `window.__op.editorText().includes('修改后的段落')`);
    check("A12 中文路径的内容可读", await evaluate(`window.__op.tab() === ${q(chinese)} && window.__op.editorText().includes('修改后的段落')`));
    check("A12 端点显示两侧编码与换行", /UTF-8 · LF/.test(await evaluate(text(".left-endpoint .encoding"))) && /UTF-8 · LF/.test(await evaluate(text(".right-endpoint .encoding"))), await evaluate(`[${text(".left-endpoint .encoding")}, ${text(".right-endpoint .encoding")}]`));
    await open("crlf.txt");
    const crlf = { notice: await evaluate(notice), left: await evaluate(text(".left-endpoint .encoding")), right: await evaluate(text(".right-endpoint .encoding")), total: await evaluate(total) };
    check("A12 CRLF → LF：两侧换行标出，并说明文本相同只有换行符变化", crlf.left.includes("CRLF") && crlf.right.includes("LF") && crlf.notice.includes("换行符：CRLF → LF") && !/无变化/.test(crlf.notice), crlf);
    await shot("a12-crlf");
    await open("final.txt");
    const final = { notice: await evaluate(notice), right: await evaluate(text(".right-endpoint .encoding")) };
    check("A12 无末尾换行：标题与说明", final.right.includes("无末尾换行") && final.notice.includes("移除末尾换行"), final);
    await open("bom.txt");
    const bom = { notice: await evaluate(notice), right: await evaluate(text(".right-endpoint .encoding")) };
    check("A12 BOM：文本相同但说明新增 BOM", bom.right.includes("BOM") && bom.notice.includes("新增 BOM"), bom);
    await open("gbk.txt", `document.querySelector('.special-file')`);
    const gbk = await evaluate(special);
    check("A12 编码失败：明确“编码不受支持”，不显示为无变化", gbk.includes("编码不受支持") && gbk.includes("内容不同") && !(await evaluate(`!!document.querySelector('.cm-editor') && !document.querySelector('.partial-notice')`)), gbk);
    await shot("a12-gbk");
    await open("utf16.txt", `window.__op.editorText().includes('第二行（修改）')`);
    check("A12 带 BOM 的 UTF-16 按文本解码", (await evaluate(text(".right-endpoint .encoding"))).includes("UTF-16 LE · BOM") && (await evaluate(total)) >= 1, await evaluate(text(".right-endpoint .encoding")));

    // ---------- A11：特殊文件 ----------
    await open("data.bin", `document.querySelector('.special-file')`);
    const bin = await evaluate(special);
    check("A11 二进制：显示大小与“内容不同”", bin.includes("二进制文件 · 内容不同") && bin.includes("5 字节") && bin.includes("6 字节"), bin);
    await open("icon.svg", `window.__op.editorText().includes('circle')`);
    const svg = { notice: await evaluate(notice), ran: await evaluate(`window.__orisSvgRan ?? null`), rendered: await evaluate(`[...document.querySelectorAll('.diff-host svg')].filter((n) => !n.classList.contains('diff-connectors')).length`), text: await evaluate(`window.__op.editorText().includes('<script>')`) };
    check("A11 SVG 按源代码文本显示，不渲染、不执行脚本", svg.ran === null && svg.rendered === 0 && svg.text && svg.notice.includes("不执行"), svg);
    await open("model.bin", `window.__op.editorText().includes('git-lfs')`);
    const lfs = await evaluate(notice);
    check("A11 LFS 指针：标出且说明不会自动下载", lfs.includes("Git LFS 指针") && lfs.includes("不会自动下载") && lfs.includes("本地缓存中没有对象"), lfs);
    await open("sub", `document.querySelector('.special-file')`);
    const sub = await evaluate(special);
    check("A11 子模块 gitlink：两侧提交、提交已改变，不初始化", sub.includes("子模块（gitlink）· 子模块指向的提交已改变") && sub.includes("提交 "), sub);
    await shot("a11-submodule");
    await open("img/logo.png", `document.querySelector('.image-viewer')`);
    const image = await evaluate(`({ controls: [...document.querySelectorAll('.image-viewer button, .image-viewer input, .image-viewer select')].map((n) => ({ tag: n.tagName, label: n.getAttribute('aria-label') ?? n.textContent.trim(), tabbable: n.tabIndex >= 0 && !n.disabled })), bg: getComputedStyle(document.querySelector('.image-viewer')).backgroundColor })`);
    check("A11 图片复用任务 03 阅读器，控件可用键盘到达", image.controls.length > 0 && image.controls.every((c) => c.tabbable), image);

    // 暂存区：仅 mode、符号链接
    await click(`window.__op.scopeButton('已暂存')`);
    await waitUntil(`window.__op.footer().includes('已暂存') && !window.__op.loading()`);
    await open("tool.sh");
    const mode = { notice: await evaluate(notice), total: await evaluate(total) };
    check("A11 仅 mode 变化：说明文件模式变化，不显示为无变化", mode.notice.includes("文件模式：100644 → 100755") && mode.total === 0, mode);
    await open("link", `document.querySelector('.special-file')`);
    const link = await evaluate(special);
    check("A11 符号链接：显示两侧目标，不跟随", link.includes("符号链接 · 目标已改变") && link.includes("docs/old.md") && link.includes("docs/new.md"), link);
    await click(`window.__op.scopeButton('未暂存')`);
    await waitUntil(`window.__op.footer().includes('未暂存') && !window.__op.loading()`);

    // ---------- 预算：超预算明确降级并可切换 ----------
    for (const [file, expect] of [["big.txt", "120001 行"], ["longline.txt", "最长行"]]) {
      await open(file, `document.querySelector('.special-file')`);
      const body = await evaluate(special);
      check(`预算 ${file}：超出显示预算、说明已显示范围`, body.includes("超出显示预算") && body.includes("已显示范围：无") && (file !== "big.txt" || body.includes("行")), { body, expect });
    }
    await open("longline.txt", `document.querySelector('.special-file')`);
    await evaluate(`document.activeElement?.blur?.()`);
    await press("ArrowDown", { alt: true });
    await waitUntil(`window.__op.tab() !== 'longline.txt' && !window.__op.loading()`, 15000);
    check("预算：超预算文件后仍可用键盘切换到其他文件", await evaluate(`window.__op.tab() !== 'longline.txt'`), await evaluate(`window.__op.tab()`));

    // ---------- A06：src/app.ts ----------
    await open("src/app.ts", `window.__op.editorText().includes('computeValue("new"')`);
    await sleep(400);
    const keepTotal = await evaluate(total);
    const split = await evaluate(`({ split: !!document.querySelector('.oris-split-view'), connectors: document.querySelectorAll('.diff-connectors path').length, words: document.querySelectorAll('.oris-changed-text').length, lines: document.querySelectorAll('.oris-modified-line, .oris-inserted-line, .oris-deleted-line').length, hunks: Number(document.querySelector('.oris-split-view').dataset.hunkCount) })`);
    check("A06 并排：连接带、词级与行级底色、计数一致", split.split && split.connectors > 0 && split.words > 0 && split.lines > 0 && split.hunks === keepTotal && keepTotal >= 6, { ...split, keepTotal });
    await evaluate(`window.__op.setSelect('高亮粒度', 'lines')`);
    await waitUntil(`document.querySelectorAll('.oris-changed-text').length === 0`);
    check("A06 按行高亮：没有词级标记", true);
    await evaluate(`window.__op.setSelect('高亮粒度', 'words')`);
    await waitUntil(`document.querySelectorAll('.oris-changed-text').length > 0`);
    await evaluate(`document.querySelectorAll('.cm-editor').forEach((n, i) => { n.__orisMark = 'editor-' + i; })`);
    const baseMarks = await evaluate(marks);

    // 前后导航：F7 / Shift+F7（焦点在编辑器内）
    await evaluate(`document.querySelector('.oris-split-pane.right .cm-content').focus()`);
    await press("F7"); await sleep(250);
    const afterF7 = await evaluate(current);
    await press("F7", { shift: true }); await sleep(250);
    const afterShiftF7 = await evaluate(current);
    check("A06 F7 / Shift+F7 前后差异导航", afterF7 === 2 && afterShiftF7 === 1, { afterF7, afterShiftF7 });

    // 搜索
    await press("f", { ctrl: true });
    await waitUntil(`document.querySelector('.oris-search-panel:not([hidden])')`);
    await evaluate(`(() => { const input = document.querySelector('.oris-search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'computeValue'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitUntil(`/^1\\/\\d+/.test(document.querySelector('.oris-search-status').textContent)`);
    await press("Enter");
    await sleep(200);
    const search = await evaluate(`({ status: document.querySelector('.oris-search-status').textContent, current: document.querySelectorAll('.oris-search-match.current').length, hits: document.querySelectorAll('.oris-search-match').length })`);
    check("A06 搜索：计数、Enter 到下一个、当前命中高亮", /^2\/\d+/.test(search.status) && search.current === 1 && search.hits > 1, search);
    await press("Escape");
    await waitUntil(`document.querySelector('.oris-search-panel')?.hidden !== false`);

    // 选择复制（CDP 拖选 + 合成 copy 事件，读取 DataTransfer）
    const point = await evaluate(`(() => { const pane = document.querySelector('.oris-split-pane.right .cm-scroller'); const box = pane.getBoundingClientRect(); for (const line of pane.querySelectorAll('.cm-line')) { const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let t; while ((t = walker.nextNode())) { const i = t.data.indexOf('computeValue'); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 12); const b = r.getBoundingClientRect(); if (b.width > 0 && b.top > box.top + 2 && b.bottom < box.bottom - 2) return { x1: b.left + 0.5, x2: b.right - 0.5, y: b.top + b.height / 2 }; } } } return null; })()`);
    if (point) {
      await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x1, y: point.y });
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: point.x2, y: point.y });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x2, y: point.y });
      await sleep(200);
    }
    const copied = await evaluate(`(() => { const dt = new DataTransfer(); const target = document.querySelector('.oris-split-pane.right .cm-content'); target.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })); return { selection: getSelection().toString(), copied: dt.getData('text/plain'), sameWord: document.querySelectorAll('.oris-selection-match').length }; })()`);
    check("A06 选择复制：复制内容等于选区，选中同词高亮", !!point && copied.selection === "computeValue" && copied.copied === "computeValue" && copied.sameWord >= 1, { point, ...copied });

    // 同步滚动（CDP 滚轮）
    const rightBox = await evaluate(`(() => { const b = document.querySelector('.oris-split-pane.right .cm-scroller').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: rightBox.x, y: rightBox.y, deltaX: 0, deltaY: 1200 });
    await sleep(500);
    const scroll = await evaluate(`({ left: document.querySelector('.oris-split-pane.left .cm-scroller').scrollTop, right: document.querySelector('.oris-split-pane.right .cm-scroller').scrollTop, master: document.querySelector('.oris-split-view').dataset.masterSide })`);
    check("A06 同步滚动：滚动右侧，左侧按差异映射跟随", scroll.right > 300 && scroll.left > 300 && scroll.master === "b", scroll);

    // 折叠、逐段展开、折叠后导航、全部展开
    await click(toggle("折叠上下文"));
    await waitUntil(`Number(document.querySelector('.oris-split-view')?.dataset.collapsedRegions ?? 0) > 0 && document.querySelectorAll('.cm-collapsedLines').length > 0`);
    const regions = await evaluate(`Number(document.querySelector('.oris-split-view').dataset.collapsedRegions)`);
    await click(`document.querySelector('.cm-collapsedLines')`);
    await waitUntil(`document.querySelector('.oris-split-view').dataset.expandedRegions === '1'`);
    await evaluate(`document.querySelector('.oris-split-pane.right .cm-content').focus()`);
    await press("F7"); await sleep(300);
    const folded = await evaluate(`({ current: ${current}, total: ${total} })`);
    check("A06 折叠后导航：计数与导航使用同一阅读模型", folded.total === keepTotal && folded.current >= 1, folded);
    await click(`window.__op.button('全部展开')`);
    await waitUntil(`document.querySelectorAll('.oris-split-view .cm-collapsedLines').length === 0`);
    check("A06 逐段展开与全部展开（并排）", regions >= 2, { regions });

    // 统一视图：同一计数；折叠占位中文；全部展开
    await evaluate(`window.__op.setSelect('Diff 布局', 'unified')`);
    await waitUntil(`!document.querySelector('.oris-split-view') && document.querySelector('.cm-editor')`);
    await sleep(500);
    const unified = await evaluate(`({ total: ${total}, collapsed: [...document.querySelectorAll('.cm-collapsedLines')].map((n) => n.textContent), deleted: document.querySelectorAll('.cm-deletedChunk').length })`);
    await click(`window.__op.button('全部展开')`);
    await sleep(300);
    const unifiedExpanded = await evaluate(`document.querySelectorAll('.cm-collapsedLines').length`);
    check("A06 统一视图：差异数与并排一致，折叠占位中文，可全部展开", unified.total === keepTotal && unified.collapsed.length > 0 && unified.collapsed.every((t) => t.startsWith("展开")) && unifiedExpanded === 0, { ...unified, unifiedExpanded });
    await shot("a06-unified");
    await click(toggle("折叠上下文"));
    await evaluate(`window.__op.setSelect('Diff 布局', 'split')`);
    await waitUntil(`document.querySelector('.oris-split-view')`);
    await sleep(400);
    await evaluate(`document.querySelectorAll('.cm-editor').forEach((n, i) => { n.__orisMark = 'editor-' + i; })`);

    // 软换行 + 对齐：同一差异块两侧上下边对齐
    await click(toggle("自动换行"));
    await click(toggle("对齐变化"));
    await waitUntil(`document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true' && document.querySelector('.cm-lineWrapping')`, 20000);
    await sleep(600);
    const aligned = await evaluate(`(() => { const view = document.querySelector('.oris-split-view'); const paths = [...document.querySelectorAll('.diff-connectors path')]; const err = paths.map((p) => Math.max(Math.abs(Number(p.dataset.aTop) - Number(p.dataset.bTop)), Math.abs(Number(p.dataset.aBottom) - Number(p.dataset.bBottom)))); return { paths: paths.length, maxError: err.length ? Math.max(...err) : null, wrapping: !!document.querySelector('.cm-lineWrapping') }; })()`);
    check("A06 软换行后对应：对齐开启时同一块两侧上下边误差 ≤ 1.5 px", aligned.wrapping && aligned.paths > 0 && aligned.maxError !== null && aligned.maxError <= 1.5, aligned);
    await shot("a06-wrap-align");
    await click(toggle("对齐变化"));
    await click(toggle("自动换行"));
    await sleep(300);
    await evaluate(`document.querySelectorAll('.cm-editor').forEach((n, i) => { n.__orisMark = 'editor-' + i; })`);

    // 空白规则
    await evaluate(`window.__op.setSelect('空白规则', 'ignore')`);
    await waitUntil(`${total} < ${keepTotal} && document.querySelector('.filter-badge')`);
    const ignore = { total: await evaluate(total), badge: await evaluate(text(".filter-badge")) };
    await open("src/ws.ts");
    const wsIgnore = { total: await evaluate(total), notice: await evaluate(notice), badge: await evaluate(text(".filter-badge")) };
    await evaluate(`window.__op.setSelect('空白规则', 'keep')`);
    await waitUntil(`${total} >= 1 && !document.querySelector('.filter-badge')`);
    const wsKeep = await evaluate(total);
    check("A06 忽略空白：计数减少、规则持续可见、只有空白差异的文件说明原因", ignore.total < keepTotal && ignore.badge.includes("已忽略空白") && wsIgnore.total === 0 && wsIgnore.notice.includes("忽略空白后没有差异") && wsIgnore.badge.includes("已忽略空白") && wsKeep >= 1, { keepTotal, ignore, wsIgnore, wsKeep });
    await shot("a06-whitespace");

    // 字号与主题：不重建编辑器
    await open("src/app.ts", `window.__op.editorText().includes('computeValue("new"')`);
    await sleep(300);
    await evaluate(`document.querySelectorAll('.cm-editor').forEach((n, i) => { n.__orisMark = 'editor-' + i; })`);
    const marked = await evaluate(marks);
    await press("=", { ctrl: true, code: "Equal", keyCode: 187 });
    await waitUntil(`getComputedStyle(document.querySelector('.cm-content')).fontSize === '14px'`);
    await press("0", { ctrl: true, code: "Digit0", keyCode: 48 });
    await waitUntil(`getComputedStyle(document.querySelector('.cm-content')).fontSize === '13px'`);
    await click(`document.querySelector('button[aria-label="设置"]')`);
    await waitUntil(`document.querySelector('.settings-dialog [role=option]')`);
    await click(`[...document.querySelectorAll('.segmented button')].find((n) => n.textContent === '浅色')`);
    await waitUntil(`document.documentElement.classList.contains('theme-light')`);
    await shot("a06-light");
    await click(`[...document.querySelectorAll('.segmented button')].find((n) => n.textContent === '深色')`);
    await waitUntil(`document.documentElement.classList.contains('theme-dark')`);
    await click(`document.querySelector('button[aria-label="关闭设置"]')`);
    check("A06 字号 / 浅深主题切换不重建编辑器", JSON.stringify(await evaluate(marks)) === JSON.stringify(marked) && marked.every(Boolean), { marked, baseMarks });

    // 专注 diff
    const widthBefore = await evaluate(`document.querySelector('.editor').getBoundingClientRect().width`);
    await evaluate(`document.querySelector('.oris-split-pane.right .cm-content').focus()`);
    await press("Enter", { ctrl: true, shift: true });
    await waitUntil(`document.querySelector('.app.focus-mode')`);
    const focus = await evaluate(`({ sidebar: getComputedStyle(document.querySelector('.sidebar')).display, projectbar: getComputedStyle(document.querySelector('.projectbar')).display, width: document.querySelector('.editor').getBoundingClientRect().width, marks: ${marks} })`);
    await shot("a06-focus-mode");
    await press("Escape");
    await waitUntil(`!document.querySelector('.app.focus-mode')`);
    check("A06 专注 diff：Ctrl+Shift+Enter 进入（隐藏侧栏与项目栏）、Esc 退出，不重建编辑器", focus.sidebar === "none" && focus.projectbar === "none" && focus.width > widthBefore + 200 && JSON.stringify(focus.marks) === JSON.stringify(marked), { ...focus, widthBefore });

    // 全键盘主要路径与可见焦点：Tab 经过工具栏控件，每个获得焦点的控件都有可见焦点样式
    await evaluate(`document.querySelector('.toolbar button').focus()`);
    const visited = [];
    for (let i = 0; i < 12; i++) {
      await press("Tab");
      visited.push(await evaluate(`(() => { const n = document.activeElement; const host = n.classList.contains('cm-content') ? n.closest('.cm-editor') : n; const cs = getComputedStyle(host); return { tag: n.tagName, label: n.getAttribute('aria-label') ?? n.textContent.trim().slice(0, 20), focusVisible: n.matches(':focus-visible'), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none' }; })()`));
    }
    check("R-UX Tab 顺序中的控件都有可见焦点（CDP 按键，非真实焦点）", visited.every((v) => v.focusVisible && (v.outline || v.shadow)), visited);
    await evaluate(`document.activeElement?.blur?.()`);
    const fileBefore = await evaluate(`window.__op.tab()`);
    await press("ArrowDown", { alt: true });
    await waitUntil(`window.__op.tab() !== ${q(fileBefore)} && !window.__op.loading()`);
    await press("ArrowUp", { alt: true });
    await waitUntil(`window.__op.tab() === ${q(fileBefore)} && !window.__op.loading()`);
    check("R-UX Alt+↓ / Alt+↑ 键盘切换文件", true);

    // 高 DPI 近似：测试实例自己的设备像素比 1.5 / 2（不是系统缩放）
    for (const dpr of [1.5, 2]) {
      await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
      await sleep(700);
      const hi = await evaluate(`({ dpr: devicePixelRatio, connectors: document.querySelectorAll('.diff-connectors path').length, markers: document.querySelectorAll('.diff-overview-marker').length })`);
      await shot(`hidpi-${dpr}`);
      check(`高 DPI 近似 ${dpr}x（Emulation，非真实系统缩放）：连接带与色标正常`, hi.dpr === dpr && hi.connectors > 0 && hi.markers > 0, hi);
    }
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  } catch (error) {
    report.readingError = String(error.stack ?? error);
    fail(`阅读验收脚本异常：${error.message}`);
    try { await shot("reading-failure"); } catch { /* ignore */ }
  } finally {
    report.readingStop = await stop(s);
    const after = repositoryFingerprint(repo);
    const changed = diffFingerprints(before, after);
    check("只读：阅读前后工作区、index、refs、config 无变化", changed.length === 0, changed);
  }
}

// ------------------------------ 性能复测 ------------------------------
async function runPerf() {
  const perf = report.perf;
  const repos = await prepareCoreRepos(runDir, 2);
  // 大文本、大图片与典型滚动夹具
  const heavy = path.join(runDir, "heavy");
  mkdirSync(heavy, { recursive: true });
  git(heavy, ["init", "-q", "-b", "main"]);
  const bigText = (seed) => Array.from({ length: 80000 }, (_, i) => `export const value_${seed}_${i} = compute(${i}, "${(i * 2654435761 % 1000000).toString(36)}");`);
  const typical = Array.from({ length: 3000 }, (_, i) => i % 11 === 0 ? `// block ${i}` : `  const item${i} = await service.load(${i}, { retry: ${i % 5}, label: "item-${i}" });`);
  for (const n of [1, 2, 3]) write(heavy, `large${n}.ts`, bigText(n).join("\n") + "\n");
  write(heavy, "typical.ts", typical.join("\n") + "\n");
  const imageA = (seed) => encodePng(2500, 2500, (x, y) => [(x + seed) & 255, (y * 3) & 255, ((x ^ y) + seed) & 255, 255]);
  write(heavy, "img/big1.png", imageA(1)); write(heavy, "img/big2.png", imageA(2));
  git(heavy, ["add", "-A"]); git(heavy, ["commit", "-q", "-m", "base"]);
  for (const n of [1, 2, 3]) { const lines = bigText(n); for (let i = 50; i < lines.length; i += 400) lines[i] = lines[i].replace("compute", "recompute"); write(heavy, `large${n}.ts`, lines.join("\n") + "\n"); }
  const typicalChanged = [...typical]; for (let i = 30; i < typicalChanged.length; i += 50) typicalChanged[i] = typicalChanged[i].replace("retry", "retries").replace("await", "await  ");
  typicalChanged.splice(1500, 0, "  // inserted block", "  const extra = true;");
  write(heavy, "typical.ts", typicalChanged.join("\n") + "\n");
  write(heavy, "img/big1.png", imageA(40)); write(heavy, "img/big2.png", imageA(90));
  git(heavy, ["status", "--porcelain"]);

  const s = await start("perf");
  const { evaluate, waitUntil, measure, click, call } = s;
  const readyText = (p, expect) => `window.__op.readyFor(${q(p)}, ${q(expect)}) === true`;
  const firstLine = (repo, rel) => readFileSync(path.join(repo, rel), "utf8").split("\n")[0];
  try {
    await waitUntil(`document.querySelector('.project-empty')`);
    for (const repo of repos) await s.addRepo(repo.path);
    await s.addRepo(heavy);
    const switchTo = async (repo) => { await evaluate(`window.__op.projectTab(${q(repo)}).querySelector('.project-switch').click()`); await waitUntil(`window.__op.status().startsWith(${q(repo)}) && !window.__op.loading()`); await sleep(800); };
    const modified = (repo) => new Set(repo.manifest.manifest.filter((m) => m.type === "unstaged" || m.type === "both").map((m) => m.path));

    // 已缓存文件切换
    perf.cachedFile = await measuredSegment(monitor, "已缓存文件切换", async () => {
      await switchTo(repos[0].path);
      const order = (await evaluate(`window.__op.rows()`)).filter((p) => modified(repos[0]).has(p));
      const [a, b] = order;
      for (const p of [a, b]) { await measure(`window.__op.row(${q(p)}).click()`, readyText(p, firstLine(repos[0].path, p))); await sleep(400); }
      const samples = [];
      for (let i = 0; i < iterations; i++) { const p = i % 2 ? b : a; await sleep(250); samples.push({ i, path: p, ...(await measure(`window.__op.row(${q(p)}).click()`, readyText(p, firstLine(repos[0].path, p)))) }); }
      return { budget: "P95 ≤ 100 ms", samples, summary: summarize(samples) };
    }, { log });
    log("已缓存文件切换", perf.cachedFile.result.summary);

    // 未缓存常用文件（S1、S2，避开已读与相邻文件）
    perf.uncachedFile = await measuredSegment(monitor, "未缓存文件", async (attempt) => {
      const samples = [];
      for (const repo of repos) {
        await switchTo(repo.path);
        const order = await evaluate(`window.__op.rows()`);
        const touched = new Set();
        const mark = (p) => { const k = order.indexOf(p); for (const d of [-1, 0, 1]) touched.add(order[(k + d + order.length) % order.length]); };
        mark(await evaluate(`window.__op.selected()`));
        // 重测时从列表另一端取，避免读到已缓存文件
        const candidates = attempt % 2 ? [...order].reverse() : order;
        for (const p of candidates) {
          if (samples.filter((x) => x.repo === repo.path).length >= Math.ceil(iterations / 2)) break;
          if (!modified(repo).has(p) || touched.has(p)) continue;
          await sleep(400);
          samples.push({ repo: repo.path, path: p, ...(await measure(`window.__op.row(${q(p)}).click()`, readyText(p, firstLine(repo.path, p)))) });
          mark(p);
        }
      }
      return { budget: "P95 ≤ 400 ms", samples, summary: summarize(samples) };
    }, { log });
    log("未缓存文件", perf.uncachedFile.result.summary);

    // 大文本计算与渲染（3 个 80,000 行文件轮换，超出内容缓存，每次都重新读取与计算）
    await switchTo(heavy);
    perf.largeText = await measuredSegment(monitor, "大文本", async () => {
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const p = `large${(i % 3) + 1}.ts`;
        await sleep(300);
        const r = await measure(`window.__op.row(${q(p)}).click()`, `${readyText(p, firstLine(heavy, p))} && /Worker/.test(document.querySelector('.tabbar').textContent)`, 30000);
        const worker = await evaluate(`Number(/Worker ([\\d.]+) ms/.exec(document.querySelector('.tabbar').textContent)?.[1] ?? NaN)`);
        samples.push({ i, path: p, workerMs: worker, ...r });
      }
      return { what: "80,000 行（约 5 MB 内）的文本：点击到正文可读；workerMs 为 Worker 计算耗时", samples, summary: summarize(samples), worker: summarize(samples.map((x) => ({ ok: Number.isFinite(x.workerMs), ms: x.workerMs }))) };
    }, { log });
    log("大文本", perf.largeText.result.summary, "Worker", perf.largeText.result.worker);

    // 大图片（2 张 2500×2500 ≈ 6.3 MP，轮换）：点击到两侧图片解码完成
    perf.largeImage = await measuredSegment(monitor, "大图片", async () => {
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const p = `img/big${(i % 2) + 1}.png`;
        await sleep(300);
        samples.push({ i, path: p, ...(await measure(`window.__op.row(${q(p)}).click()`, `window.__op.tab() === ${q(p)} && !window.__op.loading() && [...document.querySelectorAll('.image-viewer img')].length >= 2 && [...document.querySelectorAll('.image-viewer img')].every((img) => img.complete && img.naturalWidth > 0)`, 30000)) });
      }
      return { what: "6.3 MP PNG 两侧：点击到两张图片都解码完成", samples, summary: summarize(samples) };
    }, { log });
    log("大图片", perf.largeImage.result.summary);

    // 典型 diff 滚动：连续 12 s CDP 滚轮，页面内记录 rAF 帧间隔
    await measure(`window.__op.row('typical.ts').click()`, readyText("typical.ts", firstLine(heavy, "typical.ts")), 20000);
    await sleep(1200);
    const scrollRun = async (label) => {
      const box = await evaluate(`(() => { const b = document.querySelector('.oris-split-pane.right .cm-scroller, .cm-scroller').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller, .cm-scroller'); sc.scrollTop = 0; window.__frames = []; window.__scrolling = true; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__scrolling) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
      const until = Date.now() + 12000;
      let direction = 1;
      while (Date.now() < until) {
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 90 * direction });
        const atEnd = await evaluate(`(() => { const sc = document.querySelector('.oris-split-pane.right .cm-scroller, .cm-scroller'); return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 ? 1 : sc.scrollTop <= 0 ? -1 : 0; })()`);
        if (atEnd === 1) direction = -1; else if (atEnd === -1) direction = 1;
        await sleep(16);
      }
      const frames = await evaluate(`(() => { window.__scrolling = false; return window.__frames.slice(2); })()`);
      const sorted = [...frames].sort((a, b) => a - b);
      const p = (v) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * v) - 1)];
      return { label, frames: frames.length, durationMs: Math.round(frames.reduce((a, b) => a + b, 0)), p50: Number(p(0.5).toFixed(1)), p95: Number(p(0.95).toFixed(1)), max: Number(sorted.at(-1).toFixed(1)), longFrames50: frames.filter((f) => f > 50).length, longFrames100: frames.filter((f) => f > 100).length, raw: frames.map((f) => Number(f.toFixed(1))) };
    };
    perf.scroll = await measuredSegment(monitor, "典型滚动", async () => {
      const split = await scrollRun("并排（默认）");
      await click(toggle("自动换行")); await click(toggle("对齐变化"));
      await waitUntil(`document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'`, 20000);
      const wrapAligned = await scrollRun("并排 + 自动换行 + 对齐变化");
      await click(toggle("对齐变化")); await click(toggle("自动换行"));
      await evaluate(`window.__op.setSelect('Diff 布局', 'unified')`); await sleep(800);
      const unified = await scrollRun("统一视图");
      await evaluate(`window.__op.setSelect('Diff 布局', 'split')`); await sleep(800);
      return { what: "typical.ts（3,000 行、约 60 处差异）连续 12 s CDP 滚轮；预算按并排（默认）判定", budget: "P95 帧间隔 ≤ 33 ms", runs: [split, wrapAligned, unified] };
    }, { log });
    log("滚动", perf.scroll.result.runs.map((r) => `${r.label} P95 ${r.p95} ms，长帧 ${r.longFrames50}`));

    // 切换配色 / 主题模式 / 字号：不重建编辑器
    perf.appearance = await measuredSegment(monitor, "外观切换", async () => {
      await evaluate(`document.querySelectorAll('.cm-editor').forEach((n, i) => { n.__orisMark = 'editor-' + i; })`);
      const marked = await evaluate(marks);
      const font = [];
      for (let i = 0; i < iterations; i++) {
        const up = i % 2 === 0;
        font.push(await measure(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${q("")} + (${up} ? '=' : '-'), ctrlKey: true, bubbles: true, cancelable: true }))`, `getComputedStyle(document.querySelector('.cm-content')).fontSize === ${up} ? '14px' : '13px'`));
      }
      await click(`document.querySelector('button[aria-label="设置"]')`);
      await waitUntil(`document.querySelector('.settings-dialog [role=option]')`);
      // 两套深色方案（当前为深色模式）：计到根元素换成该方案（与 V2-06 验收同一口径）
      const index = JSON.parse(readFileSync(path.join(projectRoot, "src", "themes", "generated", "index.json"), "utf8"));
      const options = ["dark-modern", "monokai"].map((id) => index.find((entry) => entry.id === id));
      const scheme = [];
      for (let i = 0; i < iterations; i++) {
        const entry = options[i % 2 ? 1 : 0];
        scheme.push(await measure(`[...document.querySelectorAll('[role=option]')].find((n) => n.querySelector('.scheme-name')?.textContent === ${q(entry.name)}).click()`, `document.documentElement.dataset.scheme === ${q(entry.id)}`));
      }
      const modes = [];
      for (let i = 0; i < iterations; i++) {
        const light = i % 2 === 0;
        modes.push(await measure(`[...document.querySelectorAll('.segmented button')].find((n) => n.textContent === (${light} ? '浅色' : '深色')).click()`, `document.documentElement.classList.contains(${light} ? 'theme-light' : 'theme-dark')`));
      }
      await click(`document.querySelector('button[aria-label="关闭设置"]')`);
      const same = JSON.stringify(await evaluate(marks)) === JSON.stringify(marked);
      return { budget: "P95 ≤ 100 ms，且不重建编辑器", notRebuilt: same, font: { samples: font, summary: summarize(font) }, scheme: { schemes: options.map((entry) => entry.id), samples: scheme, summary: summarize(scheme) }, mode: { samples: modes, summary: summarize(modes) } };
    }, { log });
    log("外观切换", { font: perf.appearance.result.font.summary, scheme: perf.appearance.result.scheme.summary, mode: perf.appearance.result.mode.summary, notRebuilt: perf.appearance.result.notRebuilt });

    const p95 = (segment) => segment.result.summary?.p95;
    check("性能 已缓存文件切换 P95 ≤ 100 ms", perf.cachedFile.verdict === "ok" && p95(perf.cachedFile) <= 100, perf.cachedFile.result.summary);
    check("性能 未缓存常用文件 P95 ≤ 400 ms", perf.uncachedFile.verdict === "ok" && p95(perf.uncachedFile) <= 400, perf.uncachedFile.result.summary);
    const splitScroll = perf.scroll.result.runs[0];
    check("性能 典型滚动 P95 帧间隔 ≤ 33 ms（≥ 10 s）", perf.scroll.verdict === "ok" && splitScroll.durationMs >= 10000 && splitScroll.p95 <= 33, { p95: splitScroll.p95, durationMs: splitScroll.durationMs, longFrames50: splitScroll.longFrames50 });
    const a = perf.appearance.result;
    check("性能 切换配色 / 主题模式 / 字号 P95 ≤ 100 ms 且不重建编辑器", perf.appearance.verdict === "ok" && a.notRebuilt && a.font.summary.p95 <= 100 && a.scheme.summary.p95 <= 100 && a.mode.summary.p95 <= 100, { font: a.font.summary, scheme: a.scheme.summary, mode: a.mode.summary, notRebuilt: a.notRebuilt });
    for (const segment of ["largeText", "largeImage"]) report.checks[`性能 ${segment}（只记录）`] = { ok: true, detail: perf[segment].result.summary };
  } catch (error) {
    report.perfError = String(error.stack ?? error);
    fail(`性能复测脚本异常：${error.message}`);
  } finally {
    report.perfStop = await stop(s);
  }
}

try {
  if (only.has("reading")) await runReading();
  if (only.has("perf")) await runPerf();
} finally {
  report.load = monitor.summary(Date.parse(report.startedAt), Date.now());
  report.loadSamples = monitor.samples;
  monitor.stop();
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  log(`检查 ${Object.keys(report.checks).length} 项，失败 ${report.failures.length} 项；报告 ${path.join(outDir, "report.json")}`);
  removeDir(runDir, GUI_ROOT);
}
