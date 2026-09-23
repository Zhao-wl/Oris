#!/usr/bin/env node
// 只在仓库外创建可重复的 Git 压测夹具。用法：node generate-datasets.mjs S|L [--output 绝对路径]
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const sizes = { S: { tracked: 10000, commits: 20000, changed: 100 }, L: { tracked: 100000, commits: 100000, changed: 2000 } };
const kind = process.argv[2];
if (!sizes[kind]) throw Error('用法：node generate-datasets.mjs S|L [--output 绝对路径]');
const outputArg = process.argv.indexOf('--output');
const root = path.resolve(outputArg < 0 ? path.join(tmpdir(), 'oris-perf', kind) : process.argv[outputArg + 1]);
if (!path.isAbsolute(root) || root === path.parse(root).root) throw Error('输出目录必须是安全的绝对路径');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (root.toLowerCase().startsWith(project.toLowerCase() + path.sep)) throw Error('测试仓库不能放在 Oris 仓库内');
for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
  if (existsSync(path.join(dir, '.git'))) throw Error(`输出目录位于已有仓库内：${dir}`);
  if (dir === path.dirname(dir)) break;
}
if (existsSync(root)) throw Error(`目标已存在，拒绝覆盖：${root}`);
const { tracked, commits, changed } = sizes[kind];
const seed = 20260923;
let randomState = seed;
function random() { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState; }
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw Error(`git ${args.join(' ')}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}
function file(i) {
  if (kind === 'L') return `tracked/${String(Math.floor(i / 1000)).padStart(3, '0')}/${String(i % 1000).padStart(4, '0')}.txt`;
  return `tracked/${String(i).padStart(6, '0')}.txt`;
}
function write(rel, content) { const full = path.join(root, rel); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, content); }
function rename(oldRel, newRel) { const target = path.join(root, newRel); mkdirSync(path.dirname(target), { recursive: true }); renameSync(path.join(root, oldRel), target); }
const counts = { staged: changed / 5, unstaged: changed / 5, both: changed / 5, untracked: changed / 10, deleted: changed / 10, renamed: changed / 10, conflicted: changed / 10 };
// 100 和 2000 均可被 10 整除。
const start = Date.now();
mkdirSync(root, { recursive: true });
git(['init', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);
git(['config', 'user.name', 'Oris Perf']);
git(['config', 'user.email', 'oris-perf@example.invalid']);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Oris Perf', GIT_AUTHOR_EMAIL: 'oris-perf@example.invalid', GIT_COMMITTER_NAME: 'Oris Perf', GIT_COMMITTER_EMAIL: 'oris-perf@example.invalid' };
const importer = spawn('git', ['fast-import', '--quiet'], { cwd: root, env, stdio: ['pipe', 'ignore', 'pipe'] });
let importError = '';
importer.stderr.on('data', b => { importError += b.toString(); });
async function put(s) { if (!importer.stdin.write(s)) await once(importer.stdin, 'drain'); }
try {
  await put('blob\nmark :1\ndata 5\nbase\n\nblob\nmark :2\ndata 8\nchanged\n\n');
  const uniqueBlob = i => i < 100 || i >= tracked - changed;
  for (let i = 0; i < tracked; i++) {
    if (!uniqueBlob(i)) continue;
    const data = `file ${i}\n`;
    await put(`blob\nmark :${i + 3}\ndata ${Buffer.byteLength(data)}\n${data}\n`);
  }
  const firstDate = 1700000000;
  await put(`commit refs/heads/main\nauthor Oris Perf <oris-perf@example.invalid> ${firstDate} +0000\ncommitter Oris Perf <oris-perf@example.invalid> ${firstDate} +0000\ndata 7\ninitial\n`);
  for (let i = 0; i < tracked; i++) await put(`M 100644 :${uniqueBlob(i) ? i + 3 : 1} ${file(i)}\n`);
  await put('M 100644 inline .gitignore\ndata 14\nnode_modules/\n\n');
  for (let n = 1; n < commits; n++) {
    const id = random() % Math.min(tracked - changed - 2, 8192);
    const timestamp = firstDate + n;
    await put(`\ncommit refs/heads/main\nauthor Oris Perf <oris-perf@example.invalid> ${timestamp} +0000\ncommitter Oris Perf <oris-perf@example.invalid> ${timestamp} +0000\ndata ${String(n).length + 2}\nc${n}\nM 100644 :${n % 2 ? 2 : 1} ${file(id)}\n`);
    if (n % 10000 === 0) process.stderr.write(`fast-import ${n}/${commits}\n`);
  }
  importer.stdin.end();
  const [code] = await once(importer, 'close');
  if (code !== 0) throw Error(`fast-import 失败：${importError}`);
  git(['reset', '--hard', 'main']);
  const first = tracked - changed;
  let at = first;
  const manifest = [];
  const add = (type, rel, oldPath = null) => manifest.push({ type, path: rel, ...(oldPath ? { oldPath } : {}) });
  const stagedPaths = [];
  for (let i = 0; i < counts.staged; i++, at++) { const p = file(at); write(p, `staged ${seed} ${i}\n`); stagedPaths.push(p); add('staged', p); }
  for (let i = 0; i < counts.unstaged; i++, at++) { const p = file(at); write(p, `unstaged ${seed} ${i}\n`); add('unstaged', p); }
  const bothPaths = [];
  for (let i = 0; i < counts.both; i++, at++) { const p = file(at); write(p, `both staged ${seed} ${i}\n`); bothPaths.push(p); add('both', p); }
  for (let i = 0; i < stagedPaths.length + bothPaths.length; i += 500) git(['add', '--', ...stagedPaths.concat(bothPaths).slice(i, i + 500)]);
  for (let i = 0; i < bothPaths.length; i++) write(bothPaths[i], `both working ${seed} ${i}\n`);
  for (let i = 0; i < counts.untracked; i++) { const p = `new/untracked-${String(i).padStart(5, '0')}.txt`; write(p, `untracked ${seed} ${i}\n`); add('untracked', p); }
  const deletedStaged = [];
  for (let i = 0; i < counts.deleted; i++, at++) { const p = file(at); unlinkSync(path.join(root, p)); if (i % 2) deletedStaged.push(p); add(i % 2 ? 'deleted-staged' : 'deleted-unstaged', p); }
  if (deletedStaged.length) git(['add', '-u', '--', ...deletedStaged]);
  const renamePaths = [];
  for (let i = 0; i < counts.renamed; i++, at++) { const p = file(at), to = `renamed/item-${String(i).padStart(5, '0')}.txt`; rename(p, to); renamePaths.push(p, to); add('renamed', to, p); }
  for (let i = 0; i < renamePaths.length; i += 500) git(['add', '-A', '--', ...renamePaths.slice(i, i + 500)]);
  // update-index --index-info 精确构造三个非 0 stage，不依赖平台外部 merge 工具。
  const baseOid = git(['rev-parse', `HEAD:${file(0)}`]);
  const oursOid = git(['hash-object', '-w', '--stdin'], { input: 'ours\n' });
  const theirsOid = git(['hash-object', '-w', '--stdin'], { input: 'theirs\n' });
  let conflictInput = '';
  for (let i = 0; i < counts.conflicted; i++, at++) {
    const p = file(at);
    conflictInput += `0 0000000000000000000000000000000000000000\t${p}\n100644 ${baseOid} 1\t${p}\n100644 ${oursOid} 2\t${p}\n100644 ${theirsOid} 3\t${p}\n`;
    write(p, `<<<<<<< ours\n${i}\n=======\n${i + 1}\n>>>>>>> theirs\n`);
    add('conflicted', p);
  }
  git(['update-index', '--index-info'], { input: conflictInput });
  for (let i = 0; i < 10000; i++) write(`node_modules/ignored-${String(i).padStart(5, '0')}.txt`, 'ignored\n');
  const report = { generator: 'generate-datasets.mjs', kind, root, seed, tracked, commits, changed, layout: kind === 'L' ? 'sharded-1000' : 'flat', counts, ignored: 10000, gitVersion: git(['--version']), head: git(['rev-parse', 'HEAD']), elapsedMs: Date.now() - start, manifest };
  writeFileSync(path.join(root, 'oris-perf-manifest.json'), JSON.stringify(report, null, 2));
  // 元数据放到 .git 内，避免本身被当成 untracked。
  renameSync(path.join(root, 'oris-perf-manifest.json'), path.join(root, '.git', 'oris-perf-manifest.json'));
  console.log(JSON.stringify({ root, kind, tracked, commits, changed, ignored: 10000, elapsedMs: report.elapsedMs, manifest: path.join(root, '.git', 'oris-perf-manifest.json') }));
} catch (e) { importer.kill(); console.error(e); process.exitCode = 1; }
