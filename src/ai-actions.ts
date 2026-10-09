import type { OperationRequest } from "./operations-api";
import type { CompareScope } from "./types";
import { fileIgnoreOperationSummary, parseFileIgnoreOperation, type FileIgnoreOperation, type FileIgnoreRule } from "./file-ignore";

type Field = "text" | "number" | "boolean" | "paths" | "pathsOrAll" | "scope" | "pullMode";
type Schema = Record<string, Field>;
type AiGitOperation = OperationRequest | { kind: "stage" | "unstage"; pathIds: "all" };

/** AI 只能提出 Oris 已有的类型化操作；确认、强制与备份覆盖标志不接受模型赋值，Oris 执行时也不代为确认（V2-D68）。 */
export const AI_GIT_SCHEMAS: Record<string, Schema> = {
  stage: { pathIds: "pathsOrAll" }, unstage: { pathIds: "pathsOrAll" }, markResolved: { pathIds: "paths" },
  discard: { scope: "scope", pathIds: "paths" }, undoDiscard: { backupId: "text" },
  commit: { message: "text" }, commitSelected: { message: "text", pathIds: "paths" }, undoCommit: {},
  fetch: { remote: "text" }, stashPush: {}, stashApply: { index: "number", oid: "text" }, stashDrop: { index: "number", oid: "text" },
  branchCreate: { name: "text", start: "text" }, branchSwitch: { name: "text" }, branchTrack: { remote: "text" },
  checkout: { commit: "text" }, branchRename: { name: "text", newName: "text" }, branchDelete: { name: "text" },
  setUpstream: { name: "text", upstream: "text" }, pull: { mode: "pullMode" }, push: {},
  merge: { target: "text" }, mergeAbort: {}, mergeCommit: { message: "text" }
};

export const AI_GIT_OPTIONAL: Record<string, Schema> = {
  stashPush: { message: "text", includeUntracked: "boolean", pathIds: "paths" },
  stashApply: { pop: "boolean" }, branchCreate: { switch: "boolean" }, branchTrack: { localName: "text" },
  pull: {}, push: { remote: "text" }, merge: { noFf: "boolean" }
};

export const AI_VIEW_ACTIONS = ["openSettings", "openHistory", "openOutput", "openCommit", "openFetch", "openPull", "openPush", "openBranchMenu", "refresh", "setScope", "selectFile", "switchProject", "addProject", "removeProject", "setDiffMode", "setHighlight", "setWrap", "setCollapsed", "setAlignChanges", "setFileView", "setFileFilter", "setProjectFilter", "openFileHistory", "viewConflicts"] as const;
export type AiViewAction = typeof AI_VIEW_ACTIONS[number];
export type AiAction =
  | { kind: "git"; summary: string; operation: AiGitOperation }
  | { kind: "fileIgnore"; summary: string; operation: FileIgnoreOperation }
  | { kind: "settings"; summary: string; setting: "themeMode" | "fontSize" | "lightScheme" | "darkScheme" | "aiActiveId" | "aiShortcut"; value: string | number }
  | { kind: "view"; summary: string; view: { action: AiViewAction; value?: string | boolean } }
  | { kind: "answer"; message: string; review?: import("./ai-review/model").ReviewResult }
  | { kind: "commitSelected"; summary: string };

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const valid = (value: unknown, field: Field): boolean => {
  if (field === "text") return typeof value === "string" && value.length > 0 && value.length <= 10_000;
  if (field === "number") return typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (field === "boolean") return typeof value === "boolean";
  if (field === "pathsOrAll") return value === "all" || valid(value, "paths");
  if (field === "paths") return Array.isArray(value) && value.length > 0 && value.length <= 200 && value.every((item) => typeof item === "string" && item.length > 0);
  if (field === "scope") return ["unstaged", "staged", "all"].includes(String(value));
  return value === "ffOnly" || value === "merge";
};

export interface AiActionContext { repoId: string | null; rules: FileIgnoreRule[] }

/** 模型描述规则含义，Oris 负责存储 ID 和默认值；仍由共用校验器校验完整规则。 */
function parseAiFileIgnoreOperation(raw: unknown, context?: AiActionContext): FileIgnoreOperation {
  const input = record(raw);
  if (!input) throw new Error("AI 忽略规则操作无效");
  const adding = input.action === "add";
  const updating = input.action === "update";
  const rule = adding || updating ? record(input.rule) : null;
  if ((adding || updating) && !rule) throw new Error("AI 忽略规则缺少 rule");
  const target = rule ?? input;
  const existing = context?.rules.find(r => r.id === target.id);
  const scope = input.scope;
  if (scope !== undefined && scope !== "repository" && scope !== "global") throw new Error("AI 忽略规则作用范围无效");
  const repoId = scope === "global" ? null : scope === "repository" ? context?.repoId
    : target.repoId !== undefined ? target.repoId : existing ? existing.repoId : context?.repoId;
  if (repoId === undefined || (repoId === null && (scope === "repository" || (adding && scope !== "global" && target.repoId === undefined)))) throw new Error("请先打开目标仓库，或明确使用全局忽略规则");
  if (scope !== undefined && target.repoId !== undefined && target.repoId !== repoId) throw new Error("AI 忽略规则作用范围冲突");
  if (repoId !== null && context && repoId !== context.repoId) throw new Error("目标仓库已切换或不可用，请在目标项目中重新配置");
  if (rule) {
    const pattern = rule.pattern === undefined && updating ? existing?.pattern : rule.pattern;
    const kind = rule.kind === undefined ? (updating ? existing?.kind : undefined)
      ?? (typeof pattern === "string" ? /[?*]/.test(pattern) ? "glob" : /[/\\]/.test(pattern) ? "path" : "name" : undefined) : rule.kind;
    return parseFileIgnoreOperation({ action: input.action, rule: {
      id: adding ? crypto.randomUUID() : rule.id, repoId, kind, pattern,
      enabled: rule.enabled === undefined ? (updating ? existing?.enabled : undefined) ?? true : rule.enabled,
      caseSensitive: rule.caseSensitive === undefined ? (updating ? existing?.caseSensitive : undefined) ?? true : rule.caseSensitive
    } });
  }
  return parseFileIgnoreOperation({ ...input, repoId });
}

export function parseAiAction(raw: unknown, context?: AiActionContext): AiAction {
  const value = record(raw);
  if (!value) throw new Error("AI 未返回可识别的操作计划");
  const summary = typeof value.summary === "string" ? value.summary.slice(0, 500) : "";
  if (value.kind === "fileIgnore") {
    const operation = parseAiFileIgnoreOperation(value.operation, context);
    return { kind: "fileIgnore", summary: fileIgnoreOperationSummary(operation), operation };
  }
  if (value.kind === "answer") return { kind: "answer", message: typeof value.message === "string" ? value.message.slice(0, 4000) : "需要补充操作目标或参数。" };
  if (value.kind === "commitSelected") return { kind: "commitSelected", summary: summary || "选择相关文件并生成提交信息" };
  if (value.kind === "settings") {
    const key = value.setting;
    // V2-D67：Git 可执行文件路径决定 Oris 运行哪个程序（修改后立即运行校验），不交给模型修改。
    if (key === "gitExecutable" || key === "git.executable") throw new Error("AI 不能修改 Git 可执行文件路径，请在“设置 → Git”中手动修改");
    const setting = key === "themeMode" || key === "fontSize" || key === "lightScheme" || key === "darkScheme" || key === "aiActiveId" || key === "aiShortcut" ? key : null;
    if (!setting || (setting === "fontSize" ? typeof value.value !== "number" || !Number.isInteger(value.value) || value.value < 11 || value.value > 18 : typeof value.value !== "string")) throw new Error("AI 返回了无效的设置计划");
    if (setting === "themeMode" && !["light", "dark", "system"].includes(value.value as string)) throw new Error("主题模式无效");
    return { kind: "settings", summary: summary || `修改 ${setting}`, setting, value: value.value as string | number };
  }
  if (value.kind === "view") {
    const view = record(value.view);
    if (!view || !AI_VIEW_ACTIONS.includes(view.action as AiViewAction) || (view.value !== undefined && typeof view.value !== "string" && typeof view.value !== "boolean")) throw new Error("AI 返回了无效的界面操作");
    return { kind: "view", summary: summary || String(view.action), view: { action: view.action as AiViewAction, value: view.value as string | boolean | undefined } };
  }
  if (value.kind !== "git") throw new Error("AI 请求的能力尚未实现");
  const input = record(value.operation);
  const kind = input?.kind;
  if (!input || typeof kind !== "string" || !Object.hasOwn(AI_GIT_SCHEMAS, kind)) throw new Error("AI 返回了不支持的 Git 操作");
  const operation: Record<string, unknown> = { kind };
  for (const [key, field] of Object.entries(AI_GIT_SCHEMAS[kind])) {
    if (!valid(input[key], field)) throw new Error(`AI 操作缺少有效参数：${key}`);
    operation[key] = input[key];
  }
  for (const [key, field] of Object.entries(AI_GIT_OPTIONAL[kind] ?? {})) {
    if (input[key] !== undefined && input[key] !== null) {
      if (!valid(input[key], field)) throw new Error(`AI 操作参数无效：${key}`);
      operation[key] = input[key];
    }
  }
  // 由 Oris 的当前状态补充，绝不采纳模型提供的旧 revision / OID / 强制确认标志。
  return { kind: "git", summary: summary || `执行 ${kind}`, operation: operation as AiGitOperation };
}

export function aiActionCatalogue() {
  return { fileIgnore: {
    kind: "fileIgnore",
    addExample: { kind: "fileIgnore", operation: { action: "add", scope: "repository", rule: { kind: "name", pattern: ".DS_Store" } } },
    operation: {
      action: "add | update | delete | setEnabled", scope: "repository | global；新增默认当前仓库，仅明确要求全局时使用 global",
      rule: { pattern: "文件名、仓库相对路径或 glob", kind: "name | path | glob；省略时按模式推导", enabled: "可选 boolean，新增默认 true", caseSensitive: "可选 boolean，新增默认 true" },
      note: "add 传 rule，不填写内部 ID 或 repoId，Oris 自动生成 ID 并绑定当前仓库。name=.DS_Store 匹配任意目录同名文件。update 传 rule.id（必须来自当前规则）及要修改的字段，未提供字段保留原值。delete/setEnabled 传现有 id，setEnabled 另传 enabled。更新、删除、启停不指定 scope 时保留现有范围。读取规则用 answer。规则不修改 Git ignore；无 / 的 glob 匹配任意目录文件名；* 段内，? 单字符，** 独占段；不支持 ! [] {}。"
    }
  }, git: Object.entries(AI_GIT_SCHEMAS).map(([kind, required]) => ({ kind, required, optional: AI_GIT_OPTIONAL[kind] ?? {} })), settings: { themeMode: ["light", "dark", "system"], fontSize: [11, 18], lightScheme: "方案 ID", darkScheme: "方案 ID", aiActiveId: "已保存的 AI 配置 ID", aiShortcut: "CtrlOrMeta+P 等组合键" }, view: AI_VIEW_ACTIONS, note: "view 的 value 为目标路径、项目 ID、文件 ID、枚举值或布尔值；无参数的操作不需要 value。stage/unstage 的 pathIds 可为具体文件 ID 数组，或字符串 all，表示当前范围中未被忽略的文件（不受临时路径搜索影响）。被忽略文件仍保持真实 Git 状态，提交前核对隐藏的暂存内容。用户要求暂存或取消暂存但未限定部分文件时，使用 all；明确限定部分文件时才选择具体文件 ID。描述驱动提交用 commitSelected。" };
}

export const aiScope = (value: string): CompareScope | null => value === "unstaged" || value === "staged" || value === "all" ? value : null;
