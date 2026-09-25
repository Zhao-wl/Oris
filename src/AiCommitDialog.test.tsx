// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AiCommitDialog from "./AiCommitDialog";
import { createSettingsRegistry, SettingsStore } from "./settings";
import { schemeIndex } from "./themes/runtime";
import type { AiPlan } from "./ai-api";

let host: HTMLDivElement;
let root: Root;
let settings: SettingsStore;
const plan: AiPlan = { message: "feat: add feature", pathIds: ["a"], revision: "rev", candidates: [{ pathId: "a", displayPath: "a.txt", oldPathId: null }, { pathId: "b", displayPath: "b.txt", oldPathId: null }] };
const generate = vi.fn(async (_description: string, _requestId: string) => plan);
const commit = vi.fn(async () => true);
const cancel = vi.fn(async () => {});
const close = vi.fn();
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const type = async (element: HTMLTextAreaElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); };
const render = async () => { await act(async () => root.render(<AiCommitDialog settings={settings} onGenerate={generate} onCancelGeneration={cancel} onCommit={commit} onClose={close}/>)); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const values = new Map<string, string>();
  settings = new SettingsStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) }, createSettingsRegistry({ schemes: schemeIndex }));
  generate.mockClear(); commit.mockClear(); cancel.mockClear(); close.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("shows a review with selected files and editable message before committing by default", async () => {
  await render();
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述要提交的内容"]')!;
  expect(input.rows).toBe(1);
  await type(input, "提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 提交"]')!);
  expect(generate).toHaveBeenCalledWith("提交功能 A", expect.any(String));
  expect(commit).not.toHaveBeenCalled();
  expect(host.textContent).toContain("a.txt");
  await click(host.querySelectorAll('.ai-commit-files input[type="checkbox"]')[1]);
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "提交选中文件")!);
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ message: "feat: add feature", revision: "rev", pathIds: ["a", "b"] }));
  expect(close).toHaveBeenCalledTimes(1);
});

it("remembers direct commit and can dismiss by clicking outside", async () => {
  await render();
  await click(host.querySelector('.ai-commit-actions input[type="checkbox"]')!);
  expect(settings.get().ai.directCommit).toBe(true);
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述要提交的内容"]')!, "提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 提交"]')!);
  expect(commit).toHaveBeenCalledWith(plan);
  await act(async () => { host.querySelector(".ai-commit-overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(close).toHaveBeenCalled();
});

it("shows progress and cancels generation when the input closes", async () => {
  let finish!: (value: AiPlan) => void;
  generate.mockImplementationOnce(() => new Promise<AiPlan>((resolve) => { finish = resolve; }));
  await render();
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述要提交的内容"]')!, "提交功能 A");
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="确认 AI 提交"]')!.click(); });
  expect(host.querySelector('.ai-input-progress')?.textContent).toContain("处理中");
  const requestId = generate.mock.calls[0][1];
  await act(async () => { host.querySelector(".ai-commit-overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(cancel).toHaveBeenCalledWith(requestId);
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => { finish(plan); });
  expect(commit).not.toHaveBeenCalled();
});

it("requires manual file review when AI selection cannot be matched, even with direct commit enabled", async () => {
  generate.mockResolvedValueOnce({ ...plan, pathIds: [], selectionWarning: "请手动勾选要提交的文件" });
  await render();
  await click(host.querySelector('.ai-commit-actions input[type="checkbox"]')!);
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="描述要提交的内容"]')!, "提交功能 A");
  await click(host.querySelector('[aria-label="确认 AI 提交"]')!);
  expect(commit).not.toHaveBeenCalled();
  expect(host.textContent).toContain("请手动勾选要提交的文件");
  expect(host.querySelectorAll('.ai-commit-files input[type="checkbox"]')).toHaveLength(2);
});
