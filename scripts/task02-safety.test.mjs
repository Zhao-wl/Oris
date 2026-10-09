// 安全回归：旧入口必须在任何网络、窗口或夹具操作之前拒绝执行。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDir = new URL("./", import.meta.url);
const withoutComments = (source) => source.replace(/^\s*(?:\/\/|#).*$/gm, "").trim();
const entries = readdirSync(scriptDir).filter((name) => /^task02-feedback-.*\.mjs$/.test(name));

test("every legacy feedback entry consists only of the disabled guard", () => {
  assert.equal(entries.length, 6);
  for (const name of entries) {
    const file = new URL(name, scriptDir);
    assert.equal(withoutComments(readFileSync(file, "utf8")), 'import "./task02-gui-disabled.mjs";', name);
    const result = spawnSync(process.execPath, [fileURLToPath(file), "9252", "nonexistent-fixture.json"], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /Legacy GUI validation is disabled/, name);
    assert.doesNotMatch(result.stderr, /ENOENT|fetch failed|ECONNREFUSED/, name);
  }
});

test("shared guard has no executable body before its rejection", () => {
  assert.match(withoutComments(readFileSync(new URL("task02-gui-disabled.mjs", scriptDir), "utf8")), /^throw new Error\('[^'\r\n]*'\);$/);
});

test("native legacy helper rejects even a PID/title without any window code", { skip: process.platform !== "win32" }, () => {
  const file = new URL("focus-task02-window.ps1", scriptDir);
  assert.match(withoutComments(readFileSync(file, "utf8")), /^param\(\[int\]\$TargetProcessId, \[string\]\$WindowTitle\)\s+throw '[^'\r\n]*'$/);
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(file), "-TargetProcessId", String(process.pid), "-WindowTitle", "avatarOverlay"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Native window activation is disabled/);
});
