# 长链总结：一期 05 → V2-05 → 一期 06（发布准备）

日期：2026-09-26（运行编号 20260926-1014）。依据：[长链任务](../tasks/onetime/long-chain-v1-05-v2-05-v1-06.md)。开工时 main = origin/main = `4b9694a`，工作区干净；结束时 main = origin/main = `a0264fd`。

一次性答复（开工时）：GUI 测试实例启动（长链与发布性能测试）= 同意；阶段 3 安装 / 卸载测试 = 不允许，只构建；AgentHub 真实远端回归 = 可以。阶段 3 另行同意 Tauri bundler 下载 NSIS（只构建 NSIS，不构建 MSI，不上传、不安装）。阶段 3 中 AgentHub 回归被会话权限拦截后，用户决定跳过、先合入。

## 结论

| 阶段 | 结果 | 合入 main | 报告 |
| --- | --- | --- | --- |
| 1 一期 05 完整阅读体验与特殊文件 | Done（Windows）；字号切换滚动场景超预算交发布性能测试 | `0ef5863` | [v1-05-results](v1-05-results.md) |
| 2 V2-05 hunk 级暂存与丢弃 | Done（Windows） | `c2572a8` | [v2-05-results](v2-05-results.md) |
| 3 一期 06 Windows 与发布准备 | Windows 功能验收通过；06 为 Awaiting acceptance（待性能测试、签名、macOS 最终版本复测） | `a0264fd` | [v1-06-release-results](v1-06-release-results.md) |

所有合入都是 `git merge --no-ff` 后 `git push origin main`，推送前 origin/main 没有新提交；没有 rebase、force push、tag、Release 或上传。

## 各阶段提交

- 阶段 1（`feat/v1-05`）：`a12d027` 解码 / 特殊文件 / 空白规则 / 专注模式 / 全部展开 / F7；随后外观切换优化与验收脚本、回归修正、`f4eeeda` 文档；合入 `0ef5863`。
- 阶段 2（`feat/v2-05`）：`ccfd34a` hunk 级暂存 / 取消暂存 / 丢弃；`47fe087` 修复（autocrlf 下块丢弃改写整文件换行；写操作后阅读位置）与界面验收脚本；`7ad0046` 文档；合入 `c2572a8`。
- 阶段 3（`feat/v1-06-release`）：`62adb7b` 缺 Git / 低版本提示与发布准备脚本；`fcb5a4d` 安装包缺 `WebView2Loader.dll`；`adff37d` 发行说明、交接清单、许可证清单；`aa5828c` 重启时校验失败不再保留“校验中”的旧列表；`2545968`、`0af980e` 追溯矩阵与状态；合入 `a0264fd`。

## 测试数量变化

| 时点 | 后端（`cargo test --no-default-features --lib`） | 前端（vitest） | tsc |
| --- | --- | --- | --- |
| 开工基线 `4b9694a` | 124 通过 / 5 忽略 | 186（26 个文件） | 通过 |
| 阶段 1 合入 | 128 / 5 | 204（28） | 通过 |
| 阶段 2 合入 | 140 / 5 | 217（30） | 通过 |
| 阶段 3 合入 / 最终 main `a0264fd` | 140 / 5 | 218（30） | 通过 |

## 界面验收

- 阶段 1：`v1-05-acceptance.mjs` 37/37（A06、A11、A12），回归 v1-04 32、v2-03 24、v2-04 local 18、v2-06 20、history-feedback 12、task03 17。
- 阶段 2：`v2-05-acceptance.mjs` 14/14（B15、B16、B17），回归同上并加 v1-05 阅读 37。
- 阶段 3（最终构建 `7434C750…`）：新增 `v1-06-projects.mjs` 10/10（A02、A03、B17）与 `v1-06-git-discovery.mjs` 10/10（A15 Windows Git 发现，安装布局副本）；v2-04 本地套件新增“提交并推送”（V2-D37）检查；11 个套件全部重跑：v1-04 32/32、v2-02 36/36、v2-03 24/24、v2-04 local 19/19、v2-05 14/14、v1-05 41/42（唯一未通过为已知字号切换预算项）、v2-06 16/16、history-feedback 12/12、task03 17/17、gui-probe core / restart / trace（除需要真实焦点的 externalChange 外全部完成）。

所有界面证据为 CDP 页面事件；测试实例都经 `gui-lib` 的 `launchOris` 核验（PID、完整路径、主窗口句柄、CDP 端口归属），使用独立 profile 与应用缓存，用 `killOris` 关闭；没有调用任何窗口激活 API。

## 性能复测与负载记录

负载监测每 5 s 采样（整机 CPU、可用内存、前 5 个外部进程）；本轮所有计时段外部进程合计 CPU 都没有超过 10%（阶段 3 v1-05 性能段 P95 3.1%、最高 3.6%），没有作废重测。

| 场景（预算） | 阶段 1 | 阶段 2 | 阶段 3 最终构建 |
| --- | --- | --- | --- |
| 已缓存文件切换 P95（≤ 100 ms） | 29.8 | 未退步 | 28.4 |
| 未缓存常用文件 P95（≤ 400 ms） | 37.2 | 未退步 | 34.6 |
| 典型滚动帧间隔 P95（≤ 33 ms） | 通过 | 通过 | 并排 10.7、统一 19.3 |
| 字号切换（3,000 行文件中部）P95（≤ 100 ms） | **107.6**（由 149.9 优化；main 同场景 112） | **约 116–130**（块标题行 +约 17 ms） | **131.5**（前端包与阶段 2 相同，测量波动） |
| 块操作反馈 / Git 确认 P95 | — | ≤ 24 / 约 735–755 | ≤ 21.2 / 720.6–766.6（只作参照） |
| 热切换 / 范围切换 / 首次打开 / 重启到快照 P95 | — | — | 34.5 / 33.5 / 382.9 / 97.1 |

字号切换是唯一超预算项，交给发布性能测试按其流程处理（定位见 [v1-05-results · 性能复测](v1-05-results.md)）。

## 真实远端

AgentHub（`git@github.com:Zhao-wl/AgentHub.git`）真实远端回归本轮**未运行**：阶段 3 从 Bash 工具启动测试实例的命令被会话的自动权限分类器拦截，没有用其他方式绕过；用户决定跳过、先合入。远端引用在开工前与结束后用 SSH `ls-remote` 核对，都只有 `HEAD` 与 `refs/heads/main`（没有创建测试分支）。

## 发现并修复的问题

产品缺陷：
1. （阶段 2）块丢弃经 `git apply` 时按 `core.autocrlf=true` 把整个 LF 文件改写为 CRLF → 在工作区原始字节上只替换目标块。
2. （阶段 2）写操作后阅读位置下移 → 先放块标题行再恢复阅读位置。
3. （阶段 3）缺 Git 时只显示系统英文错误、没有处理方法；低版本同样 → 中文原因与处理方法。
4. （阶段 3）Windows 安装包缺少 `WebView2Loader.dll`（GNU 构建静态导入）→ 先编译再 `tauri bundle`，DLL 与许可证全文作为资源。
5. （阶段 3）重启时快照校验失败后一直显示“校验中”与旧列表 → 丢弃未通过校验的快照。

性能：（阶段 1）外观切换缓存主题 / 高亮 / 字号扩展，字号改用 CSS 变量，合并高亮派发（字号切换 149.9 → 107.6 ms）。

测试与脚本（不是产品问题）：v1-04 A10 检查改读同步按钮提示；v2-03 B09 等待条件竞态；常驻 cat-file 用例因全局 BlobCache 命中而不稳定（改唯一内容）；Git 发现脚本读到上一次校验结果；页签拖动脚本首步越出被拖页签；v2-05 性能循环只数到视口内的块（改读工具栏总数）。

## 构建

| 构建 | 源码 | `oris.exe` SHA-256 | 安装包 SHA-256 |
| --- | --- | --- | --- |
| 阶段 1 验收 | `feat/v1-05` | `57B70C7B49B4FB68B3ED98D1168F831FAC9FD0DD0031C263A9CAF03D1AC8EDC2` | — |
| 阶段 2 验收 | `feat/v2-05` | `F3E69CC72013C0781574CF550E674FF73AF272D833B699BC41AC612982494536` | — |
| 阶段 3 验收（`Oris-builds\v1-06`） | `aa5828c`（产品代码与最终 main 相同） | `7434C750081736A05AA25FB8A5592822C0A4017992D610764272DAD7AA4DA8B8` | `FC30E29ACAE6FC588AA2589ABEC1131710E3C4D447820339651406ADB014F38A` |
| 最终 main（`Oris-builds\final-main`，全新输出目录） | `a0264fd` | `860532B7497482A09A2DC5D5FBE6DB9162A1620A17929D5695E105483923B96E` | `CD849F98AA1D5EE102E31114DC5658BD00948963F07153FA7A3A27ED19F898B7` |

最终 main 构建与阶段 3 验收构建源码相同（之后只有文档提交），但不是逐字节相同：构建会把前端输出目录路径嵌入程序，两者输出目录不同。两者都通过 `verify_release_entry`；界面验收证据来自阶段 3 验收构建。安装包均为内部测试包（未签名）。

## 未验证项

- macOS 全部：用户在 macOS 真机上验证（2026-09-25），Oris 自动化未复核；机型 / 芯片、内存、macOS 版本、被测构建、覆盖范围、原始记录位置：用户口头确认，范围未记录。最终版本的 macOS 复测是用户待办（[macOS 交接清单](../release/macos-checklist.md)）。
- 真实鼠标、键盘与 Windows 前后台焦点；“外部变化 → 界面自动更新”；失焦后的低内存级别切换。
- Windows 安装 / 卸载实测（用户选择只构建，[交接清单](../release/windows-install-checklist.md)）；SmartScreen 与 WebView2 引导程序下载没有实际触发。
- Windows 签名、macOS 签名 / 公证：阻塞：缺证书。
- AgentHub 真实远端（B12）：本轮未运行。
- 发布性能报告（A14、V1 §4 与 V2 §3–§4 全部预算、L 数据集、分层内存、16 GiB 参考机）。
- Mac Retina 与真实系统高 DPI；未初始化子模块等只在单元测试中覆盖的界面展示。

## 待用户决定

长链中按“最保守、可逆”先行落地、等待确认的事项，见 [V2 决策 · 待用户决定](../decisions/v2-decisions.md#待用户决定)：

- V2-D50 空白规则（保留 / 忽略，默认保留，`-w` 语义）
- V2-D51 编码（只解码 UTF-8 / 带 BOM 的 UTF-16，其他显示“编码不受支持”）
- V2-D52 键盘（F7 / Shift+F7；专注模式 Ctrl/Cmd+Shift+Enter）
- V2-D53 特殊文件（符号链接不跟随；子模块只读 `.git` 文件，不启动 Git）
- V2-D54 非 UTF-8 的块操作需先“按单字节显示”
- V2-D55 块映射只在指针移入 / 键盘聚焦时读取
- V2-D56 块丢弃备份整个文件；块操作不带 mode 变化
- V2-D57 Windows 安装方式（按当前用户、WebView2 引导程序、卸载默认保留应用数据、不构建 MSI）

另需确认：5 个只有 MPL-2.0 的依赖在公开发布前的声明义务（[许可证清单](../release/third-party-licenses.md)）。

## 清理

- 删除了 A/B 对照 worktree `D:\Projects\Research\Oris-ab-main`（先删除其中指向主仓库 `node_modules` 的 junction，主仓库 `node_modules` 完好）。
- 删除了本轮在 `%TEMP%\oris-gui` 下的测试目录（各脚本结束时自动删除；安装布局副本 `installed-layout-v106` 手动删除）。`%TEMP%\oris-gui\pristine` 与 `%TEMP%\oris-perf\`（2026-09-23 / 24，V2-01 时生成）不是本轮创建，保留。
- AgentHub：没有创建测试分支，SSH `ls-remote` 只有开工时的引用。
- 没有遗留的 Oris 测试进程。
- 构建产物保留在 `D:\Projects\Research\Oris-builds\`（v1-05、v2-05、ab-main、v1-06、final-main 等），可按需删除。

## 建议的下一步

1. 发布性能测试（[release-performance](../tasks/onetime/release-performance.md)），在最终 origin/main 上执行，重点：字号切换滚动场景、V2-D29 分层内存、写操作时延与进程数、L 数据集。
2. 取得 Windows 代码签名证书与 Apple Developer ID / 公证凭据后，完成签名链路（凭据不入库）。
3. 用户按 [macOS 交接清单](../release/macos-checklist.md) 与 [Windows 安装交接清单](../release/windows-install-checklist.md) 在最终版本上复测。
4. 在会话权限放行后补跑 AgentHub 真实远端回归（B12）。
