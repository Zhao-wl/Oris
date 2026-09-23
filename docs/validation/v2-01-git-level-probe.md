# V2-01 Git 命令层压力探测

日期：2026-09-23。此报告只测 Git 命令和测试仓库的文件系统操作，**不是 Oris 端到端性能**。没有启动 Oris、Tauri、WebView，也没有执行 GUI 或真实 Windows 焦点测试。S/L 的大文件、超长行、图片、5 项目切换及应用内缓存均未覆盖。

## 数据集和环境

使用 `node scripts/perf/generate-datasets.mjs S` 与 `L` 在 `%TEMP%\oris-perf\` 下生成。固定种子 `20260923`；大量提交由 `git fast-import` 构建。S 为 10,000 tracked 文件、20,000 提交、100 个逻辑变化文件；L 为 100,000 tracked 文件、100,000 提交、2,000 个逻辑变化文件。两者各含 10,000 个被 `.gitignore` 排除的 `node_modules` 文件。变化类别按 20% 已暂存、20% 未暂存、20% 同文件双层修改、各 10% 未跟踪、删除、rename、冲突分配。删除一半已暂存、一半未暂存；rename 为已暂存。Git 实际 `rev-list --count`、HEAD 树文件数、被忽略目录文件数分别核对为 S `20000/10000/10000`、L `100000/100000/10000`。三范围旧命令得到的条目数为 S `65/65/100`、L `1300/1300/2000`（顺序：未暂存/已暂存/全部）。

机器：Windows 11 x64（内核 `10.0.22631`）、Intel Core i7-11700、16 逻辑处理器、约 47.7 GiB RAM；测试仓库位于 C: 临时目录的 NVMe SSD。Git `2.44.0.windows.1`，Node `22.18.0`。此机器内存高于 V1 §4 的 16 GiB Windows 参考机器，不能把绝对耗时直接当作参考机预算证据。

## 方法

- 旧路径照 `src-tauri/src/git.rs` 的 `list_changes`、`populate_stats`、`run_readonly` 参数执行：`git --no-optional-locks -c core.fsmonitor=false -c diff.external= -c diff.trustExitCode=false -C <repo>`，设置相同的 `GIT_EXTERNAL_DIFF`、`GIT_TERMINAL_PROMPT`、`GIT_NO_LAZY_FETCH`、`GIT_LITERAL_PATHSPECS` 环境变量；每范围串行执行 `diff --no-ext-diff --no-textconv --find-renames --name-status -z [--cached|HEAD] --`、按源码适用时执行 `ls-files --others --exclude-standard -z --`、`ls-files --unmerged -z --`、`diff --no-ext-diff --no-textconv --no-renames --numstat -z [--cached|HEAD] --`。源码的已暂存范围不运行 `--others`，所以是 3 条命令；另外两范围为 4 条，三范围合计 11 条。
- 新路径执行 `status --porcelain=v2 -z --branch --untracked-files=all --find-renames`，然后并行执行未暂存、已暂存两条 `--numstat`。分别记录 status 可生成列表的耗时和两份统计都完成的总耗时。对“全部”范围懒加载的 `diff HEAD --name-status -M -z` 语义修正，另以源码等效 `--find-renames` 命令计时，不计入一次 status 主路径。
- 每项连续采样 30 次，原始毫秒数保留在 JSON。P50/P95 按升序第 `ceil(p × 30)` 个样本计算。旧三范围总耗时独立重复 30 轮；S 的这一组是完成其他 S 测试后的补测。没有对全局 OS 缓存执行清空：JSON 的 `firstPass` 只是生成后首次测量经过，缓存状态未知；`warm` 是同仓库连续重复执行的热路径样本。**真实冷 OS 缓存未验证**，不得以首次经过数值替代。
- blob 测试从根提交选 100 个**不同 OID**，比较 100 次启动 `git cat-file blob <oid>` 与一次 `git cat-file --batch` 输入 100 个 OID；各重复 30 轮。批处理每轮仍重新启动一次 Git，因此不代表跨请求常驻进程的完整收益，也没有测应用传输与渲染。
- stat 实验每轮对测试仓库 5,000 个内容未变的 tracked 文件执行 `touch`（更新 mtime），测一次 `--no-optional-locks` status；再运行一次允许正常 index stat 回写的 status，之后测一次只读 status。各 30 轮。回写命令本身的耗时没有并入“回写后”读数。

## 热路径结果

单位：毫秒；每格为 **P50 / P95**，每项 `n=30`。

| Git 命令组 | S | L |
| --- | ---: | ---: |
| 旧：未暂存（4 进程） | 526.5 / 551.2 | 1066.7 / 1635.0 |
| 旧：已暂存（3 进程） | 233.8 / 269.6 | 405.5 / 542.1 |
| 旧：全部（4 进程） | 462.0 / 480.1 | 836.5 / 996.1 |
| 旧：三个范围连续各扫一次（11 进程） | 916.5 / 1066.1 | 2314.0 / 2945.5 |
| 新：一次 status，列表可用（1 进程） | 168.9 / 180.6 | 155.4 / 196.3 |
| 新：status 后并行两次 numstat，统计齐全（3 进程） | 365.9 / 378.1 | 820.9 / 1006.9 |
| “全部”范围懒加载 rename 修正命令（额外 1 进程） | 160.7 / 179.4 | 150.3 / 156.3 |
| 100 个不同 blob：逐个启动进程 | 6036.0 / 15450.6 | 4917.4 / 5393.8 |
| 100 个不同 blob：一次 `cat-file --batch` | 59.0 / 102.9 | 49.7 / 52.9 |
| touch 5,000 文件后的只读 status | 953.2 / 2280.9 | 677.1 / 1067.9 |
| 正常回写 index 后的只读 status | 165.3 / 824.5 | 609.6 / 684.4 |

同次测试中，三范围旧路径与新路径统计齐全的 P95 比约为 S `2.82×`、L `2.93×`；一次 status 到列表的 P95 更短。但对于只打开“已暂存”单范围、又必须等待两份 numstat 的情形，新总耗时高于旧三命令。S 的 stat 实验显示回写后 P50 从 953.2 ms 降至 165.3 ms；L 则只从 677.1 ms 降至 609.6 ms，P95 波动也明显，不能据此承诺固定倍数收益。旧三范围、单范围与新路径分组不是随机交错测量，受系统负载和缓存漂移影响。

## 状态一致性与探索轮

探针按路径、状态和 rename 原路径逐项比较旧输出与 status v2 映射，未暂存、已暂存、全部三个范围在正式 S、L 上均为 **0 处差异**。冲突、未跟踪、双层修改、删除和已暂存 rename 均在集合内；`node_modules` 不在集合内。这个夹具未覆盖仅工作区 rename、空 HEAD、特殊字符路径；这些仍需 V2 B01 的专门夹具验收，不能由此宣称 B01 全部通过。

第一次 S 探索轮把所有初始文件写成相同 blob，导致 Git 可把任一同内容删除文件配给任一 rename，`all` 范围出现 20 处配对/路径差异（其余两范围为 0）。这属于夹具歧义，不是被选择性删除的性能结果；原始数据保留在 `%TEMP%\oris-perf\S-pilot\.git\oris-perf-probe.json`。正式生成器改为对变化候选文件和 blob 抽样文件提供唯一内容，正式 S 三范围差异均为 0。探索轮只用于定位夹具问题，不纳入上表。

## 原始数据、复现与清理

正式原始样本与机器信息：`%TEMP%\oris-perf\S\.git\oris-perf-probe.json`、`%TEMP%\oris-perf\L\.git\oris-perf-probe.json`。生成参数及逐项变化清单：各自 `.git\oris-perf-manifest.json`。中断的首个 L 平铺布局尝试保留于 `%TEMP%\oris-perf\L-incomplete`，没有纳入测量。`S-pilot` 和 `L-incomplete` 均可随正式数据一起清理。

```powershell
node scripts/perf/generate-datasets.mjs S
node scripts/perf/generate-datasets.mjs L
node scripts/perf/git-level-probe.mjs "$env:TEMP\oris-perf\S" --iterations 30
node scripts/perf/git-level-probe.mjs "$env:TEMP\oris-perf\L" --iterations 30
# 仅在确认路径确为本轮临时数据目录后清理；该命令不会触及 Oris 工作树。
$perfData = (Resolve-Path -LiteralPath (Join-Path $env:TEMP 'oris-perf')).Path
Remove-Item -LiteralPath $perfData -Recurse -Force
```

生成器拒绝覆盖已有目录，因此复现前须清理或指定新的仓库外 `--output` 绝对路径。清理命令仅供人工在核验目标路径后执行；本报告保留原始数据供主线复核。

## 对 V2-D15 和预算的建议

Git 命令层数据支持 V2-D15 的“一次 status 共享三范围”和 `cat-file --batch` 方向；应保持 numstat 后台补齐，不能让文件列表等待它。OID 缓存命中率、常驻进程生命周期、应用内传输及渲染仍未测。L 的 status-only P95 为 196.3 ms，明显低于两份统计齐全的 1006.9 ms；本次 L 中主要阻塞在统计路径，不足以单凭 status 宣称 fsmonitor（V2-D10）已必要。S 的 stat 回写收益值得在正确时机采用，但 L 的收益较小，须继续监测回写成本和 index 事件。

建议**暂不修改** V2 §3 中首次打开 ≤1.5 s、范围切换 ≤50 ms 等应用预算；用任务 03 提交后的主线 release 构建、参考规格机器与真实冷/热 OS 缓存完成 GUI 基线，再决定是否调整。本文数值只可作为 V2-01 Git 后端优化的方向和回归参照，不能替代端到端验收。
