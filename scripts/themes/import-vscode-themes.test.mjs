import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseJsonc, loadTheme, highlightRules, generate } from './import-vscode-themes.mjs';
import { resolveDefault, resolveExpression } from './registry.mjs';

test('解析注释、尾逗号，并保留字符串里的注释和逗号', () => {
  assert.deepEqual(parseJsonc('{ // x\n "url":"https://x/,}", /* y */ "values":[1,2,],}'), {
    url: 'https://x/,}', values: [1, 2],
  });
});

test('继承链按子级覆盖颜色，按祖先到子级追加 token 规则', async () => {
  const childPath = 'extensions/theme-defaults/themes/2026-dark.json';
  const [parent, child, raw] = await Promise.all([
    loadTheme('extensions/theme-defaults/themes/dark_modern.json'),
    loadTheme(childPath),
    readFile(new URL(`../../third_party/vscode-themes/${childPath}`, import.meta.url), 'utf8'),
  ]);
  const own = parseJsonc(raw);
  assert.deepEqual(child.colors, { ...parent.colors, ...own.colors });
  assert.deepEqual(child.tokenColors, [...parent.tokenColors, ...own.tokenColors]);
});

test('按主题类型解析引用、透明度、HSL 变亮变暗', () => {
  assert.equal(resolveDefault('contrastActiveBorder', 'hcDark'), '#F38518');
  assert.equal(resolveDefault('inputOption.activeBackground', 'dark'), '#007fd466');
  const buttonColor = resolveDefault('button.background', 'dark');
  for (const op of ['lighten', 'darken']) {
    assert.notEqual(resolveExpression({ op, key: 'button.background', value: 0.2 }, 'dark'), buttonColor, op);
  }
});

test('TextMate scope 使用最长前缀并跳过未知规则', () => {
  const settings = { foreground: '#123456' };
  assert.deepEqual(highlightRules([
    { scope: 'keyword.operator.assignment.js', settings },
    { scope: 'entity.name.function.js', settings },
    { scope: 'unknown.scope', settings },
  ]), [
    { tag: 'function(variableName)', color: '#123456' },
    { tag: 'operatorKeyword', color: '#123456' },
  ]);
});

test('离线重复生成逐字节一致，且恰好 21 套', { timeout: 30_000 }, async (t) => {
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, 'oris-themes-'));
  t.after(async () => {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.equal(resolved, directory);
    await rm(resolved, { recursive: true });
  });

  const beforeDir = path.join(directory, 'before');
  const afterDir = path.join(directory, 'after');
  await generate(beforeDir);
  await generate(afterDir);
  const files = (await readdir(beforeDir)).sort();
  assert.deepEqual((await readdir(afterDir)).sort(), files);
  const themes = JSON.parse(await readFile(path.join(afterDir, 'index.json'), 'utf8'));
  assert.equal(themes.length, 21);
  assert.deepEqual(files, ['index.json', 'NOTICES.txt', 'REPORT.md', ...themes.map(({ id }) => `${id}.json`)].sort());
  for (const file of files) {
    assert.deepEqual(await readFile(path.join(afterDir, file)), await readFile(path.join(beforeDir, file)), file);
  }
});
