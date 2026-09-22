# Oris 竞品调研 R3：Diff 阅读交互与只读 Git 语义

> 查阅日期：2026-09-22（Asia/Shanghai）  
> 调研边界：本报告只提供事实、候选和取舍依据，不替用户确定规格、架构或实施拆票。Oris 的既定定位是轻量、高效率、安全、只读 Git 桌面可视化工具；不提供 merge、checkout、stage、unstage、discard、stash、commit、fetch 等改变仓库或远端状态的产品操作。

## 1. 结论先行

最值得 Oris 借鉴的不是某一个竞品的完整形态，而是一条收敛的阅读路径：**先从文件级变化总览缩小范围，再用可切换的并排/统一视图阅读当前文件，以行内高亮、差异地图、上下文折叠和连续跳转维持方向感；遇到图片、二进制、超大文件或编码/EOL 差异时，明确降级并解释原因。**

建议把“只读”做成可被用户持续感知的产品契约，而不只是删除几个按钮：所有比较页都显示左右端点；工作区、index、HEAD、父提交、任意 refs 的语义名称不可混用；ahead/behind 必须带上游名称与“本地快照”新鲜度说明。没有 fetch 就不能暗示“与服务器同步”。

下文中的标记含义：

- **[事实]**：官方资料明确支持。
- **[建议]**：基于 Oris 定位的设计候选，不是已决定需求。
- **[未验证]**：本轮官方资料不足，不能当成竞品能力或 Oris 需求。

## 2. 竞品阅读交互事实

### 2.1 Beyond Compare 5

- **[事实]** 文本比较以双编辑窗格显示，支持左右并排或上下布局，窗格同步滚动；行背景提示该行存在差异，字符/文本着色指出具体差异。可选缩略图以一像素一行展示全文件差异分布并支持点击跳转。[Text Compare Overview](https://www.scootersoftware.com/v5help/viewtext.html)
- **[事实]** 支持自动换行；关闭换行时保持原始长行并通过横向滚动阅读。支持逐个“差异文本”、逐个“差异区段”以及跨文件的上一/下一差异导航。[Walking Through Differences](https://www.scootersoftware.com/v5help/walking_through_differences.html)
- **[事实]** 可只显示变化并保留可配置上下文；可显示空白字符、行号、语法高亮，也可切换缩略图与当前行详情。[Text Merge commands（相同文本视图命令集）](https://www.scootersoftware.com/v5help/commandstextmerge.html)
- **[事实]** Folder Compare 是左右目录树；内容比较可以是 CRC、逐字节或规则化比较。规则化比较可忽略被定义为“不重要”的空白、注释、编码或换行符差异，因此“相同”具有所选规则的语义，不必然等于字节相同。[Content Comparisons](https://www.scootersoftware.com/v4help/opcompare.html)
- **[事实]** 有图片并排及差异高亮、十六进制逐字节比较等专用查看器；文本编码可按左右侧覆盖检测值。[Specialized Viewers](https://www.scootersoftware.com/home/multifaceted)、[Text Compare File Format Settings](https://www.scootersoftware.com/v5help/sessiontextformats.html)
- **[未验证]** 本轮未在官方 v5 帮助中确认文本“统一单栏 diff”模式，也未找到针对 diff 视图的屏幕阅读器契约；不能因其键盘快捷键丰富就推断其可访问性完备。

### 2.2 Kaleidoscope 6

- **[事实]** 文本有 Blocks、Fluid、Unified 三种布局；Fluid 会压缩空白以增强自然阅读，视图支持长行换行、行号开关、字号/字体配置、文件内搜索和上/下一个变化。[Using the Text Views](https://kaleidoscope.app/help/docs/text-comparison-views)
- **[事实]** 目录以双侧 outline 呈现，默认展开包含变化的目录；支持按状态筛选，以及用部分文件名或扩展名同时过滤两侧目录，双击文件进入新标签页比较。[Folder Comparisons](https://kaleidoscope.app/help/docs/comparing-folders)
- **[事实]** 图片提供 Two Up、One Up（可自动 A/B 交替）、Split 与 Difference 四种模式；Difference 用可调透明度蒙版显示像素变化。另有缩放、实际像素、导航器与逐像素检查工具。[Image Comparison Views](https://kaleidoscope.app/help/docs/image-comparison-views)、[Image Comparison Tools](https://kaleidoscope.app/help/docs/image-comparison-tools)
- **[事实]** 对大量或大型媒体文件，官方提供“超过阈值且大小相同则假定相同”的性能选项，并明确这是跳过完整数据检查的近似；这说明 UI 必须区分“已完整比较”与“基于启发式假定”。[Folder Compare Settings](https://kaleidoscope.app/help/docs/folder-compare-settings)
- **[未验证]** 本轮未从官方帮助确认 Windows 支持，也未找到 diff 专属的 VoiceOver/屏幕阅读器行为说明；Kaleidoscope 的手势与 `⌘` 快捷键证据不可直接移植为 Windows 交互结论。

### 2.3 WinMerge 2.16

- **[事实]** 文本比较用对齐的多窗格展示；差异块有背景色，块内可按单词或字符粒度高亮，能对齐相似行并为缺失行插入显示占位。Location pane 同时承担全文件差异地图、当前可见区域指示和点击/拖动跳转。[Comparing and merging text files](https://manual.winmerge.org/en/Compare_files.html)
- **[事实]** 支持自动滚到首个差异/首个行内差异；状态栏显示“第 x/n 个差异”、编码类型以及 CRLF/LF/CR/Mixed 等 EOL 信息。[Comparing and merging text files](https://manual.winmerge.org/en/Compare_files.html)、[Options and configuration](https://manual.winmerge.org/en/Configuration.html)
- **[事实]** 目录比较有表格与递归树视图、状态过滤和下一差异导航。大型文件可改用 Quick Contents 或 Binary Contents；官方明确 Quick Contents 会跳过插件、移动块检测与行过滤，并可能不提供差异计数。[Comparing and merging folders](https://manual.winmerge.org/en/Compare_dirs.html)
- **[事实]** 图片比较支持差异块、闪烁、颜色距离阈值、XOR、Alpha Blend/动画与缩放；二进制文件可进入十六进制比较。[Comparing image files](https://manual.winmerge.org/en/Compare_images.html)、[Comparing in hexadecimal format](https://manual.winmerge.org/en/Compare_bin.html)
- **[事实]** 文件夹级 rename/move 检测默认关闭；启用后可把同目录改名或跨目录移动合成单一条目，但歧义匹配不合并。这类结果是检测配置的产物，不是 Git 原生对象身份。[Options and configuration](https://manual.winmerge.org/en/Configuration.html)
- **[未验证]** 官方手册未给出统一单栏文本 diff；也未找到 diff 专属的屏幕阅读器说明。颜色可配置和键盘导航只能算可访问性的组成部分，不能替代屏幕阅读器验证。

### 2.4 VS Code 与 JetBrains IDE

- **[事实]** VS Code 当前 diff 编辑器支持并排、行内与自动布局；自动布局在窄窗口切为行内。可折叠未改区域、用上一/下一变化跳转。Accessible Diff Viewer 把差异转换成统一 patch 供屏幕阅读器线性阅读，并支持 F7/Shift+F7 跳转。[VS Code: Review changes with the diff editor](https://code.visualstudio.com/docs/sourcecontrol/staging-commits)、[VS Code Accessibility](https://code.visualstudio.com/docs/configure/accessibility/accessibility)
- **[事实]** VS Code 新 diff 编辑器的公开更新记录还包括移动代码检测、差异区内部对齐，以及折叠区的符号面包屑；这些更适合复杂重排，不应默认等同于最小产品必需项。[VS Code 1.82 release notes](https://code.visualstudio.com/updates/v1_82)
- **[事实]** JetBrains Diff Viewer 支持并排/统一、未变片段折叠、对应行垂直对齐、同步滚动、空白忽略，以及单词/行/字符/拆分变化等高亮粒度；也支持软换行、显示空白和行号。[JetBrains Diff Viewer](https://www.jetbrains.com/help/idea/differences-viewer.html)
- **[事实]** JetBrains 为 IDE 级别提供 Windows/macOS/Linux 屏幕阅读器支持、键盘聚焦与 UI 缩放说明；这是 IDE 的整体能力，不等于其每个 diff 控件均已在本轮独立验证。[JetBrains Accessibility](https://www.jetbrains.com/help/idea/accessibility.html)
- **[边界事实]** VS Code 与 JetBrains 的 diff UI 内含 stage、revert、accept、直接编辑等写操作；这些是竞品事实，但与 Oris 的只读定位冲突，不能照搬。VS Code 官方明确其 gutter 可 stage/revert，JetBrains 官方明确本地侧可编辑并应用差异。[VS Code source control](https://code.visualstudio.com/docs/sourcecontrol/staging-commits)、[JetBrains Diff Viewer](https://www.jetbrains.com/help/idea/differences-viewer.html)

## 3. 横向对照：Oris 可借鉴的阅读要素

| 维度 | Beyond Compare | Kaleidoscope | WinMerge | VS Code | JetBrains | 对 Oris 的启发（建议） |
|---|---|---|---|---|---|---|
| 并排 / 统一 | 并排、上下；统一未证实 | Blocks、Fluid、Unified | 对齐窗格；统一未证实 | 并排、行内、自动 | 并排、统一 | 桌面宽屏默认并排；提供统一；窄宽度自动统一但保留手动锁定 |
| 行内高亮 | 文本着色 + 行背景 | 官方说明有 text diff，粒度细节本轮未充分确认 | 单词/字符 | 行内差异 | 单词/行/字符/拆分 | 基础即需要“行 + 行内”双层编码，不能只靠红绿整行 |
| 上下文折叠 | Show Changes/Context | Fluid 压缩空白，不等同任意折叠 | Location/Diff pane 聚焦；折叠未证实 | 可折叠未变区 | 可折叠且上下文行数可配 | 大文件默认折叠未变区，入口显示隐藏行数，可单段展开 |
| 换行 / 横滚 | 可切换换行 | 可配置换行 | 有换行与行内自动定位 | 编辑器换行能力 | Soft-Wrap | 默认不换行以守住列对齐；显著提供 Wrap 切换，并记住用户选择 |
| 同步滚动 / 总览 | 同步 + 缩略图 | 文本同步细节本轮未证实 | 对齐窗格 + Location pane | 并排阅读 | 可切同步滚动 | 同步滚动默认开；差异 minimap 只显示变化密度与当前视窗，不塞语义 |
| 变化跳转 | 文本/区段/跨文件 | 上/下一个变化 | 首/上/下/末 + x/n | 上/下一个变化 | F7/Shift+F7，可续到下一文件 | 统一 `上一处 / x of n / 下一处`，到文件末尾可继续下一文件 |
| 目录/文件查找 | 文件夹视图及文件名查找 | 状态筛选 + 名称/扩展名过滤 | 树/表格 + 状态过滤 | SCM 文件列表 | VCS 文件列表 | 左侧文件树支持路径模糊搜索、状态过滤、折叠目录；搜索结果不改变比较语义 |
| 图片 | 并排 + 差异高亮 | 4 种视图 + 像素工具 | 高亮/XOR/Alpha | 非核心 diff 能力 | 文件类型查看能力，细节依类型 | 可选专用查看器；第一阶段可先给尺寸/哈希/元数据与外部打开 |
| 二进制 | Hex Compare | 本轮未证实通用 hex | Hex Compare | 通常降级 | 可打开多类文件，能力依类型 | 基础必须明确“二进制不同”，可选十六进制；绝不把无文本 diff 写成“无变化” |
| 大文件 | 多种快速/规则比较 | 可跳过完整数据检查并标注近似 | Quick/Binary 降级 | 折叠上下文 | 折叠与高亮粒度 | 设预算并显式降级：完整 / 截断 / 仅统计 / 无法渲染；用户始终知道当前证据等级 |
| rename/move | 目录规则对齐 | 本轮未确认 | 可配置检测，默认关 | 可显示 Git 结果 | 可显示 VCS 结果 | 展示 Git 给出的 old → new 与相似度（若有）；不要把启发式重命名伪装成绝对事实 |
| 编码 / EOL | 可检测/覆盖、规则可忽略 | 本轮不足 | 状态栏明确编码与 EOL | 编辑器可见空白能力 | 可见空白、忽略规则 | 文件头固定显示编码、BOM、EOL；“忽略空白”只是阅读过滤器，并醒目标明已启用 |
| 可访问性 | diff 专属证据不足 | diff 专属证据不足 | diff 专属证据不足 | Accessible Diff Viewer | IDE 级屏幕阅读器支持 | 基础即键盘全流程、非颜色图标/文本、焦点可见；统一文本视图作为屏幕阅读器主路径 |

## 4. 分层候选矩阵（候选，不是决策）

| 层级 | 候选能力 | 价值与约束 |
|---|---|---|
| **基础** | 并排 + 统一两种文本布局；行级与行内双层高亮；同步滚动；差异计数及上/下一处；未变上下文折叠/展开；长行 Wrap 开关；路径搜索与状态筛选；左右端点及比较语义常驻标题；编码/EOL/二进制/截断状态；键盘完整操作、焦点态、非颜色状态编码；ahead/behind 本地快照标签 | 直接服务“直观 diff”和安全只读。基础层不应出现任何写操作按钮，即使禁用也会制造误导。 |
| **可选** | 差异 minimap；跨文件连续阅读；空白忽略/显示空白；语法着色；Git rename 相似度与旧/新路径；图片并排/叠加/差异蒙版；十六进制只读查看；复制选中文本/路径/提交哈希；用户可调上下文行数 | 提高高频阅读效率，但每种过滤和降级都必须可见、可撤销，不能改变底层事实标签。 |
| **高成本，仅建议评估** | moved-code 检测与连线；语法/AST 感知 diff；逐像素阈值与对齐；超大文件分块/流式 diff；PDF/Office/归档专用查看器；语义重命名推断；针对多种屏幕阅读器的专门优化与自动化验收 | 都有价值，但算法、性能、格式兼容或验证矩阵成本高。除非用户明确选择，不应挤占主阅读闭环。 |

## 5. 建议的用户阅读流程

1. **进入仓库总览**：顶部只显示仓库路径、当前 HEAD/分支、上游（若有）、ahead/behind 和数据新鲜度。ahead/behind 文案示例：`相对 origin/main 的本地快照：ahead 2 / behind 1；远端跟踪引用最近更新时间未知`。不得写成“远端最新”。
2. **选择比较意图**：使用语义清晰的入口，而不是先暴露 Git 参数：`未暂存（工作区 ↔ index）`、`已暂存（index ↔ HEAD）`、`全部本地改动（工作区 ↔ HEAD）`、`某次提交（父提交 ↔ 提交）`、`比较两个引用`。
3. **缩小文件集合**：左侧文件树显示 A/M/D/R、旧路径 → 新路径、增删行统计；支持路径模糊搜索和状态过滤。未跟踪文件作为独立状态呈现，不混进普通 tracked diff 的统计。
4. **确认端点再读内容**：文件标题下固定显示 `左：<ref/index/worktree> · 右：<...>`，以及编码、EOL、是否忽略空白、是否截断。二进制或超预算文件先给出明确状态，再提供可选专用视图。
5. **连续阅读变化**：宽屏默认并排、同步滚动，窄窗自动统一；每个 hunk 有稳定的序号，顶部/快捷键均可上一处、下一处。到文件末尾时可进入下一个有变化的文件，并告知跨文件跳转。
6. **展开必要上下文**：未变区域默认折叠但显示隐藏行数；可单段展开或“全部展开”。启用忽略空白时，把过滤状态作为常驻提示而非瞬时 toast。
7. **离开时零副作用**：关闭视图不触发保存、刷新远端、修改 index 或工作区。允许的动作仅限导航、过滤、复制、外部只读打开（若用户后续选择该能力）。

## 6. Git 只读语义：必须准确标注

### 6.1 ahead / behind 与“最新性”

- **[事实]** remote-tracking branch（如 `origin/main`）是本地引用，代表“上次与远端通信时看到的远端分支位置”；离线期间服务器继续变化，本地 `origin/main` 不会自行移动。`git fetch` 会下载对象、更新本地数据库并移动相应的 remote-tracking refs。[Pro Git: Remote Branches](https://git-scm.com/book/en/v2/ch00/_delete_branches)、[git-fetch](https://git-scm.com/docs/git-fetch)
- **[事实]** Git 可对本地分支与 configured upstream 输出 ahead/behind；含义是双方各自可达而对方不可达的提交数量。若没有 upstream 则无 tracking 信息；上游引用缺失可显示 `gone`。[git-for-each-ref](https://git-scm.com/docs/git-for-each-ref)
- **[建议]** Oris 在不执行 fetch 的边界下，只能展示“当前本地 tracking 快照”的计数。始终同时展示比较对象（例如 `main ↔ origin/main`）和新鲜度状态：已知时间、未知时间或引用缺失。不能用绿色“已同步”表达服务器实时同步，最多写“与本地快照一致”。
- **[边界]** fetch 虽不修改工作区文件，却会写入对象数据库、`FETCH_HEAD` 及/或 remote-tracking refs；因此它不属于严格的零写入只读交互。本报告不建议自动或手动 fetch 入口。若未来用户重新定义“只读”为“不改工作区但允许更新元数据”，需另行做产品边界决策。

### 6.2 Diff 端点语义

Git 官方将 diff 定义为两个端点之间的比较，而不是历史“范围”。以下命名应直接进入产品文案：[git-diff](https://git-scm.com/docs/git-diff)

| Oris 语义名称 | Git 等价语义 | 左端点 → 右端点 | 关键说明 |
|---|---|---|---|
| 未暂存改动 | `git diff` | index → 工作区 | 表示相对暂存区尚未进入 index 的 tracked 内容变化。 |
| 已暂存改动 | `git diff --cached` / `--staged` | HEAD → index | 表示下一次提交将包含的变化；无 HEAD 的初始仓库是特殊情形。 |
| 全部本地改动 | `git diff HEAD` | HEAD → 工作区 | 同时反映已暂存与未暂存相对 HEAD 的合并结果，但不是“两层变化的简单拼接”。 |
| 某次普通提交引入的变化 | 提交父节点与提交比较 | `commit^1` → `commit` | root commit 没有父节点，应以空树为左端点并标注“初始提交”。 |
| 某次 merge commit | 父节点选择或 combined diff | 选定 parent → merge commit，或多父 combined | merge 有多个父节点；默认只写“父提交”会含糊。UI 应要求/显示第几个父节点，或明确 combined 模式。Git `show` 支持 first-parent、separate、combined/dense-combined 等形式。[git-show](https://git-scm.com/docs/git-show) |
| 任意两个 refs / commits | `git diff A B` | A → B | 是端点比较；方向决定新增/删除的视觉含义。左右端点不可因排序而悄悄互换。 |
| 从共同基线看 B 的变化 | `git diff A...B` | `merge-base(A,B)` → B | 三点式在 `git diff` 中不是对称差集。产品若提供，应命名为“共同基线 → B”，不要只显示 `A...B`。[git-diff](https://git-scm.com/docs/git-diff) |

- **[事实]** Git rename 是差异算法基于相似度把 delete/add 配对后的结果，阈值可配置，默认相似度阈值为 50%；它不是提交对象里存储的一条“重命名事件”。[git-diff-tree](https://git-scm.com/docs/git-diff-tree)
- **[建议]** Oris 显示 rename 时同时给出旧路径、新路径和相似度（若数据可得），并在检测关闭、超预算或结果含歧义时回退为删除 + 新增；不要虚构确定性。
- **[建议]** 比较过滤（忽略空白、隐藏未变行、仅看某路径）只改变阅读投影，页面应保留“当前过滤器”提示，原始端点与仓库状态不可随过滤器变化。

## 7. 安全仅作为产品交互边界

本节不提出实现方案，只定义用户能看见和不能触发的边界：

- **允许**：读取并浏览工作区、index、对象与 refs；切换比较端点；搜索、过滤、折叠、缩放、复制文本/路径/哈希；查看图片或十六进制内容；刷新当前本地读取结果。
- **不提供**：stage/unstage、discard/revert、编辑保存、commit、amend、checkout/switch、创建/删除/移动分支、merge/rebase/cherry-pick、stash、push/pull/fetch、修改 upstream 或 Git config。
- **避免伪操作**：不要展示禁用的写按钮，不要复用竞品中指向左右侧的 Apply/Copy 箭头，不用“同步”表示同步滚动以外的任何仓库动作。
- **状态透明**：读取失败、对象缺失、权限不足、文件变化中、超预算、二进制、编码解码失败、tracking 引用缺失都应是明确状态；不能把“无法比较”降格显示为“无差异”。

## 8. 未决项（留给下一轮用户选择）

1. 文本默认布局：始终并排，还是按宽度自动在并排/统一间切换；是否允许用户锁定。
2. 基础范围是否包含图片 diff 与十六进制查看，还是先只做清晰的类型/哈希/尺寸降级。
3. 大文件的默认预算及降级层次；是否允许用户显式请求更完整的只读计算。
4. 是否首期支持 Git rename 相似度展示、moved-code 检测或仅呈现 A/M/D/R 文件级状态。
5. merge commit 默认选择 first parent，还是总是先让用户选择父节点；combined diff 是否值得首期承担复杂度。
6. ahead/behind 的新鲜度从何处取得可信时间。Git refs 本身不提供“服务器当前时间点”的证明；若没有可靠元数据，宁可显示“更新时间未知”。
7. 可访问性验收目标：仅保证键盘/非颜色表达，还是把 Windows 屏幕阅读器的统一 diff 阅读流程纳入基础发布门槛。

## 9. 证据边界

- 本轮只使用产品厂商/项目官方帮助与 Git 官方文档；没有把第三方测评或营销性能表述当作实测。
- 页面描述的是查阅日可访问的官方文档能力，不代表所有历史版本、平台或许可证层级完全相同。
- 未安装并实际操作各竞品，因此快捷键冲突、超大仓库性能、颜色辨识、焦点顺序和屏幕阅读器朗读质量仍需后续实机验证。
- 特别是“大文件更快”“轻量”等说法，本报告只记录竞品提供的降级策略，不对速度作横向实测结论。
