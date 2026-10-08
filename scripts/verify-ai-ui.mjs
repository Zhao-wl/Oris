// 仅启动本轮创建的 headless 浏览器和 Vite 子进程，不枚举窗口、不调用原生焦点 API。
// 服务与模型响应均为模拟数据；本脚本不能作为真实 Windows 焦点或真实服务验收证据。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ORIS_PLAYWRIGHT_MODULE || "playwright");
const output = resolve(process.env.ORIS_AI_UI_OUTPUT || "artifacts/ai-ui");
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", "1429", "--strictPort", "--host", "127.0.0.1"], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  await new Promise((yes, no) => { const timer = setTimeout(() => no(new Error("Vite 启动超时")), 15000); server.stdout.on("data", data => { if (String(data).includes("127.0.0.1:1429")) { clearTimeout(timer); yes(); } }); server.on("error", no); server.on("exit", code => { clearTimeout(timer); no(new Error(`Vite 已退出：${code}`)); }); });
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("oris.settings.v1", JSON.stringify({ version: 1, appearance: { themeMode: "light", lightScheme: "oris-light", darkScheme: "oris-dark", fontSize: 13 }, ai: { activeId: "daily", profiles: [{ id: "daily", name: "日常助手", kind: "cli", provider: "codex", executable: "", baseUrl: "", model: "model-a", hasKey: false }, { id: "deep", name: "深入分析", kind: "cli", provider: "claude", executable: "", baseUrl: "", model: "model-b", hasKey: false }] }, update: { autoCheck: false } }));
    window.__aiCalls = []; window.__savedRules = null;
    let turn = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === "plugin:window|is_focused") return false;
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:app|version") return "0.7.0";
        if (command === "plugin:dialog|open") return "C:\\tests\\team.json";
        if (command === "plugin:dialog|save") return "C:\\tests\\export.json";
        if (command === "read_ai_rules_file") return JSON.stringify({ format: "oris-ai-rules", version: 1, name: "团队规则", targets: [{ id: "team", name: "团队分析", provider: "claude", model: "model-b" }], commands: [{ id: "release", tag: "发布说明", name: "生成发布说明", description: "整理发布变化", prompt: "依据记录生成发布说明", mode: "answer", contexts: ["history"], enabled: true }], routes: [{ id: "route-release", commandId: "release", target: "team", enabled: true }], defaultTarget: null, stagedMessageTarget: null });
        if (command === "write_ai_rules_file") { window.__savedRules = JSON.parse(args.content); return; }
        if (command === "plan_ai_action") { window.__aiCalls.push(args); return { kind: "answer", message: ++turn === 1 ? "你希望调整浅色主题还是深色主题的配色？" : "已收到补充。**本轮使用固定的会话主模型**。\n\n- 示例回复，不执行真实操作\n- 历史澄清已携带" }; }
        return null;
      }
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto("http://127.0.0.1:1429", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator('.titlebar .commit-entry').waitFor({ timeout: 60000 });
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.waitFor();
  await settings.locator('[aria-controls="settings-ai-subnav"]').click();
  await settings.locator('.settings-ai-subnav').getByRole('button', { name: '指令', exact: true }).click();
  await settings.getByRole('button', { name: '@审查', exact: false }).click();
  await page.screenshot({ path: resolve(output, "ai-commands.png") });
  await settings.getByRole('button', { name: '编辑路由 ↗' }).click();
  await settings.locator('tr').filter({ hasText: '@审查' }).getByRole('button', { name: '指令 ↗' }).click();
  assert.equal(await settings.getByLabel('指令标识', { exact: true }).inputValue(), '审查');
  await settings.getByRole('button', { name: '编辑路由 ↗' }).click();
  await settings.getByLabel('@审查 路由模型', { exact: true }).selectOption('deep');
  await settings.getByLabel('@设置 路由模型', { exact: true }).selectOption('deep');
  await settings.getByRole('button', { name: '匹配', exact: true }).click();
  await settings.locator('[role=status]').filter({ hasText: 'model-b' }).waitFor();
  await settings.getByRole('button', { name: '导入', exact: true }).click();
  await settings.getByLabel('导入目标 团队分析').selectOption('deep');
  await settings.getByRole('button', { name: '合并规则', exact: true }).click();
  await settings.getByLabel('@发布说明 路由模型', { exact: true }).waitFor();
  await settings.getByRole('button', { name: '导出', exact: true }).click();
  await settings.getByRole('button', { name: '保存 JSON 文件', exact: true }).click();
  const bundle = await page.evaluate(() => window.__savedRules);
  assert.equal(bundle.commands.length, 9); assert.ok(!JSON.stringify(bundle).includes('executable'));
  await page.screenshot({ path: resolve(output, "ai-routes.png") });
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.locator('.titlebar .commit-entry').click();
  const chat = page.getByRole('dialog', { name: 'AI 临时对话', exact: true });
  await chat.getByLabel('输入 AI 指令').fill('@设置 调整配色');
  await chat.getByRole('button', { name: '确认 AI 指令' }).click();
  await chat.locator('.ai-chat-message.assistant').waitFor();
  await chat.getByLabel('输入 AI 指令').fill('浅色主题');
  await chat.getByRole('button', { name: '确认 AI 指令' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ai-chat-message.assistant').length === 2);
  const calls = await page.evaluate(() => window.__aiCalls);
  assert.equal(calls.length, 2); assert.equal(calls[0].context.conversation.length, 0); assert.equal(calls[1].context.conversation.length, 0);
  assert.equal(calls[0].profile.id, 'deep'); assert.equal(calls[1].profile.id, 'daily');
  assert.ok(!calls[1].systemPrompt.includes('已有配色'));
  assert.ok(calls[1].conversationPrompt.includes('"role":"tool"'));
  await page.screenshot({ path: resolve(output, 'ai-conversation.png') });
  await chat.getByLabel('输入 AI 指令').fill('继续说明');
  await chat.getByRole('button', { name: '确认 AI 指令' }).click();
  await page.waitForFunction(() => window.__aiCalls.length === 3 && document.querySelectorAll('.ai-chat-message.assistant').length === 3);
  const third = await page.evaluate(() => window.__aiCalls[2]);
  assert.ok(third.conversationPrompt.startsWith(calls[1].conversationPrompt));
  assert.equal(third.systemPrompt, calls[1].systemPrompt);
  await chat.getByRole('button', { name: '关闭 AI 对话' }).click();
  await page.locator('.titlebar .commit-entry').click();
  assert.equal(await page.locator('.ai-chat-message').count(), 0);
  await page.setViewportSize({ width: 900, height: 600 });
  assert.ok(await page.evaluate(() => { const r = document.querySelector('.ai-conversation').getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  const commandInput = chat.getByLabel('输入 AI 指令');
  await commandInput.fill('@');
  const options = chat.getByRole('option');
  const optionCount = await options.count();
  assert.ok(optionCount > 5);
  const menuState = () => page.evaluate(() => {
    const menu = document.querySelector('.ai-prompt-menu');
    const selected = menu.querySelector('[aria-selected="true"]');
    const viewport = menu.getBoundingClientRect(), item = selected.getBoundingClientRect();
    const top = viewport.top + menu.clientTop, bottom = top + menu.clientHeight;
    return { visible: item.top >= top - 1 && item.bottom <= bottom + 1, scrollTop: menu.scrollTop, overflowing: menu.scrollHeight > menu.clientHeight,
      focused: document.activeElement === document.querySelector('textarea[aria-label="输入 AI 指令"]'), index: [...menu.querySelectorAll('[role=option]')].indexOf(selected) };
  });
  assert.ok((await menuState()).overflowing);
  for (let i = 1; i < optionCount; i++) {
    await commandInput.press('ArrowDown');
    const state = await menuState();
    assert.equal(state.index, i); assert.ok(state.visible, `ArrowDown: option ${i} must be visible`); assert.ok(state.focused);
  }
  const bottom = await menuState(); assert.ok(bottom.scrollTop > 0);
  await page.screenshot({ path: resolve(output, 'ai-command-keyboard-scroll.png') });
  await commandInput.press('ArrowDown');
  const wrapped = await menuState(); assert.equal(wrapped.index, 0); assert.ok(wrapped.visible); assert.ok(wrapped.scrollTop < bottom.scrollTop);
  await commandInput.press('ArrowUp');
  assert.equal((await menuState()).index, optionCount - 1); assert.ok((await menuState()).visible);
  for (let i = optionCount - 2; i >= 0; i--) {
    await commandInput.press('ArrowUp');
    const state = await menuState(); assert.equal(state.index, i); assert.ok(state.visible, `ArrowUp: option ${i} must be visible`); assert.ok(state.focused);
  }
  await commandInput.fill('@设');
  assert.equal(await options.count(), 1); assert.ok((await menuState()).visible);
  await commandInput.press('Enter'); assert.equal(await commandInput.inputValue(), '@设置 ');
  assert.deepEqual(errors, []);
  console.log("PASS: settings hierarchy, rule binding/preview, import/export with simulated native dialogs, multi-turn history, close clears messages, 900×600 layout, keyboard menu scrolling/filtering/wraparound with input focus retained. Screenshots: " + output);
} finally {
  try { await browser?.close(); } finally {
    if (server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  }
}
