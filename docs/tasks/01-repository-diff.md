# 01 — 真实仓库文本 Diff 与双平台选型验证

状态：Blocked（Windows 双独立滚动与外缘双列轨道已实施并通过本轮基础覆盖；等待 macOS 14+ Apple Silicon/WKWebView 真机验证）。依赖：无。输出供 02 使用，门禁未解除。

## 用户闭环

作为用户，我能在 Win11 和 M1 Mac 上打开已有仓库，选择真实变化文件，并在已确认的 JetBrains 风格界面中阅读其双端差异。

## 范围

- 建立 Tauri 2/Rust/React/TypeScript 最小可运行应用及双平台构建入口，锁定实际采用的依赖版本。
- 系统 Git 自动发现/手动指定/缺失错误；确定最低 Git 版本或必需能力探测策略并写入运行说明。
- 建立受限 GitAdapter、类型化业务 IPC、RepoId/Endpoint/ContentPair/DiffDocument 契约；只做当前闭环所需内容。
- 打开单一真实仓库，列出 tracked 未暂存变更，读取 Index/WorkingTree，显示文件树与 diff。
- CodeMirror 验证：并排/统一、词级高亮、中央连接带、折叠、同步滚动、换行、选择复制、字号变化；记录使用公共 API/扩展点的方法与限制。
- 当前可见区域支持文件侧栏/Diff 主区、左右并排 Diff 的拖动分隔；保持合理最小宽度、窗口缩放比例和标题/内容同步。暂不创建 Git Log 区域或设置持久化体系。
- 建立后台读取/计算与过期结果隔离；固定首批性能预算和内容降级上限。
- 只读边界验证：禁外部 diff/textconv/fsmonitor 等普通浏览外部执行入口；前后核对仓库状态。

## 不包含

多项目完整管理、全部本地状态、历史/分支/图片/fetch、正式签名发布；不能因此缩减后继任务中的 V1 功能。

## 验收

- [x] A01（Windows）：真实 Git 夹具中打开 → 文件选择 → 正确左右内容 → hunk 导航，前后无仓库写入；macOS 平台侧仍待验证。
- [ ] A06 基础：Windows 几何、拖动、比例、复制、56px 可见连接区、对齐开关、双侧 hunk 映射同步、零行细线及两侧“滚动条 + 差异色标”双列轨道已通过专项与本轮基础覆盖；macOS 平台侧仍待验证。
- [x] 用户授权阅读切片（Windows 基础需求覆盖）：已实现高对比真实选区、选中同词、应用内大小写/全字/正则搜索及 marker 槽逻辑 viewport band，并完成专项执行会话验证和内部定向复查；复查未重跑测试或新增代码审核，不替代任务 04 完整验收或 macOS 门禁。
- [x] A13 基础（Windows）：无害 external diff、fsmonitor、textconv 标记均未触发；不修改 safe.directory，不拼接 shell；macOS 平台侧仍待验证。
- [ ] Win11 WebView2 和 macOS 14+ M1 WKWebView 各自真实运行；浏览器截图不替代 Tauri 实机。
- [x] Windows S 场景首轮核心测量与 L 压力探测已记录预算、线程位置、时延/内存及边界；范围不含 IPC/Worker/CodeMirror/首屏，不宣称全 V1 或端到端性能通过。
- [ ] 输出双平台最终 diff 选型结论：Windows 基础实现可锁定；须等待 macOS 真机验证后才能最终锁定或提出替代决策，不能自行降低视觉要求或改主技术栈。

## 交付

可运行纵向原型、必要测试/夹具、双平台启动说明、Git 兼容基线、diff 技术决策与测量记录。当前唯一恢复条件是取得 macOS 14+ Apple Silicon 真机，在 Tauri/WKWebView 中完成平台侧 A01、A06、A13 与启动路径验证。此前任务保持 Blocked，不标 Done，也不释放 02。
