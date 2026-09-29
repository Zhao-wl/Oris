# B12 真实远端回归（AgentHub）

日期：2026-09-29。长链 lc4 阶段 3（[任务](../tasks/onetime/long-chain-prune-wrapalign-b12.md)），分支 `test/b12-real`（自 main `b382461`）。只验证 Windows。运行编号 `lc4-20260929`。

结论：**B12 真实远端通过**（SSH 与 HTTPS 的获取、拉取、推送、推送被拒绝、发布分支共 14 项）。真实远端上的“清理…”（B30 的真实远端部分）**未运行（权限拦截）**：命令两次都被会话的自动权限分类器拦下，按规则没有换其他方式执行，已交给用户。A15 的安装 / 卸载按用户答复记录为“用户已自行测试，没有问题”，本机未实测。

## 实现版本

| 项 | 值 |
| --- | --- |
| 被测构建 | `D:\Projects\Research\Oris-builds\lc4\stage2\target\release\oris.exe`（源码 `b382461`，含 v0.4.1 与历史页修复 `613a227`），SHA-256 `FCB8C47D1CC78582F050364A0D8E9DF5C932DEC2F7AB37EE972D314BFB727409`，`verify_release_entry` 通过 |
| 远端 | `git@github.com:Zhao-wl/AgentHub.git`（SSH）、`https://github.com/Zhao-wl/AgentHub.git`（HTTPS，账号 Zhao-wl） |
| 平台与工具 | Windows 11 专业版 10.0.22631；Git 2.44.0.windows.1；WebView2 Runtime 153.0.4234.48；Node v22.18.0 |

说明：该构建复用了阶段 2 的输出目录做增量构建。`scripts/build-release.ps1` 的前端输出目录在仓库外，Vite 不会清空它，旧的带哈希的前端文件会累积并一起嵌入 exe（体积从 41.9 MiB 增长到 44.6 MiB）；入口校验通过，运行时只加载 `index.html` 引用的当前文件，功能不受影响。阶段 4 的最终构建使用全新输出目录。

## 开工与结束时的远端引用

`git ls-remote git@github.com:Zhao-wl/AgentHub.git`（PowerShell）：

| 时间 | 引用 |
| --- | --- |
| 开工前 | `fc9be5c58f3757c75925f6bf977d7dd62f8a6d62 HEAD`、`fc9be5c… refs/heads/main` |
| 每个套件结束时（脚本自检） | 只剩开工时的分支，main 未变 |
| 阶段结束 | 与开工前完全相同 |

只创建过 `oris-test/lc4-20260929/` 下的分支（v1-04 套件的测试分支，与 v2-04 的 `v2-04-ssh`、`v2-04-ssh-new`、`v2-04-https`、`v2-04-https-new`），全部由脚本删除；没有碰 main 或其他分支。没有修改全局 / 系统 Git 配置；HTTPS 克隆只在自身 `.git/config` 设置 `credential.https://github.com.username=Zhao-wl`；没有读取、输出凭据，也没有在弹窗中输入。

## 结果

| 套件 | 结果 | 内容 |
| --- | --- | --- |
| `v1-04-acceptance --only real` | 3/3 通过 | SSH、HTTPS 获取：得到本次测试分支，只改远端跟踪引用；清理后远端只剩开工时的分支 |
| `v2-04-acceptance --only real` | 11/11 通过 | SSH、HTTPS 各自：获取；拉取（仅快进）；推送到测试分支；推送被拒绝（远端已有新提交）时提示先拉取、结果提示提供“拉取”、远端未被改写；首次推送新分支（“发布分支”，只有 origin 时直接发布）并设置上游；清理 |
| `branch-prune-acceptance --only real` | **未运行（权限拦截）** | 两次均在执行前被拦下，AgentHub 未受影响（`ls-remote` 与开工前相同） |

报告：`artifacts/gui-probe/v1-04-acceptance/report-real.json`、`artifacts/gui-probe/v2-04-acceptance/report-real.json`（本地不入库）。每个写操作都有前后指纹证据，只在预期类别变化（远端跟踪引用、HEAD、工作区与 index、上游配置）。

### 执行过程

- 三个套件的第一次启动都被自动权限分类器拦下；`v1-04`、`v2-04` 按约定用 Bash 单条命令重试一次后运行；`branch-prune` 重试后仍被拦，停止该项。
- `v2-04` 第一次运行时，SSH 获取与拉取通过后脚本自身报错：计算仓库指纹时 `.git/index.lock` 在列目录与读属性之间消失（`ENOENT`），后续步骤没有执行（脚本在 finally 中照常删除了测试分支）。原因是网络操作后的刷新会回写 index 的 stat 缓存（V2-D09 允许），短暂持有 `index.lock`。修正 `scripts/perf/gui-fixtures.mjs` 的 `repositoryFingerprint`：遍历途中消失的文件不计入指纹，记在 `transient` 中并写入证据；重跑一次全部通过，本次没有记到临时文件。这是测试脚本问题，不是产品回归。

## A15 安装 / 卸载

按用户答复（2026-09-29）不在本机实测：用户已自行测试安装与卸载，没有问题（口头确认，测试的版本与步骤范围未记录）。已写入 [RC 验收结果](v1-06-rc-results.md) A15 行与 [Windows 安装交接清单](../release/windows-install-checklist.md)。自动更新的原地安装：未运行（需正式签名的更新包，随下一次发版验证）。

## 未验证项

- 真实远端上的“清理…”（`branch-prune-acceptance --only real`）：未运行（权限拦截）。用户可在自己的终端执行：主工作树 `D:\Projects\Research\Oris` 快进到最新 main（`git pull --ff-only`）后，使用保留的最终构建运行
  `node scripts/perf/branch-prune-acceptance.mjs --exe D:/Projects/Research/Oris-builds/final-main-lc4b/target/release/oris.exe --only real --run-id lc4-20260929-user`
  （会在 AgentHub 推送 `oris-test/lc4-20260929-user/prune-a`、`prune-b` 后从远端删除，再在 Oris 中执行“清理…”；结束时脚本核对远端引用与开工时一致。）
- 性能：未测（本轮不做性能测试）。
- macOS：未验证。
- 真实鼠标、键盘与 Windows 焦点：未验证（CDP 页面事件）。
