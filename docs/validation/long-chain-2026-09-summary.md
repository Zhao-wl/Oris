# 长链路任务总结（2026-09-23 至 09-24）

任务来源：`docs/tasks/onetime/v2-onetime.md`（五个阶段）。起点 `main` = `90ecf47`，终点 `main` = 本文所在提交（阶段 1、3、4 已合入并推送）。GUI 测试启动已在开始时获得用户一次性同意。

## 各阶段结果

| 阶段 | 结果 | 提交 / 分支 | 证据 |
| --- | --- | --- | --- |
| 1 界面验证批次与一期基线（`wip/gui-batch`） | **完成，已合入** | 合并 `8d1860a`；脚本 `4290587`、`f4238a3`、`6338252`、`91e9527`，文档 `d7fff7c` | [V1 基线](v2-baseline-v1.md)、[任务 03 Windows 界面证据](task-03-windows-gui.md)；`scripts/perf/gui-probe.mjs` |
| 2 V2-01 数据层与流畅度（`feat/v2-01`） | **实现完成，验收未全部通过，未合入**；分支已推送 `origin/feat/v2-01` | `2424bd8`、`7656303`、`9f52588`，文档 `16706a3`（分支头） | [V2-01 结果](https://github.com/Zhao-wl/Oris/blob/feat/v2-01/docs/validation/v2-01-results.md)（在该分支上） |
| 3 V2-06 预制模块（`wip/v2-06-core`） | **完成，已合入** | 合并 `464dae8`（`6bafd71`） | [任务 V2-06](../tasks/v2/06-settings-appearance.md)“预制模块与接入清单” |
| 4 一期任务 04 预制模块（`wip/v1-04-core`） | **完成，已合入** | 合并 `4bbfc23`（`b6881c5`） | [任务 04](../tasks/04-history-branches.md)“预制模块与接入清单” |
| 5 收尾 | 完成 | 本文 | — |

阶段 2 未合入的原因：V2 验收 §4 的两项内存指标未达标（见下表），按“验收未通过不合并”的规则保留分支；是否调整预算需要用户决定（P-V2-09）。阶段 3、4 的变基与测试均基于未包含 V2-01 的 main。

## 测试数量

| 分支 / 版本 | 后端（通过 / 忽略） | 前端 vitest（含配色 5 项） | 构建 |
| --- | --- | --- | --- |
| 起点基线 | 41 / 5 | 87（前端 82 + 配色 5） | 通过 |
| 当前 main（阶段 1+3+4） | 48 / 5（+7：任务 04 历史与引用） | 106（+19：设置 5、配色运行时 8、提交图 6） | 通过 |
| `feat/v2-01`（阶段 2，含阶段 1） | 58 / 5（+17） | 98（+11） | 通过；desktop `cargo check` 无告警 |

## 一期基线与 V2-01 性能对比（同一机器、脚本、数据集、时间段；ms，P50 / P95，n=30）

| 场景 | V1 基线（`90ecf47`） | V2-01（`9f52588`） | V2 S 目标 |
| --- | ---: | ---: | --- |
| 首次打开 | 1115.6 / 1186.4 | 295.4 / 307.4 | ≤ 1500 ✓ |
| 再次打开：显示上次快照 | 788.8 / 948.4（无快照） | 91.9 / 98.2 | ≤ 300 ✓ |
| 再次打开：校验完成 | 788.8 / 948.4 | 363.5 / 375.2 | ≤ 1500 ✓ |
| 热项目切换 | 27.5 / 30.8 | 22.8 / 27.0 | ≤ 100 ✓ |
| 后台 dirty 项目切回 | 980.9 / 1218.7 | 188.6 / 196.5 | ≤ 800 ✓ |
| 切换显示区域 | 30.9 / 34.9，每次 6–26 个 Git 进程 | 20.1 / 25.4，0 个进程（早先一次运行出现后台重算，未复现） | ≤ 50 且无 Git 进程 ✓（需复核） |
| 已缓存文件切换 | 19.6 / 24.0 | 15.3 / 21.0 | ≤ 100 ✓ |
| 相邻文件（预取） | 439.6 / 452.8 | 16.8 / 21.1 | ≤ 100 ✓ |
| 未缓存常用文件 | 438.4 / 485.7 | 22.3 / 27.9 | ≤ 400 ✓ |
| 外部变化 → 界面更新 | 未测 | 未测 | 需要真实前台焦点 |
| 5 项目稳态进程树（工作集） | 462.1 MiB | 431.7 MiB | ≤ 400 ✗（两者都超出，WebView2 约 400） |
| 200 次混合切换增长 | +0.7 % | +12.0 % | ≤ 10 % ✗ |
| 任务 03 界面套件 | 16/17（混合切换受 F1 影响） | 17/17 | — |

## 过程中的新发现

- **F1**：Git 2.44 下 `git --no-optional-locks diff --name-status`（未暂存与 HEAD）在 stat 过期时仍回写 `.git/index`；V1 的“只读”刷新因此会改写 index 并触发自身 watcher，导致冲突读取被丢弃。V2-01 改用 status v2 与 plumbing 命令修复（仅在 `feat/v2-01` 上）。
- Windows 上 `CREATE_NO_WINDOW` 仍会为每个控制台子进程创建隐藏 `conhost.exe`（常驻 cat-file 每个约 11 MiB）；`notify-debouncer-full` 在 Windows 默认的文件 ID 缓存会在 `watch()` 时遍历整棵目录树（大仓库打开慢约 2 s）。两者已在 V2-01 中处理。
- V1 在切回冲突项目时会先清空已选中的冲突文件内容（同样由 F1 触发的失效事件引起）。

## 仍未验证

- macOS 14+ Apple Silicon / WKWebView：全部未运行（任务 01、02、03、V2-01）。
- 真实 Windows 前后台焦点：未验证；本轮所有 GUI 证据均为 CDP / DOM 模拟，测试窗口始终未获得原生焦点。
- 外部变化到界面更新（V1 / V2）、10 项目内存、L 数据集 GUI、真实冷 OS 缓存、16 GiB 参考机：未测。
- V2-01 切换显示区域的 Git 进程数：3 次同构建 trace 中 1 次出现后台详情重算，未定位。
- 阶段 3、4 只是未接入界面的预制模块，不构成 B19–B22、A07–A10 的验收证据。

## 需要用户决定

- **P-V2-05** diff 颜色语义、**P-V2-06** 配色移植范围、**P-V2-07** 默认配色：保持待定。预制模块两组 diff 颜色都提供，默认配色由调用方从两组候选中传入。
- **P-V2-09（新增）** 进程树内存预算：V1 基线本身已超出 400 MiB；V2-01 的额外部分主要是常驻 cat-file。A 维持预算并继续压缩（例如常驻读取器上限降到 2–3 后重测）；B 调整口径（Oris 自身 + Git 子进程单列，WebView2 另计）。决定后才能完成 V2-01 验收并合并 `feat/v2-01`（该分支包含决策条目与完整结果报告）。

## 建议的下一步

1. 用户决定 P-V2-09，据此完成 V2-01（必要时再测一轮 §4），合并 `feat/v2-01`。
2. 用户决定 P-V2-05–P-V2-07 后开工 V2-06 完整实现（按任务文档中的接入清单），再进入 V2-02。
3. 在可隔离的环境中补真实前台焦点与 macOS 验证。

## GUI 安全说明

没有修改或运行 `scripts/focus-task02-window.ps1` 与 `scripts/task02-feedback-*.mjs`（均仍在首行抛错）。所有 GUI 测量只启动本轮的 `oris.exe` 测试实例，使用独立 WebView2 profile 与应用缓存目录，核验 PID、可执行文件完整路径、主窗口句柄与 CDP 端口归属后才交互；没有调用 `SetForegroundWindow`、`ShowWindow`、`AppActivate`，没有操作 Codex、ChatGPT 或其他应用窗口。结束时只关闭已核验的本实例（先温和关闭、超时才结束其进程树），收尾时确认没有残留的测试实例与 git 子进程。

## 清理记录

- 已删除：`%TEMP%\oris-gui\`（测试夹具、5 份 S 原件、profile）、仓库外的临时 worktree 与其构建目录 `D:\Projects\Research\Oris-wt\`。
- 事故：删除 worktree 时，未能先拆除的 `node_modules` 目录联接被 `git worktree remove` 穿透，主仓库 `node_modules` 被清空；已立即用 `npm ci` 按 lockfile 恢复，并在 main 上重跑前端测试（106 项）与构建通过。没有影响源码与用户数据。
- 保留（报告引用）：`artifacts/gui-probe/`、`artifacts/long-chain/`（已被 `.gitignore` 忽略的原始数据、截图与调试脚本），以及 release 构建 `D:\Projects\Research\Oris-builds\v1-baseline\`、`D:\Projects\Research\Oris-builds\v2-01\`。`%TEMP%\oris-perf\` 为此前会话创建的数据集，未动。确认不再需要后可执行：

```powershell
Remove-Item -LiteralPath D:\Projects\Research\Oris\artifacts\gui-probe, D:\Projects\Research\Oris\artifacts\long-chain -Recurse -Force
Remove-Item -LiteralPath D:\Projects\Research\Oris-builds\v1-baseline, D:\Projects\Research\Oris-builds\v2-01 -Recurse -Force
```
