# 分支删除与清理：补登记与验收（V2-D74 / B30）

日期：2026-09-29。长链 lc4 阶段 1（[任务](../tasks/onetime/long-chain-prune-wrapalign-b12.md)），分支 `docs/branch-prune`（自 main `d005630`）。只验证 Windows。

结论：**验收通过，发现并修复 1 个缺陷**。`a19ef69`（PR #12）先行合入的本地分支右键删除与“清理…”按现有实现登记为 V2-D74，新增验收项 B30。本地界面验收 15/15 通过，回归 v1-04、v2-03、v2-04 local、history-feedback、v2-06 全部通过。缺陷：在历史页筛选某个分支后删除该分支，提交列表停在“无法解析引用”不恢复，已修复（`f46af76`）。

## 实现版本

| 项 | 值 |
| --- | --- |
| 源码 | `docs/branch-prune`：`4d0da42`（文档、测试、脚本）、`f46af76`（缺陷修复） |
| 验收构建 | `D:\Projects\Research\Oris-builds\lc4\stage1b\target\release\oris.exe`（源码 `f46af76`），SHA-256 `CF4B5FF7F04E8BAE7DEEF4FCFD4A4C40C8DAD3B7887AE35B0B254DB2287EEC8A`，`verify_release_entry` 通过 |
| 修复前构建 | `Oris-builds\lc4\stage1`（源码 `d005630`，即 v0.4.0 之后的 main），SHA-256 `6990B5A836ABA17225D5DAEE30817D692BEF4F968FE21E4D2B7C7DFCB9218319` |
| 平台与工具 | Windows 11 专业版 10.0.22631；Git 2.44.0.windows.1；WebView2 Runtime 153.0.4234.48；Node v22.18.0；Rust 1.97.1（stable-x86_64-pc-windows-gnu） |

## 盘点（以源码为准）

- **入口**：历史页左侧“本地分支”分组标题右侧“清理…”，只有存在“非当前、有上游”的本地分支时显示；写操作被阻塞时禁用并显示原因。本地分支行右键“删除分支…”：当前分支禁用（提示“不能删除当前分支，请先切换到其他分支”）。
- **清理流程**（`App.tsx` `pruneGoneBranches`）：取所有有上游的本地分支的 remote（去重），逐个执行 `OperationRequest::Fetch { remote, prune: true }`（经 OperationRunner，写锁与前置检查同普通获取）→ 重新读取引用 → 列出上游已消失的非当前本地分支 → 确认 → 逐个 `branch -d`，未合并的汇总后强确认 `-D`（说明只能从 reflog 找回），拒绝时保留并汇总。没有可清理的分支时不弹框，只说明“没有需要清理的本地分支（上游都还存在）”。
- **获取失败 / 取消**：不中止。确认框的警告为“获取 X 失败，以下结果基于本地已知的远端状态”，仍须确认才删除。这与任务草稿“获取失败时不删除任何分支”不同；用户已按现有实现确认 V2-D74，未改实现，B30 按实际行为编写。
- **参数**：`fetch --progress --prune --no-prune-tags --no-recurse-submodules --no-auto-maintenance --no-write-commit-graph --end-of-options <remote>`。`--no-prune-tags` 覆盖用户的 `remote.*.pruneTags`；普通获取为 `--no-prune`（覆盖 `fetch.prune` / `remote.*.prune`）。prune 作用于整个 remote（包括本地没有跟踪的 stale 跟踪引用），没有被本地分支跟踪的 remote 不获取。
- **分离 HEAD**：没有“当前分支”，上游已消失的本地分支都会列出。

## 文档

| 文件 | 变化 |
| --- | --- |
| `docs/decisions/v2-decisions.md` | V2-D69–V2-D73 改为“用户已确认（2026-09-29，按现有实现）”；新增 V2-D74；“待用户决定”清空 |
| `docs/specs/v1-product.md` R-REMOTE、`docs/architecture/v1-architecture.md` fetch 条目 | 注明“清理…”是“不自动 prune / 禁 prune”的唯一例外，引用 V2-D74；原约束对其他路径不变 |
| `docs/specs/v2-product.md` R-BRANCH | 补右键删除与清理 |
| `docs/validation/v2-acceptance.md` | 新增 B30 |

## 验收结果（B30）

界面验收：`node scripts/perf/branch-prune-acceptance.mjs --exe <验收构建> --only local`（报告 `artifacts/gui-probe/lc4-branch-prune/report-local.json`，本地不入库）。夹具：origin（bare）上的 gone-a / gone-b（已合并）、gone-c（未合并）、alive、stale-x（本地不跟踪）与标签 v1；第二个 remote mirror（mgone、mkeep，本地没有分支跟踪它）；本地另有 solo（无上游、已合并）、side（无上游、未合并）；用户配置 `fetch.prune=true`、`remote.origin.pruneTags=true`。之后在远端删除 gone-a / gone-b / gone-c / stale-x、标签 v1 与 mirror/mgone。每个写操作前后记录仓库指纹（.git 不含 objects / logs、工作区逐文件 SHA-256）、全部引用（for-each-ref）、stash 列表与 `status`；Git 命令用 `GIT_TRACE2_EVENT` 记录。

| 检查 | 结果 |
| --- | --- |
| 入口显示“清理…”，提示会 fetch --prune；打开历史页不改仓库 | 通过 |
| 普通获取：`--no-prune`（配置 `fetch.prune=true` 也不 prune），不删除任何远端跟踪引用与标签 | 通过 |
| 清理只获取 origin，参数 `--prune --no-prune-tags`；mirror 不获取 | 通过 |
| prune 只删除 origin 的 4 个 stale 跟踪引用（含 stale-x）；远端已删除的标签 v1 与 mirror/mgone 保留 | 通过 |
| 确认框只列 gone-a、gone-b、gone-c（不含 main、alive、solo、side），说明未合并会再次确认、远端不受影响 | 通过 |
| 取消确认：不删除任何本地分支；工作区、index、stash 不变 | 通过 |
| 未合并分支汇总后强确认（列出 gone-c，说明 reflog） | 通过 |
| 已合并的直接删除；拒绝强确认时保留 gone-c，汇总“已删除 2 个分支：gone-a、gone-b；未删除：gone-c（未合并，已保留）”；只删除这两个分支及其上游配置 | 通过 |
| 强确认后删除 gone-c，提交对象仍在 | 通过 |
| 没有可清理的分支：不弹框，说明“没有需要清理的本地分支”，不删除任何引用 | 通过 |
| 获取失败（origin 指向不存在的 `file:///` 地址）：确认框说明“获取 origin 失败，以下结果基于本地已知的远端状态”，取消后不删除 | 通过 |
| 右键删除：当前分支不可用并说明 | 通过 |
| 右键删除已合并的 solo（当时正作为历史筛选）：一次确认后只删除 `refs/heads/solo`；侧栏不再列出；历史列表回到全部分支 | 通过（修复后；修复前失败，见下） |
| 右键删除未合并的 side：强确认前仓库不变，确认后只删除 `refs/heads/side` | 通过 |
| 删除后“跳到 HEAD”定位到 HEAD（V2-D39） | 通过 |

B16、B17：每个写操作的证据中，文件变化只在预期类别（`refs/heads`、`config` 的分支段、`refs/remotes`、`packed-refs`、`FETCH_HEAD`），引用只减少预期的项，没有新增或移动；工作区、index、stash 全程不变。

说明：
- 点击是 CDP 注入的页面事件，不是真实鼠标、键盘或 Windows 焦点。测试实例都经 `launchOris` 核验（PID、完整路径、主窗口句柄、CDP 端口归属），没有调用窗口激活 API；`scripts/focus-task02-window.ps1` 已停用（调用时直接报错），`task02-feedback-*.mjs` 不再调用它。
- 认证失败不弹凭据输入由 v1-04 A10 / B18 与 v2-04 B12 / B18 覆盖（本轮回归通过），清理走同一个 fetch 路径。
- 前两轮运行中的失败项有 4 项来自脚本时序（获取结束时状态栏先显示“已获取…”；上一步留下的旧文字被误认为新结果），已改为用 MutationObserver 只认点击之后出现的文字。另一项是夹具问题：origin 地址写成不存在的带盘符路径时，Git 可能把它当成 ssh 的“主机:路径”去连接而一直卡在“获取中”，改用 `file:///` 地址后立即失败。这是 Git 解析地址的行为，与 Oris 无关。

## 发现并修复的缺陷

**正在浏览的分支被删除后，历史列表停在错误状态**（修复前构建上复现）：在历史页左侧单击 solo 作为筛选，再右键删除 solo，中间栏一直显示“浏览 solo · 0 个提交 / Git 命令失败：无法解析引用：refs/heads/solo”（等 15 s 不恢复）；侧栏已没有 solo，用户只能点“全部分支”手动恢复。“清理…”删除正在筛选的分支、外部终端删除分支，都会出现同样的情况。

修复（`f46af76`，`src/HistoryPanel.tsx`）：每次读到新的分支列表时，若当前筛选的分支 / 标签已不存在（`HEAD` 除外），回到全部分支，并在“跳到 HEAD”旁提示“X 已不存在，已改为浏览全部分支”（沿用 V2-D39 的提示，用户自己改筛选时消失）。新增单元测试；撤掉修复时该测试失败。修复后界面验收中列表立即恢复（约 1 ms 内已有提交行）。

## 测试

| 项 | 基线（main `d005630`） | 本阶段 |
| --- | --- | --- |
| 前端 vitest | 38 个文件 279 通过 | 38 个文件 282 通过（+3：清理列表范围与取消、获取失败说明与拒绝未合并、删除正在浏览的分支） |
| 后端 `cargo test --no-default-features --lib` | 170 通过 / 5 忽略（其中 `b12_pull_times_out…` 首轮与单独重跑各失败 1 次，见下） | 171 通过 / 5 忽略（+1：prune 只影响所选 remote、不 prune 远端已删除的标签）；（desktop 特性）无警告 |
| `npx tsc -b` | 通过 | 通过 |

后端基线中的 `sync_tests::b12_pull_times_out_without_output_and_push_can_be_cancelled_ending_the_process_tree` 在机器负载高时失败 2 次（一次是“5 s 内结束”的计时断言，一次是取消前读取 bare 仓库 `refs/heads/main` 偶发失败），随后单独连跑 3 次全部通过。该用例与相关代码在 RC 之后没有改动，记为“负载下偶发失败”，与本阶段无关。

## 界面回归（验收构建）

| 套件 | 结果 |
| --- | --- |
| `branch-prune-acceptance --only local` | 15/15 通过 |
| `v1-04-acceptance`（历史 + 本地远端） | 通过（32 项） |
| `v2-03-acceptance` | 通过（24 项） |
| `v2-04-acceptance --only local` | 通过（22 项） |
| `history-feedback-acceptance` | 通过（12 项） |
| `v2-06-acceptance --skip-timing` | 通过（13 项，含新增的概览栏检查；§3 时延只记录、未作结论） |

概览栏（`7adb1f4`）：v2-06 在 21 套配色（深色与浅色）上逐套读取计算样式与命中测试，色块 `opacity` 0.55、视口框 `z-index` 3 高于色块的 2，在色块与视口框重叠处 `elementFromPoint` 命中视口框，全部一致。

## 未验证项

- 性能：未测（本轮不做性能测试）。修复只在分支列表更新时多做一次数组查找，不启动 Git 进程。
- macOS：未验证。
- 真实远端（AgentHub）上的清理：留到阶段 3（`branch-prune-acceptance --only real`）。
- 真实鼠标、键盘与 Windows 焦点：未验证（CDP 页面事件）。

## 待用户决定

无。V2-D74 已按现有实现确认；获取失败时仍提供删除确认的行为已写入 V2-D74 与 B30。
