// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import {
  AppearanceRuntime, applyBootAppearance, applyScheme, appearanceExtensions, createAppearanceCompartments, diffColors,
  HIGH_CONTRAST_CLASS, highlightStyleFor, loadScheme, loadedSchemeIds, readBootCache, reconfigureAppearance, resetSchemeCacheForTest, resolveTag, schemeIndex
} from "./runtime";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
};

function fakeMedia(initialDark: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = { matches: initialDark, addEventListener: (_: "change", l: (event: { matches: boolean }) => void) => listeners.add(l), removeEventListener: (_: "change", l: (event: { matches: boolean }) => void) => listeners.delete(l) };
  return {
    matchMedia: vi.fn(() => query),
    flip(dark: boolean) { query.matches = dark; for (const l of [...listeners]) l({ matches: dark }); },
    listenerCount: () => listeners.size
  };
}

const appearance = { themeMode: "dark" as const, lightScheme: "oris-light", darkScheme: "dark-2026", fontSize: 13 };

beforeEach(() => { resetSchemeCacheForTest(); document.documentElement.removeAttribute("style"); document.documentElement.className = ""; });
afterEach(() => vi.restoreAllMocks());

describe("theme runtime", () => {
  it("lazy-loads only the scheme in use and rejects unknown ids", async () => {
    expect(loadedSchemeIds()).toEqual([]);
    const scheme = await loadScheme("dark-2026");
    expect(scheme.id).toBe("dark-2026");
    expect(loadedSchemeIds()).toEqual(["dark-2026"]);
    expect(loadScheme("dark-2026")).toBe(loadScheme("dark-2026"));
    await expect(loadScheme("../../secret")).rejects.toThrow();
    expect(schemeIndex.length).toBe(21);
  });

  it("applies CSS variables, removes missing ones and marks high-contrast schemes", async () => {
    const root = document.createElement("div");
    const dark = await loadScheme("dark-2026");
    applyScheme(dark, root);
    expect(root.style.getPropertyValue("--bg")).toBe(dark.variables["--bg"]);
    expect(root.classList.contains(HIGH_CONTRAST_CLASS)).toBe(false);
    expect(root.classList.contains("theme-dark")).toBe(true);
    root.style.setProperty("--search-other", "red");
    const hc = await loadScheme("hc-dark");
    expect(hc.variables["--search-other"]).toBeNull();
    applyScheme(hc, root);
    expect(root.style.getPropertyValue("--search-other")).toBe("");
    expect(root.classList.contains(HIGH_CONTRAST_CLASS)).toBe(true);
    expect(root.dataset.schemeType).toBe("hcDark");
    const light = await loadScheme("hc-light");
    applyScheme(light, root);
    expect(root.classList.contains("theme-light")).toBe(true);
    expect(root.style.colorScheme).toBe("light");
  });

  it("uses the Oris diff semantics (V2-D30): modified on both sides, colors taken from the scheme", async () => {
    const scheme = await loadScheme("dark-2026");
    const colors = diffColors(scheme);
    expect(colors.modifiedLeft).toEqual(scheme.diff.oris.modified);
    expect(colors.modifiedRight).toEqual(scheme.diff.oris.modified);
    expect(colors.deleted).toEqual(scheme.diff.oris.deleted);
    expect(colors.added).toEqual(scheme.diff.oris.added);
    const root = document.createElement("div");
    applyScheme(scheme, root);
    expect(root.style.getPropertyValue("--diff-modified-left-word")).toBe(scheme.diff.oris.modified.word);
    expect(root.style.getPropertyValue("--diff-modified-right-line")).toBe(scheme.diff.oris.modified.line);
    expect(root.style.getPropertyValue("--diff-deleted-marker")).toBe(scheme.diff.oris.deleted.marker);
  });

  it("removes variables left over from the previous scheme", async () => {
    const root = document.createElement("div");
    const vscodeScheme = await loadScheme("dark-2026");
    applyScheme(vscodeScheme, root);
    expect(root.style.getPropertyValue("--search-match")).not.toBe("");
    const oris = await loadScheme("oris-dark");
    applyScheme(oris, root);
    expect(root.style.getPropertyValue("--search-match")).toBe("");
    expect(root.style.getPropertyValue("--bg")).toBe(oris.variables["--bg"]);
    expect(root.style.getPropertyValue("--diff-deleted-marker")).toBe(oris.diff.oris.deleted.marker);
  });

  it("builds a HighlightStyle from scope→tag rules, including modifier tags", async () => {
    expect(resolveTag("function(variableName)")).not.toBeNull();
    expect(resolveTag("keyword")).not.toBeNull();
    expect(resolveTag("function")).toBeNull();
    expect(resolveTag("notATag")).toBeNull();
    for (const id of ["dark-2026", "light-2026", "hc-dark", "monokai"]) {
      const scheme = await loadScheme(id);
      const style = highlightStyleFor(scheme);
      const resolvable = scheme.highlight.filter((rule) => resolveTag(rule.tag)).length;
      expect(style.specs.length).toBe(resolvable);
      expect(resolvable).toBeGreaterThan(10);
    }
    // Oris 自有方案没有移植的语法规则：沿用 V1 的高亮。
    const orisDark = await loadScheme("oris-dark");
    expect(orisDark.highlight).toEqual([]);
    expect(highlightStyleFor(orisDark)).toBe(oneDarkHighlightStyle);
    expect(highlightStyleFor(await loadScheme("oris-light"))).toBe(defaultHighlightStyle);
  });

  it("reconfigures theme, highlight and font size on the same EditorView without rebuilding it", async () => {
    const compartments = createAppearanceCompartments();
    const first = await loadScheme("dark-2026");
    const second = await loadScheme("light-2026");
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "const a = 1;\n".repeat(50), extensions: appearanceExtensions(compartments, first, 13) }) });
    view.dispatch({ selection: { anchor: 5, head: 9 } });
    const dom = view.dom;
    const before = compartments.highlight.get(view.state);
    reconfigureAppearance([view], compartments, second, 16);
    expect(view.dom).toBe(dom);
    expect(compartments.highlight.get(view.state)).not.toBe(before);
    expect(view.state.selection.main.from).toBe(5);
    expect(view.state.selection.main.to).toBe(9);
    expect(view.state.doc.lines).toBe(51);
    const fontOnly = compartments.theme.get(view.state);
    reconfigureAppearance([view], compartments, null, 11);
    expect(compartments.theme.get(view.state)).toBe(fontOnly);
    view.destroy();
  });

  it("follows the system scheme live, preloads the other scheme and stops listening outside system mode", async () => {
    const media = fakeMedia(true);
    const root = document.createElement("div");
    const applied = vi.fn();
    const runtime = new AppearanceRuntime({ root, matchMedia: media.matchMedia, onApplied: applied });
    await runtime.apply({ ...appearance, themeMode: "system" });
    expect(root.dataset.scheme).toBe("dark-2026");
    await vi.waitFor(() => expect(loadedSchemeIds()).toContain("oris-light"));
    media.flip(false);
    await vi.waitFor(() => expect(root.dataset.scheme).toBe("oris-light"));
    expect(applied).toHaveBeenLastCalledWith(expect.objectContaining({ id: "oris-light" }), expect.anything());
    await runtime.apply({ ...appearance, themeMode: "dark" });
    expect(media.listenerCount()).toBe(0);
    expect(root.dataset.scheme).toBe("dark-2026");
    media.flip(true);
    runtime.dispose();
  });

  it("only loads the active scheme outside system mode", async () => {
    const runtime = new AppearanceRuntime({ root: document.createElement("div"), matchMedia: fakeMedia(false).matchMedia });
    await runtime.apply({ ...appearance, themeMode: "light" });
    expect(loadedSchemeIds()).toEqual(["oris-light"]);
  });

  it("first paint: boot cache written on apply lets a fresh root get the saved colours synchronously", async () => {
    const storage = memory();
    const media = fakeMedia(false);
    const runtime = new AppearanceRuntime({ root: document.createElement("div"), storage, matchMedia: media.matchMedia });
    await runtime.apply({ ...appearance, themeMode: "system", lightScheme: "solarized-light" });
    const cache = readBootCache(storage)!;
    expect(cache.themeMode).toBe("system");
    expect(cache.light?.id).toBe("solarized-light");
    const fresh = document.createElement("div");
    const scheme = await loadScheme("solarized-light");
    expect(applyBootAppearance(storage, fresh, media.matchMedia)).toBe("solarized-light");
    expect(fresh.style.getPropertyValue("--bg")).toBe(scheme.variables["--bg"]);
    expect(fresh.classList.contains("theme-light")).toBe(true);
    // 深色记录尚不存在时不改动根元素（沿用样式表默认配色）。
    expect(applyBootAppearance(storage, document.createElement("div"), () => ({ matches: true }))).toBeNull();
    expect(applyBootAppearance(memory(), document.createElement("div"))).toBeNull();
  });
});
