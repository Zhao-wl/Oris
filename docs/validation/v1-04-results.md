# 一期任务 04 提交、分支、版本比较与文件历史：实现与验收结果

日期：2026-09-24。任务：[04](../tasks/04-history-branches.md)。依据：[V1 产品规格](../specs/v1-product.md) R-HISTORY、R-BRANCH、R-COMPARE、R-FILEHISTORY、R-REMOTE，[V1 验收计划](v1-acceptance.md) A07–A10，[V2 技术方案](../architecture/v2-architecture.md) §3、§4（fetch 经写通道与 OperationRunner），界面参考 [一二期混合发布参考图](../design/04-mixed-release-ui-reference.md)。开工依据 V2-D33（沿用 V2-D27：一期 02、03 Windows 基础通过 + 代码已提交即可开工）。

结论：**功能验收通过（Windows）**。A07、A08、A09、A10（本地 bare remote 全部场景 + 真实远端 AgentHub 的 SSH 与 HTTPS fetch）、B17 只读回归、键盘浏览与大量提交渐进加载（计数类断言）全部通过，每次 fetch 都有操作前后的仓库状态对比。未验证：macOS 全部；真实鼠标、键盘与 Windows 前后台焦点（界面证据均为 CDP 页面事件）；全部性能计时与内存（按用户安排另行测量，本轮不测）。

## 版本

| 项目 | 值 |
| --- | --- |
| 分支 | `feat/v1-04`（自 main `d340c75`）：`b3b523b` 决策登记、`de4c57d` 后端、`4afb438` 前端、`0c6123d` 修复与验收脚本、本报告所在提交 |
| 功能验收构建 | `D:\Projects\Research\Oris-builds\v1-04\target\release\oris.exe`，SHA-256 `E862379D413C8AD591296849ECC525C1BDD496A2780CBB3AF9591E1DDF43D2DF`（`scripts/build-release.ps1`，PowerShell，`verify_release_entry` 通过） |
| 真实远端验收构建 | 同目录上一版 `0C0563AE4BE3255CC65965022AF69B2F797D642FE5EDBD7F29C17672208E9BA7`；与最终构建只差分支栏 CSS（`flex-shrink`）、侧栏标题文字与“没有 remote”提示，fetch 代码相同 |
| 平台 | Windows 11 Pro 10.0.22631、Git 2.44.0.windows.1、WebView2 |
| 测试 | 后端 101 通过、5 忽略（基线 90 / 5）；前端 161（基线 149）；`tsc -b` 通过；desktop `cargo check` 无告警 |
| 新增依赖 | 无 |

## 实现摘要

- **只读命令**（`src-tauri/src/lib.rs`、`git/history.rs`）：按接入清单暴露 `read_log`、`commit_changes`、`compare_revisions`、`file_history`、`read_refs`，另加 `read_revision_pair`。参数为类型化结构（`LogQuery`、`LogCursor`、引用名、pathId），引用只接受 `HEAD`、完整的 `refs/heads|remotes|tags/…` 与提交 OID，其余（`--all`、`HEAD~1`、`a..b`、短分支名等）一律拒绝。每种请求有独立的仓库级代次：同种类的新请求使旧请求返回 `staleRequest`，前端丢弃；分页续读沿用当前代次。
- **两端内容**（`git/content.rs` `tree_entry` / `read_revision_pair`）：“commit:path → OID”用 `ls-tree -z --full-tree <oid> -- <path>`（字面量路径），对象经 V2-01 的常驻 `cat-file --batch` 与 BlobCache 读取，图片与文本复用任务 03 的 `read_side_with`（图片阅读器、LFS 指针、预算）。两端都是已固定的提交 OID，从不读 index 或工作区，因此历史中的合并提交不会用当前 index 的冲突 stage 冒充。根提交左侧为空树；某端不存在该路径时记为缺失（不伪造空文件）；rename 时左侧按原路径读取。
- **文件历史**：`--follow -M`，并加 `--diff-merges=first-parent`（Git ≥ 2.31），合并时解决冲突改动了该文件的合并提交也出现在历史中（原预制模块会漏掉它们）。
- **显式 fetch**（`git/ops/network.rs`）：新增写操作 `fetch`，经写通道与 OperationRunner（仓库写锁、watcher 屏蔽窗口、结束后精确刷新、输出逐行推送与脱敏、取消终止进程树、不自动重试）。命令固定为 `fetch --progress --no-prune --no-recurse-submodules --no-auto-maintenance --no-write-commit-graph --end-of-options <remote>`，remote 必须是已配置的 remote。写通道新增“无输出超时”（初始 60 s，`ORIS_NETWORK_IDLE_TIMEOUT_MS` 只供测试缩短）。操作前后比较 `refs/remotes`、`refs/tags`，成功、失败、取消、超时都如实报告有多少引用在结束前已被更新，不承诺回滚。认证类错误（Authentication failed、Permission denied (publickey)、terminal prompts disabled、401 / 403 等）附可操作提示：Oris 只用本机已有凭据，不弹出输入，请先在终端完成一次认证。
- **日志页签**（`src/HistoryPanel.tsx`，底部 Git 区“日志”）：左栏分支列表（当前工作分支与正在浏览的分支分开表达；本地分支显示上游状态：`↑a ↓b` / 已同步 / 无上游 / 上游已消失 / 未知；远端跟踪分支；最近获取时间；“获取…”）；中栏按消息 / 作者 / SHA 搜索（字面量）、跳到 HEAD、提交图（`layoutGraph`，按真实 parents，分页边缘与筛选结果外的父提交画虚线“延续”）与虚拟提交列表（每页 200，滚到底部用游标续读）；右栏提交元信息（SHA、作者 / 提交者、父节点，合并提交可切换父节点，根提交相对空树）与变化文件。选择分支只筛选历史，不 checkout。
- **比较**：提交或分支右键“设为比较起点（A）”，再在另一处右键“与比较起点比较”：两端解析为 OID 后固定并显示，直接比较（非共同基线）；可交换方向（仍用固定 OID）；refs 变化后若端点引用已移动，提示“已移动到 …，当前比较仍使用固定的 OID”，并提供“按新位置重新比较”。
- **同一个 diff 阅读器**：日志中点开的文件在主阅读器显示，两端标注“父提交 xxxx（第 n 个父节点）/ 提交 xxxx”“A · 分支 @ OID / B · …”“空树（根提交）”，标签栏显示“历史 · 来源”；本地文件列表不再高亮。“← 返回本地变化”回到进入历史前的本地文件与差异位置（文件已不在当前范围时回到第一个可用文件并提示）。本地文件的标签栏有“文件历史”（从 HEAD 开始；暂存区中的 rename 用原路径）；提交详情的变化文件有“历史”。文件历史标注 rename 跟随边界、起点（新增提交）或“记录在此中断”。
- **获取入口与刷新**：标题栏“⇣ 获取…”与日志左栏“获取…”打开确认框：说明只更新远端跟踪分支等元数据、不修改工作区、不 pull / push / prune / 递归子模块；默认当前分支有效上游所属的 remote，没有有效上游时必须从已有 remote 中选择（不自行配置 remote / upstream）。运行中状态栏显示 `--progress` 的最新进度，可取消。成功后按工作区记录 Oris 的完成时间（`localStorage`）；`FETCH_HEAD` 在其后又被改写时显示“时间未知（外部工具获取过）”。普通刷新不联网。refs 类 watcher 事件（HEAD、`refs/`、`packed-refs`）与每次写操作结束都触发分支列表与日志重读。

## 验收逐项

后端测试：`src-tauri/src/git/history_tests.rs`（新增 4 项：`tree_entry`、历史两端读取覆盖根 / 两个父节点 / rename / 删除 / 图片且不读 index 冲突 stage、引用校验、合并进入文件历史）、`src-tauri/src/git/ops/network_tests.rs`（新增 7 项：fetch 只改远端跟踪引用且不 prune、不递归子模块、未知 remote 在启动进程前拒绝、无输出超时与取消都结束进程树、本地 401 服务模拟认证失败且凭据脱敏、认证提示匹配）。前端：`src/history-model.test.ts`、`src/App.history.test.tsx`（12 项）。界面验收：`scripts/perf/v1-04-acceptance.mjs`，历史 20 项 + 本地 bare remote 12 项 + 真实远端 3 项全部通过（`artifacts/gui-probe/v1-04-acceptance/report.json`、`report-real.json`）。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| A07 拓扑、分页、搜索、跳 HEAD | 通过 | 界面：429 个提交（根 + 420 个 fast-import 线性提交 + 分叉、冲突合并、rename、标签），第一页 200 行与同起点的 `git log --topo-order` 逐行一致；合并节点、HEAD / 本地分支 / 标签标注；分页边缘“更早的提交尚未加载”；滚动两次续读到 429 个，**每页恰好 1 个 `log` 进程**，前 20 行身份不变，结尾不再有延续；合并提交两个父节点的文件集合与 `git diff-tree` 一致；根提交相对空树（单侧新增视图）；消息搜索 `bob [brackets]` 按字面量命中 1 条（带 `v1.0` 标签），作者、8 位 SHA 各命中 1 条，`xyz` 明确报错；跳到 HEAD（HEAD 不在筛选结果时改为浏览 HEAD 所在分支）。后端：线性分页 ref 移动不改变身份、分叉合并父节点选择、搜索筛选、`layoutGraph` 既有测试 |
| A08 上游状态、分支筛选 | 通过 | 本地 bare remote：同步（已同步）、领先（`↑2 ↓0`）、分叉（`↑1 ↓1`）与 `rev-list --left-right --count` 一致；上游已删除显示“上游已消失”、无上游显示“无上游”，没有伪 0/0；分离 HEAD 显示“分离 HEAD @ …”。选择 `topic` 后只列出 topic 的历史，当前工作分支仍是 main，`branch --show-current` 与 HEAD 不变。后端浅克隆记为未知（既有测试） |
| A09 比较、ref 固定、文件历史、图片、根提交与父节点 | 通过 | 两分支直接比较的文件集合与 `git diff-tree -M topic main` 一致，A / B 端点 OID 固定显示，两端标注“A · topic @ … / B · main @ …”；交换方向后新增变为删除；外部在 topic 上提交后（watcher refs 事件）提示“topic 已移动到 …”，原比较仍用旧 OID，“按新位置重新比较”后端点更新。历史合并提交相对第 2 个父节点显示 `topic side → resolved`，当前 index 的冲突 stage（`conflict A`）不出现。历史图片走图片阅读器，两端尺寸 2×2 → 5×2。文件历史条数与同规则的 `git log --follow --diff-merges=first-parent` 一致，标注“由 shared.txt 改名而来”并到达起点；打开 rename 提交时左侧按原路径读取；“← 返回本地变化”回到进入历史前侧栏选中的本地文件 |
| A10 显式 fetch（本地 bare remote） | 通过 | 普通“本地刷新”后 `origin/main` 不变，trace2 中没有 fetch / 远端传输进程；fetch 默认上游 remote，`origin/main` 更新到远端新提交，用户配置了 `fetch.prune=true` 时已删除的远端分支仍保留（`--no-prune`），trace2 显示命令带 `--no-prune --no-recurse-submodules --no-auto-maintenance`，没有 pull / push / checkout / merge / gc；之后分支列表显示 `↑0 ↓1`，记录“上次由 Oris 获取 origin”；外部 `git fetch` 之后显示“时间未知”。无上游时确认框要求选择 remote，选择 `backup` 后只获取它，`branch.solo.remote` 仍未配置 |
| A10 失败 / 取消 / 超时 / 认证 | 通过 | 取消（慢速 upload-pack）：状态“已取消获取 origin。已重新读取实际引用：远端跟踪引用没有变化”，取消前进程树中有 `sh` / `sleep`，取消后都不在，12 s 后被终止脚本的标记文件也没有出现；无输出超时（测试实例设为 4 s）：“超过 4 秒没有任何输出，已终止…可能需要先在终端完成首次主机认证”；无效地址：“获取 backup失败：…”；本地 401 服务（清空凭据助手）：失败并给出认证提示，25 s 内结束，进程树中没有凭据助手进程，URL 中的 `alice:s3cret-token` 在状态栏与操作输出中都不出现。以上每次 index 条目、HEAD 与本地分支、config、工作区都不变 |
| A10 真实远端 AgentHub | 通过 | 见下文“真实远端” |
| fetch 失败 / 取消不承诺回滚 | 通过 | 结束说明统一为“已重新读取实际引用：结束前已有 N 个远端跟踪引用 / 标签被更新，Oris 不会回滚”或“没有变化”；确认框也写明 |
| B17 只读回归 | 通过 | 历史验收中全部浏览（日志、三页续读、键盘、合并父节点、根提交、图片、搜索、分支筛选、跳 HEAD、比较与交换、文件历史、打开约 14 个历史文件、返回本地）前后 `.git`（不含 objects / logs）与工作区逐文件 SHA-256 **完全不变**（0 处变化），HEAD 不变 |
| 键盘浏览与渐进加载 | 通过（计数类） | CDP 按键事件：提交列表 ↓ 到下一条、End 到最后（根提交）、Home 回到第一条（Enter 打开第一个变化文件、变化文件列表 ↑ / ↓ 已实现，未单独断言）。渐进加载每页 1 个 `log` 进程；打开约 14 个历史文件后常驻 Git 进程 ≤ 2（cat-file 常驻），前端内容缓存 ≤ 12 条。未计时 |

实现与验收中发现并修复的问题：

1. 连续滚动事件在状态更新前到达，同一游标被请求 2–3 次（trace2 中 3 页出现 6 个 `log` 进程）；改为同步的在途标记后每页恰好 1 个。
2. 获取确认框沿用之前读取的 refs：切换到无上游分支或新增 remote 后，默认目标与 remote 列表是旧的；改为打开时清空并重新读取，选择只在第一次读到时初始化。
3. 预制的 `file_history` 不输出合并提交的文件变化，合并时解决冲突造成的改动在文件历史中缺失；改为 `--diff-merges=first-parent`。
4. 分支栏在内容超出时各行因 flex 收缩而重叠；HEAD 标注依赖分支列表先读完；侧栏标题在历史阅读时误显示历史端点。

## 真实远端（AgentHub）

- 远端：`git@github.com:Zhao-wl/AgentHub.git` 与 `https://github.com/Zhao-wl/AgentHub.git`（V2-D34），账号 Zhao-wl。克隆放在 `%TEMP%\oris-remote\20260924-2031\v1-04`；HTTPS 克隆在自身 `.git/config` 写入 `credential.https://github.com.username=Zhao-wl`，命令行克隆时用 `-c` 传入，未改全局或系统配置，未读取或输出凭据。
- 本次运行创建的分支：`oris-test/20260924-2031/v1-04-fetch`（命令行经 SSH 从 `origin/main` 推送，不改动 main），验收结束后删除；SSH `ls-remote` 核对远端只剩开工时的 `HEAD` 与 `refs/heads/main`（`fc9be5c`）。
- 结果：Oris 内 **SSH fetch 成功**（约 14.5 s，获取到测试分支），**HTTPS fetch 成功**（约 2.6 s），两次都只改变远端跟踪引用与 `FETCH_HEAD`（index 条目不变）。**没有出现认证弹窗**；这一轮是从没有 `GCM_INTERACTIVE` 变量的环境启动的测试实例，GCM 用已保存的 Zhao-wl 凭据静默完成认证。
- 未覆盖：凭据缺失时 GCM 的交互弹窗、SSH 首次连接的主机指纹确认（只用无输出超时的本地模拟覆盖“卡住”的情形）。

## 写操作的 Git 进程数（本地 bare remote，`GIT_TRACE2_EVENT`，含动作后 1.5 s 内的后台补齐）

| 操作 | 进程数 | 构成 |
| --- | ---: | --- |
| fetch（有更新） | 14 + 传输内部 4 | `remote` 1（校验 remote）+ `for-each-ref` 2（前后对比）+ `fetch` 1 + 结束刷新 `status` 1 + 统计 4（`diff-files`、`diff-index` ×3）+ 前端重读分支 5（`for-each-ref`、`rev-parse` ×2、`symbolic-ref`、`remote`）；本地传输时 Git 自己另起 `upload-pack` 侧的 `pack-objects`、`rev-list`、`unpack-objects` 等 |
| 日志第一页 | 3 | `for-each-ref`（默认起点）+ `rev-parse HEAD` + `log` |
| 日志续读一页 | 1 | `log` |
| 选中提交 | 3 | `rev-parse`（解析）+ `show -s --format=%P` + `diff-tree`（指定父节点时另加 1 个 `rev-parse`） |
| 打开历史文件 | 2 | `ls-tree` ×2；对象经常驻 `cat-file` 读取，命中 BlobCache 时不启动进程 |

## 与参考图和技术方案的差异

| 参考图 / 方案 | 实现 | 原因 |
| --- | --- | --- |
| 参考图“Git 日志”页只示意两行提交 | 分支 / 提交图与列表 / 详情三栏，页高 300 px | 规格 R-HISTORY、R-BRANCH 要求的内容放不进示意高度 |
| 参考图标题栏为“同步 ▾”（获取 / 拉取 / 推送） | 本任务只有“⇣ 获取…”（标题栏与日志左栏） | 拉取、推送属 V2-04；V2-04 时把获取移入“同步”入口 |
| 参考图未画比较与文件历史入口 | 比较：提交 / 分支右键设端点；文件历史：标签栏“文件历史”与变化文件“历史” | 规格未规定入口位置；选择不新增常驻按钮的方式 |
| 接入清单“按仓库 generation 取消过期请求” | 历史类请求按种类（日志、提交、比较、文件历史、refs、内容）各自计代，不影响本地变化的读取代次 | 同时打开日志与阅读本地文件时互不取消 |
| 预制 `file_history` 不含合并提交 | 加 `--diff-merges=first-parent` | 见“修复的问题”第 3 条 |
| 技术方案 §4 网络操作只写 `--progress` | fetch 另带 `--no-auto-maintenance --no-write-commit-graph` | 任务票据“禁额外维护”；用户配置的 `fetch.writeCommitGraph` 也不触发 |
| 历史内容的前端缓存 | 只进 DiffCache（按 contentId），不进本地范围的 ContentCache | ContentCache 以本地 revision 为键 |

## 待用户决定（已确认）

> 2026-09-25：以下各项已由用户按推荐确认，见 [V2 决策登记](../decisions/v2-decisions.md) V2-D38–V2-D49。其中 fetch 只对外部 `index.lock` 放开（rebase 等进行中仍禁用）；“合并远端改动”已改为不强制 `--no-ff`（V2-D47）。

1. 外部 `index.lock` 存在或仓库处于 rebase / cherry-pick / revert / bisect 进行中时，fetch 与其他写操作一样被禁用（沿用 V2-02 的前置检查）。fetch 不需要 index，放开会更方便，但更保守的做法是保持一致；目前保持禁用。
2. “跳到 HEAD”在 HEAD 不在当前筛选 / 搜索结果中时，把浏览分支改为 HEAD 所在分支（HEAD 位于第一行），而不是在“全部分支”中逐页查找。
3. 文件历史中的合并提交只与第一个父节点比较（与提交详情的默认一致）；需要看相对其他父节点的改动时从提交详情切换父节点。
4. Oris 的获取完成时间保存在前端 `localStorage`（按工作区路径），重启后仍显示；不写入仓库。

## 未验证与已知限制

- macOS 全部未运行（A08 / A10 的“双平台”部分、WKWebView、osxkeychain、进程组取消）。
- 真实焦点：所有界面证据为 CDP 页面事件（点击、按键、滚动），不是真实鼠标、键盘或 Windows 前后台焦点；键盘浏览只证明页面内的按键处理。
- 性能：日志首屏、续读、比较、历史文件打开的时延与内存都没有测量（用户机器上有其他高负载任务，按用户安排另行测量）；“大量提交渐进加载”只做了计数类断言。
- 真实远端只验证了已保存凭据下的静默认证；凭据缺失时的 GCM 交互、SSH 主机指纹首次确认没有运行。
- 测试实例在远端验收的一次早期运行中需要强制结束本实例的已核验进程树（温和关闭 10 s 未退出）；最终两轮都正常关闭，原因未定位。

## 复现

```powershell
& D:\Projects\Research\Oris-v1-04\scripts\build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\v1-04
$env:PATH = "D:\Tools\Rust\mingw-binutils\mingw64\bin;" + $env:PATH + ";D:\Tools\Rust\msys2\msys64\mingw64\bin"
$env:CARGO_TARGET_DIR = "D:\Projects\Research\Oris-builds\v2-02\target-test"
cargo test --no-default-features --lib   # 在 src-tauri 目录
npx tsc -b; npx vitest run --maxWorkers=1 --no-file-parallelism
node scripts/perf/v1-04-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v1-04\target\release\oris.exe
node scripts/perf/v1-04-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v1-04\target\release\oris.exe --only real --run-id <运行编号>
```

GUI 安全（AGENTS.md）：开工前复查了 `scripts/focus-task02-window.ps1`（直接抛错、不调用任何窗口 API）及 `scripts/task02-feedback-*.mjs`（无 `ShowWindow`、`SetForegroundWindow`、`AppActivate` 调用），本轮未修改它们。验收脚本只经 `launchOris` 启动并核验自己的实例（PID、完整 exe 路径、主窗口句柄、CDP 端口归属），使用独立的 `WEBVIEW2_USER_DATA_FOLDER` 与 `ORIS_APP_CACHE_DIR`；不调用任何窗口激活 API，不操作其他应用窗口；结束时用 `killOris` 关闭（温和关闭超时时只结束本实例已核验的进程树）。测试仓库在 `%TEMP%\oris-gui`、真实远端克隆在 `%TEMP%\oris-remote` 下创建并在结束后删除。
