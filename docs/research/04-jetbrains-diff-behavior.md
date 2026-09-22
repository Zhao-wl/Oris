# JetBrains 原生双栏 Diff 行为调研

状态：专项调研结论；不修改 Oris 实现，不代表用户已批准新的视觉方案。

调研日期：2026-09-22。主要版本口径为 IntelliJ IDEA 2026.2 Help 与 `intellij-community` 提交 `ecd958f56e9b2e987e5bd43f5cdd566b7030a301`。2022 官方博客截图仅作跨版本外观旁证。

## 先给结论

1. JetBrains 原生连接带确实是曲线填充带。它不是按“块中心”画一根 S 线，而是取左右 change 的**顶部和底部屏幕 Y 边界**，分别画水平切线的三次 Bézier，再闭合填充。控制点位于分隔栏宽度的 30% 和 70%；这是当前源码事实，不建议把 30% 当作 Oris 必须复制的产品常量。
2. **细长 S 带在原生实现中可以真实发生**：当同一个 change 的左右屏幕 Y 区间相距很远，且没有通过“Align Changes”补白消除差值时，源码没有斜率或纵向跨度上限，曲线会跨完整距离。它不是正常情况下应主动追求的装饰效果。
3. 开启 **Align Changes in Side-by-Side Diff** 后，JetBrains 会按视觉行高度（包括软换行）在较短一侧插入块级补白，使每个 change 的前缀与块体边界重新对齐；此时由软换行单独造成的约 200 px 长 S 带不应保留。仅开启 **Synchronize Scrolling** 不等于补白对齐。
4. 纯新增/纯删除的零行侧是零高度锚点，绘制时退化为约一像素边界；官方 2026.2 截图直接展示了灰色删除带收束到右侧一点、绿色新增带从左侧一点展开。Oris 当前把所有边至少强制成 2 px，并用某一实际行块代替空范围，语义不一致。
5. JetBrains 的 divider 是可拖拽 splitter，宽度来自缩放后的 Registry 配置且会为操作按钮扩宽；连接曲线始终使用 divider 的实时宽度。因此不应复制一个声称“JetBrains 固定为 N px”的常量。
6. 官方源码自己把“对齐模型”标为 WIP，并列出相邻 split changes、镜像 inlay 等已知问题；公开 issue 也表明软换行/窄窗仍有边缘缺陷。目标应是复刻已确认规则，不应承诺所有极端场景逐像素一致。

## 证据等级

- **V（官方视觉观察）**：直接观察 JetBrains 官方发布的产品截图。
- **D（官方文档）**：JetBrains Help 对功能/设置的明文描述。
- **S（官方源码推导）**：Apache-2.0 的 `intellij-community` 当前固定提交；可证明机制，但不是本机产品实测。
- **U（尚不确定）**：缺少直接视觉证据，或 JetBrains 版本/主题可能改变外观。

本机未发现可安全复用的 JetBrains IDE，故没有本地真实 UI 观察。用户提供的 Oris 期望图只用于确认 Oris 已接受的方向，**不计入 V 证据**。

## 紧凑场景矩阵

| 场景 | 原生长什么样 | 行对齐与连接几何 | 交互/状态 | 证据 | 仍不确定 |
|---|---|---|---|---|---|
| 等长单行替换、词级高亮 | 整行蓝色浅底；改动词/字符有更强的内联高亮；等高且同 Y 时连接带近似矩形 | change 的上下边各是一条 Bézier；端点为左右实际可见块上下边界 | 高亮粒度可选 Words / Lines / Characters / None | D：Help “Highlighting Differences”；V：2022 官方截图的一行替换；S：`DiffDrawUtil.makeCurve` | 主题色具体 RGB 会随配色方案变化 |
| 等长多行替换 | 每个 diff change 一条连续蓝带；若“Split changes”拆分，则相邻 change 各自绘制 | 同高同位时近矩形；相邻 change 不自动合并为一个 path | 可切换 Split changes | D；S：`SimpleDiffModel` 遍历 presentation，每项独立 `drawDivider` | 相邻带之间在不同 DPI 下是否肉眼留缝未做实机测量 |
| 不等长替换 | 蓝色块两侧高度不同，连接带上下边分别过渡；不会按中心线单独连一根线 | 未对齐时可形成梯形/曲线带；对齐模式会给短侧补白，使块体高度相等 | Align Changes 是独立开关 | D：补 empty space；S：`AlignedDiffModel.updateInlayHeights` | 默认是否开启随 IDE/place/settings 变化，不应硬编码推断 |
| 纯新增 | 一侧零行锚点，另一侧绿色块；官方图显示从一点展开成绿色楔形 | `start == end` 的零范围变成同一 Y；绘制前调整为约 1 px 边界，不借用邻近整行高度 | 对齐模式可把新增色补白延伸到另一侧 | V：2026.2 官方深色图；S：`getGutterMarkerPaintRange`、`DividerPolygon.paint/withAlignedHeight` | 顶/尾文件的 1 px 偏移是实现细节，不建议复制为产品常量 |
| 纯删除 | 左侧灰色删除块收束到右侧零行锚点 | 与纯新增镜像；折叠时 inserted/deleted 的 divider 类型会转为 modified 色 | 同上 | V：2026.2 官方图；S | 不同主题里“灰色”的明度不固定 |
| 折叠未变上下文 | 两侧共同出现折叠占位/展开入口；保留可配置上下文行 | 折叠改变逻辑行到屏幕 Y 的映射；divider 用折叠后的 marker range 重算 | Collapse Unchanged Fragments；上下文行数可配；一侧展开状态同步到配对侧 | D：Help；S：`FoldingModelSupport` 配对 fold region，同步 `setExpanded`；S：divider 的 folded range 分支 | 2026.2 官方主截图未展示占位文案；文案/图标不作结论 |
| 自动换行关闭 | 长行横向滚动；逻辑行通常一行高 | 端点仍由逻辑行对应的屏幕 Y 计算 | 可单独切换 Soft-Wrap | D | 两侧横向滚动是否在所有 place 默认同步未做实机验证 |
| 自动换行开启、等宽两栏 | 一条逻辑行可占多个视觉行；内联高亮跟随文本 | marker 的结束 Y 使用行尾 visual position，因此包括软换行高度 | resize 后重新软换行 | D：soft wrap 随窗口；S：`lineToY` 使用 visual position | 个别版本有软换行定位 bug，不能据源码承诺无缺陷 |
| 自动换行、左右不同比例、17 px、大字号/窄窗 | 窄侧更易产生更多视觉行；关闭 Align 时同一 change 可明显错高 | **Align 开**：按视觉行像素高度补白并在软换行重算结束后 realign；**Align 关**：连接带保留真实错高，可成长 S | 手动拖分栏/窗口 resize 都会导致重排 | D + S；公开 YouTrack IJPL-208139 旁证极端窄宽仍可能错位 | 无 17 px 特定版本实机截图；不能声称 17 px 下逐像素无误 |
| 同步滚动开启 | 滚动一侧会映射另一侧对应位置 | 映射先把主侧 visual line 转 logical line，再经 diff range 转到另一侧 visual line；不是简单复用 scrollTop | Synchronize Scrolling 独立开关；Align 模式会强制同步垂直滚动 | D；S：`SyncScrollSupport.transferVisualLine`、`SimpleDiffViewer.forceSyncVerticalScroll` | 无官方视频逐帧确认惯性/动画细节 |
| 独立滚动/同步关闭 | 两侧可保持自己的 line-anchored 位置，连接带随当前 viewport 倾斜 | divider 端点减各自 scroll offset；同一块可出现大跨度曲线 | 源码注释明确两侧可独立滚动 | S：`SimpleDiffViewer.runPreservingScrollingPosition`、`getEditorTopOffset` | Help 未直接描述“独立滚动后的带形” |
| hunk 部分滚出屏幕 | 可见部分继续显示，到 divider 视口边界被裁掉，不应把端点钉到视口边缘再重画 | 源码按可见逻辑区间筛选可能相交的 polygon，然后由 Graphics clip 裁切；端点仍是文档坐标减 scroll offset | 滚动触发 repaint | S：`createVisiblePolygons`、`getDividerGraphics`、`getEditorTopOffset` | 缺少官方视频直接展示裁剪瞬间 |
| 窗口 resize / 手动分栏比例 | 两侧宽度变化、软换行重算；中央 divider 与曲线共存并可横向拖动 | splitter 的实时 divider width 作为曲线宽度；控制点按宽度比例取值，所以曲线横向比例随宽度保持 | W-resize cursor；JBSplitter 拖拽；按钮可能扩大 divider | S：`DiffSplitter`、`DiffDrawUtil`；V：官方图显示中央 gutter 与操作按钮 | Registry 默认宽度未作为稳定 API，不报告具体像素 |
| 相邻变化块 | 每个 change 保留自身颜色/块边界；可视觉相接但不是一个共享 path | 逐 change 独立闭合填充，绘制顺序按 presentation | Split changes 会影响 change 划分 | D + S | 同点同优先级 inlay 是源码注明的 WIP 问题 |
| 大跨度变化 | 蓝/绿/灰带可跨较大纵向差，曲线两端水平、中央过渡最快 | 无纵向跨度 clamp；高斜率填充后另画至少 1 px 的中心曲线以免薄带消失 | 与滚动/对齐开关共同决定是否出现 | S：`drawCurveTrapezium` 注释与 `makeCurve` | “多长开始难看”是产品取舍，不是 JetBrains 常量 |
| 颜色与编辑器高亮连续性 | divider 填充使用 change 类型颜色；编辑器块与 divider 语义同色，但透明度/具体色取决于 scheme | 默认 painter 无边线；resolved/excluded 等特殊状态可改为边线/点线 | 普通 diff 不应凭空加高对比描边 | V + S：`DefaultPainter`、`TextDiffType.getColor` | Oris 是否保留当前描边需用户取舍 |

## 长 S 带：准确回答

**会发生，但有条件。** 官方源码对任意 `(leftTop,leftBottom)` 到 `(rightTop,rightBottom)` 直接构造曲线，没有最大 `Δy`、斜率限制或“过长则改直线”的分支。因此以下情况会产生真实的长 S / 长斜带：

- Align Changes 关闭，左右 change 前面累计了不同的折叠、软换行或独立滚动偏移；
- 同一 change 左右自身视觉高度差很大；
- 同步滚动映射处在大范围 change 内部，而两侧视觉行数不同；
- 一侧是大段新增/删除、另一侧是零行锚点——此时更准确叫长楔形，而不是细 S。

**不应发生的目标状态**：如果 Oris 对外呈现的是“自动换行 + 对齐变更”语义，那么仅由窄侧比宽侧多出若干软换行导致的 200 px 细长 S，应该被视觉行补白消除。若产品不提供 Align 开关，则必须明确选择：默认补白对齐，或接受真实错高带；不能同时宣称“JetBrains 对齐模式”又保留长 S。

官方 2026.2 截图确实显示大跨度楔形/曲线带，但那是新增/删除和不等高变更的合理结果，不能拿它证明“软换行错高 200 px 也自然”。

## Oris 当前差异：具体诊断假设

以下只基于 `src/DiffViewer.tsx` 与 `src/styles.css` 的必要片段和用户截图，尚未运行 Oris，本节均标为假设。

### H1（高置信）：空范围锚点被错误扩成了一整行

当前对每个 chunk 都调用 `lineBlockAt(...)`，即使 `fromA == toA` 或 `fromB == toB`，也会落到某个真实行块；随后又以 `Math.max(top + 2, bottom)` 强制最小高度。这会把 JetBrains 的零行锚点语义变成“邻近整行高”，纯增删带形必然偏胖或端点位置不自然。

### H2（高置信）：有软换行重测，但没有 JetBrains 式视觉行补白对齐模型

当前 connector 使用 CodeMirror 行块的 top/bottom，`ResizeObserver` 和 DOM mutation 能触发重画，所以它能**测到**左右高度差；但所读片段没有发现按每个 change 的 prefix/body visual height 差插入补白的模型。它只是忠实画出错高，因而窄侧多换行会直接变成长 S。

### H3（中置信）：Oris 把 curve 叠在整套 merge root 上，裁剪/滚动坐标契约不够明确

SVG 高度取 `merge.dom.scrollHeight`，路径 Y 来自编辑器 line block 的局部坐标，监听了三个滚动源，但计算时没有显式减去两个 pane 各自的 `scrollTop`。如果 CodeMirror 的 DOM/scroll 容器在不同布局状态下坐标系变化，可能出现“线块看似对、连接带偏移”。需用 DOM 几何断言确认，不能只看截图。

### H4（已部分修复方向）：分栏比例已从固定像素转为 ratio，但中央宽度仍是 Oris 自己的 56 px

当前 `ResizeObserver` 以保存的 ratio 重算左宽，方向正确；header 和 body 也共享 CSS 变量，能避免原先 resize 漂移。但 56 px 不是已证实的 JetBrains 常量。JetBrains 是 registry + UI scale + 操作按钮约束；Oris 可保留自主宽度，但不应称“原生像素一致”。

### H5（中置信）：曲线控制点 45% 比 JetBrains 当前源码的 30% 更容易形成窄腰/细 S 观感

Oris 使用 gap 的 45% / 55%，JetBrains 当前源码为 30% / 70%。在大 `Δy` 下，45% 会让上下边更久保持水平、在中部更急剧转向，视觉上更像细长 S。把 45% 改成 30% 可以更接近当前源码，但它只能改善曲率，**不能修复错误锚点或缺少视觉行补白**。

## 建议的最小实现规则

按优先级排序：

1. **先修锚点语义**：change 保存左右半开逻辑范围 `[from,to)`；空范围 `from == to` 映射为该逻辑边界的零高度 Y，不调用邻近整行块充当高度。绘制层只为抗锯齿给零高度边界最小可见像素，不改变数据端点。
2. **明确并实现 Align 语义**：若默认采用 JetBrains 已确认方向，按每个 change 分别计算：
   - 前一 change 末端到本 change 起点的左右视觉像素高度差，在短侧 change 顶部前插补白；
   - 本 change 左右视觉像素高度差，在短侧 change 底部后插补白；
   - soft-wrap/font/分栏/折叠/inlay 高度变化后统一重算；
   - 对齐开时强制同步垂直滚动。
3. **连接带只消费布局结果**：端点取两侧实际 change paint range 的 top/bottom，减各自 viewport scroll offset，加统一 header offset；不要自行猜测 `lineBlockAt(to - 1)`。
4. **曲线使用宽度归一化控制点**：可先采用当前 JetBrains 源码的 0.3/0.7 作为行为参考，但把比例做成内部常量并通过形状断言验证，不承诺产品 API。
5. **正确裁剪**：保留文档坐标端点，先判断 polygon 是否可能与 divider viewport 相交，再由 divider clip 裁切；不要把滚出屏幕的端点 clamp 到顶部/底部。
6. **分栏保持比例**：窗口 resize 保留用户比例；header、左右 pane、divider 使用同一布局源。divider 宽度可由 Oris 视觉系统决定，不必追 JetBrains Registry。
7. **颜色连续但避免重复描边**：普通 change 使用与编辑器块同语义的半透明填充；默认不需要高对比 stroke。若保留边线，应作为 Oris 自主选择，并单独验收深浅色。

## 可测验收条件

这些条件比“看起来像 JetBrains”更可执行：

1. **零行锚点**：纯新增 3 行时，左端数据范围 `top == bottom`；纯删除镜像成立。不得读取邻近行的 bottom 作为空侧高度。
2. **等高替换**：左右同 Y、同视觉高度时，连接带上下边在采样误差内水平；中线厚度不低于 1 device pixel。
3. **不等高替换、Align 关**：四个端点分别严格等于两侧 paint range；允许曲线倾斜，不做任意 `Δy` clamp。
4. **软换行、Align 开**：在 17 px、窗口窄宽、左右 30/70 和 70/30 比例下，同一 change 的渲染后 top 与 bottom 两侧分别对齐（容差 ≤ 1 CSS px 或 1 device pixel，取更大者）；不存在由该 change 自身换行差造成的约 200 px S 带。
5. **重排原子性**：拖动 splitter、窗口 resize、切换 wrap、字号变化后，在一帧稳定布局内同时更新 pane、header、补白和 connector；不出现连接带先跳、文本后一帧跟随的持久状态。
6. **滚动裁剪**：hunk 顶部滚出 20 px 时，离屏真实端点仍为负 Y，SVG clip 只显示剩余部分；不得改写为 `y=0` 的新锚点。
7. **独立滚动**：Align/同步均关闭后分别滚动左右 pane，connector 端点随各自 scroll offset 精确移动；重开同步时按 change 映射恢复，不直接复制 scrollTop。
8. **折叠配对**：折叠/展开同一 unchanged block 后两侧状态一致，connector 在 fold 完成后重算；折叠占位高度计入 visual Y。
9. **相邻块**：两个相邻 change 产生两个可识别 path，类型色不串块，任一 path 的端点只来自自己的 range。
10. **属性测试**：任意 divider 宽度 `w > 0`，控制点始终处于 `[0,w]`；resize 前后控制点横向比例不变；path 闭合且无 NaN/Infinity。

## 哪些是直接修复，哪些要用户取舍

### 已确认方向下可直接修复

- 空范围必须是零行锚点，不能冒充整行；
- pane/header/connector 使用同一实时分栏几何，resize 保持用户比例；
- connector 端点来自实际渲染 paint range，并随 wrap/font/fold/scroll 重算；
- 滚出视口靠裁剪，不改写端点；
- 曲线控制点按 divider 实时宽度归一化；
- 用户当前选择“对齐变更”时，软换行差必须通过视觉行补白处理，而不是保留长 S。

### 需要用户取舍

- Oris 是否把 Align Changes 做成可切换设置，还是始终开启；
- Align 关闭时是否接受原生机制允许的长 S，或做 Oris 自己的降级（例如极端跨度改为断裂提示）；后者就不再是 JetBrains 行为；
- divider 的自主宽度、是否保留描边、颜色透明度；这些没有稳定的原生像素常量；
- 窄到无法舒适双栏时，是继续双栏、自动统一视图，还是提示用户切换；JetBrains 资料不足以替 Oris 作产品决定。

## 来源

### JetBrains 官方文档与素材

- [Diff Viewer for files（IntelliJ IDEA 2026.2 Help）](https://www.jetbrains.com/help/idea/differences-viewer.html)：颜色语义、折叠未变片段、Align Changes、Synchronize Scrolling、Soft-Wrap、高亮粒度。
- [2026.2 官方深色 Diff 截图](https://resources.jetbrains.com/help/img/idea/2026.2/ij_compareFiles_dark.png)：直接观察修改带、纯新增楔形、纯删除楔形、相邻变化块和中央 gutter。
- [Compare files, folders, and text sources](https://www.jetbrains.com/help/idea/comparing-files-and-folders.html)：双栏 viewer 与颜色语义。
- [Beyond Comparison（JetBrains Blog, 2022-06）](https://blog.jetbrains.com/idea/2022/06/compare-anything-in-intellij-idea/) 及其[官方截图](https://blog.jetbrains.com/wp-content/uploads/2022/06/compare-files.png)：旧版单行词级替换的视觉旁证。
- [IJPL-208139](https://youtrack.jetbrains.com/projects/IJPL/issues/IJPL-208139/Make-diff-view-usable-with-files-without-line-breaks)：公开 issue，说明 2025.2.1 下软换行、同步滚动与极窄宽仍有边缘问题；这是用户报告，不当作规范。

### JetBrains 官方公开源码（固定提交）

- [`DiffDividerDrawUtil.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/util/DiffDividerDrawUtil.java)：change range → divider polygon、可见范围、折叠、零行边界、对齐模式高度修正。
- [`DiffDrawUtil.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/util/DiffDrawUtil.java)：0.3/0.7 控制点、闭合曲线填充、高斜率至少 1 px、visual position → Y。
- [`AlignedDiffModel.kt`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/AlignedDiffModel.kt)：按前缀/块体视觉像素差插补白、监听 soft wrap、已知 WIP 边界。
- [`SyncScrollSupport.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/SyncScrollSupport.java)：visual/logical line 映射与同步滚动。
- [`FoldingModelSupport.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/FoldingModelSupport.java)：未变区域的配对 fold region、折叠状态与展开同步。
- [`SimpleDiffViewer.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/SimpleDiffViewer.java)：Align 与 sync 的关系、独立滚动边界、divider repaint。
- [`DiffSplitter.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/DiffSplitter.java)：divider 实时宽度、W-resize cursor、按钮宽度约束。
- [`SimpleDiffModel.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/SimpleDiffModel.java) 与 [`SimpleDiffChangeUi.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/SimpleDiffChangeUi.java)：每个 change 独立绘制，以及 Align 开关选择不同 painter。

证据入口另见 [`jetbrains-diff-evidence/README.md`](jetbrains-diff-evidence/README.md)。
