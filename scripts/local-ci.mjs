import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [
  ["TypeScript", ["node_modules/typescript/bin/tsc", "-b"]],
  ["Frontend build", ["node_modules/vite/bin/vite.js", "build"]],
  ["Frontend regression", ["node_modules/vitest/vitest.mjs", "run", "--pool=threads", "--maxWorkers=4"]],
  ["Theme, GUI safety and release tooling", ["--test", "scripts/themes/import-vscode-themes.test.mjs", "scripts/themes/styles-colors.test.mjs", "scripts/task02-safety.test.mjs", "scripts/release/ci-release.test.mjs"]],
];

const start = performance.now();
for (const [name, args] of checks) {
  console.log(`\n${name}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`${name} failed after ${((performance.now() - start) / 1000).toFixed(1)}s`, result.error ?? result.signal ?? `exit ${result.status}`);
    process.exit(result.status || 1);
  }
}
console.log(`\nLocal CI passed in ${((performance.now() - start) / 1000).toFixed(1)}s.`);
