// 仅包含本转换映射及其派生依赖使用的 VS Code 注册表键。
// 每条的 source 指向固定提交 e81ea68fc0228ba2eb01fc9848c30d2e41a26d56 中的定义行。
const base = 'src/vs/platform/theme/common/colors/';
const entry = (file, line, dark, light, hcDark = dark, hcLight = light) => ({ source: `${base}${file}.ts:${line}`, values: { dark, light, hcDark, hcLight } });
const ref = key => ({ ref: key });
const alpha = (key, value) => ({ op: 'transparent', key, value });
const lighten = (key, value) => ({ op: 'lighten', key, value });
const darken = (key, value) => ({ op: 'darken', key, value });

export const registry = {
  'foreground': entry('baseColors', 13, '#CCCCCC', '#616161', '#FFFFFF', '#292929'),
  'descriptionForeground': entry('baseColors', 29, alpha('foreground', .7), '#717171', alpha('foreground', .7), alpha('foreground', .7)),
  'errorForeground': entry('baseColors', 25, '#F48771', '#A1260D', '#F48771', '#B5200D'),
  'focusBorder': entry('baseColors', 37, '#007FD4', '#0090F1', '#F38518', '#006BBD'),
  'contrastBorder': entry('baseColors', 41, null, null, '#6FC3DF', '#0F4A85'),
  'contrastActiveBorder': entry('baseColors', 45, null, null, ref('focusBorder'), ref('focusBorder')),
  'editor.background': entry('editorColors', 19, '#1E1E1E', '#ffffff', '#000000', '#ffffff'),
  'editor.foreground': entry('editorColors', 23, '#BBBBBB', '#333333', '#ffffff', ref('foreground')),
  'editorLineNumber.foreground': { source: 'src/vs/editor/common/core/editorColorRegistry.ts:30', values: { dark: '#858585', light: '#237893', hcDark: '#ffffff', hcLight: '#292929' } },
  'editorError.foreground': entry('editorColors', 70, '#F14C4C', '#E51400', '#F48771', '#B5200D'),
  'editorWarning.foreground': entry('editorColors', 83, '#CCA700', '#BF8803', '#FFD370', '#895503'),
  'editor.selectionBackground': entry('editorColors', 121, '#264F78', '#ADD6FF', '#f3f518', '#0F4A85'),
  'editor.selectionForeground': entry('editorColors', 125, null, null, '#000000', '#ffffff'),
  'editor.selectionHighlightBackground': entry('editorColors', 133, { op: 'lessProminent', key: 'editor.selectionBackground', background: 'editor.background', value: .3, transparency: .6 }, { op: 'lessProminent', key: 'editor.selectionBackground', background: 'editor.background', value: .3, transparency: .6 }, null, null),
  'editor.findMatchBackground': entry('editorColors', 148, '#515C6A', '#A8AC94', null, null),
  'editor.findMatchHighlightBackground': entry('editorColors', 156, '#EA5C0055', '#EA5C0055', null, null),
  'diffEditor.insertedTextBackground': entry('editorColors', 270, '#9ccc2c33', '#9ccc2c40', null, null),
  'diffEditor.removedTextBackground': entry('editorColors', 274, '#ff000033', '#ff000033', null, null),
  'diffEditor.insertedLineBackground': entry('editorColors', 279, '#9bb95533', '#9bb95533', null, null),
  'diffEditor.removedLineBackground': entry('editorColors', 283, '#ff000033', '#ff000033', null, null),
  'widget.shadow': entry('editorColors', 339, '#0000005c', '#00000029', null, null),
  'scrollbarSlider.background': entry('miscColors', 56, '#79797966', '#64646466', alpha('contrastBorder', .6), alpha('contrastBorder', .4)),
  'scrollbarSlider.hoverBackground': entry('miscColors', 60, '#646464b3', '#646464b3', alpha('contrastBorder', .8), alpha('contrastBorder', .8)),
  'scrollbarSlider.activeBackground': entry('miscColors', 64, '#bfbfbf66', '#00000099', ref('contrastBorder'), ref('contrastBorder')),
  'panel.background': { source: 'src/vs/workbench/common/theme.ts:493', values: { dark: ref('editor.background'), light: ref('editor.background'), hcDark: ref('editor.background'), hcLight: ref('editor.background') } },
  'panel.border': { source: 'src/vs/workbench/common/theme.ts:495', values: { dark: '#80808059', light: '#80808059', hcDark: ref('contrastBorder'), hcLight: ref('contrastBorder') } },
  'sideBar.background': { source: 'src/vs/workbench/common/theme.ts:621', values: { dark: '#252526', light: '#F3F3F3', hcDark: '#000000', hcLight: '#ffffff' } },
  'sideBar.border': { source: 'src/vs/workbench/common/theme.ts:630', values: { dark: null, light: null, hcDark: ref('contrastBorder'), hcLight: ref('contrastBorder') } },
  'editorGroupHeader.tabsBackground': { source: 'src/vs/workbench/common/theme.ts:219', values: { dark: '#252526', light: '#F3F3F3', hcDark: null, hcLight: null } },
  'editorGroup.border': { source: 'src/vs/workbench/common/theme.ts:237', values: { dark: '#444444', light: '#E7E7E7', hcDark: ref('contrastBorder'), hcLight: ref('contrastBorder') } },
  'titleBar.activeBackground': { source: 'src/vs/workbench/common/theme.ts:777', values: { dark: '#3C3C3C', light: '#DDDDDD', hcDark: '#000000', hcLight: '#ffffff' } },
  'statusBar.background': { source: 'src/vs/workbench/common/theme.ts:299', values: { dark: '#007ACC', light: '#007ACC', hcDark: null, hcLight: null } },
  'statusBar.foreground': { source: 'src/vs/workbench/common/theme.ts:290', values: { dark: '#ffffff', light: '#ffffff', hcDark: '#ffffff', hcLight: ref('editor.foreground') } },
  'list.hoverBackground': entry('listColors', 65, '#2A2D2E', '#F0F0F0', '#ffffff1a', '#0F4A851a'),
  'list.activeSelectionBackground': entry('listColors', 33, '#04395E', '#0060C0', null, '#0F4A851a'),
  'list.activeSelectionForeground': entry('listColors', 37, '#ffffff', '#ffffff', null, null),
  'input.background': entry('inputColors', 20, '#3C3C3C', '#ffffff', '#000000', '#ffffff'),
  'input.foreground': entry('inputColors', 24, ref('foreground'), ref('foreground'), ref('foreground'), ref('foreground')),
  'input.border': entry('inputColors', 28, null, null, ref('contrastBorder'), ref('contrastBorder')),
  'inputOption.activeBorder': entry('inputColors', 32, '#007ACC', '#007ACC', ref('contrastBorder'), ref('contrastBorder')),
  'inputOption.activeBackground': entry('inputColors', 40, alpha('focusBorder', .4), alpha('focusBorder', .2), '#00000000', '#00000000'),
  'dropdown.background': entry('inputColors', 94, '#3C3C3C', '#ffffff', '#000000', '#ffffff'),
  'dropdown.foreground': entry('inputColors', 102, '#F0F0F0', ref('foreground'), '#ffffff', ref('foreground')),
  'dropdown.border': entry('inputColors', 106, ref('dropdown.background'), '#CECECE', ref('contrastBorder'), ref('contrastBorder')),
  'button.foreground': entry('inputColors', 113, '#ffffff', '#ffffff', '#ffffff', '#ffffff'),
  'button.background': entry('inputColors', 121, '#0E639C', '#007ACC', '#000000', '#0F4A85'),
  'button.hoverBackground': entry('inputColors', 125, lighten('button.background', .2), darken('button.background', .2), ref('button.background'), ref('button.background')),
  'button.secondaryForeground': entry('inputColors', 133, ref('foreground'), ref('foreground'), '#ffffff', ref('foreground')),
  'button.secondaryBackground': entry('inputColors', 137, ref('list.hoverBackground'), ref('list.hoverBackground'), null, '#ffffff'),
  'editorGutter.modifiedBackground': { source: 'src/vs/workbench/contrib/scm/common/quickDiff.ts:25', values: { dark: '#1B81A8', light: '#2090D3', hcDark: '#1B81A8', hcLight: '#2090D3' } },
  'editorGutter.addedBackground': { source: 'src/vs/workbench/contrib/scm/common/quickDiff.ts:33', values: { dark: '#487E02', light: '#48985D', hcDark: '#487E02', hcLight: '#48985D' } },
  'editorGutter.deletedBackground': { source: 'src/vs/workbench/contrib/scm/common/quickDiff.ts:41', values: { dark: ref('editorError.foreground'), light: ref('editorError.foreground'), hcDark: ref('editorError.foreground'), hcLight: ref('editorError.foreground') } },
  'gitDecoration.modifiedResourceForeground': { source: 'extensions/git/package.json:4161', values: { dark: '#E2C08D', light: '#895503', hcDark: '#E2C08D', hcLight: '#895503' } },
  'gitDecoration.untrackedResourceForeground': { source: 'extensions/git/package.json:4191', values: { dark: '#73C991', light: '#007100', hcDark: '#73C991', hcLight: '#007100' } },
  'gitDecoration.conflictingResourceForeground': { source: 'extensions/git/package.json:4231', values: { dark: '#e4676b', light: '#ad0707', hcDark: '#c74e39', hcLight: '#ad0707' } },
};

export const registrySources = Object.fromEntries(Object.entries(registry).map(([key, value]) => [key, value.source]));

export function resolveDefault(key, type, overrides = {}, seen = new Set()) {
  if (overrides[key] != null) return overrides[key];
  if (seen.has(key)) throw new Error(`颜色引用成环: ${key}`);
  const item = registry[key];
  if (!item) return null;
  seen.add(key);
  const value = resolveExpression(item.values[type], type, overrides, seen);
  seen.delete(key);
  return value;
}

export function resolveExpression(expr, type, overrides = {}, seen = new Set()) {
  if (expr == null || typeof expr === 'string') return expr;
  const color = resolveDefault(expr.key ?? expr.ref, type, overrides, seen);
  if (!expr.op) return color;
  if (!color) return null;
  const [r, g, b, a] = rgba(color);
  if (expr.op === 'transparent') return hex(r, g, b, Math.round(a * expr.value));
  if (expr.op === 'lessProminent') {
    const bg = resolveDefault(expr.background, type, overrides, seen);
    if (!bg) return hex(r,g,b,Math.round(a*expr.value*expr.transparency));
    const [br,bgGreen,bb] = rgba(bg);
    const lum = v => { const c=v/255; return c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4; };
    const l1=.2126*lum(r)+.7152*lum(g)+.0722*lum(b), l2=.2126*lum(br)+.7152*lum(bgGreen)+.0722*lum(bb);
    const factor=l1<l2 ? expr.value*(l2-l1)/l2 : expr.value*(l1-l2)/l1;
    const changed=adjustHsl(r,g,b,l1<l2 ? factor : -factor);
    return hex(...changed,Math.round(a*expr.transparency));
  }
  if (!['lighten','darken'].includes(expr.op)) throw new Error(`未知派生运算: ${expr.op}`);
  return hex(...adjustHsl(r,g,b,expr.op==='lighten'?expr.value:-expr.value),a);
}

function adjustHsl(r,g,b,factor) {
  const x=[r,g,b].map(v=>v/255), max=Math.max(...x), min=Math.min(...x), d=max-min;
  let h=0,s=0,l=(max+min)/2;
  if(d){ s=d/(1-Math.abs(2*l-1)); h=max===x[0]?((x[1]-x[2])/d)%6:max===x[1]?(x[2]-x[0])/d+2:(x[0]-x[1])/d+4; h=(h*60+360)%360; }
  l=Math.max(0,Math.min(1,l+l*factor));
  const c=(1-Math.abs(2*l-1))*s, q=c*(1-Math.abs((h/60)%2-1)), m=l-c/2;
  const values=h<60?[c,q,0]:h<120?[q,c,0]:h<180?[0,c,q]:h<240?[0,q,c]:h<300?[q,0,c]:[c,0,q];
  return values.map(v=>(v+m)*255);
}

export function rgba(color) {
  const h = color.replace('#', '');
  if (![3, 4, 6, 8].includes(h.length)) throw new Error(`无效颜色: ${color}`);
  const full = h.length < 6 ? [...h].map(c => c + c).join('') : h;
  return [0, 2, 4, 6].map((i) => i === 6 && full.length === 6 ? 255 : parseInt(full.slice(i, i + 2), 16));
}
export function hex(r, g, b, a = 255) {
  return '#' + [r, g, b, a].slice(0, a === 255 ? 3 : 4).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
