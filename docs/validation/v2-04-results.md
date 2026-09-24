# V2-04 远端同步与合并：实现与验收结果

日期：2026-09-24。任务：[V2-04](../tasks/v2/04-sync-merge.md)。依据：[V2 产品规格](../specs/v2-product.md) R-SYNC、R-MERGE、R-OPSAFE 与 §3 界面落点，[V2 技术方案](../architecture/v2-architecture.md) §3、§4、§6、§8，[V2 验收计划](v2-acceptance.md) B11–B14、B16–B18，界面参考 [一二期混合发布参考图](../design/04-mixed-release-ui-reference.md)（“分支与同步”“合并冲突”场景）。依赖：V2-02、V1 03（冲突只读查看）、V1 04（`ef4529a`）、V2-03（`ea46b46`，“stash 后拉取”复用其储藏流程）。

结论：**功能验收通过（Windows）**。B11–B14、B16、B17、B18 的后端测试与 CDP 界面验收全部通过；真实远端 AgentHub 上 SSH 与 HTTPS 各自的获取、拉取、推送、推送被拒绝与首次推送设置上游都在 Oris 界面中完成，结束后只删除了本次创建的测试分支。未验证：macOS 全部（osxkeychain、进程组取消）；真实鼠标、键盘与 Windows 前后台焦点（界面证据为 CDP 页面事件）；凭据缺失时的交互认证；全部性能计时与内存（按用户安排另行测量）。

## 版本

| 项目 | 值 |
| --- | --- |
| 分支 | `feat/v2-04`（自 main `ea46b46`）：`6b05660` 后端、`0d0c83f` 前端、`cf7dfa7` 修复与验收脚本、本报告所在提交 |
| 功能验收构建 | `D:\Projects\Research\Oris-builds\v2-04\target\release\oris.exe`，SHA-256 `EE474B62715B7A51E23B6ED954F0FDCB8080F3133462297232FC60A0389EB69C`（`scripts/build-release.ps1`，PowerShell，`verify_release_entry` 通过） |
| 平台 | Windows 11 Pro 10.0.22631、Git 2.44.0.windows.1、WebView2；本机 GCM 与 ssh-agent（账号 Zhao-wl） |
| 测试 | 后端 119 通过、5 忽略（长链基线 90 / 5，V2-03 后 109 / 5）；前端 177（基线 149，V2-03 后 170）；`tsc -b` 通过；desktop `cargo check` 无告警 |
| 回归 | 同一构建上一期 04（32 项）与 V2-03（24 项）界面验收全部通过（`artifacts/gui-probe/v1-04-regression-on-v2-04`、`v2-03-regression-on-v2-04`） |
| 新增依赖 | 无 |

## 实现摘要

- **pull**（`git/ops/sync.rs`）：`pull --progress --no-rebase --no-autostash --no-recurse-submodules` 加 `--ff-only`（默认）或 `--no-ff --no-edit`（合并）；不带仓库参数，拉取当前分支配置的上游。`pull.rebase` / `branch.<name>.rebase` 为 true 时照样以合并执行。无上游、分离 HEAD、合并进行中时拒绝执行并说明。仅快进因分叉失败时返回“改用合并”确认；工作区改动或未跟踪文件会被覆盖时返回“stash 后拉取”确认（复用 V2-03 的储藏步骤，不自动恢复）；拉取合并出现冲突时进入“合并进行中”。结束后报告快进 / 合并提交 / 已是最新，失败、取消、超时时重读 HEAD 与远端跟踪引用如实说明，不回滚。
- **push**：只推送当前分支，显式 refspec `refs/heads/<分支>:<上游引用>`，`--no-follow-tags`（即使配置了 `push.followTags` 也不推送 tag）、`--recurse-submodules=no`；没有上游时推送到所选 remote 的同名分支并 `--set-upstream`。被拒绝时说明“远端有本地没有的新提交，请先拉取；Oris 不提供强制推送”。不接受 `+` 或自定义目标。
- **merge**：目标为完整分支名或提交 OID，执行前核对它仍是界面显示的 OID（已移动则拒绝）；按该 OID 执行 `merge --no-edit --no-autostash [--no-ff]`，合并信息按 Git 的默认写法给出（`Merge branch 'x'`、`Merge remote-tracking branch 'origin/x'`）；其余遵循 `merge.ff`。冲突进入“合并进行中”；`merge --abort`；冲突全部标记解决后以（可编辑的）`.git/MERGE_MSG` 默认信息 `commit -F -` 完成合并，hooks 照常执行。
- **网络操作通用**：沿用一期 04 的写通道能力——`--progress` 输出逐行推送并在状态栏显示最新一行、取消时结束整个进程树、无输出超时（初始 60 s）、认证类错误附可操作提示、输出中 URL 凭据脱敏。拒绝原因（本地改动 / 未跟踪文件会被覆盖）在本次操作的全部输出中识别，不依赖错误尾部。
- **进行中状态**：外部 rebase / cherry-pick / revert / bisect 进行中时，所有写操作（含新增的拉取、推送、合并、完成合并）在前置检查中被拒绝，界面入口全部禁用并保留横幅（V2-02 已有的检测覆盖到新入口）。
- **界面**：标题栏“⇅ 同步 ▾”取代原“⇣ 获取…”，弹层显示当前分支 → 上游、领先 / 落后与获取时间，展开“获取…”“选项…”（拉取）“预览…”（推送）；无上游时拉取不可用并提供“设置上游…”，标题栏显示“无上游”；分离 HEAD 时推送不可用。拉取对话框：仅快进（默认）/ 合并远端改动，配置了 pull.rebase 时说明会以合并执行。推送预览：目标与领先的提交数，没有上游时选择 remote（只有一个时默认选中）。合并入口：分支弹层本地分支“更多 ▾ → 合并到当前分支…”、远端跟踪分支“合并…”、日志右键“合并到当前分支…”；合并对话框可勾选“总是创建合并提交”。合并进行中横幅：冲突数、“查看冲突”（切到未暂存范围并打开第一个冲突文件的只读冲突阅读）、“中止合并…”（确认）、冲突全部标记解决后“完成合并…”（可编辑默认合并信息）。

## 验收逐项

后端测试：`src-tauri/src/git/ops/sync_tests.rs`（10 项，均比较操作前后的 index、HEAD 与本地分支、远端跟踪引用、stash、config、工作区）。前端：`src/App.sync.test.tsx`（7 项）。界面验收：`scripts/perf/v2-04-acceptance.mjs`，本地 bare remote 18 项、真实远端 11 项全部通过（`artifacts/gui-probe/v2-04-acceptance/report-local.json`、`report-real.json`），每次写操作都记录仓库指纹。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| B11 仅快进 / 合并 | 通过 | 界面：获取后 `↑0 ↓1`，拉取（仅快进）HEAD 快进到上游、计数回到 `↑0 ↓0`；分叉时仅快进失败并说明“已分叉，无法仅快进”，HEAD 不变，确认“改用合并拉取”后生成两个父节点的合并提交、本地提交未被改写、没有 rebase 目录 |
| B11 `pull.rebase=true` | 通过 | 拉取对话框说明“pull.rebase=true：Oris 不做 rebase，会以合并方式执行”，执行结果为合并提交（后端同样断言） |
| B11 stash 后拉取 / 无上游 | 通过 | 本地未提交的 `a.txt` 会被覆盖：确认框列出 `a.txt`，确认后储藏再拉取，`a.txt` 为远端版本、stash 说明“拉取前储藏”、不自动恢复；无上游的分支拉取不可用并引导设置上游。后端：30 个文件的拒绝列表仍被识别为本地改动并列出全部路径 |
| B11 推送 | 通过 | 推送到上游；首次推送默认选中唯一的 remote，远端出现同名分支且设置了上游；被拒绝时提示先拉取，远端 main 未被改写，界面按钮与菜单中没有任何强制推送；配置 `push.followTags=true` 时本地 tag 仍未推送 |
| B12 进度 / 取消 / 超时 | 通过 | 推送约 4 MB 时操作输出含 `Writing objects` 等进度行；拉取（慢速 upload-pack）时点“取消”：状态“已取消…HEAD 未变化”，取消前进程树中有 `sh` / `sleep`，取消后都不在；测试实例无输出超时设为 4 s：“超过 4 秒没有任何输出，已终止…可能需要先在终端完成首次主机认证”；12 s 后被终止的脚本没有留下标记文件 |
| B12 认证失败 | 通过 | 本地 401 服务、清空凭据助手：拉取失败并给出认证提示，进程树中没有凭据助手进程，25 s 内结束。后端另覆盖推送的认证失败 |
| B12 真实凭据环境（Windows） | 通过 | 见下文“真实远端”：SSH（ssh-agent）与 HTTPS（GCM 已保存的凭据）均可用；macOS（osxkeychain）未运行 |
| B13 合并 | 通过 | 快进（遵循 merge.ff）；勾选“总是创建合并提交”生成 `Merge branch 'topic'`；冲突：横幅“合并进行中 · 1 个冲突”，“查看冲突”进入只读冲突阅读；中止合并后 HEAD、index 条目与工作区回到合并前；再次合并 → 外部写入解决结果 → “标记已解决”（文件仍含冲突标记时先警告）→ “完成合并…”显示默认信息 `Merge branch 'clash'`，编辑后完成，HEAD 为两个父节点的合并提交、信息含编辑内容 |
| B14 不支持的进行中状态 | 通过 | 界面：外部 rebase 冲突进行中时横幅说明，获取 / 拉取 / 推送等入口全部禁用，阅读正常，仓库不变。后端：rebase、cherry-pick、revert、bisect 四种状态下拉取、推送、合并、完成合并、获取、切换分支、储藏、提交全部被拒绝，仓库不变 |
| B16 并发与锁 | 通过 | 外部 `index.lock` 存在时拉取在启动任何写进程前报错，锁文件内容不变，仓库不变，没有重试 |
| B17 只读回归 | 通过 | 打开同步弹层、拉取与推送对话框后取消：仓库 0 处变化 |
| B18 凭据脱敏 | 通过 | remote URL 带 `alice:s3cret-token@`：状态栏与操作输出都不含凭据（界面与后端，拉取与推送）；`redact` 单元测试覆盖 URL 中的用户名与密码 |

实现与验收中发现并修复的问题：

1. **拒绝原因被挤出错误尾部**：写通道只保留 stderr 的最后 12 行，Git 列出很多文件时“Your local changes … would be overwritten”的提示头不在其中，拉取 / 切换被报告为普通失败，不提供“stash 后拉取 / 切换”。改为在本次操作的全部输出中识别并列出路径（最多 200 个），并加回归测试。V2-03 的切换同样受益。
2. 拉取 / 推送对话框在 refs 读取完成前就显示“还没有上游”；改为先显示“正在读取当前分支与上游…”。
3. 合并按完整引用名执行时 Git 生成的信息为 `Merge branch 'refs/heads/topic'`；改为按核对过的 OID 执行并给出 Git 默认写法的信息，也消除了核对与执行之间目标移动的窗口。

## 真实远端（AgentHub）

- 远端与账号按 V2-D34：`git@github.com:Zhao-wl/AgentHub.git` 与 `https://github.com/Zhao-wl/AgentHub.git`，Zhao-wl。克隆在 `%TEMP%\oris-remote\20260924-2031\v2-04`（克隆时 `-c core.autocrlf=false`）；HTTPS 克隆只在自身 `.git/config` 写入 `credential.https://github.com.username=Zhao-wl`，命令行克隆用 `-c` 传入；未改全局 / 系统配置，未读取或输出凭据。测试实例从不带 `GCM_INTERACTIVE` 的环境启动（`report-real.json` 的 `environment`）。
- 每种协议的流程（全部在 Oris 界面中操作，辅助克隆只负责在测试分支上制造远端提交）：获取 → 在分支弹层把 `origin/<测试分支>` 检出为跟踪分支 → 辅助克隆推送一个提交 → Oris 拉取（仅快进）→ 本地提交后 Oris 推送 → 辅助克隆再推送一个提交后 Oris 推送（被拒绝）→ 新建分支后 Oris 首次推送并设置上游。

| 协议 | 获取 | 拉取（仅快进） | 推送 | 推送被拒绝 | 首次推送设上游 | 认证弹窗 |
| --- | --- | --- | --- | --- | --- | --- |
| SSH（ssh-agent） | 通过 | 通过 | 通过 | 通过（提示先拉取，远端未被改写） | 通过 | 无 |
| HTTPS（GCM 已保存的凭据） | 通过 | 通过 | 通过 | 通过 | 通过 | 无 |

- 本次运行创建并已删除的分支：`oris-test/20260924-2031/v2-04-ssh`、`…/v2-04-ssh-new`、`…/v2-04-https`、`…/v2-04-https-new`（两轮运行各一次；第一轮因下一条所述的夹具问题部分失败，同样只删除了这些分支）。结束后 SSH `ls-remote` 只剩 `HEAD` 与 `refs/heads/main`（`fc9be5c`，与开工时相同）。
- 第一轮的夹具问题（已修正）：辅助克隆用系统配置 `core.autocrlf=true` 检出后才改为 false，导致辅助克隆在 SSH 测试分支上的第一个提交改写了全部文件的行尾；这只发生在本次运行的测试分支上，该分支已删除，main 未受影响。它也暴露了上面“修复的问题”第 1 条。
- 认证方案（V2-D12）：常见场景（ssh-agent、GCM 已保存凭据）可用，不需要提出 askpass 方案。凭据缺失时 GCM 的交互行为、SSH 首次连接的主机指纹确认未运行（只用无输出超时的本地模拟覆盖“卡住”的情形）。

## 写操作的 Git 进程数（本地 bare remote，`GIT_TRACE2_EVENT`，含动作后 1.5 s 内的后台补齐）

| 操作 | 进程数 | 说明 |
| --- | ---: | --- |
| 获取 | 29 | 打开同步弹层与获取确认框各读取一次 refs（每次约 7 个：`symbolic-ref`、`rev-parse` ×2、`for-each-ref`、`remote`、`config` ×3 中的一部分）+ 校验 remote + 前后对比 `for-each-ref` ×2 + `fetch` 1 + 本地传输时 Git 派生的 `upload-pack` / `pack-objects` / `rev-list` / `unpack-objects` + 结束刷新 `status` 1 + 统计 4 |
| 拉取（仅快进） | 34 | 同上的界面读取 + 读取上游配置 + `pull` 1 与其派生的 `fetch`、`merge --ff-only`、传输进程，以及 Git 自带的 `maintenance run --auto` + `rev-list --parents` + 刷新与统计 |
| 推送到上游 | 42 | 界面读取 + 读取上游配置 + `rev-list --count` + `push` 1 与传输进程（远端侧的 `receive-pack`、`unpack-objects` 与 `gc --auto` 由 Git 在远端运行）+ 刷新与统计 |
| 合并（总是创建合并提交） | 35 | 打开分支弹层与合并对话框的 refs 读取 + 核对 OID + `merge` 1（Git 内部 `stash create` 与 `maintenance run --auto`）+ 刷新与统计 |
| 中止合并 | 2 | `merge --abort` 1 + 刷新 `status` 1 |
| 完成合并 | 8 | `ls-files -u` 1 + `commit -F -` 1（Git 自带 `maintenance run --auto`）+ 刷新与统计 5 |

进程数只作记录，未计时。打开弹层与对话框时的 refs 读取是只读的；这部分可以在后续合并为一次读取（未在本任务中优化）。

## 与参考图和技术方案的差异

| 参考图 / 方案 | 实现 | 原因 |
| --- | --- | --- |
| 参考图提交页“提交并推送…” | 未提供；提交与推送分开 | 规格未要求组合操作，避免一次点击完成两个写操作 |
| 参考图同步弹层“拉取到当前分支 · 选项…”“推送 · 预览…” | 一致；另在无上游时提供“设置上游…” | R-SYNC“无上游时不可用，并引导设置上游” |
| 技术方案 §6 pull 模板 | 另加 `--no-autostash` | 用户配置 `merge.autoStash` 时 Git 会自动储藏并恢复，与“stash 后拉取”的显式确认冲突 |
| 技术方案 §6 push 为 `push --progress [-u <remote> <branch>]` | 显式 refspec + `--no-follow-tags --recurse-submodules=no` | 不受 `push.default`（如 matching）、`push.followTags`、`push.recurseSubmodules` 配置影响，只推送当前分支 |
| 技术方案 §6 merge 为 `merge --no-edit [--no-ff] <oid>` | 一致，另加 `--no-autostash` 与按 Git 默认写法的 `-m` 信息 | 见上与“修复的问题”第 3 条 |
| 技术方案 §4 fetch 不触发维护 | pull / merge / 完成合并时 Git 仍可能运行 `maintenance run --auto`（与在终端执行相同） | 任务 04 只对 fetch 排除了额外维护；V2-02 的提交同样如此。是否对 pull 也关闭见“待用户决定” |
| 参考图合并横幅“查看冲突”“中止合并…” | 一致，另有“完成合并…”（冲突全部标记解决后出现） | R-MERGE |

## 待用户决定

1. 拉取、合并、完成合并时 Git 自带的 `maintenance run --auto`（后台 gc 等）是否也像 fetch 一样关闭（`-c maintenance.auto=false`）。目前保持与终端一致。
2. “合并远端改动”按技术方案使用 `--no-ff`：即使可以快进也会生成合并提交。若希望“合并”在可快进时直接快进，需要改为不带 `--no-ff`。
3. 合并对话框在 `merge.ff=false` 时默认勾选“总是创建合并提交”（与配置一致）；其他情况默认不勾选。
4. 推送被拒绝时只提示先拉取，不提供“拉取后再推送”的一键组合。

## 未验证与已知限制

- macOS 全部未运行（osxkeychain、进程组取消）。
- 真实焦点：所有界面证据为 CDP 页面事件，不是真实鼠标、键盘或 Windows 前后台焦点。
- 性能：同步、拉取、推送、合并的时延与内存都没有测量；“stash 后拉取”等流程的进程数只作记录。
- 真实远端只验证了已保存凭据下的静默认证；凭据缺失时的 GCM 交互、SSH 首次主机指纹确认未运行。pre-push hook 较长时间没有输出时会被无输出超时终止（未单独验证）。
- 推送预览中的“领先 N 个提交”来自本地快照，不代表服务器实时状态（界面已注明）。

## 复现

```powershell
& D:\Projects\Research\Oris-v2-04\scripts\build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\v2-04
$env:PATH = "D:\Tools\Rust\mingw-binutils\mingw64\bin;" + $env:PATH + ";D:\Tools\Rust\msys2\msys64\mingw64\bin"
$env:CARGO_TARGET_DIR = "D:\Projects\Research\Oris-builds\v2-02\target-test"
cargo test --no-default-features --lib   # 在 src-tauri 目录
npx tsc -b; npx vitest run --maxWorkers=1 --no-file-parallelism
node scripts/perf/v2-04-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v2-04\target\release\oris.exe --only local
node scripts/perf/v2-04-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v2-04\target\release\oris.exe --only real --run-id <运行编号>
```

GUI 安全（AGENTS.md）：开工前复查了 `scripts/focus-task02-window.ps1`（直接抛错、不调用任何窗口 API）及 `scripts/task02-feedback-*.mjs`（无 `ShowWindow`、`SetForegroundWindow`、`AppActivate` 调用），本轮未修改它们。验收脚本只经 `launchOris` 启动并核验自己的实例（PID、完整 exe 路径、主窗口句柄、CDP 端口归属），使用独立的 `WEBVIEW2_USER_DATA_FOLDER` 与 `ORIS_APP_CACHE_DIR`；不调用任何窗口激活 API，不操作其他应用窗口；结束时用 `killOris` 正常关闭（本轮全部为温和关闭）。测试仓库在 `%TEMP%\oris-gui`、真实远端克隆在 `%TEMP%\oris-remote` 下创建并在结束后删除。
