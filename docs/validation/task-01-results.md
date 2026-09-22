# 任务 01 验证结果

状态：Blocked。Windows 11 x64 最新试用反馈与研究 05 实施已通过本轮基础覆盖；仍缺少 macOS 14+ Apple Silicon/WKWebView 真机资源，尚不能完成双平台验收、最终选型或释放任务 02。任务 02 的平铺视图与最近单仓库恢复只是已获授权提前实施的切片，不代表任务 02 整体依赖已释放。

内部覆盖代理 `/root/task01_coverage` 已完成定向复查，确认原 Windows 三个实现/验证缺口均已关闭：真实目录树；A06 连接带几何、共享滚动与选择复制；A13 external diff、fsmonitor、textconv 及工作区完整字节只读校验。性能与 Git 基线表述也已收敛。该复查针对既定缺口、验证脚本和必要实现片段，不是全量代码审核，不据此作全局代码质量背书。

## 实现闭环

真实目录选择/路径输入 → Rust `GitAdapter` 打开仓库 → NUL 分隔的 tracked 未暂存列表 → `git show :path` 读取 Index → 边界校验后读取 Working Tree → Web Worker 生成 `DiffDocument` → CodeMirror 只读阅读器。

所有 Git 调用使用参数数组，不经过 shell；固定 `--no-optional-locks`、`core.fsmonitor=false`、空 `diff.external`、`--no-ext-diff` 和 `--no-textconv`。请求与返回携带 `requestId/repoId/revision/contentId`，选择变化后丢弃旧结果。

## A01 / A06 基础 / A13

Windows 实机为 Windows 11 x64 build 22631、WebView2 `Edg/153.0.0.0`、Git 2.44.0.windows.1。真实临时仓库包含 `src/中文 diff.ts`，Index 与 Working Tree 分别有词级修改、不等长替换、空白变化、70 行上下文及无末尾换行。

WebView2 CDP 观察结果：

- 目录树按真实 `src/中文 diff.ts` 路径生成 `src` 层级，选择叶子后读取对应真实 tracked 未暂存文件；左右端点分别为 Index 与 Working Tree，旧/新 policy 均来自真实文件内容。
- 并排模式 2 个只读 EditorView；统一模式 1 个 EditorView，删除块可见，Accept/Reject/Revert 控件数量为 0。
- 4 个导航 hunk；F7 从 `1 / 4` 移动到 `2 / 4`。
- 词级高亮与 8 个折叠区通过。折叠态 4 条连接带中 3 条在视口内，全部位于双端间隙且上下端点与实际变更行边缘对齐；其中不等长 2→3 行连接带两侧高度不同。展开、自动换行和 17px 字号后，F7 定位的不等长块仍满足同一几何断言。
- 真实共享滚动容器滚动 66px 后，左右内容顶部均移动 -66px；不是只检查“同步滚动”开关或静态类名。
- DOM 选区与词级变更 `removeA` 的边界一致；受信任 Ctrl+C 事件收到同一选择，并由只读 CodeMirror copy handler 写入 `text/plain=removeA`。
- 浏览前后 status、index、config、refs、HEAD 以及工作区完整文件清单/字节 SHA-256 均一致；实际配置的 external diff、fsmonitor、`.gitattributes` textconv 三类无害 marker 均未生成。

原始本地证据：`artifacts/task-01/runtime/windows-webview2-coverage-final.json`、`windows-webview2-coverage-final.png`、`before-v2.json`、`after-v2.json`、`readonly-comparison-v2.json`、`windows-process-tree.json`。这些运行产物被 `.gitignore` 排除；本文件保存可复核结论，脚本位于 `scripts/`。

最终覆盖复测产物 SHA-256：release `oris.exe` 为 `bc87ccb5cc6d1edac285465a8b6ee9ff362d52f299760f971c44bda292094d15`；`windows-webview2-coverage-final.json` 为 `b3d7a4a65547593a9a376f7fa597cb1a970944969bae2ddcd2bb11fe4599150d`；辅助截图为 `27f411344c89fca3be8f988fc87854a2717bd372f1668f439ea77ce00b59c132`；只读对照为 `16f4bf5b179d9f1d2e38c7c0320aa737316802fa681da5115729c1be926d83cb`。

## 用户反馈修复（Windows）

本轮只在任务 01 范围及用户明确授权的两个任务 02 切片内处理现有可见闭环。截图中的 `E:\Tap4fun\X15\client` 仅用于理解反馈，没有在该仓库运行 Git、脚本或 hook，也没有声称该仓库问题已实测通过。

- **终端反复弹出**：根因是生产 Git 入口直接创建 Windows 子进程，没有 `CREATE_NO_WINDOW`。现在版本探测和所有只读 Git 命令统一经过同一命令工厂并设置该标志。Windows 专项测试在该工厂启动的子进程内调用 `GetConsoleWindow()`，结果为 `0`；安全参数数组、`--no-optional-locks`、禁 external diff/textconv/fsmonitor 和无 shell 边界保持不变。
- **打开仓库/首文件偏慢**：原正常分支依次执行版本、三个独立路径解析、分支、变更列表，再为首文件执行“变更列表 → Index 内容 → 变更列表”，共 9 个 Git 子进程。修复后仓库路径/分支合并为一次 `rev-parse`，文件读取只保留末端版本扫描，共 5 个；仍在返回内容前拒绝 stale revision。代表性夹具同一直接进程链各 20 轮：修复前 P50/P95 `495.11/532.88 ms`，修复后 `351.98/380.32 ms`，P95 下降 `28.63%`。这是核心 Git 进程链，不含 IPC、Worker、CodeMirror、首屏、杀毒波动，也不是用户仓库数据；另一次 warm release 从点击到首个 split render 的单样本为 `1089.70 ms`，不当作 P95 或冷启动结论。
- **异常宽空白**：根因是 MergeView 的 flex wrapper 内又给 `.cm-editor` 设置 `calc(50% - 16px)`，造成每侧编辑器只占各自 wrapper 的约一半，中央/右侧留下大片空白。现在由三列网格分配完整可用宽度，左右 pane 填满主区；独立连接区为 56px，而不是原异常约 400px，也不是压成几像素竖线。
- **区域不可拖动/窗口比例**：文件侧栏与 Diff 主区间新增 6px 分隔线；左右 Diff 间的 56px 连接区同时提供中央拖动命中线。两者支持 pointer end/cancel 和键盘微调，收缩时保留合理最小宽度且不产生页面横向溢出。左右分隔保存可用空间比例而非固定像素，标题与内容使用同一测量宽度。

内部 `/root/task01_coverage` 定向复查确认本轮可独立关闭项通过基础覆盖：Git 控制台隐藏、9→5 有限进程优化、异常横向空白、两处拖拽，以及左右 Diff 随窗口保持比例。侧栏保持用户拖动后的像素宽度不构成缺口，用户要求的窗口比例仅针对左右 Diff。活动拖动中的 `pointercancel` 已有实现，但没有专项实测；现有证据不能扩张为该分支已单独验收，也不是全量代码审核。

真实 Windows WebView2 复测覆盖 1280px 初始布局、侧栏拖动 84px、Diff 拖动 96px、980px/1800px 往返 resize、折叠展开、自动换行、17px 字号和真实 2→3 行不等长块。拖动后左侧比例在 1280/980/1800px 分别为 `0.6208/0.6212/0.6209`；中央区始终 56px，连接 path 可见且标题边界与内容边界对齐，无页面横向溢出。原覆盖脚本同时通过目录树、真实端点、hunk、几何、共享滚动、统一视图及受信任 Ctrl+C 复制；CDP 按键注入已移除会吞掉 DOM `copy` 事件的内部 `commands` 参数，产品复制处理未改。

证据：`artifacts/task-01/runtime/windows-webview2-feedback-final.json`、`windows-webview2-feedback-final.png`、`windows-webview2-coverage-feedback.json`、`windows-webview2-coverage-feedback.png`、`feedback-performance.json`。本轮可试用 release 为 `src-tauri/target/release/oris.exe`，最终 SHA-256 `1e4930a5c933949dbf43e940ddcf397500a6f90e92c760547bb99f4340bb283b`。

**对齐能力已落地，默认值已更新**：实现通过 CodeMirror 公共 StateField/Decoration/WidgetType 扩展点按视觉高度补齐较短侧；连接带消费同一布局结果。用户最新试用要求将“对齐变化”默认改为关闭，但开关能力保留。关闭模式下纯增删补白、零行细线与左右独立滚动映射等待后续专项调研，本轮不以固定倍速猜测实现。56px 是 Oris 当前可拖动连接区取值，不表述为 JetBrains 固定常量。

Windows WebView2 专项夹具覆盖等高/不等高修改、纯新增、纯删除及相邻变化，验证折叠/展开、自动换行、17px、约 30/70 与 70/30 分栏、900/980/1800px resize、侧栏与 Diff 拖动、开关关/开及部分离屏滚动。对齐开启时非空块顶/底误差不超过 1px，空侧数据锚点仍为零高度且绘制端与另一侧误差不超过 1px；关闭时窄窗最大真实错高约 330px，再开启恢复。连接带为闭合填充路径，控制点使用 30%/70%，无高对比描边；滚出视口后逻辑端点不变，由滚动容器裁剪。最终 release 单样本从载入点击到稳定 split 渲染为 `1622.30 ms`（非 P95/冷启动结论）。证据为 `artifacts/task-01/runtime/windows-webview2-alignment-final.json`（SHA-256 `46dd4e11da263d2afc2666bc70a44c73f731b51ed3c626fbfdc84ccde1c171cc`）及 `alignment-final-*.png`，自动断言由 `scripts/task01-feedback-smoke.mjs` 生成。

补充视觉证据状态：**已通过内部定向复查**。同一 release `1e4930…283b`、同一真实临时 Git 夹具 `src/中文 diff.ts`、900×720 WebView2、17px、自动换行下，脚本将同一 2→3 不等长变化块定位到视口内并分别截取 30/70 对齐开、30/70 对齐关、70/30 对齐开；另定位纯删除块展示零行侧楔形/补白。路径及 SHA-256：`alignment-final-aligned-30.png` 为 `cfc68a175208d0570f560f55ec0c155e3a673b280528f5e74d82ebb6bc974278`，`alignment-final-unaligned-30.png` 为 `3f6c85cbd60c6ef78f3e08ef36379e59d0cbff664fe72168e5f509bee3b1bc43`，`alignment-final-aligned-70.png` 为 `b3b27b38fbcead6fcea70775cfe224d29b499c79683cabceef9cb6aac0477bbe`，`alignment-final-aligned-pure-delete.png` 为 `e038131a1df3a0f2c39c2c8a06a1c9642f8dc87483409020182d8e87645bd30e`。本次人工定向复查范围是前三张同一变化块的窄窗开/关与双比例可视效果，结合脚本对纯删除零锚点及其余几何的断言，关闭本轮唯一可视交付缺口；该结论不是算法全量审核，也不替代 macOS 真机验收。

## 最新试用反馈修复（Windows，基础覆盖已通过）

- “对齐变化”和“折叠上下文”新会话默认关闭；自动换行沿用默认关闭。三个按钮只显示名称，不显示圆圈、勾或状态文字；开启态在深浅主题均有持续的背景、边框、文字色差异，失焦后仍可分辨，`aria-pressed` 与键盘 Space 切换一致。
- 文件区默认平铺并显示完整仓库相对路径；单个图标下拉选择平铺/树模式，ARIA/tooltip 说明含义。96 个真实变更文件夹具包含中文和空格路径；模式切换保持选中文件、路径与 Diff 内容不变。
- 文件区现在是独立纵向滚动容器并保留可见滚动条。实测 wheel 后文件区 `scrollTop 0→620`，侧栏标题、Diff 工具栏和 `.workspace` 位置/滚动值不变；树模式 57 个目录节点、`scrollHeight/clientHeight=4323/389`。
- 导航菜单消失的根因已复现：侧栏网格缺少 `min-height:0`，长文件树把工作区内容高度撑到 4323px；原 `EditorView.scrollIntoView` 在远距 hunk 导航时继续滚动可编程的隐藏祖先，从而把整个工作区上方卷走。修复后侧栏被约束为独立滚动口，hunk 导航只设置 Diff 容器 `scrollTop`，聚焦使用 `preventScroll`。14 次下一处、F7、Shift+F7、上一处后，tabbar/toolbar/endpoints 顶边分别保持 `87/121/159px`，`.workspace.scrollTop` 始终为 0，Diff 自身滚到 223px，按钮仍可点击。
- 最近一次成功打开的单仓库路径和最小必要 Git 可执行路径保存于该 WebView 应用用户数据中的 localStorage，不向仓库写文件。真实跨进程重启自动恢复同一仓库及首文件；手动打开不存在路径不会覆盖最后成功记录。模拟已保存路径失效时只尝试一次，显示“上次仓库未能恢复”和可重新载入的明确错误。

专项脚本 `scripts/task01-latest-feedback-smoke.mjs` 的 full/跨进程 restore/invalid 三阶段均通过。原始 JSON SHA-256：`windows-webview2-latest-feedback-full.json` 为 `b7a5384b45c59e5f751bca59331867badf8228c172dc2a0381a8f0e6d6fe26bf`，restore 为 `073735671cc0606973e09af15c76a781604b9795007f8604a5b1684f9265e670`，invalid 为 `9de096123193be7d71090ce2fc886d2e477f2e20394e71605b028467a029e12e`。用户预览图：`latest-feedback-flat.png`、`latest-feedback-toggle-active.png`、`latest-feedback-navigation.png`。最新 no-bundle release 为 `src-tauri/target/release/oris.exe`，SHA-256 `57c621a537adc6ddd65d692fdf1e8e1295f106c1e2dbdb80667ea1235a1dd1c2`。

## 研究 05 实施：非对齐滚动与双列外缘轨道（Windows，基础覆盖已通过）

已将 split 模式从 `MergeView` 迁移为两个独立 `EditorView`，统一模式继续使用公开 `unifiedMergeView`。因此关闭“对齐变化”时不再创建 CodeMirror `.cm-mergeSpacer` 或 Oris `.oris-alignment-spacer`；纯新增/纯删除的空侧以真正零高度逻辑区间和代码区细线表达，连接区仍绘制对应楔形。

滚动同步不使用固定倍速。左右文档分别以 hunk 起止视觉边界建立分段映射，当前产生真实 wheel/touch/pointer/keyboard 输入的一侧成为 master；程序写入携带 epoch/期望位置 token，避免另一侧的回写事件反向夺取 master。边界查找与可见连接带裁剪均使用二分查找。F7、按钮和 marker 导航在同一程序 epoch 内同时定位两侧，页面工作区保持不滚动。

每侧外缘轨道明确拆为两列且镜像：贴近代码的是窄差异色标列，最外缘是较宽滚动条列，中间有分隔线。两列的命中矩形无重叠；蓝/绿/灰 marker 分别表示修改/新增/删除，thumb 只表示本侧真实 viewport。thumb 拖动、空轨道翻页、Home/End/Page/Arrow 键和 marker 点击均可操作，并保留 `role=scrollbar`、数值及控件关联。

真实 260 行混合夹具与整文件新增/删除夹具通过 `scripts/task01-scroll-smoke.mjs`：两侧独立 `.cm-scroller`、Align 关闭零 spacer、左右真实 wheel master 切换、无 ping-pong、thumb 拖动、轨道键盘、marker 导航、12 次 hunk 导航、Align 开关 10 次无残留、整文件空侧 full-thumb/零行细线/有限连接几何，以及滚动条列与 marker 列双侧零交叠均通过。证据为 `artifacts/task-01/runtime/scroll-model-final.json`、`scroll-model-final-unaligned.png` 与 `scroll-model-final-aligned.png`；最终 release SHA-256 为 `b40cc9cad24ec9439ea9c0ac68392eb293cf42d2c0b7172798d515410b2de97d`。macOS 平台门禁仍未解除。

执行会话第一次在该迁移版本上复跑 `scripts/task01-cdp-smoke.mjs` 时得到 `passed:false`，内部覆盖读取结果后发现该失败，未将其归类为 Align OFF 的旧断言，也未删除失败断言。`cdp-final-repro.json` 显示折叠态通过，但展开、自动换行、17px 后 F7 定位的 2→3 行块虽顶部同为约 `193.33px`，底部仍为约 `272.37/264.72px`；相邻块也有约 24px 顶部差异。根因是 Align ON 最初在视口顶部使用 CodeMirror 对离屏换行行的估算高度完成补白，F7 将目标渲染进虚拟视口并获得真实高度后，原控制器没有启动新一代测量；旧迭代还只能在两侧交替增加 spacer，不能缩回过量值。处置为按“当前 spacer 高度差减去实测误差”直接求唯一单侧补白，真实输入或 hunk 导航触发带 generation 的重测，并在收敛后按最终几何二次定位同一 hunk；程序同步回写和补白自身的 scroll 事件不会重启测量。最终 `cdp-alignment-final.json` 为 `passed:true`：同一 2→3 行块顶点 `193.328/193.328px`、底点 `264.719/264.719px`，相邻零行块的语义端仍为零高度且绘制底点 `502.688/502.688px`。`task01-feedback-smoke.mjs` 与滚动条专项也在同一 release 上再次通过，内部覆盖随后以只读方式确认上述两项缺口已关闭。

## 用户授权阅读切片：选区、搜索与 viewport band（Windows，基础需求覆盖通过）

原白色搜索框的直接原因不是 CodeMirror 面板主题，而是 `searchKeymap` 只能在编辑器获得焦点时拦截 Ctrl+F；焦点位于工具栏或应用其他区域时，WebView2 会打开原生 Find。现在由 Oris 在文档捕获阶段接管 Ctrl/Cmd+F，并提供只读应用内面板：Aa、全字、`.*`、结果计数、上一个/下一个和关闭；Enter/Shift+Enter/Escape 可用，不出现替换控件。深浅主题都消费 Oris 变量，非法正则显示“正则表达式无效”，空查询和零长度正则显示 `0/0` 而不会循环。

显式搜索和选中同词共同使用 CodeMirror `SearchQuery`。必要区别是：显式输入在 `.*` 开启时解释为正则；鼠标选择始终作为字面查询，只继承大小写和全字设置，因此选择 `a+b` 只匹配两侧真实 `a+b`，不会误命中 `aaab`。选中同词仅扫描/装饰每侧 `visibleRanges`，每侧最多 200 个；搜索可见装饰每侧最多 500 个，全局计数/导航最多 10,000 个并以 `+` 表示截顶，输入最长 512 字符。真实选区不被替换、不打开搜索框、不跳滚；空选区清除同词装饰。配色层级为：蓝/绿/灰差异语义、紫色真实选区、青色选中同词、黄/橙搜索其它/当前命中。

色标槽新增 `.diff-overview-viewport`。它使用 `documentTop`、`lineBlockAtHeight` 和文档逻辑行号把本侧视口首末可见 block 投影到与 marker 相同的逻辑行尺度，不复制旁边按 `scrollHeight/clientHeight` 计算的 thumb。左右分别更新；wrap、折叠、字号/尺寸、滚动、导航和空文档均走同一更新入口。band 不接收 pointer，marker 仍位于其上并保持点击命中。

真实 Windows WebView2 夹具含 `wins/Wins/winsome/a+b/aaab/中文` 及修改/新增/删除三类块。`scripts/task01-reading-smoke.mjs` 用真实 CDP 键鼠验证：应用级 Ctrl+F、大小写计数 `24→15`、全字 `15→11`、正则与非法正则、Enter `1/2→2/2`、Shift+Enter `2/2→1/2`、Escape 焦点/滚动恢复、Align ON 导航后重新测量、split/unified 搜索且无 replace、真实鼠标选中 `a+b` 与蓝色修改块中的 `wins`、其它匹配、空选择清除、深浅搜索框，以及 band 的逻辑比例、左右独立值、wrap/fold、marker 命中和空文档 full-band。专项、滚动回归、原 CDP 复制/对齐回归及反馈几何回归均通过。证据：`artifacts/task-01/runtime/reading-final.json`、`reading-final-dark-search.png`、`reading-final-light-search.png`、`reading-final-selection-wins-diff.png`、`reading-final-selection-literal.png`、`reading-final-viewport-band-scroll.png`。

为补齐真实选区可读性的可见证据，`scripts/task01-selection-contrast-smoke.mjs` 在同一 release 上以 CDP 真实鼠标拖选，并逐项断言 `getSelection()` 文本、所在差异行类别、选区层颜色不同于差异行底色，以及选区矩形完整落在对应编辑器内。深色和浅色主题各覆盖蓝色修改块 `wins`、灰色删除块 `removedWins`、绿色新增块中的中文 `胜利`，6 个场景全部通过；截图中的目标行与选中文字均完整可见，没有右侧裁切。结构化结果为 `artifacts/task-01/runtime/selection-contrast.json`，截图为 `selection-contrast-dark-modified.png`、`selection-contrast-dark-deleted.png`、`selection-contrast-dark-inserted.png`、`selection-contrast-light-modified.png`、`selection-contrast-light-deleted.png`、`selection-contrast-light-inserted.png`。内部定向复查逐张查看上述六张截图并核对结构化结果，确认本轮 Windows 阅读四项反馈切片的基础需求覆盖通过；复查未重跑测试，也未新增代码审核。最终 release 未改变，SHA-256 仍为 `f474dfba21fa6abf3db46a9f25a8979e2a7736dd06b1d0605a721819e6838b96`。该结论不表示任务 04 整体开始或完成，macOS 门禁不变。

## CodeMirror 选型结论

Windows 侧通过基础选型验证，暂不切换 Monaco：

- Worker 使用 `@codemirror/merge` 公共 `diff`/`Chunk.build` 生成唯一 `DiffDocument`；split 的两个独立 `EditorView` 与统一视图的 `unifiedMergeView` 消费同一 changes 列表。计数、导航、行/词高亮和连接带由这一文档派生。
- 并排与统一、词级/行级、`collapseUnchanged`、只读选择复制、应用内 `SearchQuery` 搜索、软换行和字号扩展均使用公共 API。
- CodeMirror 默认没有 JetBrains 式曲线连接带；实现使用后端 `DiffDocument.hunks`、`EditorView.lineBlockAt`、StateField/Decoration/WidgetType 扩展点计算视觉补白与连接路径，并在滚动、折叠、换行、字体及尺寸变化后重测。未修改 CodeMirror 私有状态或源码。
- 大型内容仍需受预算保护；本任务没有证明全部 V1 文件类型与完整性能，任务 04/05 继续验收。

由于缺少 WKWebView 真机证据，D08 只能视为“Windows 基础实现可锁定，最终双平台锁定待 macOS 验证”。任务 01 因此外部平台资源缺口保持 Blocked，任务 02–05 保持 Pending 且依赖未释放。若 macOS 出现选择、测量或滚动差异，优先修复公共适配层；只有无法满足已确认体验时才提出 Monaco 替代决策，不能自行降级。

## 性能预算与首轮测量

测量前沿用 `v1-acceptance.md`：S 首次列表 P95 ≤3,000 ms、未缓存常用 diff P95 ≤1,000 ms、进程树稳态参考 ≤400 MiB；内容上限为 5 MiB/100,000 行/单行 100,000 字符。release 核心探针各运行 30 次，夹具生成时间不计入读取 P50/P95。核心探针只测 Rust `snapshot`/`ContentPair` 调用，不包含 IPC 传输、Web Worker、CodeMirror 建模和首屏绘制，不能据此宣称端到端“未缓存 diff P95 ≤1,000 ms”已通过。

Windows 测量机：Intel i7-11700、16 逻辑处理器、47.7 GiB RAM、SSD。S 夹具为 10,000 tracked/100 changed；提交历史维度不属于任务 01 的读取调用链，未用伪造 20,000 commits 冒充测量。结果：

- S fixture 生成 88,433.34 ms；文件 snapshot P50 79.97 ms/P95 82.41 ms；内容对读取 P50 211.47 ms/P95 217.39 ms；核心探针 Working Set 6.56 MiB。
- Windows Tauri + 6 个 WebView2 子进程的单项目交互快照：Working Set 383.9 MiB、Private 226.7 MiB。它不是“五项目热切换”最终内存验收。
- L 夹具为 100,000 tracked/2,000 changed，30 轮有界完成且未崩溃：fixture 生成 975,582.12 ms；文件 snapshot P50 534.46 ms/P95 593.55 ms；内容对读取 P50 1,133.35 ms/P95 1,252.09 ms；核心探针 Working Set 6.41 MiB。L 不套用 S 的 1,000 ms 常用文件门槛，也没有据此下调 S 门槛。

原始日志：`artifacts/task-01/runtime/performance-s.log` 与 `performance-l.log`。

## 未运行与风险

- 未运行 macOS 14+ Apple Silicon/WKWebView、Retina、Finder 启动和 Mac Git 路径探测；需要 M1 或以上真机。取得资源后须完成平台侧 A01/A06/A13 与启动路径验证，之后才能形成最终选型并解除任务 02 依赖。
- 未制作或签名安装包；属于任务 05。
- Windows 高 DPI 的自动截图来自真实 WebView2，但截图仅为辅助证据，功能判断来自真实 Git 来源与 DOM/IPC 断言。
- Vite 生产包主 chunk 约 655 KiB（未压缩）并有 chunk-size warning；当前交互与内存仍通过首轮探测，任务 05 应做按需语言加载/拆包。
