# 当前行提交信息验证

日期：2026-10-08。设计见 [当前行提交信息](../design/08-line-commit-info.md)。

## 验证范围

- 前端完整回归：`npm test -- --maxWorkers=4`，46 个文件、357 项测试。新增覆盖左右侧及统一视图删除内容的行映射、多行选择结束位置、重复选行高亮、详情读取、旧响应隔离、作者 / SHA 跳转、打开历史文件后返回来源。
- 前端生产构建：`npm run build`。保留 Vite 单包超过 500 kB 的构建提示。
- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features line_`（7 项）、`locate_history`（1 项）、`git::blame`（1 项）通过。真实临时 Git 仓库覆盖固定历史版本、本地快照归属、插入行与行号迁移、中文路径、重命名、未跟踪文件、真实变化片段、HEAD 过期和取消、跨第一页定位及作者搜索；前后比较仓库状态以确认查询不改写工作区、index 或提交。
- Windows desktop：PowerShell 执行 `cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- 无头 Edge：使用本轮单独创建的浏览器与模拟 Tauri IPC，操作实际 React / CodeMirror，覆盖选行及重复选行高亮、悬浮详情、作者 / SHA 跳转、返回来源、1280×850 与 900×650 的浮层边界，没有页面运行时异常。

无头界面夹具只验证界面与调用参数；Git 归属正确性的证据来自真实 Git 仓库测试。没有生成安装包、安装或执行真实桌面端到端测试。

## 后续可执行文件构建

用户要求生成可执行文件后，在 PowerShell 中运行 `npm run package`（默认 `--no-bundle`）。Release 编译通过；`verify_release_entry` 检查通过：`CUSTOM_PROTOCOL=true`、26 个嵌入资源、`index.html` 入口及引用的 JS/CSS、diff Worker 均存在。

- 产物：`src-tauri/target/release/oris.exe`，44,908,095 字节（42.8 MiB），生成时间 2026-10-08 17:38:31。
- SHA-256：`9B78EB74D9C99F6EEE91730856D3710D80471C0B50780F546780564E8A4B7D34`。
- PE 导入检查确认需要同目录的 `WebView2Loader.dll`，该文件已经存在；其余导入为 Windows 系统 DLL。

脚本在最后输出文件摘要时，因它使用的 Windows PowerShell 环境缺少 `Get-FileHash` 而返回非零状态；前面的编译和入口验证已经成功。随后使用当前 PowerShell 的 `Get-FileHash` 补做上述产物校验。未启动生成的 GUI 程序。

## Windows GUI 安全边界

验证前检查了 `scripts/focus-task02-window.ps1`、`scripts/task02-feedback-*.mjs` 及 `task02-gui-disabled.mjs`。原有原生激活脚本和其调用方已经直接抛错停止，没有实际 `ShowWindow`、`SetForegroundWindow` 或 `AppActivate` 调用；本轮无需修改这些脚本，也没有调用它们。

本轮仅创建无头浏览器，不枚举、显示、移动或激活任何其他应用窗口。浏览器在 `finally` 中关闭，临时 Vite 服务在验证后停止。没有启动可见 Oris 实例，没有操作 Codex、ChatGPT 或用户已有应用。

**真实 Windows 前后台焦点切换未验证**。DOM 行选择和无头浏览器交互不作为真实 Windows 焦点测试通过的证据。

## 当前边界

UTF-16、孤立 CR、冲突 stage 和非文本 / 降级内容有明确的不可查询提示；浅克隆标注历史可能不完整；变化预览使用第一个父节点。整文件 blame 与连续追溯更早修改不在本次范围。

## 四条界面反馈回归

2026-10-08，根据用户反馈调整鼠标附近 tip、变化文件自动 / 手动搜索、输入框内 × 清除和独立主题化行跳转。

- 前端完整回归 `npm test -- --maxWorkers=4`：46 个文件、363 项通过；增加鼠标锚点及进入详情后位置保持、600+ 文件过滤与 rename 原路径匹配、清除无需重读 Git、Ctrl+G 默认事件拦截、左右侧 / 统一行跳转、越界拒绝和目标折叠区段展开。
- 最后浮层调整后的 `DiffViewer.test.tsx` 17 项通过。行跳转面板改为 body 中的固定浮层，关闭时移除 dialog 角色，避免已隐藏面板影响应用 Esc 行为。
- 无头 Edge（模拟 IPC）：实际 React / CodeMirror 验证鼠标附近 tip、602 个变化文件自动过滤到来源文件及手动清除 / 搜索、提交搜索输入框内清除、Ctrl+G 按钮和 Enter 跳转、Ctrl+F 独立搜索且切换行跳转时清空高亮、深浅主题、1280×850 / 900×650 浮层边界。页面运行时异常为 0。较矮窗口原先遮挡行跳转按钮的问题在固定浮层改动后复测通过。
- 无头行跳转浮层实际配色：深色背景 `rgb(38,39,43)` / 前景 `rgb(188,190,196)`；浅色背景 `rgb(235,237,242)` / 前景 `rgb(37,39,45)`。

本轮未更改原生危险调用，仍检查到旧脚本直接抛错停止。仅操作本轮新建的无头浏览器，结束时关闭；未操作用户已有 Oris 或其他应用窗口。真实 Windows 焦点切换和真实 WebView 浏览器查找栏行为未执行桌面验证；快捷键拦截证据来自 DOM 的 `defaultPrevented` 与无头交互。

反馈修订版在当前 PowerShell 中直接执行 `scripts/build-release.ps1`，完整构建与文件摘要输出均成功（exit 0），避免上一轮旧 Windows PowerShell 环境的摘要命令问题。产物仍为 `src-tauri/target/release/oris.exe`（42.8 MiB），生成时间 2026-10-08 18:15:02；SHA-256：`B672710A288ECED3332F55C62B748152A8CA6FD62538CE9B51E9841771B27E7C`。`verify_release_entry` 再次通过，嵌入新 JS `index-OofhzTzA.js`、CSS `index-DWJfId5t.css` 与 diff Worker。没有启动生成的 GUI 程序；本轮 Vite 验证服务已停止。

## Tip 固定位置与搜索辨识度

根据后续反馈，tip 每次出现只定位一次；移过底栏、重新聚焦或点击触发元素、变化片段异步加载及复制提示均不再更新坐标。关闭后再次出现可以使用新的鼠标位置。内容增长受到剩余视口高度限制，并使用内部滚动。

变化文件搜索增加可点击的“搜索变化文件”标签、搜索图标、独立背景、主题色边框和 32px 输入框；匹配数量更清晰。

- `LineHistoryBar.test.tsx` 与 `App.history.test.tsx`：23 项通过，包括新加入的异步片段加载不移动用例。
- `npm run build` 通过。
- 无头 Edge 复测通过：tip 出现后移动鼠标时 x/y 相同；搜索标签可见；原有作者 / SHA 跳转、文件搜索、行跳转、深浅主题和浮层边界回归通过，页面异常为 0。
- 仅使用本轮创建的无头浏览器，结束后关闭，Vite 服务停止；危险脚本未修改或调用，仍保持禁用，未操作其他应用窗口，真实 Windows 焦点切换仍未验证。

原输出 exe 正被用户运行，构建脚本正确拒绝覆盖。新版改用独立输出目录 `artifacts/line-info-ui-20261008-1908`，保留用户已有实例。

独立构建成功（exit 0），产物 `artifacts/line-info-ui-20261008-1908/target/release/oris.exe`，42.8 MiB，生成时间 2026-10-08 19:11:19，SHA-256：`DA48EE485230562AFC3DA784D336730DEFB265BA8B2FDEEBC1B2092EB1DF41B7`。入口与 26 个嵌入资源验证通过，包含 JS `index-Ccp-TBhv.js`、CSS `index-DllZb4Sq.css` 和 diff Worker。
