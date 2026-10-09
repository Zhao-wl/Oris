import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // .claude/worktrees 下是其他会话的仓库副本，不属于本仓库的测试。
  // 此文件使用 node:test，由 npm run test:gui-safety 独立执行。
  test: { exclude: [...configDefaults.exclude, ".claude/**", "scripts/task02-safety.test.mjs"] },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: ["es2021", "chrome105", "safari13"] }
});
