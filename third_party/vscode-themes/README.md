# VS Code 内置配色来源

固定来源：`microsoft/vscode` 提交 `e81ea68fc0228ba2eb01fc9848c30d2e41a26d56`。`extensions/` 下的 19 个 JSON/JSONC 文件保持仓库原始路径与原始字节；`LICENSE.txt` 和 `ThirdPartyNotices.txt` 也保持原始字节。下载接口为 GitHub Contents API，使用 base64 解码后直接写入。

| 范围 | 源路径 |
| --- | --- |
| 10 套默认主题 | `extensions/theme-defaults/themes/{2026-dark,2026-light,dark_modern,dark_plus,dark_vs,hc_black,hc_light,light_modern,light_plus,light_vs}.json` |
| 9 套扩展主题 | `extensions/theme-{abyss,kimbie-dark,monokai,monokai-dimmed,quietlight,red,solarized-dark,solarized-light,tomorrow-night-blue}/themes/`，具体文件名见该目录 |
| VS Code MIT 许可 | `LICENSE.txt` |
| 第三方通知 | `ThirdPartyNotices.txt` |

`Colorsublime-Themes-NOTICE.txt` 是从完整第三方通知中摘取的该项目段落，方便发布包单独收录。9 套扩展主题的该段通知保留了 Colorsublime.com 版权与 MIT 许可。转换脚本的注册表默认值在 `scripts/themes/registry.mjs` 中按键注明了同一提交中的源码位置。
