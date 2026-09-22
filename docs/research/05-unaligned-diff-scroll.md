# Align 关闭后的双侧滚动与差异概览标记研究

> 研究快照：2026-09-22。本文只提出证据、行为契约、技术方案与验收矩阵，不批准实现、不拆票。业务代码在研究期间存在并行修改，因此涉及 Oris 的行号只代表本轮读取快照。

## 1. 结论先行

1. **当前 Align 关闭后仍出现大块空白的直接原因已确认。** Oris 只在 `alignChanges === true` 时安装自己的 `AlignmentSpacer`，但 split 模式无论开关状态都创建 CodeMirror `MergeView`。已安装的 `@codemirror/merge@6.12.2` 会无条件安装私有 `Spacers` 状态字段，并在每次测量中调用 `updateSpacers`，以补白方式垂直对齐未变化区域。因此，Align 关闭只关掉了 Oris 的第二层补白，没有关掉 CodeMirror 内建补白。
2. **`MergeView` 没有受支持的“关闭内建对齐”配置。** `DirectMergeConfig` 不暴露该选项；用 CSS 隐藏 `.cm-mergeSpacer` 或触碰私有 `Spacers`，会让内部高度、viewport 和末尾补白计算继续按“存在 spacer”运行，不能作为稳定方案。
3. **推荐结构是两个独立 `EditorView`，而不是继续把 split 托管给 `MergeView`。** 两侧拥有各自的 `scrollDOM`，中央连接带由同一份 diff chunk 数据绘制；Align 关闭时不插任何 diff 补白，Align 开启时由 Oris 自己插补白。这样切换开关不会切换滚动容器模型。
4. **JetBrains 的同步滚动不是固定比例，也不是简单复制 `scrollTop`。** 它用每个 change 的左右起止行组成单调边界表，在约视口高度 `1/3` 的锚点上做分段映射；段内按 1:1 视觉行推进并在目标段末端截停，端点精确对齐。`0:N`、`M:N` 等不等长区域因此会出现“停住”或“跨端点跳转”，这是信息守恒的必然取舍，不是 bug。
5. **两侧滚动条应各自位于比较区最外缘。** JetBrains 源码明确把左编辑器滚动条方向设为 `LEFT`，右侧保持默认 `RIGHT`。官方截图也显示左右各自的差异色标位于各自外缘的 editor error stripe/scrollbar 区域。
6. **差异色标是文档概览，不是加载进度。** 推荐按各侧自己的半开逻辑行范围映射到轨道总高度；纯新增/删除在空侧保持零长度语义，仅绘制最小可见刻度。软换行、字体和窗口宽度改变滚动 thumb，却不应让全局差异色标在轨道上漂移。

## 2. 证据等级与范围

| 标记 | 含义 |
|---|---|
| D | JetBrains 官方帮助或 CodeMirror 官方 API 文档直接陈述 |
| S | 固定到源码提交或本地已安装发布物的源码推导 |
| V | 官方截图可直接观察 |
| H | 对当前 Oris 快照的源码诊断 |
| R | 本文给 Oris 的产品/工程建议，不宣称是 JetBrains 内部实现 |
| U | 尚未确认，不能写成既定事实 |

用户提供的期望截图来源未知，只用来说明目标外观：两侧内容自然错高、没有大段差异补白、两条外缘概览轨道。它不作为 JetBrains 官方证据。

## 3. 为什么 Align 关闭仍有占位

### 3.1 Oris 当前调用链（H，高置信）

- `App.tsx` 的 `alignChanges` 默认值为 `false`，工具栏可切换。
- `DiffViewer.tsx` 在 split 模式始终 `new MergeView(...)`。
- Oris 自定义 `installChangeAlignment(split)` 只在 `alignChanges` 为真时安装。
- split 导航滚动的是 `current.split.dom`，不是某一侧的 `scrollDOM`。
- CSS 给 `.cm-mergeView` 设置 `overflow:auto`。CodeMirror 的 merge 基础主题又把内部 `.cm-scroller` 强制为 `height:auto; overflow-y:visible`，最终形成一个外层共享垂直滚动容器。

因此当前结构实际上是：

```text
.cm-mergeView  ← 唯一垂直滚动容器
└─ .cm-mergeViewEditors
   ├─ Editor A（内部 scroller 不独立垂直滚动）
   ├─ 中央 gutter
   └─ Editor B（内部 scroller 不独立垂直滚动）
```

### 3.2 CodeMirror 6.12.2 的内建行为（S + D，高置信）

本地发布物注释直接把 `MergeView` 定义为“并排管理两个编辑器，并垂直对齐未变化行”。构造函数无条件把私有 `Spacers` 字段和测量监听器加入两侧；`updateSpacers` 在每个未变化区边界比较两侧 `lineBlockAt(...).top`，向较短一侧插入 `.cm-mergeSpacer`，并在文档末尾补齐总高度。超长未变化区还会在 viewport 顶部增加同步点。

`DirectMergeConfig` 的公开类型中没有 align/spacer 开关。CodeMirror 作者也在官方讨论区明确说明，CM6 不再支持旧版那种“不补白、靠滚动补偿”的 merge 模式。

### 3.3 不接受的“快速修补”

| 方案 | 为什么不能作为产品方案 |
|---|---|
| `.cm-mergeSpacer { display:none }` | 只隐藏 DOM；内部仍以 spacer 高度计算 `offA/offB`、末尾高度和 viewport 对齐，容易造成位置、虚拟化和连接带坐标互相矛盾 |
| 访问 bundle 内私有 `Spacers` / `adjustSpacers` | 未导出、未声明为 API；升级或打包优化即可失效 |
| Align 关闭时只清空 Oris 自定义 StateField | 当前已经如此；CodeMirror 自带 spacer 不受影响 |
| 让两个 pane 都监听 scroll，但仍滚动 `.cm-mergeView` | 监听目标不等于拥有独立滚动状态，无法形成左右两个 master/slave 容器 |

## 4. 可选架构与推荐

### A. 两个独立 EditorView（推荐）

用公开的 diff chunk 数据构建两侧装饰、gutter 和中央连接带；每侧是独立 `EditorView`，外层 diff body 自身不垂直滚动。

```text
固定工具栏 / 文件端点栏（不参与滚动）
┌──────┬────────────────┬────────┬────────────────┬──────┐
│左轨道│ Left EditorView│ divider│Right EditorView│右轨道│
│ master/slave scrollDOM│        │ master/slave scrollDOM│
└──────┴────────────────┴────────┴────────────────┴──────┘
固定状态栏（不参与滚动）
```

优点：公开 API；真正无 spacer；两侧可独立测量；滚动同步、外缘滚动条和色标都能建立明确契约；Align 开关只控制 Oris spacer，不改变容器所有权。代价是需要把当前依赖 `MergeView` 私有布局获得的 split 高亮/gutter 能力迁移到公开 `EditorView` decorations/gutters，或复用 Oris 已有的 backend change 数据。

### B. 维护 `@codemirror/merge` fork/patch

给 `MergeView` 增加受测试的 `alignChanges` 配置，关闭时不安装/更新 `Spacers`，并恢复两侧独立 scroller。它可以复用更多 upstream UI，但需要长期跟进已迁移仓库的变更和安全修复；仅“跳过 spacer”仍不足以得到双独立滚动条，因为原主题和外层容器契约也要改。

### C. 私有 DOM/CSS hack（拒绝）

维护成本表面最低，实际无法为测量、虚拟化、折叠、软换行和升级建立稳定断言。只适合一次性实验，不应进入产品路径。

## 5. JetBrains 双侧同步滚动的精确行为

### 5.1 边界表

JetBrains `SimpleDiffViewer.MySyncScrollable` 生成如下单调边界对：

```text
(0, 0)
(change1.leftStart, change1.rightStart)
(change1.leftEnd,   change1.rightEnd)
...
(leftLineCount, rightLineCount)
```

其基础契约要求边界不交叉，第一项和最后一项分别覆盖文档首尾。滚动事件来自哪一侧，哪一侧就是本次 master，映射方向随之反转。

### 5.2 分段传递函数

设包含 master 行 `x` 的边界段为 `[s1,e1] -> [s2,e2]`，JetBrains 的核心语义可写为：

```text
x == s1  => s2
x == e1  => e2
x 处于段内 => min(s2 + (x - s1), e2)
x 超过最后边界 => 保留尾部相对距离
```

这不是 `x / masterTotal * slaveTotal`，也不是段内按长度比例缩放。它优先保留 1:1 的视觉行推进与精确端点。同步过程使用视口高度约 `1/3` 处作为锚点，并保留当前视觉行内部的像素相位；当相邻 source visual row 都映射到同一个 target row 时，会抑制无意义的微小移动。

### 5.3 不等长区域的可观察结果

| 区域 | master 行为 | slave 行为 |
|---|---|---|
| `N:N` | 正常连续滚动 | 近似 1:1 连续跟随 |
| `M:N` 且 `M>N` | 长侧继续走 | 短侧到段末后停住，master 到端点时两侧端点精确对齐 |
| `M:N` 且 `M<N` | 短侧继续走 | 长侧先 1:1，master 抵达端点时跳到目标端点 |
| `0:N`，N 侧为 master | 插入内容连续滚动 | 空侧保持在同一边界锚点 |
| `0:N`，0 侧为 master | 空侧没有区域内部可滚动距离 | 跨过边界时长侧从 hunk 起点跳到 hunk 终点 |
| 整文件 `0:N` | 空文档没有有效 master visual line | 长侧主动滚动时空侧固定；不能要求空侧反向产生连续控制量 |

这里存在一个不可消除的约束：对 `0:N`，无法同时满足“空侧滚动连续”“非空侧遍历完整 N 行”“两端精确对齐”。推荐直接采用 JetBrains 的停住/跳转语义，不再发明比例滚动。

### 5.4 事件归属与防反馈

JetBrains 在同步写入目标编辑器时进入 `isDuringSyncScroll` guard，目标侧产生的 visible-area 事件不会反向触发第二轮同步。Oris 在 Web/Electron 中不能只用同步函数栈内布尔值，因为设置 `scrollTop` 后的 `scroll` 事件可能异步到来。推荐：

1. `wheel`、触摸/指针、键盘滚动、轨道按下和 thumb drag 显式记录用户拥有的 `masterSide`。
2. 原生 `scroll` 事件按 `requestAnimationFrame` 合并；同一帧只读一次布局缓存，只写一次 slave `scrollTop`。
3. 每次程序性写入记录 `{epoch, targetSide, expectedScrollTop}`；目标 scroll 事件与期望值在容差内匹配时只消费 token，不反向同步。token 至少保留到事件到达或下一次 rAF，而不是函数返回即清除。
4. 两侧快速交替输入时，最新真实用户输入获胜；不得让上一次 slave 写入抢回 master。
5. `NextHunk`/色标点击属于程序导航：一次性计算并写入左右目标 offset，置于同一 guard/epoch 下，不再让通用 listener 二次修正。V1 可不做滚动动画，以避免动画中间帧的锚点插值复杂度。

## 6. 在 CodeMirror 公开 API 上实现映射

### 6.1 必须来自 Core 的数据契约

renderer 不应从字符偏移和 DOM 反推 diff 结构。每个 hunk 至少提供：

```ts
type SideRange = { startLine: number; endLine: number }; // 0-based, half-open, 可相等
type DiffHunk = { id: string; left: SideRange; right: SideRange; kind: "insert" | "delete" | "modify" };
```

并满足：稳定顺序、单调不交叉、零行范围合法、首尾 sentinel 可构造。字符级范围只负责 inline highlight，不负责滚动映射。

### 6.2 视觉像素映射

CodeMirror 公开 `EditorView` 提供 `scrollDOM`、`contentHeight`、`documentPadding`、`lineBlockAt`、`lineBlockAtHeight`、`defaultLineHeight` 和 `requestMeasure`。推荐在测量阶段缓存每个 diff 边界的视觉 Y：

- 逻辑行起点 -> 对应 `lineBlockAt(pos).top + documentPadding.top`；
- 文档尾边界 -> 最后一块 `bottom + documentPadding.top`；
- 折叠/软换行使 block 高度改变时，在 `requestMeasure` read phase 重建；
- 字体、wrap、pane 宽度、窗口 resize、折叠状态、文档/chunk 变化都使缓存失效；
- 原始 scroll handler 不读取 DOM 几何。

对 source 视口取 `anchorY = clientHeight / 3`，将 `scrollTop + anchorY` 定位到相邻 source 边界段。段内采用与 JetBrains 同义的“1:1 像素/视觉行推进，目标段末截停，端点精确跳转”，再令：

```text
targetScrollTop = clamp(mappedDocumentY - anchorY + intraRowPhase,
                        0,
                        target.scrollHeight - target.clientHeight)
```

CodeMirror 没有公开“全局 visual-line index”数组；直接使用已测量边界 Y 是可行的等价工程模型，但必须通过软换行、折叠和离屏长文档 fixture 验证，不能假定 `posAtCoords` 能对所有离屏位置工作。

## 7. 两侧外缘滚动条与差异概览标记

### 7.1 JetBrains 已确认事实

- `TwosideTextDiffViewer.createEditorHolders` 把左 editor 的 vertical scrollbar orientation 设为 `LEFT`；右侧保持默认 `RIGHT`。（S）
- `DiffDrawUtil.LineHighlighterBuilder` 为每侧差异创建单独的 error-stripe highlighter；颜色取对应 `TextDiffType` 的 marker color。空行范围也保留边界 marker。（S）
- 官方 2026.2 截图可见两侧最外缘滚动区域中的彩色差异标记。（V）
- JetBrains 通用 error-stripe 在极端密集、同像素碰撞时的最终混色/覆盖顺序，本轮未固定到稳定公开契约；不要复制一个未经证实的优先级并称作 JetBrains 行为。（U）

### 7.2 Oris 三种外缘轨道实现

| 方案 | 优点 | 风险 | 结论 |
|---|---|---|---|
| 两个原生 scrollbar，均保持浏览器默认右侧 | 无障碍与输入成本最低 | 左侧不在比较区最外缘，不满足明确目标 | 不采用 |
| 左 scroller 用 `direction:rtl` 搬移原生 scrollbar，内容恢复 `ltr` | 改动小，仍由浏览器提供 thumb | Electron/Chromium、文本选择、gutter、横向滚动和输入法行为需逐项验证，跨平台不稳 | 可做短期 spike，不作为无验证结论 |
| 自定义两条外缘 rail + 隐藏原生 scrollbar 视觉 | 布局、thumb、差异 marker、点击命中完全可控 | 必须自己完成 ARIA、键盘、pointer capture、高 DPI、最小 thumb；wheel/touch 仍应作用于真实 `scrollDOM` | 若“左最外缘”是硬需求，推荐 |

自定义 rail 不是另建滚动状态：真实 source of truth 仍是每侧 `scrollDOM.scrollTop/scrollHeight/clientHeight`，rail 只是可视化和输入代理。

### 7.3 Thumb 几何

设轨道有效高度为 `T`，内容高度 `S`，viewport 高度 `C`，滚动位置 `p`：

```text
thumbHeight = max(minThumb, T * C / S)
thumbTop    = (T - thumbHeight) * p / max(1, S - C)
```

当 `S <= C` 时 thumb 占满轨道且不可拖动。拖动时由该侧成为 master，反算 `scrollTop` 后进入同一同步映射。rail 需实现 `role="scrollbar"`、`aria-controls`、`aria-valuemin/max/now`、键盘 Home/End/PageUp/PageDown/方向键，并用 pointer capture 保证拖出轨道仍连续。

### 7.4 差异色标映射（R，推荐的 Oris 契约）

色标表达“此侧文档哪里有差异”，因此用此侧自己的半开逻辑行范围，而不是另一侧长度，也不是当前 wrap 后像素高度：

```text
denominator = max(1, sideLogicalLineCount)
startRatio  = startLine / denominator
endRatio    = endLine   / denominator
markerTop   = trackTop + startRatio * markerTrackHeight
markerEnd   = trackTop + endRatio   * markerTrackHeight
markerHeight = max(minMarkerDevicePixels, markerEnd - markerTop)
```

行为含义：

- 左删除只在左轨道覆盖被删范围；右空侧在对应边界画最小删除刻度。
- 右新增只在右轨道覆盖新增范围；左空侧画最小新增刻度。
- 修改各按本侧实际范围绘制，左右高度可以不同。
- 空文件用分母 1 避免除零；唯一的零范围变化在 0 或 1 的边界画最小刻度。
- 软换行、字号、pane resize 不改变色标的全局逻辑位置；它们只改变 thumb，因为实际视觉内容高度变化。
- 折叠未变化区同样不移动逻辑色标；thumb 因可滚动视觉高度变化。若未来产品明确要求“色标对应折叠后视觉位置”，那是另一套模式，不能静默切换。
- 最小 marker 以 device pixel 定义并折算 CSS px，避免高 DPI 下消失；不把零范围伪装成相邻整行。

同一像素桶中的密集标记建议只合并“同类型且相邻”的区间；不同类型不宣称按 JetBrains 未确认优先级混色。可按稳定 hunk 顺序绘制，并让当前/选中 hunk 另加描边或独立指示器，而不是改变其语义色。色标点击导航到该 hunk；空白轨道点击按 scrollbar 习惯 page/seek；两者命中区必须可区分。

## 8. Align 开关与连接带的统一契约

### Align 关闭

- 不存在 diff 生成的 spacer；两侧内容高度只由各自文本、软换行、折叠和编辑器 padding 决定。
- 每侧独立滚动；开启同步时按第 5 节映射，关闭同步时互不写入。
- 中央 connector 的四个端点分别使用各侧当前 viewport 坐标，允许长 S/楔形；只裁剪，不把离屏端点钉到视口边缘。
- `0:N` 空侧端点为一条最小边界，不借用邻近整行。

### Align 开启

- 仍是相同的两个 `EditorView` 和两个 `scrollDOM`。
- Oris 按每个 hunk 的前缀/块体视觉高度向短侧插自有 spacer；同一 hunk 上下边界在像素容差内对齐。
- 垂直同步强制开启或表现为近似恒等映射；关闭 Align 后立即移除自有 spacer 并重新测量，不残留累计高度。

用同一容器模型支持两种模式，比 Align 切换时在 `MergeView` 与自建双 editor 之间重建更容易保持焦点、选择、scroll anchor 和无障碍关系。

## 9. 性能边界

- scroll 高频路径：rAF 合并；每帧 O(log hunk) 二分边界段；禁止扫描所有 hunks、禁止 DOM layout read/write 交错。
- marker 生成：文档/chunk 变化时 O(hunks)；按物理像素桶合并同类型区间，避免数万 DOM 节点。可用单层 canvas/SVG 或有限绝对定位节点。
- 视觉边界缓存：仅在 CodeMirror measure read phase 读取 `lineBlockAt` 等布局信息；wrap/font/width/fold/chunk 改变时失效。
- connector：只绘制与可见逻辑区间相交的 hunks；离屏真实端点可为负/超高，由 SVG/canvas clip 处理。
- 程序同步写入若与浏览器惯性滚动竞争，最新真实用户 epoch 获胜；旧 epoch 丢弃。

## 10. 场景矩阵与可自动化断言

| 场景 | 必须断言 |
|---|---|
| `N:N` 单行/多行修改 | Align 关无 `.oris-alignment-spacer` 且无 CodeMirror merge spacer；同步时锚点连续 1:1 |
| `0:N` / `N:0` | 空侧 connector 与轨道均为边界刻度；长侧 master 时空侧固定；空侧跨边界时长侧端点跳转 |
| `M:N`，`M>N` | 短 slave 到段末停住，不按全文件比例漂移；两端精确对齐 |
| `M:N`，`M<N` | master 到段末时长 slave 抵达其端点；允许端点跳转，禁止越界 |
| 相邻 hunks / 零长度相邻 | 边界表单调；二分不会选错段；同像素色标命中稳定 |
| 超长未变化区 | 映射不依赖 viewport 内临时 DOM；快速滚动后仍落到正确边界段 |
| 整文件新增/删除、空文件 | 无除零、NaN、负 scrollTop；空侧 rail 满 thumb/不可拖；marker 仍可见 |
| 末行无换行 | 最后半开边界映射到文档视觉 bottom，不丢最后一个 hunk |
| 左右分别 wheel | 触发侧为 master；目标程序事件被 epoch 消费，无 ping-pong |
| touch/trackpad 惯性 | 每帧最多一次 slave write；惯性期间 master 不被旧目标事件夺走 |
| 两侧快速交替滚动 | 最近真实用户输入侧获胜；最终无持续振荡 |
| scrollbar thumb drag | 拖动侧显式为 master；pointer 离开 rail 仍捕获；松开后状态一致 |
| PageUp/Down、Home/End、方向键 | 焦点侧为 master；ARIA 值与实际 scrollTop 一致 |
| Next/Previous Hunk | 两侧在一个程序 epoch 内到目标；不被通用 listener 二次移动 |
| marker 点击 / 空轨道点击 | 前者选择并导航 hunk；后者 page/seek；命中区不冲突 |
| wrap 开关、左右不同宽度 | Align 关无补白；映射缓存重建；marker 逻辑位置不漂移，thumb 可变化 |
| 字体 12/17/24 px、DPR 1/1.25/2 | 边界误差不超过 `max(1 CSS px, 1 device px)`；零范围 marker 不消失 |
| 分栏拖动、窗口 resize | measure 完成后映射/connector 更新；scroll handler 中无强制同步 layout |
| 折叠未变化区展开/收起 | thumb 与视觉缓存改变；逻辑 marker 不动；目标 scrollTop clamp 正确 |
| Align 开关往返 | 关时零 diff spacer；开时 hunk 上下边界对齐；重复 10 次无累计高度 |
| 同步开关往返 | 关闭后两侧完全独立；重开时由下一次用户输入侧成为 master，不突然复制旧 scrollTop |
| 10k+ hunks | marker 节点/绘制批次受像素桶限制；scroll 帧不做 O(hunks) 扫描 |

建议自动化读取：两侧 `scrollTop/scrollHeight/clientHeight`、master epoch、当前边界段、source/target anchor Y、每个 connector 的四端点、每个 marker 的逻辑范围与轨道像素范围。截图只作视觉复核，不能替代这些数值断言。

## 11. 最小待确认产品决策

这些不是研究不确定性，而是实现前必须固定的产品契约：

1. **`0:N` 与 `M:N` 同步规则**：建议采用 JetBrains 的 1:1 + 截停/端点跳转，不采用比例缩放。
2. **左侧外缘 scrollbar 的实现质量门槛**：若“最外缘”是硬要求，建议自定义可访问 rail；`direction:rtl` 只能在 Windows/Electron 完整 fixture 通过后降级采用。
3. **marker 纵向尺度**：建议按逻辑行固定，wrap/resize/fold 不移动；若要求按折叠后视觉高度变化，必须另行明确。
4. **轨道点击语义**：建议 marker 点击导航 hunk，空白轨道点击 page/seek，拖 thumb 滚动并成为 master。
5. **同步开关**：若产品没有独立“同步滚动”开关，V1 可保持始终同步；不要为了本问题顺带新增设置。Align 开时同步必须有效。

## 12. 来源与可复核入口

### JetBrains 官方材料

- [Diff Viewer for files（IntelliJ IDEA 2026.2 Help）](https://www.jetbrains.com/help/idea/differences-viewer.html)
- [2026.2 官方深色截图](https://resources.jetbrains.com/help/img/idea/2026.2/ij_compareFiles_dark.png)
- [`SimpleDiffViewer.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/SimpleDiffViewer.java)：边界对、Align 强制同步、分段映射入口
- [`BaseSyncScrollable.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/BaseSyncScrollable.java)：单调边界契约与 `transferLine`
- [`SyncScrollSupport.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/SyncScrollSupport.java)：1/3 viewport anchor、visual/logical 转换、像素相位与反馈 guard
- [`TwosideTextDiffViewer.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/util/side/TwosideTextDiffViewer.java)：左 scrollbar orientation 为 LEFT
- [`DiffDrawUtil.java`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/util/DiffDrawUtil.java)：line highlighter、error-stripe marker、零范围边界与 marker color
- [`AlignedDiffModel.kt`](https://github.com/JetBrains/intellij-community/blob/ecd958f56e9b2e987e5bd43f5cdd566b7030a301/platform/diff-impl/src/com/intellij/diff/tools/simple/AlignedDiffModel.kt)：Align 开时视觉高度补白

JetBrains 源码统一固定到提交 `ecd958f56e9b2e987e5bd43f5cdd566b7030a301`，避免默认分支漂移。

### CodeMirror 官方材料与本地发布物

- [CodeMirror Reference Manual](https://codemirror.net/docs/ref/)：`MergeView`、`EditorView.scrollDOM`、`lineBlockAt`、`lineBlockAtHeight`、`documentPadding`、`requestMeasure`
- [Merge view align feature 讨论](https://discuss.codemirror.net/t/merge-view-align-feature/7940)：作者说明 CM6 仅保留补白对齐模式
- 本地 `node_modules/@codemirror/merge/dist/index.js`：安装包 `6.12.2`，`Spacer`、`Spacers`、`updateSpacers`、merge 基础主题和 `MergeView` 构造链
- npm tarball：`https://registry.npmjs.org/@codemirror/merge/-/merge-6.12.2.tgz`
- lockfile integrity：`sha512-V8JvyAPjHbPupqP7BeMcsdsYCbyPij74jxIbaIJDORI+VZzW44zFmon8bF+oxGWvOKhcRmkiUMXd8MxHr3YA2w==`
- 本地 `dist/index.js` SHA-256：`98F01E3A8C526B392840718807F95848621DFE6F7E4D48BD0AEF57304A6EA8DF`
- 本地 `dist/index.d.ts` SHA-256：`C3B1E3A14C6DD668CFA8615DC2EEE1427D3AF6D1B90562C3CC6EAB48DB5A8546`

截至本轮快照，原 GitHub `codemirror/merge` 仓库已归档并指向新托管地址；npm `6.12.2` 没有可安全猜测的一一对应 GitHub tag。因此复核应以 lockfile、npm tarball integrity 和本地发布物 hash 为准，不虚构 commit 对应关系。

## 13. 只读边界声明

本轮没有修改 `src/`、配置、依赖、测试或既有研究报告，没有运行 Oris 构建/测试，没有创建分支、暂存、提交或推送。新增内容仅为本报告和其证据索引。
