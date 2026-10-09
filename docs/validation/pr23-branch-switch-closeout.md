# PR #23 分支切换补充验收

日期：2026-10-08。起始 HEAD：`4caedcb`；PR #23 合并提交：`4708a4b`。

结论：前台无扰的验收通过，脚本安全收尾已完成。真实 Windows 前后台焦点、原生 Oris/WebView2 与 Git 桥接的端到端 GUI 本轮未验证。以下三层证据各自记录，不把模拟焦点或模拟响应算作原生验收。

## 安全修复

- 开始验证前读取根 `AGENTS.md`，检查 `focus-task02-window.ps1`、全部六个 `task02-feedback-*.mjs` 和其共享禁用 guard，并搜索脚本调用链。
- 原生 helper 原本已直接抛错，没有可执行的窗口 API；保留拒绝旧 PID/标题参数的行为，补充安全验收入口提示。未重新启用任何窗口操作。
- `projects`、`smoke`、`stages`、`switch` 四个反馈入口虽然被 guard 挡住，仍残留按标题选首个 CDP 页面、连接 socket、修改夹具与页面存储的旧执行体。本轮彻底删除；六个入口现在都仅导入立即抛错的 guard。移除 guard 不再能够恢复这些旧执行体。
- `task02-safety.test.mjs` 检查入口只剩 guard、共享 guard 只剩拒绝，并实际运行全部六个入口及 PowerShell helper：即使传入 PID/`avatarOverlay` 标题或不存在的夹具，仍首先明确拒绝，不连接端口、不读取夹具、不调用窗口代码。
- 新的 headless 验收只创建自己的浏览器 context 和回环随机端口 Vite 服务，不启动原生 Oris EXE、不枚举或激活窗口、不修改前台、不连接已有用户浏览器/Oris。没有 `ShowWindow`、`SetForegroundWindow`、`AppActivate`、`Page.bringToFront` 或焦点恢复循环。

## 覆盖与本轮结果

| 场景 | App/jsdom（模拟外部桥） | headless 页面（模拟 Tauri/Git） | Rust（真实临时 Git 仓库） |
| --- | --- | --- | --- |
| 标题栏放弃修改 / 带着改动 / 取消 | 通过，请求参数及取消无二次请求 | 通过，实际按钮和确认框，请求参数及页面分支状态 | 放弃后目标内容、备份原文、stash 列表；带着改动后分支及冲突通过 |
| 历史页本地分支右键菜单的三种选择 | 新增三项通过，菜单关闭、目标及参数、取消无二次请求 | 三项通过，实际右键菜单→确认框→选择 | 与标题栏共用同一后端操作，后端无入口差异 |
| Escape 取消 | 新增历史菜单路径通过 | 两个入口均通过 | 无二次后端写请求 |
| 默认焦点为“取消” | DOM 焦点通过 | headless DOM 焦点通过 | 不涉及原生焦点 |
| 未跟踪文件会被覆盖 | 禁止带着改动及 discard/includeUntracked 参数通过 | 未覆盖这一扩展场景 | 放弃时备份未跟踪文件、切换后目标内容通过 |
| 已暂存改动限制 | 新增历史菜单禁用“带着改动”通过 | 未覆盖这一扩展场景 | merge 拒绝且仓库指纹不变通过 |
| 切换后阅读位置、历史菜单当前分支及远端分支 | 既有 App 回归通过 | 本轮仅测试本地分支冲突选择 | 既有分支/检出/远端跟踪回归通过 |
| 初始化失焦、自动刷新 blur/focus 边界 | 既有受控事件回归通过 | 原生查询固定模拟为 false | 未验证 Windows 焦点 |

执行命令及结果：

```powershell
node --test scripts/task02-safety.test.mjs
# 3 passed，0 skipped
# 同一入口已登记为 npm run test:gui-safety
npm run test:branch-switch
# 3 个文件，80 passed（含新增 5 项历史菜单测试）
cargo +stable-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --lib --no-default-features git::ops::branch_tests -- --test-threads=1
# 9 passed，0 failed，0 ignored；真实 Git，tempfile 仓库与备份
npm run build
# TypeScript/Vite 通过；保留现有大 chunk 提示

# 使用已安装的 playwright；本机从 Codex bundled runtime 读取，不新增产品依赖。
$env:ORIS_PLAYWRIGHT_MODULE = 'C:/Users/zhaowenlong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
npm run test:branch-switch-ui
# 8/8 passed，errors=[]，browser/vite cleaned=true
node --check scripts/perf/v2-03-acceptance.mjs
node --check scripts/verify-branch-switch-ui.mjs
git diff --check
```

首轮前端新增断言使用了不存在的 `.history-panel`，改为实际 `.log-layout` 后通过；headless 首两轮按 button 定位历史 tab/menuitem 超时，改为实际语义角色后 8/8 通过。失败轮次也已收尾。默认 GNU Rust 工具链因缺少 `dlltool.exe` 未完成构建，改用本机已有 MSVC 工具链后的上述测试通过；未改全局工具链设置。未发现需要修改产品分支切换逻辑的缺陷。

页面报告及截图：`artifacts/pr23-branch-switch/report.json` 和同目录八张截图。截图只辅助审阅；通过条件来自实际页面动作后的请求、目标分支、确认框关闭及异常断言。模拟 Tauri outcome 不证明真实 Git 执行；真实 Git 的证据由 Rust 测试独立提供，两者不是原生桥接端到端验收。

## 既有 CDP 验收脚本

`scripts/perf/v2-03-acceptance.mjs` 已新增标题栏/历史菜单各自的放弃、带着改动、取消路径：尚未选择及取消后比较完整仓库指纹；带着改动检查目标分支、真实 unmerged index 与冲突标记、stash 不变；放弃检查目标内容、找回命令指向的备份原文及 stash 不变。原有未跟踪文件和阅读位置回归保留。

本轮该原生 Oris/WebView2 脚本仅做语法及调用链检查，**未执行**，新断言不列为运行通过。不能通过启动普通共享桌面窗口来保证前台无扰，因此使用 headless 脚本作为本轮页面验收入口。以后运行原生脚本前仍须按 AGENTS.md 审查测试实例与清理边界。

## 原生焦点与资源收尾

当前没有能够保证不干扰用户桌面的隔离桌面/专用原生焦点测试环境，故真实 Windows 聚焦/失焦、前后台切换、用户切走后不抢回均未验证；不借用 Codex、ChatGPT 或其他应用制造失焦。CDP/浏览器协议的页面事件、DOM `activeElement` 及 jsdom 受控焦点桥均不属于这一验证。

每个 headless case 在 `finally` 关闭自身 context；正常和失败收尾均已运行，关闭自身浏览器和 Vite，任何清理失败会使报告失败。另有 SIGINT/SIGTERM 清理处理器，本轮未专项注入信号验证。最终报告两项 cleaned 均为 true，结束后只读查询确认没有本轮 headless runner 进程。Rust 的临时仓库/备份由 tempfile 生命周期释放。未启动原生 Oris、未结束或修改用户已有应用、未遗留覆盖窗口。仅保留构建缓存与报告/截图作为可复查产物。
