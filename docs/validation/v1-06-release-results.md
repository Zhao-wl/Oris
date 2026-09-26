# 一期 06 合并发布验收：Windows 与发布准备结果

日期：2026-09-26（长链运行编号 20260926-1014，阶段 3）。任务：[06 双平台性能与可安装发布包](../tasks/06-performance-release.md)。依据：[V1 验收计划](v1-acceptance.md) A01–A15、§5；[V2 验收计划](v2-acceptance.md) B01–B22、§5；[V2-01 结果 · 已知限制与未验证](v2-01-results.md#已知限制与未验证)留给 06 的门禁。

结论：**Windows 功能验收通过；06 整体为 Awaiting acceptance（待性能测试、签名、macOS 最终版本复测）**。A01–A15 与 B01–B22 都在同一个最终构建上重跑（旧版本结果没有用来替代）；本阶段发现并修复 3 个实际缺陷（缺 Git 提示不清楚、安装包缺少 `WebView2Loader.dll`、重启时快照校验失败后旧列表一直标“校验中”）。未完成：发布性能报告（A14 与两套性能 / 内存预算）、Windows 与 macOS 签名 / 公证（阻塞：缺证书）、安装 / 卸载实测（用户选择只构建）、AgentHub 真实远端回归（本轮被会话权限拦截，未运行）、macOS 全部、需要真实前台焦点的“外部变化 → 界面更新”。

## 构建与产物

| 项 | 值 |
| --- | --- |
| 源码 | 分支 `feat/v1-06-release`（自 main `c2572a8`），产品代码最后一次修改在 `aa5828c` |
| 版本号 | 0.1.0（`package.json`、`Cargo.toml`、`tauri.conf.json` 一致） |
| 构建命令 | PowerShell：`scripts/build-release.ps1 -Bundle -Bundles nsis -OutputRoot D:\Projects\Research\Oris-builds\v1-06`（GNU 工具链；PATH 前置 mingw-binutils、后置 msys2 mingw64） |
| `oris.exe` | `D:\Projects\Research\Oris-builds\v1-06\target\release\oris.exe`，31.2 MiB，SHA-256 `7434C750081736A05AA25FB8A5592822C0A4017992D610764272DAD7AA4DA8B8`（`tauri bundle` 写入安装包类型信息之后的最终文件，安装包内即此文件）；`verify_release_entry` 通过（26 个嵌入资源，index / JS / CSS / Worker 可读） |
| `WebView2Loader.dll` | SHA-256 `8427B1FC58EC707813E5C0A51EB5D69397BB333250A7B891BE4D3B123F1E0F1C`（与 V2-01 以来相同） |
| `THIRD-PARTY-NOTICES.txt` | 612,311 字节，SHA-256 `9DC499CB98C30BB34BE2A18F5DBBE3D632FC5C524CAA2D060867973C16FE2D12` |
| Windows 安装包 | `…\bundle\nsis\Oris_0.1.0_x64-setup.exe`，SHA-256 `FC30E29ACAE6FC588AA2589ABEC1131710E3C4D447820339651406ADB014F38A`。**内部测试包（未签名）**；NSIS 由 Tauri bundler 从 `github.com/tauri-apps/binary-releases` 下载（用户已同意），未构建 MSI，未上传 |
| macOS DMG | 未构建（无 macOS 环境），见 [macOS 交接清单](../release/macos-checklist.md) |
| 测试 | 后端 `cargo test --no-default-features --lib`：140 通过 / 5 忽略；前端 `vitest`：218 通过（30 个文件，本阶段新增 1 项）；`npx tsc -b` 通过 |
| 测量机 | Windows 11 专业版 10.0.22631，i7-11700（16 逻辑处理器），47.7 GiB，NVMe SSD，WebView2 153.0.4234.48，Git 2.44.0.windows.1，Node 22.18.0 |

安装包内容（Tauri 生成的 `target\release\nsis\x64\installer.nsi` 中核对，未安装）：按当前用户安装到 `$LOCALAPPDATA\Oris`；文件为 `oris.exe`、`THIRD-PARTY-NOTICES.txt`、`WebView2Loader.dll` 与卸载程序；缺少 WebView2 时下载引导程序并 `/silent` 安装；卸载删除这些文件与开始菜单项，勾选“删除应用数据”时才删除 `$APPDATA\com.oris.viewer` 与 `$LOCALAPPDATA\com.oris.viewer`（[V2-D57](../decisions/v2-decisions.md)，待用户决定）。与安装目录相同的三个文件复制到 `%TEMP%\oris-gui\installed-layout-v106` 后，从该目录启动的实例通过了 Git 发现验收（10/10）。

## 本阶段修复的缺陷

| # | 现象 | 原因与修复 | 提交 |
| --- | --- | --- | --- |
| 1 | 缺 Git 时打开项目只显示“无法显示差异 / 找不到或无法启动 Git：program not found”（系统英文错误），没有处理方法；低版本只说“低于最低支持版本” | 错误文本改为说明原因（“PATH 中没有 git”或“<路径> 不存在”），并提示“请安装 Git 2.31.0 或更高版本，或在‘设置 → Git’中指定 git 可执行文件”；低版本提示升级或指定其他 git | `62adb7b` |
| 2 | Windows 安装包安装后无法启动（推断：缺 DLL） | GNU 工具链的 `oris.exe` 静态导入 `WebView2Loader.dll`（`objdump -p`），Tauri bundler 只打包主程序；`build-release.ps1` 改为先编译并验证入口，再把 DLL 与许可证全文作为资源用 `tauri bundle` 生成安装包 | `fcb5a4d` |
| 3 | 重启时上次快照校验失败（项目目录已被移走）后，标题栏一直显示“校验中”，文件列表仍是未通过校验的旧快照（写入口已禁用，但看起来像有效列表） | 校验失败时丢弃未通过校验的快照，只显示失败原因，项目记录保留；新增前端用例（去掉修复时失败） | `aa5828c` |

另有两处验收脚本问题（不是产品问题）：Git 发现脚本在连续校验时读到上一次的结果（改为等待结果变化）；页签拖动脚本第一步移动 42 px 已越出被拖页签，页面按真实鼠标的逻辑没有开始拖动（改为先小步移动）。

## 追溯矩阵

结果口径：**通过**（本构建上的自动化证据全部通过）、**部分通过**（写明未覆盖部分）、**未运行**（写明原因）、**待性能测试**、**待 macOS**、**待签名**。所有界面证据是 CDP 页面事件（点击、按键、CDP 鼠标），不是真实鼠标、键盘或 Windows 前后台焦点；测试实例都经 `launchOris` 核验（PID、完整路径、主窗口句柄、CDP 端口归属），不调用窗口激活 API。macOS 一栏见文末；除特别说明外，所有行的 macOS 状态均为“待 macOS”。

界面报告目录：`artifacts/gui-probe/v1-06-reg-<套件>/`（v2-06 为 `artifacts/gui-probe/v2-06-acceptance/`，Git 发现为 `artifacts/gui-probe/v1-06-git-discovery/`），每份报告记录 exe 路径与 SHA-256 `7434C750…`（v2-06 与 Git 发现两份报告只记录路径：v2-06 运行于最终构建完成之后的同一路径；Git 发现使用的安装布局副本在复制后核对过 SHA-256）。

| ID | Windows 结果 | 本构建上的证据 |
| --- | --- | --- |
| A01 | 通过 | 后端 `reads_real_index_and_worktree_without_writes`、`reads_staged_unstaged_and_all_as_distinct_endpoint_pairs`、`rejects_a_result_after_the_worktree_revision_changes`；界面 gui-probe core（5 个 S 项目打开、文件切换，两个夹具仓库浏览前后工作区与 `.git` 逐字节不变）、v1-05 阅读（块导航） |
| A02 | 通过 | 新脚本 `v1-06-projects.mjs` 的 A02 检查 7/7：同名不同路径、重复添加切换到已有项目、搜索完整路径、双击别名、拖动排序（CDP 鼠标）、× 只移除记录且目录不变、没有 pin 入口；前端 `ProjectTab.test.tsx`、`workspace-model.test.ts` |
| A03 | 通过 | `v1-06-projects.mjs`：重启后恢复项目、别名与顺序；关闭期间目录被移走 → 明确提示且列表为空（缺陷 3 修复后）；gui-probe core 热切换 30/30 与混合 200 次切换无旧结果落屏；前端 `App.initialization.test.tsx` |
| A04 | 通过 | 后端 `reports_rename_delete_untracked_special_paths_and_conflicts`、`supports_unborn_head…`、conflict_tests 3 项、`controlled_conflict_stage_combinations`；界面 task03 17/17（冲突 UU 默认 stage 2 → 3、Base、工作区、冲突图片、UD 缺失明确显示） |
| A05 | 部分通过 | 后端外部 Git 操作后 revision 变化、`watch.rs` 分类刷新；界面 gui-probe core “后台 dirty 切回”30/30、手动刷新只启动 1 个 Git 进程。**未验证**：“外部修改 → 界面自动更新”——自动刷新只在窗口有原生前台焦点时进行，测试窗口没有真实焦点（AGENTS.md 禁止激活窗口），core 的 externalChange 30 次均未在 8 s 内自动更新（与 V2-01 相同的已知限制） |
| A06 | 通过 | v1-05 A06 13/13（并排 / 统一、词级、折叠与全部展开、搜索、复制、同步滚动、换行、字号、浅深色、专注模式、F7） |
| A07 | 通过 | v1-04 A07 8/8；history-feedback 12/12；后端 history_tests |
| A08 | 通过 | v1-04 A08 3/3；后端 `upstream_states_use_real_reachability_and_never_fake_zero` |
| A09 | 通过 | v1-04 A09 9/9；后端 `compare_pins_endpoints_and_swaps_direction`、文件历史 rename 边界 |
| A10 | 通过 | v1-04 A10 10/10；后端 network_tests 8 项（认证失败不提示输入、凭据脱敏、取消 / 无输出超时结束进程树） |
| A11 | 通过 | v1-05 A11 7/7；task03 图片 10 项；后端 content_tests（LFS、SVG、符号链接、子模块、mode）、media tests |
| A12 | 通过 | v1-05 A12 8/8；后端 `a12_unicode_crlf_final_newline_and_encoding_failures_have_explicit_states`、`raw_non_utf8_path_and_revision` |
| A13 | 通过 | 后端 `ignores_external_diff_and_fsmonitor`、`b18_malicious_config_is_not_executed_on_v2_paths`、`write_channel_does_not_run_fsmonitor_or_external_diff_commands`、`history_reads_never_run_signature_programs…`、task03_safety_tests；界面 v1-04 B18 检查。静态核对：前端无 fetch / XHR / WebSocket / sendBeacon，Rust 无 HTTP 客户端依赖，capability 只有 `core:default` 与 `dialog:allow-open`，CSP 只允许应用自身资源（无 telemetry、无远程代码） |
| A14 | 待性能测试 | 功能部分通过：超预算文本 / 长行 / 图片明确降级（后端 `degrades_oversized_files_and_lines_without_truncating`、media 40 MP 边界）；取消与缓存上限（`task03_cancel_tests`、`resource_limits_cat_file_pool_idle_reaping_and_blob_cache_budget`）。预算判定交给发布性能测试（见下“阶段 1、2 性能复测”） |
| A15 | 部分通过；安装 / 卸载未运行；签名待签名；macOS 待 macOS | Git 发现 `v1-06-git-discovery.mjs` 10/10（在安装布局副本上）：注册表 Machine + User PATH（资源管理器启动时的 PATH）自动发现、缺 Git 提示与处理方法、手动路径校验与重启保留、PATH 中 Git 2.30.2 与手动指定 2.30.2 均提示版本不支持（低版本为 rustc 编译的模拟程序，只回答 `--version`）；只改测试实例自己的 PATH，未改系统 PATH、未安装 / 卸载 Git。Windows 安装包已构建（内部测试包，未签名）；**安装 / 卸载未运行**（用户选择只构建，清单见 [Windows 安装交接清单](../release/windows-install-checklist.md)）；**签名：阻塞：缺证书** |
| B01 | 通过 | 后端 v2_tests `b01_*` 4 项（与 V1 逐命令结果逐项一致） |
| B02 | 通过 | 后端 v2_tests `b02_*` 3 项 |
| B03 | 通过 | gui-probe restart 30/30（窗口就绪到显示快照、到校验完成）；`v1-06-projects.mjs` 重启恢复与校验失败；前端“shows the persisted snapshot as verifying…”与本阶段新增的校验失败用例 |
| B04 | 通过 | 后端 `watch::tests` 7 项；gui-probe core 后台 dirty 切回 30/30 |
| B05 | 通过 | v2-02 B05 9/9；后端 `b05_*` 3 项 |
| B06 | 通过 | v2-02 B06 8/8；后端 `b06_*` 6 项 |
| B07 | 通过 | v2-02 B07 7/7（amend 已按 V2-D37 删除，脚本在 `eeda8ab` 已同步）；v2-04 本地套件新增“提交并推送（已有上游）”；后端 `b07_*` 2 项 |
| B08 | 通过 | v2-02 B08 4/4；后端 `b08_*` 3 项 |
| B09 | 通过 | v2-03 B09 8/8；后端 branch_tests `b09_*` 3 项 |
| B10 | 通过 | v2-03 B10 14/14；后端 `b10_*` 3 项 |
| B11 | 通过（本地 bare remote） | v2-04 本地 B11 7/7；后端 sync_tests `b11_*` 5 项 |
| B12 | 部分通过；真实远端未运行 | 本地：v2-04 B12 5/5（进度、取消结束进程树、无输出超时、认证失败不弹凭据输入且脱敏）；后端 `b12_*` 2 项。**AgentHub（SSH / HTTPS）真实远端回归未运行**：从 Bash 工具启动测试实例的命令被本会话的自动权限分类器拦截；未改用其他方式绕过，用户决定本轮跳过、先合入（2026-09-26），远端引用未被改动（开工前 SSH `ls-remote` 只有 `HEAD`、`refs/heads/main`）。上一次真实远端通过记录见 [V2-04 结果](v2-04-results.md)（旧构建，不作本构建证据） |
| B13 | 通过 | v2-04 B13 4/4；后端 `b13_*` 2 项 |
| B14 | 通过 | v2-04 B14 1/1；后端 `b14_*` |
| B15 | 通过 | v2-05 B15 10/10；后端 hunk_tests 8 项 |
| B16 | 通过 | v2-02 3/3、v2-03 1/1、v2-04 1/1、v2-05 1/1；后端 `b16_*` 4 项 |
| B17 | 通过 | v1-04、v2-02（3）、v2-03、v2-04、v2-05、`v1-06-projects.mjs` 的仓库指纹检查；gui-probe core 只读核对；gui-probe trace：切换显示区域 6 次、热切换 3 次、切换文件 6 次都没有启动 Git 进程（V2-01 “待复核”的后台 Git 进程未复现） |
| B18 | 通过 | v1-04 B18、v2-04 B18（URL 凭据脱敏）；后端 `b18_malicious_config…`、`redacts_credentials_in_urls` |
| B19 | 通过 | v2-06 B19 4/4 |
| B20 | 通过 | v2-06 B20 2/2；`v1-06-git-discovery.mjs` 的手动路径检查 |
| B21 | 通过（跟随系统为 CDP 模拟） | v2-06 B21 2/2 与 19 套配色逐套截图 |
| B22 | 通过 | v2-06 B22 3/3（含“发布包内含 VS Code 与 Colorsublime 许可声明”）；许可声明在前端包 `index-*.js` 中，同时收入安装包的 `THIRD-PARTY-NOTICES.txt` |
| V1 §4 / V2 §3–§4 性能与内存预算 | 待性能测试 | 本阶段只做阶段 1、2 复测的退步检查（下节） |

各套件在本构建上的结果（`artifacts/long-chain/v1-06-regress/summary.txt`）：

| 套件 | 检查 | 结果 |
| --- | --- | --- |
| `v1-06-projects.mjs`（新） | 10 | 10/10 |
| `v1-06-git-discovery.mjs`（新，安装布局副本） | 10 | 10/10 |
| v1-04 | 32 | 32/32 |
| v2-02 functional | 36 | 36/36 |
| v2-03 | 24 | 24/24 |
| v2-04 local | 19 | 19/19（含新增“提交并推送”） |
| v2-05 | 14 | 14/14 |
| v1-05（阅读 + 性能） | 42 | 41/42：唯一未通过为“切换配色 / 主题模式 / 字号 P95 ≤ 100 ms”，字号项超预算（阶段 1 起的已知项，见下） |
| v2-06 | 16 | 16/16 |
| history-feedback | 12 | 12/12 |
| gui-probe task03 | 17 | 17/17 |
| gui-probe core / restart / trace | core 11 类场景（每类 30 次，混合 200 次）、restart 30 次、trace 19 个动作 | 除 externalChange 0/30（需要真实前台焦点，见 A05）外全部完成；5 个夹具仓库浏览前后不变；混合切换后静置 65 s 无残留 Git 子进程 |

## 阶段 1、2 性能复测（退步检查，不是发布性能报告）

负载监测每 5 s 采样；v1-05 性能段外部进程 CPU P95 3.1%、最高 3.6%，没有超过 10% 的时段，数据有效。

| 场景 | 本构建 P50 / P95 ms | 阶段 1（一期 05）/ 阶段 2（V2-05） | 结论 |
| --- | --- | --- | --- |
| 已缓存文件切换（预算 P95 ≤ 100） | 25.0 / 28.4 | 29.8 / 与阶段 1 相同 | 通过，未退步 |
| 未缓存常用文件（≤ 400） | 28.5 / 34.6 | 37.2 | 通过，未退步 |
| 典型滚动帧间隔（≤ 33） | 并排 10.7、统一 19.3 | 相同 | 通过 |
| 字号切换（滚动到 3,000 行文件中部，≤ 100） | 104.9 / 131.5 | 一期 05 约 101–110；V2-05 约 116–130 | **未达标（已知）**；前端包与阶段 2 逐字节相同（`index-DW5tDEIN.js`），差异为测量波动，不是本阶段退步；交发布性能测试 |
| 配色 / 模式切换（≤ 100） | 60.2 / 88.9、59.9 / 82.8 | 相同量级 | 通过 |
| 块操作乐观反馈 / Git 确认 | 反馈 P95 ≤ 21.2；确认 P95 720.6–766.6 | V2-05 约 735–755 | 未退步；确认时延只作参照（B15 无单独预算，stage 参照 500 ms） |
| gui-probe core / restart | 热切换 28.9 / 34.5；范围切换 25.7 / 33.5；已缓存文件 25.2 / 32.2；未缓存 29.4 / 34.9；后台 dirty 切回 206.4 / 215.5；首次打开 366.5 / 382.9；重启窗口就绪到显示快照 92.5 / 97.1、到校验完成 427.3 / 441.6 | 同量级（V2-01 起的回归） | 未退步；预算判定与内存项（混合 200 次后工作集增长 20.5% 等）交发布性能测试 |

## 发布准备

- **发行说明**（草稿，未发布）：[release-notes.md](../release/release-notes.md)：支持平台（Win11 x64、macOS 14+ arm64；无 Intel / Universal / Windows ARM64）、Git 基线 2.31.0、安全边界（按 V2 验收计划 §5）、内容预算、已知限制、安装与卸载、无自动更新、应用数据位置。
- **macOS 交接清单**：[macos-checklist.md](../release/macos-checklist.md)：DMG 构建、签名与公证、macOS 14 / M1 下限与较新版本 smoke、osxkeychain / ssh-agent 远端、需要复测的验收 ID。
- **Windows 安装交接清单**：[windows-install-checklist.md](../release/windows-install-checklist.md)。
- **第三方许可证**：`scripts/release/third-party-licenses.mjs` 用本机 `cargo metadata --offline --locked` 与 `package-lock.json` 汇总（不联网、不下载工具），清单见 [third-party-licenses.md](../release/third-party-licenses.md)：Cargo 288 个包（Windows 265、macOS 259），npm 25 个包；5 个 crate 只有 MPL-2.0（cssparser、cssparser-macros、dtoa-short、option-ext、selectors，经 Tauri / wry 依赖引入，未修改），公开发布前需确认 MPL-2.0 的声明义务；22 个包的本机源码目录没有许可证文件（多为本机未解压的 macOS 专用 objc2 系列），NOTICES 中只列出许可证名称。许可证全文随安装包附带。
- **签名**：Windows 代码签名、macOS 签名 / 公证均为**阻塞：缺证书**。仓库、日志、报告中没有写入任何证书或密钥。

## 未验证与已知限制

- **macOS 全部**：用户在 macOS 真机上验证（2026-09-25），Oris 自动化未复核；机型 / 芯片、内存、macOS 版本、被测构建、覆盖范围、原始记录位置：用户口头确认，范围未记录。本阶段的最终版本复测交给用户（[macOS 交接清单](../release/macos-checklist.md)）。
- **AgentHub 真实远端（B12）**：本轮未运行，用户决定跳过（见追溯矩阵 B12 行）；之后补测需要用户在会话权限中放行“从 Bash 工具启动测试实例并推送 `oris-test/20260926-1014/` 测试分支”，或自行运行 `node scripts/perf/v2-04-acceptance.mjs --exe <oris.exe> --only real --run-id <运行编号>`。
- **安装 / 卸载实测**：未运行（用户选择只构建）；安装脚本内容已核对，安装布局副本可启动。
- **真实焦点**：所有界面证据为 CDP 页面事件；“外部变化 → 界面自动更新”、失焦后切到低内存级别的真实焦点切换（V2-01 门禁）未验证。
- **16 GiB 参考机**：测量机为 47.7 GiB；发布性能测试另行处理。
- **签名 / 公证**：缺证书。
- Windows SmartScreen 对未签名安装包的提示、WebView2 缺失时的引导程序下载都没有实际触发（本机已安装 WebView2）。
