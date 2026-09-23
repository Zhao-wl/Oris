# V2 实施任务

状态：全部 Pending（未开始），本次只做规划。共同输入：[V2 产品规格](../../specs/v2-product.md)、[V2 技术方案](../../architecture/v2-architecture.md)、[V2 验收计划](../../validation/v2-acceptance.md)、[V2 决策登记](../../decisions/v2-decisions.md)。V1 任务总表见 [../README.md](../README.md)；V1 文档中“明确不支持”的列表只约束 V1 范围。

## 五条纵向任务

| 任务 | 交付闭环 | 依赖 | 当前状态 |
| --- | --- | --- | --- |
| [V2-01 数据层与流畅度基础](01-data-layer-performance.md) | 测 V1 基线 → 单次 status + cat-file + OID 缓存 → 快照恢复 → watcher 分类 → 对比基线达标 | V1 03 完成 | Pending |
| [V2-02 暂存、丢弃与提交](02-stage-commit.md) | 写操作通道 → stage/unstage → discard（含撤销）→ commit/amend/撤销提交 | V2-01 | Pending |
| [V2-03 stash 与分支切换](03-stash-branch.md) | stash 保存 / 查看 / 恢复 → 新建 / 切换分支 → detached 检出 → 分支管理 | V2-02、V1 04 | Pending |
| [V2-04 远端同步与合并](04-sync-merge.md) | pull / push（进度、取消）→ merge → 冲突只读查看 → 标记已解决 → 完成或中止 | V2-02、V1 03、V1 04 | Pending |
| [V2-05 hunk 级暂存与丢弃](05-hunk-operations.md) | 在 diff 中逐 hunk 暂存 / 取消暂存 / 丢弃 | V2-02；默认在 V1 05 之后 | Pending |

## 执行顺序（V2-D17，用户已确认）

V1 03 → **V2-01** → V2-02 → V1 04 → V2-03 → V2-04 → V1 05 → V2-05 → 发布验收（V1 06 与二期的关系待 P-V2-02 确认）

理由：
- V2-01 改动的是所有读取路径，放在 V1 04（历史）之前做，04 的提交 diff、文件历史可以直接建立在 OID 读取之上，避免返工；同时要等 V1 03 完成，以免与它在 `git.rs` 读取路径上的改动冲突。
- V2-02 不依赖历史视图，可以在 V1 04 之前交付。
- V2-03 的检出提交、V2-04 的合并目标选择与领先/落后数依赖 V1 04 的分支与提交视图。
- V2-05 的 hunk 语义受空白规则影响，V1 05 固定空白规则之后再做。

## 执行约定

沿用 [V1 任务通用执行约定](../README.md#任务通用执行约定)。另外：
- 每个写操作任务都要附带操作前后的仓库状态对比证据，并通过 B16、B17。
- V2-01 之后的每个任务都要复测 R-FLOW 预算中与它相关的行，不能因为新增功能导致性能退步。
- V2-02 开工前，[二期 UI 提案](../../design/03-phase2-ui-proposal.md)必须已获用户确认（V2-D18）。
