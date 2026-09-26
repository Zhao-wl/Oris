# Windows 安装 / 卸载交接清单（一期 06）

状态：**待用户执行**。长链开工时用户选择“安装 / 卸载测试：不允许，只构建”，Oris 自动化只构建了安装包、核对了安装脚本内容，没有在本机安装或卸载。

被测安装包：`Oris_0.1.0_x64-setup.exe`（内部测试包，**未签名**），路径与 SHA-256 见[发布验收结果 · 构建与产物](../validation/v1-06-release-results.md#构建与产物)。执行前先核对 SHA-256：

```powershell
Get-FileHash .\Oris_0.1.0_x64-setup.exe -Algorithm SHA256
```

## 已由自动化核对的内容（不需要重复）

- 安装脚本（Tauri 生成的 `installer.nsi`）：按当前用户安装到 `$LOCALAPPDATA\Oris`；安装主程序、`WebView2Loader.dll`、`THIRD-PARTY-NOTICES.txt`；缺少 WebView2 时下载微软引导程序静默安装；卸载删除上述文件与开始菜单快捷方式，只有勾选“删除应用数据”时才删除 `%APPDATA%\com.oris.viewer` 与 `%LOCALAPPDATA%\com.oris.viewer`。
- 与安装目录相同的文件组合（上述三个文件复制到单独目录）从该目录启动：Git 自动发现、缺 Git、手动路径、低版本提示 10/10 通过。

## 步骤

建议准备一个测试仓库（例如 `D:\oris-install-test\repo 中文`，含一个已修改的文件），不要用重要仓库做卸载测试。

| # | 步骤 | 预期 | 结果 |
| --- | --- | --- | --- |
| W1 | 双击运行安装程序 | SmartScreen 可能提示“未知发布者”（未签名的已知状态，选择“仍要运行”；不要关闭 SmartScreen） | |
| W2 | 完成安装 | 不需要管理员权限；安装位置为 `%LOCALAPPDATA%\Oris`；安装目录中有 `oris.exe`、`WebView2Loader.dll`、`THIRD-PARTY-NOTICES.txt`、`uninstall.exe` | |
| W3 | 从**开始菜单**启动 Oris（不要从终端启动） | 窗口正常显示；没有“找不到 WebView2Loader.dll”之类的系统错误 | |
| W4 | 添加测试仓库 | 文件列表出现；底部显示 Git 版本；设置 → Git 的“实际使用”显示系统 Git 路径 | |
| W5 | 设置 → Git：输入不存在的路径，回车 | 提示“找不到或无法启动 Git（… 不存在）…”，保留原设置 | |
| W6 | 设置 → Git：清空（恢复自动发现） | 校验通过 | |
| W7 | 关闭 Oris，从开始菜单再次打开 | 项目列表与设置恢复；先显示上次快照并标“校验中”，随后刷新 | |
| W8 | “设置 → 应用 → 已安装的应用”中卸载 Oris，**不勾选**“删除应用数据” | 卸载完成；安装目录被删除；**测试仓库目录与内容不变**；`%LOCALAPPDATA%\com.oris.viewer` 仍在 | |
| W9 | 再次运行安装程序并启动 | 项目列表与设置仍在 | |
| W10 | 再次卸载，这次**勾选**“删除应用数据” | `%APPDATA%\com.oris.viewer` 与 `%LOCALAPPDATA%\com.oris.viewer` 被删除；**测试仓库仍不变** | |
| W11（可选） | 缺 Git：临时在设置中指定不存在的路径后重新载入项目 | 打开项目时提示找不到 Git 与处理方法（不修改系统 PATH、不卸载 Git） | |

仓库不变的核对（在 W8 / W10 前后各运行一次，输出应相同）：

```powershell
git -C "D:\oris-install-test\repo 中文" status --porcelain=v2 --branch
```

## 记录

请记录：Windows 版本（`winver`）、安装包 SHA-256、每步结果（通过 / 失败 + 现象）、失败时的截图。结果交给 Oris 写入[发布验收结果](../validation/v1-06-release-results.md)的 A15 行；在此之前该行的安装 / 卸载部分为“未运行（用户未授权安装测试）”。
