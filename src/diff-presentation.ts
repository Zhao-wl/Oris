import type { FileChange, TextSide } from "./types";

export type DiffPresentation =
  | { kind: "compare" }
  | { kind: "single"; side: "a" | "b"; tone: "inserted" | "deleted"; empty: boolean };

export function availableDiffModes(presentation: DiffPresentation): readonly ("single" | "split" | "unified")[] {
  return presentation.kind === "single" ? ["single"] : ["split", "unified"];
}

type SidePresence = Pick<TextSide, "endpoint" | "encoding" | "byteLength">;

/**
 * Resolve file-level presentation from Git semantics and explicit endpoint
 * presence. Text content is deliberately not inspected: an existing empty
 * file is different from a missing endpoint.
 */
export function resolveDiffPresentation(
  status: FileChange["status"],
  left: SidePresence,
  right: SidePresence
): DiffPresentation {
  const leftMissing = left.encoding === "missing";
  const rightMissing = right.encoding === "missing";

  if ((status === "added" || status === "untracked" || status === "conflicted") && leftMissing && !rightMissing) {
    return { kind: "single", side: "b", tone: "inserted", empty: right.byteLength === 0 };
  }
  if ((status === "deleted" || status === "conflicted") && rightMissing && !leftMissing) {
    return { kind: "single", side: "a", tone: "deleted", empty: left.byteLength === 0 };
  }
  return { kind: "compare" };
}
