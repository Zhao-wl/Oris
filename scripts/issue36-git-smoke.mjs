// 非 GUI 验证：仅操作本轮 mkdtemp 创建的 Git 夹具，不启动窗口或模型。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { applyFileIgnoreOperation, createFileIgnoreMatcher, filterReadableFiles } from "../src/file-ignore.ts";

const base = resolve(tmpdir()), fixture = mkdtempSync(join(base, "oris-issue36-"));
const git = (...args) => {
  const result = spawnSync("git", ["-C", fixture, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const write = (path, text) => { const target = join(fixture, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); };
try {
  git("init", "--quiet"); git("config", "user.name", "Oris issue36 fixture"); git("config", "user.email", "issue36@example.invalid");
  for (const path of ["config-tool/.DS_Store", "gdconfig_tools/.DS_Store", "json/.DS_Store", "src/app.ts"]) write(path, "before\n");
  write(".gitignore", "build/\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture baseline");
  for (const path of ["config-tool/.DS_Store", "gdconfig_tools/.DS_Store", "json/.DS_Store", "src/app.ts", ".DS_Store"]) write(path, "after\n");
  git("add", "json/.DS_Store");
  const fingerprint = () => ({ status: git("status", "--porcelain=v1", "-z"), index: git("ls-files", "--stage", "-z"), refs: git("show-ref"), diff: git("diff"), staged: git("diff", "--cached"), config: git("config", "--local", "--list"),
    bytes: [".gitignore", ".git/info/exclude", ".git/index", ".DS_Store", "config-tool/.DS_Store", "gdconfig_tools/.DS_Store", "json/.DS_Store", "src/app.ts"].map(path => [path, createHash("sha256").update(readFileSync(join(fixture, path))).digest("hex")]) });
  const before = fingerprint();
  let rules = applyFileIgnoreOperation([], { action: "add", rule: { id: "ds", repoId: "fixture", kind: "glob", pattern: "**/.DS_Store", enabled: true, caseSensitive: true } }, "fixture");
  const matcher = createFileIgnoreMatcher(rules, "fixture");
  const paths = output => output.split("\0").filter(Boolean).map(displayPath => ({ displayPath }));
  const unstaged = [...paths(git("diff", "--name-only", "-z")), ...paths(git("ls-files", "--others", "--exclude-standard", "-z"))];
  const staged = paths(git("diff", "--cached", "--name-only", "-z"));
  const all = [...new Map([...unstaged, ...staged].map(f => [f.displayPath, f])).values()];
  assert.equal(all.length, 5); assert.equal(all.filter(f => matcher(f.displayPath)).length, 4);
  assert.deepEqual(filterReadableFiles(unstaged, matcher, "", false).map(f => f.displayPath), ["src/app.ts"]);
  assert.deepEqual(filterReadableFiles(staged, matcher, "", false), []);
  assert.deepEqual(filterReadableFiles(all, matcher, "", false).map(f => f.displayPath), ["src/app.ts"]);
  assert.equal(filterReadableFiles(all, matcher, "", true).length, 5);
  rules = applyFileIgnoreOperation(rules, { action: "delete", id: "ds", repoId: "fixture" }, "fixture");
  assert.equal(filterReadableFiles(all, createFileIgnoreMatcher(rules, "fixture"), "", false).length, 5);
  assert.deepEqual(fingerprint(), before);
  const large = Array.from({ length: 10000 }, (_, i) => ({ displayPath: `src/group${i % 50}/${i % 10 === 0 ? ".DS_Store" : `file${i}.ts`}` }));
  const many = Array.from({ length: 32 }, (_, i) => ({ id: `r${i}`, repoId: null, kind: "glob", pattern: i === 31 ? "**/.DS_Store" : `**/cache${i}/*.tmp`, enabled: true, caseSensitive: true }));
  const compiled = createFileIgnoreMatcher(many, "fixture"), started = performance.now();
  const visible = filterReadableFiles(large, compiled, "", false); const coldMs = performance.now() - started;
  const warmStarted = performance.now(); filterReadableFiles(large, compiled, "file", false); const warmMs = performance.now() - warmStarted;
  assert.equal(visible.length, 9000);
  console.log(JSON.stringify({ passed: true, scopes: ["unstaged", "staged", "all"], changedFiles: all.length, ignored: 4, gitAndBytesUnchanged: true, performance: { files: 10000, rules: 32, visible: visible.length, coldMs: +coldMs.toFixed(2), warmMs: +warmMs.toFixed(2) }, nativeWindows: "not used", realModel: "not used" }, null, 2));
} finally {
  assert.equal(dirname(resolve(fixture)), base); assert.ok(fixture.startsWith(join(base, "oris-issue36-")));
  rmSync(fixture, { recursive: true, force: true });
}
