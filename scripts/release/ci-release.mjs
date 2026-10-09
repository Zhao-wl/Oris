// 双平台构建共用版本准备、更新签名核验和汇总逻辑；此脚本不读取本机密钥文件。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const mode = process.env.RELEASE_MODE;
const configPath = 'src-tauri/tauri.conf.json';
const rootVersion = () => json('package.json').version;
export function verifySignature(file, signature, pubkey, version) {
  const pub = Buffer.from(Buffer.from(pubkey, 'base64').toString('utf8').trim().split(/\r?\n/)[1], 'base64');
  const lines = Buffer.from(signature, 'base64').toString('utf8').trim().split(/\r?\n/);
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  if (pub.length !== 42 || sig.length !== 74 || sig.subarray(0, 2).toString() !== 'ED' || !pub.subarray(2, 10).equals(sig.subarray(2, 10))) throw Error('签名数据或公钥 ID 不匹配');
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10)]), format: 'der', type: 'spki' });
  const digest = crypto.createHash('blake2b512').update(readFileSync(file)).digest();
  if (!crypto.verify(null, digest, key, sig.subarray(10))) throw Error(`产物签名无效：${file}`);
  if (!lines[2]?.startsWith('trusted comment: ') || !lines[2].split(/\s+/).includes(`version:${version}`)) throw Error('签名中的版本不匹配');
  if (!crypto.verify(null, Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice(17))]), key, Buffer.from(lines[3] ?? '', 'base64'))) throw Error('版本注释签名无效');
}

function prepare() {
  if (!['check', 'publish'].includes(mode)) throw Error('未知发布模式');
  if (mode === 'check') return;
  const next = process.env.RELEASE_VERSION;
  const current = rootVersion();
  if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) throw Error('版本号必须为 x.y.z');
  const a = next.split('.').map(Number), b = current.split('.').map(Number);
  const differing = a.findIndex((part, index) => part !== b[index]);
  if (differing < 0 || a[differing] < b[differing]) throw Error(`新版本必须大于 ${current}`);
  if (!process.env.RELEASE_NOTES?.trim()) throw Error('正式发布必须提供说明');
  const tags = spawnSync('git', ['tag', '--list', `v${next}`], { encoding: 'utf8' });
  if (tags.status !== 0 || tags.stdout.trim()) throw Error('版本标签已存在或无法读取标签');
  for (const file of ['package.json', 'package-lock.json', configPath]) {
    const value = json(file);
    value.version = next;
    if (file === 'package-lock.json') value.packages[''].version = next;
    save(file, value);
  }
  const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
  writeFileSync('src-tauri/Cargo.toml', cargo.replace(/^version = "[^"]+"/m, `version = "${next}"`));
  const lock = readFileSync('src-tauri/Cargo.lock', 'utf8');
  const pattern = /(\[\[package\]\]\r?\nname = "oris"\r?\nversion = ")[^"]+(")/;
  // 只调整根包版本，保留所有依赖解析结果。
  const changed = lock.replace(pattern, (_match, prefix, suffix) => `${prefix}${next}${suffix}`);
  if (changed === lock) throw Error('Cargo.lock 根包未找到');
  writeFileSync('src-tauri/Cargo.lock', changed);
  console.log(`版本准备：${current} → ${next}`);
}

function collect(platform) {
  const version = rootVersion();
  const root = platform === 'windows' ? 'src-tauri/target/release/bundle/nsis' : 'src-tauri/target/aarch64-apple-darwin/release/bundle';
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
  const pick = suffix => {
    const matches = files.filter(file => file.endsWith(suffix));
    if (matches.length !== 1) throw Error(`期望一个 ${suffix}，找到 ${matches.length}`);
    return matches[0];
  };
  const update = platform === 'windows' ? pick(`Oris_${version}_x64-setup.exe`) : pick('.app.tar.gz');
  const signature = readFileSync(`${update}.sig`, 'utf8').trim();
  verifySignature(update, signature, json(configPath).plugins.updater.pubkey, version);
  const destination = path.join('release-assets', platform);
  mkdirSync(destination, { recursive: true });
  const artifacts = [update, `${update}.sig`];
  if (platform === 'macos') artifacts.push(pick('.dmg'));
  for (const file of artifacts) copyFileSync(file, path.join(destination, path.basename(file)));
  console.log(`${platform}：产物和签名已核验`);
}

function assemble() {
  const version = rootVersion();
  const output = 'release-assets/published';
  mkdirSync(output, { recursive: true });
  const platforms = {};
  for (const [platform, target, suffix] of [['windows', 'windows-x86_64', '_x64-setup.exe'], ['macos', 'darwin-aarch64', '.app.tar.gz']]) {
    const directory = `release-assets/${platform}`;
    const files = readdirSync(directory);
    const updates = files.filter(file => file.endsWith(suffix));
    if (updates.length !== 1) throw Error(`${platform} 更新包缺失或重复`);
    const file = updates[0];
    const signature = readFileSync(path.join(directory, `${file}.sig`), 'utf8').trim();
    verifySignature(path.join(directory, file), signature, json(configPath).plugins.updater.pubkey, version);
    platforms[target] = { signature, url: `https://github.com/Zhao-wl/Oris/releases/download/v${version}/${file}` };
    for (const asset of files) copyFileSync(path.join(directory, asset), path.join(output, asset));
  }
  save(`${output}/latest.json`, { version, notes: process.env.RELEASE_NOTES, pub_date: new Date().toISOString(), platforms });
  const hashes = readdirSync(output).map(file => `${crypto.createHash('sha256').update(readFileSync(path.join(output, file))).digest('hex')}  ${file}`);
  writeFileSync(`${output}/SHA256SUMS.txt`, hashes.join('\n') + '\n');
  writeFileSync('release-assets/release-notes.md', process.env.RELEASE_NOTES);
  console.log('双平台签名与更新清单已核验');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const command = process.argv[2];
  if (command === 'prepare') prepare();
  else if (command === 'collect' && ['windows', 'macos'].includes(process.argv[3])) collect(process.argv[3]);
  else if (command === 'assemble') assemble();
  else throw Error('用法：ci-release.mjs prepare | collect windows|macos | assemble');
}
