你在 Oris 项目（D:\Projects\Research\Oris，Tauri 2 + Rust + React/TS 的 Git 差异阅读桌面应用，远端 origin = github.com:Zhao-wl/Oris.git）中执行一个长链路任务：按顺序完成 **分支清理功能补登记与验收 → 自动换行 + 对齐的长行对齐误差修复 → 真实远端回归（B12）→ 最终 main 功能复验** 四个阶段。始终用中文回答、写文档和写提交信息。尽量连续执行到底，只在“需要停下来问用户”列出的情况才停。

背景：上一轮长链（V2-D60 → V2-D58 → 一期 06 RC，总结见 docs/validation/long-chain-v2d60-v2d58-v1-06-rc-summary.md）结束后，一期 06 仍为 Awaiting acceptance（待签名、macOS 最终版本复测、安装 / 卸载实测、AI 真实模型冒烟）。剩下的非性能缺口：

1. `a19ef69`（本地分支右键删除、本地分支分组“清理…”）通过 PR #12 直接合入。“清理…”会对上游所在的 remote 执行 `fetch --prune`，与 V1 规格 R-REMOTE（docs/specs/v1-product.md 第 91 行“不自动 prune”）和 V1 技术方案（docs/architecture/v1-architecture.md 第 96 行“禁 prune”）的文字不一致；没有登记决策，没有验收项，也没有界面验收脚本。`7adb1f4`（概览栏色块半透明、视口框显示在色块之上）同样没有界面证据。
2. 已知问题：自动换行开启且两侧对齐时，少数长行的滚动对齐存在误差（docs/validation/v2-d58-font-size-results.md：“自动换行 + 对齐变化”场景滚到 41% 后初始 73.1 px，切换字号后 4 / 3 px；优化前构建也一样）。
3. B12 AgentHub 真实远端两轮都没有跑成（自动权限分类器拦截）。

补充：2026-09-29 main 已发布 v0.4.0（`8da935c`，只改版本号，其他会话完成）。本轮对 docs/release/release-notes.md 的新增内容（分支清理、换行对齐修复、WebView2 连接说明、安装 / 卸载记录）写到 **v0.4.0 之后的下一版本**；开工时先核对 release-notes.md 当前对应哪个版本，不改写已发布版本的说明，版本归属不清时停下来问。v1-06-rc-results.md 的“lc4 复验”注明被测构建与 v0.4.0 的关系。

**本轮不做性能测试**（当前环境负载不适合）：不运行 release-perf-session、v1-06-write-latency、v1-06-git-children、appearance-probe 的计时模式、memory5、块操作 A/B、L 数据集；V2-D59 与块操作 Git 确认时延（v1-06-rc-results.md“块操作”一节）保持“待低负载确认”。各阶段需要的性能结论一律写“未测（本轮不做性能测试）”，不拿本轮任何计时数据下结论。

====================
一、前提
====================
- 已确认的决策 V2-D01–V2-D68 全部有效。
- **用户答复（2026-09-29，开工前已给出，开工时不再询问）**：
  1. 同意本会话内启动 Oris 测试实例（GUI 验收照常执行）。
  2. 同意结束本会话启动、已核对 PID 的 Oris 测试进程（以及本轮的假模型服务 / 假命令行工具进程）。
  3. 同意 AgentHub 真实远端回归（B12）。注意：口头同意不等于会话权限放行，开工时提醒用户在会话权限中放行下文 3.1 列出的 Bash 命令；被拦截时按 3.1 第 4 项处理。
  4. **不做 Windows 安装 / 卸载实测**：用户已自行测试安装与卸载，没有问题（2026-09-29，用户口头确认，范围未记录）。A15 的安装 / 卸载按这条记录写，不要扩大它的范围；自动更新的原地安装仍未验证。
  5. 同意：V2-D69–V2-D73 与阶段 1 的 V2-D74 均改为“用户已确认（2026-09-29，按现有实现）”；WebView2 首次运行时那条来源未确认的对外连接写入发行说明（如实写“推测为 WebView2 运行时自身的请求，不经 Oris 代码，未确认”）。开工后先在 docs/decisions/v2-decisions.md 中更新 V2-D69–V2-D73 的状态并把它们移出“待用户决定”。
  6. 同意阶段 4 的 AI 界面验收把本轮随机生成的测试 API Key（不是任何真实服务的密钥）写入 Windows 凭据管理器，条目只用 `Oris AI` / `oris-test-<运行编号>`，结束时删除并用 `cmdkey /list` 核对。
  第 5 项已由用户确认上述理解（2026-09-29）。
- 用户授权：每个阶段验收通过后，用 `git merge --no-ff` 合入 main 并 `git push origin main`。不授权：打 tag、推送 tag、创建 GitHub Release、上传安装包、发版（包括 oris-release skill）。
- 不在本长链内：签名 / 公证（缺证书）、macOS 复测（无环境）、AI 真实模型冒烟（需用户自己的密钥）、AI 第 3–4 期与多步计划（V2-D73 已确认本次发布不做）、Windows 安装 / 卸载实测（用户已自测）、全部性能测试。
- 主工作树被多个会话共用：每个阶段都在独立 worktree 中进行（例如 D:\Projects\Research\Oris-lc4），构建前核对当前分支；node_modules 用 junction 指向主仓库，删除 worktree 前先删 junction。
- 提交身份只用 Zhao-wl（仓库本地 config 已设置），不改全局 config。

====================
二、开始前必做
====================
1. 通读：AGENTS.md（GUI 安全约束，必须遵守）；docs/README.md；docs/decisions/v1-decisions.md、docs/decisions/v2-decisions.md（重点 V2-D38、V2-D39、V2-D58、V2-D64–V2-D73）；docs/specs/v1-product.md（R-REMOTE、R-BRANCH）与 docs/specs/v2-product.md（R-BRANCH、R-SYNC、R-OPSAFE）；docs/architecture/v1-architecture.md §fetch、docs/architecture/v2-architecture.md；docs/validation/v1-acceptance.md、docs/validation/v2-acceptance.md；docs/validation/v1-06-rc-results.md；docs/validation/v2-d58-font-size-results.md；docs/release/ 下全部文件；上一轮总结 docs/validation/long-chain-v2d60-v2d58-v1-06-rc-summary.md。
2. 检查工作区：`git status` 干净；`git fetch origin` 后 main 等于 origin/main 或只能快进。
3. 基线测试（当前 main）：后端 `cargo test --no-default-features --lib`（上一轮 170 通过 / 5 忽略）、前端 vitest（上一轮 275）、`npx tsc -b`。以实测为准写入进度日志；每个阶段结束时不能少于基线。
4. 建进度日志 artifacts/long-chain/progress-lc4.md（artifacts/ 已被 gitignore），每个里程碑写入：分支、提交号、完成项、未完成项、下一步。中断或上下文被压缩后先读这份日志。
5. 开工确认：GUI、结束测试进程、AgentHub、安装 / 卸载、待定决策、AI 测试密钥均已在“一、前提”中答复，不再询问。开工时只做一件事：
   a. 提醒用户在会话权限中放行阶段 3.1 的 Bash 命令（原样，不串联）：`node scripts/perf/v1-04-acceptance.mjs --only real --run-id <运行编号>`、`node scripts/perf/v2-04-acceptance.mjs --only real --run-id <运行编号>`、`node scripts/perf/branch-prune-acceptance.mjs --only real --run-id <运行编号>`、`git push git@github.com:Zhao-wl/AgentHub.git --delete oris-test/<运行编号>/...`，以及结束测试进程的 `taskkill /PID <PID> /T /F`。

====================
三、通用规则
====================
- 分支：每个阶段从最新 main 建分支，按里程碑提交。阶段 1：docs/branch-prune；阶段 2：fix/wrap-align；阶段 3：test/b12-real（只有文档与脚本改动）；阶段 4 在 main 上做，只提交文档。
- 合入流程：验收通过 → `git fetch origin` → origin/main 有新提交时 `git merge --no-ff origin/main` 进本地 main（不 rebase），重跑全部测试并查看新提交改了哪些文件 → `git merge --no-ff <阶段分支>` → 推送 → 核对 `git rev-parse main origin/main` 一致。冲突时停下来问。**新提交改动了产品代码时，阶段 4 必须在包含它们的构建上复验。**
- 工具链（Windows，GNU Rust）：
  - desktop / release 构建与 `cargo check` 一律在 PowerShell 中执行（Git Bash 下 windres 失败）。当前进程 PATH 前面加 `D:\Tools\Rust\mingw-binutils\mingw64\bin`，后面加 `;D:\Tools\Rust\msys2\msys64\mingw64\bin`，不改系统环境。
  - 后端测试：在 src-tauri 执行 `cargo test --no-default-features --lib`，`CARGO_TARGET_DIR` 指向 `D:\Projects\Research\Oris-builds\<阶段>\target-test`。不要去掉 `--no-default-features`（带 desktop 特性会以 `STATUS_ENTRYPOINT_NOT_FOUND` 启动失败，是命令用错）。a10 取消用例偶发计时失败：单独重跑一次，仍失败才算问题。
  - `cargo check`（默认特性）要求无警告；`npx tsc -b`；`npx vitest run`。
  - release：`scripts/build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\<阶段>`，不要加 `*>&1` 之类的重定向。记录 oris.exe 的 SHA-256，确认 `verify_release_entry` 通过。
  - 提交信息含中文弯引号时写到文件再 `git commit -F`。批量改文件先把脚本写到磁盘再执行，不用 bash heredoc；文件保持 LF。
- GUI：严格遵守 AGENTS.md。只通过 scripts/perf/gui-lib.mjs 的 `launchOris` 启动并核验自己的实例（PID、exe 完整路径、主窗口句柄、CDP 端口归属），使用独立的 `WEBVIEW2_USER_DATA_FOLDER` 与 `ORIS_APP_CACHE_DIR`；禁止 SetForegroundWindow、ShowWindow、AppActivate；结束时 `killOris` 正常关闭并清理临时目录。报告区分“CDP 页面事件”与“真实鼠标、键盘与 Windows 焦点”。不改系统显示缩放、系统主题。
- 测试数据只放在 %TEMP%\oris-gui\、%TEMP%\oris-perf\ 下本轮新建的目录，用 gui-fixtures.mjs 或 generate-datasets.mjs 生成，用完删除；不在用户真实仓库里制造改动。
- 不自己做产品决策：新决策从 V2-D74 起编号，只能列为“待用户决定”。不阻塞的分歧按最保守、可逆的做法实现并登记；阻塞的停下来问。
- 如实报告：不降低预算，不跳过验收，不伪造或挑选数据；没测的写“未测”。
- 文档：每个阶段更新相关任务文档与 docs/tasks/README.md 或 docs/tasks/v2/README.md 的状态，新建验证报告（阶段 1：docs/validation/branch-prune-results.md；阶段 2：docs/validation/wrap-align-results.md；阶段 3：docs/validation/b12-real-remote-results.md）。报告包含：实现版本、逐项验收结果、证据路径、平台与工具版本、与技术方案的差异、未验证项、待用户决定。

====================
四、阶段
====================

【阶段 1】分支删除 / 清理功能补登记与验收（docs/branch-prune）
依据：`a19ef69` 的实现（src/App.tsx、src/HistorySidebar.tsx、src/HistoryPanel.tsx、src-tauri/src/git/ops/network.rs）；V2 规格 R-BRANCH“删除本地分支”；V1 规格第 91 行与 V1 技术方案第 96 行的 prune 约束。
1. 盘点（以源码为准，写进进度日志）：右键“删除分支…”与“清理…”的入口、确认文案、未合并强确认、当前分支 / detached / 进行中操作时的可用状态；`fetch --prune` 的参数（是否含 `--no-prune-tags`、`--no-recurse-submodules`、是否只对上游所在 remote）、写锁与 OperationRunner 路径、失败 / 取消 / 认证失败时的行为；普通“获取”是否仍为 `--no-prune`。
2. 登记决策 V2-D74（“待用户决定（按现有实现先行）”，用户在开工答复中确认的除外）：“用户在本地分支分组显式点击‘清理…’时，对上游所在 remote 执行 `fetch --prune`（从不 prune 标签），再列出上游已消失的本地分支、确认后删除；普通获取、刷新、启动、项目切换仍不 prune”。在 V1 规格 R-REMOTE 与 V1 技术方案的 prune 条目旁注明此例外并引用 V2-D74，不改原约束对其他路径的效力。
3. 在 docs/validation/v2-acceptance.md 新增 B30（从现有最大编号之后顺延）：
   - 普通获取不删除任何远端跟踪引用（trace 核对无 `--prune`）；“清理…”只删除上游 remote 的 stale 跟踪引用，不删除标签，不影响其他 remote。
   - 列表只含上游已消失的本地分支；当前分支、没有上游的分支、上游仍存在的分支都不出现；取消确认时不删除任何分支。
   - 已合并的直接删除；未合并的汇总后强确认，说明之后只能从 reflog 找回；结束后如实汇总成功 / 失败。
   - 右键删除：当前分支不可删；未合并强确认；删除后历史页、分支列表、跳到 HEAD（V2-D39）正确。
   - fetch 失败 / 取消 / 认证失败时不删除任何本地分支，不弹凭据输入。
   - B16、B17：操作前后的仓库指纹只在预期的 refs 上变化（工作区、index、stash、其他分支、标签不变）。
4. 新增 scripts/perf/branch-prune-acceptance.mjs：`--only local` 用本地 bare remote（生成 3 个上游已删除的分支，其中 1 个未合并；1 个无上游分支；1 个标签；第二个 remote），走 CDP 覆盖上面各项并用 `GIT_TRACE2_EVENT` 核对参数；`--only real` 预留给阶段 3（AgentHub）。AgentHub 相关代码放在单独的函数里，`--only local` 不引用它。
5. 概览栏（`7adb1f4`）：在 v1-05 或 v2-06 界面验收中补一项，断言色块半透明、视口框的层叠在色块之上（读计算样式与 z-index / 绘制顺序），浅色 / 深色各一次。
6. 单元测试：补 fetch prune 参数、stale 分支筛选、未合并汇总的用例（已有的保留）。
7. 回归：v1-04、v2-03、v2-04 `--only local`、history-feedback 界面验收。
8. 通过后合入 main 并推送。发现实际缺陷（例如 prune 了标签、取消后仍删除、删除了非 stale 分支）直接修复，属于本阶段范围。

【阶段 2】自动换行 + 两侧对齐的长行对齐误差（fix/wrap-align）
依据：docs/validation/v2-d58-font-size-results.md“阅读状态对照”（3 条误差：滚到 41% 后初始 73.1 px，切换字号后 4 / 3 px）；scripts/perf/v2-d58-font-equivalence.mjs 的“自动换行 + 对齐变化”场景；研究 05（Align 关闭时的双侧滚动与零行语义）；src 中对齐层与同步滚动实现。
1. 复现：用 v2-d58-font-equivalence.mjs（只用它的状态采集部分，不做计时）在当前 main 上复现 3 条误差，并扩展到更多位置（10%–90% 每 10%、顶部、底部，左右两侧主控），列出误差 > 1 px 的位置、对应行号、两侧折行数与块类型，写进进度日志。
2. 定位：确认误差来自哪一步（例如折行高度未测量就用估算值、间隔块（spacer）高度按旧折行计算、视口外行高缓存、同步滚动时的锚点换算），给出证据（测量前后的 heightMap、spacer 高度、锚点行的 top）。
3. 修复目标：自动换行 + 两侧对齐时，任何滚动位置与字号切换后，两侧锚点行的顶部偏差 ≤ 1 px；不开换行、不开对齐、统一视图的 63 个阅读状态与修复前完全一致（顶部行号、像素偏移 ≤ 1 px、scrollTop ≤ 1 px、首行文本、块标题行、搜索命中、连接带）。
4. 需要体验取舍才能做到时（例如短暂不对齐、改变折行规则、限制换行下的对齐精度），**停下来问用户**。纯技术手段做不到时，如实记录最好结果与根因，已知问题保留，不停长链、不合入会改变其他状态的改动。
5. 测试：单元测试覆盖改动的对齐 / 高度计算逻辑；把扩展后的对照做成可重复运行的检查（修复前构建与修复后构建各跑一次，列出差异表）；回归 v1-05（阅读 42 项）、v2-06、v2-05 界面验收。
6. 性能：未测（本轮不做性能测试）。在报告中写明改动是否在滚动路径上增加了测量或强制同步布局，留给下一次低负载性能会话复测典型 diff 滚动与字号切换。
7. 修复有效且其他状态无变化时合入 main 并推送；发行说明已知问题相应删除或更新。

【阶段 3】真实远端回归（B12）（test/b12-real）
依据：docs/validation/v1-06-rc-results.md 中 B12 的“未运行”说明；AgentHub 账号与远端规则。
3.1 AgentHub 真实远端（用户已同意，见“一、前提”第 3 项）
1. 开始前先告知用户，并记录 AgentHub 开工时的引用（SSH `git ls-remote git@github.com:Zhao-wl/AgentHub.git`，在 PowerShell 执行）。
2. 从 Bash 工具、单条命令启动：`v1-04 --only real`（fetch SSH / HTTPS）、`v2-04 --only real`（pull / push / 发布分支 / 被拒绝 / 取消）、`branch-prune-acceptance --only real`（推送 `oris-test/<运行编号>/prune-a`、`prune-b` 后从远端删除，再在 Oris 中执行“清理…”，确认只删这两个本地分支、标签不变）。
3. 只创建 `oris-test/<运行编号>/` 下的分支，结束后删除；不碰 main 和已有分支。不改全局 / 系统 Git 配置；HTTPS 克隆只在自身 .git/config 设置 `credential.https://github.com.username=Zhao-wl`；不读取、不输出凭据；不在弹窗中输入。
4. 被拦截：放行后用 Bash 单条重试一次；仍被拦就停下这一项，把命令交给用户执行，拿到用户的输出后再写结论；用户不执行时 B12 记为“未运行（权限拦截）”，继续后续工作。
5. 结束时 `ls-remote` 核对只剩开工时的引用。
3.2 A15 安装 / 卸载：不实测。在 v1-06-rc-results.md 的 A15 行与 docs/release/windows-install-checklist.md 中记录“用户已自行测试安装与卸载，没有问题（2026-09-29，用户口头确认，范围未记录）”，不扩大范围；自动更新的原地安装记为“未运行（需正式签名的更新包，随下一次发版验证）”。
3.3 文档：更新 v1-06-rc-results.md 中 B12、A15 两行（注明构建与日期），写 docs/validation/b12-real-remote-results.md；通过后合入 main 并推送。

【阶段 4】最终 main 功能复验（main，只提交文档）
1. 在最终 main 上重跑后端、前端、tsc、`cargo check`，并在全新目录 Oris-builds\final-main-lc4 做 release 构建，记录 SHA-256。
2. 重跑全部功能界面套件（不跑任何计时套件）：v1-04、v2-02、v2-03、v2-04 local、v2-05、v1-05、v2-06、history-feedback、gui-probe task03、v1-06-projects（含 `--net-audit`）、v1-06-git-discovery、v1-06-ai-acceptance（测试密钥按“一、前提”第 6 项：只写 `Oris AI` / `oris-test-<运行编号>`，结束时删除并用 `cmdkey /list` 核对）、branch-prune-acceptance local。脚本因已确认的决策过期时按决策更新并说明。
3. 更新 v1-06-rc-results.md：新增“lc4 复验”一节，列出每个套件在最终构建上的结果；追溯矩阵中本轮改变结论的行（B12、A15、B30、已知问题）逐行更新，性能行全部保持原状并注明“本轮不做性能测试”。
4. 发行说明（仍为草稿）：已知问题按阶段 2 结果更新；补“分支清理”说明（手动触发，会 prune 上游 remote 的跟踪分支，不 prune 标签）；补 WebView2 首次运行对外连接的说明（按“一、前提”第 5 项）；安装 / 卸载一节把“本轮没有在本机执行安装 / 卸载测试（未授权）”改为用户自测记录；更新版本与产物 SHA-256。
5. 06 的状态：保持“Awaiting acceptance（待签名、macOS 最终版本复测、AI 真实模型冒烟）”；安装 / 卸载按用户自测记录从剩余项中去掉。同步更新 docs/tasks/README.md 与 06 任务文档的状态行。

====================
五、收尾
====================
- 写 docs/validation/long-chain-prune-wrapalign-b12-summary.md：各阶段结果与合入提交、测试数量变化、界面验收项数、真实远端结果、发现并修复的问题、未验证项（明确列出本轮跳过的全部性能项）、待用户决定、建议的下一步（低负载性能会话：写操作 / 块操作 A/B / 外观阅读 / 分层内存 / 常驻 Git 子进程 / 阶段 2 改动的滚动复测；签名；macOS 最终复测；AI 真实模型冒烟；按 V2-D73 的决定是否启动 AI 第 3 期；发版指令）。
- 清理：删除 worktree（先删 junction）、%TEMP% 下本轮测试目录、AgentHub 测试分支（`ls-remote` 核对）、本轮写入的凭据（`cmdkey /list` 核对）；确认没有遗留的 Oris 测试进程、假模型服务与假命令行工具进程（结束进程被拦时列出 PID 与命令行交给用户）。不是本轮创建的 %TEMP%\oris-gui\pristine 与 %TEMP%\oris-perf\ 旧目录保留。
- 用中文向用户汇报：结论、每个阶段的提交、测试与构建、未验证项、待用户决定。

====================
六、需要停下来问用户的情况（其余情况不停）
====================
- 开工时工作区不干净，或 main 与 origin/main 分叉且有冲突；合入时与其他会话的提交冲突。
- 需要做会阻塞实现的产品决策，或需要修改已确认的决策（包括阶段 2 需要体验取舍）。
- 阶段 1 盘点发现“清理…”的实际行为超出上面的描述且修复会改变用户可见行为（例如需要去掉清理入口、改为不 prune）。
- 任何破坏性操作：rebase、force push（包括 --force-with-lease）、推送 tag、增删 remote、删除或重命名远端的非测试分支、`--no-verify`、删除用户数据。
- 需要签名证书、Apple 账号、真实 API Key 或任何凭据，或需要安装、卸载系统软件。
