# 研究 09：成熟 Git 客户端的获取 / 拉取 / 推送交互

日期：2026-09-28。起因：用户反馈 V2-04 同步功能层级深（“同步 ▾”弹层 → 行按钮 → 确认对话框）、三个对话框风格不统一、弹层打开有等待。本研究只回答“同类产品怎么做”，结论用于 [同步工具栏改版参考图](../design/06-sync-toolbar-ui.md)。

资料来源为官方文档与公开 issue 的检索摘要；未在官方文档中直接确认的标“未核实”。

## 各产品要点

| 产品 | 入口 | 点击后 | 何时才弹窗 | 进度 / 结果 | 拉取策略 |
|---|---|---|---|---|---|
| GitHub Desktop | 顶栏单一主按钮，随状态变为 Fetch / Pull / Push / Publish branch；副标题“Last fetched X ago”与领先/落后数 | 直接执行 | rebase、force push、冲突；刻意不做“一键推拉”（issue #598：旧 Sync 按钮让人害怕） | 按钮内转圈；错误用横幅 / 对话框 | 跟随 git 配置，不每次问 |
| VS Code | 状态栏 Sync（`↓n ↑m`）；面板 `…` 菜单有独立 Pull / Push / Fetch；无上游时变 Publish Branch | Sync 默认先确认一次（`git.confirmSync`），可关 | 无上游询问发布；推送被拒提示先拉取 | 状态栏转圈；toast 通知 | 设置里一次配置 |
| JetBrains | 工具栏 fetch、Update Project（Ctrl+T）、Push（Ctrl+Shift+K）；分支弹层显示领先/落后 | Update 默认弹 Merge/Rebase，可勾“不再询问”；Push 走预览对话框 | 工作区脏时提示 stash / shelve | 底部进度条可取消；气泡通知带后续动作按钮 | 设置里一次配置 |
| Fork | 工具栏 Fetch / Pull / Push 三按钮，带角标 | 默认弹 sheet（记住上次设置）；**按住 Alt 点击直接执行** | — | 按钮置灰、状态栏进度，可取消 | 对话框勾选并记忆 |
| Sourcetree | 工具栏三按钮，按钮上叠加 incoming/outgoing 数 | 弹对话框 | force push 需先在设置里打开 | — | 对话框选，可设默认 |
| GitKraken | 工具栏 Pull（带 ▾）/ Push；Fetch 在 Pull 下拉 | **直接执行**；▾ 里选 ff-if-possible / ff-only / rebase，选项前圆点设为默认 | 远端分支不存在时询问创建 | — | ▾ 内“默认 + 单次覆盖” |
| Tower | 工具栏三按钮，带计数徽标 | —（未核实） | 工作区脏时主动提议 stash | — | 未核实 |
| lazygit | 键位 `f` / `p` / `P` | 直接执行 | 无上游时询问；需要 force 时确认 | 底部 loading | — |

自动获取：GitKraken 1 分钟、Sourcetree 10 分钟、Fork 20 分钟默认开启；VS Code 默认关闭，理由是后台凭据弹窗来源不明（issue #34684）。

## 共识

1. **默认直接执行，弹窗只留给真正的决策点**：无上游首次推送、推送被拒、分叉需选合并方式、工作区改动阻止。
2. **状态写在按钮上**：领先/落后数是标配；“上次获取 X 前”成本低、消歧强。
3. **拉取策略一次配置**：▾ 内设默认（GitKraken）或“不再询问”（JetBrains），而不是每次选。
4. **进度不挡界面、可取消**；按钮执行中置灰或变为取消。
5. **失败提示附带下一步动作**（推送被拒 →“拉取”；分叉 →“改用合并”）。
6. **高级选项藏在 ▾ 或修饰键后**，主按钮服务常见路径。

## 对 Oris 的结论

- 采用三个独立按钮（用户 2026-09-28 选定），不用单一变形按钮。
- 点主按钮直接执行；V2-04 已有的“改用合并”“stash 后拉取”确认保留，这是真正的决策点。
- 拉取默认仅快进，▾ 内单选即设为默认（用户选定）。
- 自动获取暂不做（用户选定），用“上次获取 X 前”提示。本机有两个 GCM 账号，后台获取可能弹出来源不明的凭据窗口，与 VS Code 默认关闭的理由一致。
- 不借鉴 force push 相关设计（V2-D04）。

## 来源

- [GitHub Docs：Syncing your branch in GitHub Desktop](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/syncing-your-branch-in-github-desktop)；[desktop/desktop #598](https://github.com/desktop/desktop/issues/598)
- [VS Code：Source Control](https://code.visualstudio.com/docs/sourcecontrol/overview)；[microsoft/vscode #34684](https://github.com/microsoft/vscode/issues/34684)
- [JetBrains：Sync with a remote Git repository](https://www.jetbrains.com/help/idea/sync-with-a-remote-repository.html)
- [GitKraken：Push, Pull, and Fetch](https://help.gitkraken.com/gitkraken-desktop/pushing-and-pulling/)
- [Fork Release Notes](https://git-fork.com/releasenotes)；[fork-dev/TrackerWin #2165](https://github.com/fork-dev/TrackerWin/issues/2165)
- [Atlassian SRCTREE-5791](https://jira.atlassian.com/browse/SRCTREE-5791)
- [Tower：Inspecting Remote Data](https://www.git-tower.com/learn/git/ebook/en/desktop-gui/remote-repositories/inspecting-remote-data/)
- [lazygit Keybindings](https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md)
