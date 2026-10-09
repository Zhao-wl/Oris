// 从 Mac / Windows 发起双平台构建；保留原文件名以兼容既有调用。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const repo = 'Zhao-wl/Oris';
const args = process.argv.slice(2);
const usage = '用法：npm run release:desktop -- <x.y.z> --notes-file <文件>\n验证：npm run release:desktop -- --check';
function gh(params) {
  const result = spawnSync('gh', params, { cwd: root, encoding: 'utf8' });
  if (result.error) throw new Error(`无法运行 gh，请先安装 GitHub CLI：${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh 失败（${result.status}）`);
  return result.stdout;
}
try {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
  } else {
    const check = args.length === 1 && args[0] === '--check';
    if (!check && (args.length !== 3 || !/^\d+\.\d+\.\d+$/.test(args[0]) || args[1] !== '--notes-file')) {
      throw new Error(usage);
    }
    const version = check ? '' : args[0];
    const notes = check ? '' : readFileSync(args[2], 'utf8');
    if (!check && !notes.trim()) throw new Error('更新说明文件不能为空');
    gh(['auth', 'status', '--hostname', 'github.com']);
    if (!check) {
      const secrets = JSON.parse(gh(['secret', 'list', '--repo', repo, '--json', 'name']));
      for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
        if (!secrets.some(secret => secret.name === name)) throw new Error(`仓库尚未配置 Secret：${name}`);
      }
      // 以远端 main 为准，避免本机版本过期；仅运行已推送的代码。
      const content = JSON.parse(gh(['api', `repos/${repo}/contents/package.json?ref=main`]));
      const current = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')).version;
      const nextParts = version.split('.').map(Number);
      const currentParts = current.split('.').map(Number);
      const firstDifference = nextParts.findIndex((part, i) => part !== currentParts[i]);
      if (firstDifference < 0 || nextParts[firstDifference] < currentParts[firstDifference]) {
        throw new Error(`新版本 ${version} 必须大于远端 main 的 ${current}`);
      }
    }
    gh(['workflow', 'run', 'release-windows.yml', '--repo', repo, '--ref', 'main',
      '-f', `mode=${check ? 'check' : 'publish'}`, '-f', `version=${version}`, '-f', `notes=${notes}`]);
    console.log(`已触发 Windows / macOS ${check ? '构建验证（不发布）' : `正式发布 ${version}`}。`);
    console.log(`进度：https://github.com/${repo}/actions/workflows/release-windows.yml`);
    console.log(`终端查看：gh run list -R ${repo} --workflow release-windows.yml --limit 5`);
    console.log('工作流只构建远端 main，本机未推送的修改不会进入发布。');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
