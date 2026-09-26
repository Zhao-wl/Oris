// 第三方依赖许可证清单（一期 06）。只使用本机已有的数据：`cargo metadata --offline --locked` 与 package-lock.json，
// 许可证全文取自本机 Cargo 注册表源码目录与 node_modules 中各包自带的 LICENSE / NOTICE 文件，不联网、不下载工具。
// Rust：从 oris 包出发，按 desktop 特性、只沿 normal 依赖（进入产品二进制的依赖；build / dev 依赖不随产品分发）遍历，
//       分别对 x86_64-pc-windows-gnu 与 aarch64-apple-darwin 解析平台相关依赖。
// npm：从 package.json 的 dependencies 出发沿 package-lock.json 遍历（devDependencies 只参与构建，不进入产品）。
// 用法：node scripts/release/third-party-licenses.mjs [--md docs/release/third-party-licenses.md] [--notices <输出 NOTICES 文件>]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mdPath = path.resolve(root, option("md", "docs/release/third-party-licenses.md"));
const noticesPath = option("notices", null);

// ---------- Rust ----------
const TARGETS = { windows: "x86_64-pc-windows-gnu", macos: "aarch64-apple-darwin" };
function cargoPackages(target) {
  const r = spawnSync("cargo", ["metadata", "--format-version", "1", "--offline", "--locked", "--features", "desktop", "--filter-platform", target, "--manifest-path", path.join(root, "src-tauri", "Cargo.toml")], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`cargo metadata 失败（${target}）：${r.stderr}`);
  const meta = JSON.parse(r.stdout);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const rootId = meta.resolve.root;
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
    }
  }
  seen.delete(rootId);
  return [...seen].map((id) => byId.get(id));
}
const rust = new Map();
for (const [platform, target] of Object.entries(TARGETS)) {
  for (const p of cargoPackages(target)) {
    const key = `${p.name}@${p.version}`;
    const entry = rust.get(key) ?? { name: p.name, version: p.version, license: p.license ?? (p.license_file ? `见 ${p.license_file}` : "未声明"), repository: p.repository ?? "", dir: path.dirname(p.manifest_path), platforms: [] };
    entry.platforms.push(platform);
    rust.set(key, entry);
  }
}

// ---------- npm ----------
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const npm = new Map();
function resolveLock(name, from) {
  // node_modules 解析：从依赖方所在目录逐级向上查找。
  let base = from;
  while (true) {
    const candidate = `${base ? base + "/" : ""}node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i >= 0 ? base.slice(0, i) : "";
  }
}
const queue = Object.keys(pkg.dependencies).map((name) => [name, ""]);
while (queue.length) {
  const [name, from] = queue.shift();
  const key = resolveLock(name, from);
  if (!key) throw new Error(`package-lock.json 中找不到 ${name}（来自 ${from || "根"}）`);
  if (npm.has(key)) continue;
  const info = lock.packages[key];
  npm.set(key, { name, version: info.version, license: info.license ?? "未声明", repository: "", dir: path.join(root, ...key.split("/")) });
  for (const dep of Object.keys({ ...(info.dependencies ?? {}), ...(info.optionalDependencies ?? {}) })) {
    if (resolveLock(dep, key)) queue.push([dep, key]); else if (!(info.optionalDependencies ?? {})[dep]) throw new Error(`${key} 的依赖 ${dep} 未解析`);
  }
}
for (const entry of npm.values()) {
  try { const manifest = JSON.parse(readFileSync(path.join(entry.dir, "package.json"), "utf8")); const repo = manifest.repository; entry.repository = typeof repo === "string" ? repo : repo?.url ?? ""; } catch { /* 可选 */ }
}

// ---------- 许可证文本 ----------
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-_.].*)?$/i;
function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && LICENSE_FILE.test(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ file: d.name, text: readFileSync(path.join(dir, d.name), "utf8").replace(/\r\n/g, "\n").trim() }));
}
const all = [...[...rust.values()].map((e) => ({ ...e, ecosystem: "Cargo" })), ...[...npm.values()].map((e) => ({ ...e, ecosystem: "npm", platforms: ["windows", "macos"] }))]
  .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
for (const e of all) e.texts = licenseTexts(e.dir);

// 需要人工留意的许可证（Copyleft / 非常见）：列出，不做自动结论。
const PERMISSIVE = /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|Zlib|0BSD|Unlicense|Unicode-3\.0|Unicode-DFS-2016|BSL-1\.0|CC0-1\.0|MIT-0|Apache-2\.0 WITH LLVM-exception)$/;
const terms = (license) => license.replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+|\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
const attention = all.filter((e) => {
  const parts = terms(e.license);
  // “A OR B” 只要有一个宽松选项即可按宽松许可使用；AND 组合要求每一项都宽松。
  const orGroups = e.license.includes(" OR ") || e.license.includes("/") ? [parts] : parts.map((p) => [p]);
  return !orGroups.every((group) => group.some((p) => PERMISSIVE.test(p)));
});
const missingText = all.filter((e) => e.texts.length === 0);

const summary = new Map();
for (const e of all) summary.set(`${e.ecosystem}|${e.license}`, (summary.get(`${e.ecosystem}|${e.license}`) ?? 0) + 1);
const lockSha = spawnSync("git", ["-C", root, "log", "-1", "--format=%H", "--", "src-tauri/Cargo.lock", "package-lock.json"], { encoding: "utf8" }).stdout.trim();

const md = [];
md.push("# 第三方依赖许可证清单", "");
md.push(`生成方式：\`node scripts/release/third-party-licenses.mjs\`（本机 \`cargo metadata --offline --locked\` 与 \`package-lock.json\`，不联网）。依赖锁文件最后修改提交：\`${lockSha.slice(0, 12)}\`。`, "");
md.push("范围：随产品分发的依赖。Rust 为 `oris`（desktop 特性）的 normal 依赖传递闭包，按 Windows（x86_64-pc-windows-gnu）与 macOS（aarch64-apple-darwin）分别解析；npm 为 `dependencies` 的传递闭包（打包进前端资源）。构建工具（Tauri CLI、Vite、TypeScript、测试框架）、build / dev 依赖不随产品分发，不在此列。许可证字段取自各包自己的元数据，未逐包复核源码。", "");
md.push("配色方案数据来自 VS Code 与 Colorsublime-Themes（MIT），声明见 `src/themes/generated/NOTICES.txt`，同时显示在设置 → 外观，并收入安装包的 `THIRD-PARTY-NOTICES.txt`。", "");
md.push(`合计：Cargo ${rust.size} 个包（Windows ${[...rust.values()].filter((e) => e.platforms.includes("windows")).length}、macOS ${[...rust.values()].filter((e) => e.platforms.includes("macos")).length}），npm ${npm.size} 个包。`, "");
md.push("## 按许可证汇总", "", "| 生态 | 许可证（SPDX 表达式） | 包数 |", "| --- | --- | --- |");
for (const [key, count] of [...summary].sort((a, b) => b[1] - a[1])) { const [eco, lic] = key.split("|"); md.push(`| ${eco} | ${lic} | ${count} |`); }
md.push("", "## 需要留意", "");
if (attention.length) {
  md.push("以下包的许可证表达式中没有可单独选用的宽松许可（MIT / Apache-2.0 / BSD / ISC / Zlib 等），公开发布前需人工确认义务：", "", "| 生态 | 包 | 版本 | 许可证 |", "| --- | --- | --- | --- |");
  for (const e of attention) md.push(`| ${e.ecosystem} | ${e.name} | ${e.version} | ${e.license} |`);
} else md.push("所有包的许可证表达式中都至少有一个可选用的宽松许可。");
md.push("");
if (missingText.length) {
  md.push(`以下 ${missingText.length} 个包的源码目录中没有 LICENSE / NOTICE 文件，NOTICES 中只列出许可证名称：`, "");
  md.push(missingText.map((e) => `${e.name} ${e.version}（${e.license}）`).join("、"), "");
}
md.push("## 完整清单", "", "| 生态 | 包 | 版本 | 许可证 | 平台 | 来源 |", "| --- | --- | --- | --- | --- | --- |");
for (const e of all) md.push(`| ${e.ecosystem} | ${e.name} | ${e.version} | ${e.license} | ${e.platforms.join(" / ")} | ${e.repository.replace(/^git\+/, "").replace(/\|/g, "\\|")} |`);
mkdirSync(path.dirname(mdPath), { recursive: true });
writeFileSync(mdPath, md.join("\n") + "\n");
console.log(`清单：${mdPath}（Cargo ${rust.size}、npm ${npm.size}；需留意 ${attention.length}；缺许可证文件 ${missingText.length}）`);

if (noticesPath) {
  const out = [];
  out.push("Oris 第三方软件声明（THIRD-PARTY-NOTICES）", "", "本文件列出随 Oris 分发的第三方组件及其许可证全文（取自各组件源码包）。", "");
  out.push("=".repeat(78), "配色方案（VS Code / Colorsublime-Themes）", "=".repeat(78), readFileSync(path.join(root, "src", "themes", "generated", "NOTICES.txt"), "utf8").replace(/\r\n/g, "\n").trim(), "");
  // 相同文本只写一次，其余包引用它。
  const seenText = new Map();
  for (const e of all) {
    out.push("=".repeat(78), `${e.name} ${e.version}（${e.ecosystem}）`, `许可证：${e.license}`, ...(e.repository ? [`来源：${e.repository.replace(/^git\+/, "")}`] : []), "-".repeat(78));
    if (!e.texts.length) out.push("（源码包中没有许可证文件；许可证条款见上方 SPDX 标识对应的标准文本）");
    for (const t of e.texts) {
      const prior = seenText.get(t.text);
      if (prior) out.push(`[${t.file}] 与 ${prior} 的同名文件内容相同`);
      else { seenText.set(t.text, `${e.name} ${e.version}`); out.push(`[${t.file}]`, t.text); }
    }
    out.push("");
  }
  mkdirSync(path.dirname(path.resolve(noticesPath)), { recursive: true });
  writeFileSync(path.resolve(noticesPath), out.join("\n") + "\n");
  console.log(`NOTICES：${path.resolve(noticesPath)}`);
}
