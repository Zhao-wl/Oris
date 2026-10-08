import { RECOMMENDED_AI_COMMANDS, type AiRuleSet } from "./ai-rules";
/** 标签加载任务规则；用户明确发送的请求仍是执行依据。 */
export interface AiPromptTag { id: string; name: string; label: string; detail: string }
export const AI_PROMPT_TAGS: AiPromptTag[] = RECOMMENDED_AI_COMMANDS.map(c => ({ id: c.id, name: c.tag, label: `@${c.tag}`, detail: c.description }));
export function configuredPromptTags(rules: AiRuleSet): AiPromptTag[] {
  return rules.commands.filter(c => c.enabled && rules.routes.some(r => r.commandId === c.id && r.enabled))
    .map(c => ({ id: c.id, name: c.tag, label: `@${c.tag}`, detail: c.description }));
}

export interface PromptTagMatch { start: number; end: number; query: string }

const isSpace = (char: string) => /\s/u.test(char);

/** 仅在输入光标所在的独立词以 @ 开始时提供候选。 */
export function activePromptTag(text: string, caret: number): PromptTagMatch | null {
  if (caret < 0 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !isSpace(text[start - 1])) start--;
  if (text[start] !== "@") return null;
  let end = caret;
  while (end < text.length && !isSpace(text[end])) end++;
  const query = text.slice(start + 1, caret);
  // 标点连接或正文中的 @ 不作为提示词标签。
  if (/[\p{P}\p{S}]/u.test(query) || /[\p{P}\p{S}]/u.test(text.slice(caret, end))) return null;
  return { start, end, query };
}

export function matchingPromptTags(query: string, tags: readonly AiPromptTag[] = AI_PROMPT_TAGS): readonly AiPromptTag[] {
  const normalized = query.toLocaleLowerCase();
  return tags.filter((tag) => tag.name.toLocaleLowerCase().startsWith(normalized));
}

/** 选择候选时保证标签后有空格，并把光标放在该空格后。 */
export function insertPromptTag(text: string, match: PromptTagMatch, tag: AiPromptTag): { text: string; caret: number } {
  const before = text.slice(0, match.start);
  const after = text.slice(match.end);
  const addSpace = !after.length || !isSpace(after[0]);
  const inserted = `${tag.label}${addSpace ? " " : ""}`;
  const next = `${before}${inserted}${after}`;
  return { text: next, caret: before.length + tag.label.length + 1 };
}

/** 提示词注入仅识别两侧为空白或文本边界的完整标签。 */
export function mentionedPromptTags(text: string, tags: readonly AiPromptTag[] = AI_PROMPT_TAGS): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)(?=\s|$)/gu)) {
    const tag = tags.find(t => t.name.toLowerCase() === match[1].toLowerCase());
    if (tag) found.add(tag.name);
  }
  return found;
}
