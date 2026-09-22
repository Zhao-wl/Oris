# Oris V1 文档入口

更新日期：2026-09-22。适用于本轮已确认的 V1 产品范围及技术栈。

## 阅读顺序

1. [决策登记](decisions/v1-decisions.md)：区分用户已确认、工程建议和待验证项。
2. [产品规格](specs/v1-product.md)：使用场景、功能边界及需求编号。
3. [UI/UX 基准](design/02-approved-ui.md)：JetBrains 风格 V2 与只读交互。
4. [技术方案](architecture/v1-architecture.md)：模块、数据契约、Git 与 diff、安全与性能。
5. [验收计划](validation/v1-acceptance.md)：需求覆盖、正确性、双平台验证与性能预算。
6. [任务清单](tasks/README.md)：五项纵向实施任务、依赖与完成条件。

## 文档约定

- 产品规格决定“做什么”；技术方案描述“如何做”；任务引用需求，不另行缩减功能。
- `已确认` 表示来自本轮用户明确选择。`工程建议` 允许实现前依据直接证据调整，但必须记录原因及影响。
- `待验证` 不能写成已实现、已通过或最终选型。涉及已确认功能/平台的变更需用户决策。
- 文档完成不等于应用完成。所有实施任务当前为未开始，不创建代码、提交或发布。
- 先实现最短可用浏览链路，再扩展其他 V1 场景；不为框架分层单独拆出无法验收的基础设施任务。

## 历史资料

- [原始方向提案](design/01-product-direction.md)已经被本版规格替代，保留用于追溯。
- [Git 客户端调研](research/01-git-clients.md)、[IDE 与插件调研](research/02-ide-plugins.md)、[Diff 与只读语义调研](research/03-diff-and-readonly.md)是证据资料，不是最终范围。
