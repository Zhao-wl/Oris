// Headless CSS 验证：独立 Chromium，没有原生窗口激活、进程枚举或前台切换。
// 从 App.operations.test.tsx 的“初次加载”用例导出真实 React DOM，再加载生产 CSS。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const [playwrightModule, snapshots = "artifacts/issue36-layout"] = process.argv.slice(2);
if (!playwrightModule) throw new Error("请提供 Playwright 模块入口路径");
const { startVitest } = await import("vitest/node");
const savedDir = process.env.ORIS_LAYOUT_SNAPSHOTS;
process.env.ORIS_LAYOUT_SNAPSHOTS = resolve(snapshots);
let runner;
try {
  runner = await startVitest("test", ["src/App.operations.test.tsx"], { run: true, maxWorkers: 1, testNamePattern: "初次加载", setupFiles: ["scripts/issue36-layout-setup.mjs"] });
  if (!runner || runner.state.getUnhandledErrors().length || runner.state.getFiles().some(file => file.result?.state === "fail")) throw new Error("布局 DOM 导出测试失败");
} finally {
  await runner?.close();
  if (savedDir === undefined) delete process.env.ORIS_LAYOUT_SNAPSHOTS;
  else process.env.ORIS_LAYOUT_SNAPSHOTS = savedDir;
}
const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href);
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) });
const results = [];
try {
  const page = await browser.newPage();
  // HTML 夹具不需要网络；只使用当前项目的实际 CSS。
  await page.route("**/*", route => route.abort());
  for (const [width, height] of [[1280, 900], [980, 700], [720, 680]]) {
    await page.setViewportSize({ width, height });
    await page.setContent(readFileSync(join(snapshots, "sidebar.html"), "utf8"));
    // jsdom 测试挂载点是普通 div；还原生产 index.html 的 #root 高度约束。
    await page.evaluate(() => { document.body.firstElementChild.id = "root"; });
    await page.addStyleTag({ content: readFileSync("src/styles.css", "utf8") });
    const list = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar"), files = document.querySelector(".files"), filter = document.querySelector(".filter-row");
      return { sidebarHeight: sidebar.getBoundingClientRect().height, filesHeight: files.getBoundingClientRect().height,
        gap: files.getBoundingClientRect().top - filter.getBoundingClientRect().bottom,
        fourth: sidebar.children[3] === files, ignoreEntry: !!sidebar.querySelector(".ignore-status") };
    });
    assert.equal(list.fourth, true); assert.equal(list.ignoreEntry, false);
    assert.ok(list.gap >= 0 && list.gap <= 10, JSON.stringify(list));
    assert.ok(list.filesHeight > list.sidebarHeight * .6, JSON.stringify(list));
    await page.screenshot({ path: join(snapshots, `sidebar-${width}.png`) });
    await page.setContent(readFileSync(join(snapshots, "settings.html"), "utf8"));
    await page.evaluate(() => { document.body.firstElementChild.id = "root"; });
    await page.addStyleTag({ content: readFileSync("src/styles.css", "utf8") });
    const nav = await page.evaluate(() => {
      const subnav = document.querySelector("#settings-git-subnav"), button = subnav.querySelector("button");
      const group = document.querySelector(".settings-git-group>button"), dialog = document.querySelector(".settings-dialog");
      const rect = dialog.getBoundingClientRect();
      return { nested: button.textContent === "忽略文件" && !subnav.hidden,
        indent: button.getBoundingClientRect().left - group.getBoundingClientRect().left,
        withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        preview: !!document.querySelector('[aria-label="临时显示被忽略文件"]') };
    });
    assert.equal(nav.nested, true); assert.ok(nav.indent > 0); assert.equal(nav.withinViewport, true); assert.equal(nav.preview, true);
    await page.screenshot({ path: join(snapshots, `settings-${width}.png`) });
    results.push({ width, height, list, nav });
  }
  writeFileSync(join(snapshots, "results.json"), JSON.stringify({ headless: true, nativeFocusTest: false, data: "React App DOM with mocked repository", results }, null, 2));
  console.log("ISSUE36_LAYOUT_PASS", JSON.stringify(results));
} finally { await browser.close(); }
