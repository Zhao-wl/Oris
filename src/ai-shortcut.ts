export const DEFAULT_AI_SHORTCUT = "CtrlOrMeta+P";
export const isMacPlatform = () => /Mac|iPhone|iPad/.test(navigator.platform);

export function matchesAiShortcut(event: KeyboardEvent, shortcut: string, mac = isMacPlatform()): boolean {
  if (!shortcut || ["Control", "Meta", "Shift", "Alt"].includes(event.key)) return false;
  const parts = shortcut.split("+");
  const ctrl = parts.includes("CtrlOrMeta") ? !mac : parts.includes("Ctrl");
  const meta = parts.includes("CtrlOrMeta") ? mac : parts.includes("Meta");
  return event.ctrlKey === ctrl && event.metaKey === meta && event.shiftKey === parts.includes("Shift")
    && event.altKey === parts.includes("Alt") && event.key.toUpperCase() === parts.at(-1);
}

export const displayAiShortcut = (shortcut: string, mac = isMacPlatform()) =>
  shortcut === DEFAULT_AI_SHORTCUT ? (mac ? "⌘P" : "Ctrl+P") : shortcut;
