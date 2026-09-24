你在 Oris 项目（D:\Projects\Research\Oris，Tauri 2 + Rust + React/TS 的 Git 差异阅读桌面应用，远端 origin = github.com:Zhao-wl/Oris.git）中执行一个长链路任务：按顺序完成下面 5 个阶段。始终用中文回答、写文档和写提交信息。尽量连续执行到底，只在下面“需要停下来问用户”列出的情况才停。

====================
一、开始前必做
====================
1. 通读：AGENTS.md（GUI 安全约束，必须遵守）；docs/README.md；docs/decisions/v2-decisions.md（重点 V2-D08、V2-D09、V2-D15、V2-D16、V2-D19–V2-D27，以及“待用户决定”中的 P-V2-05–P-V2-07）；docs/specs/v2-product.md；docs/architecture/v2-architecture.md；docs/validation/v1-acceptance.md 与 docs/validation/v2-acceptance.md；docs/tasks/README.md 与 docs/tasks/v2/README.md；各阶段指定的任务文档。
2. 在 artifacts/long-chain/progress.md 建一份进度日志（artifacts/ 已被 gitignore），每完成一个里程碑就写入：分支、提交号、完成项、未完成项、下一步。上下文被压缩或中断后，先读这份日志再继续。
3. 【只问一次】向用户说明：阶段 1 和阶段 2 末尾需要在本机启动 Oris 测试实例（会出现新窗口，通过 CDP 驱动，不抢焦点、不操作其他应用窗口），每次大约持续多久；请用户对本会话内的这些启动给出一次性同意。
   - 同意：阶段 1、2 中的 GUI 部分照常执行；
   - 不同意或没有回应：跳过所有 GUI 测量，相关项记为“未运行”，其余工作继续。

====================
二、通用规则
====================
- 分支：每个阶段从最新的 main 创建分支（git switch -c <分支名>），按里程碑提交。阶段验证全部通过后，用 git merge --no-ff 合入 main，然后 git push origin main（用户已授权推送 main）。阶段未通过就不合并，把分支推到 origin 保留，并在进度日志与最终报告中说明，然后继续不依赖它的后续阶段。
- 工具链：Rust 为 GNU 工具链。执行 cargo 前把 D:\Tools\Rust\mingw-binutils\mingw64\bin 加入当前进程的 PATH（参考 scripts/build-release.ps1），不修改系统环境。
  - 后端测试：cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib
  - 前端测试：npx vitest run --maxWorkers=1 --no-file-parallelism
  - 构建：npm run build；release：scripts/build-release.ps1 -OutputRoot <仓库外的独立目录>
  - 当前 main 基线：后端 41 项通过（5 项忽略），前端 82 项通过，配色脚本 5 项通过。每个阶段结束时不能少于这个数。
- GUI：严格按 AGENTS.md 执行。
  - 先审查 scripts/focus-task02-window.ps1 与 scripts/task02-feedback-*.mjs 的危险调用；
  - 只操作本轮启动、并且同时核验了 PID、可执行文件完整路径、主窗口句柄的 Oris 测试实例；
  - 禁止调用 SetForegroundWindow、ShowWindow、AppActivate；不碰 Codex、ChatGPT 等任何其他应用的窗口；
  - 优先用 CDP（通过 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 开启 remote-debugging-port，在页面内派发 DOM 事件并读取 performance 时间点）；
  - 报告中必须区分“CDP / DOM 模拟”与“真实 Windows 焦点”，前者不能当作后者的证据；
  - 结束时清理本轮的测试实例、profile 和临时目录，不结束用户已有的应用。
- 测试数据只放在仓库之外的临时目录，例如 %TEMP%\oris-perf\ 或 %TEMP%\oris-gui\。数据集用 scripts/perf/generate-datasets.mjs 生成。
- 不自己做产品决策：P-V2-05（diff 颜色语义）、P-V2-06（移植范围）、P-V2-07（默认配色）保持待定；需要用到时两种实现都做，或者做成可配置。
- 如实报告：不降低预算，不跳过验收，不伪造或挑选数据；没有测的写“未测”。
- 文档：每个阶段结束时更新相应任务文档的状态行、docs/tasks/v2/README.md 或 docs/tasks/README.md 的状态列，以及验证报告。可以把实现中形成的事实写入技术方案；但新的产品决策不写成“已确认”，只能列为待用户决定。

====================
三、阶段
====================

【阶段 1】界面验证批次与一期性能基线（分支 wip/gui-batch）
目的：补齐一期任务 03 缺失的 Windows WebView2 界面证据；在尚未包含 V2-01 改动的版本上测一期基线；留下阶段 2 要复用的测量脚本。
1. 先从当前 main（90ecf47 或之后的纯文档提交）构建 release 到 D:\Projects\Research\Oris-builds\v1-baseline，记录 exe 与 WebView2Loader.dll 的 SHA-256。基线必须用这个构建测，之后不能用 V2-01 的代码替代。本阶段不修改 src/、src-tauri/src/。
2. 新增 scripts/perf/gui-probe.*：覆盖 V2 验收 §3 中不涉及写操作的各行（首次打开、热项目切换、后台 dirty 项目切回、切换显示区域、已缓存 / 未缓存文件切换、外部变化到界面更新），以及 §4 的内存行（5 项目热切换稳态、200 次混合切换的增长趋势，统计整个进程树，包括 WebView2 与 git 子进程）。每项至少 30 次，报告 P50 / P95 与原始数据；记录机器、Git、WebView2 版本；无法做到真正冷 OS 缓存时如实说明。一期没有的能力标为“无此功能”。
3. 任务 03 的 Windows 界面证据（依据 docs/tasks/03-image-conflict-diff.md 与 docs/validation/task-03-closeout.md）：真实 WebView2 中的图片并排 / 滑动 / 缩放 / 透明 / 不同尺寸与方向、坏图降级；冲突版本选择；图片 / 文本 / 冲突混合切换 30 次的时延与整个进程树内存。
4. 交付 docs/validation/task-03-windows-gui.md、docs/validation/v2-baseline-v1.md。按结果更新任务 03 的状态：Windows 界面证据齐全时改为“Windows 基础通过，macOS 待验证”；不齐全就如实保留原状态。

【阶段 2】V2-01 数据层与流畅度基础（分支 feat/v2-01）
依据：docs/tasks/v2/01-data-layer-performance.md、技术方案 §1–§5 与 §7、验收 B01–B04、B17、B18、docs/validation/v2-01-git-level-probe.md，以及已合入 main 但尚未接入的 src-tauri/src/git/status_v2.rs 与 object_reader.rs。可以新增 notify-debouncer-full、ignore 两个 crate；其他新依赖要在报告中说明理由。不做任何写操作功能，也不做设置和配色（那是 V2-06）。
- M1 StatusScanner 接入：
  - 用 status_v2 替换 list_changes；新的仓库级 revision 由三个范围共享；切换范围在前端过滤，不启动 Git 进程；
  - “全部”范围懒执行 rename 修正，按 revision 缓存；
  - 增删统计后台补齐，统计未到之前显示占位，不能显示为 0，文件列表不等待统计；
  - branch 与 ahead/behind 取自 status 头信息；inProgress 进入快照；
  - 验收 B01：补齐仅工作区 rename、空 HEAD、特殊字符与非 UTF-8 路径的专门夹具。
- M2 ContentReader 接入：
  - HEAD / index 两侧按 OID 通过 object_reader 读取，工作区直接读文件系统，contentId 基于内容；
  - 去掉全局 READ_SERIAL，改为每仓库队列（工作区读取并发 ≤ 2）与每仓库 generation 取消；
  - 冲突 stage 按 OID 读取；大内容改为二进制 IPC；
  - 验收 B02，并证明任务 03 的图片与冲突行为没有回退。
- M3 前端：
  - DiffCache 按 (leftContentId, rightContentId, 阅读选项) 建键，不再因 revision 变化整仓清空；
  - 按项目拆分状态 store（基于 useSyncExternalStore 的小型 store，不引入状态管理库）；
  - 切换文件时复用编辑器，只替换文档与装饰（兼容 V1 D15 的双 EditorView），阅读位置不丢；
  - 空闲时预取上下相邻的 ≤ 256 KiB 文本；连续切换时 80 ms 延迟发请求并取消过期请求；文件超过 500 项时启用虚拟列表。
- M4 Watcher：
  - 后端合并事件（约 200 ms），按 gitignore 过滤，按技术方案 §5.4 分类下发；
  - 后台项目只标记 dirty；watcher 最多保留 5 个项目（LRU）；
  - 验收 B04。
- M5 快照恢复与 stat 缓存：
  - 轻量快照持久化（版本化，有大小上限）；启动时先显示快照并标“校验中”，校验完成后只替换有差异的部分；
  - 提供“校验完成前禁止写操作”的状态标志，供 V2-02 使用；
  - 只在手动刷新时执行一次允许回写 index 的 status，并跳过它引起的 watcher 事件；
  - 验收 B03、B17。
- M6 验证：
  - 全部测试；B17 / B18 只读与安全回归；资源上限（常驻 cat-file ≤ 5 个且空闲回收、BlobCache 32 MiB、快照上限）用测试断言；
  - V1 A01–A05、A11–A13 回归；release 构建；
  - 已获 GUI 同意时，用阶段 1 的脚本在同一台机器上测本分支，与一期基线对照 V2 §3–§4。达标后任务标 Done；未测或未达标时标 Awaiting acceptance / Blocked，并写明原因。
- 交付 docs/validation/v2-01-results.md：逐项结果、证据路径、性能对比表、与技术方案不一致的地方及原因。

【阶段 3】V2-06 预制模块：设置存储与配色运行时（分支 wip/v2-06-core）
依据：docs/tasks/v2/06-settings-appearance.md、R-SETTINGS / R-APPEARANCE、技术方案 §9、docs/design/05-settings-ui.md、src/themes/generated/ 的数据格式与 REPORT.md。本阶段只新增模块和测试，不接入界面：不改 App.tsx、DiffViewer.tsx、styles.css、index.html，不新增 npm 依赖。完整的 V2-06 要等用户决定 P-V2-05–P-V2-07 后再开工。
1. src/settings：
   - 带版本号的设置模型：appearance（themeMode 为 light / dark / system，lightScheme、darkScheme、fontSize 11–18，diffColorMode 预留 oris / vscode）与 git（executable）；
   - 分类注册表（键、类型、默认值、校验、界面元数据），新增分类不需要改框架；
   - 读写与迁移：迁移“最近一次成功打开的项目所用的非空 Git 路径”；数据损坏或版本不兼容时回退默认值并返回提示标志，不影响项目列表；
   - 订阅机制复用阶段 2 的 store（阶段 2 未合入时，自带一个接口兼容 useSyncExternalStore 的小型 store）。
2. src/themes/runtime.ts：
   - 按 id 懒加载方案数据；把方案应用为 CSS 变量，高对比方案额外加类名；
   - 构造 CodeMirror HighlightStyle 与编辑器主题扩展，提供可放进 Compartment、支持 reconfigure 的接口；
   - 按 diffColorMode 选择两组 diff 颜色；跟随系统时监听 prefers-color-scheme，并预加载另一套方案；
   - 提供首屏无闪烁用的同步应用函数，以及它需要的最小数据。
3. 测试：迁移与损坏回退、校验、订阅通知、CSS 变量应用、高对比类名、diff 两组颜色、跟随系统切换（jsdom 模拟 matchMedia）、HighlightStyle 构造。
4. 在任务 V2-06 文档中记录“预制模块已完成”，并列出接入时需要改动的位置。

【阶段 4】一期任务 04 预制模块：提交历史、分支与提交图（分支 wip/v1-04-core）
依据：docs/tasks/04-history-branches.md、V1 规格的 R-HISTORY / R-BRANCH / R-COMPARE / R-FILEHISTORY、V1 验收 A07–A09、docs/design/04-mixed-release-ui-reference.md 中的日志区设计。只新增模块和测试，不接入界面；Git 读取沿用只读通道，能复用阶段 2 的数据层就复用。
1. src-tauri/src/git/log.rs：
   - 分页读取提交（-z，含 parents、作者、提交者、时间、消息、refs 装饰），用游标保证分批加载时已显示提交的身份不变；
   - 按作者 / 消息 / SHA 搜索，按分支筛选；
   - 根提交相对空树的变化文件；合并提交可以选择父节点；
   - 单文件历史，结果中标注 rename 跟随的边界；
   - 两个端点比较：先把 ref 解析为 OID 并固定。
2. src-tauri/src/git/refs.rs：本地分支、远端跟踪分支、上游、当前工作分支；ahead / behind 按真实可达性计算；区分无上游、上游已消失、未知，不能用 0/0 代替。
3. src/history-graph.ts：按真实 parents 计算泳道布局；分页边缘未加载的关系要有延续标记；不能用页面行号推断拓扑。
4. 测试（真实临时仓库）：线性、分叉、merge、根提交、分页边缘；无上游、上游已消失、领先、落后、分叉；rename 历史边界；读取前后工作区、index、refs 不变。
5. 在任务 04 文档中记录“预制模块已完成”，并列出接入时需要改动的位置。

【阶段 5】收尾
1. 确认 main 上全部测试通过，npm run build 通过，工作区干净，已推送到 origin/main；未合并的分支已推到 origin。
2. 清理本轮临时数据（测量用的原始数据先确认报告里已引用，然后按报告中的清理命令处理），以及测试实例、profile。
3. 写 docs/validation/long-chain-2026-09-summary.md，并在对话中给出同样内容的摘要：
   - 每个阶段的结果（完成 / 未完成 / 未运行）、提交号、证据路径；
   - 测试数量相对基线（后端 41、前端 82、配色 5）的变化；
   - 一期基线与 V2-01 的性能对比表；
   - 仍未验证的项目（至少包括 macOS）；
   - 需要用户决定的事项（P-V2-05–P-V2-07，以及过程中新发现的问题）；
   - 建议的下一步：用户决定上述三项后开工 V2-06 完整实现，再进入 V2-02。

====================
四、需要停下来问用户的情况（其余情况不停）
====================
- 开始时的 GUI 一次性同意（见第一部分第 3 条）。
- 需要做产品决策，或者需要改变已确认的决策 / 预算时。
- 需要执行破坏性操作：强制推送、改写已推送的历史、删除用户数据或非本轮创建的目录。
- 发现 main 或 origin/main 出现了不是本会话提交的新改动，可能有其他会话在工作时，先停下来确认再合并。