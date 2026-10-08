// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsDialog from "./SettingsDialog";
import { createSettingsRegistry, DEFAULT_AI_PROMPTS, SettingsStore } from "./settings";
import { schemeIndex } from "./themes/runtime";
import { detectAiTools, listAiModels, setAiKey, testAiConnection } from "./ai-api";

vi.mock("./ai-api", () => ({ detectAiTools: vi.fn(), listAiModels: vi.fn(), setAiKey: vi.fn(), testAiConnection: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let settings: SettingsStore;
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };

beforeEach(async () => {
  vi.clearAllMocks();
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

it("说明 AI 会发送哪些数据，未配置时不检测也不联网（V2-D72）", async () => {
  const note = host.querySelector('[aria-label="AI 发送的数据"]')?.textContent ?? "";
  for (const text of ["不会在后台自动发送", "已暂存的改动", "未跟踪文件开头最多 2 KB", "当前打开文件两侧的内容", "API Key 只随请求发送"]) expect(note).toContain(text);
  expect(detectAiTools).not.toHaveBeenCalled();
  expect(listAiModels).not.toHaveBeenCalled();
  expect(testAiConnection).not.toHaveBeenCalled();
});

const setInput = async (selector: string, value: string) => {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const addReadyProfile = async (kind: "api" | "cli" = "api") => {
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === (kind === "api" ? "添加 API" : "手动添加工具"))!);
  await act(async () => settings.update("ai", "profiles", settings.get().ai.profiles.map((profile) => ({ ...profile, baseUrl: kind === "api" ? "https://example.com/v1" : "", model: "test-model", hasKey: kind === "api" }))));
  return host.querySelector<HTMLButtonElement>('[aria-label^="测试 "]')!;
};

it("requires a model and saved API key; CLI profiles can test without a key", async () => {
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "添加 API")!);
  const button = host.querySelector<HTMLButtonElement>('[aria-label^="测试 "]')!;
  expect(button.disabled).toBe(true);
  await setInput("#ai-model-manual", "test-model");
  expect(button.disabled).toBe(true);
  await act(async () => settings.update("ai", "profiles", []));
  expect((await addReadyProfile("cli")).disabled).toBe(false);
  expect(testAiConnection).not.toHaveBeenCalled();
});

it("tests the chosen profile once, shows progress and success, and hides stale results after edits", async () => {
  const button = await addReadyProfile();
  let finish!: () => void;
  vi.mocked(testAiConnection).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const profile = settings.get().ai.profiles[0];
  const activeId = settings.get().ai.activeId;
  await click(button);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("测试中…");
  expect(host.querySelector(".ai-profile-item [role=status]")?.textContent).toContain("正在测试");
  await click(button);
  expect(testAiConnection).toHaveBeenCalledExactlyOnceWith(profile);
  await act(async () => finish());
  expect(button.disabled).toBe(false);
  expect(host.querySelector(".ai-profile-item .settings-ok")?.textContent).toContain("连接成功");
  expect(settings.get().ai.activeId).toBe(activeId);
  expect(listAiModels).not.toHaveBeenCalled();
  await setInput("#ai-base-url", "https://other.example.com/v1");
  expect(host.querySelector(".ai-profile-item .settings-ok")).toBeNull();
});

it("shows the connection failure on that profile and allows retry", async () => {
  const button = await addReadyProfile();
  vi.mocked(testAiConnection).mockRejectedValueOnce("AI 服务拒绝了请求（HTTP 401）").mockResolvedValueOnce();
  await click(button);
  expect(host.querySelector(".ai-profile-item [role=alert]")?.textContent).toContain("连接失败：AI 服务拒绝了请求（HTTP 401）");
  expect(button.disabled).toBe(false);
  await click(button);
  expect(host.querySelector(".ai-profile-item [role=alert]")).toBeNull();
  expect(host.querySelector(".ai-profile-item .settings-ok")).not.toBeNull();
});

it("requires saving a draft key and clears the previous test result when replacing it", async () => {
  const button = await addReadyProfile();
  vi.mocked(testAiConnection).mockResolvedValue();
  vi.mocked(setAiKey).mockResolvedValue();
  await click(button);
  await setInput("#ai-key", "new-key");
  expect(button.disabled).toBe(true);
  expect(button.title).toBe("请先保存密钥");
  await click([...host.querySelectorAll("button")].find((item) => item.textContent === "保存密钥")!);
  expect(setAiKey).toHaveBeenCalledWith(settings.get().ai.profiles[0].id, "new-key");
  expect(host.querySelector(".ai-profile-item .settings-ok")).toBeNull();
  expect(button.disabled).toBe(false);
});
