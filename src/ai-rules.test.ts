import { describe, expect, it } from "vitest";
import { defaultAiRuleSet, exportAiRules, importAiRules, parseAiRuleBundle, resolveAiRoute, resolveStagedProfile, validateAiRuleSet } from "./ai-rules";
import { createSettingsRegistry, DEFAULT_AI_PROMPTS, loadSettings, SETTINGS_KEY, SETTINGS_VERSION } from "./settings";
import { schemeIndex } from "./themes/runtime";
const profiles = [
  { id: "a", name: "日常", kind: "api" as const, provider: "openai" as const, executable: "C:/private.exe", baseUrl: "https://private.example?key=secret", model: "model-a", hasKey: true },
  { id: "b", name: "深入", kind: "cli" as const, provider: "claude" as const, executable: "C:/private-cli", baseUrl: "", model: "model-b", hasKey: false }
];
const ai = () => ({ profiles, activeId: "a", shortcut: "", prompts: DEFAULT_AI_PROMPTS, ruleSet: defaultAiRuleSet() });
describe("AI rule routing", () => {
  it("does not inherit commands, resolves defaults and overrides, and snapshots the selected model", () => {
    const settings = ai(); settings.ruleSet.routes.find(r => r.commandId === "review")!.profileId = "b";
    const first = resolveAiRoute(settings, "@审查 检查改动");
    expect(first.profile.id).toBe("b"); expect(first.mode).toBe("answer");
    expect(resolveAiRoute(settings, "第二个问题呢？").profile.id).toBe("a");
    expect(resolveAiRoute(settings, "@审查 继续", "a").overridden).toBe(true);
    expect(resolveAiRoute(settings, "@解释 说明原因").commandId).toBe("explain");
    settings.profiles = settings.profiles.map(p => ({ ...p, model: "changed" }));
    expect(first.profile.model).toBe("model-b");
    settings.ruleSet.stagedMessageProfileId = "b"; expect(resolveStagedProfile(settings).id).toBe("b");
  });
  it("fails closed for unknown/multiple/disabled/deleted commands and missing models", () => {
    const settings = ai();
    expect(() => resolveAiRoute(settings, "@未知 请求")).toThrow("未知指令");
    expect(() => resolveAiRoute(settings, "@审查 @提交 请求")).toThrow("一条主指令");
    settings.ruleSet.routes.find(r => r.commandId === "review")!.profileId = "";
    expect(() => resolveAiRoute(settings, "@审查 请求")).toThrow("不可用");
    settings.ruleSet.routes.find(r => r.commandId === "review")!.enabled = false;
    expect(() => resolveAiRoute(settings, "@审查 继续", "a")).toThrow("停用");
    settings.ruleSet.commands = settings.ruleSet.commands.filter(c => c.id !== "review");
    expect(() => resolveAiRoute(settings, "@审查 继续")).toThrow("未知指令");
    expect(resolveAiRoute(ai(), "mail@example.com @审查, 是普通文本").commandId).toBeNull();
  });
});
describe("portable AI rules", () => {
  it("exports only whitelisted data and round-trips after explicit local target mapping", () => {
    const rules = defaultAiRuleSet(); rules.routes[0].profileId = "b"; rules.defaultProfileId = "a";
    const source = JSON.stringify(exportAiRules(rules, profiles, "团队规则"));
    expect(source).not.toMatch(/private|hasKey|baseUrl|executable/);
    const bundle = parseAiRuleBundle(source), mapping = Object.fromEntries(bundle.targets.map(t => [t.id, t.model === "model-a" ? "a" : "b"]));
    const imported = importAiRules(defaultAiRuleSet(), bundle, mapping, "replace", "keep");
    expect(imported).toEqual(rules);
    const unbound = importAiRules(defaultAiRuleSet(), bundle, {}, "replace", "keep");
    expect(unbound.defaultProfileId).toBe("");
    expect(() => resolveAiRoute({ ...ai(), ruleSet: unbound }, "@状态 检查")).toThrow("不可用");
  });
  it("keeps, replaces or renames conflicts without mutating the original set", () => {
    const current = defaultAiRuleSet(), source = defaultAiRuleSet(); source.commands[0].prompt = "新的规则";
    const bundle = exportAiRules(source, [], "import");
    expect(importAiRules(current, bundle, {}, "merge", "keep").commands[0].prompt).toBe(current.commands[0].prompt);
    expect(importAiRules(current, bundle, {}, "merge", "replace").commands.find(c => c.tag === "状态")?.prompt).toBe("新的规则");
    const renamed = importAiRules(current, bundle, {}, "merge", "rename");
    expect(renamed.commands.some(c => c.tag === "状态_2")).toBe(true);
    expect(new Set(renamed.routes.map(r => r.commandId)).size).toBe(renamed.routes.length);
    expect(current.commands[0].prompt).not.toBe("新的规则");
  });
  it("rejects unsupported versions, dangling references and duplicates", () => {
    const bundle = exportAiRules(defaultAiRuleSet(), [], "rules");
    expect(() => parseAiRuleBundle(JSON.stringify({ ...bundle, version: 2 }))).toThrow("版本");
    expect(() => parseAiRuleBundle(JSON.stringify({ ...bundle, defaultTarget: "missing" }))).toThrow("不存在");
    expect(validateAiRuleSet({ ...defaultAiRuleSet(), commands: [bundle.commands[0], bundle.commands[0]] })).toBeUndefined();
  });
});
it("migrates only customized legacy prompts and preserves deliberate deletions", () => {
  const registry = createSettingsRegistry({ schemes: schemeIndex });
  const old = { version: SETTINGS_VERSION, ai: { profiles, activeId: "b", prompts: { ...DEFAULT_AI_PROMPTS, describedCommit: "只写英文", gitActions: "旧 Git 约束" } } };
  const loaded = loadSettings({ getItem: key => key === SETTINGS_KEY ? JSON.stringify(old) : null }, registry).settings;
  expect(loaded.ai.ruleSet.commands.find(c => c.tag === "提交")?.prompt).toBe("只写英文");
  expect(loaded.ai.ruleSet.commands.find(c => c.tag === "Git")?.prompt).toBe("旧 Git 约束");
  expect(loaded.ai.activeId).toBe("b");
  loaded.ai.ruleSet.commands = []; loaded.ai.ruleSet.routes = [];
  expect(loadSettings({ getItem: key => key === SETTINGS_KEY ? JSON.stringify(loaded) : null }, registry).settings.ai.ruleSet.commands).toEqual([]);
});
it("keeps built-in review read-only even when imported settings request action mode", () => {
  const config = ai(); config.ruleSet.commands.find(c => c.id === "review")!.mode = "action";
  expect(resolveAiRoute(config, "@审查 检查").mode).toBe("answer");
});
