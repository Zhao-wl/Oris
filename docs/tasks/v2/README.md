# V2 实施任务

状态：V2-01、V2-06、V2-03 已完成（Windows，见下表）；V2-02 功能完成并已合入、性能复测暂缓；其余 Pending。共同输入：[V2 产品规格](../../specs/v2-product.md)、[V2 技术方案](../../architecture/v2-architecture.md)、[V2 验收计划](../../validation/v2-acceptance.md)、[V2 决策登记](../../decisions/v2-decisions.md)。V1 任务总表见 [../README.md](../README.md)；V1 文档中“明确不支持”的列表只约束 V1 范围。

## 五条纵向任务

| 任务 | 交付闭环 | 依赖 | 当前状态 |
| --- | --- | --- | --- |
| [V2-01 数据层与流畅度基础](01-data-layer-performance.md) | 测 V1 基线 → 单次 status + cat-file + OID 缓存 → 快照恢复 → watcher 分类 → 对比基线达标 | V1 03 代码已提交（V2-D27） | Done（Windows）：功能 / 安全验收、§3 可测时延与 §4 分层内存预算（V2-D29）达标；外部变化时延与 macOS 未验证（[结果](../../validation/v2-01-results.md)） |
| [V2-02 暂存、丢弃与提交](02-stage-commit.md) | 写操作通道 → stage/unstage → discard（含撤销）→ commit/amend/撤销提交 | V2-01 | 功能完成并已合入（Windows）：B05–B08、B16、B17 通过；性能复测暂缓，由用户另行安排（[结果](../../validation/v2-02-results.md)） |
| [V2-03 stash 与分支切换](03-stash-branch.md) | stash 保存 / 查看 / 恢复 → 新建 / 切换分支 → detached 检出 → 分支管理 | V2-02、V1 04 | Done（Windows）：B09、B10、B16、B17 通过；macOS 与性能未测（[结果](../../validation/v2-03-results.md)） |
| [V2-04 远端同步与合并](04-sync-merge.md) | pull / push（进度、取消）→ merge → 冲突只读查看 → 标记已解决 → 完成或中止 | V2-02、V1 03、V1 04 | Pending |
| [V2-05 hunk 级暂存与丢弃](05-hunk-operations.md) | 在 diff 中逐 hunk 暂存 / 取消暂存 / 丢弃 | V2-02；默认在 V1 05 之后 | Pending |
| [V2-06 设置与外观](06-settings-appearance.md) | 设置框架与分类 → Git / 字号 / 浅深色迁入 → 颜色变量化 → VS Code 配色方案移植 | V2-01 | Done（Windows）：B19–B22 与配色 / 设置时延通过，V2-01 预算未退步；macOS 与真实系统主题切换未验证（[结果](../../validation/v2-06-results.md)） |

## 执行顺序（V2-D17，经 V2-D26 修订，用户已确认）

V1 03 → **V2-01** → V2-06 → V2-02 → V1 04 → V2-03 → V2-04 → V1 05 → V2-05 → V1 06 合并发布验收（V2-D19：一二期合并为一次发布，一期不单独发布）

理由：
- V2-01 改动的是所有读取路径，放在 V1 04（历史）之前做，04 的提交 diff、文件历史可以直接建立在 OID 读取之上，避免返工；同时要等 V1 03 完成，以免与它在 `git.rs` 读取路径上的改动冲突。
- V2-02 不依赖历史视图，可以在 V1 04 之前交付。
- V2-03 的检出提交、V2-04 的合并目标选择与领先/落后数依赖 V1 04 的分支与提交视图。
- V2-05 的 hunk 语义受空白规则影响，V1 05 固定空白规则之后再做。
- V2-06 排在 V2-01 之后、V2-02 之前（V2-D26）：它把界面颜色全部收拢为变量，二期后续新增的提交页、同步、横幅等界面可以直接使用；它依赖 V2-01 的前端 store 与单编辑器实例。

## 执行约定

沿用 [V1 任务通用执行约定](../README.md#任务通用执行约定)。另外：
- 每个写操作任务都要附带操作前后的仓库状态对比证据，并通过 B16、B17。
- V2-01 之后的每个任务都要复测 R-FLOW 预算中与它相关的行，不能因为新增功能导致性能退步。
- V2-02 的界面按用户已确认的[一期与二期混合发布参考图](../../design/04-mixed-release-ui-reference.md)（`oris-mixed-release.html`，V2-D18）实现，差异见 [V2-02 结果](../../validation/v2-02-results.md#与参考图和技术方案的差异)。
