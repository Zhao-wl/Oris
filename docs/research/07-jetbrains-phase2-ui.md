# JetBrains Git 操作界面调查与 Oris 对照

日期：2026-09-23。调查对象为 JetBrains IntelliJ IDEA 2026.2 官方帮助中的 Git staging、Commit 工具窗口、VCS widget、Stash 和 Diff 行为。这里记录可观察的产品关系，不把 JetBrains 的实现细节当作 Oris 规范。

官方截图可直接对照：[Git staging area](https://resources.jetbrains.com/help/img/idea/2026.2/git_staging_area.png)、[文件行暂存入口](https://resources.jetbrains.com/help/img/idea/2026.2/git_stage_from_toolwindow.png)、[分支/VCS widget](https://resources.jetbrains.com/help/img/idea/2026.2/git_widget.png)。下文“对 Oris 的启发”是基于资料与项目约束作出的设计推断，不是 JetBrains 原文。

## 观察

| 任务 | JetBrains 官方呈现 | 对 Oris 的启发 |
| --- | --- | --- |
| 分支与远端 | 主窗口顶部的 VCS widget 显示当前分支及收发计数；点击后进入分支操作，Fetch 在 widget 内；Pull 使用选项对话框，Push 可先检查待推送提交。([分支](https://www.jetbrains.com/help/idea/manage-branches.html)、[同步](https://www.jetbrains.com/help/idea/sync-with-a-remote-repository.html)、[推送](https://www.jetbrains.com/help/idea/commit-and-push-changes.html)) | 当前分支及领先/落后数需要持续可见；Fetch/Pull/Push 可归入一个“同步”入口，避免在 Oris 已有标题栏再放三枚常驻按钮。Pull/Push 仍需独立确认界面。 |
| 暂存与提交 | 启用 staging area 后，Commit 工具窗口集中展示变更、暂存入口和提交控件；文件行有暂存按钮。提交控件可按任务展开、收起，工具窗口的位置也可调整。([提交与暂存](https://www.jetbrains.com/help/idea/commit-and-push-changes.html)) | 文件级暂存保留在文件行；提交表单做成可展开的底部“提交”任务页，不永久占据文件列表高度。 |
| 块级操作 | IDE 编辑器通过 gutter 的变化标记进入块级 Stage；更细粒度才打开 HEAD/Staged/Local 三方视图。([提交与暂存](https://www.jetbrains.com/help/idea/commit-and-push-changes.html)) | Oris 没有可编辑代码区、二期也不做行级操作；应在每个 hunk 标题行显示有文字的“暂存此块/丢弃此块”，只在合适比较范围出现。中央连接区仍只表达差异关系。 |
| Stash | Stash 与 Commit 在同一工具窗口的页签中，选中 stash 后可查看文件与 diff，再执行 Apply/Pop/Drop。([Stash](https://www.jetbrains.com/help/idea/shelving-and-unshelving-changes.html)) | Oris 底部 Git 区可设“日志 / 提交 / Stash / 操作输出”任务页；选中 stash 文件仍使用主 diff 阅读器。 |
| 丢弃与冲突 | 丢弃前列出影响文件；分支切换受本地改动阻止时显示文件与后续选择。JetBrains 的 Smart Checkout 会暂存并恢复改动，但 Oris 的既定行为是 stash 后切换且不自动恢复。([撤销变更](https://www.jetbrains.com/help/idea/undo-changes.html)、[分支](https://www.jetbrains.com/help/idea/manage-branches.html)) | 保留 Oris 规格中的二次确认、安全网、只读冲突查看和显式 stash 恢复，不借用 JetBrains 的自动恢复语义。 |

## 当前效果图与已确认基准的偏差

1. 现图将“获取 / 拉取 / 推送”三枚按钮和分支控件并排常驻标题栏；在 1240px 固定画框下增加密度，也弱化了 V1 已确认的项目切换和大面积 diff。
2. 提交表单固定在左侧文件列表底部，始终挤占列表；这与“文件列表独立滚动、标题/过滤/计数固定可见”和 diff 阅读优先的目标不够协调。
3. hunk 操作浮在代码行右侧，遇到长行或窄分栏会覆盖正文；纯图标还要求先猜动作。V1 已明确中央连接区不放写入箭头，因此不能简单挪到连接区。
4. 同一批文件既按“未暂存 / 已暂存 / 全部”切换比较端点，又在文件行放复选框和写入按钮，现图未充分说明“复选”只是批量选择、不会自动暂存。

## 本轮参考图的设计选择

- 标题栏常驻当前分支与收发计数；“同步”作为单一入口，其内区分获取、拉取、推送，拉取策略和推送目标由独立确认界面承载。
- 保留 Oris 的三个比较范围。文件行提供对应范围的暂存/取消暂存操作；复选框只用于批量选择。文件数量与已暂存总数同时持续可见。
- 底部 Git 区可收起，页签是“日志 / 提交 / Stash / 操作输出”。选择“提交”时才展开草稿、amend 与提交按钮；选择文件仍可在主 diff 阅读。
- hunk 标题行是写操作入口，按钮文案明确。未暂存可暂存/丢弃，已暂存可取消暂存，全部及冲突范围无写入口；禁用原因以说明文字呈现。
- 合并进行中、detached HEAD、外部 rebase 等状态使用靠近阅读器的持久横幅；普通成功/失败使用状态栏摘要并可查看操作输出。

上述为待确认的交互参考，不修改 V1/V2 规格与既有决策。新版图见 [Oris 混合发布 UI 参考图](../design/oris-mixed-release.html)。
