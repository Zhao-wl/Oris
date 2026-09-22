# Oris 竞品调研：桌面 Git 客户端的信息架构与 Diff 体验

> 调研任务：R1  
> 查阅日期：2026-09-22（Asia/Shanghai）  
> 产品范围：GitKraken Desktop、Sourcetree、Fork、GitHub Desktop、Sublime Merge；Tower 作为补充参照  
> Oris 前提：轻量、高效率、安全、只读；核心价值是直观 diff，同时查看工作区、暂存区、提交记录、分支及相对远端的 ahead/behind；不提供 merge、checkout、stage、stash 等写操作。

## 1. 结论摘要

最值得 Oris 继续评估的不是复制某一款完整 Git 客户端，而是组合几种已经被市场反复验证的阅读路径：

1. **GitHub Desktop 的低认知负担**：把日常入口压缩成 `Changes / History`，文件列表与 diff 始终是主要内容。它证明了“少入口、强上下文”对非 Git 专家很友好；但它不提供完整提交拓扑图，也没有独立、明确的暂存区视图。
2. **Sublime Merge 的连续阅读工作台**：位置栏、提交图、文件列表和详情区构成稳定的四段关系；同一个详情区既能看 pending changes，也能看 commit diff。它最接近“选择对象，然后阅读变化”的统一心智模型。
3. **GitKraken 的图谱可读性与 diff 模式**：WIP 作为提交图中的一个节点，将未提交变化与历史放在同一时间轴；diff 提供 Hunk、Inline、Split、词级变化、语法高亮和变更导航。这些是很强的参考，但其大量写操作、集成、AI 与多工作树能力对 Oris 明显过重。
4. **Fork 的高密度效率**：侧栏、提交列表/图、提交详情和大 diff 之间切换快，文件过滤、diff 内搜索、快捷预览值得借鉴；但它的交互依赖大量上下文菜单和写操作，不能原样移植到只读产品。
5. **Sourcetree 的状态分组表达清楚**：`Unstaged files / Staged files` 的显式分组，以及分支旁 ahead/behind 徽标，适合用来校验 Oris 的信息完整性；但其导航层级、工具栏和 Git Flow 等功能会造成明显视觉负担。
6. **Tower 的状态图标与详情布局成熟**：单行状态同时表达 staged/unstaged，历史详情支持 changeset/tree 两种阅读方式；作为高完成度参考有价值，但其完整 Git 操作面远超 Oris 范围。

一个跨产品的共同缺口是：**ahead/behind 的数字通常可见，但远端数据“何时 fetch、是否过期、失败后仍显示旧值”并不总是同等显眼。** 对只读工具而言，状态可信度比同步动作本身更重要。Oris 可考虑把“本地计算值”和“远端状态新鲜度”绑定展示，例如 `↑3 ↓1 · 已于 2 分钟前更新`、`尚未获取`、`更新失败，显示 09:42 的旧结果`。这是设计建议，不是已确定规格。

## 2. 证据边界与判读方式

### 2.1 已证实事实

- 下文标为“已证实”的内容来自产品官方帮助、官方文档、官方产品页或官方发布说明。
- “真实可参考界面”链接均指向带官方截图或明确 UI 说明的页面；有些官方页面会动态更新，因此报告保留查阅日期。
- ahead/behind 的语义统一理解为：当前本地分支相对于其 tracking/upstream 分支所独有和缺少的提交数。它反映的是**本地 remote-tracking refs**；是否接近真实远端取决于 fetch 新鲜度。

### 2.2 设计建议

- 标为“建议/候选”的内容是面向 Oris 定位的推导，不代表竞品已有该能力，也不代表用户已经选择。
- “可借鉴/过重”只评价是否匹配 Oris 的只读边界，不评价竞品功能本身好坏。

### 2.3 未验证项

- 本轮未安装并逐一操作各客户端，没有进行性能、内存、超大仓库、网络失败或无权限远端的实测。
- 官方的“fast”“performance”等营销表述未作为性能结论。
- Fork 的官方资料以产品页、博客和发布说明为主，缺少与其他产品同等完整的帮助中心；自动 fetch 的默认策略和“最后刷新时间”未从本轮官方资料中确认。
- GitHub Desktop、Sourcetree、Tower 的不同操作系统版本可能在布局细节上有差异；本文只抽取稳定的信息关系。

## 3. 模块总览

| 模块 | GitKraken | Sourcetree | Fork | GitHub Desktop | Sublime Merge | Tower（简述） |
|---|---|---|---|---|---|---|
| 主信息架构 | 左侧导航 + 中央提交图 + Commit Panel/diff | 左侧仓库导航 + File Status/Log 主视图 + 详情/diff | 侧栏 + 提交列表/图 + 详情/diff | 顶部仓库/分支/同步条 + `Changes / History` + diff | Locations + Commits + Files + Details | 侧栏 Workspace + Working Copy/History + 右侧详情 |
| 分支/提交图 | 强；WIP 也进入图 | 强；全分支/当前分支、日期/祖先排序 | 强；提交列表带拓扑与 ref 标签 | 弱；History 是线性提交列表，不是全仓拓扑图 | 强；彩色拓扑线、ref 注释、可折叠 merge | 强；历史图有多种布局 |
| 工作区/暂存区 | WIP 节点；Staged/Unstaged 明确分组 | File Status；Unstaged/Staged 明确分组 | Changes/Stage 视图；文件/行级 staging | Changes 列表以“是否纳入下一提交”勾选；不直接暴露标准 index 分区 | 无提交选中时统一显示 Unmerged/Modified/Untracked/Staged；详情内连续 diff | Working Copy；单行状态能同时表示 staged/unstaged |
| commit 详情 | Commit Panel：元数据、文件、文件 diff | hash、parents、author、date、labels/tags、文件与 diff | 详情面板；文件列表、diff，可折叠/快捷弹出 | History 选 commit 后显示元数据、文件与 diff；支持连续多选 | Details：元数据、文件与每个文件 diff | Changeset 显示元数据+diff；Tree 显示该版本完整树 |
| ahead/behind | 左侧分支指示；fetch 后更新 | 分支旁小徽标 | 分支标签箭头/状态；突出 to-push/to-pull commits | 工具栏动作按钮给出待 push 数；远端有新提交时切换到 Pull；不是全分支对照面板 | Locations 分支行显示双计数，可点击触发 push/pull | 分支旁徽标；hover 解释；Branches Review 也显示比较计数 |
| 远端新鲜度 | 官方说明默认每分钟自动 fetch，可调 | 可启用后台刷新远端状态；是否开启取决于设置 | 未从官方资料确认默认自动刷新节奏或时间戳 | 官方同步流程以手动 `Fetch origin` 为明确入口；本轮未确认时间戳 | `auto_fetch` 可配置；本轮未确认 UI 是否显示最后成功时间 | 支持可选自动 fetch；本轮未确认时间戳 |
| diff 入口 | WIP 文件、commit 文件、Shift 多选两 commit | File Status 文件、commit 文件 | Changes、commit、两端比较、空格大预览 | Changes 文件、History commit/文件、连续 commit 范围 | pending file、commit file、两 commit 多选 | Working Copy 文件、History changeset、外部 diff |
| 对 Oris 的最大价值 | 图谱语境 + 完整 diff 控件 | 状态与历史的显式分区 | 高密度快捷阅读 | 极简入口与清晰主任务 | 稳定四段布局与连续 diff | 状态编码与详情模式 |
| 对 Oris 明显过重 | 写操作、终端、AI、PR、多工作树 | Git Flow、复杂工具栏、写操作 | 写操作、rebase/merge、密集上下文菜单 | commit/branch/PR 流程；且缺完整图 | 完整编辑历史/merge/command palette | 全套 Git 操作、服务集成、Undo、拖放 |

## 4. 按模块对照

### 4.1 信息架构：入口数量与上下文保持

#### 已证实

- **GitKraken Desktop** 以提交图为核心。工作区变化被表示为图顶端的 `//WIP` 节点；选中 WIP 或某个 commit 后，在 Commit Panel 查看文件，再进入 diff。官方文档还提供左侧分支/远端导航及可收起的 Commit Detail panel。参考：[Commit 工作流与 WIP 截图](https://help.gitkraken.com/gitkraken-desktop/commits/)、[Diff 界面](https://help.gitkraken.com/gitkraken-desktop/diff/)、[键盘与面板切换](https://help.gitkraken.com/gitkraken-desktop/keyboard-shortcuts/)。
- **Sourcetree** 把工作区和历史拆成 `File Status` 与 `Log/History` 两个主要视图；左侧的 Working Copy、Branches、Tags、Remotes 兼具导航作用。参考：[File Status 官方界面](https://support.atlassian.com/sourcetree/kb/viewing-file-status-of-a-repository/)、[Log/History 官方界面](https://support.atlassian.com/sourcetree/kb/viewing-log-history-of-a-repository/)。
- **Fork** 官方产品页以 `Commit List / Working Directory Changes / Side by Side Diff / Repository Manager` 展示主界面组成；官方发布记录长期围绕 sidebar、commit list、commit details、stage view、diff view 演进。参考：[Fork 官方产品页及界面轮播](https://git-fork.com/)、[Windows 官方发布说明](https://git-fork.com/releasenoteswin)、[Mac 官方发布说明](https://git-fork.com/releasenotes)。
- **GitHub Desktop** 把本地仓库内的核心内容压缩为左栏的 `Changes / History` 两个标签，顶部负责当前仓库、当前分支与 fetch/push/pull 的上下文。参考：[Changes 与 diff 官方截图](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop)、[History 官方截图](https://docs.github.com/en/enterprise-cloud%40latest/desktop/making-changes-in-a-branch/viewing-the-branch-history-in-github-desktop?platform=windows)。
- **Sublime Merge** 官方将主工作区明确分成 Overview 和 Details。Overview 内有 Locations、Commits、Files 三列；Details 根据选择显示 pending changes 或 commit details。参考：[Getting Started：Overview/Details 官方截图与说明](https://www.sublimemerge.com/docs/getting_started)。
- **Tower** 的侧栏提供 Workspace 入口；Working Copy 左侧列文件、右侧显示 diff，上方集成 commit 区；History 左侧列提交、右侧显示 Changeset 或 Tree。参考：[Tower Interface Overview 官方截图](https://www.git-tower.com/help/guides/first-steps/tower-overview/windows)。

#### 对 Oris 的候选启发

- **候选 A：两入口模型**——用 `工作区 / 历史` 承担 GitHub Desktop 式低认知入口，再让历史内嵌拓扑图。优点是轻；风险是分支浏览和 commit 定位需要更好的二级导航。
- **候选 B：单工作台模型**——采用 Sublime Merge 式 `位置 → 提交 → 文件 → Diff` 稳定列关系。优点是上下文不丢；风险是窄屏和高 DPI 下容易拥挤。
- **候选 C：图谱中心模型**——借鉴 GitKraken，把 `Working Tree` 与 `Index` 作为图顶的两个虚拟状态节点。优点是把未提交变化和历史放在同一模型；风险是 Git 初学者可能误把虚拟节点当 commit。
- 可在下一轮让用户选择入口模型，不应在本报告中直接定案。

### 4.2 分支与提交图

#### 已证实

- GitKraken、Sourcetree、Fork、Sublime Merge、Tower 都提供带拓扑线和 ref 标签的提交历史视图。
- GitKraken 可 `Solo` 分支、固定分支到左侧，并通过 Smart Branch Visibility 只显示当前分支、目标分支及相应 upstream，从而降低大型图噪声。参考：[GitKraken 分支可见性](https://help.gitkraken.com/gitkraken-desktop/branching-and-merging/)、[Solo 与图宽调整](https://help.gitkraken.com/gitkraken-desktop/tips/)。
- Sourcetree 可在 All Branches / Current Branch 间切换，并支持 Date Order / Ancestor Order；官方说明默认图对应 `git log --graph --all --date-order`。参考：[Sourcetree Log/History](https://support.atlassian.com/sourcetree/kb/viewing-log-history-of-a-repository/)。
- Fork 的提交列表显示拓扑和 branch/tag labels，支持按活动分支过滤、分支/文件过滤、折叠 commit、快捷打开 commit details。参考：[Fork 官方产品页](https://git-fork.com/)、[Fork Mac 发布说明](https://git-fork.com/releasenotes)、[Fork Windows 发布说明](https://git-fork.com/releasenoteswin)。
- GitHub Desktop 的 History 是当前分支的提交列表，官方文档展示 commit 选择与连续范围选择，但没有展示全仓分支拓扑图。参考：[GitHub Desktop branch history](https://docs.github.com/en/enterprise-cloud%40latest/desktop/making-changes-in-a-branch/viewing-the-branch-history-in-github-desktop?platform=windows)。
- Sublime Merge 的 Commits 列绘制彩色拓扑线，commit summary 包含消息、作者和关联分支；merge commits 默认可折叠。参考：[Sublime Merge Getting Started](https://www.sublimemerge.com/docs/getting_started)、[Commit Folding 官方文章](https://www.sublimemerge.com/blog/sublime-merge-build-1070)。
- Tower History 支持排序、tree graph 与显示尺寸配置。参考：[Tower Feature Overview](https://www.git-tower.com/features/all-features)。

#### 对 Oris 的候选启发

- 默认图可优先显示当前分支、upstream、默认基线及与它们相连的必要提交，其余 ref 按需展开；这是对 GitKraken Smart Branch Visibility 的只读化借鉴。
- 每个 ref 标签至少要区分 `HEAD`、local、remote-tracking、tag；颜色应辅助而不是成为唯一编码。
- 图与提交列表应共享同一选中态；选中 commit 后文件列表和 diff 原地更新，避免页面跳转。
- “全部分支图”可作为高级视图候选，而不一定占据默认首页。

### 4.3 工作区、暂存区与文件列表

#### 已证实

- GitKraken 在 WIP 的 Commit Panel 中分开显示 staged 与 unstaged files，支持文件、hunk、行级 staging。参考：[GitKraken Staging](https://help.gitkraken.com/gitkraken-desktop/staging/)。
- Sourcetree 的 File Status 明确显示 `Unstaged files` 与 `Staged files`；文件 staged 后会从前者移动到后者。参考：[Sourcetree File Status](https://support.atlassian.com/sourcetree/kb/viewing-file-status-of-a-repository/)。
- Fork 官方确认 commit view 支持行级 stage/unstage，文件列表支持过滤与 combined-list layout，stage view 支持 split view。参考：[Fork 官方产品页](https://git-fork.com/)、[Fork 发布说明](https://git-fork.com/releasenoteswin)。
- GitHub Desktop 的 Changes 以文件复选框和行选择决定下一 commit 包含内容；官方界面并不直接用 `Staged / Unstaged` 两组呈现 Git index。参考：[GitHub Desktop Changes](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop)。
- Sublime Merge 在未选 commit 时，Files 列显示 Unmerged、Modified、Untracked、Staged；Details 内对每个文件显示 diff，并可按文件标签切换。参考：[Sublime Merge Getting Started](https://www.sublimemerge.com/docs/getting_started)。
- Tower 的 Status 列可在同一个文件行中同时表示 staged 与 unstaged，并区分 M/A/?/D/R/C 等状态；Working Copy 还能在“仅变化平铺、仅变化树、全部文件树”之间切换。参考：[Tower Staging Changes](https://www.git-tower.com/help/guides/working-copy/stage-changes/windows)、[Tower Inspecting Changes](https://www.git-tower.com/help/guides/working-copy/inspect-changes/windows)。

#### 对 Oris 的候选启发

- Oris 虽不允许 stage，但仍应准确读取并展示 index。可考虑固定三组：`暂存区`、`工作区`、`未跟踪`，冲突状态另设高优先级组；或者采用 Tower 的单行双状态编码以节省空间。
- 对“同一文件同时有 staged 和 unstaged 变化”的情况，不能只给一个 `M`。至少需要双徽标或两个可选择的 diff 面：`HEAD ↔ Index` 与 `Index ↔ Working Tree`。
- 文件列表适合提供平铺/目录树切换、状态筛选、路径搜索和修改量统计；这些均是只读操作，符合 Oris 边界。
- 不应复用竞品中的 checkbox、加号、拖放等写操作暗示；只读产品更适合使用状态徽标和明确的比较基准标签。

### 4.4 Commit 详情

#### 已证实

- GitKraken 的 Commit Panel 从图上选 commit 进入，提供 commit 信息、文件列表及文件 diff；支持选两 commit 直接比较。参考：[GitKraken Diff](https://help.gitkraken.com/gitkraken-desktop/diff/)。
- Sourcetree commit 详情包含完整 hash、parents、author、date、labels/tags、涉及文件及大部分文件的 diff。参考：[Sourcetree Log/History](https://support.atlassian.com/sourcetree/kb/viewing-log-history-of-a-repository/)。
- Fork 有可折叠 commit details，并支持空格快捷弹出详情；官方早期文章展示其 redesigned commit details 与 to-push/to-pull commit 标识。参考：[Fork 发布说明](https://git-fork.com/releasenoteswin)、[Fork 1.0.73 官方文章](https://git-fork.com/blog/posts/fork-1.0.73/)。
- GitHub Desktop 的 History commit 显示 message、时间、committer、SHA；文件较多时从文件列表选择单个文件看 diff，且可选择连续多个 commit 查看合并范围。参考：[GitHub Desktop branch history](https://docs.github.com/en/enterprise-cloud%40latest/desktop/making-changes-in-a-branch/viewing-the-branch-history-in-github-desktop?platform=windows)。
- Sublime Merge commit details 顶部显示 message、author 等元数据，下方是所有变化文件及各自 diff；选中多个 commit 会显示首尾比较。参考：[Sublime Merge Getting Started](https://www.sublimemerge.com/docs/getting_started)、[Sublime Merge FAQ](https://www.sublimemerge.com/docs/faq)。
- Tower History 的 Changeset 模式显示元数据与详细 changes，Tree 模式则浏览该 revision 的完整文件树。参考：[Tower Interface Overview](https://www.git-tower.com/help/guides/first-steps/tower-overview/windows)。

#### 对 Oris 的候选启发

- commit 详情可拆为“身份信息”和“变化内容”两层：首屏只放 subject、作者、时间、短 SHA、parents、refs、签名状态（若可得）；扩展区再放完整 message 和其他 metadata。
- 文件列表应保留 A/M/D/R/C 类型、路径、增加/删除行数，并能按状态或路径筛选。
- 父 commit 不止一个时，应明确当前 diff 基准（如 `commit vs first parent`），避免 merge commit 的差异语义不透明。
- `Tree` 模式有价值，但相对“直观 diff”优先级较低，可作为下一轮精简候选。

### 4.5 Ahead/behind 与远端状态新鲜度

#### 已证实

- GitKraken 在 Left Panel 显示分支 ahead/behind；官方说明 Fetch All 后展示与远端的距离，且默认每分钟自动 fetch，可在 Preferences 中调整间隔。参考：[GitKraken Push/Pull/Fetch](https://help.gitkraken.com/gitkraken-desktop/pushing-and-pulling/)。
- Sourcetree 在分支旁显示相对 remote counterpart 的 ahead/behind 小徽标；远端状态后台刷新需要启用 `Automatically refresh` 与 `Refresh remote status in background`。参考：[Sourcetree Log/History](https://support.atlassian.com/sourcetree/kb/viewing-log-history-of-a-repository/)、[Sourcetree 远端刷新设置](https://support.atlassian.com/sourcetree/kb/refreshing-repository-according-to-file-changes-and-remote-changes-on-sourcetree/)。
- Fork 官方发布记录确认分支标签有 ahead/behind 箭头，并能突出待 push / 待 pull commits；新版本也出现 pull/push 工具栏徽标。参考：[Fork Mac 发布说明](https://git-fork.com/releasenotes)、[Fork Windows 发布说明](https://git-fork.com/releasenoteswin)、[Fork 1.0.73](https://git-fork.com/blog/posts/fork-1.0.73/)。本轮未从官方资料确认自动 fetch 默认值或“最后成功刷新时间”。
- GitHub Desktop 的仓库栏用 `Push origin N` 表示未推送 commit 数；检查远端的官方步骤是点击 `Fetch origin`，有远端 commit 时再显示 `Pull origin`。参考：[首次仓库流程中的 Push origin 计数](https://docs.github.com/en/desktop/overview/creating-your-first-repository-using-github-desktop)、[Syncing your branch](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/syncing-your-branch-in-github-desktop)。本轮官方资料未显示全分支 ahead/behind 总览或最后 fetch 时间戳。
- Sublime Merge 的 Locations 分支行有 ahead/behind 双计数；官方变更记录确认 `auto_fetch` preference，并允许点击 ahead/behind 指示器执行 push/pull。参考：[Theme 元素对 ahead/behind 的定义](https://www.sublimemerge.com/docs/themes)、[Sublime Merge changelog](https://www.sublimemerge.com/download)。本轮未确认 UI 是否持续显示最后 fetch 时间。
- Tower 在 tracking branch 旁显示 ahead/behind 徽标并可 hover 查看细节；官方功能页说明 fetching 可按需自动执行。参考：[Tower Tracking a Branch](https://www.git-tower.com/help/guides/branches-and-tags/track-branch/windows)、[Tower Feature Overview](https://www.git-tower.com/features/all-features)。本轮未确认最后 fetch 时间是否常驻显示。

#### 对 Oris 的候选启发

- 把以下三件事分开显示，避免一个“同步”图标同时承担多重语义：
  1. `↑n / ↓n`：相对当前本地 remote-tracking ref 的计算结果；
  2. `最后成功 fetch`：该 ref 数据的时间依据；
  3. `刷新状态`：空闲、刷新中、失败、离线、需认证。
- 当尚未 fetch、upstream 缺失或 fetch 失败时，不应显示一个看似确定的 `0/0`。候选状态可为 `未跟踪`、`未知`、`旧数据`。
- 只读并不等于无网络写入：`git fetch` 会更新本地 `.git` 中的 remote-tracking refs 和 FETCH_HEAD。若 Oris 的“只读”定义包含“不改动仓库内部元数据”，则自动 fetch 可能不在范围内；可考虑使用隔离缓存、调用托管服务只读 API，或将 fetch 定义为明确例外。此处是需要用户后续决定的产品边界。

### 4.6 Diff 入口与阅读体验

#### 已证实

- **GitKraken**：可从 WIP 文件、commit 文件进入 diff；Shift 选择两个 commit 可比较；内置 Hunk、Inline、Split 三种模式，带词级差异、语法高亮、minimap、wrap 与变更导航。参考：[GitKraken Diff](https://help.gitkraken.com/gitkraken-desktop/diff/)。
- **Sourcetree**：File Status 中选文件可查看未提交 diff，Log/History 中选 commit 再选文件可看该提交 diff。参考：[File Status](https://support.atlassian.com/sourcetree/kb/viewing-file-status-of-a-repository/)、[Log/History](https://support.atlassian.com/sourcetree/kb/viewing-log-history-of-a-repository/)。
- **Fork**：官方展示 side-by-side diff、diff 内搜索、文件过滤、空格大预览，以及图片 side-by-side/swipe/onion-skin。参考：[Fork 官方产品页](https://git-fork.com/)、[Fork Windows 体验文章](https://git-fork.com/blog/posts/)、[Fork 发布说明](https://git-fork.com/releasenoteswin)。
- **GitHub Desktop**：Changes 和 History 都以文件选择驱动 diff；支持 Unified / Split、隐藏空白变化、展开上下文和展开整文件。参考：[GitHub Desktop Changes 与 diff 设置](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop)。
- **Sublime Merge**：pending changes 与 commit details 中都可连续显示多个文件 diff，也可按文件 tab 聚焦；选择两个 commit 即在详情面板展示首尾差异。参考：[Sublime Merge Getting Started](https://www.sublimemerge.com/docs/getting_started)、[FAQ](https://www.sublimemerge.com/docs/faq)。
- **Tower**：Working Copy 和 History 都可在右侧看内置 diff，并可打开外部 diff；文件列表可切平铺或树状。参考：[Tower Inspecting Changes](https://www.git-tower.com/help/guides/working-copy/inspect-changes/windows)。

#### 对 Oris 的候选启发

- Diff 应是一等视图，而不是最深层弹窗。任何状态对象——工作区、index、commit、commit range、branch vs upstream——都应收敛到同一个 diff 阅读器。
- 每次 diff 顶部必须显示比较式，例如 `Working Tree ↔ Index`、`Index ↔ HEAD`、`a1b2c3d ↔ parent`、`feature ↔ origin/feature`，让用户知道红绿两侧分别是什么。
- 可供下一轮取舍的阅读功能：Unified/Split、行内词级变化、忽略空白、上下文行扩展、整文件、hunk 导航、文件内搜索、折叠未改动区、二进制/图片摘要、重命名识别、过大文件降级提示。
- 为维持轻量，minimap、图片 swipe/onion-skin、外部 diff 集成和多 commit 批量操作可列为“延后/排除”候选。

## 5. 各产品可借鉴与过重设计

### 5.1 GitKraken Desktop

**可借鉴**

- WIP 进入提交图，未提交变化与历史上下文连续。
- 分支 Solo、Pin、Smart Branch Visibility 能控制大图噪声。
- Diff 模式齐全，入口一致；文件历史与 blame 从 diff 延伸。
- ahead/behind 与自动 fetch 有明确文档，刷新周期可配置。

**对 Oris 过重**

- 左侧导航同时承载 remote、PR、worktree、agent、issue/integration 等生态信息。
- 大量图上拖放和上下文菜单会触发 checkout、reset、merge、push 等写操作。
- 内置终端、编辑器、AI、Code Review、Launchpad 等偏离只读核心。

### 5.2 Sourcetree

**可借鉴**

- `File Status / Log-History` 的职责区分明确。
- `Unstaged / Staged` 分组和状态图标对 Git index 的表达直接。
- 左侧 branch/tag/remote 点击即可定位到图上对应 commit。
- ahead/behind 紧邻 branch，并有后台刷新开关。

**对 Oris 过重**

- 顶部工具栏和侧栏暴露大量写操作、stash、submodule、subtree、Git Flow。
- 工作区与历史分属不同主视图，来回核对时上下文可能中断。
- 官方支持页面本身标注 Data Center/旧 Server 适用性提示；布局细节需要后续实机再确认。

### 5.3 Fork

**可借鉴**

- 侧栏、提交图、详情面板紧凑，高信息密度适合熟练用户。
- diff 内搜索、文件过滤、快捷大预览、可折叠详情能减少鼠标移动。
- 分支颜色与图线颜色一致，待 push/pull commits 在图中直接突出。
- 图片 diff 模式说明其 diff-first 产品思路可扩展到非文本资源。

**对 Oris 过重**

- 大量高级写操作：interactive rebase、merge resolver、reflog 恢复、Git-flow、worktree 管理。
- 快捷键和上下文菜单的操作密度高，新用户发现性可能弱。
- 官方帮助体系不如其他产品结构化，部分界面行为只能从发布说明确认。

### 5.4 GitHub Desktop

**可借鉴**

- `Changes / History` 两入口非常克制，主区始终围绕文件和 diff。
- Unified/Split、隐藏空白、展开上下文/整文件覆盖了常见 diff 阅读任务。
- 顶部 current repository/current branch/fetch-or-push 提供持续上下文。
- 空状态清楚，适合引导非 Git 专家。

**对 Oris 的限制或过重部分**

- 缺少全仓拓扑图，不足以满足 Oris 的分支关系可视化目标。
- index 通过“纳入 commit”交互抽象，不能直接满足只读地观察真实 staged/unstaged 状态。
- PR、commit、branch 操作仍是产品主流程的一部分；Oris 应保留其简洁度而非复制流程。

### 5.5 Sublime Merge

**可借鉴**

- `Locations / Commits / Files / Details` 是最完整、稳定的选择链。
- 同一 Details 区复用 pending changes 与 commit details，减少模式切换。
- 多文件 diff 连续展开与单文件 tab 聚焦可兼顾扫描和深读。
- merge commit folding、branch hide/solo 类能力可控制历史图复杂度。
- ahead/behind 在 branch 行直接展示，且支持 auto-fetch preference。

**对 Oris 过重**

- staging、commit editing、interactive rebase、merge tool、自定义命令和 command palette 都超出只读边界。
- 四段布局信息密度高，若不做响应式收缩，容易牺牲 diff 宽度。

### 5.6 Tower（补充）

**可借鉴**

- Status 列把 staged 与 unstaged 同时编码，特别适合复杂文件状态。
- History 的 Changeset/Tree 双模式能区分“看变化”和“看当时全貌”。
- branch 旁 ahead/behind badge hover 解释，兼顾简洁与准确。

**对 Oris 过重**

- 服务集成、PR、Undo、拖放、Branch Review、stacked branches 和完整写操作体系远超范围。
- “自动帮用户完成 Git 操作”是其核心卖点之一，与 Oris 的只读承诺方向不同。

## 6. 可供下一轮选择的功能/UI 候选

以下仅是选择菜单，不是规格或路线图。

### 6.1 建议优先讨论

| 候选 | 参考来源 | 价值 | 主要取舍 |
|---|---|---|---|
| `工作区 / 历史` 两主入口 | GitHub Desktop | 最低认知负担 | 需补分支图入口 |
| 单工作台四段选择链 | Sublime Merge | 上下文连续 | 占横向空间 |
| WIP/Index 虚拟节点进入图 | GitKraken | 统一未提交变化与历史 | 需解释其非 commit 性质 |
| 当前分支聚焦图 + 全图切换 | GitKraken/Sourcetree | 默认降噪、仍保留完整性 | 聚焦算法要透明 |
| staged/unstaged 双状态文件行 | Tower | 复杂状态准确且省空间 | 图标学习成本 |
| 稳定的比较式标题 | 竞品共同不足的补强 | 降低 diff 语义误读 | 需统一所有入口 |
| ahead/behind + 新鲜度 + 刷新状态 | 跨产品缺口 | 提升状态可信度 | 涉及“只读是否允许 fetch”边界 |
| Unified/Split + 词级差异 + hunk 导航 | GitKraken/GitHub Desktop | 直观 diff 的核心体验 | 需处理大文件性能 |
| 文件过滤与 diff 内搜索 | Fork | 大 changeset 中高效定位 | 搜索范围要明确 |

### 6.2 可作为创新方向评估

- **状态可信度条**：把 `本地扫描时间`、`最后成功 fetch`、`remote URL/upstream`、`错误/离线` 放在同一区域，而不是只显示一个刷新图标。
- **只读保证可见化**：界面固定展示“只读模式”，并在帮助中列出会读取的 Git 对象和可能更新的缓存；若 fetch 会改 `.git`，必须如实说明或隔离。
- **比较对象面包屑**：所有 diff 都以对象链展示来源，并允许只读返回上一级，例如 `repo / feature / commit / file`。
- **变化地图而非操作工具栏**：把顶部空间用于文件数、增删行、状态分布、ahead/behind 和新鲜度，而非 commit/push/pull/merge 按钮。
- **渐进式图谱**：默认只画当前 branch、upstream 与 merge base；用户明确展开后再加入其他 refs，避免大型仓库“彩线墙”。

### 6.3 建议精简或排除的竞品设计

- 所有写操作：stage/unstage、discard、commit/amend、checkout、merge、rebase、cherry-pick、stash、reset、push/pull、branch/tag/remote 管理。
- 拖放触发 Git 操作、可写 checkbox、危险操作上下文菜单。
- Git Flow、PR 管理、issue/hosting service 面板、AI commit message、内置终端/编辑器、agent/worktree 编排。
- 第一阶段的 blame、reflog、submodule 管理、Tree-at-revision、图片高级 diff、外部 diff 工具，可先作为独立候选而非默认纳入。

## 7. 未决项

1. Oris 所称“只读”是否允许 `git fetch` 更新仓库内 `.git` 元数据？如果不允许，ahead/behind 的实时性来源必须另行设计。
2. 默认首页更偏向“立即看工作区 diff”还是“先看仓库全局状态/提交图”？这决定两入口、四段工作台或图谱中心三种信息架构的优先级。
3. 是否必须显式区分 `HEAD ↔ Index` 与 `Index ↔ Working Tree`，还是提供聚合 `HEAD ↔ Working Tree` 并允许展开？
4. 提交图默认显示全部 refs，还是只显示当前分支相关子图？
5. ahead/behind 只面向当前分支，还是要在分支列表逐项展示？大量分支的远端新鲜度和计算成本不同。
6. Diff 第一阶段是否需要 Split、词级差异、忽略空白、整文件展开、搜索全部同时具备？哪些可以延后？
7. 是否纳入 binary/image diff、rename/copy detection、submodule pointer diff 与 Git LFS 指针提示？
8. 是否需要展示签名验证、作者邮箱、parents、完整 message、notes 等 commit 元数据？
9. 大仓库的目标规模与性能验收条件尚未给出；本轮不能从竞品营销材料推导性能目标。

## 8. 官方资料索引

### GitKraken Desktop

- [Commit / WIP / Commit Panel](https://help.gitkraken.com/gitkraken-desktop/commits/)
- [Diff、file history、blame](https://help.gitkraken.com/gitkraken-desktop/diff/)
- [Staging 视图](https://help.gitkraken.com/gitkraken-desktop/staging/)
- [Fetch 与 ahead/behind](https://help.gitkraken.com/gitkraken-desktop/pushing-and-pulling/)
- [分支可见性与图谱](https://help.gitkraken.com/gitkraken-desktop/branching-and-merging/)

### Sourcetree

- [File Status](https://support.atlassian.com/sourcetree/kb/viewing-file-status-of-a-repository/)
- [Log/History](https://support.atlassian.com/sourcetree/kb/viewing-log-history-of-a-repository/)
- [文件与远端后台刷新设置](https://support.atlassian.com/sourcetree/kb/refreshing-repository-according-to-file-changes-and-remote-changes-on-sourcetree/)

### Fork

- [产品页与主要界面](https://git-fork.com/)
- [Windows 发布说明](https://git-fork.com/releasenoteswin)
- [Mac 发布说明](https://git-fork.com/releasenotes)
- [Fork 1.0.73：commit details 与 to-push/to-pull 标识](https://git-fork.com/blog/posts/fork-1.0.73/)

### GitHub Desktop

- [Changes 与 diff](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop)
- [History 与 commit diff](https://docs.github.com/en/enterprise-cloud%40latest/desktop/making-changes-in-a-branch/viewing-the-branch-history-in-github-desktop?platform=windows)
- [Fetch/Pull 同步流程](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/syncing-your-branch-in-github-desktop)

### Sublime Merge

- [Getting Started：完整界面结构、pending changes、commit details](https://www.sublimemerge.com/docs/getting_started)
- [FAQ：两 commit diff](https://www.sublimemerge.com/docs/faq)
- [Changelog：auto-fetch、ahead/behind、性能改进（仅作功能存在证据）](https://www.sublimemerge.com/download)
- [Theme 文档：UI 组件与 ahead/behind 元素](https://www.sublimemerge.com/docs/themes)

### Tower

- [Interface Overview](https://www.git-tower.com/help/guides/first-steps/tower-overview/windows)
- [Staging 状态表达](https://www.git-tower.com/help/guides/working-copy/stage-changes/windows)
- [Working Copy 与 diff](https://www.git-tower.com/help/guides/working-copy/inspect-changes/windows)
- [Tracking branch 与 ahead/behind](https://www.git-tower.com/help/guides/branches-and-tags/track-branch/windows)
- [完整功能概览](https://www.git-tower.com/features/all-features)
