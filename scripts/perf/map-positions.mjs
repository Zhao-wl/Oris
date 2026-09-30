// 把 CDP 时间线 / CPU 剖析中打包产物的“函数名:行:列”（行、列从 0 开始，与 CDP callFrame 相同）映射回源码位置。
// 用法：node scripts/perf/map-positions.mjs <index-*.js.map> "f:35:23261" "mA:35:24800" ...
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require("source-map-js");
const [mapFile, ...positions] = process.argv.slice(2);
const consumer = new SourceMapConsumer(JSON.parse(readFileSync(mapFile, "utf8")));
for (const item of positions) {
  const [name, line, column] = item.split(":");
  const original = consumer.originalPositionFor({ line: Number(line) + 1, column: Number(column) });
  console.log(`${item} → ${original.source?.replace(/^.*node_modules\//, "node_modules/")}:${original.line}:${original.column} ${original.name ?? ""}`);
}
