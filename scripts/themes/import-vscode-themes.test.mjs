import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc, loadTheme, tagForScope, generate, themes } from './import-vscode-themes.mjs';
import { resolveExpression, resolveDefault } from './registry.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

describe('VS Code 配色导入', () => {
  it('解析注释、尾逗号，并保留字符串里的注释和逗号', () => {
    expect(parseJsonc('{ // x\n "url":"https://x/,}", /* y */ "values":[1,2,],}')).toEqual({url:'https://x/,}',values:[1,2]});
  });
  it('继承链按子级覆盖颜色，按祖先到子级追加 token 规则', async () => {
    const parent=await loadTheme('extensions/theme-defaults/themes/dark_modern.json');
    const child=await loadTheme('extensions/theme-defaults/themes/2026-dark.json');
    expect(child.tokenColors.length).toBeGreaterThan(parent.tokenColors.length);
    for(const [key,value] of Object.entries(parent.colors)) if(!Object.hasOwn(parseJsonc(await readFile(path.join(root,'third_party/vscode-themes/extensions/theme-defaults/themes/2026-dark.json'),'utf8')).colors??{},key)) expect(child.colors[key]).toBe(value);
  });
  it('按主题类型解析引用、透明度、HSL 变亮变暗', () => {
    expect(resolveDefault('contrastActiveBorder','hcDark')).toBe('#F38518');
    expect(resolveDefault('inputOption.activeBackground','dark')).toBe('#007fd466');
    expect(resolveExpression({op:'lighten',key:'button.background',value:.2},'dark')).not.toBe(resolveDefault('button.background','dark'));
    expect(resolveExpression({op:'darken',key:'button.background',value:.2},'dark')).not.toBe(resolveDefault('button.background','dark'));
  });
  it('TextMate scope 使用最长前缀', () => {
    expect(tagForScope('keyword.operator.assignment.js')).toBe('operatorKeyword');
    expect(tagForScope('entity.name.function.js')).toBe('function(variableName)');
    expect(tagForScope('unknown.scope')).toBeNull();
  });
  it('离线重复生成逐字节一致，且恰好 21 套', async () => {
    await generate();
    const files=[...themes.map(([id])=>`${id}.json`),'oris-dark.json','oris-light.json','index.json','REPORT.md','NOTICES.txt'];
    const before=await Promise.all(files.map(f=>readFile(path.join(root,'src/themes/generated',f))));
    await generate();
    const after=await Promise.all(files.map(f=>readFile(path.join(root,'src/themes/generated',f))));
    expect(after.every((bytes,i)=>bytes.equals(before[i]))).toBe(true);
    expect(JSON.parse(after.at(-3)).length).toBe(21);
  });
});
