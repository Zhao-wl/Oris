/** Oris 阅读规则；不读取或修改 Git ignore 配置。路径始终相对所属仓库。 */
export interface FileIgnoreRule {
  id: string;
  repoId: string | null;
  kind: "path" | "name" | "glob";
  pattern: string;
  enabled: boolean;
  caseSensitive: boolean;
}

export type FileIgnoreOperation =
  | { action: "add"; rule: FileIgnoreRule }
  | { action: "update"; rule: FileIgnoreRule }
  | { action: "delete"; id: string; repoId: string | null }
  | { action: "setEnabled"; id: string; repoId: string | null; enabled: boolean };

export const IGNORE_LIMIT = 256;
export function fileIgnoreOperationSummary(op: FileIgnoreOperation, rules: FileIgnoreRule[] = []): string {
  const id = "rule" in op ? op.rule.id : op.id;
  const rule = "rule" in op ? op.rule : rules.find(r => r.id === id);
  const repoId = "rule" in op ? op.rule.repoId : op.repoId;
  const action = op.action === "add" ? "添加" : op.action === "update" ? "修改" : op.action === "delete" ? "删除" : op.enabled ? "启用" : "停用";
  return `${repoId === null ? "全局" : `当前仓库 ${repoId}`} · ${action} · ${rule?.pattern ?? id}${rule ? ` · ${rule.kind} · ${rule.caseSensitive ? "区分大小写" : "不区分大小写"}` : ""}`;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function validateFileIgnoreRule(value: unknown): FileIgnoreRule | undefined {
  const r = object(value);
  if (!r || typeof r.id !== "string" || !/^[\w-]{1,80}$/.test(r.id)
    || !(r.repoId === null || (typeof r.repoId === "string" && /^[\w-]{1,128}$/.test(r.repoId)))
    || !["path", "name", "glob"].includes(String(r.kind)) || typeof r.pattern !== "string"
    || typeof r.enabled !== "boolean" || typeof r.caseSensitive !== "boolean") return undefined;
  const pattern = r.pattern.replace(/\\/g, "/");
  if (!pattern || pattern.length > 256 || /[\u0000-\u001f\u007f]/.test(pattern) || pattern.startsWith("/")
    || /^[a-z]:/i.test(pattern) || pattern.split("/").some(s => !s || s === "." || s === "..")) return undefined;
  if (r.kind === "name" && pattern.includes("/")) return undefined;
  // 不支持 gitignore 的取反、字符组、花括号或正则；** 只能作为完整目录段。
  if (r.kind === "glob" && (/[!\[\]{}]/.test(pattern) || pattern.split("/").some(s => s.includes("**") && s !== "**"))) return undefined;
  return { id: r.id, repoId: r.repoId as string | null, kind: r.kind as FileIgnoreRule["kind"], pattern, enabled: r.enabled, caseSensitive: r.caseSensitive };
}

export function validateFileIgnoreRules(value: unknown): FileIgnoreRule[] | undefined {
  if (!Array.isArray(value) || value.length > IGNORE_LIMIT) return undefined;
  const rules = value.map(validateFileIgnoreRule);
  if (rules.some(r => !r) || new Set(rules.map(r => r!.id)).size !== rules.length) return undefined;
  return rules as FileIgnoreRule[];
}

export function parseFileIgnoreOperation(value: unknown): FileIgnoreOperation {
  const op = object(value);
  if (!op) throw new Error("忽略规则操作无效");
  if (op.action === "add" || op.action === "update") {
    const rule = validateFileIgnoreRule(op.rule);
    if (!rule) throw new Error("忽略规则无效：请使用仓库相对路径、文件名或支持的 glob");
    return { action: op.action, rule };
  }
  if ((op.action === "delete" || op.action === "setEnabled") && typeof op.id === "string" && /^[\w-]{1,80}$/.test(op.id)
    && (op.repoId === null || typeof op.repoId === "string") && (op.action !== "setEnabled" || typeof op.enabled === "boolean")) {
    return op.action === "delete" ? { action: "delete", id: op.id, repoId: op.repoId as string | null }
      : { action: "setEnabled", id: op.id, repoId: op.repoId as string | null, enabled: op.enabled as boolean };
  }
  throw new Error("忽略规则操作无效");
}

/** 手动和 AI 共用：先构造并完整校验，失败时调用方不写入。 */
export function applyFileIgnoreOperation(rules: FileIgnoreRule[], input: FileIgnoreOperation, currentRepoId: string | null): FileIgnoreRule[] {
  const op = parseFileIgnoreOperation(input);
  const repoId = "rule" in op ? op.rule.repoId : op.repoId;
  if (repoId !== null && repoId !== currentRepoId) throw new Error("目标仓库已切换或不可用，请在目标项目中重新配置");
  const id = "rule" in op ? op.rule.id : op.id;
  const index = rules.findIndex(r => r.id === id);
  if (op.action === "add" && index !== -1) throw new Error("忽略规则 ID 已存在");
  if (op.action !== "add" && (index === -1 || rules[index].repoId !== repoId)) throw new Error("忽略规则或作用范围已变化，请重新配置");
  const next = op.action === "add" ? [...rules, op.rule] : op.action === "delete" ? rules.filter(r => r.id !== id)
    : rules.map(r => r.id !== id ? r : op.action === "update" ? op.rule : { ...r, enabled: op.enabled });
  const valid = validateFileIgnoreRules(next);
  if (!valid) throw new Error(`忽略规则无效或超过 ${IGNORE_LIMIT} 条上限`);
  return valid;
}

/** 按字符动态规划匹配，避免把用户模式编译为可能灾难回溯的正则。 */
function segmentMatches(pattern: string, text: string): boolean {
  if (!/[?*]/.test(pattern)) return pattern === text;
  if (pattern === "*") return true;
  if (pattern.startsWith("*") && !/[?*]/.test(pattern.slice(1))) return text.endsWith(pattern.slice(1));
  if (pattern.endsWith("*") && !/[?*]/.test(pattern.slice(0, -1))) return text.startsWith(pattern.slice(0, -1));
  const chars = Array.from(text);
  let row = Array<boolean>(chars.length + 1).fill(false); row[0] = true;
  for (const char of pattern) {
    const next = Array<boolean>(chars.length + 1).fill(false);
    next[0] = char === "*" && row[0];
    for (let j = 1; j <= chars.length; j++) next[j] = char === "*" ? row[j] || next[j - 1] : row[j - 1] && (char === "?" || char === chars[j - 1]);
    row = next;
  }
  return row[chars.length];
}

export function createFileIgnoreMatcher(rules: FileIgnoreRule[], repoId: string | null): (path: string) => boolean {
  const active = rules.filter(r => r.enabled && (r.repoId === null || r.repoId === repoId)).map(r => ({ ...r, parts: (r.caseSensitive ? r.pattern : r.pattern.toLowerCase()).split("/") }));
  const cache = new Map<string, boolean>();
  return path => {
    if (!active.length) return false;
    const known = cache.get(path);
    if (known !== undefined) return known;
    const normalized = path.replace(/\\/g, "/");
    const result = active.some(r => {
      const target = r.caseSensitive ? normalized : normalized.toLowerCase();
      const parts = target.split("/");
      if (r.kind === "path") return target === r.parts.join("/");
      if (r.kind === "name") return parts.at(-1) === r.parts[0];
      if (r.parts.length === 1 && r.parts[0] !== "**") return segmentMatches(r.parts[0], parts.at(-1)!);
      if (r.parts.at(-1) !== "**" && !segmentMatches(r.parts.at(-1)!, parts.at(-1)!)) return false;
      let row = Array<boolean>(parts.length + 1).fill(false); row[0] = true;
      for (const token of r.parts) {
        const next = Array<boolean>(parts.length + 1).fill(false); next[0] = token === "**" && row[0];
        for (let j = 1; j <= parts.length; j++) next[j] = token === "**" ? row[j] || next[j - 1] : row[j - 1] && segmentMatches(token, parts[j - 1]);
        row = next;
      }
      return row[parts.length];
    });
    if (cache.size >= 20_000) cache.clear();
    cache.set(path, result);
    return result;
  };
}

export function filterReadableFiles<T extends { displayPath: string }>(files: T[], matches: (path: string) => boolean, query: string, showIgnored: boolean): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return files.filter(f => (showIgnored || !matches(f.displayPath)) && f.displayPath.toLocaleLowerCase().includes(needle));
}
