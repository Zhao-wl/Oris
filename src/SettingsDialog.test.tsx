// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const validateGit = vi.fn();
vi.mock("./api", () => ({ validateGit: (...args: unknown[]) => validateGit(...args) }));

import SettingsDialog from "./SettingsDialog";
import { createSettingsRegistry, DEFAULT_SCHEMES, SettingsStore } from "./settings";
import { schemeIndex } from "./themes/runtime";

let root: Root;
let host: HTMLDivElement;
let store: SettingsStore;
let onClose: ReturnType<typeof vi.fn<() => void>>;
const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }; };
const render = async () => { await act(async () => root.render(<SettingsDialog settings={store} onClose={onClose} gitInUse={{ executable: "C:/Git/cmd/git.exe", version: "2.44.0", minimumVersion: "2.31.0" }}/>)); };
const click = async (element: Element) => { await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); };
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  store = new SettingsStore(memory(), createSettingsRegistry({ schemes: schemeIndex }));
  onClose = vi.fn<() => void>();
  validateGit.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("lists all 21 schemes (V2-D31), tags defaults and high contrast, and applies selections immediately", async () => {
  await render();
  const options = host.querySelectorAll('[role="option"]');
  expect(options.length).toBe(schemeIndex.length);
  expect(options.length).toBe(21);
  expect(host.querySelectorAll('[role="option"] .scheme-tag').length).toBe(4);
  expect(host.textContent).not.toMatch(/首批|第二批|待决定/);
  const notice = host.querySelector(".settings-notices pre")!.textContent!;
  expect(notice).toContain("Microsoft Corporation");
  expect(notice).toContain("Copyright (c) 2015 Colorsublime.com");
  const dark2026 = [...options].find((o) => o.textContent?.includes("Dark 2026"))!;
  await click(dark2026);
  expect(store.get().appearance.darkScheme).toBe("dark-2026");
  expect(dark2026.getAttribute("aria-selected")).toBe("true");
});

it("has no diff color switch (V2-D30) and restores the Oris default schemes", async () => {
  await render();
  expect(host.textContent).not.toContain("新增绿 · 删除红");
  await click([...host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Light 2026"))!);
  await click([...host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Monokai"))!);
  expect(store.get().appearance).toMatchObject({ lightScheme: "light-2026", darkScheme: "monokai" });
  await click(button("恢复默认配色"));
  expect(store.get().appearance).toMatchObject(DEFAULT_SCHEMES);
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
