# V2-02 暂存、丢弃与提交：实现与验收结果

日期：2026-09-24。任务：[V2-02](../tasks/v2/02-stage-commit.md)。依据：[V2 产品规格](../specs/v2-product.md) R-STAGE、R-DISCARD、R-COMMIT、R-OPSAFE，[V2 技术方案](../architecture/v2-architecture.md) §3、§4、§6，[V2 验收计划](v2-acceptance.md) B05–B08、B16、B17 与 §3，界面参考 [一二期混合发布参考图](../design/04-mixed-release-ui-reference.md)（`oris-mixed-release.html`）。

结论：**功能验收通过（Windows）；性能复测暂缓**。B05–B08、B16、B17 的后端测试与 CDP 界面验收全部通过，每个写操作都有操作前后的仓库状态对比。stage / unstage 与 commit 的时延实测在预算内，但测量期间机器上有其他任务（多个 `testhost` 进程，约占 5 个核心）并行运行，V2-01 预算的 A/B 复测结果受干扰、不能据此下“没有退步”的结论；用户决定性能测试计划暂缓、另行安排（2026-09-24）。因此本任务未合入 main，只推送分支 `feat/v2-02`。未验证：macOS 全部；真实鼠标、键盘与 Windows 前后台焦点（所有界面证据为 CDP 页面事件）。

## 版本

| 项目 | 值 |
| --- | --- |
| 分支 | `feat/v2-02`（自 main `27c7725`） |
| 功能验收构建 | `D:\Projects\Research\Oris-builds\v2-02\target\release\oris.exe`，SHA-256 `5BF9EB82ABD356728F4FE7CF3019FFB4393D78CBD3C0426E42C0EDC73EBD6DBA`（`scripts/build-release.ps1`，PowerShell，`verify_release_entry` 通过） |
| main 对照构建 | `Oris-builds/v2-06-main`（`EF7C2E92B357…`，与当前 main 代码一致，main 其后只改了文档） |
| 平台 | Windows 11 Pro 10.0.22631、Git 2.44.0.windows.1（系统配置 `core.autocrlf=true`、`core.editor=devenv.exe`） |
| 测试 | 后端 90 通过、5 忽略（基线 67 / 5）；前端 147（基线 130，含配色生成器 5 项、静态颜色检查 2 项）；`tsc -b` 通过；desktop `cargo check` 无告警 |
| 新增依赖 | 无（Job Object 用手写的 kernel32 FFI） |

## 实现摘要

- **写通道**（`src-tauri/src/git/ops/process.rs`）：去掉 `--no-optional-locks`，允许 hooks 与 filter；继续禁用 external diff 与 fsmonitor 命令；`GIT_EDITOR` / `GIT_SEQUENCE_EDITOR` 设为 Git 内置空操作 `:`（本机系统配置的编辑器是 devenv.exe，不设会卡住）；路径一律经 `--pathspec-from-file=- --pathspec-file-nul` 与 `GIT_LITERAL_PATHSPECS=1` 传递，前端 pathId 先校验为仓库内相对路径。输出逐行转发到界面（`operation-output` 事件），URL 凭据脱敏，保留 256 KiB。取消时用 Job Object 终止 git 及其派生的 hook 进程（其他平台用进程组）。
- **OperationRunner**（`git/ops/mod.rs`、`lib.rs`）：前端只提交 `OperationRequest` 操作描述；仓库级写锁，忙时直接拒绝（不排队）；前置检查外部 `index.lock`（报错、不删除）与不支持的进行中状态（rebase / cherry-pick / revert / bisect 禁用全部写操作，合并中禁止修订与撤销提交）；结束后一次允许回写 stat 缓存的 status（V2-D09），快照随结果返回，前端不再另发刷新；任何写操作都不自动重试。取消或失败后同样重新读取并如实报告（例如“提交已生成”“检测到遗留 index.lock，Oris 不会删除”）。
- **watcher 屏蔽窗口**（`watch.rs`）：操作期间该仓库事件只合并不下发；结束后 1.5 s 尾窗口内只跳过“修改时间不晚于操作结束”的事件与操作删除的路径，之后发生的外部修改照常下发。
- **R-STAGE**：stage 为 `add -A`（删除也被暂存），unstage 为 `restore --staged`，空 HEAD 为 `rm --cached`；rename 取消暂存时同时给出原路径。冲突文件“标记已解决”是 stage 的变体：文件仍含冲突标记时先要求确认。前端乐观更新（条目立即移动并标“确认中”，revision 不变，统计与缓存继续可用），Git 确认后用返回的快照替换，前置检查失败时恢复原显示。
- **R-DISCARD**：未暂存范围（已跟踪 `restore --worktree`，未跟踪由 Rust 删除并清理变空的目录，不跟随上级符号链接）与“全部”范围（`restore --source=HEAD --staged --worktree`；index 新增的文件 `rm --cached` 后删除；暂存 rename 的原路径一并恢复）。丢弃前工作区原始字节经 `hash-object -w --no-filters` 入库，暂存内容记录 OID 与 mode；备份记录先落盘再执行丢弃，写入应用数据目录，每仓库 20 次。撤销丢弃：先核对对象仍存在（被 gc 清理时如实说明），文件在丢弃后又被修改时再次确认，暂存部分用 `update-index -z --index-info` 恢复。单文件超过 50 MiB 不备份并在确认框标“不可撤销”。gitlink 与冲突文件不能丢弃并说明原因。
- **R-COMMIT**：`commit -F -`；amend 为 `--amend -F -`，信息未改时 `--amend --no-edit` 只并入暂存；撤销最近提交为 `reset --soft <第一个父提交>`，根提交为带旧值校验的 `update-ref -d HEAD <oid>`（分离 HEAD 上的根提交不提供）。已推送保护：`merge-base --is-ancestor HEAD @{u}`，后端执行前再核对一次；amend 与撤销带 `expectedHead`，HEAD 已变化时拒绝。hooks 照常执行，不提供 `--no-verify`；签名按用户 git config。
- **界面**（按参考图）：文件行“暂存 / 取消暂存 / 标记已解决”文字按钮；复选框只选择批量目标；**丢弃只在右键菜单提供**；有勾选时右键（点在任何文件上）直接对全部勾选项批量暂存 / 取消暂存 / 标记已解决 / 丢弃，没有勾选时作用于右键的文件（用户 2026-09-24 要求）；标题栏显示领先 / 落后与“提交 · N”入口；底部可收起的 Git 区“提交”页（摘要 + 正文、提交暂存区 · N 个文件、草稿说明、amend、提交、撤销最近提交…，hooks 运行中可取消）与“操作输出”页（最近一次操作的 Git 输出、可撤销的丢弃）；状态栏显示操作结果并可展开输出，丢弃成功后可直接“撤销丢弃”。写入口在快照校验中、另一写操作进行中、不支持的进行中状态时禁用并说明原因。草稿按项目保存在 localStorage，重启后恢复，提交成功后清空。

## 验收逐项

后端测试：`src-tauri/src/git/ops/tests.rs`（每个用例比较操作前后的 index / HEAD 与 refs / config / 工作区指纹）。界面验收：`scripts/perf/v2-02-acceptance.mjs --only functional`，36/36 通过，21 次写操作逐次记录仓库指纹（`artifacts/gui-probe/v2-02-acceptance/report.json` 的 `operations`，全部只在预期类别内变化）。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| B05 stage / unstage | 通过 | 后端：修改、删除、工作区 rename 两端（暂存后配对为 rename）、特殊字符路径（`空 格/中文 #[x].txt`）、未跟踪的批量暂存与取消暂存，只改 index、工作区不变；空 HEAD 取消暂存；失败的暂存报告 Git 错误且只执行一次；越界路径被拒绝，形似选项的文件名 `--output=x` 只作为字面路径。界面：单文件与批量（右键菜单、批量栏）、已暂存范围显示 rename 原路径、空 HEAD、外部锁导致失败时乐观更新回滚。前端：乐观移动、确认后替换、前置失败回滚 |
| B06 discard | 通过 | 后端与界面：未暂存（CRLF 文本、二进制、删除、未跟踪 + 空目录清理）与“全部”范围（暂存且工作区再改、index 新增、暂存 rename、暂存删除、未跟踪）结果正确；撤销后工作区逐字节恢复、`ls-files -s` 与丢弃前一致；丢弃后又被修改时再次确认（取消不改动）；50 MiB+1 文件确认框标“不可撤销”、记录标注不可撤销、撤销时如实说明未能恢复；gitlink 与冲突不可丢弃并说明原因；备份对象被 `git prune` 清理后撤销如实报错。打开丢弃确认框（只读计算）不改动仓库 |
| B07 commit / amend / 撤销 | 通过 | 多行、Unicode、引号与 `$` 的信息原样写入；无暂存时提交失败且不生成提交；amend 只改信息（父提交不变、默认填入原信息）、amend 并入暂存（信息不变）；撤销普通 / 合并（回到第一个父提交）/ 根提交（回到无提交、文件留在暂存区），确认框分别说明后果，工作区不变；已推送的 HEAD 禁用 amend 与撤销并说明原因，领先 1 后可撤销；草稿重启后恢复；HEAD 在外部变化时 amend / 撤销被拒绝 |
| B08 hooks / 取消 / 签名 | 通过 | pre-commit 失败：界面展示 hook 的 stderr 与 stdout，没有生成提交，暂存与草稿保留；hook 运行中取消：进程树中的 `sh.exe`、`sleep.exe` 与提交用的 git 全部结束，hook 后续写入没有发生，HEAD 不变（后端用例取消后 3 s 内返回）；`commit.gpgsign=true` 且签名程序不存在时给出含 “gpg” 的清晰错误；可用的签名程序（测试替身，输出 `SIG_CREATED` 状态行）时提交对象带 `gpgsig`。本机未用真实 GPG 密钥验证 |
| B16 并发与锁 | 通过 | 同仓库第二个写操作被拒绝（`operationBusy`），不同仓库互不影响；hook 运行期间界面其他写入口禁用并说明原因；外部 `index.lock`：stage / discard / commit 都在启动任何写进程之前报错，锁文件内容不变、仓库不变；失败的命令只执行一次（进程计数 1）；外部 rebase 进行中：横幅说明、写入口全部禁用、阅读正常 |
| B17 只读回归 | 通过 | 后端：stat 过期时 `prepare_discard`、`head_commit_info`、丢弃记录查询前后 `.git/index` 逐字节不变（V2-01 原有 B17 用例继续通过）。界面：浏览、切换范围 / 文件 / 项目、打开提交页与丢弃确认框、重启与快照恢复前后工作区、index、refs、config 都不变；手动刷新只改 `.git/index`。写操作后的 stat 回写发生在操作结束时的刷新中，属于限定时机 |
| 写通道安全 | 通过 | `core.fsmonitor` 与 `diff.external` 设为标记脚本时，stage 与 commit 都不执行它们 |

实现中发现并修复的问题：

1. V2-01 遗留：扫描 revision 不含进行中状态，外部开始 rebase 而 status 输出不变时复用旧扫描状态，界面看不到“rebase 进行中”。revision 已计入进行中标记（回归用例 `in_progress_state_changes_the_revision_even_when_status_output_is_identical`）。
2. 提交页读取的 HEAD 信息可能落后于快照（例如刚修订完就点撤销），后端的 `expectedHead` 拒绝了操作（没有撤销错误的提交）；界面改为 HEAD 信息与快照 HEAD 一致之前不提供修订与撤销。
3. watcher 尾窗口原先按路径跳过回声，会吞掉操作结束后立刻发生的外部修改；改为按修改时间判断。

## 写操作的 Git 进程数（界面验收，`GIT_TRACE2_EVENT`，含动作后 1.5 s 内的后台补齐）

| 操作 | 进程数 | 构成 |
| --- | ---: | --- |
| stage / unstage（单文件或批量） | 6 | `add` 或 `restore --staged` 1 + 结束刷新 `status` 1 + 后台统计 4（`diff-files`、`diff-index` ×3） |
| 外部 `index.lock` 时 stage | 0 | 前置检查即拒绝 |
| discard 未暂存 | 8–10 | 读取当前状态 `status` 1 + `hash-object --stdin-paths` 1 + `restore` 1 + 结束刷新 1 + 统计 4（夹具含子模块时 Git 另起 `status --porcelain=2` 检查子模块） |
| discard “全部”范围 | 9 | 同上，另加 `rm --cached` 1 |
| 撤销丢弃 | 8 | `cat-file --batch-check` 1 + `cat-file --batch` 1 + （“全部”范围另加 `update-index`）+ 刷新 1 + 统计 4 |
| commit（无 hooks） | 11（观测 15，含上一动作的后台统计） | `commit` 1 + Git 自带的 `maintenance run --auto` 1 + 刷新 1 + 统计 4 + 提交页读取 HEAD 信息 4（`log`、`rev-parse @{u}`、`merge-base`、`symbolic-ref`） |
| 撤销最近提交 | 13 | 已推送核对 2 + `rev-list` 1 + `reset --soft` 1 + 刷新 1 + 统计 4 + HEAD 信息 4 |

## §3 时延

写操作（`v2-02-acceptance.mjs --only latency`，S 数据集 S1，n=30，CDP，构建 `486DF9FD…`；此后的改动不涉及写操作路径）。**测量时段是否有外部负载未记录**（负载监测是在之后的 A/B 中才加的），数据仅供参考：

| 场景 | P50 / P95 / 最大（ms） | 预算 |
| --- | --- | --- |
| stage 单文件：乐观反馈（点击到该行离开列表并绘制） | 20.2 / 26.2 / 30.4 | ≤ 50 |
| stage 单文件：Git 确认（确认中消失、revision 更新、状态栏显示结果） | 214.2 / 262.4 / 272.6 | P95 ≤ 500 |
| unstage 单文件：乐观反馈 | 7.0 / 11.6 / 17.3 | ≤ 50 |
| unstage 单文件：Git 确认 | 264.0 / 320.1 / 334.2 | P95 ≤ 500 |
| commit（无 hooks）：到文件列表与分支领先计数刷新 | 492.2 / 621.7 / 626.4 | P95 ≤ 1000 |

V2-01 预算 A/B（`gui-probe --suite core`，n=30，同一脚本，先 main 后新构建），P50 / P95 ms：

| 场景 | 第 1 轮 main | 第 1 轮 V2-02（`486DF9FD`） | 第 2 轮 main | 第 2 轮 V2-02（`E53A21B2`） | S 目标 |
| --- | --- | --- | --- | --- | --- |
| 首次打开 | 321.0 / 402.7 | 311.5 / 718.8 | 291.2 / 427.4 | 463.5 / 556.4 | ≤ 1500 |
| 热项目切换 | 22.5 / 29.9 | 24.8 / 28.0 | 21.4 / 25.6 | 40.1 / 55.0 | ≤ 100 |
| 切换显示区域 | 17.2 / 25.2 | 19.5 / 33.5 | 17.9 / 23.3 | 47.1 / **52.2** | ≤ 50 |
| 已缓存文件 | 13.9 / 32.1 | 16.5 / 18.3 | 14.1 / 21.0 | 37.6 / 43.6 | ≤ 100 |
| 相邻文件（预取） | 16.1 / 31.5 | 17.4 / 36.8 | 21.0 / 32.5 | 24.6 / 36.4 | ≤ 100 |
| 未缓存常用文件 | 22.4 / 36.0 | 26.5 / 44.0 | 23.1 / 26.7 | 38.7 / 49.9 | ≤ 400 |
| 后台 dirty 切回 | 189.6 / 203.7 | 198.4 / 388.1 | 187.8 / 297.7 | 320.3 / 373.4 | ≤ 800 |
| 200 次混合（参考） | 28.2 / 40.8 | 36.5 / 53.9 | 54.4 / 78.3 | 59.1 / 100.5 | — |

判断：第 2 轮期间出现 3 个外部 `testhost` 进程（16:33、16:54 启动，合计约 5 个核心），V2-02 那一段全程受影响，切换显示区域 P95 52.2 ms 超出预算，不能作为结论；第 3 轮（加入负载监测）main 那一段中途 `testhost` 再次出现，main 自身 dirty 切回 P95 达 944 ms，随后按用户决定停止。第 1 轮没有观察到外部负载，V2-02 各项都在目标内，但首次打开与 dirty 切回的 P95 高于 main（单次长尾）。第 1 轮后做了一处减少切换项目时多余重渲染的调整（`56f4fcc`）。**V2-01 预算是否退步、trace 套件（切换显示区域是否启动 Git 进程）与 V2-D29 分层内存，都留待用户安排的性能测试**；原始数据在 `artifacts/gui-probe/v2-02-ab*`。

## 与参考图和技术方案的差异

| 参考图 / 方案 | 实现 | 原因 |
| --- | --- | --- |
| 参考图文件行只有“暂存 / 取消暂存 / 标记解决”，批量栏为“批量操作 ▾” | 行上按钮一致（“标记已解决”沿用规格用词）；批量栏为“暂存所选 / 取消暂存所选 / 标记已解决 / 清除 / 全选”；丢弃只在右键菜单（含批量） | 用户 2026-09-24 要求丢弃走右键菜单；规格 §3 要求右键菜单 |
| 参考图底部 Git 区四个页签（日志、提交、Stash、操作输出） | 只有“提交”“操作输出” | 日志属 V1 04，Stash 属 V2-03，不放不可用的页签 |
| 参考图提交页有“提交并推送…”，标题栏有分支弹层与“同步” | 未实现，标题栏只显示分支与领先 / 落后 | 推送、同步、分支操作属 V2-03 / V2-04 |
| 参考图侧栏标题显示“已暂存 N · 未暂存 N” | 未显示；标题栏“提交 · N”显示已暂存数 | 本任务未改侧栏标题 |
| 原标题栏“▣ 只读”标记 | 移除 | 引入写操作后不再准确 |
| 技术方案 §3 写通道未提 fsmonitor | 写通道继续强制 `core.fsmonitor=false` | 与只读通道同样的安全理由（命令字符串形式的 fsmonitor 不执行），只影响速度 |
| 技术方案 §4 取消用 Job Object | 进程启动后再加入 Job，未用挂起创建 | 标准库不暴露主线程句柄；git 启动 hook 前有数十毫秒，窗口可忽略。不设 KILL_ON_JOB_CLOSE，正常结束时 hook 有意留在后台的进程保持终端中的行为 |
| 技术方案 §4 watcher 屏蔽后“解除屏蔽” | 另加 1.5 s 尾窗口，只跳过修改时间不晚于操作结束的事件 | 200 ms 合并窗口的迟到事件会造成一次多余刷新 |
| 技术方案 §6 已推送判断只在只读通道 | 前端显示用 `head_commit_info`，后端执行 amend / 撤销前再核对一次 | 防止显示与执行之间的变化 |
| 技术方案 §6 撤销丢弃“从备份对象写回工作区” | 写回原始字节；丢弃前还记录丢弃后的内容哈希，用于“又被修改”判断 | R-DISCARD 要求再次确认 |
| 丢弃备份目录 | 应用数据目录；`ORIS_APP_DATA_DIR` 可覆盖，隔离测试实例设置了 `ORIS_APP_CACHE_DIR` 时也写在其下 | 测试实例不写入用户的应用数据目录 |

## 未验证与已知限制

- **性能复测暂缓**（用户决定）：V2-01 §3 预算 A/B、`gui-probe --suite trace`（V2-01 遗留的切换显示区域后台 Git 进程复核）、V2-D29 分层内存（5 项目前台总开销 ≤ 210 MiB）都没有在干净时段完成。写操作时延的测量时段负载未记录。
- 真实焦点：所有界面验收为 CDP 页面事件，不是真实鼠标、键盘或 Windows 前后台焦点；外部变化自动刷新仍只在窗口有原生焦点时发生（V2-01 行为），本轮不能验证。
- macOS 全部未运行（进程组取消、符号链接恢复等分支只在代码中实现）。
- 签名只用测试替身验证了“按配置执行”，未用真实 GPG / SSH 密钥。
- 丢弃“全部”范围时，同一路径既是暂存删除又是未跟踪文件的罕见组合，扫描结果按路径去重后只处理其中一条。
- 空提交页在尚未显示过 diff 时两端标题挤在左侧（既有布局行为，与本任务无关）。

## 复现

```powershell
& D:\Projects\Research\Oris-v2-02\scripts\build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\v2-02
$env:PATH = "D:\Tools\Rust\mingw-binutils\mingw64\bin;" + $env:PATH + ";D:\Tools\Rust\msys2\msys64\mingw64\bin"
$env:CARGO_TARGET_DIR = "D:\Projects\Research\Oris-builds\v2-02\target-test"
cargo test --no-default-features --lib   # 在 src-tauri 目录
npx tsc -b; npx vitest run
node scripts/perf/v2-02-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v2-02\target\release\oris.exe --only functional
node scripts/perf/v2-02-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v2-02\target\release\oris.exe --only latency --label v2-02-latency
node scripts/perf/gui-probe.mjs --exe <main 或 V2-02 构建> --label <名称> --suite core,trace,memory
```

GUI 安全（AGENTS.md）：开工前复查了 `scripts/focus-task02-window.ps1`（直接抛错、不调用任何窗口 API）及 `scripts/task02-feedback-*.mjs`（无 `ShowWindow`、`SetForegroundWindow`、`AppActivate` 调用），本轮未修改它们。验收脚本只经 `launchOris` 启动并核验自己的实例（PID、完整 exe 路径、主窗口句柄、CDP 端口归属），用独立的 `WEBVIEW2_USER_DATA_FOLDER` 与 `ORIS_APP_CACHE_DIR`；不调用任何窗口激活 API，不操作其他应用窗口；结束时用 `killOris` 正常关闭。测试仓库全部在 `%TEMP%\oris-gui` 下创建并在结束后删除；中途停止的性能复测已确认没有遗留进程，并删除了其运行目录。
