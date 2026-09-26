# V1 实施任务

状态：开发已启动；任务 01 与任务 02 均为 Blocked。两项 Windows 实现与基础需求覆盖已经通过，但仍等待 macOS 14+ Apple Silicon/WKWebView、GUI 与文件监听真机验证；这不等于双平台最终验收通过。任务 03 源码与非 GUI 自动验证基础覆盖已通过，整体为 Blocked／待平台验收（平台/GUI 门禁保留），任务 04 已完成（Windows，2026-09-24），任务 05 已完成（Windows，2026-09-26），任务 06 为合并发布验收；没有发布产品。

共同输入：[产品规格](../specs/v1-product.md)、[技术方案](../architecture/v1-architecture.md)、[UI/UX](../design/02-approved-ui.md)、[验收计划](../validation/v1-acceptance.md)、[决策登记](../decisions/v1-decisions.md)。

## 六条纵向任务

| 任务 | 交付闭环 | 依赖 | 当前状态 |
| --- | --- | --- | --- |
| [01 真实仓库文本 Diff 与双平台选型验证](01-repository-diff.md) | 打开仓库 → 选文件 → 阅读真实 diff；确定组件可行性 | 无 | Blocked：Windows 独立修复与对齐开关通过基础覆盖；macOS 真机待验证 |
| [02 多项目与完整本地变更浏览](02-project-workspace.md) | 多项目切换 → 三种比较范围 → 外部变化更新 → 恢复阅读状态 | 01 Windows 基础通过；macOS 门禁保留 | Blocked：Windows 实现与基础覆盖通过；macOS GUI/WKWebView/watcher 真机待验证 |
| [03 图片差异与冲突只读查看](03-image-conflict-diff.md) | 静态 PNG/JPEG/WebP 图片比较 → stages/WT 冲突版本阅读；仅两闭环 | 02 通过，原平台及 GUI 门禁保留 | Windows 基础通过，macOS 待验证：代码已交付（`2211753`）；Windows WebView2 界面证据在 V1 基线上 16/17（混合切换受 F1 影响），V2-01 修复后 17/17（[证据](../validation/task-03-windows-gui.md)）；真实焦点与 macOS 未验证 |
| [04 提交、分支、版本比较与文件历史](04-history-branches.md) | 分支/提交 → 文件 diff → 两版本/文件历史；显式 fetch | 02、03 Windows 基础通过 + 代码已提交（V2-D33） | Done（Windows）：A07–A10、B17 通过，AgentHub SSH / HTTPS fetch 通过；macOS 与性能未测（[结果](../validation/v1-04-results.md)） |
| [05 完整阅读体验与特殊文件](05-diff-experience.md) | 完善文本交互/编码 → 其他特殊内容 → 键盘与主题；复用 03 图片 | 02、03 通过；默认 04 后 | Done（Windows）：A06、A11、A12 通过；macOS、Mac Retina、真实高 DPI 未验证；字号切换滚动场景超预算交发布性能测试（[结果](../validation/v1-05-results.md)） |
| [06 双平台性能与可安装发布包](06-performance-release.md) | 全范围真实验收 → 性能预算 → 双平台安装/签名；一二期合并发布（V2-D19） | 03、04、05 与二期 V2-01–V2-06 通过 | Pending |

默认顺序：01 → 02 → 03（图片→冲突）→ 04 → 05 → 06。04/05 共享 diff 契约，只有确认文件/接口/资源隔离后才能并行；当前不启动后续产品任务。此前只授权正式文档同步；2026-09-23 用户另行明确授权任务 03 开发，证据见[任务 03 实现报告](../validation/task-03-image-conflict-evidence.md)。

01 与 02 都是可运行的纵向交付，不是只有技术调研。任务 01 已确定 Git 最低支持版本为 2.31.0，npm/Cargo 具体依赖由 lockfile 锁定；任务 02 的 Windows 多项目、完整本地变化、外部更新、恢复与性能基础覆盖也已关闭。两项都缺少 macOS 真机证据，因此保持 Blocked；该基础通过本身不自动解锁后续任务；03 已另获用户明确开发授权，04–06 未启动，后续 macOS 验收要求不降低。

内部覆盖代理 `/root/task01_coverage` 完成的是定向覆盖复查：原 Windows 目录树、A06 几何/滚动/复制、A13 textconv 与工作区字节只读校验三个缺口均已关闭。该结论不是全量代码审核，也不替代 macOS 真机验收。

内部覆盖代理 `/root/task02_coverage` 完成的是 Windows 基础需求定向复查：失效阅读锚点的明确提示与合法回退缺口关闭，其余既定覆盖成立。该复查未重跑测试，也不是全量技术深审；运行结果仍以任务 02 的 Windows 验证记录为准，macOS 门禁未解除。

总控内部 `task03_coverage` 只读基础检查已通过：当前源码及既有非 GUI 自动验证基本覆盖 A/B，未发现明确实现遗漏。此次检查未重跑测试，也不是技术深审；不替代真实平台验收。任务 03 整体 A/B 与双平台最终验收未通过，04–06 保持 Pending、未启动，不释放后继。

任务 03 开发收尾已按当前源码重跑非 GUI 回归并重新构建独立 release，结果见[收尾记录](../validation/task-03-closeout.md)；真实平台证据缺口与上述 Blocked 状态不变。

JetBrains Diff 首轮专项调研结论与证据入口见 [JetBrains Diff 行为调研](../research/04-jetbrains-diff-behavior.md)，Align 关闭后的双侧滚动、零行语义和外缘轨道见 [研究 05](../research/05-unaligned-diff-scroll.md)。研究 05 已完成并按用户授权实施；实现不宣称逐像素复制 JetBrains，macOS 平台门禁仍未解除。

## 需求覆盖索引

| 需求 | 实现主责 | 最终验收 |
| --- | --- | --- |
| R-PROJECT | 02 | A02/A03，06 复核 |
| R-LOCAL | 01 基础、02 本地范围、03 冲突只读 | A01/A04/A05 |
| R-FILES | 02 | A04/A12 |
| R-DIFF | 01 基础、05 完整 | A06/A12/A14 |
| R-HISTORY/R-BRANCH | 04 | A07/A08 |
| R-COMPARE/R-FILEHISTORY | 04 | A09 |
| R-REMOTE | 04 | A10 |
| R-IMAGE | 03 图片、05 其他特殊文件 | A11 |
| R-UX | 02 状态、05 交互 | A03/A06 |
| R-SAFE | 全任务，01 建边界 | A01/A05/A10/A13 |
| R-PERF | 全任务，06 总体验收 | A03/A14 |
| R-PLATFORM | 01 起两端验证、06 发布 | A15 |

## 2026-09-23 编号迁移与历史追溯

| 原文件/编号 | 当前文件/编号 |
| --- | --- |
| 新增 | [03-image-conflict-diff.md](03-image-conflict-diff.md) |
| 03-history-branches.md / 03 | [04-history-branches.md](04-history-branches.md) / 04 |
| 04-diff-experience.md / 04 | [05-diff-experience.md](05-diff-experience.md) / 05 |
| 05-performance-release.md / 05 | [06-performance-release.md](06-performance-release.md) / 06 |

仅原 04 图片实现主责迁至新 03；文本/编码、二进制/SVG/LFS/submodule 既有约定仍由现 05 承担。历史研究、运行记录和验证报告保留当时编号与内容，查阅其中旧 03/04/05 时按上表对应；编号变化不是重跑验收。研究中的全格式候选不属于新 03，正式票据为准。

## 任务通用执行约定

- 开始前检查现有改动，仅修改任务相关文件，保护共享工作树；不切分支、不清理他人内容。
- 使用真实 Git 数据完成对应 UI 闭环，不用预填结果/固定计数作为验收证据。
- 不添加任务外产品功能、数据库、恢复/重试体系、遥测或云服务。遇错误清楚报告并停止该次动作。
- 核对源代码、测试夹具、日志的生成调用链，避免用截图或静态页面替代功能证明。
- 任务完成报告包含交付版本、逐项验收结果、证据路径、未运行平台和遗留问题；无证据不得标记完成。
- 状态流转：Ready/Pending → In progress → Awaiting acceptance → Done；实质问题为 Blocked 并说明恢复条件。
- 用户已授权按完整计划派发实施，并明确批准基于任务 01 的 Windows 基础覆盖启动任务 02；03 此后已获明确开发授权，源码与非 GUI 自动验证基础覆盖通过；现整体为 Blocked／待平台验收，04–06 保持 Pending、未启动，不释放后继。2026-09-23 用户已授权提交并推送到 `origin/main`；发布仍未授权。
