# Issue #25 代码追溯验收报告

日期：2026-10-08（Asia/Shanghai）。基线：Oris 0.8.2，`4caedcb55d9aa97a31f3858fa4f68f29a7fb3608`。执行平台：Debian Linux 云环境，Git 真实临时仓库；前端 DOM 测试使用 jsdom。

## 用户入口与契约

- 原有单行提交信息、作者/SHA 跳转及文件历史保留；阅读器工具栏和行信息栏新增“代码追溯”，历史工具栏新增“历史内容搜索”，文件历史新增“追溯此文件”。
- 整文件归属每页 200 行，显式加载和前后翻页；使用原始字节对应的 UTF-8 阅读快照，未提交行独立标记。连续行段通过已有选中行初始化，再在独立面板设定起止行；未改写 DiffViewer 的选区/块操作。
- 新查询在 `trace-api.ts`；共享历史 API 仅增量导出。仓库身份通过注册表核验，历史端使用完整 OID，本地端携带并核验 revision/contentId、侧别、pathId、行号及内容字节 hash。分页绑定仓库和完整查询，内容搜索第一次解析引用 tip 后固定 OID，引用移动不改变后续页。
- 结果含实际提交及父 OID、前后 pathId、行段、增删片段。比较调用现有固定版本内容入口；捕获并恢复来源内容、比较设置、选中行和阅读视口的行锚点/偏移/水平位置。定位只滚动本轮阅读器，不调用系统窗口焦点 API。

## 结果与明确局限

- Blame 与真实 `git blame --line-porcelain --root` 的 OID、原始行号、最终行号、Unicode 重命名路径逐条比对通过。
- 行历史沿第一父节点回溯，跨 Git `-M` 检测的重命名；替换块以整个旧块回溯，明确标记范围推断。遇到未提交引入、删除、浅边界、缺对象、二进制/非 UTF-8 内容、无法唯一定位路径或扩展范围超过预算时说明原因，停止而不编造来源。合并的其他父节点不在此线性路线中，内容搜索检查所有父节点。
- 搜索针对区分大小写的单行字面文本，扫描各父节点的真实 patch 新增/删除行；测试包含标题含关键词而内容无关键词的反例，及实际引入、删除、合并提交。路径筛选匹配该次重命名两端，不声称能自动覆盖所有更早旧名称；全仓库搜索可覆盖旧路径。
- 浅克隆边界仍保留对象中的实际 parent，行历史停止；搜索跳过边界变化，不把边界原文冒充引入。缺对象不触发 lazy fetch。
- 内容搜索以“提交”作为分页完成单位，单个提交的匹配文件可使页面超过名义 20 文件；达到 200 文件硬上限会明确降级，不提供容易遗漏结果的下一页。每文件仅展示前 20 个命中片段，保留实际命中总数；比较可查看完整版本。

## 只读、取消及预算

全部查询使用 `--no-optional-locks`，关闭 fsmonitor、外部 diff、textconv 和 lazy fetch；本地比较仅写临时文件，并由 RAII 清理。真实 Git 测试逐字节比对查询前后的工作区、index、refs、对象和其他 `.git` 文件，无变化。

取消按仓库/requestId 隔离，允许取消先于请求登记；已完成/取消 ID 保留 60 秒，防止重用。每仓库最多两个活动追溯查询，独立于现有内容读取槽位；UI 切项目、切本地比较范围、关面板、改查询条件或取消时拒绝旧响应。比较往返另有代次，返回后迟到的定位不能改变恢复的位置。

每次查询 10 秒 / 8 MiB 累计 Git 输出；两个管道通过最多 8 个 8 KiB 块的有界队列读取，stderr 最多保留 64 KiB；取消/超预算 kill 并 wait 本请求创建的 Git 进程，再回收读线程。测试验证取消、期限耗尽、输出超预算后的本轮 PID 消失，不按名称结束其他进程。

行历史每次选取 1–1000 行、每页最多扫描 100 提交、累计 2000 提交；搜索每页 1–100 提交、累计 10000 提交、1–8 个引用。Blame 和搜索只保留当前页；行历史 UI 最多保留最近 200 个变化，片段截断有提示。无结果但仍有游标的页面明确表示还有未扫描历史。

## 自动测试

- `npm run build`：通过 TypeScript 与 Vite 构建；保留现有大 chunk 警告。
- `npm test`：47 文件、371 测试通过（含新增面板取消/过期响应、App 比较/返回、实际 CodeMirror 阅读接口测试）。
- `cargo test --no-default-features --lib git::trace -- --nocapture`：9 项通过，含真实 Git 归属/重命名/修改后删除/本地快照/合并/浅克隆/缺对象/固定 tip 分页、取消预算和性能记录。
- `cargo test --no-default-features --lib git::history_tests`：原有 19 项历史测试通过。
- Rust 全套：190 通过、7 失败、5 忽略；原始基线在独立 worktree 复跑为 181 通过、同样 7 失败、5 忽略。失败集合完全一致：`a10_cancel_ends_the_process_tree_and_reports_refs`、`a10_no_output_timeout_ends_the_process_tree_and_reports_refs`、`v2_d65_fetch_blocked_by_a_ref_lock_offers_removal_and_retry`、`b12_pull_times_out_without_output_and_push_can_be_cancelled_ending_the_process_tree`（fixture upload-pack 脚本 Permission denied）、`b05_failed_stage_reports_git_error_and_leaves_repository_unchanged` 和 `reveal::tests::rejects_paths_outside_the_worktree`（Windows 绝对路径在 Linux 上被判为相对路径）、`watch::tests::ignored_storm_is_silent_and_real_changes_are_batched`（目录通知行为差异）。未将这些失败表述为全套通过，未扩展到其他功能单修复。

## 性能与内存样本

真实 fixture：一个 1000 行文件 + 25 个无关文件提交，共 26 提交。单次本地测量用于回归观察，不作为大仓库或 Windows 性能保证。

| 查询 | 耗时 | 累计 Git 输出 |
| --- | ---: | ---: |
| 原有日志读取，追溯前 | 4 ms | 原有接口 |
| Blame 首 200 行 | 7 ms | 65,973 B |
| 第 500 行追踪至引入 | 97 ms | 27,600 B |
| 历史内容搜索 `line 500` | 141 ms | 22,278 B |
| 原有日志读取，追溯后 | 4 ms | 结果与前一读取相同 |

独立运行追溯测试可执行文件，Python `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss` 观察到最大 RSS 为 24,092 KiB（包含该轮测试/Git 子进程，含输出超预算场景；不是浏览器堆测量）。浏览器原生堆/实际渲染帧率未在本环境测量。大仓库按输出、时间和扫描预算显式停止，未通过移除预算制造完整扫描。

## 平台及 GUI 缺口

`cargo check --features desktop` 在 Linux 因缺少 GLib/GTK 的 pkg-config 开发库失败，未完成桌面 Tauri 接入编译；Windows desktop/release PowerShell 构建及真实 Windows 前后台焦点尚未验证，需发布环境继续验收。版本号、锁文件根版本、发行说明和打包配置均未修改。

GUI 安全预检已读取 `scripts/focus-task02-window.ps1`，检索全部脚本引用及 `task02-feedback-*.mjs`：基线的危险原生窗口脚本已 fail closed；四个旧调用方先导入抛错的 `task02-gui-disabled.mjs`，focus/interrupted 脚本开头直接抛错。未执行旧脚本，未新增或恢复危险调用，不操作其他应用窗口。新测试仅为 DOM/jsdom 和本轮创建的后台进程证据，不能作为 CDP 真机或真实 Windows 焦点切换通过的证据。本轮临时仓库、原始基线 worktree、测试根节点及自建进程均已清理。
