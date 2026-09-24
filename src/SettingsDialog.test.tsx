// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const validateGit = vi.fn();
vi.mock("./api", () => ({ validateGit: (...args: unknown[]) => validateGit(...args) }));

import SettingsDialog from "./SettingsDialog";
import { createSettingsRegistry, DEFAULT_SCHEME_OPTIONS, SettingsStore } from "./settings";
import { schemeIndex } from "./themes/runtime";

let root: Root;
let host: HTMLDivElement;
let store: SettingsStore;
let onClose: ReturnType<typeof vi.fn>;
const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }; };
const render = async () => { await act(async () => root.render(<SettingsDialog settings={store} onClose={onClose} gitInUse={{ executable: "C:/Git/cmd/git.exe", version: "2.44.0", minimumVersion: "2.31.0" }}/>)); };
const click = async (element: Element) => { await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); };
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  store = new SettingsStore(memory(), createSettingsRegistry({ schemes: schemeIndex, defaults: DEFAULT_SCHEME_OPTIONS.oris }));
  onClose = vi.fn();
  validateGit.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("lists every scheme with batch tags and applies selections immediately", async () => {
  await render();
  const options = host.querySelectorAll('[role="option"]');
  expect(options.length).toBe(schemeIndex.length);
  expect(host.textContent).toContain("首批");
  expect(host.textContent).toContain("第二批");
  const dark2026 = [...options].find((o) => o.textContent?.includes("Dark 2026"))!;
  await click(dark2026);
  expect(store.get().appearance.darkScheme).toBe("dark-2026");
  expect(dark2026.getAttribute("aria-selected")).toBe("true");
});

it("filters to the first batch and switches the pending-decision options", async () => {
  await render();
  const checkbox = host.querySelector<HTMLInputElement>('.inline-check input')!;
  await click(checkbox);
  expect(host.textContent).not.toContain("第二批");
  await click(button("B：新增绿"));
  expect(store.get().appearance.diffColorMode).toBe("vscode");
  await click(button("VS Code Light / Dark 2026"));
  expect(store.get().appearance).toMatchObject(DEFAULT_SCHEME_OPTIONS.vscode2026);
  await click(button("以 Oris 配色为默认"));
  expect(store.get().appearance).toMatchObject(DEFAULT_SCHEME_OPTIONS.oris);
});

it("keeps the previous Git path when validation fails and saves it when it succeeds", async () => {
  await render();
  await click(button("Git"));
  const field = host.querySelector<HTMLInputElement>("#settings-git")!;
  const type = async (value: string) => { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }); };
  const enter = async () => { await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }); };
  validateGit.mockResolvedValueOnce({ ok: false, executable: "D:/nope.exe", version: null, minimumVersion: "2.31.0", error: "找不到文件" });
  await type("D:/nope.exe"); await enter();
  expect(store.get().git.executable).toBe("");
  expect(host.textContent).toContain("未采用：找不到文件");
  validateGit.mockResolvedValueOnce({ ok: true, executable: "D:/Git/git.exe", version: "2.45.0", minimumVersion: "2.31.0", error: null });
  await type("D:/Git/git.exe"); await enter();
  expect(store.get().git.executable).toBe("D:/Git/git.exe");
  expect(host.textContent).toContain("已校验");
});

it("closes on Escape and on overlay click", async () => {
  await render();
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => { host.querySelector(".settings-overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(onClose).toHaveBeenCalledTimes(2);
});
