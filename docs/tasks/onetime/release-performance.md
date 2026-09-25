你在 Oris 项目（D:\Projects\Research\Oris，Tauri 2 + Rust + React/TS 的 Git 差异阅读桌面应用，远端 origin = github.com:Zhao-wl/Oris.git）中执行 **一二期合并发布的 Windows 性能测试**，也就是一期任务 06 的“性能报告”部分。始终用中文回答、写文档和写提交信息。

被测版本：执行时 origin/main 的最新提交（预期已包含一期 05、V2-05 与一期 06 的发布准备）。开始时把 commit 记录下来；测量期间如果 main 又有新提交，不切换被测版本，只在报告中注明。

====================
一、目标与依据
====================
- 依据：docs/validation/v1-acceptance.md §4；docs/validation/v2-acceptance.md §3–§5（同一场景取两套预算中较严的一项）；docs/decisions/v2-decisions.md（V2-D10、V2-D28、V2-D29 等）；docs/tasks/06-performance-release.md。
- 可参考的历史结果：docs/validation/v2-baseline-v1.md、v2-01-results.md、v2-02-results.md（写操作时延与被干扰的 A/B）。
- 同时收掉以往被推迟的复测：
  - V2-01 预算在最终版本上是否退步；
  - `gui-probe --suite trace`：切换显示区域是否启动 Git 进程（V2-01 遗留）；
  - V2-D29 分层内存；
  - V2-02 写操作时延；
  - V2-03 / V2-04 / V2-05 写操作后刷新启动的 Git 进程数。
- 预算在测量前已固定，不得事后降低。没有预先预算的场景（stash、切换分支、pull / push / merge、hunk 操作）**只记录数据**，建议的预算列为“待用户决定”，不自行定为通过或失败。

====================
二、需要满足的预算（Windows，S 数据集，release 构建）
====================
| 场景 | 指标与预算 |
| --- | --- |
| 首次打开 | 到文件列表可交互 P95 ≤ 1.5 s |
| 再次打开（重启） | 窗口就绪到显示上次快照 P95 ≤ 300 ms；快照校验完成 P95 ≤ 1.5 s |
| 热项目切换 | 到可交互视图 P95 ≤ 100 ms |
| 后台 dirty 项目切回 | 到显示新鲜数据 P95 ≤ 800 ms |
| 切换显示区域 | P95 ≤ 50 ms，且不启动 Git 进程（trace 证明） |
| 已缓存 / 相邻预取的文件切换 | 到文本显示 P95 ≤ 100 ms |
| 未缓存常用文件 | 到首屏可读 P95 ≤ 400 ms |
| 典型 diff 滚动 | 连续 ≥10 s，P95 帧间隔 ≤ 33 ms，记录长帧 |
| 外部变化 | 最后一个文件事件到界面更新 P95 ≤ 1 s（需要真实前台焦点，见第四节） |
| stage / unstage 单文件 | 乐观反馈 ≤ 50 ms；Git 确认 P95 ≤ 500 ms |
| commit（无 hooks） | 到文件列表与分支状态刷新 P95 ≤ 1 s |
| 切换配色 / 主题模式 / 字号 | P95 ≤ 100 ms，且不重建编辑器 |
| 打开设置 | 到可交互 P95 ≤ 100 ms |
| 内存（V2-D29，私有工作集，5 项目热切换稳态） | 前台：外部框架与工具 ≤ 200 MiB，Oris 自身 ≤ 15 MiB，总开销 ≤ 210 MiB；失焦后：外部框架与工具 ≤ 130 MiB，总开销 ≤ 140 MiB |
| 长时间使用 | 200 次项目 / 文件 / 范围混合切换：外部框架与工具峰值 ≤ 220 MiB，总开销峰值 ≤ 230 MiB；静置 65 s 后不超过稳态的 115% |
| 常驻 Git 子进程 | 空闲 ≤ 5 个；关闭项目后 60 s 内回收 |
| 缓存上限 | BlobCache、DiffCache、快照持久化不超过技术方案 §7 的上限（用测试断言证明） |
| 10 项目对 5 项目 | 稳态增量主要来自轻量状态，每项目约 ≤ 2 MiB |

L 数据集（100,000 tracked 文件、100,000 提交、2,000 个变化文件、超长行、超大图片）：
- 要求有界加载、可以取消、不崩溃、缓存不无限增长；
- 记录 100,000 文件下 status 的时延，作为 V2-D10（fsmonitor）的决策依据。

每个响应场景 n ≥ 30，报告 P50 / P95 / 最大值和原始样本。冷启动与热启动分开；OS 文件缓存无法在不重启机器的情况下清空，如实说明测的是哪种状态。

====================
三、步骤
====================
1. 通读 AGENTS.md（GUI 安全约束，必须遵守），以及第一节列出的文档；阅读 scripts/perf/ 下已有的脚本：
   - gui-probe.mjs：core、restart、trace、task03、memory 套件；`all` 不含 memory，要单独指定；
   - v2-02-acceptance.mjs `--only latency`；
   - v2-06-acceptance.mjs 中的配色时延；
   - 各任务的滚动脚本；
   - generate-datasets.mjs；
   - gui-lib.mjs。
   能复用就复用；缺的场景（例如 V2-03 / V2-04 / V2-05 写操作时延与进程数）补进脚本，并在报告中说明新增了什么。
2. 【只问一次】告诉用户：
   - 预计总时长，按 S、L 数据集和内存套件分别估算；
   - 期间会反复启动 Oris 测试窗口（CDP 驱动，不抢焦点）；
   - 请用户在测量期间不要在本机运行重负载任务。
   请用户一次性同意。
3. 环境记录：
   - CPU 型号与核数、内存容量（参考机为 16 GB，实际不同时如实记录）、磁盘类型、Windows 版本与版本号；
   - 电源计划与是否接通电源：只记录，不修改；
   - Git 版本、WebView2 运行时版本、Node / Rust 版本、被测 commit、oris.exe 的 SHA-256。
4. 构建：在 PowerShell 中执行 `scripts/build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\perf-<日期>`。
   - PATH 前面加 `D:\Tools\Rust\mingw-binutils\mingw64\bin`，后面加 `;D:\Tools\Rust\msys2\msys64\mingw64\bin`。
   - 不要加 `*>&1` 重定向。
   - 确认 `verify_release_entry` 通过。
5. 数据集：用 generate-datasets.mjs 生成 S 与 L，放在 %TEMP%\oris-perf\ 下，记录生成参数与种子。
   - 生成 L 之前检查磁盘剩余空间并在日志中记录；空间不足时先告诉用户。
6. 负载监测（贯穿全程）：每 5 s 记录一次整机 CPU、可用内存，以及占用最高的前 5 个外部进程（不含本轮 Oris 测试实例及其子进程）。
   - 外部进程合计超过 10% 并持续 10 s 以上：这一段数据作废并重测，最多 2 次；
   - 仍受干扰：该项写“受干扰，未下结论”，附负载记录；
   - 不结束、不降低优先级用户的任何进程。
7. 测量顺序：
   1. S 数据集：core → restart → trace → 写操作时延（stage / unstage / commit，以及 stash、切换分支、hunk 操作，只记录）→ 配色 / 设置 → 滚动 → task03 图片 → memory（5 项目，含 200 次混合切换与静置 65 s）→ 10 项目对比。
   2. 最后跑 L 数据集。
   每个套件之间静置 30 s。
8. 可选对照：如果需要判断相对 V2-01 是否退步，从 V2-01 合入 main 的提交重新构建一个对照版本（git log 查找）。同一时段按 A B A B 交替测 core 套件，只作参考；发布结论以第二节的预算为准。
9. 预算未达标时：
   - 先用 trace、IPC 计时、进程树数据找到真实瓶颈，写进报告；
   - 在分支 perf/<问题简述> 上修复。只优化实现（并发与取消、过期结果、按需读取、虚拟列表、缓存淘汰等），不追加产品功能，不改预算，不隐藏结果或跳过真实计算；
   - 修复后跑全部测试（后端 `cargo test --no-default-features --lib`，不能去掉该参数；前端 `npx vitest run` 与 `npx tsc -b`），回归受影响的界面验收，再重测受影响的全部套件；
   - 修复需要在体验上取舍，或者需要修改预算时，停下来问用户。
10. 合入：修复分支通过后，`git fetch origin`；origin/main 有新提交就先 `git merge --no-ff origin/main`（不用 rebase），重跑测试，再 `git merge --no-ff` 修复分支，然后 `git push origin main`（用户已授权），核对 `git rev-parse main origin/main`。合并冲突时停下来问用户。纯文档提交同样按此流程合入。

====================
四、不能在本机自动验证的项
====================
- 真实前台焦点（外部变化时延、失焦后的低内存级别）：AGENTS.md 禁止抢焦点，也不能借用其他应用的窗口制造失焦。
  - 可以用环境变量强制级别等方式测量，但报告必须写明“非真实焦点切换”；
  - 真实焦点项记为“未验证”，并写一份用户可手动执行的步骤。
- macOS（M1 / 8 GB 参考机）性能：本机无法测，列为未运行，并写 macOS 下的测量清单交给用户。
- 16 GiB 参考机：本机配置不同时如实说明，不换算。

====================
五、输出
====================
- 报告：docs/validation/v1-06-performance.md，包含：
  - 结论；
  - 环境与版本；
  - 预算表（预算、P50 / P95 / 最大、结果）；
  - 内存分层与趋势；
  - L 数据集结果；
  - 各写操作的进程数；
  - 负载记录摘要与作废重测记录；
  - 发现的瓶颈与修复；
  - 与 V2-01 结果的对比；
  - 未验证项；
  - 待用户决定（例如新写操作的预算建议、V2-D10 是否启用 fsmonitor）。
- 原始数据：放在 artifacts/gui-probe/perf-<运行编号>/（本地，不入库）。另把每个场景的样本数组与环境信息汇总成一个 JSON，放到 docs/validation/data/v1-06-performance-<运行编号>.json 入库；超过 2 MB 就只入库汇总，并在报告中写明本地路径。
- 更新 docs/tasks/06-performance-release.md 与发布追溯矩阵 docs/validation/v1-06-release-results.md 中的性能项。06 在签名与 macOS 最终复测完成前不写 Done。
- 清理：删除 %TEMP%\oris-perf\ 与 %TEMP%\oris-gui\ 下本轮的数据与 profile；确认没有遗留的 Oris 测试进程；删除已合入的修复分支。
- 用中文向用户汇报：达标 / 未达标 / 未测的项目，关键数字，修复内容与提交，未验证项，待用户决定。

====================
六、规则摘要
====================
- GUI：只通过 gui-lib.mjs 的 `launchOris` 启动并核验自己的实例（PID、exe 完整路径、主窗口句柄、CDP 端口）；使用独立的 WEBVIEW2_USER_DATA_FOLDER / ORIS_APP_CACHE_DIR；禁止调用 SetForegroundWindow / ShowWindow / AppActivate；不操作其他应用的窗口；用 `killOris` 正常关闭。CDP 页面事件不是真实焦点证据。
- 不修改系统设置（电源计划、显示缩放、Defender 排除项等）；不安装软件；不结束用户进程。
- 不做 rebase、force push、推送 tag、发布；不用 `--no-verify`。
- 提交信息写到文件，用 `git commit -F`（PowerShell 会拆坏中文弯引号）。
- 如实报告：不降低预算，不挑选数据，不把受干扰或未测的项写成通过。
