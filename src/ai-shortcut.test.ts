// @vitest-environment jsdom
import { expect, it } from "vitest";
import { displayAiShortcut, matchesAiShortcut } from "./ai-shortcut";

it("uses Ctrl+P on Windows and Command+P on macOS", () => {
  const ctrlP = new KeyboardEvent("keydown", { key: "p", ctrlKey: true });
  const commandP = new KeyboardEvent("keydown", { key: "p", metaKey: true });
  expect(matchesAiShortcut(ctrlP, "CtrlOrMeta+P", false)).toBe(true);
  expect(matchesAiShortcut(commandP, "CtrlOrMeta+P", true)).toBe(true);
  expect(matchesAiShortcut(ctrlP, "CtrlOrMeta+P", true)).toBe(false);
  expect(matchesAiShortcut(commandP, "CtrlOrMeta+P", false)).toBe(false);
  expect(displayAiShortcut("CtrlOrMeta+P", true)).toBe("⌘P");
  expect(displayAiShortcut("CtrlOrMeta+P", false)).toBe("Ctrl+P");
});
