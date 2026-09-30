# 长链 lc5 阶段 2：低负载发布性能会话（未完成，受干扰）

日期：2026-09-30。任务：[长链 lc5](../tasks/onetime/long-chain-perf-lc5.md) 阶段 2。方法与口径同 [发布性能测试](v1-06-performance.md)（CDP 页面内“动作 → 断言首次成立 → 下一帧”；每 5 s 记录整机 CPU 与外部进程；外部进程合计 > 10% 且持续 ≥ 10 s 的段落作废重测）。

## 结论

**本轮没有得到任何有效的性能数据。** 开跑前的负载闸门两次不通过（外部进程 CPU 的 P95 67.6% / 74.1%，门槛 ≤ 5%），用户先决定按现状继续；第一个套件 core 运行中外部负载升到 65–75%，数据判为受干扰，用户决定暂停清场；清场后重做闸门仍不通过，**用户决定跳过性能会话**（2026-09-30），直接进入阶段 3。

因此下表所有预算行都是“未测”（或“受干扰，未下结论”），发布性能结论仍沿用 [发布性能测试](v1-06-performance.md)（构建 `ae08225`）与 [RC 复测](v1-06-rc-results.md)。V2-07 工作区的 §3 / §4 预算、V2-D75 之后的大文件、对齐变化、块操作 A/B、AI 计时都**未测**。没有降低或调整任何预算。

## 被测构建

| 项 | 值 |
| --- | --- |
| 源码 | main `8465358`（阶段 1 合入后，含 v0.5.0 版本号；产品代码与已发布的 v0.5.0 相同，构建不同） |
| 构建 | PowerShell：`scripts/build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\perf-lc5`（全新目录；GNU 工具链，PATH 前置 mingw-binutils、后置 msys2 mingw64）；`verify_release_entry` 通过 |
| `oris.exe` | 42.4 MiB，SHA-256 `01EE175E19BF20FDD4537B47A188FE056481092FB5C511FE2D0B488B3ABA3413` |
| A/B 对照 | `Oris-builds\ab-ae08225`（`ae08225`，SHA-256 `F6BC62D5…`，与 RC 报告相同）；未运行 |
| 机器与工具 | Windows 11 专业版 10.0.22631，i7-11700（16 逻辑处理器），47.7 GiB；Git 2.44.0.windows.1；Node v22.18.0 |
| 数据集 | S：`%TEMP%\oris-gui\pristine\S1…S8`（`generate-datasets.mjs S`，种子 20260923；S6–S8 本轮生成）；L：`%TEMP%\oris-perf\perf-lc5\L`（本轮生成，128 s） |

## 负载记录

| 时间（UTC） | 测量 | 外部 CPU P50 / P95 / 最高 | 超过 10% 的采样 | 占用最高的外部进程 |
| --- | --- | --- | --- | --- |
| 02:38–02:43 | 闸门 1（300 s） | 18.7 / 67.6 / 89.0% | 50 / 50 | MsMpEng 44%（刚生成 L 数据集）、其他会话的 Rust 测试 `oris_lib-…` 7.6%、另一个 Claude Code 会话 6.3%、TGitCache 5.7%、VS Code 5.5%、PcaSvc 5.5% |
| 02:44–02:45 | 闸门 1b（90 s） | 17.7 / 22.4 / 22.4% | 16 / 16 | Claude Code 会话 5.7%、VS Code 5.2%、PcaSvc 5.0%、MsMpEng 4.7% |
| 02:49–02:50 | core 开始前 60 s | 14.2 / 39.6% | — | MsMpEng 12.6%、PcaSvc 5.4%、Claude Code 会话 5.2% |
| 02:50–03:15 | core（第 1 次，1,499 s） | 23.1 / 83.8 / 88.0% | 受干扰 | 重测期间 65–75%：Unity、VS Code ServiceHost、testhost（.NET 测试宿主）、MsMpEng、Claude Code 会话、PcaSvc |
| 05:34–05:39 | 闸门 2（300 s，用户清场后） | 21.5 / 74.1 / 76.6% | 48 / 48 | Unity 14.8%、MsMpEng 13.1%、dotnet 7.0%、ChatGPT 6.7%、Claude Code 会话 6.2%、VS Code ServiceHost 5.8%、PcaSvc 5.5% |

`svchost#69` 为 PcaSvc（程序兼容性助手服务），占用随整机进程创建而上升；另有用户自己的 Oris（`D:\Tools\Oris`，v0.4.1）在运行，空闲，不计为干扰。本轮没有结束或调整任何外部进程，也没有修改系统设置。core 重测 1 进行中按用户决定停止了会话（只结束本会话启动的进程树）。

core 第 1 次（受干扰，**作废**，只供参考，不能与上一版比较）：首次打开 P50 1,111.6 / P95 6,030.1 ms，热项目切换 60.8 / 76.8，切换显示区域 44.3 / 58.0，已缓存文件 33.3 / 48.2，未缓存文件 63.6 / 82.2，后台 dirty 切回 343.9 / 613.6 ms；外部变化 30 次都未自动更新（需要真实焦点，同上一版）。数值普遍是上一版的 2–3 倍，与同期外部负载相符；是否另有退步只能在低负载下确认。

## 本轮新增或修改的测量脚本（已冒烟，未正式运行）

- `workspace-acceptance.mjs --only perf`：V2 验收 §3 工作区三行 + 打开仓库选择器 + §4 内存。夹具为 S1 副本（普通项目）与另一份 S1 副本加 S2–S8 副本作为 7 个子模块（共 8 个成员；S 数据集的 index 含冲突条目，用临时 index 提交 `.gitmodules` 与 gitlink，再 `absorbgitdirs`）；普通项目与工作区交替添加 n 次，差值取两者 P95 之差；每次打开工作区后首次切到一个成员（轮换）；8 个成员都打开后热切换 n 次；方法与 gui-probe core 相同。冒烟（n = 2，高负载）流程全部可用。
- `v1-06-ai-acceptance.mjs --timing-n N`：AI 入口打开次数改为 N，并追加 N 次“暂存全部 / 取消暂存全部”计划执行计时（假模型服务发出回复 → 界面刷新，扣除模型响应时间）。冒烟 37/37。
- `p-v2-10-gui.mjs --cached N`：已缓存切换每场景的次数（原固定 5 次）。
- `release-perf-session.mjs`：新增 diff-blocks、wrap-align-single / multi、workspace、ai-latency 套件；`--pre-check 秒数` 在每个套件开始前记录一段空载负载。
- `load-gate.mjs`（新）：开跑前空载测量，外部 CPU P95 > 5% 或发现其他会话的 Oris 测试实例、cargo / rustc、Oris 的 node 测试脚本时不通过（用户日常使用的 Oris 单独列出、不计）。
- `gui-lib.mjs`：`powershell()` 偶发启动失败时重试两次（冒烟时见过一次，导致 AI 验收中断）；AI 验收异常分支的截图最多等 10 s（CDP 已断开时原来会一直等待）。

## 复现（低负载时）

```powershell
node scripts/perf/load-gate.mjs --seconds 300
node scripts/perf/release-perf-session.mjs --exe D:\Projects\Research\Oris-builds\perf-lc5\target\release\oris.exe --run-id perf-lc5 --pre-check 60 --suites core,restart,trace
```

其余批次：`latency-v202,write,write-trace`、`hunk,appearance,reading`、`task03,memory5,memory5-low`、`memory10,git-children,diff-blocks`、`wrap-align-single,wrap-align-multi,workspace`、`ai-latency`；L：`--l-repo %TEMP%\oris-perf\perf-lc5\L --suites git-probe-L,large`；块操作 A/B：分别以 `ab-ae08225` 与被测构建交替运行 `--suites hunk` 各 3 轮。
