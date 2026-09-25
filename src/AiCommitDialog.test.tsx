// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AiCommitDialog from "./AiCommitDialog";
import type { AiPlan } from "./ai-api";
import type { AiAction } from "./ai-actions";

let host: HTMLDivElement;
let root: Root;
const plan: AiPlan = { message: "feat: add feature", pathIds: ["a"], revision: "rev", candidates: [{ pathId: "a", displayPath: "a.txt", oldPathId: null }, { pathId: "b", displayPath: "b.txt", oldPathId: null }] };
const generate = vi.fn(async (_description: string, _requestId: string) => plan);
const planAction = vi.fn(async (_description: string, _requestId: string): Promise<AiAction> => ({ kind: "commitSelected", summary: "提交选中文件" }));
const executeAction = vi.fn(async () => true);
const commit = vi.fn(async () => true);
const cancel = vi.fn(async () => {});
const close = vi.fn();
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const type = async (element: HTMLTextAreaElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); };
const render = async () => { await act(async () => root.render(<AiCommitDialog onGenerate={generate} onPlanAction={planAction} onExecuteAction={executeAction} onCancelGeneration={cancel} onCommit={commit} onClose={close}/>)); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  generate.mockClear(); planAction.mockClear(); executeAction.mockClear(); commit.mockClear(); cancel.mockClear(); close.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("executes a generated commit without a second confirmation", async () => {
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  expect(input.rows).toBe(1);
  expect(host.querySelector('.ai-commit-actions input[type="checkbox"]')).toBeNull();
  await type(input, "提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(generate).toHaveBeenCalledWith("提交功能 A", expect.any(String));
  expect(commit).toHaveBeenCalledWith(plan);
  expect(host.querySelector(".ai-commit-preview")).toBeNull();
  expect(close).toHaveBeenCalledTimes(1);
});

it("also executes an explicitly direct commit", async () => {
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "直接提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(commit).toHaveBeenCalledWith(plan);
  expect(close).toHaveBeenCalledTimes(1);
});

it("shows progress and cancels generation when the input closes", async () => {
  let finish!: (value: AiAction) => void;
  planAction.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "提交功能 A");
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 指令"]')!.click(); });
  expect(host.querySelector('.ai-input-progress .ai-spinner')).not.toBeNull();
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
  expect(host.querySelector('.ai-commit-preview')).toBeNull();
});

it("executes a settings action as soon as planning finishes", async () => {
  planAction.mockResolvedValueOnce({ kind: "settings", summary: "将字号设为 16", setting: "fontSize", value: 16 });
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!, "字体改成 16");
  await click(host.querySelector('[aria-label="确认 AI 指令"]')!);
  expect(executeAction).toHaveBeenCalledWith({ kind: "settings", summary: "将字号设为 16", setting: "fontSize", value: 16 });
  expect(close).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".ai-commit-preview")).toBeNull();
});

it("shows prompt suggestions for a standalone @ and inserts a selected tag", async () => {
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入 AI 指令"]')!;
  await type(input, "@");
  expect(host.querySelectorAll('[role="listbox"] [role="option"]')).toHaveLength(5);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
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
  await type(input, "请 @Git");
  expect(host.querySelectorAll('[role="listbox"] [role="option"]')).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
});
