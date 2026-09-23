# 一期任务 03 开发收尾记录

日期：2026-09-23。核验源码基线：`f9a92dca525c9b34cc5c9351a03d4094e8c512ef`；任务 03 图片与冲突实现已在 `2211753` 提交。此次收尾只更新交付记录与文档入口，不改产品代码或验收标准。

## 本轮核验

| 项目 | 结果 | 证据边界 |
| --- | --- | --- |
| 前端回归 | `npx vitest run --maxWorkers=1 --no-file-parallelism`：11 文件、82 项通过 | jsdom/组件与逻辑测试，不是 WebView2 画面验证 |
| 前端生产构建 | `npm run build` 通过 | Vite 保留已有大 chunk 提示 |
| 后端回归 | `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib`：30 通过、0 失败、5 忽略 | 含真实临时 Git 的图片、冲突、只读与刷新用例；忽略项本轮未重跑 |
| 当前源码 release | `scripts/build-release.ps1 -OutputRoot D:/Projects/Research/Oris-builds/task03-close` 通过 | 独立目录构建，无 GUI 启动；使用当前提交源码而非旧产物 |
| 生产入口 | 同一编译上下文的 `verify_release_entry` 通过：`Directory`、custom protocol、`App(index.html)`、内嵌 index/JS/CSS/Worker 均可读取 | 无窗口资源探针，不等于 WebView2 执行 JS 或绘制图片 |

首次并行执行 `npm test` 时，8 文件的 42 项通过，但另外 3 个 Vitest fork worker 启动超时，命令退出 1；该次不计全量通过。待高负载编译结束后，以上述单 worker 命令完整重跑并通过 82 项。后端本轮完整回归此前已知的 ignored-path 过滤断言也通过。

旧 `task03-entry-fix` release 的源码清单与当前 `src/DiffViewer.tsx`、`src/styles.css` 不一致，因此本轮没有沿用其 EXE 作为当前版本。新产物为 `D:/Projects/Research/Oris-builds/task03-close/target/release/oris.exe`，SHA-256 `F2E550D11EBDAFBA3B37BD18D00D2C3DD72D76DB21AA5CA05F9D3F5AE1709D38`；同目录 `WebView2Loader.dll` SHA-256 `8427B1FC58EC707813E5C0A51EB5D69397BB333250A7B891BE4D3B123F1E0F1C`。分发该 GNU 构建时两文件须同目录。构建后工作树的产品源码无改动。

## GUI 安全与验收状态

GUI 验证前复查了 `scripts/focus-task02-window.ps1` 及 `scripts/task02-feedback-*.mjs` 调用方。原生焦点脚本直接抛错，焦点专项入口保持禁用；本轮**没有修改危险调用**，也没有运行这些 GUI 脚本。没有启动或激活 Oris 窗口，没有调用 `ShowWindow`、`SetForegroundWindow` 或 `AppActivate`，没有选择或操作 Codex、ChatGPT 及其他应用窗口。无窗口构建/测试未创建覆盖窗口；没有用户应用进程被结束。

任务 03 的 A/B 源码交付及非 GUI 回归收尾完成，**整体仍为 Blocked／待平台验收**。Windows WebView2 实际图片显示、滑动/缩放/透明与方向渲染、真实 Windows 焦点和 watcher 联动、30 次 GUI 混合切换与全进程树内存均未在隔离环境验证；macOS 14+ Apple Silicon/WKWebView 未运行。DOM/jsdom、无窗口入口探针和文件系统测试不代替真实 Windows 焦点测试。任务 03 的完成勾选与 04–06 后继门禁保持原状，待真实平台证据补齐后再验收。

此前 A/B 逐项实现证据与预算见[图片和冲突报告](task-03-image-conflict-evidence.md)，大仓持续刷新见[过期修复报告](task-03-stale-refresh-fix.md)，普通 JSON 错误传递见[JSON 报告](task-03-json-read-fix.md)，旧入口配置回归见[入口修复报告](task-03-release-entry-fix.md)。
