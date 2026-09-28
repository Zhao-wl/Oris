import { describe, expect, it, vi } from "vitest";
import schemeIndex from "../themes/generated/index.json";
import { createSettingsRegistry, DEFAULT_AI_PROMPTS, DEFAULT_SCHEMES, FONT_SIZE_MAX, FONT_SIZE_MIN, integerSetting, loadSettings, migrateGitExecutable, SETTINGS_KEY, SETTINGS_VERSION, SettingsStore } from "./index";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value); }), data };
};
const registry = (defaults?: { lightScheme: string; darkScheme: string }) => createSettingsRegistry({ schemes: schemeIndex, defaults });
const workspace = (projects: { gitExecutable: string; lastOpenedAt: number }[]) => JSON.stringify({ version: 2, activeRepoId: null, projects: projects.map((p, i) => ({ repo: { repoId: `r${i}` }, pinned: false, anchor: {}, ...p })) });

describe("settings model, registry and persistence", () => {
  it("defaults to the Oris schemes (V2-D32) and still accepts other valid default ids", () => {
    const oris = loadSettings(memory(), registry()).settings;
    expect(DEFAULT_SCHEMES).toEqual({ lightScheme: "oris-light", darkScheme: "oris-dark" });
    expect(oris).toMatchObject({ version: SETTINGS_VERSION, appearance: { themeMode: "dark", lightScheme: "oris-light", darkScheme: "oris-dark", fontSize: 13 }, git: { executable: "" } });
    expect(oris.appearance).not.toHaveProperty("diffColorMode");
    expect(oris.ai).toEqual({ profiles: [], activeId: "", shortcut: "CtrlOrMeta+P", prompts: DEFAULT_AI_PROMPTS });
    const vscode = loadSettings(memory(), registry({ lightScheme: "light-2026", darkScheme: "dark-2026" })).settings;
    expect(vscode.appearance).toMatchObject({ lightScheme: "light-2026", darkScheme: "dark-2026" });
    expect(() => createSettingsRegistry({ schemes: schemeIndex, defaults: { lightScheme: "dark-2026", darkScheme: "oris-dark" } })).toThrow();
  });

  it("persists AI profile choices without storing API keys in settings", () => {
    const storage = memory();
    const store = new SettingsStore(storage, registry());
    const profile = { id: "provider1", name: "OpenAI", kind: "api" as const, provider: "openai" as const, executable: "", baseUrl: "", model: "gpt-test", hasKey: true };
    expect(store.update("ai", "profiles", [profile])).toBe(true);
    expect(store.update("ai", "activeId", profile.id)).toBe(true);
    expect(store.update("ai", "prompts", { ...DEFAULT_AI_PROMPTS, stagedMessage: "只写一句话" })).toBe(true);
    const saved = storage.data.get(SETTINGS_KEY)!;
    expect(saved).not.toContain("sk-");
    expect(loadSettings(storage, registry()).settings.ai).toMatchObject({ profiles: [profile], activeId: "provider1", prompts: { stagedMessage: "只写一句话" } });
  });

  it("loads operation prompt defaults from older settings without removing AI profiles", () => {
    const old = { version: 1, ai: { profiles: [{ id: "old", name: "Codex", kind: "cli", provider: "codex", executable: "/usr/local/bin/codex", baseUrl: "", model: "gpt-test", hasKey: false }], activeId: "old", shortcut: "Ctrl+K", directCommit: true } };
    const loaded = loadSettings(memory({ [SETTINGS_KEY]: JSON.stringify(old) }), registry()).settings;
    expect(loaded.ai.profiles).toHaveLength(1);
    expect(loaded.ai.activeId).toBe("old");
    expect(loaded.ai.prompts).toEqual(DEFAULT_AI_PROMPTS);
    expect(loaded.ai).not.toHaveProperty("directCommit");
  });

  it("registry: categories are ordered, a new category needs no framework change, invalid fields fall back per item", () => {
    const reg = registry();
    expect(reg.list().map((c) => c.id)).toEqual(["appearance", "git", "ai"]);
    reg.register({ id: "reading", label: "Diff 阅读", order: 15, settings: [integerSetting("tabSize", 1, 8, 4, { label: "Tab 宽度", control: "slider" })] });
    expect(reg.list().map((c) => c.id)).toEqual(["appearance", "reading", "git", "ai"]);
    expect(reg.defaults().reading).toEqual({ tabSize: 4 });
    const { values, corrected } = reg.normalize({ appearance: { fontSize: 99, themeMode: "system", lightScheme: "dark-2026" }, git: { executable: "C:/Git/bin/git.exe" }, unknown: { x: 1 } });
    expect(values.appearance.fontSize).toBe(13);
    expect(values.appearance.themeMode).toBe("system");
    expect(values.appearance.lightScheme).toBe("oris-light");
    expect(values.git.executable).toBe("C:/Git/bin/git.exe");
    expect(values).not.toHaveProperty("unknown");
    expect(corrected).toEqual(["appearance.lightScheme", "appearance.fontSize"]);
    expect(() => reg.register({ id: "git", label: "dup", order: 1, settings: [] })).toThrow();
    expect(reg.definition("appearance", "diffColorMode")).toBeUndefined();
    expect(reg.definition("appearance", "lightScheme")!.ui.options!.every((o) => !o.value.startsWith("dark"))).toBe(true);
    expect(reg.definition("appearance", "darkScheme")!.ui.options!.some((o) => o.value === "hc-dark")).toBe(true);
  });

  it("migrates the non-empty Git path of the most recently opened project, without touching the project list", () => {
    const storage = memory({ "oris.workspace.v2": workspace([{ gitExecutable: "C:/old/git.exe", lastOpenedAt: 10 }, { gitExecutable: "", lastOpenedAt: 99 }, { gitExecutable: " D:/new/git.exe ", lastOpenedAt: 50 }]) });
    const before = storage.data.get("oris.workspace.v2");
    const loaded = loadSettings(storage, registry());
    expect(loaded.notice).toBe("migrated");
    expect(loaded.settings.git.executable).toBe("D:/new/git.exe");
    expect(loaded.migratedGitExecutable).toBe("D:/new/git.exe");
    expect(storage.data.get("oris.workspace.v2")).toBe(before);
    expect(migrateGitExecutable(memory({ "oris.recentRepository.v1": JSON.stringify({ path: "C:/r", gitExecutable: "E:/legacy/git.exe" }) }))).toBe("E:/legacy/git.exe");
    expect(migrateGitExecutable(memory({ "oris.workspace.v2": "{broken" }))).toBeNull();
    expect(loadSettings(memory(), registry()).settings.git.executable).toBe("");
  });

  it("corrupted or incompatible storage falls back to defaults with a notice and leaves the project list intact", () => {
    const projects = workspace([{ gitExecutable: "C:/git.exe", lastOpenedAt: 1 }]);
    const corrupted = memory({ [SETTINGS_KEY]: "{not json", "oris.workspace.v2": projects });
    const a = loadSettings(corrupted, registry());
    expect(a.notice).toBe("corrupted");
    expect(a.settings.git.executable).toBe("");
    expect(corrupted.data.get("oris.workspace.v2")).toBe(projects);
    const future = memory({ [SETTINGS_KEY]: JSON.stringify({ version: 2, appearance: { fontSize: 17 } }) });
    const b = loadSettings(future, registry());
    expect(b.notice).toBe("incompatible");
    expect(b.settings.appearance.fontSize).toBe(13);
    expect(future.setItem).not.toHaveBeenCalled();
    const partial = loadSettings(memory({ [SETTINGS_KEY]: JSON.stringify({ version: 1, appearance: { fontSize: FONT_SIZE_MAX + 1, themeMode: "light" } }) }), registry());
    expect(partial.notice).toBe("corrected");
    expect(partial.settings.appearance).toMatchObject({ fontSize: 13, themeMode: "light" });
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: vi.fn() };
    expect(loadSettings(throwing, registry()).notice).toBe("corrupted");
  });

  it("store: valid updates notify subscribers once and save immediately; invalid updates keep the previous value", () => {
    const storage = memory();
    const store = new SettingsStore(storage, registry());
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.update("appearance", "fontSize", 16)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!).appearance.fontSize).toBe(16);
    expect(store.update("appearance", "fontSize", FONT_SIZE_MIN - 1)).toBe(false);
    expect(store.update("appearance", "lightScheme", "dark-2026")).toBe(false);
    expect(store.get().appearance.fontSize).toBe(16);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.update("appearance", "fontSize", 16)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    const previous = store.get();
    expect(store.update("appearance", "themeMode", "system")).toBe(true);
    expect(store.get().git).toBe(previous.git);
    const reloaded = new SettingsStore(storage, registry());
    expect(reloaded.get().appearance).toMatchObject({ fontSize: 16, themeMode: "system" });
    expect(reloaded.notice).toBeNull();
  });
});
