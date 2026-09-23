# 配色对比度报告

来源：microsoft/vscode e81ea68fc0228ba2eb01fc9848c30d2e41a26d56；Oris 原配色取自 src/styles.css。

标准：普通文字 WCAG AA 4.5:1；半透明颜色按背景合成后计算。diff 词级检查文字对叠加色背景的对比度。

## 未达标或缺色

| 方案 | 项目 | 实测 | 阈值 |
| --- | --- | ---: | ---: |
| dark-2026 | 选中文字 | 3.94:1 | 4.5:1 |
| light-plus | 次要文字 | 4.40:1 | 4.5:1 |
| light-vs | 次要文字 | 4.40:1 | 4.5:1 |
| abyss | 选中文字 | 3.26:1 | 4.5:1 |
| abyss | diff modified 词级 | 3.73:1 | 4.5:1 |
| abyss | diff added 词级 | 3.52:1 | 4.5:1 |
| kimbie-dark | 选中文字 | 4.04:1 | 4.5:1 |
| quiet-light | 次要文字 | 4.36:1 | 4.5:1 |
| solarized-dark | 选中文字 | 3.25:1 | 4.5:1 |
| solarized-dark | diff modified 词级 | 3.15:1 | 4.5:1 |
| solarized-dark | diff added 词级 | 3.13:1 | 4.5:1 |
| solarized-dark | diff deleted 词级 | 3.73:1 | 4.5:1 |
| solarized-light | 正文 | 4.13:1 | 4.5:1 |
| solarized-light | 次要文字 | 3.98:1 | 4.5:1 |
| solarized-light | 选中文字 | 3.64:1 | 4.5:1 |
| solarized-light | diff modified 词级 | 2.82:1 | 4.5:1 |
| solarized-light | diff added 词级 | 3.59:1 | 4.5:1 |
| solarized-light | diff deleted 词级 | 3.40:1 | 4.5:1 |
| oris-dark | 次要文字 | 4.18:1 | 4.5:1 |
| oris-light | 次要文字 | 4.22:1 | 4.5:1 |

## 映射后缺色

- hc-dark: --search-other ← editor.findMatchHighlightBackground → editor.findMatchBackground
- hc-dark: --widget-shadow ← widget.shadow
- hc-light: --search-other ← editor.findMatchHighlightBackground → editor.findMatchBackground
- hc-light: --widget-shadow ← widget.shadow

说明：报告只记录问题，不自动修正色值。选区前景缺省时使用 editor.foreground；实际选区半透明背景按编辑器背景合成。
