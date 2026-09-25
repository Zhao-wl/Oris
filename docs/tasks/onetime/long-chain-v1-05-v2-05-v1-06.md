你在 Oris 项目（D:\Projects\Research\Oris，Tauri 2 + Rust + React/TS 的 Git 差异阅读桌面应用，远端 origin = github.com:Zhao-wl/Oris.git）中执行一个长链路任务：按顺序完成 **一期 05 → V2-05 → 一期 06 合并发布验收（Windows 与发布准备部分）** 三个阶段。始终用中文回答、写文档和写提交信息。尽量连续执行到底，只在“需要停下来问用户”列出的情况才停。

整体性能报告不在本长链内完成：一期 06 中的“性能报告”由后续的性能测试提示词（docs/tasks/onetime/release-performance.md）在最终版本上完成。本长链每个阶段只复测与它相关的预算行，保证不退步。

====================
一、前提（用户已确认）
====================
- 执行顺序按 V2-D17 / V2-D26：一期 05 → V2-05 → 一期 06。一二期合并为一次发布（V2-D19）。
- 用户授权：每个阶段功能验收通过后，用 `git merge --no-ff` 合入 main 并 `git push origin main`。不授权：打 tag、推送 tag、创建 GitHub Release、上传任何安装包、公开发布。
- macOS 真机：用户已在 macOS 真机上测试通过（2026-09-25）。记录如下，由用户填写：
  - 机型 / 芯片：＿＿＿＿；内存：＿＿＿＿；macOS 版本：＿＿＿＿
  - 被测构建（commit 或安装包 SHA-256）：＿＿＿＿
  - 覆盖范围（任务 / 验收 ID）：＿＿＿＿
  - 原始记录位置（截图、日志）：＿＿＿＿
  把以上内容原样写进相关任务文档与验证报告，标注“用户在 macOS 真机上验证，Oris 自动化未复核”。没有填写的项写“用户口头确认，范围未记录”，不要自行扩大范围。一期 06 要求验收“最终合并版本”，因此最终版本上的 macOS 复测仍列为待办，交给用户。
- 窗口图标（Windows / macOS）已由用户更新并推送到 origin/main，不用再改。
- 2026-09-25 已确认的决策：V2-D37（删除 amend，改为“提交并推送”勾选）、V2-D38–V2-D49（长链 12 项待决事项）。验收计划中与这些决策冲突的旧断言（例如 B07 中的 amend）按决策登记执行，并在报告中注明依据。

====================
二、开始前必做
====================
1. 通读：AGENTS.md（GUI 安全约束，必须遵守）；docs/README.md；docs/decisions/v1-decisions.md 与 docs/decisions/v2-decisions.md（全部，重点 V2-D17–V2-D20、V2-D26、V2-D29、V2-D37–V2-D49）；docs/specs/v1-product.md 与 docs/specs/v2-product.md；docs/architecture/v1-architecture.md 与 docs/architecture/v2-architecture.md；docs/validation/v1-acceptance.md 与 docs/validation/v2-acceptance.md；docs/tasks/README.md 与 docs/tasks/v2/README.md；各阶段的任务文档；docs/validation/long-chain-v1-04-v2-03-v2-04-summary.md（上一轮长链的经验与未验证项）。
2. 检查工作区：`git status` 必须干净。`git fetch origin` 后，main 必须等于 origin/main，或者只落后可快进。
3. 基线测试（在当前 main 上）：后端 124 通过 / 5 忽略；前端 186 通过（26 个文件）；`npx tsc -b` 通过。实测数字写入进度日志。每个阶段结束时不能少于这个数。
4. 建进度日志 artifacts/long-chain/progress-v105-v205-v106.md（artifacts/ 已被 gitignore）。每个里程碑都写入：分支、提交号、完成项、未完成项、下一步。上下文被压缩或中断后，先读这份日志再继续。
5. 【只问一次】向用户说明以下两项，请用户一次性答复：
   a. 每个阶段末尾要在本机启动 Oris 测试实例：会出现新窗口，通过 CDP 驱动，不抢焦点，不操作其他应用窗口。说明大约次数与时长，请用户对本会话内的这些启动一次性同意。不同意时跳过所有 GUI 验收，相关项记为“未运行”，其余工作继续。
   b. 阶段 3 是否允许在本机安装 Windows 安装包，做“安装 → 从开始菜单启动 → 卸载”测试。安装会写开始菜单和当前用户的卸载注册项。默认不允许：只构建安装包，把这一项交给用户手动执行，并提供检查清单。

====================
三、通用规则
====================
- 分支：每个阶段从最新的 main 创建分支，按里程碑提交。
  - 阶段 1：feat/v1-05；阶段 2：feat/v2-05；阶段 3：feat/v1-06-release。
  - 可以用 worktree（例如 D:\Projects\Research\Oris-v1-05），合入后删除。
- 合入流程：
  1. 阶段验收通过后先 `git fetch origin`。
  2. 如果 origin/main 有其他会话的新提交：用 `git merge --no-ff origin/main` 合进本地 main，不用 rebase。重跑全部测试，并查看新提交改了哪些文件，确认与本阶段不冲突。
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
  - 不修改系统显示缩放、系统主题等系统设置。高 DPI 用测试实例自己的 WebView2 参数（例如 `--force-device-scale-factor`）近似，并注明不是真实系统高 DPI。
- 测试数据只放在仓库外的临时目录（%TEMP%\oris-gui\、%TEMP%\oris-perf\），用 scripts/perf/generate-datasets.mjs 或 gui-fixtures.mjs 生成，用完删除。不在用户的真实仓库里制造改动。
- 性能复测：每个阶段复测与本阶段相关的预算行（见各阶段）。测量期间每 5 s 记录一次整机 CPU 与占用最高的前 5 个外部进程。外部进程合计占用超过 10% 并持续 10 s 以上时，这段数据作废并重测，最多重测 2 次；仍受干扰就如实记录“受干扰，未下结论”。不结束用户的任何进程。
- 不自己做产品决策：新的决策编号从 V2-D50 开始，只能列为“待用户决定”。实现中遇到分歧时：不阻塞的，按最保守、可逆的做法实现并登记；阻塞的，停下来问。
- 如实报告：不降低预算，不跳过验收，不伪造或挑选数据；没有测的写“未测”。
- 文档：每个阶段结束时更新任务文档的状态行、docs/tasks/README.md 或 docs/tasks/v2/README.md 的状态列，并新建验证报告 docs/validation/<阶段>-results.md。报告包含：实现版本、逐项验收结果、证据路径、平台与工具版本、与参考图 / 技术方案的差异、未验证项、待用户决定。

====================
四、阶段
====================

【阶段 1】一期 05 完整阅读体验与特殊文件（feat/v1-05）
依据：docs/tasks/05-diff-experience.md；v1-acceptance A06、A11、A12、A14 的阅读部分；docs/research/04-jetbrains-diff-behavior.md 与 docs/research/05-unaligned-diff-scroll.md；docs/validation/v2-06-results.md（字号、主题复用 V2-06 的设置，不另建入口）。
1. 先盘点现状：选区、同词、搜索、色标 viewport 已经提前实施。列出任务 05 范围中每一项的“已有 / 部分 / 缺失”，写进进度日志。
2. 补齐 R-DIFF：搜索、词 / 行高亮、空白处理、同步滚动、导航计数、上下文逐段 / 全部展开、软换行、复制、专注模式。计数、导航、高亮都用同一个阅读模型。
   - 空白处理只影响显示，不改仓库状态；当前的过滤规则在界面上可见。
   - 空白规则的默认值与选项如果决策登记中没有，按保守方案实现（默认不忽略），并登记为待用户决定。V2-05 会依赖这里的规则。
3. 内容：解码、EOL、无末尾换行、长行 / 大文件预算与明确降级；编码不支持时不能显示成“无变化”。
4. 特殊文件：其他二进制、SVG（按文本显示或只显示说明，不执行其中的脚本等主动内容）、LFS 指针、submodule gitlink。都要准确说明，不误报无变化，不自动下载、不初始化。图片能力复用任务 03，只核对主题、键盘、跨入口的一致性。
5. 键盘与可见焦点：主要路径可以全键盘完成；快捷键区分 Windows 与 macOS。
6. 测试：
   - 后端、前端单元测试，覆盖 A12 的直接断言（Unicode / 中文、CRLF / LF、无末尾换行、编码失败）。
   - 新增 scripts/perf/v1-05-acceptance.mjs，走 CDP 界面验收 A06、A11、A12。
   - 在同一构建上回归 v1-04、v2-03、v2-04（`--only local`）、v2-06、history-feedback 的界面验收，以及 `gui-probe --suite task03`。
7. 性能复测：已缓存 / 未缓存文件切换；典型 diff 滚动（连续 ≥10 s，P95 帧间隔 ≤33 ms）；大文本、大图片的计算与渲染时间；切换配色 / 字号 ≤100 ms 且不重建编辑器。每项 n ≥ 30。
8. 未验证项照实列出：Mac Retina、真实系统高 DPI、真实焦点。
9. 通过后合入 main 并推送。**未通过就停止整个长链并汇报**：V2-05 依赖这里的空白规则。

【阶段 2】V2-05 hunk 级暂存与丢弃（feat/v2-05）
依据：docs/tasks/v2/05-hunk-operations.md；v2-acceptance B15、B16、B17；v2-architecture 中的写通道、R-DISCARD 备份与撤销；V2-02 已有的 stage / discard 实现（src-tauri/src/git/ops/）。
1. 后端：patch 由 Rust 按原始字节生成，不使用前端解码后的文本来算 hunk 边界。
   - 执行前先 `git apply --check`；如果与显示时的 revision 不一致，拒绝执行并刷新。
   - hunk 丢弃纳入 R-DISCARD 的备份与撤销。
   - 走 OperationRunner 的 preflight（锁、进行中状态、外部 index.lock、合并进行中的限制等），不自动重试。
2. 前端：显示的 hunk 与 Rust patch 一一对应，对应不上的 hunk 不显示操作按钮，并说明原因。
   - 并排与统一视图都可用。
   - 禁用条件：“全部”范围、忽略空白模式、冲突、二进制、子模块、仅 mode 变化、超出内容预算，每种都给出说明。
   - 写操作后刷新，保持阅读位置。
3. 测试：B15 每个场景（CRLF、末尾无换行、相邻 hunk、非 UTF-8、显示后被外部修改而被 `--check` 拒绝、各禁用条件）。
   - 每个场景都用操作前后的 `git diff` / `git diff --cached` 输出，证明只有目标 hunk 被移动或丢弃；并附工作区、index、refs、stash、config 的前后指纹。
   - B16、B17 回归。
   - 新增 scripts/perf/v2-05-acceptance.mjs 做界面验收；回归阶段 1 列出的界面验收，外加 v1-05。
4. 性能复测：hunk 暂存的乐观反馈与 Git 确认时延（参照 stage 单文件 ≤50 ms / P95 ≤500 ms，只作参照，不是新预算）；每种 hunk 操作后刷新启动的 Git 进程数（记录）；文件切换类预算不退步。
5. 通过后合入 main 并推送。**未通过就停止整个长链并汇报**：一期 06 依赖 V2-01–V2-05 全部通过。

【阶段 3】一期 06 合并发布验收：Windows 与发布准备（feat/v1-06-release）
依据：docs/tasks/06-performance-release.md；v1-acceptance §5；v2-acceptance §5；docs/validation/v2-01-results.md 中“已知限制与未验证”留给 06 的门禁。
1. 追溯矩阵：新建 docs/validation/v1-06-release-results.md，逐项列出 A01–A15 与 B01–B22。每项写明：
   - 在本阶段最终构建上的证据（脚本、报告路径、构建 SHA-256）；
   - 结果：通过 / 失败 / 未运行 / 待性能测试 / 待 macOS / 待签名。
   旧版本的结果不能替代，必须在最终构建上重跑。
2. 在最终构建上重跑全部已有的自动化：后端、前端、tsc，以及所有界面验收脚本（v1-04、v2-02、v2-03、v2-04 local、v2-05、v1-05、v2-06、history-feedback、gui-probe task03）。
   - 脚本因已确认的决策而过期（例如 v2-02-acceptance 中的 amend，V2-D37 已删除）时，按决策更新脚本，并在报告中说明，不当作产品回归。
   - 覆盖不到的验收 ID，补脚本或写明“未运行”及原因。
3. 真实远端（B12，AgentHub）回归一次，规则同上一轮长链：
   - 只创建 `oris-test/<运行编号>/` 下的分支，结束后删除；不碰 main 和已有分支。
   - 不改全局 / 系统 Git 配置；HTTPS 克隆只在自身 .git/config 设置 `credential.https://github.com.username=Zhao-wl`；不读取、不输出凭据；不在弹窗中输入。
   - 测试实例从 Bash 工具启动（PowerShell 工具带 `GCM_INTERACTIVE=never` 等变量，不代表正常桌面启动）；SSH 核对远端用 PowerShell。
   - 开始前先告知用户。
4. Git 发现与版本：GUI 启动时的系统 Git 发现、手动指定路径、缺 Git、低于 2.31.0 的不支持版本，都给出明确提示。
   - 用测试实例自己的环境变量（PATH、设置文件）模拟，不修改系统 PATH，不安装或卸载 Git。
5. 安装包：
   - 用 Tauri bundler 构建 Windows 安装包，处理 WebView2 依赖。没有签名证书时输出“内部测试包（未签名）”，06 的签名项记为“阻塞：缺证书”。
   - 不在仓库、日志、报告中写入任何证书或密钥。不上传任何产物。
   - 安装 / 卸载测试按“开始前必做”第 5b 项的答复执行。卸载后确认用户仓库未被删除；应用数据是否保留，写进发行说明。
6. 许可证与版本：
   - 生成第三方依赖许可证清单（Cargo 与 npm）。优先用本机已有的工具或 `cargo metadata` / package-lock.json 自行汇总；不从不可信来源下载工具。
   - 核对 V2-06 要求的 VS Code 与 Colorsublime 许可声明已进入安装包。
   - 记录版本号与各产物的 SHA-256。
7. 发行说明 docs/release/release-notes.md（草稿，不发布），包含：
   - 支持平台：Win11 x64、macOS 14+ arm64；不提供 Intel / Universal / Windows ARM64 原生包。
   - Git 基线 2.31.0。
   - 安全边界（按 v2-acceptance §5 的表述）。
   - 内容预算、已知限制、安装与卸载、无自动更新、应用数据位置。
8. macOS 交接清单 docs/release/macos-checklist.md：给用户在最终版本上执行，包括 DMG 构建、签名与公证、macOS 14 / M1 下限与一个较新版本的 smoke、osxkeychain / ssh-agent 远端、需要复测的验收 ID。
9. 本阶段不做整体性能报告，只确认阶段 1、2 的复测没有退步；06 的性能项在追溯矩阵中标“待性能测试”。
10. 修复本阶段发现的实际缺陷，不追加产品功能。功能验收通过后合入 main 并推送。
    - 06 的任务状态写 “Awaiting acceptance（待性能测试、签名、macOS 最终版本复测）”，不写 Done。

====================
五、收尾
====================
- 在最终 main 上重跑全部测试与 release 构建，记录 SHA-256。
- 写 docs/validation/long-chain-v1-05-v2-05-v1-06-summary.md，内容包括：各阶段结果与合入提交、测试数量变化、界面验收项数、性能复测数据与负载记录、真实远端结果、发现并修复的问题、未验证项、待用户决定、建议的下一步（性能测试提示词、签名、macOS 最终复测）。
- 清理：删除 worktree、%TEMP% 下本轮的测试目录、AgentHub 测试分支（用 SSH `ls-remote` 核对只剩开工时的引用）；确认没有遗留的 Oris 测试进程。
- 用中文向用户汇报：结论、每个阶段的提交、测试与构建、未验证项、待用户决定。

====================
六、需要停下来问用户的情况（其余情况不停）
====================
- 开工时工作区不干净，或 main 与 origin/main 分叉且有冲突；合入时与其他会话的提交冲突。
- 需要做会阻塞实现的产品决策，或需要修改已确认的决策。
- 任何破坏性操作：rebase、force push（包括 --force-with-lease）、推送 tag、增删 remote、删除或重命名远端的非测试分支、`--no-verify`、删除用户数据。
- 需要签名证书、Apple 账号、任何凭据，或需要安装、卸载系统软件（第 5b 项已同意的安装测试除外）。
- 阶段 1 或阶段 2 未通过（按上文停止长链）。
