# 任务 01 补充：合并差异轨道与纯新增/删除单栏

日期：2026-09-23。状态：源码、纯逻辑测试、TypeScript/Vite 与隔离 release 构建通过；未执行 Windows 原生 GUI 交互验收。

内部覆盖结论（总控确认）：原“单文件模式仍提供不可用布局选项”的唯一基础覆盖缺口已关闭；源码与既有自动测试的基础覆盖通过。本结论不替代 GUI 验收，下列技术记录与未测边界保持不变。

## 交付范围

- split 左右外缘各保留一条 24px 轨道（原滚动条列与差异色标列的总宽度），移除独立传统 thumb DOM 和中间分隔线。
- 同一轨道叠加逻辑 viewport band 与蓝/绿/灰差异 marker。band 为半透明描边，marker 位于其上，窗口区域与变化色块可同时辨认。
- viewport band 可拖动；点击轨道按逻辑行定位；marker 仍可点击导航；轨道保留 Home/End/PageUp/PageDown/ArrowUp/ArrowDown 和 ARIA scrollbar。左右 master/epoch 同步、Align、逻辑行 marker/viewport 投影保持原路径。
- 纯新增/未跟踪文件只显示右侧实际版本的全宽绿色单编辑器；纯删除文件只显示左侧实际版本的全宽灰色单编辑器。没有空白另一侧、56px 中间连接区或连接带。
- 单栏保留行号、应用内搜索、选择/复制、主题、自动换行、字号和合并轨道。布局、高亮粒度、折叠上下文及 Align 在纯模式禁用；标题只显示实际存在的端点及其编码/EOL。
- 空新增/空删除显示“0 字节”明确状态。判定只消费 `FileChange.status`、端点 `encoding: missing` 与实际侧字节数，不读取文本是否为空；已有文件清空、空文件写入内容、rename/conflict/type-change 均继续普通比较视图。

`src/App.tsx` 仅增加 `resolveDiffPresentation` 调用、向 `DiffViewer` 传递呈现结果，以及纯模式下的控件禁用/实际端点标题。未修改初始化、焦点、请求门禁、项目切换或缓存实现。

## 自动验证

- 首轮 `npm test`：7 个测试文件、46 项通过。其中 `diff-presentation.test.ts` 覆盖 added/untracked/deleted、空新增/空删除、已有文件清空、空文件写入、rename/conflict/type-change；`diff-scroll.test.ts` 覆盖合并轨道 viewport 的顶部/中部/底部逻辑行映射与零行 marker。覆盖复查后增加布局选项契约，定向执行 `npm test -- src/diff-presentation.test.ts`，1 个文件 10 项通过：普通比较仅提供 split/unified，纯文件仅提供 single。
- `npx tsc -b --pretty false`：通过。
- `npm run build`：通过（保留 Vite 既有大 chunk 警告）。
- `node --check scripts/task01-scroll-smoke.mjs` 与 `task01-reading-smoke.mjs`：通过；脚本断言已更新为无传统 thumb、marker/band 同轨，以及纯新增/删除单栏结构。
- 隔离构建命令：设置 `CARGO_TARGET_DIR=artifacts/task-02-feedback/initialization-build` 后执行 `npm run tauri -- build --no-bundle`，通过。覆盖复查最小修正后再次构建，产物：`artifacts/task-02-feedback/initialization-build/release/oris.exe`，SHA-256 `c51db7419fe98efa1a1a0b2a43a5a4e8b8f24f99b344206c07bff3a5fb6e0360`。
- 原 `src-tauri/target/release/oris.exe` 未覆盖，SHA-256 仍为 `41f43555e3f145de047c9ca52dec0980200463d828e6573b64bebf6264a76cc6`。

## 未验证与安全边界

本轮没有启动 Oris 或执行 CDP/原生窗口自动化，没有调用被禁用的抢焦点脚本，也没有显示、隐藏、激活或结束任何用户应用窗口。因而未声称真实 Windows 鼠标拖动、轨道点击、marker 点击、主题视觉或真实前后台焦点已通过；更新后的 GUI smoke 脚本只完成语法检查，须在专用测试窗口或隔离桌面中另行执行。macOS 真机门禁保持不变。
