/** @ 标签只选择要注入的提示词包，不直接决定或执行操作。 */
export const AI_PROMPT_TAGS = [
  { name: "Git", label: "@Git", detail: "Git 操作与仓库状态" },
  { name: "设置", label: "@设置", detail: "外观、Git 与 AI 设置" },
  { name: "提交", label: "@提交", detail: "选择文件并生成提交信息" },
  { name: "拉取", label: "@拉取", detail: "当前分支与上游的拉取流程" },
  { name: "合并", label: "@合并", detail: "分支目标与合并流程" }
] as const;

export type AiPromptTag = typeof AI_PROMPT_TAGS[number];
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

export function matchingPromptTags(query: string): readonly AiPromptTag[] {
  const normalized = query.toLocaleLowerCase();
  return AI_PROMPT_TAGS.filter((tag) => tag.name.toLocaleLowerCase().startsWith(normalized));
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
export function mentionedPromptTags(text: string): Set<AiPromptTag["name"]> {
  const found = new Set<AiPromptTag["name"]>();
  for (const match of text.matchAll(/(^|\s)@(Git|设置|提交|拉取|合并)(?=\s|$)/gu)) found.add(match[2] as AiPromptTag["name"]);
  return found;
}
