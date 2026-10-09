import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { verifySignature } from './ci-release.mjs';

test('发布准备只统一五个根包版本，检查模式不改动版本', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oris-prepare-'));
  try {
    mkdirSync(path.join(directory, 'src-tauri'));
    spawnSync('git', ['init', '-q'], { cwd: directory });
    for (const [file, value] of [['package.json', { version: '0.8.4' }], ['package-lock.json', { version: '0.8.4', packages: { '': { version: '0.8.4' }, dependency: { version: '1.2.3' } } }], ['src-tauri/tauri.conf.json', { version: '0.8.4' }]]) {
      writeFileSync(path.join(directory, file), JSON.stringify(value));
    }
    writeFileSync(path.join(directory, 'src-tauri/Cargo.toml'), '[package]\nname = "oris"\nversion = "0.8.4"\n');
    writeFileSync(path.join(directory, 'src-tauri/Cargo.lock'), '[[package]]\nname = "oris"\nversion = "0.8.4"\n\n[[package]]\nname = "dependency"\nversion = "1.2.3"\n');
    const run = mode => spawnSync(process.execPath, [path.join(import.meta.dirname, 'ci-release.mjs'), 'prepare'], { cwd: directory, encoding: 'utf8', env: { ...process.env, RELEASE_MODE: mode, RELEASE_VERSION: '0.9.0', RELEASE_NOTES: '测试' } });
    assert.equal(run('check').status, 0);
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'package.json'))).version, '0.8.4');
    const result = run('publish');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'package.json'))).version, '0.9.0');
    const lock = JSON.parse(readFileSync(path.join(directory, 'package-lock.json')));
    assert.equal(lock.packages[''].version, '0.9.0');
    assert.equal(lock.packages.dependency.version, '1.2.3');
    assert.match(readFileSync(path.join(directory, 'src-tauri/Cargo.lock'), 'utf8'), /name = "oris"\nversion = "0.9.0"/);
    assert.match(readFileSync(path.join(directory, 'src-tauri/Cargo.lock'), 'utf8'), /name = "dependency"\nversion = "1.2.3"/);
    assert.notEqual(run('publish').status, 0, '同版本重发必须拒绝');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('双平台更新签名必须绑定文件、公钥和版本', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oris-signature-'));
  try {
    const file = path.join(directory, 'app.tar.gz');
    const bytes = Buffer.from('update bundle');
    writeFileSync(file, bytes);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const id = crypto.randomBytes(8);
    const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const pub = Buffer.concat([Buffer.from('Ed'), id, rawPublic]);
    const key = Buffer.from(`untrusted comment: test\n${pub.toString('base64')}\n`).toString('base64');
    const signature = crypto.sign(null, crypto.createHash('blake2b512').update(bytes).digest(), privateKey);
    const packet = Buffer.concat([Buffer.from('ED'), id, signature]);
    const comment = 'timestamp:1\tversion:0.9.0';
    const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const encoded = Buffer.from(`untrusted comment: test\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
    assert.doesNotThrow(() => verifySignature(file, encoded, key, '0.9.0'));
    assert.throws(() => verifySignature(file, encoded, key, '0.9.1'), /版本不匹配/);
    writeFileSync(file, 'modified bundle');
    assert.throws(() => verifySignature(file, encoded, key, '0.9.0'), /产物签名无效/);
    writeFileSync(file, bytes);
    const corrupted = Buffer.from(encoded, 'base64').toString().replace('version:0.9.0', 'version:0.9.1');
    assert.throws(() => verifySignature(file, Buffer.from(corrupted).toString('base64'), key, '0.9.1'), /版本注释签名无效/);
    assert.throws(() => verifySignature(file, 'invalid', key, '0.9.0'), /签名数据/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
