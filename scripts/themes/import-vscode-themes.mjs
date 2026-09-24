import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { registry, resolveDefault, rgba, hex } from './registry.mjs';

export const commit = 'e81ea68fc0228ba2eb01fc9848c30d2e41a26d56';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'third_party/vscode-themes');
const output = path.join(root, 'src/themes/generated');

export const themes = [
  ['dark-2026','Dark 2026','dark','theme-defaults/themes/2026-dark.json'],
  ['light-2026','Light 2026','light','theme-defaults/themes/2026-light.json'],
  ['dark-modern','Dark Modern','dark','theme-defaults/themes/dark_modern.json'],
  ['light-modern','Light Modern','light','theme-defaults/themes/light_modern.json'],
  ['dark-plus','Dark+','dark','theme-defaults/themes/dark_plus.json'],
  ['light-plus','Light+','light','theme-defaults/themes/light_plus.json'],
  ['dark-vs','Dark (Visual Studio)','dark','theme-defaults/themes/dark_vs.json'],
  ['light-vs','Light (Visual Studio)','light','theme-defaults/themes/light_vs.json'],
  ['hc-dark','Dark High Contrast','hcDark','theme-defaults/themes/hc_black.json'],
  ['hc-light','Light High Contrast','hcLight','theme-defaults/themes/hc_light.json'],
  ['abyss','Abyss','dark','theme-abyss/themes/abyss-color-theme.json'],
  ['kimbie-dark','Kimbie Dark','dark','theme-kimbie-dark/themes/kimbie-dark-color-theme.json'],
  ['monokai','Monokai','dark','theme-monokai/themes/monokai-color-theme.json'],
  ['monokai-dimmed','Monokai Dimmed','dark','theme-monokai-dimmed/themes/dimmed-monokai-color-theme.json'],
  ['quiet-light','Quiet Light','light','theme-quietlight/themes/quietlight-color-theme.json'],
  ['red','Red','dark','theme-red/themes/Red-color-theme.json'],
  ['solarized-dark','Solarized Dark','dark','theme-solarized-dark/themes/solarized-dark-color-theme.json'],
  ['solarized-light','Solarized Light','light','theme-solarized-light/themes/solarized-light-color-theme.json'],
  ['tomorrow-night-blue','Tomorrow Night Blue','dark','theme-tomorrow-night-blue/themes/tomorrow-night-blue-color-theme.json'],
];

export function parseJsonc(text) {
  let clean = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; clean += c; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; clean += '\n'; }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; clean += ' '; }
    else clean += c;
  }
  let withoutTrailing = '', inString = false, escape = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inString) { withoutTrailing += c; if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') inString = false; }
    else if (c === '"') { inString = true; withoutTrailing += c; }
    else if (c === ',') { let j=i+1; while (/\s/.test(clean[j]??'')) j++; if (clean[j] !== '}' && clean[j] !== ']') withoutTrailing += c; }
    else withoutTrailing += c;
  }
  return JSON.parse(withoutTrailing);
}

export async function loadTheme(file, chain = new Set()) {
  const full = path.resolve(source, file);
  if (!full.startsWith(source + path.sep)) throw new Error(`主题越界: ${file}`);
  if (chain.has(full)) throw new Error(`include 循环: ${file}`);
  chain.add(full);
  const own = parseJsonc(await readFile(full, 'utf8'));
  let parent = { colors: {}, tokenColors: [] };
  if (own.include) parent = await loadTheme(path.relative(source, path.resolve(path.dirname(full), own.include)), chain);
  chain.delete(full);
  return { ...parent, ...own, colors: { ...parent.colors, ...own.colors }, tokenColors: [...(parent.tokenColors ?? []), ...(own.tokenColors ?? [])] };
}

// 显式列出 TextMate 前缀与可传给 @lezer/highlight tags 的标识。
export const scopeTags = {
  'comment': 'comment', 'punctuation.definition.comment': 'comment',
  'string.regexp': 'regexp', 'string': 'string', 'constant.character.escape': 'escape',
  'constant.numeric': 'number', 'constant.language.boolean': 'bool', 'constant.language.null': 'null',
  'constant': 'atom', 'keyword.control': 'controlKeyword', 'keyword.operator': 'operatorKeyword',
  'keyword': 'keyword', 'storage.type': 'definitionKeyword', 'storage.modifier': 'modifier',
  'entity.name.function': 'function(variableName)', 'support.function': 'function(variableName)',
  'entity.name.type': 'typeName', 'entity.name.class': 'className', 'support.class': 'className',
  'entity.name.tag': 'tagName', 'entity.other.attribute-name': 'attributeName',
  'variable.parameter': 'variableName', 'variable.language': 'self', 'variable': 'variableName',
  'support.type': 'typeName', 'support.constant': 'atom', 'punctuation': 'punctuation',
  'invalid': 'invalid', 'markup.heading': 'heading', 'markup.bold': 'strong', 'markup.italic': 'emphasis',
};
export function tagForScope(scope) {
  return Object.entries(scopeTags).filter(([prefix]) => scope === prefix || scope.startsWith(prefix + '.'))
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))[0]?.[1] ?? null;
}
export function highlightRules(tokenColors) {
  const chosen = new Map();
  tokenColors.forEach((rule, index) => {
    const scopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? rule.scope.split(',') : [];
    for (const scope of scopes.map(s => s.trim())) {
      const tag = tagForScope(scope);
      if (!tag || !rule.settings) continue;
      const specificity = Object.keys(scopeTags).filter(p => scope === p || scope.startsWith(p + '.')).sort((a,b) => b.length-a.length)[0]?.length ?? 0;
      const old = chosen.get(tag);
      if (!old || specificity > old.specificity || specificity === old.specificity && index > old.index)
        chosen.set(tag, { specificity, index, color: rule.settings.foreground ?? null, fontStyle: rule.settings.fontStyle ?? null });
    }
  });
  return [...chosen].sort(([a],[b]) => a.localeCompare(b)).map(([tag, v]) => ({ tag, ...(v.color ? { color: v.color } : {}), ...(v.fontStyle ? { fontStyle: v.fontStyle } : {}) }));
}

// §9.3 的完整映射；数组按优先级回退。值为 null 的注册表默认值不会遮蔽后续回退。
export const mapping = {
  '--bg':['editor.background'], '--panel':['sideBar.background','panel.background','editor.background'],
  '--chrome':['titleBar.activeBackground','editorGroupHeader.tabsBackground','sideBar.background','editor.background'],
  '--text':['editor.foreground','foreground'], '--dim':['descriptionForeground','foreground'],
  '--line-number':['editorLineNumber.foreground','descriptionForeground'],
  '--border':['panel.border','sideBar.border','editorGroup.border','contrastBorder','focusBorder'],
  '--hover':['list.hoverBackground','editor.selectionBackground'],
  '--selection':['list.activeSelectionBackground','editor.selectionBackground'],
  '--selection-text':['list.activeSelectionForeground','editor.foreground'],
  '--blue':['focusBorder','button.background'],
  '--button-bg':['button.background'], '--button-text':['button.foreground'],
  '--button-secondary-bg':['button.secondaryBackground','list.hoverBackground'],
  '--button-secondary-text':['button.secondaryForeground','foreground'],
  '--input-bg':['input.background','dropdown.background'], '--input-text':['input.foreground','dropdown.foreground'],
  '--input-border':['input.border','dropdown.border','contrastBorder','focusBorder'],
  '--dropdown-bg':['dropdown.background','input.background'], '--dropdown-text':['dropdown.foreground','input.foreground'],
  '--dropdown-border':['dropdown.border','input.border','contrastBorder','focusBorder'],
  '--toggle-on':['inputOption.activeBackground','list.activeSelectionBackground'],
  '--toggle-on-border':['inputOption.activeBorder','focusBorder'], '--toggle-off':['input.background','editor.background'],
  '--status-bg':['statusBar.background','editor.background'], '--status-text':['statusBar.foreground','foreground'],
  '--text-selection':['editor.selectionBackground'], '--text-selection-fg':['editor.selectionForeground','editor.foreground'],
  '--same-word':['editor.selectionHighlightBackground','editor.selectionBackground'],
  '--search-match':['editor.findMatchBackground','editor.selectionBackground'],
  '--search-other':['editor.findMatchHighlightBackground','editor.findMatchBackground'],
  '--warning':['editorWarning.foreground'], '--error':['errorForeground'],
  '--status-modified':['gitDecoration.modifiedResourceForeground','editorGutter.modifiedBackground'],
  '--status-added':['gitDecoration.untrackedResourceForeground','editorGutter.addedBackground'],
  '--status-conflicted':['gitDecoration.conflictingResourceForeground','errorForeground'],
  '--scrollbar':['scrollbarSlider.background','descriptionForeground'],
  '--scrollbar-hover':['scrollbarSlider.hoverBackground','foreground'],
  '--scrollbar-active':['scrollbarSlider.activeBackground','foreground'],
  '--widget-shadow':['widget.shadow'],
};

export function mix(a, b, weight = .5) {
  const x = rgba(a), y = rgba(b);
  return hex(...[0,1,2].map(i => x[i] * weight + y[i] * (1-weight)));
}
export function withAlpha(color, alpha) { const c = rgba(color); return hex(c[0],c[1],c[2],Math.round(alpha*255)); }
export function resolveTheme(colors, type) {
  const get = key => colors[key] ?? resolveDefault(key, type, colors);
  const pick = (...keys) => keys.map(get).find(v => v != null) ?? null;
  const variables = Object.fromEntries(Object.entries(mapping).map(([name, keys]) => [name, pick(...keys)]));
  const bg = variables['--bg'], fg = variables['--text'];
  const modified = pick('editorGutter.modifiedBackground');
  const added = pick('editorGutter.addedBackground');
  const gray = mix(fg, bg, .48);
  variables['--status-deleted'] = gray;
  variables['--status-renamed'] = variables['--status-modified'];
  variables['--status-type-changed'] = variables['--status-modified'];
  // 强调色（描边、当前命中文字、概览轨道视口）：样式表回退值是 Oris 原配色，
  // 所以 VS Code 方案必须给出明确值；来源没有定义时用透明 / 当前文字色，与 VS Code 的外观一致。
  const hc = type.startsWith('hc');
  variables['--search-match-border'] = pick('editor.findMatchBorder') ?? (hc ? pick('contrastActiveBorder') : null) ?? 'transparent';
  variables['--search-other-border'] = pick('editor.findMatchHighlightBorder') ?? (hc ? pick('contrastBorder') : null) ?? 'transparent';
  variables['--search-match-text'] = pick('editor.findMatchForeground') ?? 'currentColor';
  variables['--selection-outline'] = hc ? pick('contrastActiveBorder') ?? 'transparent' : 'transparent';
  variables['--same-word-border'] = pick('editor.selectionHighlightBorder') ?? 'transparent';
  variables['--overview-viewport-bg'] = pick('scrollbarSlider.background') ?? 'transparent';
  variables['--overview-viewport-border'] = pick('scrollbarSlider.hoverBackground') ?? 'transparent';
  variables['--overview-viewport-active'] = pick('scrollbarSlider.activeBackground') ?? 'transparent';
  variables['--overview-viewport-shadow'] = 'transparent';
  // 高对比方案在 VS Code 中不定义其他命中底色与浮层阴影（靠描边区分）；给透明值，避免落到样式表中的 Oris 回退色。
  if (hc) { variables['--search-other'] ??= 'transparent'; variables['--widget-shadow'] ??= 'transparent'; }
  const oris = {
    modified: { marker: modified, line: withAlpha(modified, .23), word: withAlpha(modified, .34) },
    added: { marker: added, line: pick('diffEditor.insertedLineBackground') ?? withAlpha(added,.2), word: pick('diffEditor.insertedTextBackground') ?? withAlpha(added,.3) },
    deleted: { marker: gray, line: withAlpha(gray,.22), word: withAlpha(gray,.35) },
  };
  const vscode = {
    added: { marker: added, line: pick('diffEditor.insertedLineBackground') ?? withAlpha(added,.2), word: pick('diffEditor.insertedTextBackground') ?? withAlpha(added,.3) },
    deleted: { marker: pick('editorGutter.deletedBackground'), line: pick('diffEditor.removedLineBackground') ?? withAlpha(pick('editorGutter.deletedBackground'),.2), word: pick('diffEditor.removedTextBackground') ?? withAlpha(pick('editorGutter.deletedBackground'),.3) },
  };
  return { variables, diff: { oris, vscode }, ...(type.startsWith('hc') ? { contrastBorder: pick('contrastBorder'), contrastActiveBorder: pick('contrastActiveBorder') } : {}) };
}

function composite(foreground, background) {
  const f=rgba(foreground), b=rgba(background), a=f[3]/255;
  return [0,1,2].map(i => f[i]*a+b[i]*(1-a));
}
function luminance(rgb) { const v=rgb.map(c => { const s=c/255; return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4; }); return .2126*v[0]+.7152*v[1]+.0722*v[2]; }
export function contrast(fg, bg, base = '#ffffff') {
  const back=composite(bg,base), front=composite(fg,hex(...back));
  const a=luminance(front), b=luminance(back);
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}
// B21 要求“无未说明的不达标项”：每条不达标都给出原因。移植忠实于来源（V2-D21），不改色值。
function explain(theme) {
  if (theme.startsWith('oris-')) return 'V1 已确认的 Oris 配色，保持不变；次要文字只用于辅助信息';
  if (theme.startsWith('solarized-')) return '与 VS Code 原主题一致（Solarized 本身为低对比设计），逐色移植不改色';
  return '与 VS Code 原主题一致，逐色移植不改色';
}
function reportLine(theme, label, foreground, background, threshold, base = '#ffffff') {
  if (!foreground || !background) return `| ${theme} | ${label} | 缺色 | — | ${explain(theme)} |`;
  const ratio=contrast(foreground,background,base);
  return ratio < threshold ? `| ${theme} | ${label} | ${ratio.toFixed(2)}:1 | ${threshold}:1 | ${explain(theme)} |` : null;
}

async function orisTheme(id, name, type, light) {
  const css=await readFile(path.join(root,'src/styles.css'),'utf8');
  // 默认变量块：深色在 `:root { --bg… }`，浅色在 `:root.theme-light { … }`（V2-06 起颜色收拢为变量）。
  const block=css.match(light ? /:root\.theme-light\s*\{([^}]*)\}/ : /:root\s*\{(\s*--bg[^}]*)\}/)?.[1];
  if (!block) throw new Error(`找不到 ${id} 的 CSS 变量`);
  const variables=Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map(([,k,v])=>[k,v.trim()]));
  // 颜色可能写成 `var(--status-x, #回退)`：取回退色，即 Oris 原配色。
  const color=String.raw`color:\s*(?:var\(--[\w-]+,\s*)?(#[0-9a-fA-F]+)`;
  const status=css.match(new RegExp(String.raw`\.status\s*\{[^}]*` + color))?.[1];
  const statusClass=key=>css.match(new RegExp(String.raw`\.status\.` + key + String.raw`[^{}]*\{\s*` + color))?.[1];
  if (!status || !statusClass('added') || !statusClass('deleted')) throw new Error('找不到 Oris 文件状态颜色');
  Object.assign(variables, {
    '--status-modified':status, '--status-added':statusClass('added'),
    '--status-deleted':statusClass('deleted'), '--status-renamed':statusClass('renamed'),
    '--status-type-changed':statusClass('typeChanged'), '--status-conflicted':statusClass('conflicted'),
  });
  const selectionRule=light ? /:root\.theme-light \.diff-host \.cm-content ::selection\s*\{([^}]*)\}/ : /\n\.diff-host \.cm-content ::selection\s*\{([^}]*)\}/;
  const selection=css.match(selectionRule)?.[1];
  if (!selection) throw new Error(`找不到 ${id} 的选区颜色`);
  variables['--text-selection']=selection.match(/background:\s*(?:var\(--[\w-]+,\s*)?(#[0-9a-fA-F]+)/)?.[1] ?? null;
  variables['--text-selection-fg']=selection.match(/(?:^|;)\s*color:\s*(?:var\(--[\w-]+,\s*)?(#[0-9a-fA-F]+)/)?.[1] ?? null;
  const line=light ? { modified:'#e2edfb',added:'#e3f2df',deleted:'#e7e7e8' } : { modified:'#283d53aa',added:'#294436aa',deleted:'#3c3f41' };
  const marker=light ? { modified:'#6a9de6',added:'#74ad78',deleted:'#9ca0a8' } : { modified:'#548af7',added:'#4f9f64',deleted:'#85888f' };
  const diff={ oris:Object.fromEntries(['modified','added','deleted'].map(k=>[k,{marker:marker[k],line:line[k],word:k==='modified'?variables['--diff-word-bg']:withAlpha(marker[k],.34)}])) };
  return { id,name,type,source:{kind:'oris',path:'src/styles.css'},variables,diff:{...diff,vscode:null},highlight:[] };
}

export async function generate() {
  await mkdir(output,{recursive:true});
  const index=[], failed=[], missing=new Set();
  for (const [id,name,type,file] of themes) {
    const theme=await loadTheme(`extensions/${file}`);
    const data={id,name,type,source:{kind:'vscode',commit,path:`extensions/${file}`},...resolveTheme(theme.colors??{},type),highlight:highlightRules(theme.tokenColors??[])};
    for (const [variable, keys] of Object.entries(mapping)) if (!data.variables[variable]) missing.add(`${id}: ${variable} ← ${keys.join(' → ')}`);
    await writeFile(path.join(output,`${id}.json`),JSON.stringify(data,null,2)+'\n');
    index.push({id,name,type,source:data.source,preview:['--bg','--panel','--text','--blue','--status-added','--status-modified'].map(k=>data.variables[k])});
    const v=data.variables,bg=v['--bg'];
    for (const [label,fg,b,limit,base] of [
      ['正文',v['--text'],bg,4.5],['次要文字',v['--dim'],v['--panel'],4.5],
      ['选中文字',v['--text-selection-fg'],v['--text-selection'],4.5,bg],
      ...['modified','added','deleted'].map(k=>[`diff ${k} 词级`,v['--text'],data.diff.oris[k].word,4.5,bg]),
    ]) { const line=reportLine(id,label,fg,b,limit,base); if(line) failed.push(line); }
  }
  for (const [id,name,type,light] of [['oris-dark','Oris 深色','dark',false],['oris-light','Oris 浅色','light',true]]) {
    const data=await orisTheme(id,name,type,light);
    await writeFile(path.join(output,`${id}.json`),JSON.stringify(data,null,2)+'\n');
    index.push({id,name,type,source:data.source,preview:['--bg','--panel','--text','--blue'].map(k=>data.variables[k])});
    const v=data.variables;
    for(const [label,fg,b,base] of [['正文',v['--text'],v['--bg']],['次要文字',v['--dim'],v['--panel']],['选中文字',v['--text-selection-fg'],v['--text-selection'],v['--bg']],...['modified','added','deleted'].map(k=>[`diff ${k} 词级`,v['--text'],data.diff.oris[k].word,v['--bg']])]) { const line=reportLine(id,label,fg,b,4.5,base); if(line) failed.push(line); }
  }
  await writeFile(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');
  const report=['# 配色对比度报告','',`来源：microsoft/vscode ${commit}；Oris 原配色取自 src/styles.css。`,'','标准：普通文字 WCAG AA 4.5:1；半透明颜色按背景合成后计算。diff 词级检查文字对叠加色背景的对比度。','', '## 未达标或缺色','', '| 方案 | 项目 | 实测 | 阈值 | 说明 |','| --- | --- | ---: | ---: | --- |',...(failed.length?failed:['| — | 无 | — | — | — |']),'','## 映射后缺色','',...(missing.size?[...missing].sort().map(s=>`- ${s}${/^hc-/.test(s)?'（高对比方案在 VS Code 中也不定义该色：搜索命中改用 --search-other-border 描边，浮层不用阴影）':''}`):['- 无']),'','说明：报告只记录问题，不自动修正色值。选区前景缺省时使用 editor.foreground；实际选区半透明背景按编辑器背景合成。',''].join('\n');
  await writeFile(path.join(output,'REPORT.md'),report);
  // B22：发布包内含许可声明。原文逐字收录，随前端打包进 exe，在设置窗口中可查看。
  const vscodeLicense=(await readFile(path.join(source,'LICENSE.txt'),'utf8')).replace(/\r\n/g,'\n').trim();
  const colorsublime=(await readFile(path.join(source,'Colorsublime-Themes-NOTICE.txt'),'utf8')).replace(/\r\n/g,'\n').trim();
  const notices=[
    'Oris 配色方案的第三方许可声明',
    '',
    `19 套配色方案转换自 microsoft/vscode（提交 ${commit}）的内置主题；其中 9 套扩展主题（Abyss、Kimbie Dark、Monokai、Monokai Dimmed、Quiet Light、Red、Solarized Dark、Solarized Light、Tomorrow Night Blue）源自 Colorsublime-Themes。`,
    '',
    '==== Visual Studio Code ====',
    '',
    vscodeLicense,
    '',
    '==== Colorsublime-Themes ====',
    '',
    colorsublime,
    '',
  ].join('\n');
  await writeFile(path.join(output,'NOTICES.txt'),notices);
  return {count:index.length,failures:failed.length,missing:missing.size};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(await generate());
