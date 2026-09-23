# 普通 JSON 读取与错误提示修复

日期：2026-09-23。执行会话 `01a0cd01-3e4f-70d3-a066-e97cfa7e9e43`；父会话 `01a0c6f9-8a2d-7432-aaac-0d1e3bb20ea2`。本次仅处理普通文本读取/报错/显式刷新问题，不新增 JSON 语义 diff，不调整其他任务验收状态。

## 现象与可复现证据

用户截图显示选中 `artifacts/task-03/build/debug/.fingerprint/block-buffer-6d3323bfb37c0008/lib-block_buffer.json`，正文为“无法显示差异 / 操作失败”。

只读核实：该路径确实存在，424 字节，是合法 UTF-8 JSON，Git 状态为未跟踪。原文件 SHA256 为 `482400CEF5B3C5157B3FA118CEC1FB09F2315149085F0AD715ECF75596053D9D`。没有删除、忽略或修改这个文件。

使用修复前的产品 GitAdapter 对本项目执行完整 snapshot→该路径 read 的无窗口探针，结果通过：右侧 `utf-8` 且内容逐字节等于原文件，左侧 `missing`；说明不存在“JSON 后缀不受支持”或该深层路径不能读取的问题。当前仓库有约 5,590 个未跟踪文件，完整探针耗时 68.73 s；这是当前真实工作区扫描成本，不当作 JSON 解码成本或已解决的性能问题。日志：`artifacts/task-03-json-fix/runtime/live-reported-file-before-backend-fix.log`。

确定复现的根因：

1. 真实临时 Git 仓库放入同样深层路径的 JSON，先正常读取；只修改另一个已在快照中的文件、保持 JSON 本身字节不变，再用旧 revision 读取，返回 `GitError::StaleRequest`。其旧 serde 输出为 `{"kind":"staleRequest"}`，没有 `message`。前端 `errorText` 只读取字符串 message，最终落到“操作失败”。修复前 Rust 断言明确失败，日志 `before-fix.log`。
2. 前端受控链路注入相同真实错误形状，复现与截图相同的“操作失败”。读取失败后若手动刷新的 revision 未变，旧流程只刷新列表、不再次读取文件；若 revision 变化并再次读取失败，刷新末尾的 `setError(null)` 又抹掉该错误。三条修复前测试失败，日志 `frontend-before-fix.log`。

截图没有保留当时 IPC 返回值，不能追溯当时具体哪个写入/请求导致失效，也不能排除其他同样缺少 message 的错误变体；本报告不把“当时一定正在构建”当作已证事实。已确认的是正常原 JSON 可读，且上述错误传递和刷新缺陷可独立稳定复现。

## 修复范围

- `src-tauri/src/git.rs`：GitError 的所有 unit/tuple/struct 变体统一序列化为稳定的 `{kind, message: Display文本}`。保留 revision/安全边界/取消检查，不强行接受过期内容。
- `src/error-message.ts`：优先显示具体 message，兼容旧版 kind-only 错误和旧版 UnsupportedGit 结构；未知 kind 仍显示错误种类，不再无信息地退成“操作失败”。
- `src/App.tsx`：手动本地刷新会重新尝试当前文件，revision 相同也可重试；真实读取错误不会被刷新收尾或未变化的自动列表检查清掉。自动刷新仍遵守既有 focus+visible 门禁，没有引入自动读取重试循环。
- JSON 仍沿用普通 UTF-8 文本阅读器、原有全文预算、缺失端点单栏和三范围定义。没有新增格式路由或 JSON 专用渲染。
- 测试新增于 `git/json_regression_tests.rs`、`error-message.test.ts`、既有 `App.initialization.test.tsx`。`serde_json` 仅新增为 dev-dependency，以断言真实 IPC 序列化形状。

后端回归覆盖同样深层路径的未跟踪/新增 JSON、HEAD→Index / Index→WT / HEAD→WT 的实际内容、中文 JSON、原文件不变而旁文件变化、显式刷新后恢复、文件消失后旧快照拒绝与刷新后的删除侧。前端回归覆盖错误解释、同 revision 显式重读、重复失败仍可见、未变自动核对不清除读取错误。

## 工作区与安全边界

本轮开始 HEAD 为 `12444f61e11b494e5f05404641f4507b2b2ac4a1`。已有任务03、滚动/构建脚本及 V2 文档等 WIP 全部保留，没有 stage/commit/push/reset/unstage。未修改任务验收状态。

执行中发现他方并行修改 `src-tauri/src/git/media.rs`（LFS相关新增）存在字面换行字符语法错误，一次完整后端编译因此失败；已向总控报告协调。随后再次核对时错误已由他方修正为 `strip_suffix('\n')?.split('\n')`，文件修改时间15:36:59、SHA256 `49B02735052BF4CA0AE64F560C77FF9DA9AE32864EA19DE80C4FD57050D19805`。本任务没有修改、回退或格式化该文件；共享源码另包括他方新增的 `ChangeFilter` 与 watcher 批处理（git.rs/lib.rs）。最终产物包含这些他方修改，不把LFS/watcher功能归属到本JSON修复。

在完整后端回归中，他方新增 `change_filter_skips_ignored_and_object_writes` 失败；只读诊断复现：`GIT_LITERAL_PATHSPECS=1` 下执行 `git check-ignore -- dist/index.html` 返回 `pathspec magic not supported by this command: literal`。已上报总控协调，总控明确要求本轮不修改他方filter语义、不删除或弱化断言；该失败保留。影响为本应忽略的工作区写入可能被当成相关变化，产生额外刷新/失效通知；不把它描述成JSON格式不支持。

遵守 AGENTS：没有启动 GUI、没有调用窗口激活/抢焦点 API，没有重新启用危险脚本，也没有操作或终止用户应用。测试仅使用无窗口 Git/Rust 与 jsdom；真实 WebView2/WKWebView、原生焦点未测。临时 Git 夹具由 tempfile 清理，真实项目和原截图文件只读访问。

## 最终验证与独立版本

前端完整回归 **79 passed / 11 files**，TypeScript/Vite生产构建通过；保留Vite已有大chunk提示。定向后端测试已通过 **3项**（实际文件探针另行显式运行通过）。完整 Rust 回归为 **24 passed / 1 failed / 5 ignored**，215.99 s。唯一失败为 `git::media::tests::change_filter_skips_ignored_and_object_writes`，`media.rs:684` 断言 `!filter.relevant(&ignored)`；原因和影响见上文。5个显式探针本轮完整套件默认跳过，其中原文件只读探针已单独运行，其他旧性能/大图探针不重复宣称本轮执行。JSON新增测试在完整回归中全部通过；**当前整合版不称为全部回归通过**。所有新日志位于 `artifacts/task-03-json-fix/runtime/`。新构建目录为 `artifacts/task-03-json-fix/target`，不覆盖此前交付或用户正在运行的 EXE。


独立release构建成功（8m 05s），没有启动窗口：

- EXE绝对路径：`D:/Projects/Research/Oris/artifacts/task-03-json-fix/target/release/oris.exe`
- EXE SHA256：`D2889D9C8BDFE3779543A6B5E2CAD5FE22A9A57A541CA8D7EA9C87CE32177A49`
- 大小：29,234,141字节；生成时间2026-09-23 15:44:37（本机时间）。
- HEAD仍为 `12444f61e11b494e5f05404641f4507b2b2ac4a1`，未提交。
- 39个前后端源码/依赖文件在本轮构建进行中、结束前和结束后核对，哈希无变化；源码清单 `artifacts/task-03-json-fix/SHA256SUMS.txt`，清单本身SHA256 `1A27DA09C36A43F98CB39E2412FA2268DAB4D9683D8A2D4A07E32E4C0DD4DFF7`。本清单对应当前共享基线，包括他方LFS/watcher/既有滚动等实现，不把这些内容归属到JSON修复。
- 原交付EXE仍为 `11482EC65B986EA3D7F3D2EEA19E9EED8F5589798ED27EF994F8CDA079CCFB9B`，没有覆盖。
- 截图JSON仍为 `482400CEF5B3C5157B3FA118CEC1FB09F2315149085F0AD715ECF75596053D9D`，没有修改或通过ignore隐藏。

本问题修复交付完成：普通JSON真实链路可读，错误有具体原因，手动刷新能重读且保留重复失败信息。整合版已知watcher回归仍在，交总控另行处理。仅进行非GUI验证；真实WebView2/WKWebView、焦点/watcher真机行为未测。其他任务验收状态未改，全部并行WIP保留。

## 总控定向基础覆盖检查

2026-09-23，内部 `task03_coverage` 定向基础覆盖检查通过：JSON 错误传递与手动刷新修复未发现明确遗漏；已核对交付 EXE SHA256 `D2889D9C8BDFE3779543A6B5E2CAD5FE22A9A57A541CA8D7EA9C87CE32177A49`。本次检查只读、未重跑测试，不是技术深审。

证据边界保持：截图当时的具体失效触发仍未确定；68.73 s 是完整 snapshot→read 探针耗时，不是 JSON 解码耗时；完整 Rust 回归仍为 24 passed / 1 failed / 5 ignored，共享 watcher 过滤回归继续保留，不宣称整合版全部通过。真实 WebView2/WKWebView、原生焦点及 watcher 行为未测。

本次仅追加本报告，没有修改源码、manifest、EXE 或他方 filter，没有重测或提交，也不改变任务 03 的整体验收状态。
