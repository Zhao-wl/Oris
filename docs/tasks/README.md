# V1 实施任务

状态：开发已启动；任务 01 为 Blocked（Windows 双独立滚动、零行语义与外缘双列轨道已实施并通过本轮基础覆盖；最新获授权的选区/搜索/viewport 阅读切片也已通过 Windows 基础需求覆盖；仍等待 macOS 14+ Apple Silicon/WKWebView 真机验证）。用户已明确批准以 Windows 已通过的基础继续启动任务 02，macOS 未验证事实与任务 01 的 Blocked 状态继续保留；任务 04 的本次阅读功能只是提前实施切片，其余 03–05 仍为 Pending。没有发布产品。

共同输入：[产品规格](../specs/v1-product.md)、[技术方案](../architecture/v1-architecture.md)、[UI/UX](../design/02-approved-ui.md)、[验收计划](../validation/v1-acceptance.md)、[决策登记](../decisions/v1-decisions.md)。

## 五条纵向任务

| 任务 | 交付闭环 | 依赖 | 当前状态 |
| --- | --- | --- | --- |
| [01 真实仓库文本 Diff 与双平台选型验证](01-repository-diff.md) | 打开仓库 → 选文件 → 阅读真实 diff；确定组件可行性 | 无 | Blocked：Windows 独立修复与对齐开关通过基础覆盖；macOS 真机待验证 |
| [02 多项目与完整本地变更浏览](02-project-workspace.md) | 多项目切换 → 三种比较范围 → 外部变化更新 → 恢复阅读状态 | 01 Windows 基础通过；macOS 门禁保留 | Ready（用户已明确批准启动；平铺/树切换、最近单仓库恢复切片已提前交付） |
| [03 提交、分支、版本比较与文件历史](03-history-branches.md) | 分支/提交 → 文件 diff → 两版本/文件历史；显式 fetch | 02 通过 | Pending |
| [04 完整阅读体验与图片差异](04-diff-experience.md) | 完善文本交互 → 图片/特殊内容 → 键盘与主题 | 02 通过 | Pending（选区/搜索/viewport 阅读切片已提前实施） |
| [05 双平台性能与可安装发布包](05-performance-release.md) | 全范围真实验收 → 性能预算 → 双平台安装/签名 | 03、04 通过 | Pending |

默认顺序：01 → 02 → 03 → 04 → 05。03/04 没有产品依赖，但共享 diff 契约；只有确认文件/接口/资源隔离后才能并行，不能因为表格上无直接依赖就默认并发。

01 是可运行的纵向交付，不是只有技术调研。任务 01 已确定 Git 最低支持版本为 2.31.0，npm/Cargo 具体依赖由 lockfile 锁定；Windows 基础覆盖和性能/Git 基线表述已经关闭，但 macOS 真机证据未完成，因此 01 保持 Blocked。用户已明确接受在保留该平台门禁的前提下启动 02；这只是解除 02 的启动阻塞，不等于 01 双平台验收通过，也不降低后续 macOS 验收要求。

内部覆盖代理 `/root/task01_coverage` 完成的是定向覆盖复查：原 Windows 目录树、A06 几何/滚动/复制、A13 textconv 与工作区字节只读校验三个缺口均已关闭。该结论不是全量代码审核，也不替代 macOS 真机验收。

JetBrains Diff 首轮专项调研结论与证据入口见 [JetBrains Diff 行为调研](../research/04-jetbrains-diff-behavior.md)，Align 关闭后的双侧滚动、零行语义和外缘轨道见 [研究 05](../research/05-unaligned-diff-scroll.md)。研究 05 已完成并按用户授权实施；实现不宣称逐像素复制 JetBrains，macOS 平台门禁仍未解除。

## 需求覆盖索引

| 需求 | 实现主责 | 最终验收 |
| --- | --- | --- |
| R-PROJECT | 02 | A02/A03，05 复核 |
| R-LOCAL | 01 基础、02 完整 | A01/A04/A05 |
| R-FILES | 02 | A04/A12 |
| R-DIFF | 01 基础、04 完整 | A06/A12/A14 |
| R-HISTORY/R-BRANCH | 03 | A07/A08 |
| R-COMPARE/R-FILEHISTORY | 03 | A09 |
| R-REMOTE | 03 | A10 |
| R-IMAGE | 04 | A11 |
| R-UX | 02 状态、04 交互 | A03/A06 |
| R-SAFE | 全任务，01 建边界 | A01/A05/A10/A13 |
| R-PERF | 全任务，05 总体验收 | A03/A14 |
| R-PLATFORM | 01 起两端验证、05 发布 | A15 |

## 任务通用执行约定

- 开始前检查现有改动，仅修改任务相关文件，保护共享工作树；不切分支、不清理他人内容。
- 使用真实 Git 数据完成对应 UI 闭环，不用预填结果/固定计数作为验收证据。
- 不添加任务外产品功能、数据库、恢复/重试体系、遥测或云服务。遇错误清楚报告并停止该次动作。
- 核对源代码、测试夹具、日志的生成调用链，避免用截图或静态页面替代功能证明。
- 任务完成报告包含交付版本、逐项验收结果、证据路径、未运行平台和遗留问题；无证据不得标记完成。
- 状态流转：Ready/Pending → In progress → Awaiting acceptance → Done；实质问题为 Blocked 并说明恢复条件。
- 用户已授权按完整计划派发实施，并明确批准基于任务 01 的 Windows 基础覆盖启动任务 02；任务 03–05 仍按各自依赖保持 Pending。推送与发布仍未授权。
