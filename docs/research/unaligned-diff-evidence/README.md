# Align OFF / 双侧滚动研究证据索引

本目录只保存 `05-unaligned-diff-scroll.md` 的证据入口与复核元数据，不复制第三方源码或图片。

## 固定来源

- JetBrains 帮助：<https://www.jetbrains.com/help/idea/differences-viewer.html>
- JetBrains 2026.2 官方截图：<https://resources.jetbrains.com/help/img/idea/2026.2/ij_compareFiles_dark.png>
- JetBrains 固定源码提交：`ecd958f56e9b2e987e5bd43f5cdd566b7030a301`
- `SimpleDiffViewer.java`：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/SimpleDiffViewer.java>
- `BaseSyncScrollable.java`：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/BaseSyncScrollable.java>
- `SyncScrollSupport.java`：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/SyncScrollSupport.java>
- `TwosideTextDiffViewer.java`：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/side/TwosideTextDiffViewer.java>
- `DiffDrawUtil.java`：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/util/DiffDrawUtil.java>
- `AlignedDiffModel.kt`：<https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/AlignedDiffModel.kt>
- CodeMirror Reference Manual：<https://codemirror.net/docs/ref/>
- CodeMirror 作者讨论：<https://discuss.codemirror.net/t/merge-view-align-feature/7940>

## 本地发布物指纹

- package：`@codemirror/merge@6.12.2`
- tarball：`https://registry.npmjs.org/@codemirror/merge/-/merge-6.12.2.tgz`
- integrity：`sha512-V8JvyAPjHbPupqP7BeMcsdsYCbyPij74jxIbaIJDORI+VZzW44zFmon8bF+oxGWvOKhcRmkiUMXd8MxHr3YA2w==`
- `node_modules/@codemirror/merge/dist/index.js` SHA-256：`98F01E3A8C526B392840718807F95848621DFE6F7E4D48BD0AEF57304A6EA8DF`
- `node_modules/@codemirror/merge/dist/index.d.ts` SHA-256：`C3B1E3A14C6DD668CFA8615DC2EEE1427D3AF6D1B90562C3CC6EAB48DB5A8546`

## 本地复核位置（2026-09-22 快照）

- `src/App.tsx`：Align 默认值与工具栏开关。
- `src/DiffViewer.tsx`：split 始终创建 `MergeView`；Oris 自定义 spacer 仅 Align 开启时安装；导航当前滚动外层 `merge.dom`。
- `src/styles.css`：`.cm-mergeView` 为外层 `overflow:auto`。
- `node_modules/@codemirror/merge/dist/index.js`：约 854-983 行是私有 spacer/update 链，1077-1112 行是 merge/scroller 布局主题，1181-1281 行是 `MergeView` 构造链。
- `node_modules/@codemirror/merge/dist/index.d.ts`：约 250-307 行为公开 `DirectMergeConfig` 和 `MergeView` 类型，没有关闭 alignment/spacer 的选项。

## 来源边界

- 用户期望截图来源未知，只用于描述目标外观，不作为 JetBrains 官方证据。
- JetBrains 通用 error-stripe 在高密度同像素碰撞时的具体覆盖/混色顺序未固定为本文契约。
- 本目录没有复制或修改第三方材料；所有链接和 hash 仅用于复核。
