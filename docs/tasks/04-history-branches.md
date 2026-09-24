# 04 — 提交、分支、版本比较与文件历史

状态：**Done（Windows）**（2026-09-24，[结果](../validation/v1-04-results.md)）：A07–A10、B17 只读回归、键盘浏览与渐进加载（计数类）通过，真实远端 AgentHub 的 SSH / HTTPS fetch 通过。**macOS 未验证；性能计时与内存未测**（按用户安排另行测量）。依赖口径按 V2-D33（沿用 V2-D27：02、03 Windows 基础通过 + 代码已提交）。

编号迁移：2026-09-23 从原 03 顺延为 04，原范围保留。

**预制模块已完成（2026-09-23，分支 `wip/v1-04-core`）**：`src-tauri/src/git/log.rs`、`src-tauri/src/git/refs.rs`、`src/history-graph.ts` 及真实临时仓库测试。2026-09-24 已按文末“接入清单”接入界面并完成验收（`feat/v1-04`）。

## 用户闭环

作为用户，我能从分支/提交进入文件差异，比较任意两个版本，追溯单文件历史，并显式更新远端跟踪状态而不切换工作分支。

## 范围

- R-HISTORY：真实 parents 驱动的分页提交图、提交元信息/文件 diff、作者/消息/SHA 搜索、分支筛选、HEAD 定位。
- 根提交相对空树；合并提交父节点选择，不默认把 first-parent 当成唯一父节点。
- R-BRANCH：本地/远端 refs、上游、当前工作分支与浏览分支分开；ahead/behind/无上游/gone/未知。
- R-COMPARE：任意两个提交/分支直接比较，解析 OID 后固定端点，交换方向，ref 移动提示刷新。
- R-FILEHISTORY：单文件历史、相关提交 diff、返回上下文；rename 跟随边界有说明；不做 blame。
- R-REMOTE：独立手动 fetch；上游 remote 默认/无上游显式选择；已有凭据环境；禁自动 fetch/prune/子模块递归/额外维护；失败取消后重读实际 refs。
- Git Log 采用已确认 UI：分支列表、拓扑、提交列表、元信息、联动同一文件/diff 阅读器。

## 验收

- [x] A07：线性、分叉、merge、root、分页边缘拓扑与 refs/OID 一致；搜索/筛选不改变仓库。
- [x] A08：ahead/behind 用真实可达性核对；无上游/gone 不显示伪 0；选择分支前后 HEAD/index/工作区不变。
- [x] A09：比较方向、ref 固定、历史及 rename 边界；所有入口复用统一 diff 语义。接入任务 03 的静态图片阅读器，验证 commit/OID 双端、根提交和不同父节点；历史 merge 不用当前 index stages 冒充。
- [x] A10：本地 bare remote 场景中显式 fetch 更新正确，普通刷新不联网；已有认证环境在双平台分别验证或清晰记未运行。（Windows：AgentHub SSH / HTTPS 通过；macOS 未运行）
- [x] fetch 失败/取消不承诺回滚元数据；工作区/index 不被本应用改变，不附带 pull/push。
- [ ] 双平台键盘浏览与大量提交渐进加载可用，进程数/缓存不随条目无界增长。（Windows 计数类断言通过：每页 1 个 log 进程、常驻 Git ≤ 2；macOS 与计时未运行）

## 交付与排除

完整历史/分支调查链路与 fetch 边界证据；无分支写操作、共同基线增强、PR/Issue、凭据管理或终端。


## 预制模块与接入清单

以下只是读取与布局模块及其测试，**未接入界面**，不构成 A07–A10 的通过证据；R-REMOTE（显式 fetch）不在预制范围内。

| 模块 | 内容 | 测试（`src-tauri/src/git/history_tests.rs`、`src/history-graph.test.ts`） |
| --- | --- | --- |
| `git/log.rs` `read_log` | `git log -z --topo-order --decorate=full --no-show-signature`，含 parents、作者、提交者、时间、消息、refs 装饰；第一页把起点 ref 解析为 OID 并写入游标，后续页用同一组 OID + `--skip`，分页期间 ref 移动不改变已显示提交的身份；单页上限 1000 | 线性 25 个提交分三页，第二页前分支前进仍返回原来的第 11–20 个提交 |
| 搜索与筛选 | 作者 / 消息按字面量（`--fixed-strings`、忽略大小写）；SHA 前缀 ≥4 位解析为提交；按分支（完整引用名）筛选；选择分支不切换工作分支 | 含正则特殊字符的消息、作者、SHA 前缀、分支筛选、`branch --show-current` 不变 |
| `commit_changes` | 根提交 `--root` 相对空树；合并提交默认第一个父节点，可指定任一父节点，非父节点拒绝 | 两个父节点分别得到不同文件集合；根提交全部为新增 |
| `compare` / `swapped` | 两端点直接比较（非共同基线），先 `rev-parse --verify --end-of-options <ref>^{commit}` 固定 OID；交换方向复用已固定的 OID | ref 移动后原比较与交换方向都不读取新位置 |
| `file_history` | `--follow --name-status -M`，每条记录给出该提交中的路径，改名提交标注 `renamed_from`（跟随边界）；`reached_origin` 表示已到达新增提交，否则说明记录不连续或还有下一页 | 改名前后四条记录、分页后到达起点、`../` 路径拒绝 |
| `git/refs.rs` `read_refs` | 本地 / 远端跟踪分支（排除 `origin/HEAD` 符号引用）、当前工作分支、detached、空仓库；上游状态 `NoUpstream` / `Gone` / `Known{ahead,behind}` / `Unknown`，数字来自 `%(upstream:track)`（Git 按可达性计算），浅克隆记为 `Unknown` | 本地 bare remote：同步、领先、落后、分叉（与 `rev-list --left-right --count` 逐一核对）、上游已删除、无上游、detached、空仓库、浅克隆 |
| 只读与安全 | 全部经只读通道（`--no-optional-locks`、禁用 external diff / textconv）；`--no-show-signature` 防止 `log.showSignature` 触发 GPG；以 `-` 开头的引用拒绝 | 配置 `log.showSignature=true`、`gpg.program`、`diff.external` 为标记脚本后全部读取，标记未出现，`.git`（不含 objects/logs）与工作区逐字节不变 |
| `src/history-graph.ts` `layoutGraph` | 按真实 parents 计算泳道：子提交汇合、第二父节点开新泳道、穿过的泳道原样延续；分页边缘未加载的父提交以 `continuations` 标记，结果集外的父提交（筛选 / 搜索）同样只标延续，不伪造终点；布局按行顺序增量计算，加载下一页不改变已显示行 | 线性、分叉合并、交错的两条独立历史、分页边缘延续与下一页后前几行不变、筛选结果、octopus 合并、重复提交检测 |

### 接入时需要改动的位置

1. `src-tauri/src/lib.rs`：新增只读命令 `read_log`、`commit_changes`、`compare_revisions`、`file_history`、`read_refs`，参数为类型化结构（`LogQuery`、`LogCursor`、引用名），不接受任意 Git 参数；按仓库 generation 取消过期请求。
2. 内容读取：提交 / 比较两端按 OID 读取，接入 V2-01 的 `ContentReader`（常驻 `cat-file --batch` 与 BlobCache）；新增“commit:path → OID”的 `ls-tree` 查询，图片仍走任务 03 的图片阅读器。历史中的合并提交不得用当前 index stages 冒充冲突版本（A09）。
3. 前端：Git Log 视图（分支列表、提交图、提交列表、元信息，按[混合发布参考图](../design/04-mixed-release-ui-reference.md)）；提交列表使用 V2-01 的虚拟列表，滚动到底部时用 `next` 游标加载下一页，并把累积结果交给 `layoutGraph`；比较端点显示固定的 OID，ref 移动时提示刷新。
4. watcher 的 `refs` 类事件（V2-01 已分类）触发分支列表与日志刷新。
5. R-REMOTE 显式 fetch 与 A10 需另行实现与验收（写元数据，不属于本预制范围）。
