# V2-01 数据层与流畅度基础：实现与验收结果

日期：2026-09-23 至 09-24。任务：[V2-01](../tasks/v2/01-data-layer-performance.md)。依据：[V2 技术方案](../architecture/v2-architecture.md) §1–§5、§7，[V2 验收计划](v2-acceptance.md) B01–B04、B17、B18 与 §3–§4，[Git 命令层探测](v2-01-git-level-probe.md)，[V1 基线](v2-baseline-v1.md)。

结论：**Blocked**。§3 中可测的时延场景全部达标、功能与安全验收通过，但 §4 的两项内存指标未达标（5 项目稳态进程树 431.7 MiB > 400 MiB；200 次混合切换工作集增长 12.0% > 10%），“外部变化到界面更新”需要真实前台焦点而未测，macOS 未运行。预算没有调整；是否调整内存预算或继续压缩常驻资源需要用户决定（见文末）。

## 版本

| 项目 | 值 |
| --- | --- |
| 分支 / 实现提交 | `feat/v2-01`：`2424bd8`（接入）、`7656303`（watcher 不用文件 ID 缓存）、`9f52588`（常驻 cat-file 不分配控制台） |
| 测量用 release | `D:\Projects\Research\Oris-builds\v2-01\target\release\oris.exe`，源码 `9f52588`，SHA-256 `F703A0F21CFA4485A8934212197987ECC819D87770DAECD7A03503D0A31DB08C`；`WebView2Loader.dll` `8427B1FC58EC707813E5C0A51EB5D69397BB333250A7B891BE4D3B123F1E0F1C`；`verify_release_entry` 通过 |
| 平台 | 与 V1 基线同一台机器：Windows 11 Pro 10.0.22631、i7-11700、47.7 GiB、NVMe；WebView2 153.0.4234.48；Git 2.44.0.windows.1 |
| 新增依赖 | `notify-debouncer-full 0.6`、`ignore 0.4`（任务允许）；`serde_json` 从构建 / 开发依赖加到普通依赖，用于二进制内容帧的 JSON 头（它已通过 tauri 在依赖树中，未引入新 crate） |

## 实现摘要（M1–M5）

- **M1 StatusScanner**（`src-tauri/src/git/scan.rs`）：一次 `status --porcelain=v2 -z --branch --untracked-files=all --find-renames`（只读通道）映射出三个范围，映射规则与 V1 逐命令结果对齐；revision = status 原始输出 + HEAD / refs 内容 + 列表中各路径的工作区 stat（三个范围共享）。增删统计与“全部”范围修正（工作区 rename 配对、index 与工作区都改过但工作区回到 HEAD 的条目剔除）在后台按 revision 计算一次，前端未到时显示占位“…”而不是 0。branch、upstream、ahead/behind 取自 status 头信息，inProgress（merge / rebase / cherry-pick / revert / bisect）进入快照。
- **M2 ContentReader**（`git/content.rs`、`git/object_reader.rs`）：HEAD / index / 冲突 stage 两侧按扫描时记录的 OID 经常驻 `cat-file --batch` 读取（全局最多 5 个、空闲 60 s 回收、异常退出时重启一次、超过 20 MiB 的对象只报告大小），BlobCache 全局 32 MiB、单对象 > 4 MiB 不缓存；工作区直接读文件；contentId 为内容哈希。去掉全局 `READ_SERIAL`，改为每仓库读取并发 ≤ 2 与每仓库 generation 取消。内容以二进制帧传输（`ORC1` + JSON 头 + 文本 / 图片原始字节）。
- **M3 前端**：`src/store.ts`（基于 `useSyncExternalStore` 的小型 store）与 `src/project-store.ts`（按项目拆分运行状态，App 只订阅当前项目切片）；切换范围在前端过滤；DiffCache 按 `(leftContentId, rightContentId, 阅读选项)` 建键、不随 revision 清空；DiffViewer 在切换文件时复用 EditorView（`setState` 替换文档与装饰，兼容双 EditorView），并按文件记住阅读位置（最近 32 个）；空闲 150 ms 后预取上下相邻文件（后端检查两侧 ≤ 256 KiB 且为文本）；键盘连续切换时内容请求延迟 80 ms；文件超过 500 项时虚拟列表（平铺与树状）。
- **M4 Watcher**（`src-tauri/src/watch.rs`）：`notify-debouncer-full` 200 ms 合并；分层 gitignore（根、子目录、`info/exclude`、全局）过滤，已跟踪但被忽略的文件仍有效；`.git` 事件分类为 index / refs / stash / inProgress，objects / logs / hooks / `*.lock` 丢弃；后台项目只标记 dirty，切回时才刷新；watcher 最多 5 个（LRU），被淘汰的项目切回时重建并完整刷新。
- **M5 快照恢复与 stat 缓存**（`src-tauri/src/snapshot_store.rs`、前端 `loadProject`）：轻量快照（三个范围的文件列表与统计、分支、inProgress；不含内容）版本化保存到应用缓存目录，每个 ≤ 2 MiB、最多 20 个；启动时先显示快照并标“校验中”，校验完成后替换（按 key 协调，阅读位置保留）。`ProjectStore.canWrite(repoId)` 在校验完成前返回 false，供 V2-02 使用。手动刷新执行一次允许回写 index stat 的 status，并在 2.5 s 内跳过由此产生的 `.git/index` 事件；其余路径保持 `--no-optional-locks`。

## 验收逐项

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| B01 三范围与 V1 逐项一致 | 通过 | `git/v2_tests.rs`：`b01_mixed_changes_special_paths_renames_and_conflicts_match_v1`（修改、暂存、双层、删除、暂存 rename、中文 / 空格 / `#` / `[x]` 路径、真实 merge 冲突）、`b01_worktree_only_renames_empty_head_and_cancelled_layers_match_v1`（仅工作区 rename 两种形态、暂存 rename 后工作区删除、双层修改抵消、空 HEAD）、`b01_non_utf8_index_path_and_external_operations_match_v1`（非 UTF-8 index 路径、关闭期间的修改 / 暂存 / 提交 / 切换分支）、`b01_revision_covers_repeated_worktree_edits_and_is_shared_by_scopes`。对照方为保留在测试中的 V1 实现 `snapshot_for_scope_v1`，文件集合、状态、rename 原路径与增删统计逐项相等 |
| B02 按 OID 读取与 V1 逐字节一致；缓存命中；cat-file 恢复 | 通过 | `b02_oid_reads_match_v1_bytes_for_every_file_and_scope`（文本 CRLF、图片、二进制、截断图片、rename 原路径、冲突 stage 与工作区多种组合，与 V1 读取路径 `read_content_pair_v1` 比较文本、字节数、编码、EOL、contentId、OID、降级原因、图片字节）；`b02_cache_survives_git_operations_and_cat_file_recovers_once`（外部 `git add` 改变 revision 后，未变化文件的对象命中 BlobCache 且不启动 cat-file；杀掉常驻进程后自动恢复）；`b02_binary_frame_carries_text_and_image_bytes_verbatim`；读取无效 Git 路径时报错见 `object_reader` 既有用例 |
| B03 重启先显示快照、校验后替换、校验前禁写 | 通过（Windows） | 前端 `App.initialization.test.tsx`“shows the persisted snapshot as verifying on restart…”、`project-store.test.ts`（`canWrite`、版本与路径绑定）；后端 `snapshot_store` 大小 / 数量 / 版本用例；GUI 重启场景（下表）；关闭期间外部操作后的校验结果见 B01 |
| B04 忽略目录大量写入不刷新；分类刷新；后台只标 dirty | 通过（Windows） | `watch.rs`：`ignored_storm_is_silent_and_real_changes_are_batched`（`node_modules` 10,000 次写入 0 次通知；200 次真实写入合并为 ≤ 10 次通知）、`gitignore_layers_negation_and_git_dir_classes`、`tracked_files_under_ignore_rules_still_count`、`lru_keeps_at_most_five_watchers`；前端“background changes only mark a project dirty…”；GUI 后台 dirty 切回 30/30 |
| B17 只读回归 | 通过 | `b17_readonly_paths_never_write_index_and_manual_refresh_is_the_only_writeback`：300 个文件 stat 过期时，扫描、统计、全部文件读取与预取检查前后仓库（含 `.git/index`）逐字节不变；手动刷新时只有 `.git/index` 变化且 revision 不变。GUI 5 个 S 仓库与任务 03 夹具读取前后 `.git`（不含 objects / logs）不变 |
| B18 安全回归（只读通道） | 通过 | `b18_malicious_config_is_not_executed_on_v2_paths`（`diff.external`、`core.fsmonitor`、textconv、diff command 均为标记脚本，扫描 / 统计 / 读取 / 手动刷新后标记不存在；`../`、`--output=`、`-c` 形式的 pathId 被拒绝）；V1 `ignores_external_diff_and_fsmonitor` 在 V2 路径上继续通过 |
| 资源上限 | 通过 | `resource_limits_cat_file_pool_idle_reaping_and_blob_cache_budget`（7 个读取器同时存活 ≤ 5、空闲回收为 0、超限对象只报告大小且流保持同步、BlobCache 40 MiB 写入后为 32 MiB、> 4 MiB 不缓存）；`resident_cat_file_has_no_console_host`；`slot_tests`（每仓库并发 ≤ 2）；`snapshot_store`（2 MiB / 20 个）；前端 `DiffCache` 12 项上限 |
| V1 A01–A05、A11–A13 回归 | 通过（Windows，已实施范围） | V1 既有后端用例全部运行在 V2 读取与扫描实现上并通过（`reads_real_index_and_worktree_without_writes`、`reads_staged_unstaged_and_all_as_distinct_endpoint_pairs`、`reports_rename_delete_untracked_special_paths_and_conflicts`、`supports_unborn_head…`、`cached_content_rejects_index_and_packed_head_changes`、`rejects_a_result_after_the_worktree_revision_changes`、冲突 / 图片 / JSON / 任务 03 安全与取消用例）；前端 App 集成测试 27 个用例（含 3 个 V2 新增）；GUI 任务 03 套件 17/17 |

测试数量：后端 58 通过、5 忽略（基线 41 / 5）；前端 98（基线 82 + 配色 5 = 87，vitest 默认运行包含配色测试）；`npm run build` 通过；`cargo check`（desktop 特性）无告警。

## 性能对比（V2 §3–§4，同一机器、同一脚本、同一数据集、同一时间段）

V1：`artifacts/gui-probe/v1-baseline/`（第二次运行，方法见[基线报告](v2-baseline-v1.md)）；V2-01：`artifacts/gui-probe/v2-01/`（最终构建 `9f52588`）。单位 ms，`n=30`，P50 / P95。

| 场景 | V1 基线 | V2-01 | V2 S 目标 | 结论 |
| --- | ---: | ---: | --- | --- |
| 首次打开（添加项目 → 列表可交互） | 1115.6 / 1186.4 | 295.4 / 307.4 | P95 ≤ 1500 | 达标 |
| 再次打开：窗口就绪 → 显示上次快照 | 788.8 / 948.4（无快照，完整打开） | 91.9 / 98.2 | P95 ≤ 300 | 达标 |
| 再次打开：快照校验完成 | 788.8 / 948.4 | 363.5 / 375.2 | 同首次打开（≤ 1500） | 达标 |
| 热项目切换 | 27.5 / 30.8 | 22.8 / 27.0 | P95 ≤ 100 | 达标 |
| 后台 dirty 项目切回 | 980.9 / 1218.7 | 188.6 / 196.5 | P95 ≤ 800 | 达标 |
| 切换显示区域（时延） | 30.9 / 34.9 | 20.1 / 25.4 | P95 ≤ 50 | 达标 |
| 切换显示区域（启动的 Git 进程） | 每次 6–26 个 | 0（6/6） | 0 | 达标，见下方说明 |
| 已缓存文件切换 | 19.6 / 24.0 | 15.3 / 21.0 | P95 ≤ 100 | 达标 |
| 相邻文件切换（预取） | 439.6 / 452.8（V1 无预取） | 16.8 / 21.1 | P95 ≤ 100 | 达标 |
| 未缓存常用文件 | 438.4 / 485.7 | 22.3 / 27.9 | P95 ≤ 400 | 达标 |
| 外部变化 → 界面更新 | 未测到 | 未测到 | P95 ≤ 1000 | **未测**：测试窗口无原生焦点，V1 / V2 都只在前台时自动刷新 |
| 首次打开其他 4 个项目（参考） | 1232.2 / 1262.4 | 318.7 / 471.9 | — | — |

| §4 指标 | V1 基线 | V2-01 | 目标 | 结论 |
| --- | --- | --- | --- | --- |
| 5 项目稳态（工作集 / 私有，中位数） | 462.1 / 358.0 MiB | 431.7 / 331.1 MiB | ≤ 400 MiB | **未达标**（WebView2 进程组约 403 MiB，oris.exe 约 28 MiB） |
| 200 次混合切换增长（第 20 次 → 第 200 次，工作集） | 456.4 → 459.4（+0.7 %） | 472.7 → 529.2（+12.0 %），峰值 529.2 | ≤ 10 %，无单调上升 | **未达标** |
| 同上（私有字节） | 362.6 → 348.4（−3.9 %） | 393.6 → 552.7（+40.4 %） | — | 增长主要来自 5 个常驻 cat-file（每个私有约 34 MiB） |
| 常驻 Git 子进程（静置 65 s 后） | 0 | 0（混合切换中最多 5 个，空闲后回收） | 空闲 ≤ 5，关闭项目后 60 s 内回收 | 达标 |
| 缓存上限 | — | 测试断言（见上） | §7 | 达标 |
| 10 项目相对 5 项目的增量 | 未测 | 未测 | 主要来自轻量状态 | **未测** |

200 次混合切换的操作时延：V1 P50 543.1 / P95 1357.6 ms，V2 P50 26.7 / P95 37.4 ms（同样 200 次操作，逐次时延合计 V2 约 5.3 s、V1 约 114 s，不含两次操作之间的固定等待）。

内存构成（V2 第 200 次采样）：WebView2 461.5 MiB 工作集（第 20 次为 434.4），oris.exe 30.9，5 个 `git cat-file` 36.6（私有 169.5）。常驻 cat-file 的私有字节与 `core.deltaBaseCacheLimit` / `packedGitLimit` 无关（`artifacts/long-chain/catfile-mem.mjs` 实测均为 34.1 MiB，工作集约 8.5 MiB），推测为包文件映射计入私有提交。强制 GC 后页面 JS 堆只有 4–6 MiB，DOM 节点与事件监听器在 200 次文件切换中不增长（`artifacts/long-chain/debug-leak.mjs`），没有发现页面内泄漏。

### 测量过程中的修正（均保留原始数据）

1. **第一次 V2 构建（`2424bd8`）首次打开 P95 约 2.2 s**（冒烟）：`notify-debouncer-full` 在 Windows 上默认用 `FileIdMap`，`watch()` 时遍历整棵目录树（含 1 万个 node_modules 文件）。改为 `NoCache` 并把“已跟踪但被忽略的文件”清单移到后台后降到约 300 ms（`7656303`）。
2. **第二次构建（`7656303`，`artifacts/gui-probe/v2-01-run1/`）**：时延与最终一致，但 200 次混合工作集增长 +19.8 %，原因是每个常驻 cat-file 附带一个约 11 MiB 的隐藏 `conhost.exe`（`CREATE_NO_WINDOW` 仍创建控制台宿主）。常驻 cat-file 改用 `DETACHED_PROCESS`（`9f52588`）后为 +12.0 %。通用 Git 调用保留 `CREATE_NO_WINDOW`：`DETACHED_PROCESS` 下 PowerShell 这类控制台程序会自行创建新控制台（`production_command_factory_creates_no_console_window` 用例失败即为此），不适用于可能启动其他程序的调用。
3. **切换显示区域的 Git 进程数**：第二次构建的第一次 trace（`v2-01-run1/trace.json`）中 6 次切换都记录到 3–4 个后台“详情”进程（统计与 rename 修正被重复计算，不阻塞界面，切换时延 26–44 ms）；随后同一构建的两次重跑（`v2-01-trace2`、`v2-01-trace3`，已加入按动作记录前端 IPC）与最终构建的 trace 都是 0 个，IPC 记录显示切换范围只发出 `read_content_pair` 与 `save_snapshot`。第一次的原因未能复现、未定位，列为需要复核的项目。

## 与技术方案不一致之处

| 技术方案 | 实现 | 原因 |
| --- | --- | --- |
| §5.1“全部”范围只在显示时懒执行 `diff HEAD --name-status -M` | 改为 `diff-index -M --name-status HEAD` 等 plumbing 命令，与统计一起在后台按 revision 计算一次 | **F1**：porcelain `git diff` 即使带 `--no-optional-locks` 也会在 stat 过期时回写 index（见[基线报告](v2-baseline-v1.md#发现)）；后台计算使切换范围不启动 Git 进程 |
| §5.1 统计用 `diff --numstat` 两次 | `diff-files` / `diff-index --cached` / `diff-index`（`--no-renames`，与 V1 统计口径一致） | 同上，plumbing 不回写 index |
| §5.1 revision = status 原始输出 + HEAD/refs | 另加列表中各路径的工作区 stat | 已修改文件再次被改写时 status 输出不变，否则缓存会给出旧内容 |
| §5.2 内容读取只按 OID | 保留零进程快速守卫（`.git/index` stat、HEAD / refs 文件、选中路径工作区 stat），只有 index / HEAD 变化时补一次单路径 `ls-files` / `ls-tree` 精确核对 | 保持 V1 A03“旧结果不落屏”语义与既有用例 |
| §5.3 DiffCache 存 DiffDocument 与解码文本 | DiffCache 只存 DiffDocument（按 contentId）；解码文本在按 revision 建键的 ContentCache 中，两者各自 16 MiB / 12 项 | 避免同一文本两份拷贝；revision 变化后文本经 BlobCache 与文件读取快速重建 |
| §5.4 工作区事件少于阈值时带 pathspec 做局部 status | 未实现，统一完整 status | S 数据集完整 status 约 170–250 ms，dirty 切回已满足预算；L 数据集未做 GUI 验证 |
| §5.4 前端刷新时机 | 保持 V1：活动项目只有在原生窗口获得焦点且可见时才自动刷新 | 产品规格未要求非前台刷新，不擅自改变 V1 行为；因此“外部变化”场景需要真实前台焦点 |
| §5.7 连续切换延迟 80 ms | 只用于键盘连续切换 | 与方案原文“键盘连续切换文件时”一致；点击是明确选择，不延迟 |
| §5.2 大内容二进制 IPC | 所有内容读取都走二进制帧 | 实现更简单，小内容也避免转义 |
| §5.5 快照写入 | 由前端在统计补齐后提交轻量 JSON，后端按路径哈希写入（`ORIS_APP_CACHE_DIR` 环境变量只用于隔离测试实例） | 前端已持有合并后的统计与阅读锚点 |

## 已知限制与未验证

- 双层修改抵消判断按字节比较 HEAD blob 与工作区文件，不应用 clean filter / EOL 转换；配置了转换的仓库可能把实际无变化的文件保留在“全部”范围（V1 用 porcelain diff 会应用转换）。
- 已跟踪但被忽略的文件清单只在 watcher 启动时计算，`.gitignore` 变化后不重算。
- fsmonitor（V2-D10）不在本任务范围；L 数据集 status 时延沿用 [Git 命令层探测](v2-01-git-level-probe.md) 的 P50 155.4 / P95 196.3 ms 作为决策依据，L 数据集 GUI 未运行。
- 未运行：macOS 14+ Apple Silicon / WKWebView、真实冷 OS 缓存、16 GiB 参考机、真实 Windows 前后台焦点、10 项目内存。
- GUI 证据全部为 **CDP / DOM 模拟**，不是真实鼠标或真实焦点；安全边界与清理方式同[任务 03 Windows 界面证据](task-03-windows-gui.md#gui-安全说明agentsmd-交付要求)（本轮新增的调试脚本 `artifacts/long-chain/debug-*.mjs` 同样只启动并结束自己的测试实例）。

## 任务 03 回归

V2-01 最终构建上重跑任务 03 界面套件（`artifacts/gui-probe/v2-01/task03.json`）：17/17 通过，包括在 V1 上因 F1 失败的“30 次图片 / 文本 / 冲突混合切换”（30/30，P50 13.2 / P95 25.1 ms；进程树工作集开始 442.0、峰值 488.5、结束 485.1 MiB，私有峰值 464.9 MiB）；两个夹具仓库读取前后不变。

## 需要用户决定

- 进程树内存预算（≤ 400 MiB 与 200 次增长 ≤ 10 %）在本机 WebView2 153 下 V1 基线已超出；V2-01 的额外部分主要是常驻 cat-file（5 个 × 约 7 MiB 工作集 / 34 MiB 私有）。可选：维持预算并继续优化（例如把常驻读取器上限从 5 降为 2–3，以更多进程启动换内存，需重新测量），或调整预算口径（例如按“Oris 自身 + Git 子进程”单列，WebView2 另计）。在决定前任务保持 Blocked。

## 复现

```powershell
node scripts/perf/gui-probe.mjs --exe D:\Projects\Research\Oris-builds\v2-01\target\release\oris.exe --label v2-01 --suite core,trace,restart,task03 --iterations 30
```
