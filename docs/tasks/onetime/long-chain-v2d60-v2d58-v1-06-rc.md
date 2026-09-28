你在 Oris 项目（D:\Projects\Research\Oris，Tauri 2 + Rust + React/TS 的 Git 差异阅读桌面应用，远端 origin = github.com:Zhao-wl/Oris.git）中执行一个长链路任务：按顺序完成 **历史页后台重读合并（V2-D60）→ 字号切换优化（V2-D58）→ 一期 06 最终发布候选复验（含 AI 功能纳入发布）** 三个阶段。始终用中文回答、写文档和写提交信息。尽量连续执行到底，只在“需要停下来问用户”列出的情况才停。

背景：一期 06 的发布验收（最终构建 `7434C750…`，源码 `a0264fd`）与发布性能测试（被测 `ae08225`）之后，main 又合入了约 2,600 行产品代码：`bec460f` AI 提交辅助、`94813d4` AI 统一操作入口、`8cee887` 文件树行高统一为 32px、`02a2760` 宽图片预算说明、`02e5b03` ai_context 测试构建修复。AI 功能目前没有写进产品规格、决策登记、验收计划、发行说明和许可证说明之外的任何发布文档，现有追溯矩阵与性能报告都不代表当前 main。本长链修复两项已登记的已知问题，然后在最终版本上重做发布验收。

====================
一、前提（用户已确认）
====================
- 2026-09-28 用户决定：**AI 功能（AI 提交辅助与 AI 统一操作入口）纳入本次发布**。开工后先把这一条登记为 V2-D64（“用户已确认（2026-09-28）”）。
- 一二期合并为一次发布（V2-D19）。已确认的决策 V2-D37–V2-D63 全部有效；V2-D58（字号切换已知问题）、V2-D60（历史页后台重读另开任务）就是本长链阶段 2、阶段 1 的来源；V2-D61 的写操作预算是阶段 1、3 的复测标准。
- 用户授权：每个阶段验收通过后，用 `git merge --no-ff` 合入 main 并 `git push origin main`。不授权：打 tag、推送 tag、创建 GitHub Release、上传任何安装包、公开发布。
- 不在本长链内：Windows 代码签名与 macOS 签名 / 公证（缺证书）、最终版本的 macOS 真机复测、Windows 安装 / 卸载实测（除非开工时用户另行同意）。这些在报告中列为用户待办。
- 用户已在 macOS 真机上验证过（2026-09-25，用户口头确认，范围未记录）；最终版本（含 AI）的 macOS 复测仍是用户待办，不要扩大这条记录的范围。

====================
二、开始前必做
====================
1. 通读：AGENTS.md（GUI 安全约束，必须遵守）；docs/README.md；docs/decisions/v1-decisions.md 与 docs/decisions/v2-decisions.md（全部，重点 V2-D10、V2-D19、V2-D28、V2-D29、V2-D37、V2-D50–V2-D63）；docs/specs/v1-product.md 与 docs/specs/v2-product.md；docs/architecture/v2-architecture.md 与 docs/architecture/ai-command-center.md；docs/validation/v1-acceptance.md 与 docs/validation/v2-acceptance.md；docs/tasks/README.md、docs/tasks/v2/README.md、docs/tasks/06-performance-release.md；docs/validation/v1-06-release-results.md、docs/validation/v1-06-performance.md（重点“瓶颈与修复”“写操作时延与 Git 进程数”）；docs/validation/long-chain-v1-05-v2-05-v1-06-summary.md（上一轮长链的经验与未验证项）；docs/release/ 下全部文件。
2. 检查工作区：`git status` 必须干净。`git fetch origin` 后，main 必须等于 origin/main，或者只落后可快进。
3. 基线测试（在当前 main 上）：后端 `cargo test --no-default-features --lib`、前端 vitest、`npx tsc -b`。上一轮结束时为后端 140 通过 / 5 忽略、前端 218（30 个文件）；之后合入的 AI 提交带了新用例，以本次实测为准写入进度日志。每个阶段结束时不能少于基线。
4. 建进度日志 artifacts/long-chain/progress-rc.md（artifacts/ 已被 gitignore）。每个里程碑都写入：分支、提交号、完成项、未完成项、下一步。上下文被压缩或中断后，先读这份日志再继续。
5. 【只问一次】向用户说明以下三项，请用户一次性答复：
   a. 每个阶段末尾要在本机启动 Oris 测试实例：会出现新窗口，通过 CDP 驱动，不抢焦点，不操作其他应用窗口。说明大约次数与时长（阶段 3 含 11 个以上界面套件与性能复测，约数小时），请用户对本会话内的这些启动一次性同意。不同意时跳过所有 GUI 验收，相关项记为“未运行”，其余工作继续。
   b. 阶段 3 的 AgentHub 真实远端回归（B12）需要从 Bash 工具启动测试实例、执行 git / ssh 命令。上一轮这些命令被会话的自动权限分类器拦截，请用户开工前在会话权限中放行。被拦截时不用其他方式绕过，B12 记为“未运行（权限拦截）”，继续后续工作。
   c. 阶段 3 的 AI 验收会让测试实例把一个测试用 API Key（本轮生成的随机字符串，不是任何真实服务的密钥）写入 Windows 凭据管理器，条目为 `Oris AI` / `oris-test-<运行编号>`，结束时删除并用 `cmdkey /list` 核对。请用户同意；不同意时 AI 的端到端界面验收记为“未运行”，只做单元测试与假模型服务的后端测试。
   默认不做安装 / 卸载测试；用户在本次答复中主动同意时，按上一轮长链阶段 3 第 5 项的规则执行。

====================
三、通用规则
====================
- 分支：每个阶段从最新的 main 创建分支，按里程碑提交。
  - 阶段 1：fix/history-reread；阶段 2：perf/font-size-switch；阶段 3：feat/v1-06-rc。
  - 可以用 worktree（例如 D:\Projects\Research\Oris-rc），合入后删除。worktree 里需要 node_modules 时用 junction 指向主仓库，删除 worktree 前先删除 junction。
- 合入流程：
  1. 阶段验收通过后先 `git fetch origin`。
  2. 如果 origin/main 有其他会话的新提交：用 `git merge --no-ff origin/main` 合进本地 main，不用 rebase。重跑全部测试，并查看新提交改了哪些文件，确认与本阶段不冲突。**新提交如果改动了产品代码，阶段 3 必须在包含它们的构建上验收。**
  3. 再 `git merge --no-ff <阶段分支>`，推送后核对 `git rev-parse main origin/main` 一致。
  4. 合并有冲突时停下来问用户。
- 工具链（Windows，GNU Rust）：
  - desktop / release 构建与 `cargo check` 一律在 PowerShell 中执行（Git Bash 下 windres 会失败）。当前进程的 PATH 前面加 `D:\Tools\Rust\mingw-binutils\mingw64\bin`，后面加 `;D:\Tools\Rust\msys2\msys64\mingw64\bin`，不修改系统环境。
  - 后端测试：在 src-tauri 目录执行 `cargo test --no-default-features --lib`，`CARGO_TARGET_DIR` 指向仓库外，例如 `D:\Projects\Research\Oris-builds\<阶段>\target-test`。**不要去掉 `--no-default-features`**：带 desktop 特性的测试程序会以 `STATUS_ENTRYPOINT_NOT_FOUND` 启动失败，那是命令用错，不是代码问题。
  - desktop 检查：`cargo check`（默认特性），`CARGO_TARGET_DIR` 指向 `...\<阶段>\target-check`，要求没有警告。
  - 前端：`npx tsc -b`；`npx vitest run`。
  - release：`scripts/build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\<阶段>`。不要给这个脚本加 `*>&1` 之类的重定向，那样会破坏构建。记录 oris.exe 的 SHA-256，并确认 `verify_release_entry` 通过。
  - 提交信息含中文弯引号时，PowerShell 会拆坏 `-m` 参数：把提交信息写到文件，再用 `git commit -F <文件>`。
  - 用脚本批量改文件时，先用写文件工具把脚本写到磁盘再执行，不要用 bash heredoc（`\n`、`\t` 会被改掉）。文件保持 LF 行尾（见 .gitattributes）。
- GUI：严格遵守 AGENTS.md。
  - 开工前复查 scripts/focus-task02-window.ps1 与 scripts/task02-feedback-*.mjs 中的危险调用。
  - 只通过 scripts/perf/gui-lib.mjs 的 `launchOris` 启动并核验自己的实例（PID、exe 完整路径、主窗口句柄、CDP 端口归属），用独立的 `WEBVIEW2_USER_DATA_FOLDER` 与 `ORIS_APP_CACHE_DIR`。
  - 禁止调用 SetForegroundWindow、ShowWindow、AppActivate；不碰任何其他应用的窗口。结束时用 `killOris` 正常关闭，并清理本轮的临时目录。
  - 报告中区分“CDP 页面事件”和“真实鼠标、键盘与 Windows 焦点”：前者不能当作后者的证据。
  - 不修改系统显示缩放、系统主题等系统设置。
- 测试数据只放在仓库外的临时目录（%TEMP%\oris-gui\、%TEMP%\oris-perf\），用 scripts/perf/generate-datasets.mjs 或 gui-fixtures.mjs 生成，用完删除。不在用户的真实仓库里制造改动。
- 性能复测：每个阶段复测与本阶段相关的预算行（见各阶段），每项 n ≥ 30。测量用 scripts/perf/load-monitor.mjs 每 5 s 记录整机 CPU 与占用最高的前 5 个外部进程。外部进程合计占用超过 10% 并持续 10 s 以上时，这段数据作废并重测，最多重测 2 次；仍受干扰就如实记录“受干扰，未下结论”。写操作自身触发的 Defender 扫描按发布性能测试的做法：逐轮检测、受干扰轮次单独统计。不结束用户的任何进程。
- 不自己做产品决策：新的决策编号从 V2-D65 开始（V2-D64 为上文的 AI 纳入发布），只能列为“待用户决定”。实现中遇到分歧时：不阻塞的，按最保守、可逆的做法实现并登记；阻塞的，停下来问。
- 如实报告：不降低预算，不跳过验收，不伪造或挑选数据；没有测的写“未测”。
- 文档：每个阶段结束时更新相关任务文档的状态行与 docs/tasks/README.md 或 docs/tasks/v2/README.md 的状态列，并新建验证报告（阶段 1：docs/validation/v2-d60-history-reread-results.md；阶段 2：docs/validation/v2-d58-font-size-results.md；阶段 3：docs/validation/v1-06-rc-results.md）。报告包含：实现版本、逐项验收结果、证据路径、平台与工具版本、与技术方案的差异、未验证项、待用户决定。

====================
四、阶段
====================

【阶段 1】合并写操作后的历史页后台重读（fix/history-reread，V2-D60）
依据：docs/validation/v1-06-performance.md“瓶颈与修复”第 2 项与“写操作时延与 Git 进程数”；V2-D61；v2-architecture 中“只刷新受影响维度”的刷新模型；V1 04 历史页实现。
1. 先复现并定位：历史页打开过一次后切回“提交”页，执行 fetch、pull、push、merge、切换分支、stash push / pop、提交，用 `GIT_TRACE2_EVENT` 记录每次操作后 1.5 s 内的 Git 命令，列出每一次历史重读由哪个事件 / 订阅触发（写进进度日志）。现象：每个改变 refs 的操作重读历史 3–4 次，每次约 12 个命令（`config` ×3、`for-each-ref` ×2、`log`、`rev-parse`、`show`、`diff-tree`、`remote`、`symbolic-ref` 等）。
2. 修复目标：
   - 一次写操作最多触发 1 次历史重读；历史页不可见时只标记失效，切回历史页时再读（保持切回时数据正确，不显示过期 refs）。
   - 同一次刷新内相同的只读命令不重复执行（例如 `config`、`remote`、`symbolic-ref` 的结果在一次刷新内复用）。
   - 不改变历史页可见行为：选中提交、滚动位置、筛选 / 搜索、“跳到 HEAD”（V2-D39）、文件历史（V2-D40）在写操作后仍然正确。
   - 不引入新的缓存失效风险：refs 真的变化时必须更新；外部终端改变 refs 时的行为与修复前一致。
3. 测试：
   - 单元测试覆盖合并 / 去重逻辑与“不可见时只标记失效”。
   - 新增或扩展进程计数脚本（可复用 scripts/perf/v1-06-write-latency.mjs 的 `--trace`），输出每种操作修复前后的 Git 进程数对比表。
   - 回归 v1-04、v2-03、v2-04（`--only local`）、history-feedback 界面验收。
4. 性能复测：V2-D61 的写操作预算全部重测（fetch、pull 仅快进、push、stash pop P95 ≤ 1.5 s；merge 快进、切换分支 20 个文件、stash push P95 ≤ 1 s）；热项目切换、切换显示区域（不启动 Git 进程）不退步。
5. 通过后合入 main 并推送。未能在不改变可见行为的前提下完成时，不合入，记录定位结果，继续阶段 2（V2-D60 保持已知问题）。

【阶段 2】切换字号优化（perf/font-size-switch，V2-D58）
依据：docs/validation/v1-06-performance.md（切换字号 P95 160.4 ms，场景为滚动到 3,000 行文件中部的并排 diff）；docs/validation/v1-05-results.md“性能复测”中的定位；docs/validation/v2-06-results.md；scripts/perf/v1-05-acceptance.mjs `--only perf` 与 scripts/perf/appearance-probe.mjs `--scrolled`。
1. 先用 `appearance-probe --scrolled` 与 Performance trace 把一次字号切换拆成：设置写入与派发、CSS 变量生效、CodeMirror 重新测量、同步滚动 / 对齐重算、块标题行与装饰、绘制。数据写进进度日志，找出主要耗时段。
2. 只做不改变体验的技术优化，例如：避免重复测量与强制同步布局、合并多次派发、推迟视口外的装饰重算、减少对齐层的全量重算。字号切换后阅读位置、对齐、换行、块标题行、搜索高亮都必须与优化前一致。
3. 目标：滚动场景 P95 ≤ 100 ms，且不重建编辑器；60 行文件快捷键场景、切换配色（94.2）、切换主题模式（89.3）不退步。
4. 需要体验取舍（例如切换后短暂不对齐、降低动画或精度）或调整预算才能达标时，**停下来问用户**。纯技术手段做不到时，如实记录最好结果，V2-D58 保持已知问题，不停长链。
5. 测试：单元测试覆盖改动的逻辑；回归 v1-05（阅读 42 项，含字号预算项）、v2-06、v2-05 界面验收。
6. 性能复测：字号 / 配色 / 主题模式的滚动场景与 60 行场景；典型 diff 滚动（连续 ≥ 10 s，P95 帧间隔 ≤ 33 ms）；已缓存 / 未缓存文件切换。
7. 优化有效且没有退步时合入 main 并推送。

【阶段 3】一期 06 最终发布候选复验，含 AI 功能（feat/v1-06-rc）
依据：docs/tasks/06-performance-release.md；v1-acceptance §4–§5；v2-acceptance §3–§5；docs/architecture/ai-command-center.md（§1 边界、§6 执行与校验、§8 第 1–2 期验收重点）；docs/validation/v1-06-release-results.md（上一版追溯矩阵）。

3.1 AI 功能进入发布文档（先做，再验收）
1. 盘点已实现的 AI 能力（以源码为准：src-tauri/src/ai.rs、src-tauri/src/lib.rs 中的 AI 命令、src/AiCommitDialog.tsx、src/ai-actions.ts、src/ai-prompt-tags.ts、src/ai-shortcut.ts、src/settings/model.ts 的 `ai` 分类、App.tsx 中的统一入口），写进进度日志：提供方（codex / claude 命令行工具，OpenAI、Anthropic、DeepSeek、兼容接口）、模型列表、密钥存储、网络请求的时机与内容、执行白名单、取消与超时、快捷键。
2. 在 docs/specs/v2-product.md 新增需求 R-AI（范围只写已实现的能力，不写 ai-command-center.md 中尚未实现的第 3–4 期），在 v2-architecture 引用 ai-command-center.md，并把后者的“状态”更新为与发布一致。
3. 在 docs/validation/v2-acceptance.md 新增 AI 验收项（从 B23 开始编号），至少覆盖：
   - 未配置 AI 时：启动与日常使用不发出任何网络请求，不启动任何 AI 命令行工具；入口可见但给出配置说明。
   - 密钥只存系统凭据存储（Windows 凭据管理器 / macOS 钥匙串），不出现在设置文件、localStorage、日志、快照、崩溃信息中；删除配置时同时删除凭据。
   - 发送给模型的内容范围与界面说明一致（哪些 diff、文件列表、提交信息会被发送）；超出内容预算时如何截断。
   - `@标签` 本身不触发写入；无标签的误判不触发白名单之外的动作；模型返回无效 / 越权 / 不存在的 pathId / 过期 revision 的计划时在执行前拦下并说明，不部分执行。
   - Git 写入只经 OperationRunner（preflight、锁、进行中状态检查与普通按钮相同），不向模型提供任意 shell、Git 参数、文件写入或 IPC。
   - 命令行工具以只读沙箱运行（codex `--sandbox read-only`、claude `--tools ""` 等），工作目录为临时目录，不在用户仓库中运行。
   - 关闭规划框 / 取消能中止模型调用（HTTP 与命令行工具进程都结束）；超时（HTTP 15 s / 120 s，命令行 300 s）给出中文说明；网络错误、401、限流、模型输出不是有效 JSON 时给出中文说明，不自动重试。
   - AI 提交后的仓库状态与手动提交相同（B16、B17 对 AI 路径同样成立）。
4. 以下是现有实现已有的产品含义，**不修改实现**，按现状写进文档，并逐条登记为“待用户决定（按现有实现先行）”，编号从 V2-D65 起：
   - 有效计划直接执行，不做二次确认（与 R-SAFE 中“写操作前说明影响”的关系需要用户确认）。
   - 产品引入可选的外部云服务（模型服务）；与 V1 任务通用约定“不添加云服务”的关系，限定为“用户主动配置后才联网”。
   - 支持的提供方列表与默认模型；兼容接口允许任意 base URL（包括 http）。
   - 发给模型的数据范围与隐私说明的文字。
   - ai-command-center.md §9 中的两项待决定（多步计划、自定义 SOP）维持“本次发布不做”。
   发现实际缺陷（例如密钥写入了日志、取消后进程未结束、越权计划被执行）属于修复范围，直接修，不需要问。
5. 发行说明补“AI 功能”一节：可选、默认未配置、需要用户自己的模型服务或已安装的 codex / claude 工具、会发送哪些数据、密钥存放位置、直接执行的范围与限制。

3.2 AI 验收
1. 后端：为 HTTP 路径建一个只监听 127.0.0.1 的假模型服务（测试代码内启动，不下载工具），用“兼容接口”配置指向它，脚本化返回：有效计划、无效 JSON、越权动作、不存在的 pathId、过期 revision、慢响应（测取消与超时）、401、429。命令行路径用临时目录中的假可执行文件（记录收到的参数与工作目录，输出预设结果），核对沙箱参数与工作目录。**不调用任何真实模型服务、不启动用户已安装的 codex / claude、不读取用户已有的 AI 配置或凭据。**
2. 界面：新增 scripts/perf/v1-06-ai-acceptance.mjs，走 CDP：打开入口（按钮与 Ctrl+P）、标签候选与提示词注入、有效计划直接执行（暂存 / 取消暂存 / 提交 / 切换分支 / 设置类）、各类拦截、取消、错误说明、AI 提交后 B16 / B17 前后指纹。测试密钥按“开始前必做”第 5c 项的答复处理，只写 `oris-test-<运行编号>` 条目，结束时删除并核对。
3. 网络核对：在未配置 AI 的测试实例中完成一轮 v1-06-projects 流程，用进程级手段（例如 `Get-NetTCPConnection -OwningProcess` 针对测试实例及其子进程）确认没有对外连接；不安装抓包驱动、不改系统设置。
4. 资源：AI 引入了 reqwest / tokio / keyring。复测 V2-D29 分层内存（5 项目前台稳态 Oris 自身 ≤ 15 MiB、总开销 ≤ 210 MiB 等），并记录安装包与 oris.exe 体积变化。
5. 真实模型的冒烟（用户自己的 API Key 或 codex / claude 账号）列为用户待办，写进交接清单，不在本长链执行。

3.3 最终构建上的全量复验
1. 追溯矩阵：新建 docs/validation/v1-06-rc-results.md，逐项列出 A01–A15、B01–B22 与新增 AI 验收项。每项写明本阶段最终构建上的证据（脚本、报告路径、构建 SHA-256）与结果：通过 / 失败 / 未运行 / 待 macOS / 待签名。上一版矩阵的结果不能替代。
2. 在最终构建上重跑全部已有自动化：后端、前端、tsc，以及界面套件 v1-04、v2-02、v2-03、v2-04 local、v2-05、v1-05、v2-06、history-feedback、gui-probe（task03、core / restart / trace）、v1-06-projects、v1-06-git-discovery、v1-06-ai-acceptance。
   - 文件树行高改为 32px（`8cee887`）：确认虚拟列表测量、滚动定位、恢复阅读状态、操作按钮布局没有回归；脚本里写死的旧行高按新值更新，并在报告中说明，不当作产品回归。
   - 脚本因已确认的决策而过期时，按决策更新脚本并说明。
3. 真实远端（B12，AgentHub `git@github.com:Zhao-wl/AgentHub.git`，账号 Zhao-wl）回归一次：
   - 开始前先告知用户；只创建 `oris-test/<运行编号>/` 下的分支，结束后删除；不碰 main 和已有分支。
   - 不改全局 / 系统 Git 配置；HTTPS 克隆只在自身 .git/config 设置 `credential.https://github.com.username=Zhao-wl`；不读取、不输出凭据；不在弹窗中输入。
   - 测试实例从 Bash 工具启动（PowerShell 工具带 `GCM_INTERACTIVE=never` 等变量，不代表正常桌面启动）；SSH 核对远端用 PowerShell。
   - 命令被权限拦截时不绕过，B12 记为“未运行（权限拦截）”。
4. 性能复测（发布性能测试中受影响的行，方法与口径同 docs/validation/v1-06-performance.md，与其数据并列对比）：首次打开、重启到快照、热项目切换、切换显示区域、已缓存 / 相邻预取 / 未缓存文件切换、典型 diff 滚动、stage / unstage / commit、V2-D61 全部写操作与块操作、字号 / 配色 / 主题模式、打开设置、5 项目分层内存与 200 次混合切换、常驻 Git 子进程。新增记录（无预算，只记录）：打开 AI 入口到可输入的时延、AI 计划执行到界面刷新完成的时延（假模型服务，扣除模型响应时间）。L 数据集只在上述行有明显退步时重跑。
5. 安装包：用 Tauri bundler 重新构建 Windows NSIS 内部测试包（未签名，不构建 MSI，不上传）；签名项记为“阻塞：缺证书”。确认 THIRD-PARTY-NOTICES 与安装包资源包含最新依赖。
6. 许可证：依赖若有变化，按上一轮的方法重新生成 docs/release/third-party-licenses.md，核对 MPL-2.0 依赖是否仍为 V2-D63 登记的 5 个；新增的 MPL / GPL / 未知许可证列为待用户决定。
7. 发行说明（docs/release/release-notes.md，仍为草稿）：已知问题按阶段 1、2 的结果更新（修复了的删除，未修复的保留 V2-D58 / V2-D59 / V2-D60 的表述）；加入 AI 一节；更新版本与产物 SHA-256。
8. macOS 交接清单与 Windows 安装交接清单：补 AI 相关检查（钥匙串 / 凭据管理器、真实模型冒烟、未配置时不联网）与本次最终构建信息。
9. 修复本阶段发现的实际缺陷，不追加产品功能。功能验收通过后合入 main 并推送。06 的任务状态写“Awaiting acceptance（待签名、macOS 最终版本复测、安装 / 卸载实测、AI 真实模型冒烟）”，不写 Done。

====================
五、收尾
====================
- 在最终 main 上重跑全部测试与 release 构建（全新输出目录 Oris-builds\final-main-rc），记录 SHA-256，并说明与阶段 3 验收构建的源码是否相同。
- 写 docs/validation/long-chain-v2d60-v2d58-v1-06-rc-summary.md，内容包括：各阶段结果与合入提交、测试数量变化、界面验收项数、性能复测数据（与发布性能测试并列）与负载记录、真实远端结果、AI 验收结果、发现并修复的问题、未验证项、待用户决定、建议的下一步（签名、macOS 最终复测、安装 / 卸载实测、AI 真实模型冒烟、发布指令）。
- 清理：删除 worktree（先删 junction）、%TEMP% 下本轮的测试目录、AgentHub 测试分支（用 SSH `ls-remote` 核对只剩开工时的引用）、本轮写入的 `Oris AI` / `oris-test-*` 凭据（`cmdkey /list` 核对）；确认没有遗留的 Oris 测试进程、假模型服务进程与假命令行工具进程。不是本轮创建的 %TEMP%\oris-gui\pristine 与 %TEMP%\oris-perf\ 旧目录保留。
- 用中文向用户汇报：结论、每个阶段的提交、测试与构建、未验证项、待用户决定。

====================
六、需要停下来问用户的情况（其余情况不停）
====================
- 开工时工作区不干净，或 main 与 origin/main 分叉且有冲突；合入时与其他会话的提交冲突。
- 需要做会阻塞实现的产品决策，或需要修改已确认的决策（包括阶段 2 需要体验取舍或调整预算）。
- AI 盘点中发现现有实现与 ai-command-center.md §1 的安全边界相冲突、且修复会改变用户可见行为（例如需要恢复二次确认、收窄可执行动作）。
- 任何破坏性操作：rebase、force push（包括 --force-with-lease）、推送 tag、增删 remote、删除或重命名远端的非测试分支、`--no-verify`、删除用户数据。
- 需要签名证书、Apple 账号、真实 API Key 或任何凭据，或需要安装、卸载系统软件（第 5 项已同意的除外）。
