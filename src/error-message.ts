/** Rust IPC errors always expose a message in current builds. Keep legacy kind-only errors useful too. */
const legacyReasons: Record<string, string> = {
  staleRequest: "仓库或文件自上次扫描后发生变化，请点击“本地刷新”后重试。未显示旧内容。",
  unsafePath: "文件路径越过仓库边界或包含不支持的链接，无法安全读取。",
  unsupportedPathEncoding: "文件路径编码不受支持，无法读取。",
  unknownRepository: "仓库尚未打开或已失效，请重新载入仓库。",
  gitChanged: "打开仓库后 Git 可执行文件发生变化，请重新载入仓库。",
  registry: "仓库登记状态不可用，请重新载入仓库。",
};
export function errorText(error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const payload = error as { kind?: unknown; message?: unknown };
    if (typeof payload.message === "string" && payload.message) return payload.message;
    if (typeof payload.kind === "string") {
      if (legacyReasons[payload.kind]) return legacyReasons[payload.kind];
      if (payload.kind === "unsupportedGit" && payload.message && typeof payload.message === "object") {
        const version = payload.message as { found?: unknown; minimum?: unknown };
        if (typeof version.found === "string" && typeof version.minimum === "string") return `Git ${version.found} 低于最低支持版本 ${version.minimum}`;
      }
      return `后台请求失败（${payload.kind}），未收到详细错误原因。`;
    }
  }
  return "请求失败：未收到可显示的错误详情。";
}
