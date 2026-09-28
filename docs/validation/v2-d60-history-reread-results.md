# V2-D60 写操作后历史页后台重读的合并

日期：2026-09-28。长链阶段 1（[任务](../tasks/onetime/long-chain-v2d60-v2d58-v1-06-rc.md)），分支 `fix/history-reread`（自 main `80fa2d0`）。只验证 Windows。

结论：**修复完成，功能与性能验收通过**。历史页打开过之后，一次写操作最多触发 1 次历史重读；历史页不可见时写操作不再重读，只标记失效，切回时重读一次。每个改变 refs 的操作少启动约 20–60 个 Git 进程。历史页的可见行为没有改变（回归 v1-04、v2-03、v2-04 local、history-feedback 全部通过）。

## 实现版本

| 项 | 值 |
| --- | --- |
| 源码 | `fix/history-reread`（提交见“提交”一节） |
| 验收构建 | `D:\Projects\Research\Oris-builds\stage1-rc\target\release\oris.exe`，SHA-256 `2FFBA4AC4BEF164A457F66E4CCA6AF9BA1DE31CCDE757EDFC2CA9C7F5955BA6A`，`verify_release_entry` 通过 |
| 修复前对照 | `Oris-builds\release-dd3bc20`（产品代码与 `80fa2d0` 相同），SHA-256 `92E1B499…` |
| 平台与工具 | Windows 11 专业版 10.0.22631；Git 2.44.0.windows.1；WebView2 Runtime 153.0.4234.48；Node v22.18.0；Rust 1.97.1（stable-x86_64-pc-windows-gnu） |

## 定位

方法：新增 `scripts/perf/v2-d60-history-reread.mjs`。历史页打开过一次后切回“提交”页，依次执行 fetch、pull（仅快进）、merge（快进）、push、切换分支（往返）、提交；stash push / pop 的入口在历史页左侧，只能在历史页可见时执行。每个操作统计点击 → 成功后 1.5 s 内的 Git 进程（`GIT_TRACE2_EVENT`），并用 CDP Network 记录前端的只读 IPC（`ipc.localhost` 请求，滤掉 CORS 预检），页面内订阅 `repository-invalidated` 事件，把每一次 `read_log` 归因到它之前最近的触发点。

修复前（1 轮定位运行的时间线，`artifacts/gui-probe/v2-d60-before-try/`）：

| 操作 | 历史重读 | 触发来源 |
| --- | --- | --- |
| fetch、pull、merge | 2 | 操作返回后 `runOp` 递增 refsVersion ×1；watcher `refs + global` 事件 ×1 |
| push、提交 | 3 | 操作返回 ×1；watcher `refs + global` ×2 |
| 切换分支 | 3–4 | 操作返回 ×1；watcher `refs + global` ×2–3 |
| stash push / pop（历史页可见） | 2 / 3 | watcher `refs + global` ×2 / ×3（stash 操作本身不递增 refsVersion） |

每次重读 = `read_refs`（symbolic-ref、rev-parse HEAD、rev-parse --is-shallow-repository、for-each-ref、remote、config ×3）+ `read_log`（for-each-ref、rev-parse HEAD、log）+ `commit_changes`（show、diff-tree），`global` 事件还会重读 stash 列表。与发布性能报告记录的“每次约 12 个命令、3–4 次”一致。

根因：

1. **watcher 把 `.git` 目录自身的修改当成“git 目录被重建”**：`watch.rs` 对路径为 `.git` 本身的事件发出 `refs + global`，且这一分支不做写操作尾窗口的回声判断。Windows 上 `.git` 中新建 / 删除任何文件（`index.lock`、`HEAD.lock`、`ORIG_HEAD`，以及操作结束时回写 index 的刷新）都会报告目录自身被修改，于是每次操作结束后都会多出 1–3 个 refs 事件。`refs/stash` 同样没有回声判断。手动刷新回写 index 时建立的 `index.lock` 也会产生同样的事件。
2. **历史页隐藏时仍立即重读**：`HistoryPanel` 挂载后不论是否可见，refsVersion 一变就重读 refs、日志与提交详情。
3. **提交详情随 refs 重读**：`commit_changes` 按固定的提交 OID 读取，结果不会随 refs 变化，却也依赖 refsVersion。
4. **同一次刷新内重复的只读命令**：三个拉取 / 合并配置各起一次 `config --get`；`read_refs` 与 `read_log` 各自解析一次 HEAD。

## 修复

| 位置 | 改动 |
| --- | --- |
| `src-tauri/src/watch.rs` | `.git` 目录自身与 `refs/stash` 的事件在写操作尾窗口内按回声跳过（修改时间不晚于操作结束），手动刷新回写 index 的窗口内同样跳过 `.git` 目录自身的事件。窗口外、以及操作结束之后才发生的修改照旧下发（`.git` 目录自身仍是全局 refs 失效）；真实的 refs 变化另有自身路径（`HEAD`、`refs/…`、`packed-refs`）的事件，不受影响 |
| `src/history-model.ts` `deferVersions` + `HistoryPanel` | 历史页可见时跟随 refs / stash 版本（每次变化重读一次）；不可见时只记下“已失效”，不读取；切回时一次追上最新版本，并在读到该版本之前**不显示不可见期间已过期的内容**：左侧分支列表与当前分支显示为读取中，提交行上的引用 / HEAD 标记暂不显示，“跳到 HEAD”暂不可用，stash 列表暂不显示。提交列表保留，滚动位置与选中提交不变。可见时的重读仍在原位替换（不闪烁，与修复前相同） |
| `HistoryPanel` | 提交详情按（提交 OID, 父节点）去重，refs 变化不重读；上一次读取失败或被新选择取代时才重新读取 |
| `src-tauri/src/git/history.rs` | 三个配置项（`branch.<当前分支>.rebase`、`pull.rebase`、`merge.ff`）合并为一次 `config -z --get-regexp`，取值规则与逐项 `--get` 相同（子节区分大小写，同一键取最后一个值，没有值的键为空字符串） |
| `src-tauri/src/git/refs.rs`、`log.rs` | HEAD 指向本地分支时，由 `for-each-ref` 的 `%(HEAD)` 取得当前分支与 OID，不再另起 `symbolic-ref` / `rev-parse`；日志默认起点中已有 HEAD 所在分支时不再单独解析 HEAD。分离 HEAD、分支尚无提交时按原方式读取 |
| `src/SyncPanel.tsx`、`App.tsx` | 同步弹层读到的 refs 交给上层（“上次获取”说明依赖 FETCH_HEAD 时间），历史页不可见时不必另读 |

## 验收

### 单元测试

| 时点 | 后端（`cargo test --no-default-features --lib`） | 前端（vitest） | tsc | desktop `cargo check` |
| --- | --- | --- | --- | --- |
| 基线 main `80fa2d0` | 143 通过 / 5 忽略 | 239（35 个文件） | 通过 | — |
| 阶段 1 | 146 / 5 | 243（35） | 通过 | 通过，无警告 |

新增用例：
- 后端 `watch::operation_tail_skips_git_dir_and_stash_echo`：窗口外 `.git` 目录事件仍为全局 refs；尾窗口内锁文件造成的目录修改与 `refs/stash` 被跳过；操作结束后的修改照常下发；index 回写窗口内跳过目录事件、refs 自身事件照常下发。
- 后端 `refs_view_config_values_match_individual_config_get`：合并读取的配置与逐项 `config --get` 一致（大小写、重复键、无值键）。
- 后端 `head_state_from_for_each_ref_matches_read_head`：分支上、分离 HEAD、尚无提交三种状态与逐项读取一致；分离 HEAD 时日志起点仍包含 HEAD。
- 前端 `history-model.test.ts`“deferVersions”：可见跟随、不可见只标记、切回一次追上、幂等、只有 stash 失效时不隐藏引用。
- 前端 `App.history.test.tsx`“V2-D60”：历史页不可见时写操作后不读取；切回时 refs 与日志各读一次，读完前不显示旧的 HEAD / 引用 / 分支列表、“跳到 HEAD”不可用；提交详情不重读；无新失效时切回不读取。历史页可见时一次写操作只重读一次，重读期间保持原有显示。

### Git 进程数（修复前后，S 数据集，3 轮，范围为最小–最大）

历史页打开过一次后切回“提交”页（报告 `artifacts/gui-probe/v2-d60-before/`、`v2-d60-after/`）：

| 操作 | 修复前：Git 进程 | 修复前：历史重读 | 修复后：Git 进程 | 修复后：历史重读 |
| --- | --- | --- | --- | --- |
| fetch | 17–50 | 1–3 | 17 | 0 |
| pull（仅快进） | 44–59 | 2–3 | 22 | 0 |
| merge（快进） | 22–52 | 1–3 | 16 | 0 |
| push | 37–57 | 3 | 22 | 0 |
| 切换分支 | 25–47 | 3–4 | 8–11 | 0 |
| 提交 | 52–77 | 2–3 | 11 | 0 |
| 切回历史页（此前 7 个写操作在“提交”页执行） | 26–31 | 0 | 7 | 1 |
| stash push（历史页可见） | 23–48 | 1–2 | 8 | 0 |
| stash pop（历史页可见） | 66–68 | 3 | 15 | 0 |

历史页始终可见（`--history-visible`，报告 `v2-d60-before-visible/`、`v2-d60-after-visible/`；提交需要“提交”页，历史页此时不可见）：

| 操作 | 修复前：Git 进程 | 修复前：历史重读 | 修复后：Git 进程 | 修复后：历史重读 |
| --- | --- | --- | --- | --- |
| fetch | 36–50 | 2–3 | 19 | 1 |
| pull（仅快进） | 48–55 | 2–3 | 25 | 1 |
| merge（快进） | 27–44 | 1–2 | 18 | 1 |
| push | 47–56 | 2–3 | 24 | 1 |
| 切换分支 | 20–54 | 2–4 | 11–15 | 1 |
| 提交 | 63–76 | 3 | 11 | 0 |
| stash push | 26–74 | 1–2 | 8 | 0 |
| stash pop | 28–69 | 1–3 | 14–15 | 0 |

说明：
- 修复前“切回历史页”的 26–31 个进程来自前一次手动刷新之后迟到的 refs 事件（见根因 1），不是切回本身；修复后切回的 7 个进程就是这一次重读（read_refs 4 个：rev-parse --is-shallow-repository、for-each-ref、remote、config；read_log 2 个：for-each-ref、log；stash 列表 1 个：rev-parse refs/stash），提交详情没有重读。
- 修复后 stash 操作不再重读历史（stash 不在日志起点中），只重读 stash 列表。
- 修复后同一次刷新内没有完全相同的只读命令；写操作前置检查中的 `remote`、`symbolic-ref`、`rev-parse` 与操作后的重读各执行一次（分别读取操作前后的状态，不能复用）。
- 发布性能报告中“历史页从未打开”时的进程数：fetch 13、pull 18、merge 17、push 18、切换分支 4–8。修复后历史页打开过但不可见时为 17、22、16、22、8–11，窗口内没有历史读取；两者的夹具与操作前步骤不完全相同（本脚本经同步弹层打开对话框、提交前在终端暂存），差值没有逐项归因。

### 界面回归（验收构建，CDP 页面事件）

| 套件 | 结果 |
| --- | --- |
| `v1-04-acceptance.mjs`（history + remote） | 32/32 |
| `v2-03-acceptance.mjs` | 24/24 |
| `v2-04-acceptance.mjs --only local` | 19/19 |
| `history-feedback-acceptance.mjs` | 12/12 |

脚本更新（因本次修复而过期，不是产品回归）：`v1-04-acceptance.mjs` 的“A08 分离 HEAD”检查原先在“操作输出”页可见时读取**隐藏的**历史页 DOM；修复后隐藏的历史页不再在后台重读，改为先切回历史页再检查，并新增断言“切回的那一帧不显示过期的当前分支”（切回时显示“● …”，读完后显示“分离 HEAD”）。第一次运行该项失败即为此原因。

所有界面证据为 CDP 页面事件，不是真实鼠标、键盘或 Windows 焦点。测试实例都经 `gui-lib` 的 `launchOris` 核验（PID、完整路径、主窗口句柄、CDP 端口归属），使用独立的 WebView2 用户目录与应用缓存目录，结束时用 `killOris` 关闭；没有调用任何窗口激活 API。

### 性能复测（验收构建，S 数据集，n ≥ 30）

方法与口径同[发布性能测试](v1-06-performance.md)：`release-perf-session.mjs --suites write,core,trace`（运行编号 stage1-20260928），负载监测每 5 s 采样。写操作 30 轮全部有效（外部进程 CPU 最高 3.67%，没有作废重测）；core 外部 CPU 最高 4.5%，trace 4.28%。原始报告：`artifacts/gui-probe/perf-stage1-20260928-*`（本地，不入库）。

| 场景（预算） | 发布性能测试 P50 / P95 / 最大 | 阶段 1 P50 / P95 / 最大 | 结果 |
| --- | --- | --- | --- |
| fetch（P95 ≤ 1.5 s） | 841.0 / 880.8 / 885.0 | 714.3 / 744.3 / 749.4 | 达标 |
| pull 仅快进（P95 ≤ 1.5 s） | 986.2 / 1,045.9 / 1,053.6 | 821.7 / 866.1 / 1,057.5 | 达标 |
| merge 快进（P95 ≤ 1 s） | 690.4 / 779.9 / 809.3 | 533.5 / 555.8 / 564.4 | 达标 |
| push（P95 ≤ 1.5 s） | 1,062.8 / 1,089.6 / 1,102.5 | 881.3 / 909.7 / 910.2 | 达标 |
| 切换分支 20 个文件（P95 ≤ 1 s，n = 60） | 527.7 / 685.2 / 731.2 | 417.9 / 508.8 / 537.5 | 达标 |
| stash push（P95 ≤ 1 s） | 789.4 / 836.9 / 869.2 | 692.7 / 710.4 / 713.8 | 达标 |
| stash pop（P95 ≤ 1.5 s） | 1,251.8 / 1,300.8 / 1,319.5 | 689.8 / 759.7 / 778.1 | 达标 |
| 热项目切换（P95 ≤ 100 ms） | 28.5 / 33.8 / 34.6 | 27.4 / 31.2 / 31.5 | 未退步 |
| 切换显示区域（P95 ≤ 50 ms，不启动 Git 进程） | 24.8 / 33.8 / 34.5；0 个 | 23.9 / 28.8 / 28.8；trace 6 次切换 0 个 | 未退步 |

写操作时延从“点击最后一个按钮”计到“状态成功且界面刷新完成后的下一帧”。发布性能测试的写操作套件在 stash 步骤打开过历史页，之后的操作都带有后台重读；本次 stash pop 下降最多（重读从 3 次降为 0 次，并与操作结束后的界面刷新不再争用）。core 套件的其余行（首次打开 317.3、已缓存 / 相邻 / 未缓存文件 23.9 / 23.6 / 32.4、后台 dirty 项目切回 203.1、200 次混合切换 P95 40.4）同样没有退步；“外部变化 → 界面更新”仍需要真实前台焦点，30 次都未自动更新，与发布性能测试相同（未验证）。

## 提交

- `22706a4` fix(history)：合并写操作后的历史页后台重读
- `f7417a7` perf(history)：同一次历史刷新内不重复解析 HEAD
- 文档与脚本更新（本报告、决策登记、发行说明、V2 任务总表、`v1-04-acceptance.mjs`）

## 与技术方案的差异

- 技术方案 §5.4 的 watcher 分类表没有“git 目录自身”一行；实现中它一直作为全局 refs 失效。本次保留窗口外的这一行为，只在写操作尾窗口与 index 回写窗口内按回声跳过。
- 历史页不可见时的失效改为“切回时读取”，这是 §5.4“后台项目只标记 dirty、切回前台再刷新”在页面级的同一做法。

## 未验证项

- 真实鼠标、键盘与 Windows 前后台焦点下的历史页切换（只有 CDP 页面事件）。
- 外部终端改变 refs 后的**自动**刷新（需要真实前台焦点，AGENTS.md 不允许抢焦点）；本次的 watcher 改动在窗口外不改变行为，由单元测试覆盖。
- macOS（FSEvents 对目录自身修改的报告方式与 Windows 不同，窗口外行为不变，窗口内按修改时间判断）。
- L 数据集（大仓库）下的进程数与后台 CPU：未测。

## 待用户决定

无。
