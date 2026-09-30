你在 Oris 项目（D:\Projects\Research\Oris，Tauri 2 + Rust + React/TS 的 Git 差异阅读桌面应用，远端 origin = github.com:Zhao-wl/Oris.git）中执行一个长链路任务：按顺序完成 **发布文档跟进（V2-07 / V2-D75 / PR #16 / PR #18）→ 低负载发布性能会话 → 超预算项的技术优化 → 最终 main 功能与性能复验** 四个阶段。始终用中文回答、写文档和写提交信息。尽量连续执行到底，只在“需要停下来问用户”列出的情况才停。

背景：上一轮长链 lc4（总结 docs/validation/long-chain-prune-wrapalign-b12-summary.md）只做了功能验收，没有做任何性能测试。之后 main 又合入了：分级 diff（V2-D75，PR #17）、块标题行横向滚动修复（PR #16）、对齐变化一轮批量计算（PR #18）、V2-07 工作区（PR #19，Awaiting acceptance）、构建脚本清空前端产物（`e015c69`）。一期 06 仍为 Awaiting acceptance（待签名、macOS 最终版本复测、AI 真实模型冒烟）。本轮补齐性能证据，并把新功能写进发布文档。

====================
一、前提
====================
- 已确认的决策 V2-D01–V2-D86 全部有效；当前没有待用户决定的事项。
- 一二期合并为一次发布（V2-D19）；性能预算以 docs/validation/v1-acceptance.md、docs/validation/v2-acceptance.md §3–§4、V2-D29（分层内存）、V2-D61（写操作）为准，**不降低、不调整预算**。
- 用户授权：每个阶段验收通过后 `git merge --no-ff` 合入 main 并 `git push origin main`。不授权：打 tag、推送 tag、创建 GitHub Release、上传安装包、发版（包括 oris-release skill）。
- 不在本长链内：签名 / 公证、macOS、AI 真实模型冒烟、Windows 安装 / 卸载（用户已自测）、新产品功能。
- 主工作树被多个会话共用：每个阶段在独立 worktree 中进行（例如 D:\Projects\Research\Oris-lc5），node_modules 用 junction 指向主仓库，删除 worktree 前先删 junction。提交身份只用 Zhao-wl。

====================
二、开始前必做
====================
1. 通读：AGENTS.md；docs/README.md；docs/decisions/v2-decisions.md（重点 V2-D29、V2-D58–V2-D63、V2-D75–V2-D86）；docs/validation/v1-acceptance.md、docs/validation/v2-acceptance.md（§3 性能、§4 内存，含工作区三行）；docs/validation/v1-06-performance.md（上一版发布性能测试的方法、口径与结论）；docs/validation/v1-06-rc-results.md（“RC 构建上的性能复测”“补跑 memory5 与 hunk”“块操作 A/B 对比”“lc4 复验”）；docs/research/10-diff-scan-limit.md（§7.3 性能、§7.4 未验证、对齐收敛一节）；docs/validation/v2-07-results.md；docs/tasks/v2/07-workspace.md；docs/release/ 下全部文件；lc4 总结。
2. 检查工作区：`git status` 干净；`git fetch origin` 后以 origin/main 为起点。
3. 基线测试（当前 origin/main）：后端 `cargo test --no-default-features --lib`、前端 vitest、`npx tsc -b`、`cargo check`。以实测为准写入进度日志；每个阶段结束时不能少于基线。
4. 建进度日志 artifacts/long-chain/progress-lc5.md（artifacts/ 已被 gitignore），每个里程碑写入：分支、提交号、完成项、未完成项、下一步。中断后先读这份日志。
5. 【只问一次】向用户说明并请一次性答复：
   a. GUI 测试实例：阶段 2 性能会话约 4–6 小时（含 L 数据集），其余阶段各 1–2 小时；新窗口，CDP 驱动，不抢焦点。
   b. 结束本会话启动、核对过 PID 与路径的测试进程（含性能会话进程树）。
   c. **性能会话期间请用户不要在本机运行其他会话的测试、编译或大型程序**（lc4 期间有其他会话同时跑 Oris 测试与编译，多段数据作废）。说明开工前会做 5 分钟空载测量。
   d. B30 真实远端（AgentHub 上的“清理…”）：请用户在会话权限中放行 `node scripts/perf/branch-prune-acceptance.mjs --exe <exe> --only real --run-id <运行编号>`（原样、单条）；若用户已在 lc4 之后自行跑过，请提供结果，本轮不再跑。
   e. AI 验收会写入并删除测试密钥 `Oris AI` / `oris-test-<运行编号>`（阶段 4 功能复验用）。
   f. V2-07 工作区是否随下一版本发布（默认：是；为否时只在阶段 1 记录，不写进发行说明的“变化”）。

====================
三、通用规则
====================
- 分支：阶段 1 `docs/release-scope-lc5`；阶段 2 `perf/release-lc5`（只含脚本与报告）；阶段 3 `perf/optimize-lc5`；阶段 4 在 main 上，只提交文档与脚本。
- 合入流程：验收通过 → `git fetch origin` → origin/main 有新提交时以它为基础 `merge --no-ff`，重跑全部测试并查看新提交改了哪些文件 → 推送 → 核对 `git rev-parse HEAD origin/main`。冲突时停下来问。**新提交改动产品代码时，阶段 2 的数据只代表被测构建：阶段 4 必须在包含新提交的构建上复测受影响的行。**
- 工具链（Windows，GNU Rust）：构建与 `cargo check` 在 PowerShell 中执行；PATH 前加 `D:\Tools\Rust\mingw-binutils\mingw64\bin`、后加 `;D:\Tools\Rust\msys2\msys64\mingw64\bin`。后端测试在 src-tauri 下 `cargo test --no-default-features --lib`，`CARGO_TARGET_DIR` 指向仓库外；`b12_pull_times_out…` 与 a10 取消用例在高负载下偶发失败，单独重跑一次再下结论。release：`scripts/build-release.ps1 -OutputRoot <目录>`（现在每次会清空 dist），记录 SHA-256，确认 `verify_release_entry`。**被测构建一律用全新输出目录。**
- Bash 工具每次调用后工作目录重置到主工作树：运行 worktree 中的脚本用绝对路径。批量改文件用写文件工具写脚本再执行，不用 bash heredoc；含反斜杠的路径不要写进 `node -e`。
- GUI：严格遵守 AGENTS.md。只通过 scripts/perf/gui-lib.mjs 的 `launchOris` 启动并核验实例；禁止 SetForegroundWindow / ShowWindow / AppActivate；结束时 `killOris`。报告区分 CDP 页面事件与真实输入 / 焦点。端口避开其他会话正在用的端口（启动前检查）。
- 测试数据只放在 %TEMP%\oris-gui\、%TEMP%\oris-perf\ 下本轮新建的目录，用完删除。
- **性能口径**（与 docs/validation/v1-06-performance.md 相同）：每项 n ≥ 30（大数据集按原报告的 n）；scripts/perf/load-monitor.mjs 每 5 s 记录整机 CPU 与占用最高的 5 个外部进程；外部进程合计 > 10% 且持续 ≥ 10 s 的段落作废重测，最多 2 次，仍受干扰写“受干扰，未下结论”；写操作触发的 Defender 扫描逐轮检测、单独统计。不结束用户的任何进程。
- 不自己做产品决策：新决策从 V2-D87 起编号，只能列为“待用户决定”。优化需要体验取舍或调整预算时停下来问。
- 如实报告：不降低预算，不挑选数据；没测的写“未测”，受干扰的写“受干扰”。

====================
四、阶段
====================

【阶段 1】发布文档跟进与 B30 真实远端（docs/release-scope-lc5）
1. 发行说明草稿（docs/release/release-notes.md，“相对 v0.4.1 的变化”）：按开工答复 5f 加入 V2-07 工作区（范围只写已实现与 B31–B36 已验收的能力）；核对 V2-D75、PR #16、PR #18 的条目；已知限制中“对齐变化在块数多时收敛慢”按 PR #18 的结果更新或删除；版本与构建引用改为本轮。
2. RC 验收结果（docs/validation/v1-06-rc-results.md）追溯矩阵新增 B31–B36（证据取自 docs/validation/v2-07-results.md，注明构建；性能列写“待阶段 2”），并更新 06 / V2-07 的状态说明。V2-07 的任务状态在阶段 4 按结果更新。
3. B30 真实远端：按开工答复 5d 执行（Bash 单条命令；被拦时重试一次，仍被拦交给用户，不绕过）；AgentHub `ls-remote` 开工前后一致，只创建 `oris-test/<运行编号>/` 下的分支。
4. 合入 main 并推送。

【阶段 2】低负载发布性能会话（perf/release-lc5）
0. 负载闸门：在被测构建上开跑前，用 load-monitor 空载测量 5 分钟；外部进程 CPU 的 P95 > 5% 或出现其他会话的 oris / cargo / node 测试进程时，**停下来告诉用户**是哪些进程，等用户处理后再测。会话中每个套件开始前重复一次 1 分钟检查。
1. 被测构建：阶段 1 合入后的 main，全新输出目录 Oris-builds\perf-lc5；记录 SHA-256 与源码提交。L 数据集按 v1-06-performance.md 用 generate-datasets.mjs 生成。
2. 用 scripts/perf/release-perf-session.mjs（`--run-id perf-lc5`）按批运行（每批 ≤ 3 个套件，便于中途收尾）：core、restart、trace、latency-v202、write、write-trace、hunk、appearance、reading、task03、memory5、memory5-low、memory10、git-children、large、git-probe-L。与 v1-06-performance.md 及 RC 数据并列对比。
3. 块操作 A/B：hunk 套件的 Git 确认时延在 RC 时逐次上升（796 → 940–990 → 1,217–1,446 ms），当时判为受干扰。本轮与发布性能测试的被测构建（`ae08225`，按原报告重建）同机交替各 3 轮，下结论：达标 / 未达标 / 回归（定位到提交）。
4. V2-D75 之后的大文件：用 scripts/perf/p-v2-10-gui.mjs 复测研究 10 §7.3 的各场景（65 / 182 / 540 / 1,813 块：未缓存 / 已缓存切换、F7、滚动帧间隔、统一视图）；已缓存切换预算 P95 ≤ 100 ms。
5. 对齐变化（PR #18）：wrap-align-probe（multi / single 夹具）与研究 10 的对齐收敛场景：滚动停下后对齐完成时间、期间可见块边界最大误差、滚动帧间隔（对齐开启）。无预算的只记录。
6. V2-07 工作区（v2-acceptance §3 三行与 §4）：打开工作区（S 数据集，8 个成员）与同规模普通项目首次打开的差值（≤ 300 ms）、工作区热成员切换（P95 ≤ 100 ms）、首次切到某成员（P95 ≤ 1.5 s）、工作区内存。workspace-acceptance.mjs 没有计时部分时，新增 `--only perf`（方法与 gui-probe core 一致），并在报告中说明。普通项目的首次打开、热切换、外部变化与 V2-01 结果对比。
7. 新增记录（无预算）：打开 AI 入口到可输入、AI 计划执行到界面刷新完成（假模型服务，扣除模型响应时间）。
8. 报告：docs/validation/v1-06-performance-lc5.md（方法、构建、负载记录、每行数据与预算、与上一版并列、超预算与回归清单、受干扰项）。只提交脚本与报告，合入 main。

【阶段 3】超预算项的技术优化（perf/optimize-lc5）
1. 已知必做：V2-D75 之后已缓存切换 182 块以上 P95 超出 100 ms（研究 10 定位为编辑器换入文档、布局与语法解析）。先用 CDP Performance trace 拆分耗时，再做不改变体验的技术优化（例如避免重复 setState / 重复测量、推迟视口外装饰与语法解析、复用已缓存的解析状态）。
2. 阶段 2 发现的其他超预算或回归项：逐项定位（可二分到提交），能用技术手段修复的修复；需要体验取舍或调整预算时**停下来问用户**；纯技术手段做不到的如实记录最好结果与根因，列为已知问题，不停长链。
3. 每项修复：单元测试覆盖改动逻辑；受影响的功能界面套件回归（v1-05 reading、v2-05 functional、v2-06 --skip-timing 等按改动范围选）；受影响的性能行按阶段 2 口径复测，并确认其他行不退步。
4. 报告：docs/validation/perf-optimize-lc5-results.md；合入 main。

【阶段 4】最终 main 功能与性能复验（main，只提交文档与脚本）
1. 在最终 main（含其他会话的新提交）上全新目录构建，记录 SHA-256；后端、前端、tsc、cargo check。
2. 全部功能界面套件：v1-04、v2-02 functional、v2-03、v2-04 local、v2-05 functional、v1-05 reading、v2-06 `--skip-timing`、history-feedback、gui-probe task03、v1-06-projects `--net-audit`、v1-06-git-discovery、branch-prune local、workspace-acceptance、v1-06-ai-acceptance（测试密钥按 5e）。
3. 性能：阶段 3 改动涉及的行与阶段 2 之后产品代码变化涉及的行在最终构建上复测（负载闸门同阶段 2）；其余行注明“沿用阶段 2（构建 …），之后未改动相关代码”。
4. 更新 v1-06-rc-results.md（新增“lc5 复验”一节；矩阵中性能与内存预算行、B31–B36、A15 等按结果更新）、发行说明（性能与已知限制、版本与产物 SHA-256）、06 与 V2-07 的任务状态（V2-07：§3 / §4 达标时写 Done（Windows），否则保持 Awaiting acceptance 并写明剩余项）。

====================
五、收尾
====================
- 写 docs/validation/long-chain-perf-lc5-summary.md：各阶段结果与合入提交、测试数量变化、性能数据（与上一版并列）与负载记录、优化前后对比、未达标与受干扰项、未验证项、待用户决定、建议的下一步（签名、macOS 最终复测、AI 真实模型冒烟、发版指令）。
- 清理：worktree（先删 junction）、%TEMP% 下本轮目录、AgentHub 测试分支（`ls-remote` 核对）、测试凭据（`cmdkey /list`）、本轮测试进程；本地报告复制到主工作树 artifacts\lc5\ 后再删 worktree。
- 用中文向用户汇报：结论、每个阶段的提交、测试与构建、性能达标情况、未验证项、待用户决定。

====================
六、需要停下来问用户的情况（其余情况不停）
====================
- 开工时工作区不干净或 main 与 origin/main 分叉有冲突；合入时冲突。
- 负载闸门不通过（列出进程，等用户处理）。
- 需要产品决策、体验取舍或调整预算。
- 任何破坏性操作：rebase、force push、推送 tag、增删 remote、删除远端非测试分支、`--no-verify`、删除用户数据。
- 需要签名证书、Apple 账号、真实 API Key 或任何凭据，或安装 / 卸载系统软件。
