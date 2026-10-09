// 仅由 headless 布局验证的 Vitest 实例加载，不向应用 TypeScript 引入 Node 类型。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.ORIS_LAYOUT_SNAPSHOTS;
if (!dir) throw new Error("缺少布局快照输出目录");
mkdirSync(dir, { recursive: true });
globalThis.orisLayoutCapture = (name, html) => writeFileSync(join(dir, `${name}.html`), html);
