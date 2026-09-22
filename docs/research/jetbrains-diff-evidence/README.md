# JetBrains Diff 调研证据索引

调研日期：2026-09-22。

本目录只记录可复查的来源入口，不包含用自制 HTML 冒充的 JetBrains 截图。

## 官方视觉材料

- IntelliJ IDEA 2026.2 Help 的双栏 Diff 截图（深色）：<https://resources.jetbrains.com/help/img/idea/2026.2/ij_compareFiles_dark.png>
- 同一截图（浅色）：<https://resources.jetbrains.com/help/img/idea/2026.2/ij_compareFiles.png>
- JetBrains 官方博客 2022-06 的双栏 Diff 截图：<https://blog.jetbrains.com/wp-content/uploads/2022/06/compare-files.png>
- 对应帮助页：<https://www.jetbrains.com/help/idea/differences-viewer.html>

## 官方公开源码快照

以下源码结论固定在 `intellij-community` 提交
`ecd958f56e9b2e987e5bd43f5cdd566b7030a301`（提交时间 2026-09-22T04:22:40Z），避免 `master` 漂移。

- 连接带端点、可见范围与零行范围：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/util/DiffDividerDrawUtil.java>
- 三次 Bézier 曲线及控制点：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/util/DiffDrawUtil.java>
- 视觉行补白、软换行重算：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/AlignedDiffModel.kt>
- 同步滚动映射：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/SyncScrollSupport.java>
- 未变区域折叠与两侧展开同步：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/FoldingModelSupport.java>
- 分隔栏宽度与拖拽基类：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/DiffSplitter.java>
- 每个 change 独立绘制：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/SimpleDiffModel.java>

## 实机边界

本机未发现 IntelliJ IDEA、WebStorm、PyCharm、Rider、CLion、GoLand 或 PhpStorm 的命令、Toolbox 安装目录或运行进程。本轮没有安装 IDE、没有修改用户 IDE 配置，也没有声称做过本地 JetBrains 实机验证。
