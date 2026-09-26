# V2-05 hunk 级暂存与丢弃：实现与验收结果

日期：2026-09-26（长链运行编号 20260926-1014）。任务：[V2-05](../tasks/v2/05-hunk-operations.md)。依据：[V2 验收计划](v2-acceptance.md) B15、B16、B17；[V2 技术方案](../architecture/v2-architecture.md) §3 写通道、§4 OperationRunner、§6 hunk 命令模板与 discard 备份；V2-02 的 stage / discard 实现（`src-tauri/src/git/ops/`）；一期 05 的空白规则（V2-D50）。

结论：**功能验收通过（Windows）**。B15 的每个场景（相邻块、CRLF、末尾无换行、非 UTF-8、显示后被外部修改、各禁用条件）都在后端测试与界面验收中通过，并附操作前后的 `git diff` / `git diff --cached` 与工作区、index、refs、stash、config 指纹；B16、B17 通过；写操作后阅读位置保持；文件切换类预算未退步。验收中发现并修复一个实际缺陷：丢弃一块时 `git apply` 按 `core.autocrlf`（Git for Windows 默认 true）把整个 LF 文件改写为 CRLF。块操作的 Git 确认时延 P95 约 750 ms（只作参照）；滚动场景的字号切换因块标题行再增加约 17 ms（该项在一期 05 已超预算）。未验证：macOS、真实焦点。

## 版本

- 分支 `feat/v2-05`（自 main `0ef5863`）：`ccfd34a` 功能、`47fe087` 修复与验收脚本，之后为回归与文档提交。
- 验收构建：`D:\Projects\Research\Oris-builds\v2-05\target\release\oris.exe`，SHA-256 `F3E69CC72013C0781574CF550E674FF73AF272D833B699BC41AC612982494536`；`scripts/build-release.ps1` 在 PowerShell 中构建，`verify_release_entry` 通过。
- 测试：后端 140 通过 / 5 忽略（一期 05 合入后 128 / 5，新增 hunk 相关 12 项）；前端 217 通过（30 个文件；新增 `hunk-model.test.ts` 6 项、`App.hunk.test.tsx` 7 项）；`npx tsc -b` 通过；desktop `cargo check` 无警告。

## 实现

后端（`src-tauri/src/git/ops/hunk.rs`）：
- **差异块来自 Git 的原始字节**：只读通道运行 `git diff -U0 --no-color --no-ext-diff --no-textconv --no-renames --diff-algorithm=myers --no-indent-heuristic`（固定 `diff.noprefix` / `mnemonicPrefix` / `color.diff`，不受用户配置影响），按字节解析；不使用前端解码后的文本计算边界。两侧原始字节（index / HEAD blob、工作区文件）的内容标识与读取内容时的 `contentId` 相同。
- **一块一个 patch**：上下文取自被应用的一侧（暂存取 index，取消暂存与丢弃取新一侧），因此相邻块互不影响；路径一律 C 风格加引号；处理“\ No newline at end of file”。
- **执行前核对**：重新扫描、重新计算块，核对两侧内容标识与块的行范围 + 摘要，不一致时拒绝（“文件在显示之后已被修改”）并返回刷新快照；再 `git apply --check`（`--cached` / `--reverse` 按操作），不通过时仓库不改动；都不自动重试。
- **丢弃**：先把整个工作区文件写入对象库并记录（R-DISCARD，可撤销，超过 50 MiB 需确认不可撤销）；`--check` 通过后，在工作区原始字节上只替换目标块的行（CRLF 文件中还原的行也用 CRLF），其余字节不动；无法逐行对应（其他 clean / smudge filter）时才交给 `git apply --reverse`。写入前再次核对内容标识。
- **OperationRunner**：新增 `hunkStage` / `hunkUnstage` / `hunkDiscard`，走同一 preflight（仓库写锁、rebase 等进行中状态、外部 `index.lock`），操作结束按影响维度精确刷新。
- **只读 IPC `hunk_map`**：返回 Git 报告的块、两侧内容标识，或整个文件不能做块操作的原因。
- 禁用（给出原因）：“全部”范围、冲突、新增 / 删除 / 重命名 / 未跟踪 / 类型变化、子模块、符号链接、二进制、超出内容预算（每侧 5 MiB / 100,000 行）、仅 mode 变化；mode 与内容同时变化时说明“文件模式变化不随块操作”。
- 编码不受支持的一侧附带逐字节（Latin-1）文本，经二进制帧传输，供“按单字节显示”使用。

前端：
- **块标题行**（[混合发布参考图](../design/04-mixed-release-ui-reference.md)：块操作在块标题行、使用完整动作文字；中央连接带保持纯阅读语义）：未暂存范围“暂存此块 / 丢弃此块”，已暂存范围“取消暂存此块”；并排视图放在右侧编辑器，统一视图放在唯一编辑器；写操作进行中、校验中按钮不可用并以提示说明。
- **一一对应**（`hunk-model.ts`）：显示的块（同一个 `DiffDocument`）按两侧行范围与 Git 的块完全相同才可以操作，对应不上的块不显示按钮，写明“与 Git 计算的差异块对应不上（两边的对齐方式不同），请使用文件级操作”。
- **按需读取**：块映射只在指针移入 diff 或键盘聚焦时读取（一次 `git diff -U0`），按范围与两侧内容缓存；在此之前按钮照常显示，点击时先读取并核对。浏览、切换文件与范围不启动 Git 进程（V2-01 的切换显示区域预算不受影响）。
- 丢弃此块先确认，结果进入状态栏“撤销丢弃”；文件级禁用原因常驻在阅读说明中（“块操作不可用：…”）。
- 编码不受支持的文件：说明卡片提供“按单字节（Latin-1）显示”，两侧逐字节显示（多字节字符为乱码，说明常驻），差异与块操作按原始字节计算；工具栏可退出（V2-D54 待定）。
- 写操作后先放块标题行、再恢复阅读位置（顺序反过来会让阅读位置下移，验收中发现并修复）。

## 验收逐项

后端测试：`src-tauri/src/git/ops/hunk_tests.rs`（B15 / B16 / B17）与 `hunk.rs` 单元测试；设置 `ORIS_HUNK_EVIDENCE` 时把每个场景的前后 `git diff` / `--cached` 与指纹写成 JSON（本轮在 `artifacts/long-chain/v2-05-evidence/`）。界面：`scripts/perf/v2-05-acceptance.mjs`（CDP 页面事件，报告 `artifacts/gui-probe/v2-05-acceptance/report-functional.json` 与回归运行的报告，每个写操作场景的前后输出在 `scenarios` 中）。

| 场景 | 结果 | 前后证据（变化的指纹类别） |
| --- | --- | --- |
| B15 暂存相邻块（第 20、22 行只隔一行） | 通过（后端 + 界面） | 已暂存只有目标块，未暂存少了目标块；只有 index 变化，工作区不变 |
| B15 取消暂存此块 | 通过 | 已暂存为空，4 块都回到未暂存；只有 index |
| B15 丢弃此块 + 撤销 | 通过 | 未暂存只少了目标块；只有工作区（index 内容不变）；撤销后整个文件逐字节恢复 |
| B15 CRLF | 通过 | index 中该行保留 CRLF，另一块仍未暂存；只有 index |
| B15 末尾无换行 | 通过 | 暂存最后一块后 index 仍无末尾换行；丢弃另一块不影响最后一行；只有 index / 工作区 |
| B15 非 UTF-8（Latin-1 字节） | 通过 | 后端直接操作；界面在明确选择“按单字节显示”后操作；index 中是原始字节；只有 index |
| B15 丢弃在 `core.autocrlf=true` 下（LF 工作区、CRLF 工作区） | 通过（后端） | 只还原目标块，其余字节（含换行）不变 |
| B15 显示后被外部修改 | 通过 | 拒绝执行（“文件在显示之后已被修改”）并刷新到新内容；`git diff` / `--cached` 与 index 内容不变，没有留下备份记录 |
| B15 `git apply --check` 拒绝 | 通过（后端） | patch 生成后外部改动 index，`--check` 拒绝且 index 不变；目标未变时同一 patch 通过 |
| B15 禁用：“全部”范围、忽略空白、冲突、二进制、子模块、超出内容预算、仅 mode 变化、新增文件 | 通过 | 不显示块操作，阅读说明写明原因（后端 `blocked` 与前端文件级判断） |
| B16 外部 `index.lock` | 通过（后端 + 界面） | 报错说明原因、不删除锁、没有任何变化、没有重试 |
| B16 写操作进行中 | 通过（沿用 V2-02） | 块按钮不可用并提示（同一 `writeBlockedReason`） |
| B17 只读 | 通过 | 浏览、切换文件与范围、读取块映射前后工作区、index 内容、refs、stash、config 不变 |
| 写操作后保持阅读位置 | 通过（界面） | 暂存一块后右侧顶部可见行不变 |

## 性能（Windows，release，CDP，n = 30）

构建 `F3E69CC7…`，P50 / P95 / 最大（ms）；负载：外部进程 CPU P95 4.7%、最大 5.2%，没有作废重测。

| 场景 | 反馈（点击到状态栏“正在…”） | Git 确认并刷新（到工具栏块数减一） | 参照 |
| --- | --- | --- | --- |
| 暂存此块（640 行、64 块的文件） | 17.5 / 20.7 / 23.9 | 708.5 / 754.8 / 759.7 | stage 单文件：乐观反馈 ≤ 50 ms / Git 确认 P95 ≤ 500 ms（只作参照，不是新预算） |
| 取消暂存此块 | 8.1 / 12.6 / 16.2 | 687.7 / 733.1 / 736.1 | 同上 |
| 丢弃此块（点击确认到块数减一） | 14.4 / 18.3 / 18.7 | 716.6 / 735.7 / 755.5 | — |

修复前的首轮测量（构建 `FC37BB0B…`，负载：外部进程 CPU 最大 2.8%）：暂存此块反馈 P50 17.1 / P95 23.6 ms，确认 720.7 / 752.2 ms；取消暂存反馈 9.3 / 14.6 ms，确认 685.9 / 720.3 ms；丢弃反馈 15.9 / 23.9 ms，确认 719.4 / 745.6 ms。

每次块操作启动的 Git 进程（`GIT_TRACE2_EVENT`，操作后 1.5 s 内）：**9 个**——执行前重新扫描的 `status`、`diff -U0`（按需块映射）、`apply --check`、`apply`（丢弃为备份用 `hash-object`，写回由 Rust 完成）、操作后精确刷新的 `status`，以及后台补齐统计的 `diff-index` ×3、`diff-files`。文件级 stage 在 V2-02 中约为 `add`、`status` 与统计查询，确认 P95 262 ms；块操作多出的执行前扫描、`diff`、`--check` 是确认时延高出的主要原因。是否为块操作设预算、是否合并执行前扫描，列为待用户决定。

文件切换类预算（同一构建，`v1-05-acceptance --only perf`）：已缓存 P95 29.0 ms、未缓存 36.7 ms、典型滚动通过，均未退步。

外观切换：块标题行在未暂存 / 已暂存范围中增加了编辑器的块结构，滚动到 3,000 行文件中部时字号切换 P95 由一期 05 的约 99–103 ms 升到约 116–130 ms（同一脚本 A/B；“全部”范围没有块标题行，两者一致：P50 84 / 79 ms）；配色、模式切换约增加 10 ms，仍在 100 ms 内。该项在一期 05 已未达标，一并交给发布性能测试处理。

## 与参考图和技术方案的差异

- 技术方案 §6 写“`apply --cached` / `apply --cached --reverse` / `apply --reverse`，执行前先 `--check`”。丢弃一块时仍先 `apply --reverse --check`，但写回改为在工作区原始字节上替换目标块的行：`git apply` 写工作区会按 `core.autocrlf` 重写整个文件的换行，不符合“只丢弃目标块”。无法逐行对应时仍用 `git apply`。
- 块映射按需读取（指针移入 / 键盘聚焦），不在显示时读取，避免浏览启动 Git 进程（V2-D55 待定）。
- 块操作只提供给“已修改”的文本文件；新增 / 删除 / 重命名等使用文件级操作（V2-D55 待定）。
- 非 UTF-8 的块操作需要先选择“按单字节显示”（V2-D54 待定）。
- 块丢弃备份整个文件，撤销恢复整个文件；块操作不带上 mode 变化（V2-D56 待定）。

## 回归（同一构建 `F3E69CC7…`）

| 界面验收 | 结果 | 报告 |
| --- | --- | --- |
| v2-05（本阶段） | 14/14，时延与进程数见上 | `artifacts/gui-probe/v2-05-reg-v2-05/` |
| v1-05（阅读） | 37/37 | `artifacts/gui-probe/v2-05-reg-v1-05/` |
| v1-04 | 32/32 | `artifacts/gui-probe/v2-05-reg-v1-04/` |
| v2-03 | 24/24 | `artifacts/gui-probe/v2-05-reg-v2-03/` |
| v2-04 `--only local` | 18/18 | `artifacts/gui-probe/v2-05-reg-v2-04/` |
| v2-06 | 全部通过 | `artifacts/gui-probe/v2-06-acceptance/` |
| history-feedback | 12/12 | `artifacts/gui-probe/v2-05-reg-history-feedback/` |
| gui-probe `--suite task03` | 17/17 | `artifacts/gui-probe/v2-05-reg-task03/` |
| v1-05 性能复测（文件切换、滚动、外观） | 文件切换与滚动通过；外观切换字号项未达标（见上） | `artifacts/gui-probe/v2-05-reg-perf/` |

## 未验证项

- **macOS 全部**：用户在 macOS 真机上验证（2026-09-25），Oris 自动化未复核；机型 / 芯片、内存、macOS 版本、被测构建、覆盖范围、原始记录位置：用户口头确认，范围未记录。V2-05 晚于该次验证，最终版本的 macOS 复测交给用户（一期 06）。
- 真实鼠标、键盘与 Windows 焦点：界面证据都是 CDP 页面事件；“指针移入”为 CDP 鼠标移动。
- 其他 clean / smudge filter（如 Git LFS 跟踪的文本）下的块丢弃：代码走 `git apply` 回退路径，未单独测试。
- 统一视图中的块操作只做了代码路径与单元测试，界面验收在并排视图中进行。

## 待用户决定

V2-D54–V2-D56（[决策登记](../decisions/v2-decisions.md#待用户决定)），以及：块操作是否设时延预算（当前 P95 约 750 ms）、是否把执行前的重新扫描与块映射合并以减少 Git 进程。

## 复现

```powershell
& .\scripts\build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\v2-05
node scripts/perf/v2-05-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v2-05\target\release\oris.exe
```

GUI 安全：只通过 `gui-lib.mjs` 的 `launchOris` 启动并核验自己的实例（PID、完整路径、主窗口句柄、CDP 端口归属），独立 WebView2 profile 与 `ORIS_APP_CACHE_DIR`；不调用任何窗口激活 API；结束时正常关闭并删除本轮临时目录。一次中途停止的时延测量：确认没有遗留的 node / Oris 进程后删除了其运行目录。
