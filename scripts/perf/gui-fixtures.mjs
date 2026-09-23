// GUI 测量夹具：只在仓库外的临时目录创建（默认 %TEMP%\oris-gui）。
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { encodePng, withExifOrientation } from "./gui-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GUI_ROOT = realpathSync.native(tmpdir()) + path.sep + "oris-gui";

export function assertOutside(dir) {
  const resolved = path.resolve(dir).toLowerCase();
  if (resolved.startsWith(projectRoot.toLowerCase() + path.sep)) throw new Error(`夹具不能放在 Oris 仓库内：${dir}`);
  if (!resolved.startsWith(GUI_ROOT.toLowerCase() + path.sep)) throw new Error(`夹具必须位于 ${GUI_ROOT} 内：${dir}`);
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Oris GUI", GIT_AUTHOR_EMAIL: "oris-gui@example.invalid", GIT_COMMITTER_NAME: "Oris GUI", GIT_COMMITTER_EMAIL: "oris-gui@example.invalid", GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" };
export function git(cwd, args, { input, allowFail = false } = {}) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "merge.conflictstyle=merge", ...args], { cwd, env: gitEnv, input, encoding: input instanceof Buffer ? undefined : "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} 失败：${result.stderr}`);
  return typeof result.stdout === "string" ? result.stdout.trim() : result.stdout;
}

/** 生成（或复用）5 份 S 数据集原件，复制到本次运行目录并刷新 index stat 缓存。 */
export async function prepareCoreRepos(runDir, count = 5) {
  assertOutside(runDir);
  const pristineRoot = path.join(GUI_ROOT, "pristine");
  mkdirSync(pristineRoot, { recursive: true });
  const jobs = [];
  for (let i = 1; i <= count; i++) {
    const target = path.join(pristineRoot, `S${i}`);
    if (existsSync(path.join(target, ".git", "oris-perf-manifest.json"))) continue;
    if (existsSync(target)) throw new Error(`不完整的原件目录，请人工确认后删除：${target}`);
    jobs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(projectRoot, "scripts", "perf", "generate-datasets.mjs"), "S", "--output", target], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`生成 ${target} 失败`))));
    }));
  }
  await Promise.all(jobs);
  const repos = [];
  for (let i = 1; i <= count; i++) {
    const target = path.join(runDir, `S${i}`);
    if (existsSync(target)) throw new Error(`运行目录已存在：${target}`);
    cpSync(path.join(pristineRoot, `S${i}`), target, { recursive: true, preserveTimestamps: true });
    // 复制会改变 stat 信息；以正常 status 刷新 index 的 stat 缓存，避免把夹具复制的代价计入测量。
    git(target, ["status", "--porcelain"], { allowFail: true });
    const real = realpathSync.native(target);
    const manifest = JSON.parse(readFileSync(path.join(real, ".git", "oris-perf-manifest.json"), "utf8"));
    repos.push({ path: real, manifest, warmup: [] });
  }
  // 预热：刚复制的大量文件会触发系统后台扫描，首轮 status 明显偏慢。重复只读 status，
  // 直到连续两次都在最快值的 1.3 倍以内（最多 20 轮），把稳定前的耗时记录下来而不是计入测量。
  for (const repo of repos) {
    for (let round = 0; round < 20; round++) {
      const started = Date.now();
      spawnSync("git", ["--no-optional-locks", "-C", repo.path, "status", "--porcelain=v2", "-z", "--untracked-files=all"], { env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
      repo.warmup.push(Date.now() - started);
      const fastest = Math.min(...repo.warmup);
      const last = repo.warmup.slice(-2);
      if (last.length === 2 && last.every((ms) => ms <= fastest * 1.3)) break;
    }
  }
  return repos;
}

/** 仓库只读状态指纹：.git 下的 index/HEAD/refs/config 与工作区文件内容。 */
export function repositoryFingerprint(repo, { includeWorktree = true } = {}) {
  const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
  const entries = {};
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (rel === ".git/objects" || rel === ".git/logs") continue;
        if (!includeWorktree && !rel.startsWith(".git")) continue;
        walk(full, rel);
      } else if (includeWorktree || rel.startsWith(".git")) {
        entries[rel] = hash(readFileSync(full));
      }
    }
  };
  walk(repo, "");
  return { files: Object.keys(entries).length, digest: hash(Buffer.from(JSON.stringify(entries))), entries };
}

export function diffFingerprints(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])) if (before.entries[key] !== after.entries[key]) changed.push(key);
  return changed;
}

// ---------- 任务 03 图片 / 冲突夹具 ----------
const solid = (r, g, b, a = 255) => () => [r, g, b, a];
const gradient = (w, h, tint) => (x, y) => [Math.round((x / w) * 255), Math.round((y / h) * 255), tint, 255];

/** 通过测试实例页面内的 canvas 编码 JPEG / WebP（WebView2 自带编码器），返回 Buffer。 */
async function canvasImage(cdp, { width, height, type, quality = 0.95, draw }) {
  const base64 = await cdp.evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = ${width}; canvas.height = ${height};
    const ctx = canvas.getContext('2d'); (${draw})(ctx);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, ${JSON.stringify(type)}, ${quality}));
    const bytes = new Uint8Array(await blob.arrayBuffer()); let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  })()`);
  return Buffer.from(base64, "base64");
}

export async function prepareTask03Repos(runDir, cdp) {
  assertOutside(runDir);
  const images = path.join(runDir, "task03-images");
  const conflict = path.join(runDir, "task03-conflict");
  for (const dir of [images, conflict]) { if (existsSync(dir)) throw new Error(`已存在：${dir}`); mkdirSync(dir, { recursive: true }); git(dir, ["init", "-q", "-b", "main"]); }
  const put = (repo, rel, bytes) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), bytes); };
  // 方向标定图：存储 40×20，左上 10×10 红块，其余蓝色。EXIF 6 应显示为 20×40，红块在右上。
  const drawOrient = `(ctx) => { ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 40, 20); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 10, 10); }`;
  const jpegBase = await canvasImage(cdp, { width: 40, height: 20, type: "image/jpeg", draw: drawOrient });
  const webpHead = await canvasImage(cdp, { width: 48, height: 32, type: "image/webp", draw: `(ctx) => { ctx.fillStyle = '#20a040'; ctx.fillRect(0, 0, 48, 32); }` });
  const webpWork = await canvasImage(cdp, { width: 48, height: 32, type: "image/webp", draw: `(ctx) => { ctx.fillStyle = '#c020c0'; ctx.fillRect(0, 0, 48, 32); ctx.fillStyle = '#ffffff'; ctx.fillRect(8, 8, 16, 16); }` });
  if (webpHead.toString("ascii", 8, 12) !== "WEBP") throw new Error("WebView2 未生成 WebP");
  const png32 = encodePng(32, 32, gradient(32, 32, 90));
  const apng = encodePng(32, 32, gradient(32, 32, 30), [["acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])]]);
  const alphaHead = encodePng(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 < 400 ? [255, 120, 0, 255] : [0, 0, 0, 0]));
  const alphaIndex = encodePng(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 < 600 ? [0, 120, 255, 160] : [0, 0, 0, 0]));
  put(images, "img/photo.png", encodePng(64, 48, gradient(64, 48, 200)));
  put(images, "img/alpha.png", alphaHead);
  put(images, "img/orient.jpg", withExifOrientation(jpegBase, 1));
  put(images, "img/pic.webp", webpHead);
  put(images, "img/broken.png", png32);
  put(images, "img/anim.png", png32);
  put(images, "img/removed.png", encodePng(40, 40, solid(10, 160, 160)));
  put(images, "notes.txt", "第一行\n第二行\n第三行\n");
  git(images, ["add", "-A"]); git(images, ["commit", "-q", "-m", "images base"]);
  put(images, "img/alpha.png", alphaIndex); git(images, ["add", "img/alpha.png"]);
  put(images, "img/photo.png", encodePng(96, 64, (x, y) => [(x * 7) & 255, 40, (y * 11) & 255, 255]));
  put(images, "img/orient.jpg", withExifOrientation(jpegBase, 6));
  put(images, "img/pic.webp", webpWork);
  put(images, "img/broken.png", png32.subarray(0, 40));
  put(images, "img/anim.png", apng);
  put(images, "img/added.png", encodePng(48, 48, solid(200, 200, 20)));
  unlinkSync(path.join(images, "img/removed.png"));
  put(images, "notes.txt", "第一行\n第二行（修改）\n第三行\n新增第四行\n");

  // 真实 merge 生成冲突：UU 文本、UU 图片、UD 修改/删除。
  put(conflict, "c.txt", "base line 1\nbase line 2\nbase line 3\n");
  put(conflict, "img.png", encodePng(32, 32, solid(128, 128, 128)));
  put(conflict, "md.txt", "keep me\n");
  put(conflict, "plain.txt", "plain\n");
  git(conflict, ["add", "-A"]); git(conflict, ["commit", "-q", "-m", "base"]);
  git(conflict, ["switch", "-q", "-c", "theirs"]);
  put(conflict, "c.txt", "base line 1\ntheirs change\nbase line 3\n");
  put(conflict, "img.png", encodePng(32, 24, solid(0, 0, 255)));
  unlinkSync(path.join(conflict, "md.txt"));
  git(conflict, ["add", "-A"]); git(conflict, ["commit", "-q", "-m", "theirs"]);
  git(conflict, ["switch", "-q", "main"]);
  put(conflict, "c.txt", "base line 1\nours change\nbase line 3\n");
  put(conflict, "img.png", encodePng(24, 32, solid(255, 0, 0)));
  put(conflict, "md.txt", "keep me, modified by ours\n");
  put(conflict, "plain.txt", "plain modified\n");
  git(conflict, ["add", "c.txt", "img.png", "md.txt"]); git(conflict, ["commit", "-q", "-m", "ours"]);
  git(conflict, ["merge", "--no-edit", "theirs"], { allowFail: true });
  const unmerged = git(conflict, ["ls-files", "--unmerged"]);
  return { images: realpathSync.native(images), conflict: realpathSync.native(conflict), unmerged };
}
