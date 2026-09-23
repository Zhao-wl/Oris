# 任务 02 用户反馈实施与验证

本文件记录 2026-09-23 的反馈修复，不修改任务验收状态，不替代总控覆盖。

后续“初始化不应受焦点门禁阻塞”的修复、独立构建和受控测试，见 [初始化焦点边界修复](task-02-initialization-focus-fix.md)。下文保留本轮早先产物及安全纠正历史。

**安全纠正 / 最终状态：产品代码已构建，最终 GUI 验收未完成。** 本轮焦点测试曾按 ChatGPT 进程/标题首匹配并显示、激活窗口，用户报告误激活隐藏 avatarOverlay、拦截交互。该操作不安全。相关工具及全部反馈 GUI 入口已经禁用，危险调用和临时生成器已经移除；未再操作任何非测试应用进行恢复。此前焦点数据不得作为验收通过依据，原始文件仅保留用于事故追踪。

## 版本与边界

- 工作目录 `D:\Projects\Research\Oris` 是真实 Git 仓库；HEAD 为 `3c1c2d1d25fb7e04a6fa3226fccab708042f5907`。
- 在既有任务 02 未提交改动上继续实现，不建 worktree、不切分支、不暂存、不提交、不推送。README 用户改动保留。
- 原 release SHA-256：`1F21FCA03BB23EC9B5E068F26AC8B6CFD28346E5322630C2C28C1DEDC2B216C8`。
- 本轮最终 release SHA-256：`41F43555E3F145DE047C9CA52DEC0980200463D828E6573B64BEBF6264A76CC6`，路径 `src-tauri/target/release/oris.exe`。
- Windows 本机测试；macOS 14+ Apple Silicon 无真实资源，未验证。

## 根因与实现

1. 平铺路径原先使用 CSS 尾部省略，遮住区分文件的尾部。现在按容器实际宽度测量前置省略，文本仍按自然顺序排列，不采用 RTL 反排；完整相对路径保留 title。窄侧栏优先文件名与状态，统计和旧路径在不足 260px 时收起；rename 行 title 仍同时提供旧、新路径。
2. 原 `read_content_pair_for_scope` 每次选择文件调用 `list_changes`，重复全仓 name-status、untracked、conflict、numstat 扫描。现在每仓库最多保留三范围的快照元数据；读取内容复用该快照，并在读取前后核对 HEAD/refs、index 和变化文件元数据。普通 files ref 存储直接读本地文件，reftable 保留 CLI 回退。读取不会写用户仓库。原内容 LRU 16 MiB/12 项仍保留，前端增加范围摘要缓存。
3. 原刷新无论 revision 是否变化都进入 `acceptSnapshot → selectFile`，清空 pair/document，卸载编辑器并重新计算 diff。原监听/定时器还依赖频繁变化的 callback。现在无变化核对不更新 diff，选中文件内容 ID 不变也不重新计算；稳定监听合并 300ms 事件、同一自动刷新只允许一个在途请求、合并补查。只有 visible 且 Tauri 原生窗口 isFocused/onFocusChanged 确认聚焦才启动自动 Git 工作；失焦停止前台定时器、监听仅累加 dirty generation、丢弃在途结果，不启动新的内容计算。回焦原生 focus/visibility 事件合并 150ms 后核对；前台补偿间隔 30 秒。用户在 3 秒内切回无新事件的范围/项目时复用已核对摘要，手动/回焦核对仍读取真实状态。外部修改、焦点和手动刷新仍读取真实状态。读取期间的刷新合并延后，仓库/内容请求 gate 继续丢弃过期结果。
4. 同文件有内容变化时，编辑器更新前记录两侧首个可见文本行、行内偏移和水平位置，更新后优先匹配原文本锚点，失效则夹到合法行。不主动跳首 hunk。无变化保持原编辑器实例。
5. 项目增加自定义显示名和独立拖动柄；名称空白回退仓库名，路径仍常驻且有 tooltip。v2 存储格式扩展可选 customName，读取原数组顺序即迁移，不丢已有记录/锚点。切换、最近访问、固定、刷新和重启均不再排序；新增追加，移除仅删除记录，拖动才重排。异步快照接受保留最新用户元信息。
6. 统一比较器用于平铺、过滤结果和前后导航：已有变化（修改/rename/type-change/冲突）→删除→新增/未跟踪；同组按完整路径稳定序数顺序。树保持目录层级、目录按名称排列，同目录文件使用此状态顺序，不打散整棵树。冲突仍有 U 状态和明确降级说明。

## 验证入口状态

- `node scripts/create-task02-feedback-fixture.mjs` 创建独立真实 Git 仓库：10,000 tracked 文件、100 个同时含 staged/unstaged 的变更文件，每个变更文件 1,800 行，包含中文、空格、# 和方括号路径。不是完整 S 历史数据集（没有 20,000 提交），用于本反馈的本地变更链路。
- `scripts/task02-feedback-*.mjs`：全部已禁用，不能直接复跑；普通入口导入 `task02-gui-disabled.mjs` 后立即抛错，焦点/中断专项直接抛错。不得移除禁用保护来复用旧测试方法。
- Git 阶段追踪使用进程环境 `GIT_TRACE2_PERF` 写忽略目录中的日志，未改仓库配置或 Git 全局配置。
- 编译命令作用域 PATH 补入 `D:/Tools/Rust/mingw-binutils/mingw64/bin` 后运行 `npm run tauri -- build --no-bundle`，未安装新工具链。

## 验证记录

真实夹具为 10,000 tracked 文件、100 个同时含 staged/unstaged 的文件，每个 1,800 行。下列为安全纠正前保存的历史测量，来自本机 release WebView2 和真实 Git；没有把 API 计时当成 GUI 计时。GUI 数据并非最终版本验收，最终复验尚未完成。

| 指标 | 原 release | 修复实测 | 样本/口径 |
| --- | ---: | ---: | --- |
| 内容读取 API P95 | 1017ms | 129.2ms | 各 30 次，直接 Tauri invoke；`stages-before.json` / `stages-after.json` |
| 未缓存切文件 GUI P95 | 1177ms | 436ms | 各 30 次；修复值为加入 diff-document 缓存前的原生焦点版 |
| 缓存切文件 GUI P95 | 166ms | 135ms | 各 30 次；同上 |
| 三范围切换 GUI P95 | 3210ms | 599ms | 各 30 次，三范围先预热；同上 |
| 大仓热切项目 GUI P95 | 尚待相同口径补测 | 143.3ms | 30 次，点击到两编辑器可读并经过两次 rAF；加入 diff-document 缓存版 |

以上中间版本数据保留为追踪证据，最终 release 回归结果和 hash 在下方单列。中间冷启动 API 样本曾达 7262ms，保存在 `stages-after-cold.json`；不将后续热样本推广为冷启动保证，也不宣称所有完整 Git 扫描均达到热切换速度。原实现普通未暂存内容读取需要 7 条 Git 命令，修复后需要 1 条；优化重点是消除重复全仓扫描。

diff-document 缓存与内容共用原 16MiB/12 项 LRU 预算，清仓或驱逐时一起释放；缓存命中直接发布对应的 pair/document，避免重复 Worker 和中间卸载。失焦打断内容读取时保留待补读标志，回焦即使 revision 未变也补读被打断的选中文件；正常完成后清除标志，不影响无变化实例保持。

历史测试方法：项目脚本使用 WebView drag 拦截/投递，曾验证独立拖动柄；中断专项曾延迟真实 Worker 派发 1800ms 以触发失焦打断。焦点及中断专项使用了不安全的窗口激活方法，结果撤回为验收证据。所有这些入口已禁用，不能复用。DOM/CDP 模拟焦点不证明 Windows 原生前后台状态。

自动测试：前端 24 passed；Rust 10 passed、2 个显式性能探针 ignored；release 构建通过，仅保留 Vite 大 chunk 提示。macOS、完整 S/L 历史数据集、用户 Unity 实际仓库未测。不存在 fetch 或远程操作。

最终产物构建成功，但热切换、完整工作区/阅读/滚动回归、重启持久化和真实原生失焦行为的最终版验收均未完成。此前 `projects-restored.json`、`workspace.json`、`reading.json` 是较早构建，不能记作最终版通过。最终构建曾完成中断专项，但因安全纠正撤回其焦点验收结论。

## 安全修正清单与剩余验证

- `scripts/focus-task02-window.ps1` 已彻底删除原生窗口 API、枚举首匹配及激活代码，只保留立即报错入口；传入 PID/标题也不会执行窗口操作。
- `task02-feedback-focus.mjs`、`task02-feedback-interrupted.mjs` 替换为立即报错入口；不再查找或操作 ChatGPT。
- `task02-feedback-smoke.mjs`、`projects.mjs`、`switch.mjs`、`stages.mjs` 删除启动和 wait/retry 中的激活调用、删除模拟焦点，并在连接 CDP 前统一禁用。
- 忽略目录中的旧测试副本、调试入口、能重新生成激活逻辑的脚本一并禁用，具体列表为 `artifacts/task-02-feedback/safety-disabled-artifacts.json`。
- 静态搜索确认上述范围无窗口激活调用或其他应用匹配残留；所有反馈脚本语法检查通过；实际调用禁用 Node/PowerShell 入口均立即以错误退出，没有连接 CDP 或调用窗口 API。
- 纠正后进程清单确认无本轮 GUI 测试、原生 helper 或 Oris 实例继续运行；没有终止用户已有应用，没有操作其他应用恢复窗口。未修改根 AGENTS.md。

后续真实焦点验证必须使用专用测试窗口或隔离桌面。仅允许操作本轮创建且以 PID、完整 exe 路径和已校验可见主窗口句柄准确识别的 Oris 实例，排除隐藏辅助窗；用户切走后不得抢回。当前未建立这种隔离验证条件，因此停止原生焦点验证并明确记为未验证。仅在通过独立安全审查后才能用新的测试实现替换禁用入口。

未暂存、未提交、未推送，HEAD 未变；README SHA-256 仍为 `FA98F8290AA748B92A4FDF9BBCDEED7A3070252D0B943640E271E8C534A9D6DB`。既有任务状态与其他 WIP 均保留。
