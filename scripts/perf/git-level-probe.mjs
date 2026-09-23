#!/usr/bin/env node
// 用法：node git-level-probe.mjs <测试仓库绝对路径> [--iterations 30] [--out JSON绝对路径]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const repo = path.resolve(process.argv[2] || '');
const opt = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const iterations = Number(opt('--iterations', '30'));
const out = path.resolve(opt('--out', path.join(repo, '.git', 'oris-perf-probe.json')));
if (!existsSync(path.join(repo, '.git', 'oris-perf-manifest.json'))) throw Error('仅接受生成器创建的测试仓库');
if (!Number.isInteger(iterations) || iterations < 30) throw Error('每项至少 30 次');
const manifest = JSON.parse(readFileSync(path.join(repo, '.git', 'oris-perf-manifest.json'), 'utf8'));
const prefix = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'diff.trustExitCode=false', '-C', repo];
const environment = { ...process.env, GIT_EXTERNAL_DIFF: '', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1' };
async function git(args, { input, normalLocks = false } = {}) {
  const command = normalLocks ? prefix.slice(1) : prefix;
  const started = performance.now();
  const child = spawn('git', [...command, ...args], { cwd: repo, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdout = [], stderr = [];
  child.stdout.on('data', b => stdout.push(b));
  child.stderr.on('data', b => stderr.push(b));
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const elapsedMs = performance.now() - started;
  if (code !== 0) throw Error(`git ${args.join(' ')} 退出 ${code}: ${Buffer.concat(stderr).toString()}`);
  return { bytes: Buffer.concat(stdout), elapsedMs };
}
const scopeArgs = scope => scope === 'staged' ? ['--cached'] : scope === 'all' ? ['HEAD'] : [];
function nameArgs(scope) { return ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', ...scopeArgs(scope), '--']; }
function statArgs(scope) { return ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', ...scopeArgs(scope), '--']; }
const others = ['ls-files', '--others', '--exclude-standard', '-z', '--'];
const unmerged = ['ls-files', '--unmerged', '-z', '--'];
const statusArgs = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames'];
const strings = b => b.toString('utf8').split('\0').filter(Boolean);
const normalize = c => ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'renamed', T: 'typeChanged', U: 'conflicted', '?': 'untracked' })[c] || null;
function oldSet(parts, scope) {
  const result = new Map(), fields = strings(parts[0]);
  for (let i = 0; i < fields.length;) {
    const status = fields[i++][0];
    if (status === 'R' || status === 'C') { const oldPath = fields[i++], p = fields[i++]; result.set(p, { status: 'renamed', oldPath }); }
    else { const p = fields[i++]; result.set(p, { status: normalize(status) }); }
  }
  let next = 1;
  if (scope !== 'staged') { for (const p of strings(parts[next++])) result.set(p, { status: 'untracked' }); }
  for (const field of strings(parts[next])) { const tab = field.indexOf('\t'); if (tab >= 0) result.set(field.slice(tab + 1), { status: 'conflicted' }); }
  return result;
}
function parseV2(bytes) {
  const fields = strings(bytes), entries = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record.startsWith('# ')) continue;
    const type = record[0];
    if (type === '1') { const p = record.split(' ', 9); entries.push({ type, xy: p[1], path: p[8] }); }
    else if (type === '2') { const p = record.split(' ', 10); entries.push({ type, xy: p[1], path: p[9], oldPath: fields[++i] }); }
    else if (type === 'u') { const p = record.split(' ', 11); entries.push({ type, xy: p[1], path: p[10] }); }
    else if (type === '?') entries.push({ type, path: record.slice(2) });
    else if (type === '!') continue;
    else throw Error(`未知 porcelain v2 记录: ${record.slice(0, 80)}`);
  }
  return entries;
}
function v2Set(entries, scope) {
  const result = new Map();
  for (const e of entries) {
    if (e.type === 'u') { result.set(e.path, { status: 'conflicted' }); continue; }
    if (e.type === '?') { if (scope !== 'staged') result.set(e.path, { status: 'untracked' }); continue; }
    const x = e.xy[0], y = e.xy[1];
    let code = scope === 'staged' ? x : scope === 'unstaged' ? y : (y !== '.' ? y : x);
    if (code === '.') continue;
    const rename = e.type === '2' && x === 'R' && scope !== 'unstaged';
    if (rename) code = 'R';
    result.set(e.path, { status: normalize(code), ...(rename ? { oldPath: e.oldPath } : {}) });
  }
  return result;
}
function differences(old, next) {
  const result = [];
  for (const p of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(p), b = next.get(p);
    if (JSON.stringify(a) !== JSON.stringify(b)) result.push({ path: p, old: a || null, v2: b || null });
  }
  return result;
}
async function oldRun(scope) {
  const args = [nameArgs(scope), ...(scope === 'staged' ? [] : [others]), unmerged, statArgs(scope)];
  const outputs = [];
  const start = performance.now();
  for (const a of args) outputs.push((await git(a)).bytes);
  return { elapsedMs: performance.now() - start, outputs, commands: args.length };
}
async function newRun() {
  const start = performance.now();
  const status = await git(statusArgs);
  const statusMs = performance.now() - start;
  const [unstagedStats, stagedStats] = await Promise.all([git(statArgs('unstaged')), git(statArgs('staged'))]);
  return { elapsedMs: performance.now() - start, statusMs, status: status.bytes, statMs: [unstagedStats.elapsedMs, stagedStats.elapsedMs] };
}
function percentile(samples, p) { const sorted = [...samples].sort((a, b) => a - b); return sorted[Math.ceil(p * sorted.length) - 1]; }
function summary(samples) { return { n: samples.length, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), minMs: Math.min(...samples), maxMs: Math.max(...samples) }; }
async function oldThreeSamples() {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    for (const scope of ['unstaged', 'staged', 'all']) await oldRun(scope);
    samples.push(performance.now() - start);
  }
  return { ...summary(samples), samplesMs: samples, commands: 11 };
}
if (process.argv.includes('--group-only')) {
  if (!existsSync(out)) throw Error('group-only 需要已有的完整探针 JSON');
  const existing = JSON.parse(readFileSync(out, 'utf8'));
  existing.warm.oldThreeScopes = await oldThreeSamples();
  writeFileSync(out, JSON.stringify(existing, null, 2));
  console.log(JSON.stringify({ out, oldThreeScopes: existing.warm.oldThreeScopes }));
  process.exit(0);
}
const results = { metadata: { dataset: manifest.kind, root: repo, manifest: path.join(repo, '.git', 'oris-perf-manifest.json'), iterations, machine: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0].model, logicalCores: cpus().length, ramBytes: totalmem() }, gitVersion: (await git(['--version'])).bytes.toString().trim(), nodeVersion: process.version, startedAt: new Date().toISOString(), cache: '未清空 OS 缓存；firstPass 仅是生成后首次执行，warm 为同仓库连续重复执行' }, firstPass: {}, warm: {}, consistency: {} };
for (const scope of ['unstaged', 'staged', 'all']) {
  const a = await oldRun(scope), b = await newRun();
  const diff = differences(oldSet(a.outputs, scope), v2Set(parseV2(b.status), scope));
  results.consistency[scope] = { oldCount: oldSet(a.outputs, scope).size, statusCount: v2Set(parseV2(b.status), scope).size, differenceCount: diff.length, differences: diff };
  results.firstPass[`old-${scope}`] = a.elapsedMs;
  results.firstPass[`new-after-${scope}`] = { totalMs: b.elapsedMs, statusMs: b.statusMs };
  const samples = [];
  for (let i = 0; i < iterations; i++) samples.push((await oldRun(scope)).elapsedMs);
  results.warm[`old-${scope}`] = { ...summary(samples), samplesMs: samples, commands: a.commands };
  console.error(`${manifest.kind} old ${scope}: ${samples.length} 次`);
}
const newSamples = [], statusSamples = [];
for (let i = 0; i < iterations; i++) { const r = await newRun(); newSamples.push(r.elapsedMs); statusSamples.push(r.statusMs); }
results.warm.newTotal = { ...summary(newSamples), samplesMs: newSamples, commands: 3 };
results.warm.newStatusOnly = { ...summary(statusSamples), samplesMs: statusSamples, commands: 1 };
results.warm.oldThreeScopes = await oldThreeSamples();
// 全部范围的工作区 rename 需要懒执行这条命令。测量它，但不混进单次 status 主路径。
const lazy = [];
for (let i = 0; i < iterations; i++) lazy.push((await git(nameArgs('all'))).elapsedMs);
results.warm.allRenameCorrection = { ...summary(lazy), samplesMs: lazy };
// 从根提交选 100 个不同的 blob；后续提交可能改动同一文件，不能只按 HEAD 路径抽样。
const rootCommit = (await git(['rev-list', '--max-parents=0', 'HEAD'])).bytes.toString().trim().split('\n')[0];
const tree = strings((await git(['ls-tree', '-r', '-z', rootCommit])).bytes);
const oids = [...new Set(tree.filter(x => x.includes('\ttracked/')).map(x => x.split(' ')[2].split('\t')[0]))].slice(0, 100);
if (oids.length !== 100) throw Error('不足 100 个 blob');
const singles = [], batches = [];
async function batch() { const input = oids.join('\n') + '\n'; return git(['cat-file', '--batch'], { input }); }
results.firstPass.blobSingle100 = (await (async () => { const s = performance.now(); for (const oid of oids) await git(['cat-file', 'blob', oid]); return performance.now() - s; })());
results.firstPass.blobBatch100 = (await batch()).elapsedMs;
for (let i = 0; i < iterations; i++) {
  const s = performance.now(); for (const oid of oids) await git(['cat-file', 'blob', oid]); singles.push(performance.now() - s);
  batches.push((await batch()).elapsedMs);
}
results.warm.blobSingle100 = { ...summary(singles), samplesMs: singles, processStarts: 100, uniqueOidCount: new Set(oids).size };
results.warm.blobBatch100 = { ...summary(batches), samplesMs: batches, processStarts: 1, uniqueOidCount: new Set(oids).size, note: '每次新建一个 --batch 进程处理 100 个 OID；未计入跨请求常驻启动摊销' };
// touch 只作用于生成器记录的测试仓库。每轮 touch 同一批 5000 文件，保持内容不变。
const touchPaths = [];
function trackedPath(i) { return manifest.layout === 'sharded-1000' ? `tracked/${String(Math.floor(i / 1000)).padStart(3, '0')}/${String(i % 1000).padStart(4, '0')}.txt` : `tracked/${String(i).padStart(6, '0')}.txt`; }
for (let i = 100; i < Math.min(manifest.tracked - manifest.changed, 5100); i++) touchPaths.push({ path: trackedPath(i) });
const fs = await import('node:fs');
async function touch() { const now = new Date(Date.now() + 2000); for (const item of touchPaths) fs.utimesSync(path.join(repo, item.path), now, now); }
const dirty = [], rewritten = [];
for (let i = 0; i < iterations; i++) { await touch(); dirty.push((await git(statusArgs)).elapsedMs); await git(statusArgs, { normalLocks: true }); rewritten.push((await git(statusArgs)).elapsedMs); }
results.warm.statDirtyNoLocks = { ...summary(dirty), samplesMs: dirty, touchedFiles: touchPaths.length };
results.warm.statAfterWriteback = { ...summary(rewritten), samplesMs: rewritten, touchedFiles: touchPaths.length };
results.metadata.finishedAt = new Date().toISOString();
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ out, dataset: manifest.kind, consistency: Object.fromEntries(Object.entries(results.consistency).map(([k,v]) => [k, v.differenceCount])), p95Ms: Object.fromEntries(Object.entries(results.warm).map(([k,v]) => [k, v.p95Ms])) }));
