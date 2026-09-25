# V2-03 stash 与分支切换：实现与验收结果

日期：2026-09-24。任务：[V2-03](../tasks/v2/03-stash-branch.md)。依据：[V2 产品规格](../specs/v2-product.md) R-STASH、R-BRANCHOP、R-OPSAFE 与 §3 界面落点，[V2 技术方案](../architecture/v2-architecture.md) §3、§4、§6，[V2 验收计划](v2-acceptance.md) B09、B10、B16、B17，界面参考 [一二期混合发布参考图](../design/04-mixed-release-ui-reference.md)（“分支与同步”“Stash”场景）。依赖：V2-02（已合入）、V1 04（`ef4529a` 已合入）。

结论：**功能验收通过（Windows）**。B09、B10、B16、B17 与“切换后刷新”（M4）的后端测试与 CDP 界面验收全部通过，每个写操作都有操作前后的仓库状态对比。未验证：macOS 全部；真实鼠标、键盘与 Windows 前后台焦点（界面证据为 CDP 页面事件）；全部性能计时与内存（按用户安排另行测量）。

## 版本

| 项目 | 值 |
| --- | --- |
| 分支 | `feat/v2-03`（自 main `ef4529a`）：`c732ff5` 后端、`4574f3d` 前端、`3215fd0` 修复与验收脚本、本报告所在提交 |
| 功能验收构建 | `D:\Projects\Research\Oris-builds\v2-03\target\release\oris.exe`，SHA-256 `B4DFC5D54E8B8A4E7BFDF155C8F63195ECE26CAA6F05393F00DCAC635EB8F279`（`scripts/build-release.ps1`，PowerShell，`verify_release_entry` 通过） |
| 平台 | Windows 11 Pro 10.0.22631、Git 2.44.0.windows.1、WebView2 |
| 测试 | 后端 109 通过、5 忽略（长链基线 90 / 5，一期 04 后 101 / 5）；前端 170（基线 149，一期 04 后 161）；`tsc -b` 通过；desktop `cargo check` 无告警 |
| 回归 | 一期 04 界面验收（历史 20 项 + 本地 bare remote 12 项）在本构建上全部通过（`artifacts/gui-probe/v1-04-regression-on-v2-03/report.json`） |
| 新增依赖 | 无 |

## 实现摘要

- **只读查询**（`git/stash.rs`、`lib.rs`）：`stash_list`（`refs/stash` 的 reflog：序号、OID、说明、所在分支、时间、储藏时的 HEAD、未跟踪部分）、`stash_changes`（已跟踪部分为“储藏时的 HEAD → stash 树”，未跟踪部分为“空树 → 第三个父节点”）、`check_branch_name`（`check-ref-format --branch`，并拒绝 `-` 开头、`@{`、`HEAD`、控制字符与会被展开的写法）。stash 内容经一期 04 的 `read_revision_pair` 按固定 OID 读取，在同一个 diff 阅读器中显示。
- **stash 写操作**（`git/ops/stash.rs`）：`stash push [--include-untracked] [-m] [--pathspec-from-file]`；执行后核对 `refs/stash` 确实新增，否则报告“没有可储藏的改动”。apply / pop / drop 执行前核对 `stash@{n}` 仍指向列表中的 OID，列表在外部被修改时拒绝执行并由前端重读列表。apply 按 OID 执行；pop = 按 OID apply，没有冲突后再次核对身份再 drop，出现冲突时 stash 保留，冲突文件进入任务 03 的只读冲突查看。
- **分支写操作**（`git/ops/branch.rs`）：新建（起点 HEAD / 完整分支名 / 提交 OID，先解析为 OID，`branch --no-track`，可选立即切换）；切换本地分支（`switch --no-guess`）；远端跟踪分支建立同名本地跟踪分支（`switch -c <name> --track <remote>/<branch>`，同名本地分支已存在时返回需要选择）；检出提交（`switch --detach <oid>`）；重命名（`branch -m`）；删除（不能删当前分支；`branch -d` 报告未合并时返回强确认，确认后 `-D`，说明原指向的 OID 与 reflog 找回方式）；设置 / 更换上游（`branch --set-upstream-to`）。
- **stash 后切换**：Git 因“工作区改动会被覆盖”或“未跟踪文件会被覆盖”拒绝切换时，返回需要确认（列出 Git 给出的路径），不改仓库；确认后先 `stash push`（只有 Git 报告未跟踪文件会被覆盖时才含未跟踪）再切换，**不自动恢复**，结果说明新 stash 的位置与恢复方式。新建并切换、检出远端分支、检出提交都走同一流程。
- **界面**：标题栏分支按钮打开弹层（搜索；本地分支显示上游状态，“切换”与“更多 ▾”：从这里新建、重命名、设置 / 更换上游、删除；远端跟踪分支“检出”“新建…”）；新建分支、重命名、设置上游、同名跟踪选择对话框（分支名随输入按 Git 规则校验）；删除分支先确认，未合并再强确认；底部 Git 区新增“Stash”页（说明、包含未跟踪、只储藏选中的文件——文件列表的单选或 Ctrl / Shift 多选；列表、应用 / 弹出 / 删除（确认，标明无法撤销）；所选 stash 的已跟踪与未跟踪文件分组，点开在主阅读器显示）；日志页提交右键加入“检出（分离 HEAD）”“从这里新建分支…”；分离 HEAD 时编辑区上方常驻横幅并提供“从这里新建分支…”。
- **切换后刷新（M4）**：分支类操作结束后，阅读的文件仍在当前范围时保持文件与差异位置，已不在时回到第一个可用文件并提示“此前选中的文件已不在当前比较范围中…”。写操作结束后按影响维度刷新：只有改变 HEAD / 分支 / 远端跟踪引用的操作才重读分支列表与日志，只有改变 `refs/stash` 的操作才重读 stash 列表；watcher 的 `stash` 事件也触发 stash 列表重读。

## 验收逐项

后端测试：`src-tauri/src/git/ops/branch_tests.rs`（8 项，均比较操作前后的 index、HEAD 与本地分支、stash、config、工作区）。前端：`src/App.branch.test.tsx`（9 项）。界面验收：`scripts/perf/v2-03-acceptance.mjs`，24 项全部通过，23 次写操作与只读步骤逐次记录仓库指纹（`artifacts/gui-probe/v2-03-acceptance/report.json` 的 `operations`，全部只在预期类别内变化）。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| B09 保存 | 通过 | 界面：带说明、不含未跟踪——已跟踪改动与暂存进入 stash，`u.txt` 保留，只改 index / `refs/stash` / 工作区；只储藏选中的文件（在文件列表选中 `u.txt`）并含未跟踪——只移走 `u.txt`，`a.txt` 的改动保留。后端另覆盖只储藏选中的已跟踪文件、没有改动时不创建 stash、不带路径的 `-u` 会移走未跟踪文件并在弹出后恢复 |
| B09 查看 | 通过 | 未跟踪部分单独列出（“未跟踪文件 · 1”），在主阅读器以“空树 → 未跟踪部分”显示；已跟踪部分相对储藏时的 HEAD 显示 |
| B09 apply / pop / drop | 通过 | 应用后改动恢复、stash 保留；弹出成功后从列表删除且未跟踪部分恢复；删除前确认框标明无法撤销，只改 `refs/stash` |
| B09 列表在外部被修改 | 通过 | 命令行在 Oris 列表刷新前新储藏一条，随即在界面删除原来的 `stash@{0}`：状态栏“stash@{0} 已不是列表中的那一条（stash 列表在外部被修改），已拒绝执行”，仓库 0 处变化，列表刷新为 3 条，原 stash 仍在（`stash@{1}`）。后端同时覆盖 apply / pop / drop 的身份核对 |
| B09 冲突保留 | 通过 | HEAD 上提交了不同内容后弹出：失败并说明“出现冲突：stash 已保留”，`ls-files -u` 非空，冲突文件显示只读冲突工具栏；stash 仍在；外部解决后由用户自行删除 |
| B10 新建 / 切换 / 跟踪 | 通过 | 分支名 `bad name` 被拒绝（按钮不可用并说明）；从选中的起点 `origin/main` 新建且不切换，只新增 `refs/heads/topic-new`；切换本地分支 feature；`origin/remote-only` 检出为同名跟踪分支（`@{u}` = `origin/remote-only`）；`origin/feature` 检出时已存在同名本地分支，对话框让用户选择，换名 `feature-2` 建立跟踪 |
| B10 重命名 / 删除 / 上游 | 通过 | 重命名当前分支，上游配置随之移动；设置上游只改 config；删除已合并分支一次确认；删除未合并分支先确认、再强确认（说明原指向的 OID，之后只能通过 reflog 找回），确认前仓库不变；当前分支的“删除…”不可用并说明原因 |
| B10 检出与从这里新建 | 通过 | 日志右键“检出（分离 HEAD）”：HEAD 分离到该提交，横幅常驻；横幅“从这里新建分支…”新建并切换后横幅消失，只改 HEAD 与新分支 |
| B10 stash 后切换 | 通过 | 工作区改动阻止切换到 feature：确认框说明原因并列出 `a.txt`，确认前仓库不变；确认后储藏再切换，`a.txt` 为 feature 的内容（不自动恢复），stash 说明为“Oris：切换到 feature 前储藏”，结果提示可在“Stash”页恢复。未跟踪文件会被覆盖时，确认框说明“包含未跟踪文件”，确认后储藏（stash 带第三个父节点）再切换 |
| M4 切换后刷新 | 通过 | 阅读未跟踪的 `notes.txt` 时切换分支：仍停在 `notes.txt`；阅读 `a.txt` 时 stash 后切换（`a.txt` 不再有变化）：回到合法入口并提示 |
| B16 并发与锁 | 通过 | 外部 `index.lock` 存在时切换分支：在启动任何写进程前报错说明，锁文件内容不变，仓库不变，没有重试。后端：stash push、新建并切换、检出同样被拒绝；写锁与“同仓库一次一个写操作”沿用 V2-02 |
| B17 只读回归 | 通过 | 浏览分支弹层（含搜索）、打开“新建分支”后取消、打开 Stash 页：仓库 0 处变化。后端：`stash_list`、`stash_changes`、`stash_oid`、`check_branch_name` 与读取 stash 内容在 stat 过期时也不改 `.git/index` |

实现与验收中发现并修复的问题：

1. **写通道默认 `GIT_LITERAL_PATHSPECS=1` 会让不带路径的 `stash push --include-untracked` 留下未跟踪文件**：Git 在储藏后用魔术路径 `:/` 清理已储藏的未跟踪文件，字面量路径下匹配不到任何文件，结果文件既进了 stash 又留在工作区。不带用户路径的 stash 命令改为不设字面量路径（`process::RunOptions`），带路径时仍按字面量传递；增加回归测试。
2. **`read_refs` 的请求互相取消**：分支弹层、日志页与获取确认框同时读取 refs 时，后到的请求让先到的返回 `staleRequest`，弹层停在“正在读取分支…”。refs 读取廉价且结果相同，改为互不取消。一期 04 的获取确认框同样可能受影响，此次一并修复。
3. 写操作结束后原先无论什么操作都重读分支列表、日志与 stash 列表；改为按影响维度只重读受影响的部分。

## 写操作的 Git 进程数（界面验收，`GIT_TRACE2_EVENT`，含动作后 1.5 s 内的后台补齐）

| 操作 | 进程数 | 说明 |
| --- | ---: | --- |
| 新建分支（不切换） | 8 | `check-ref-format` 1 + 解析起点与校验 5（`rev-parse`）+ `branch --no-track` 1 + 结束刷新 `status` 1 |
| 切换本地分支 | 12 | 校验 5 + `switch` 1 + 刷新 `status` 1 + 统计 4 + `symbolic-ref` 1 |
| 检出远端分支（跟踪） | 15 | 校验与 `remote` 7 + `switch -c --track` 1 + 刷新与统计 5 + 其余 |
| stash push（不含未跟踪） | 20 | `stash push` 1 与其内部的 `reset --hard`、`update-index` + 核对 `refs/stash` 前后 + 刷新与统计 + Stash 页重读列表（`rev-parse`、`log -g`）与所选 stash 内容 |
| stash apply | 17 | 核对身份 + `stash apply` 1（内部 `status`）+ `ls-files -u` + 刷新与统计 + Stash 页重读 |
| 检出提交（日志页打开时） | 55 | 除操作本身外，日志页与 Stash 页都在重读（分支列表、第一页日志、选中提交的变化、stash 列表与内容） |
| stash 后切换（日志页打开时） | 79 | 两次操作（第一次被 Git 拒绝返回确认，确认后储藏 + 切换），每次结束都刷新状态并重读日志页与 Stash 页 |

写操作后的重读随打开的页签增加；这些是只读进程，不写仓库。进程数只作记录，未计时。

## 与参考图和技术方案的差异

| 参考图 / 方案 | 实现 | 原因 |
| --- | --- | --- |
| 参考图分支弹层“当前 / 最近”分组 | 只有“本地分支”“远端跟踪分支”两组，当前分支标 ●；不记录“最近” | 规格要求本地 / 远端分组；“最近”需要额外持久化，未在规格中 |
| 参考图 Stash 行“查看文件”按钮 | 选中一行即在右栏列出文件，点开进入主阅读器 | 与日志页一致，少一步点击 |
| 参考图批量操作下拉含“储藏” | Stash 页的“只储藏选中的文件”使用文件列表的单选或 Ctrl / Shift 多选 | 沿用 V2-02 不设复选框的多选方式 |
| 技术方案 §6 `stash 应用 / 弹出` 为 `stash apply / pop` | apply 按 OID 执行；pop = 按 OID apply 后再核对身份并 drop | 避免在核对与执行之间列表被外部修改时作用到另一条 stash；冲突时保留与 Git 的 pop 一致 |
| 技术方案 §6 切换为 `switch <name>` | 本地分支加 `--no-guess`，防止名称意外匹配远端分支而自动建立跟踪 | 远端分支的跟踪由单独的“检出”入口显式完成 |
| 技术方案 §6 新建为 `branch <name> <oid>` | 加 `--no-track`，起点为远端分支时也不自动设置上游 | 上游由“设置上游”显式设置 |
| 写通道 `GIT_LITERAL_PATHSPECS=1` | 不带用户路径的 stash 命令不设 | 见“修复的问题”第 1 条 |

## 待用户决定（已确认）

> 2026-09-25：以下各项已由用户按推荐确认，见 [V2 决策登记](../decisions/v2-decisions.md) V2-D38–V2-D49。其中 fetch 只对外部 `index.lock` 放开（rebase 等进行中仍禁用）；“合并远端改动”已改为不强制 `--no-ff`（V2-D47）。

1. 删除 stash 在确认框中标为“无法撤销”（只能用 `git fsck` 从悬空对象找回）；目前没有像丢弃那样的撤销备份。
2. “stash 后切换”只在 Git 报告未跟踪文件会被覆盖时才包含未跟踪文件；其余情况只储藏已跟踪文件的改动，未跟踪文件留在工作区跟随切换。
3. 新建分支一律不设置上游（包括从远端跟踪分支新建）；需要跟踪时用远端分支的“检出”或“设置上游”。
4. 合并进行中（冲突未解决）时，分支与 stash 操作不在 Oris 前置检查中拦截，交给 Git 报错（例如 Git 拒绝在有未合并文件时切换）。

## 未验证与已知限制

- macOS 全部未运行。
- 真实焦点：所有界面证据为 CDP 页面事件，不是真实鼠标、键盘或 Windows 前后台焦点。
- 性能：分支弹层、stash 列表、切换后的刷新都没有计时；进程数只作记录。
- Git 拒绝切换时列出的路径取自 Git 输出的最后 12 行，文件很多时只列出其中一部分。
- stash 列表上限 500 条，未做虚拟列表。

## 复现

```powershell
& D:\Projects\Research\Oris-v2-03\scripts\build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\v2-03
$env:PATH = "D:\Tools\Rust\mingw-binutils\mingw64\bin;" + $env:PATH + ";D:\Tools\Rust\msys2\msys64\mingw64\bin"
$env:CARGO_TARGET_DIR = "D:\Projects\Research\Oris-builds\v2-02\target-test"
cargo test --no-default-features --lib   # 在 src-tauri 目录
npx tsc -b; npx vitest run --maxWorkers=1 --no-file-parallelism
node scripts/perf/v2-03-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v2-03\target\release\oris.exe
node scripts/perf/v1-04-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v2-03\target\release\oris.exe --label v1-04-regression-on-v2-03
```

GUI 安全（AGENTS.md）：开工前复查了 `scripts/focus-task02-window.ps1`（直接抛错、不调用任何窗口 API）及 `scripts/task02-feedback-*.mjs`（无 `ShowWindow`、`SetForegroundWindow`、`AppActivate` 调用），本轮未修改它们。验收脚本只经 `launchOris` 启动并核验自己的实例（PID、完整 exe 路径、主窗口句柄、CDP 端口归属），使用独立的 `WEBVIEW2_USER_DATA_FOLDER` 与 `ORIS_APP_CACHE_DIR`；不调用任何窗口激活 API，不操作其他应用窗口；结束时用 `killOris` 正常关闭（本轮全部为温和关闭）。测试仓库全部在 `%TEMP%\oris-gui` 下创建并在结束后删除。
