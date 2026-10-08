import { expect, it } from "vitest";
import { activePromptTag, insertPromptTag, matchingPromptTags, mentionedPromptTags } from "./ai-prompt-tags";

it("offers tags only at the start or after whitespace", () => {
  expect(matchingPromptTags(activePromptTag("@", 1)!.query)).toHaveLength(8);
  expect(activePromptTag("请 @拉", 4)).toEqual({ start: 2, end: 4, query: "拉" });
  expect(activePromptTag("请@", 2)).toBeNull();
  expect(activePromptTag("(@", 2)).toBeNull();
  expect(activePromptTag("@Git,", 5)).toBeNull();
  expect(matchingPromptTags("审").map((tag) => tag.label)).toEqual(["@审查"]);
});

it("inserts a whole tag with a trailing separator", () => {
  const tag = matchingPromptTags("拉")[0];
  expect(insertPromptTag("请 @拉", activePromptTag("请 @拉", 4)!, tag)).toEqual({ text: "请 @拉取 ", caret: 6 });
  expect(insertPromptTag("@设置 后续", activePromptTag("@设置 后续", 3)!, matchingPromptTags("设置")[0])).toEqual({ text: "@设置 后续", caret: 4 });
});

it("loads only standalone completed prompt tags", () => {
  expect([...mentionedPromptTags("@审查 @拉取 操作")]).toEqual(["审查", "拉取"]);
  expect([...mentionedPromptTags("前缀@Git @GitHub @提交, @设置好 @合并\n处理")]).toEqual(["合并"]);
  expect([...mentionedPromptTags("请 @设置 调大字号")]).toEqual(["设置"]);
});
