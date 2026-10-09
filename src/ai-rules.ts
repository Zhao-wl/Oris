import type { AiProfile, AiSettings } from "./settings/model";

export const AI_CONTEXTS = {
  status: "仓库状态", diff: "当前文件差异", refs: "分支与远端",
  history: "提交记录", settings: "外观与 AI 设置", changes: "可提交文件差异"
} as const;
export type AiContext = keyof typeof AI_CONTEXTS;
export interface AiCommand {
  id: string; tag: string; name: string; description: string; prompt: string;
  mode: "answer" | "action"; contexts: AiContext[]; enabled: boolean;
}
export interface AiRoute { id: string; commandId: string; profileId: string | null; enabled: boolean }
/** null 跟随当前默认组合；空字符串表示导入后尚未绑定，不允许执行。 */
export interface AiRuleSet {
  version: 1; commands: AiCommand[]; routes: AiRoute[];
  defaultProfileId: string | null; stagedMessageProfileId: string | null; selectionProfileId?: string | null;
  contextWindowTokens?: number; contextTaskTokens?: number;
}
const command = (id: string, tag: string, description: string, mode: AiCommand["mode"], contexts: AiContext[], prompt: string): AiCommand =>
  ({ id, tag, name: description, description, mode, contexts, prompt, enabled: true });
export const RECOMMENDED_AI_COMMANDS: AiCommand[] = [
  command("status", "状态", "梳理仓库状态与下一步", "answer", ["status", "refs"], "根据当前分支、上游关系、已暂存和未暂存文件、进行中的 Git 操作概括工作状态。优先说明阻碍，再给出直接的下一步建议；未知信息明确标注。本指令只分析。"),
  command("explain", "解释", "解释当前文件的改动", "answer", ["diff"], "先概括当前文件的变化，再说明关键改动改变了什么行为、可能的目的及影响场景。结合代码说明，避免逐行复述，推断明确标注。"),
  command("review", "审查", "检查实际缺陷与边界条件", "answer", ["status", "diff"], "审查提供的改动，优先寻找逻辑错误、边界条件、异常路径、兼容性和数据丢失问题。每个问题说明位置、触发条件、影响及修正方向。只报告有代码依据的问题，不把风格偏好当作缺陷；无明确问题时直接说明，并指出无法核实的部分。"),
  command("commit", "提交", "按意图选择文件并提交", "action", ["status"], "根据用户提交目标选择直接相关的整文件，并依据实际差异撰写中文提交信息。标题说明具体变化，必要时解释原因，不编造测试结果。按功能选择时排除无关改动。Oris 只能整文件提交，不能拆分同一文件内的混合改动；范围不明确时先澄清。提交的文件选择交给专用提交流程。"),
  command("pull", "拉取", "更新当前分支到上游", "action", ["status", "refs"], "以当前分支已配置上游为默认目标，默认仅快进拉取。上游缺失、目标不明确或状态不满足条件时说明原因，不擅自切换分支、储藏改动或改用其他整合方式。"),
  command("merge", "合并", "将指定分支合入当前分支", "action", ["status", "refs"], "将用户指定分支合入当前分支，明确来源与接收分支。使用真实存在的引用，名称歧义或目标缺失时先澄清。遵循应用执行校验；冲突时说明当前状态，不自动选择一侧覆盖。"),
  command("history", "历史", "梳理最近提交的变化脉络", "answer", ["history"], "围绕用户关注的功能、作者或时间整理提供的提交记录，标明相关提交。区分标题描述与核实的代码变化；只有标题和作者时不推断实现细节、测试结果或是否彻底解决问题。记录不足时说明限制。"),
  command("settings", "设置", "调整外观、快捷键、文件忽略规则与 AI 配置", "action", ["settings"], "将用户需求映射到支持的设置项和值，使用已有配色和 AI 配置。目标明确时生成对应操作，模糊要求先澄清。变更文件忽略使用 fileIgnore 动作，目标未明确全局时仅配置当前仓库，读取规则用 answer。新增配置、凭据或不支持的设置，引导到设置界面，不虚构配置。")
];
export const defaultAiRuleSet = (): AiRuleSet => ({
  version: 1, commands: structuredClone(RECOMMENDED_AI_COMMANDS),
  routes: RECOMMENDED_AI_COMMANDS.map(c => ({ id: `route-${c.id}`, commandId: c.id, profileId: null, enabled: true })),
  defaultProfileId: null, stagedMessageProfileId: null, selectionProfileId: null
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !v.includes("\0");
export const validCommandTag = (v: string) => /^[\p{L}\p{N}_-]{1,40}$/u.test(v);
const binding = (v: unknown): v is string | null => v === null || v === "" || id(v);
export function validateAiRuleSet(v: unknown): AiRuleSet | undefined {
  if (!object(v) || v.version !== 1 || !Array.isArray(v.commands) || !Array.isArray(v.routes)
    || v.commands.length > 100 || v.routes.length > 100 || !binding(v.defaultProfileId) || !binding(v.stagedMessageProfileId)) return undefined;
  const commands: AiCommand[] = [], routes: AiRoute[] = [];
  for (const c of v.commands) {
    if (!object(c) || !id(c.id) || !text(c.tag, 40) || !validCommandTag(c.tag) || !text(c.name, 100) || !c.name.trim()
      || !text(c.description, 200) || !text(c.prompt, 10000) || !["answer", "action"].includes(String(c.mode)) || typeof c.enabled !== "boolean"
      || !Array.isArray(c.contexts) || c.contexts.length > Object.keys(AI_CONTEXTS).length
      || !c.contexts.every(x => typeof x === "string" && Object.hasOwn(AI_CONTEXTS, x))) return undefined;
    commands.push({ id: c.id, tag: c.tag, name: c.name, description: c.description, prompt: c.prompt,
      mode: c.mode as AiCommand["mode"], enabled: c.enabled, contexts: [...new Set(c.contexts)] as AiContext[] });
  }
  if (new Set(commands.map(c => c.id)).size !== commands.length || new Set(commands.map(c => c.tag.toLowerCase())).size !== commands.length) return undefined;
  for (const r of v.routes) {
    if (!object(r) || !id(r.id) || !id(r.commandId) || !commands.some(c => c.id === r.commandId) || !binding(r.profileId) || typeof r.enabled !== "boolean") return undefined;
    routes.push({ id: r.id, commandId: r.commandId, profileId: r.profileId, enabled: r.enabled });
  }
  if (new Set(routes.map(r => r.id)).size !== routes.length || new Set(routes.map(r => r.commandId)).size !== routes.length) return undefined;
  for (const key of ["contextWindowTokens", "contextTaskTokens"] as const) if(v[key] !== undefined && (!Number.isInteger(v[key]) || Number(v[key]) < 16384 || Number(v[key]) > 1048576)) return undefined;
  if (v.selectionProfileId !== undefined && !binding(v.selectionProfileId)) return undefined;
  return { version: 1, commands, routes, defaultProfileId: v.defaultProfileId, stagedMessageProfileId: v.stagedMessageProfileId, selectionProfileId: v.selectionProfileId as string | null | undefined, ...(v.contextWindowTokens===undefined?{}:{contextWindowTokens:Number(v.contextWindowTokens)}), ...(v.contextTaskTokens===undefined?{}:{contextTaskTokens:Number(v.contextTaskTokens)}) };
}
export interface AiResolvedRoute {
  commandId: string | null; commandTag: string | null; ruleId: string; ruleName: string;
  profile: AiProfile; mode: "answer" | "action"; contexts: AiContext[]; prompt: string; overridden: boolean;
}
export const hasAiCommand = (input: string) => /(?:^|\s)@([\p{L}\p{N}_-]+)(?=\s|$)/u.test(input);
export function resolveAiRoute(ai: AiSettings, input: string, override: string | null = null): AiResolvedRoute {
  const tags = [...new Set([...input.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)(?=\s|$)/gu)].map(m => m[1].toLowerCase()))];
  if (tags.length > 1) throw new Error("一次只能使用一条主指令，请选择一个 @指令");
  const c = tags.length ? ai.ruleSet.commands.find(c => c.tag.toLowerCase() === tags[0]) : undefined;
  if (tags.length && !c) throw new Error(`未知指令 @${tags[0]}`);
  if (c && !c.enabled) throw new Error(`@${c.tag} 已停用`);
  const r = c ? ai.ruleSet.routes.find(r => r.commandId === c.id) : null;
  if (c && (!r || !r.enabled)) throw new Error(`@${c.tag} 的路由未配置或已停用`);
  const profileId = override ?? r?.profileId ?? ai.ruleSet.defaultProfileId ?? ai.activeId;
  const profile = ai.profiles.find(p => p.id === profileId);
  if (!profile || !profile.model.trim() || (profile.kind === "api" && !profile.hasKey)) throw new Error("路由目标未配置或不可用，请在设置 → AI → 连接与模型／规则路由中完成配置");
  return { commandId: c?.id ?? null, commandTag: c?.tag ?? null, ruleId: r?.id ?? "default", ruleName: c ? `${c.name}规则` : "默认规则",
    profile: { ...profile }, mode: c?.id === "review" ? "answer" : c?.mode ?? "action", contexts: c ? [...c.contexts] : ["status", "diff", "refs", "settings"], prompt: c?.prompt ?? "", overridden: override !== null };
}
export function resolveStagedProfile(ai: AiSettings): AiProfile {
  const profileId = ai.ruleSet.stagedMessageProfileId ?? ai.ruleSet.defaultProfileId ?? ai.activeId;
  const profile = ai.profiles.find(p => p.id === profileId);
  if (!profile || !profile.model.trim() || (profile.kind === "api" && !profile.hasKey)) throw new Error("提交信息生成路由的 AI 配置不可用，请在设置 → AI → 规则路由中配置");
  return { ...profile };
}
export interface AiConversationMessage { role: "user" | "assistant" | "operation" | "tool"; content: string }
export interface AiTurn {
  isActive?: () => boolean;
  attachments?: import("./context-selection/model").Attachment[];
  reviewRequest?: import("./ai-review/model").ReviewRequest;
  route: AiResolvedRoute; history: AiConversationMessage[]; historyTruncated: boolean;
  repoId: string | null; branch: string | null; systemPrompt: string; commitPrompt: string;
  /** 主会话追加式传输前缀；一次性指令不携带此字段。 */
  sessionTranscript?: string; requestTranscript?: string;
}
/** JSONL 保持已发送部分不变，仓库快照和工具结果只追加到末尾。 */
export const sessionEvent = (role: string, content: string) => `${JSON.stringify({ role, content })}\n`;
export function conversationContext(messages: AiConversationMessage[]): { history: AiConversationMessage[]; historyTruncated: boolean } {
  const history: AiConversationMessage[] = []; let size = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (history.length >= 24 || size + messages[i].content.length > 32000) break;
    size += messages[i].content.length; history.unshift(messages[i]);
  }
  return { history, historyTruncated: history.length !== messages.length };
}

interface PortableTarget { id: string; name: string; provider: string; model: string }
export interface AiRuleBundle {
  format: "oris-ai-rules"; version: 1; name: string; commands: AiCommand[];
  routes: { id: string; commandId: string; target: string | null; enabled: boolean }[];
  targets: PortableTarget[]; defaultTarget: string | null; stagedMessageTarget: string | null; selectionTarget?: string | null;
}
export function exportAiRules(rules: AiRuleSet, profiles: AiProfile[], name: string): AiRuleBundle {
  const clean = validateAiRuleSet(rules); if (!clean) throw new Error("当前规则集无效");
  const targets: PortableTarget[] = [], slots = new Map<string, string>();
  const slot = (profileId: string | null): string | null => {
    if (profileId === null) return null;
    if (slots.has(profileId)) return slots.get(profileId)!;
    const p = profiles.find(p => p.id === profileId), targetId = `target-${targets.length + 1}`;
    slots.set(profileId, targetId); targets.push({ id: targetId, name: p?.name ?? "待绑定配置", provider: p?.provider ?? "", model: p?.model ?? "" });
    return targetId;
  };
  const routes = clean.routes.map(({ profileId, ...r }) => ({ ...r, target: slot(profileId) }));
  const defaultTarget = slot(clean.defaultProfileId), stagedMessageTarget = slot(clean.stagedMessageProfileId), selectionTarget = slot(clean.selectionProfileId ?? null);
  return { format: "oris-ai-rules", version: 1, name: name.trim().slice(0, 100) || "我的 AI 规则", commands: clean.commands, routes, targets, defaultTarget, stagedMessageTarget, selectionTarget };
}
export function parseAiRuleBundle(source: string): AiRuleBundle {
  if (source.length > 1_000_000) throw new Error("规则文件不能超过 1 MB");
  let v: unknown; try { v = JSON.parse(source.replace(/^\uFEFF/, "")); } catch { throw new Error("规则文件不是有效的 JSON"); }
  if (!object(v) || v.format !== "oris-ai-rules" || v.version !== 1) throw new Error("不支持的规则文件格式或版本");
  if (!text(v.name, 100) || !Array.isArray(v.targets) || v.targets.length > 103 || !Array.isArray(v.routes)) throw new Error("规则文件结构无效");
  const targets: PortableTarget[] = [];
  for (const t of v.targets) {
    if (!object(t) || !id(t.id) || !text(t.name, 100) || !text(t.provider, 40) || !text(t.model, 4096)) throw new Error("规则目标结构无效");
    targets.push({ id: t.id, name: t.name, provider: t.provider, model: t.model });
  }
  if (new Set(targets.map(t => t.id)).size !== targets.length) throw new Error("规则目标标识重复");
  const targetValid = (t: unknown) => t === null || targets.some(x => x.id === t);
  if (!targetValid(v.defaultTarget) || !targetValid(v.stagedMessageTarget) || (v.selectionTarget !== undefined && !targetValid(v.selectionTarget))) throw new Error("默认规则引用了不存在的目标");
  const routes = v.routes.map(r => {
    if (!object(r) || !targetValid(r.target)) throw new Error("路由引用了不存在的目标");
    return { id: r.id, commandId: r.commandId, profileId: r.target, enabled: r.enabled };
  });
  const clean = validateAiRuleSet({ version: 1, commands: v.commands, routes, defaultProfileId: v.defaultTarget, stagedMessageProfileId: v.stagedMessageTarget, selectionProfileId: v.selectionTarget ?? null });
  if (!clean) throw new Error("指令或路由无效：请检查重复标识、匹配指令和字段范围");
  return { format: "oris-ai-rules", version: 1, name: v.name, commands: clean.commands, targets,
    routes: clean.routes.map(({ profileId, ...r }) => ({ ...r, target: profileId })), defaultTarget: clean.defaultProfileId, stagedMessageTarget: clean.stagedMessageProfileId, selectionTarget: clean.selectionProfileId };
}
export type ImportConflict = "keep" | "replace" | "rename";
/** 构造完整新值后统一提交；解析或冲突失败时不修改设置。 */
export function importAiRules(current: AiRuleSet, bundle: AiRuleBundle, mappings: Record<string, string>, mode: "merge" | "replace", conflict: ImportConflict): AiRuleSet {
  const next: AiRuleSet = mode === "replace" ? { version: 1, commands: [], routes: [], defaultProfileId: null, stagedMessageProfileId: null } : structuredClone(current);
  const mapped = (target: string | null) => target === null ? null : Object.hasOwn(mappings, target) ? mappings[target] : "";
  if (mode === "replace") { next.defaultProfileId = mapped(bundle.defaultTarget); next.stagedMessageProfileId = mapped(bundle.stagedMessageTarget); next.selectionProfileId = mapped(bundle.selectionTarget ?? null); }
  const freshId = (used: string[]) => { let nextId: string; do { nextId = crypto.randomUUID(); } while (used.includes(nextId)); return nextId; };
  for (const imported of bundle.commands) {
    const existing = next.commands.find(c => c.tag.toLowerCase() === imported.tag.toLowerCase());
    if (existing && conflict === "keep" && mode === "merge") continue;
    const c = structuredClone(imported);
    if (existing && conflict === "rename" && mode === "merge") {
      let n = 2; const base = c.tag.slice(0, 32); while (next.commands.some(x => x.tag.toLowerCase() === `${base}_${n}`.toLowerCase())) n++;
      c.tag = `${base}_${n}`;
    }
    c.id = existing && conflict === "replace" ? existing.id : next.commands.some(x => x.id === c.id) ? freshId(next.commands.map(x => x.id)) : c.id;
    if (existing && conflict === "replace") { next.commands = next.commands.filter(x => x.id !== existing.id); next.routes = next.routes.filter(x => x.commandId !== existing.id); }
    next.commands.push(c);
    const r = bundle.routes.find(r => r.commandId === imported.id);
    if (r) next.routes.push({ id: next.routes.some(x => x.id === r.id) ? freshId(next.routes.map(x => x.id)) : r.id, commandId: c.id, profileId: mapped(r.target), enabled: r.enabled });
  }
  const valid = validateAiRuleSet(next); if (!valid) throw new Error("导入后规则超出限制或存在冲突，原规则未修改");
  return valid;
}
