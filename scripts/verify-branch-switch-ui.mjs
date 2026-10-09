// PR #23 前台无扰验收：真实 App + headless Edge + 模拟 Tauri 桥。
// 页面输入经浏览器协议派发，仓库响应为夹具；不能证明真实 Git / WebView2 / Windows 焦点。
// 用法：ORIS_PLAYWRIGHT_MODULE 指向已安装的 playwright（可用 Codex bundled runtime）。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ORIS_PLAYWRIGHT_MODULE || "playwright");
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(projectRoot, "artifacts", "pr23-branch-switch");
const report = { method: "headless Edge 页面交互；真实 App、模拟 Tauri/Git 响应", nativeWindowsFocus: "未验证：无隔离桌面，不启动原生 Oris 窗口", checks: [], errors: [] };
let server, browser;
let interrupted = false;
async function cleanup() {
  const results = await Promise.allSettled([browser?.close(), server?.close()]);
  for (const result of results) if (result.status === "rejected") report.errors.push(`资源清理失败：${result.reason}`);
}
const interrupt = () => { interrupted = true; void cleanup(); };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);

try {
  await mkdir(output, { recursive: true });
  // 仅在回环随机端口启动本轮 Vite，不借用已有服务。
  server = await createServer({ root: projectRoot, logLevel: "error", server: { port: 0, strictPort: false, host: "127.0.0.1" } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const entry of ["titlebar", "history-menu"]) {
    for (const choice of ["discard", "merge", "cancel", "escape"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => report.errors.push(error.message));
        await page.addInitScript(() => {
          let branch = "main", revision = 0;
          const oid = "1".repeat(40);
          const repo = () => ({ repoId: "pr23", displayName: "PR23 fixture", worktreePath: "C:/oris-test-fixture", gitDir: "C:/oris-test-fixture/.git", commonDir: "C:/oris-test-fixture/.git", branch });
          const snapshot = (requestId = "snapshot") => ({ requestId, repo: repo(), scope: "unstaged", revision: String(revision), scannedAt: 1, files: [], statsReady: true, scopes: { staged: [], unstaged: [], all: [] }, branchInfo: { head: branch, oid, upstream: null, ahead: null, behind: null }, inProgress: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false }, git: { executable: "git", version: "2.44.0", supported: true, minimumVersion: "2.31" } });
          const refs = () => ({ head: { branch: `refs/heads/${branch}`, oid, detached: false, unborn: false }, local: ["main", "feature"].map(name => ({ fullName: `refs/heads/${name}`, name, kind: "local", oid, current: branch === name, tracking: { state: "noUpstream" }, remote: null })), remote: [], tags: [], shallow: false, remotes: [], defaultRemote: null, fetchHeadAt: null });
          localStorage.setItem("oris.workspace.v2", JSON.stringify({ version: 2, activeRepoId: "pr23", projects: [{ repo: repo(), gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: { scope: "unstaged", selectedPathId: null, filter: "", fileView: "flat", hunk: 0 } }] }));
          localStorage.setItem("oris.settings.v1", JSON.stringify({ version: 1, update: { autoCheck: false } }));
          window.__pr23 = { requests: [], unknown: [], branch: () => branch };
          window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
            transformCallback: () => 1, unregisterCallback: () => {},
            invoke: async (command, args = {}) => {
              if (command === "plugin:window|is_focused") return false;
              if (command === "plugin:event|listen") return 1;
              if (command === "plugin:app|version") return "0.8.2";
              if (["open_repository", "refresh_repository"].includes(command)) return snapshot(args.requestId);
              if (command === "activate_repository" || command === "save_snapshot") return true;
              if (command === "discover_group") return { isGroup: false, members: [], selectedRepoId: null, ignored: [] };
              if (command === "read_refs") return refs();
              if (command === "read_remotes") return { remotes: [], defaultRemote: null, fetchHeadAt: null };
              if (command === "read_log") return { commits: [], next: null, tips: [] };
              if (command === "stash_list" || command === "discard_backups") return [];
              if (command === "run_operation") {
                const request = args.request;
                if (request.kind !== "branchSwitch" || request.name !== "refs/heads/feature") throw new Error("Unexpected write request");
                window.__pr23.requests.push(request);
                const base = { opId: args.opId, repoId: "pr23", kind: request.kind, output: "", outputTruncated: false, backup: null, lockLeft: false, gitProcesses: 1, elapsedMs: 1 };
                if (!request.localChanges) return { ...base, status: "needsConfirmation", message: "Git 拒绝切换：本地改动会被覆盖", snapshot: null, confirmation: { reason: "localChanges", message: "Git 拒绝切换：本地改动会被覆盖", paths: ["src/deep/a.txt"] } };
                branch = "feature"; revision++;
                return { ...base, status: "succeeded", message: request.localChanges === "merge" ? "已切换到 feature；冲突需要手动解决" : `已切换到 feature；git stash apply ${oid}`, snapshot: snapshot(), confirmation: null };
              }
              // 无仓库内容、无真实配置/缓存/更新/窗口；这些可选只读桥返回空结果。
              if (["load_snapshot", "last_operation", "repository_details", "head_commit_info", "load_ai_config", "load_ai_rules", "merge_message", "watch_group", "close_repository", "cancel_content_read", "set_submodule_pointers", "plugin:event|unlisten", "plugin:window|set_theme", "plugin:window|set_background_color"].includes(command)) return null;
              window.__pr23.unknown.push(command);
              throw new Error(`Unmocked bridge command: ${command}`);
            }
          };
          window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
        });
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.locator(".branch-button").filter({ hasText: "main" }).waitFor();
        if (entry === "titlebar") {
          await page.locator(".branch-button").click();
          await page.locator(".branch-row").filter({ has: page.locator(".branch-row-name", { hasText: /^feature$/ }) }).getByRole("button", { name: "切换", exact: true }).click();
        } else {
          await page.locator(".git-tabs").getByRole("tab", { name: "历史", exact: true }).click();
          await page.locator('[data-group="local"] .log-branch').filter({ hasText: "feature" }).click({ button: "right" });
          await page.locator(".log-menu").getByRole("menuitem", { name: "切换到 feature", exact: true }).click();
        }
        const dialog = page.getByRole("alertdialog", { name: "切换到 feature", exact: true });
        await dialog.waitFor();
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), "取消", "DOM 默认焦点");
        assert.equal(await dialog.locator(".switch-file-name").textContent(), "a.txt");
        assert.equal(await dialog.locator(".switch-file-dir").textContent(), "src/deep");
        assert.deepEqual(await page.evaluate(() => window.__pr23.requests), [{ kind: "branchSwitch", name: "refs/heads/feature" }]);
        await page.screenshot({ path: path.join(output, `${entry}-${choice}.png`) });
        if (choice === "escape") await page.keyboard.press("Escape");
        else if (choice === "cancel") await dialog.getByRole("button", { name: "取消", exact: true }).click();
        else await dialog.locator(".switch-option").filter({ hasText: choice === "discard" ? "放弃修改后切换" : "带着改动切换" }).click();
        await dialog.waitFor({ state: "detached" });
        const accepted = choice === "discard" || choice === "merge";
        if (accepted) await page.locator(".branch-button").filter({ hasText: "feature" }).waitFor();
        const result = await page.evaluate(() => ({ requests: window.__pr23.requests, branch: window.__pr23.branch(), unknown: window.__pr23.unknown }));
        assert.deepEqual(result.unknown, [], "桥接夹具必须明确处理每个实际调用");
        assert.deepEqual(result.requests, accepted ? [
          { kind: "branchSwitch", name: "refs/heads/feature" },
          { kind: "branchSwitch", name: "refs/heads/feature", localChanges: choice, includeUntracked: false }
        ] : [{ kind: "branchSwitch", name: "refs/heads/feature" }]);
        assert.equal(result.branch, accepted ? "feature" : "main");
        report.checks.push({ entry, choice, passed: true, ...result });
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(report.errors, [], "浏览器页面不能有未处理异常");
  report.passed = !interrupted;
} catch (error) {
  report.passed = false; report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await cleanup();
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  if (interrupted) process.exitCode = 130;
  report.cleaned = { browser: !browser || !browser.isConnected(), vite: !server?.httpServer?.listening };
  if (report.errors.length || !report.cleaned.browser || !report.cleaned.vite) { report.passed = false; process.exitCode = 1; }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
