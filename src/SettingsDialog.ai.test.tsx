// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsDialog from "./SettingsDialog";
import { createSettingsRegistry, DEFAULT_AI_PROMPTS, SettingsStore } from "./settings";
import { schemeIndex } from "./themes/runtime";
import { detectAiTools, listAiModels } from "./ai-api";

vi.mock("./ai-api", () => ({ detectAiTools: vi.fn(), listAiModels: vi.fn(), setAiKey: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let settings: SettingsStore;
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const values = new Map<string, string>();
  settings = new SettingsStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) }, createSettingsRegistry({ schemes: schemeIndex }));
  await act(async () => root.render(<SettingsDialog settings={settings} gitInUse={null} onClose={() => {}}/>));
  await click([...host.querySelectorAll(".settings-nav button")].find((button) => button.textContent === "AI")!);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("starts empty, reuses an unfinished API profile, and can clear it", async () => {
  expect(host.querySelectorAll(".ai-profile-card")).toHaveLength(0);
  const addApi = [...host.querySelectorAll("button")].find((button) => button.textContent === "添加 API")!;
  await click(addApi);
  await click(addApi);
  expect(host.querySelectorAll(".ai-profile-card")).toHaveLength(1);
  expect(settings.get().ai.profiles).toHaveLength(1);
  await click([...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("清理未配置项"))!);
  expect(host.querySelectorAll(".ai-profile-card")).toHaveLength(0);
  expect(settings.get().ai.profiles).toHaveLength(0);
});

it("shows the Codex version warning from detection and model checks", async () => {
  const warning = "当前 Codex CLI 版本为 0.144.6，低于写入模型列表的 Codex 0.158.0";
  vi.mocked(detectAiTools).mockResolvedValue([{ provider: "codex", executable: "C:/npm/codex.cmd", models: ["gpt-6-astra"], warning }]);
  vi.mocked(listAiModels).mockResolvedValue({ models: ["gpt-6-astra"], warning: null });
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "自动检测本机工具")!);
  expect(host.querySelector(".settings-warning")?.textContent).toBe(warning);
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "添加 Codex")!);
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "检测模型")!);
  expect(host.querySelector(".settings-warning")).toBeNull();
  expect(listAiModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", executable: "C:/npm/codex.cmd" }));
});

it("edits and resets each operation's system prompt independently", async () => {
  const staged = host.querySelector<HTMLTextAreaElement>('[aria-label="根据暂存内容生成提交信息系统提示词"]')!;
  const described = host.querySelector<HTMLTextAreaElement>('[aria-label="根据描述选择文件并生成提交信息系统提示词"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(staged, "只写英文摘要");
    staged.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(settings.get().ai.prompts.stagedMessage).toBe("只写英文摘要");
  expect(settings.get().ai.prompts.describedCommit).toBe(DEFAULT_AI_PROMPTS.describedCommit);
  await click(staged.closest(".ai-prompt-field")!.querySelector("button")!);
  expect(settings.get().ai.prompts.stagedMessage).toBe(DEFAULT_AI_PROMPTS.stagedMessage);
  expect(described.value).toBe(DEFAULT_AI_PROMPTS.describedCommit);
});
