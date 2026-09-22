# Oris 竞品调研 R2：IDE 原生 Git 与插件的只读 UI/UX 候选

查阅日期：2026-09-22（Asia/Shanghai）

## 1. 范围与证据边界

本报告只研究以下产品中与“读取 Git 状态、历史、分支和 diff”有关的交互，不为 Oris 决定规格、架构或实现顺序：

- VS Code 原生 Source Control、Source Control Graph、Diff Editor
- GitLens
- Git Graph（`mhutchie.git-graph`）
- JetBrains IDE 的 Git Log、Local Changes / Staging Area、Diff Viewer

Visual Studio 未展开：上述四组已覆盖本轮要求的关键交互变量（多文件阅读、工作区/暂存区、历史/分支、比较对象、筛选、键盘、布局与上下文保留），继续加入同类 IDE 的边际信息有限。

证据以厂商官方文档、官方 Marketplace、项目官方仓库 README 为主。下文中的“已证实”只表示文档明确写出，不等于本轮做过性能、可用性或安全实测；任何“快”“适合大仓库”等宣传性表述均不作为结论。

## 2. 结论摘要

1. **最稳定的跨产品阅读链路是：选择比较范围 → 浏览变更文件 → 阅读单文件或连续多文件 diff → 在文件/变更块之间前后导航。** VS Code 已把提交的全部变更放入 multi-file diff；JetBrains 提供 All-in-One Diff；GitLens 和 Git Graph 都把“比较对象 + 文件清单 + 单文件 diff”作为主链路。
2. **工作区与暂存区应是两个明确的只读数据层，而不是两个可操作队列。** VS Code 原生用 `Changes` / `Staged Changes` 分组；JetBrains 在启用 staging area 后能同时表达 HEAD、Staged、Local 三层。Oris 可借用层次表达，但应删除 stage/unstage、拖拽、复选提交等写入口。
3. **历史图的价值不是“画线”，而是提供稳定上下文。** Git Graph 的 HEAD 居中、键盘沿父子提交移动、详情面板不离开图；GitLens 的可固定比较结果；JetBrains 的过滤结果新标签页，都是减少重复定位的模式。
4. **ahead/behind 必须显示参照物和数据新鲜度。** VS Code 把 incoming/outgoing 定义为当前分支相对 upstream；GitLens 的比较结果同时给出 Ahead、Behind 和文件数。只显示两个数字而不显示 `当前分支 ↔ upstream/目标 ref`，含义会不清楚。
5. **只读定位需要比 IDE 更强的“禁写可见性”。** 这些竞品大量把 checkout、stage、commit、fetch、pull、push、merge、rebase、reset、stash 混在同一工具栏或右键菜单里。Oris 若定位为安全只读工具，应在信息架构层移除这些动作，而不是只做按钮禁用。

## 3. 产品能力对照（已证实事实）

| 产品 | 形态与能力边界 | 多文件阅读 | 工作区 / 暂存区 | 历史、分支与比较 | 筛选与键盘 | 上下文保留 |
|---|---|---|---|---|---|---|
| VS Code 原生 | Git 支持内置；Source Control、Graph、Diff Editor 属原生功能。GitHub PR 是另装扩展，Copilot Code Review 需订阅 | 提交可 `Open Changes` 进入 multi-file diff；单文件 diff 支持 inline / side-by-side、折叠未改区域、前后变更导航 | `Changes` 与 `Staged Changes` 分组；可切换树/列表。原产品含 stage/unstage 等写操作 | Graph 展示提交和分支关系，可比较提交与本地/远端分支或 merge base；upstream 存在时标出 incoming/outgoing | `Ctrl+Shift+G` 聚焦 Source Control；Accessible Diff Viewer 为 `F7`；图和 diff 另有按钮导航 | Graph → changed files → diff；Timeline 跟随当前活动文件，适合文件级追溯 |
| GitLens | VS Code 第三方扩展；部分能力标 `PRO`。Commit Graph 对 public/local repo 可免费无账号使用，private repo 需 Pro/试用 | 比较结果含变更文件；文件复选框可标记 review progress；Graph/Inspect/Compare 之间可下钻 | 可显示 working changes；产品同时包含大量写操作，不适合原样移植 | Search & Compare 可比较任意两个 refs，明确显示 Ahead、Behind、changed files；Graph 表达 HEAD、upstream、merge target | 可按 message、author、SHA、path/glob、patch 搜索；Graph 搜索支持大小写、正则及结果前后跳转 | 搜索/比较结果可 pin，可选择保留旧结果；文件布局可 list/tree/auto |
| Git Graph | VS Code 第三方扩展；官方 Marketplace/仓库页面列功能，未据此确认当前授权、收费或长期维护承诺 | 提交详情列变更文件，点击进入 VS Code diff；两提交比较同样从文件列表进入 diff；review 状态可跨 VS Code 会话保留 | 可把 uncommitted changes 作为图中对象，并与任意提交比较；原产品也包含 stash/reset/clean 等写操作 | 图显示本地/远端分支、tags、remotes；`Ctrl/Cmd` 选择第二个提交进行比较；hover 顶点可看提交是否属于 HEAD 及哪些 refs 包含它 | 分支下拉过滤、文本 Find；`Ctrl/Cmd+F` 查找、`Ctrl/Cmd+H` 回到 HEAD、方向键移动相邻提交、组合键沿父/子提交走 | 可配置详情位置、列宽/列可见性；`Retain Context When Hidden` 用内存换切回速度 |
| JetBrains IDE 原生 | Git UI 随 IDE 集成，不是本轮另装插件；IDE 本身的版本/许可证差异不等于 Git 功能另收费 | All-in-One Diff 可把全部变更连续展示；提交/两提交比较先得到文件列表，再用 `Ctrl+D` 看 diff | 默认可用 changelists；可选启用 Git staging area，表达 HEAD / Staged / Local 三层并支持三向 diff。原产品有编辑和提交动作 | Log 展示本地/远端所有分支；可选两提交 `Compare Versions`；分支比较展示双方独有提交 | commit 搜索支持片段、完整 SHA、正则；可按 branch/favorite、user、date、folder/root 过滤；左右键跳父/子提交，`Ctrl+L` 聚焦搜索 | 可把当前过滤条件打开为新 Log 标签；详情侧栏和 diff preview 可保持列表选择上下文 |

## 4. 各产品可借鉴与应剥离之处

### 4.1 VS Code 原生 Source Control / Diff

**已证实**

- Source Control 的 `Changes` 与 `Staged Changes` 让用户先选“看哪一层”，再选文件；文件状态使用 U/M/D 等文字标志，列表可在树形和扁平结构之间切换。
- Diff Editor 会根据宽度自动在 side-by-side 与 inline 间选择，也允许手动固定；可折叠未变化区域并跳转到上一/下一处变化。
- Source Control Graph 中选提交后先看 changed files，之后可以进入单文件 diff，或用 `Open Changes` 进入整个提交的 multi-file diff。
- 当分支配置 upstream 时，Graph 显示 incoming/outgoing commits；官方定义分别为“远端有而本地没有”和“本地有而远端没有”。

**可移植设计建议（非产品决定）**

- 把“工作区”“暂存区”设计为只读 scope tabs，并在每个 tab 上给文件数与行数统计；不要复制 `+/-`、拖拽等 stage 语义。
- 默认依据窗口宽度自动选择 side-by-side / inline，但保留显式切换，避免响应式布局替用户做不可逆选择。
- 同时提供“文件列表 + 单文件 diff”和“连续多文件 diff”两种阅读密度；两者共享当前比较对象和滚动/已读上下文。
- ahead/behind 标签写全参照，例如 `main ↔ origin/main · ahead 2 · behind 1`，并显示本地 ref 数据更新时间。

**应剥离**

- Stage、Unstage、Commit、Checkout、Fetch/Pull/Push/Sync、冲突解决以及 AI 生成提交信息。

### 4.2 GitLens

**已证实**

- Search & Compare 的比较对象可以是 branches、tags、commits 等 refs；结果同时展示 Behind、Ahead、changed files。
- 搜索支持 message、author、SHA、文件路径/glob 和 patch 内容；比较与搜索结果可 pin，可保留旧结果。
- 比较文件旁的 checkbox 用于记录 review progress，这是“本地阅读状态”，不等于 Git 写操作。
- Commit Graph 的搜索支持 message/author/file/change 等字段，并有下一/上一结果快捷键；可隐藏 refs、只看当前分支或控制 remote-only branches、tags、stashes 等图层。
- Commit Graph 文档标为 `PRO`，但官方同时说明 public/local repositories 无需账号即可用；private repository 需要 Pro 或试用。Cloud Patches、Launchpad 等也明确标 `PRO`，不应混入 Oris 基础候选。

**可移植设计建议（非产品决定）**

- “比较会话”可固定：保存左右 refs、merge-base/直接比较模式、过滤条件、文件选择和阅读进度。固定对象是本地 UI 状态，不改仓库。
- 搜索框采用轻量字段语法并给可见提示 chips，例如 `author:`、`path:`、`message:`；高级语法不应成为基本查找的前置条件。
- 图层过滤优先提供少量预设：当前分支、当前 + upstream、全部本地分支、全部 refs；tags/remotes 可作为独立显隐项。

**应剥离**

- 云工作区、PR/Issue、Cloud Patch、账号体系、AI review/compose，以及切分支、fetch、rebase 等写入或联网协作工作流。

### 4.3 Git Graph

**已证实**

- 单击提交打开详情，`Ctrl/Cmd` 再单击另一个提交进入两提交比较；两种详情都以 affected files 为入口进入 VS Code diff。
- Code Review 模式用粗体表示未读文件，打开 diff/文件后取消粗体；review 状态跨 VS Code 会话保留，并在 90 天无活动后自动关闭。
- `Ctrl/Cmd+H` 把图重新居中到 HEAD；方向键走上下相邻提交，组合键沿同一分支父/子提交导航，带 Shift 时可走分叉的另一条路径。
- 可调详情面板位置、列宽、列可见性；可以让隐藏后的图保留上下文，但官方明确这会增加内存开销。
- 分支过滤支持全部、手选多个、预定义 glob；Find 可匹配提交信息、日期、作者、hash、branch/tag 名。

**可移植设计建议（非产品决定）**

- 将“回到 HEAD”做成始终可见的定位动作，并在图、提交详情和 diff 中共享同一选中提交。
- 支持真正的键盘图遍历：上下是视觉相邻，左右或组合键是拓扑父子；二者需在帮助提示中区分。
- 阅读进度适合做成可选、纯本地元数据；默认可只保存到当前会话，是否跨会话和过期时间由用户下一轮选择。
- 对“保留隐藏视图”给资源权衡：保存轻量选择/过滤状态，与缓存完整 diff 内容分开。

**应剥离**

- 图中右键的 checkout、merge、rebase、reset、clean、stash、push、tag/branch 修改；Repository Settings 中会写配置或远端的操作。

### 4.4 JetBrains Git Log / Diff

**已证实**

- Git Log 可以按 branch/favorite branch、user、date、folder/root 筛选；搜索支持提交名/信息片段、revision、正则。
- 左右方向键可跳到 parent/child commit；`Ctrl+L` 聚焦搜索。当前过滤结果可另开标签，避免为了另一条调查路线反复清空过滤条件。
- 选两个提交后 `Compare Versions` 得到 changed-files 列表；选文件后 `Ctrl+D` 看 diff。文件历史选中 revision 时，右侧会立即显示 diff preview。
- All-in-One Diff 把所有 changed files 放入单个连续 diff；Diff Viewer 可选择 side-by-side 或 unified，并允许折叠未变化片段、控制空白字符/行号/缩进线等显示。
- Staging Area 是可选模式；启用后能在三向 Diff Viewer 同时表达 repository、staged、local。默认 changelist 模型与原生 Git index 不是同一概念。
- 可选检查 incoming/outgoing，并在分支名旁用不同颜色箭头提示。

**可移植设计建议（非产品决定）**

- 将 JetBrains 的“过滤结果开新标签”改造成更轻的调查 tabs 或 history stack，避免独立桌面工具复制完整 IDE 标签系统。
- 连续 diff 中保留粘性文件头（路径、状态、增删行、上一/下一文件）；文件树点击时滚动到对应文件，而不是打开另一个编辑器上下文。
- 三层状态应固定为 `HEAD → Index → Working Tree`，并明确每个 diff 的左右端点；不移植 changelist，以免把 IDE 抽象误当 Git 事实。

**应剥离**

- 可编辑 diff、Accept/Revert、changelist 管理、commit/push、checkout、rollback，以及依赖 IDE 项目模型的代码编辑能力。

## 5. 面向 Oris 的可选功能模块（供下一轮选择，不是规格）

下表按独立模块列候选。`支持 / 创新 / 精简 / 排除` 为空，留给用户下一轮裁决。

| 候选模块 | 最小可见价值 | 竞品来源 | 可选增强 | 只读边界风险 | 用户选择 |
|---|---|---|---|---|---|
| 仓库状态条 | 当前 branch、HEAD、upstream、ahead/behind、状态时间 | VS Code、GitLens、JetBrains | 可解释 tooltip：数字如何计算、相对谁 | “刷新”若调用 fetch 就变成网络/远端状态变化；应区分重读本地 refs 与 fetch | 待选 |
| 工作区 / 暂存区双 scope | 清楚区分 Working Tree vs Index | VS Code、JetBrains | HEAD/Index/Working Tree 三端点小图 | 任何 stage/unstage 入口都越界 | 待选 |
| 变更文件导航器 | 状态、路径、增删行，树/列表切换 | VS Code、GitLens、Git Graph | reviewed/未读标记、路径过滤 | review 标记只能写 Oris 本地状态，不能写仓库 | 待选 |
| 单文件 Diff | side-by-side / inline、折叠未改区、hunk 导航 | VS Code、JetBrains | 空白忽略、语法高亮、二进制预览策略 | “应用/还原”箭头必须不存在 | 待选 |
| 连续多文件 Diff | 一次顺序阅读全部变更 | VS Code、JetBrains | 粘性文件头、文件 mini-map、只看未读 | 大变更的内存/渲染性能未实测 | 待选 |
| Commit Graph | 提交拓扑、refs、当前 HEAD | 四者均有相关实现 | scope presets、回到 HEAD、父子键盘遍历 | 图上不得出现 checkout/merge/rebase 等写菜单 | 待选 |
| Commit 详情 | 作者/时间/SHA/message/parents/changed files | GitLens、Git Graph、JetBrains | 父提交切换、复制稳定标识 | 外链 issue/PR 会引入联网与隐私范围 | 待选 |
| 任意两 refs 比较 | 明确左右对象、Ahead/Behind、files changed | GitLens、VS Code、Git Graph、JetBrains | merge-base 与 direct 两种模式并列解释 | 默认比较语义若不显式会造成误读 | 待选 |
| 搜索与筛选 | message/author/SHA/path/branch/date | GitLens、Git Graph、JetBrains | 可见 filter chips、保存/固定调查 | patch 内容搜索成本与索引策略未验证 | 待选 |
| 调查上下文保留 | 记住 scope、refs、filters、选择和滚动位置 | GitLens、Git Graph、JetBrains | 固定比较、历史返回、可选跨会话恢复 | 缓存内容可能泄漏私有代码；需单独决定保存范围 | 待选 |
| 键盘阅读模式 | 搜索、下一文件、下一 hunk、父子提交、回到 HEAD | 四者组合 | 命令面板/快捷键提示层 | 不应暴露任何写命令 | 待选 |
| 文件历史 / blame | 从当前行或文件追溯提交 | VS Code、GitLens、JetBrains | 行级 hover 进入 commit/diff | 可能分散“diff 优先”的主路径，可延后或排除 | 待选 |

## 6. 三种布局候选（只描述权衡）

### 候选 A：三栏审阅台

`左：scope/文件树 | 中：diff | 右：提交或比较详情`

- 优点：对象、文件和内容同时可见，切文件不丢比较上下文。
- 风险：窄屏拥挤；Graph 需要替换中栏或进入独立视图。
- 来源模式：VS Code Source Control + editor、GitLens Inspect、JetBrains Log details。

### 候选 B：Graph 主工作台

`上：仓库/分支状态 | 中：Graph | 下或右：选中提交详情与文件 | 独立 diff tab`

- 优点：历史/分支调查路径最直接，类似 Git Graph/GitLens。
- 风险：从文件列表进入 diff 会发生视图切换；工作区 diff 可能被历史图降级。
- 来源模式：Git Graph、GitLens Commit Graph。

### 候选 C：Diff-first 双栏

`左：scope + 文件导航 | 右：连续多文件 diff；历史/分支通过抽屉选择比较对象`

- 优点：最贴合“直观 diff 最重要”，信息密度低，适合轻量桌面工具。
- 风险：拓扑关系不常驻；复杂分支调查需打开次级视图。
- 来源模式：VS Code multi-file diff、JetBrains All-in-One Diff。

## 7. 可用性细节候选

- **状态不能只靠颜色**：文件状态保留 `A/M/D/R/U` 或完整文本；ahead/behind 同时有箭头、文字和数字。Git Graph 已有面向色觉差异的文字状态选项，可作为参考。
- **导航层级分开**：`J/K` 或上下键用于文件，`[`/`]` 或独立命令用于 hunk，父/子提交使用另一组组合键；避免同一按键因焦点不同产生难以预测的跳转。
- **比较端点常驻**：diff 顶部始终显示 `left ref`、`right ref` 与比较模式（direct / merge-base）；工作区则显示 `HEAD ↔ Working Tree` 或 `Index ↔ Working Tree`。
- **保持上下文但限制缓存**：优先保存 refs、filters、selected path、scroll anchor 这类小状态；是否持久化 review progress、diff 内容和私有路径历史应单独征求选择。
- **大范围结果渐进加载**：竞品存在 page size / initial load / load more 设置，但本轮没有做大仓库实测；只能把渐进加载列为候选，不能宣称其性能收益已验证。

## 8. 未验证项与下一轮应问的问题

### 未验证项

- 四类产品在超大仓库、巨型提交、长路径、submodule、Git LFS、重命名检测和二进制文件上的真实响应时间与内存占用。
- 各产品在 Windows 高 DPI、屏幕阅读器、完整键盘操作、中文路径/提交信息方面的实际可用性。
- GitLens 在 2026-09-22 的完整套餐矩阵与企业授权条款；本报告只采用具体功能页对 public/local 与 private repo 的明确说明。
- Git Graph 当前许可证、稳定版维护节奏及企业可采用性；Marketplace/README 的功能事实不能替代法律与维护评估。
- ahead/behind 的“新鲜度”：竞品 UI 可能基于本地 remote-tracking refs；若不 fetch，它不代表远端服务器实时状态。Oris 的“只读”是否允许网络 fetch 尚未由用户决定。
- review progress 跨会话保存是否会触及私有仓库路径、文件名或选择记录的隐私要求。

### 下一轮可一次性选择的前置问题

1. 三种主布局中，A 三栏、B Graph-first、C Diff-first，哪一个作为主方向？
2. 多文件 diff 是否首发同时支持“文件列表逐个读”和“连续 All-in-One”，还是只保留一种？
3. 比较是否首发支持任意 ref ↔ ref，还是先限制为 Working Tree / Index / HEAD / upstream 四个固定端点？
4. ahead/behind 只读取本地 refs，还是允许显式联网更新？若允许，是否仍满足用户对“只读”的定义？
5. 阅读进度、固定比较和上次位置是否跨会话持久化？若持久化，保存哪些字段、多久过期？
6. Commit Graph 是常驻主模块、次级模块，还是首版排除以保证 diff-first 的轻量性？
7. file history / blame 是主链路所需，还是延后以避免把工具扩张成 IDE？

## 9. 官方来源与截图入口

以下页面均于 2026-09-22 查阅；页面内包含官方截图或动图，可用于后续视觉对照。

### VS Code

- [Source control in VS Code](https://code.visualstudio.com/docs/sourcecontrol/overview)：内置 Git、Source Control、Graph、Diff Editor、incoming/outgoing 与界面截图。
- [Staging and committing changes](https://code.visualstudio.com/docs/sourcecontrol/staging-commits)：Changes/Staged Changes、树/列表、diff 布局、折叠与导航、Accessible Diff Viewer。
- [View source control history](https://code.visualstudio.com/docs/sourcecontrol/history)：Graph、multi-file diff、比较分支/远端/merge base、incoming/outgoing 定义。
- [Working with repositories and remotes](https://code.visualstudio.com/docs/sourcecontrol/repos-remotes)：多仓库选择、branch/sync 状态。

### GitLens

- [GitLens Core Features](https://help.gitkraken.com/gitlens/gitlens-features/)：Commit Graph、搜索、ref 显隐、public/local 与 private repo 能力边界、功能截图。
- [GitLens Side Bar Views](https://help.gitkraken.com/gitlens/side-bar/)：Search & Compare、pinned results、Ahead/Behind/files changed、review progress。
- [Commit Graph is Home](https://help.gitkraken.com/gitlens/home-view/)：HEAD、upstream、merge target、ahead/behind 与 graph-first 工作台表述。

### Git Graph

- [Git Graph — Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph)：功能、设置、快捷键与演示图。
- [Git Graph 官方仓库 README](https://github.com/mhutchie/vscode-git-graph)：提交比较、review progress、图导航、上下文保留与完整设置说明。

### JetBrains

- [Investigate changes in Git repository](https://www.jetbrains.com/help/idea/investigate-changes.html)：Log 搜索/过滤、两提交比较、父子导航、文件/目录历史和 diff preview。
- [Commit and push changes](https://www.jetbrains.com/help/idea/commit-and-push-changes.html)：Local Changes、可选 staging area、HEAD/Staged/Local 三向 diff、工具窗口布局。
- [Diff Viewer for files](https://www.jetbrains.com/help/idea/differences-viewer.html)：side-by-side/unified、未变区域、显示选项与快捷键。
- [Advanced Settings — Version Control](https://www.jetbrains.com/help/idea/advanced-settings.html)：All-in-One Diff、diff tab、incoming/outgoing 分支图标。
- [Main version control shortcuts](https://www.jetbrains.com/help/idea/main-version-control-shortcuts.html)：Log、Commit、上一/下一 change 等默认快捷键。

