// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AiCommitDialog from "./AiCommitDialog";
import type { AiPlan } from "./ai-api";
import type { AiAction } from "./ai-actions";
import { createSettingsRegistry, SettingsStore } from "./settings";
import { schemeIndex } from "./themes/runtime";
import type { AiTurn } from "./ai-rules";

vi.mock("./ai-review/model", async (original) => ({ ...(await original<typeof import("./ai-review/model")>()),
  reviewInventory: vi.fn(async (repoId: string, range: unknown) => ({ repoId, range, identity: "review-id", revision: "rev", left: "oid", right: "workingTree", totalFiles: 1,
    files: [{ pathId: "a", path: "a.txt", oldPathId: null, oldPath: null, status: "modified" }] }))
}));
let host: HTMLDivElement;
let root: Root;
let settings: SettingsStore;
const plan: AiPlan = { message: "feat: add feature", pathIds: ["a"], revision: "rev", candidates: [{ pathId: "a", displayPath: "a.txt", oldPathId: null }, { pathId: "b", displayPath: "b.txt", oldPathId: null }] };
const generate = vi.fn(async (_description: string, _requestId: string, _turn: AiTurn) => plan);
const planAction = vi.fn(async (_description: string, _requestId: string, _turn: AiTurn): Promise<AiAction> => ({ kind: "commitSelected", summary: "提交选中文件" }));
const executeAction = vi.fn(async (_action: AiAction, _turn: AiTurn) => "应用操作已完成");
const commit = vi.fn(async (_plan: AiPlan, _turn: AiTurn) => "提交已完成");
const cancel = vi.fn(async () => {});
const close = vi.fn();
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const type = async (element: HTMLTextAreaElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); };
const render = async () => { await act(async () => root.render(<AiCommitDialog settings={settings} project={{ repoId: "repo", name: "Oris", branch: "main" }} onGenerate={generate} onPlanAction={planAction} onExecuteAction={executeAction} onCancelGeneration={cancel} onCommit={commit} onClose={close}/>)); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  settings = new SettingsStore({ getItem: () => null, setItem: () => {} }, createSettingsRegistry({ schemes: schemeIndex }));
  settings.update("ai", "profiles", [{ id: "test-ai", name: "测试模型", kind: "cli", provider: "codex", executable: "", baseUrl: "", model: "model-a", hasKey: false }, { id: "deep", name: "深入分析", kind: "cli", provider: "claude", executable: "", baseUrl: "", model: "model-b", hasKey: false }]);
  settings.update("ai", "activeId", "test-ai");
  generate.mockClear(); planAction.mockClear(); executeAction.mockClear(); commit.mockClear(); cancel.mockClear(); close.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("executes a generated commit without a second confirmation", async () => {
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  expect(input.rows).toBe(2);
  expect(host.querySelector('.ai-commit-actions input[type="checkbox"]')).toBeNull();
  await type(input, "提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(generate).toHaveBeenCalledWith("提交功能 A", expect.any(String), expect.objectContaining({ repoId: "repo" }));
  expect(commit).toHaveBeenCalledWith(plan, expect.objectContaining({ repoId: "repo" }));
  expect(host.querySelector(".ai-commit-preview")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(host.querySelector("[role=log]")?.textContent).toContain("提交已完成");
});

it("also executes an explicitly direct commit", async () => {
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "直接提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(commit).toHaveBeenCalledWith(plan, expect.any(Object));
  expect(close).not.toHaveBeenCalled();
});

it("shows progress and cancels generation when the input closes", async () => {
  let finish!: (value: AiAction) => void;
  planAction.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "提交功能 A");
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!.click(); });
  expect(host.querySelector('.ai-input-progress .ai-spinner')).not.toBeNull();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!.value).toBe("");
  expect(host.querySelector('[role=log]')?.textContent).toContain("提交功能 A");
  expect(host.querySelector('.ai-input-progress')?.textContent).not.toContain("处理中");
  const requestId = planAction.mock.calls[0][1];
  await act(async () => { host.querySelector(".ai-commit-overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(cancel).toHaveBeenCalledWith(requestId);
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ kind: "commitSelected", summary: "提交选中文件" }); });
  expect(commit).not.toHaveBeenCalled();
});

it("stops without committing when AI cannot reliably match files", async () => {
  generate.mockResolvedValueOnce({ ...plan, pathIds: [], selectionWarning: "请手动勾选要提交的文件" });
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "直接提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(commit).not.toHaveBeenCalled();
  expect(host.textContent).toContain("请手动勾选要提交的文件");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!.value).toBe("");
  expect(host.querySelector('.ai-commit-preview')).toBeNull();
});

it("executes a settings action as soon as planning finishes", async () => {
  planAction.mockResolvedValueOnce({ kind: "settings", summary: "将字号设为 16", setting: "fontSize", value: 16 });
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "字体改成 16");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(executeAction).toHaveBeenCalledWith({ kind: "settings", summary: "将字号设为 16", setting: "fontSize", value: 16 }, expect.any(Object));
  expect(close).not.toHaveBeenCalled();
  expect(host.querySelector(".ai-commit-preview")).toBeNull();
});

it("shows prompt suggestions for a standalone @ and inserts a selected tag", async () => {
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  await type(input, "@");
  expect(host.querySelectorAll('[role="listbox"] [role="option"]')).toHaveLength(8);
  await type(input, "@设");
  expect(host.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("@设置");
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(input.value).toBe("@设置 ");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(planAction).not.toHaveBeenCalled();
});

it("does not suggest an embedded @ and Escape closes suggestions before the dialog", async () => {
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  await type(input, "字词@");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  await type(input, "请 @审查");
  expect(host.querySelectorAll('[role="listbox"] [role="option"]')).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

it("returns command clarification to the primary model without inheriting its rule", async () => {
  planAction.mockResolvedValueOnce({ kind: "answer", message: "develop 还是 development？" });
  planAction.mockResolvedValueOnce({ kind: "git", summary: "合并 develop", operation: { kind: "merge", target: "refs/heads/develop", expected: "head" } });
  planAction.mockResolvedValueOnce({ kind: "answer", message: "合并已经完成。" });
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  await type(input, "@合并 开发分支"); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  await type(input, "develop"); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(planAction.mock.calls[1][2].route.commandId).toBeNull();
  expect(planAction.mock.calls[1][2].sessionTranscript).toContain("develop 还是 development？");
  expect(planAction.mock.calls[1][2].history.map(m => m.content)).toEqual(["@合并 开发分支", "develop 还是 development？"]);
  await type(input, "结果呢？"); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(planAction.mock.calls[2][2].history).toContainEqual({ role: "operation", content: "应用操作已完成" });
  expect(close).not.toHaveBeenCalled();
});

it("blocks actions in answer-only mode even if the model proposes a commit", async () => {
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "@审查 检查问题");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(host.querySelector('[role=alert]')?.textContent).toContain("只允许回答");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!.value).toBe("");
  expect(generate).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(executeAction).not.toHaveBeenCalled();
});

it("pins the routed model across both command commit stages without changing the primary model", async () => {
  const rules = settings.get().ai.ruleSet;
  settings.update("ai", "ruleSet", { ...rules, routes: rules.routes.map(r => r.commandId === "commit" ? { ...r, profileId: "deep" } : r) });
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "@提交 功能 A");
  planAction.mockImplementationOnce(async (_text, _id, turn) => {
    settings.update("ai", "activeId", "test-ai");
    settings.update("ai", "profiles", settings.get().ai.profiles.map(p => p.id === "deep" ? { ...p, model: "model-c" } : p));
    expect(turn.route.profile.model).toBe("model-b");
    return { kind: "commitSelected", summary: "提交" };
  });
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(generate.mock.calls[0][2].route.profile.model).toBe("model-b");
  expect(commit.mock.calls[0][1].route.profile.model).toBe("model-b");
  expect(planAction.mock.calls[0][2].sessionTranscript).toBeUndefined();
  expect(host.querySelector('[aria-label="本轮路由"]')?.textContent).toContain("model-a");
});

it("stop discards a late response and permits a new request without executing the cancelled one", async () => {
  let finish!: (value: AiAction) => void;
  planAction.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  await type(input, "提交 A");
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!.click(); });
  await click([...host.querySelectorAll('button')].find(b => b.textContent === "停止生成")!);
  expect(cancel).toHaveBeenCalled();
  planAction.mockResolvedValueOnce({ kind: "answer", message: "新的回答" });
  await type(input, "解释一下"); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  await act(async () => finish({ kind: "commitSelected", summary: "旧计划" }));
  expect(host.querySelector('[role=log]')?.textContent).toContain("新的回答");
  expect(generate).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
});

it("keeps the chosen primary configuration and prompts fixed across tool calls and settings changes", async () => {
  planAction.mockResolvedValue({ kind: "answer", message: "回答" });
  await render();
  await click([...host.querySelectorAll('button')].find(b => b.textContent?.includes('选择主模型'))!);
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="会话主模型"]')!; select.value = "deep"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  await type(input, "解释整体思路"); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  const first = planAction.mock.calls.at(-1)![2];
  expect(first.route.profile.model).toBe("model-b");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="会话主模型"]')!.disabled).toBe(true);
  await act(async () => {
    settings.update("ai", "profiles", settings.get().ai.profiles.map(p => ({ ...p, model: "changed" })));
    settings.update("ai", "prompts", { ...settings.get().ai.prompts, commandCenter: "新的系统提示词" });
  });
  await type(input, "@审查 检查当前差异"); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  const tool = planAction.mock.calls.at(-1)![2];
  expect(tool.route.profile.id).toBe("test-ai"); expect(tool.sessionTranscript).toBeUndefined();
  await type(input, "解释审查结果"); await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  const last = planAction.mock.calls.at(-1)![2];
  expect(last.route.profile.model).toBe("model-b"); expect(last.systemPrompt).toBe(first.systemPrompt);
  expect(last.route.prompt).toBe(""); expect(last.sessionTranscript).toContain('"role":"tool"');
  expect(last.sessionTranscript).toContain(tool.route.ruleName);
});
