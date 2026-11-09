# 0.9.6 暂存列表闪烁修复

日期：2026-11-09。

## 复现与原因

暂存 / 取消暂存先乐观移动条目，操作返回的轻量快照可能 statsReady=false。旧实现立即发布轻量快照并清空上一 revision 的统计，随后异步 repositoryDetails 恢复统计与 contentUnchanged 标记，导致原本折叠的文件短暂展开、排序与数字跳变。

另外 FileTree 根据是否有 contentUnchanged 文件在 FileList 与 Fragment 之间切换。折叠区出现或消失时，主 FileList 的组件身份变化，未修改的文件行也会被卸载再创建。

修改前新增的两个回归测试均失败：暂存等待统计时 c.txt 意外出现在列表；折叠区变化导致 b.txt / 其他稳定文件行的 DOM 身份改变。复现日志：artifacts-staging-repro.log。

## 修复

- 保留立即移动所选文件的反馈；暂存确认快照与对应 revision 的统计一起发布，期间保留乐观列表。
- 统计失败或 revision 不匹配时仍使用 Git 的权威结果，不回滚已成功的暂存，不使用过期统计。
- 主列表与折叠区使用固定位置及 key；空折叠区不显示，但不通过结构切换重建主列表。

## 验证

- TypeScript 编译通过。
- 定向测试 60/60 通过：暂存 / 取消暂存时保留其余文件行身份和统计；保留滚动位置；统计失败、revision 不匹配不撤销成功结果。
- 完整 Vitest：54 个文件通过、1 个跳过；466 项通过、1 项跳过。
- 本轮为 DOM 与模拟后端回归测试，没有启动原生 Oris 窗口，没有执行真实 Windows 焦点切换。
- 没有修改或恢复旧危险窗口调用；此前已禁用的原生抢焦点入口保持禁用。本轮未操作其他应用窗口。

## 交付

版本 0.9.6。PowerShell 构建，使用仅限当前进程的精简 PATH。
构建日志 artifacts-staging-package.log；安装包和免安装 ZIP 位于 artifacts/releases/0.9.6/。

构建成功：release、内嵌资源检查 ENTRY_ASSETS_PASS、NSIS 安装包均通过。ZIP 包含主程序、WebView2Loader.dll、README 和第三方许可证；没有执行安装程序或启动 Oris。
