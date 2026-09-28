// 自动更新端到端测试用的本机静态文件服务：只监听 127.0.0.1，只提供指定目录下的文件。
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const [root, port = "18765"] = process.argv.slice(2);
if (!root) throw new Error("Usage: node server.mjs <dir> [port]");

createServer((request, response) => {
  // 只允许目录内的单层文件名，拒绝路径穿越。
  const name = basename(decodeURIComponent(new URL(request.url, "http://x").pathname));
  const file = join(root, name);
  try {
    const size = statSync(file).size;
    response.writeHead(200, { "content-length": size, "content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream" });
    createReadStream(file).pipe(response);
    console.log(`${new Date().toISOString()} 200 ${name} ${size}`);
  } catch {
    response.writeHead(404).end();
    console.log(`${new Date().toISOString()} 404 ${name}`);
  }
}).listen(Number(port), "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
