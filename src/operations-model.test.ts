import { describe, expect, it } from "vitest";
import { DRAFTS_KEY, loadDraft, optimisticMove, pathIdsFor, rowActions, saveDraft, selectionAfterOperation, undoCommitText, unsupportedInProgress, writeBlockedReason } from "./operations-model";
import type { FileChange, RepositorySnapshot } from "./types";

const file = (path: string, status: FileChange["status"], extra: Partial<FileChange> = {}): FileChange => ({ pathId: `id:${path}`, displayPath: path, oldPathId: null, oldDisplayPath: null, status, additions: 1, deletions: 0, ...extra });
const snapshot = (unstaged: FileChange[], staged: FileChange[]): RepositorySnapshot => ({
  requestId: "s", repo: { repoId: "r", displayName: "r", worktreePath: "C:/r", gitDir: "C:/r/.git", commonDir: "C:/r/.git", branch: "main" },
  scope: "unstaged", revision: "rev", files: unstaged, scannedAt: 0, scopes: { unstaged, staged, all: [...unstaged, ...staged] },
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" }
});

describe("optimistic stage / unstage (B05)", () => {
  it("moves files between scopes immediately, marks them pending and keeps the revision", () => {
    const base = snapshot([file("a.txt", "modified"), file("new.txt", "untracked"), file("gone.txt", "deleted"), file("c.txt", "conflicted")], [file("s.txt", "added")]);
    const next = optimisticMove(base, "stage", [base.scopes!.unstaged[0], base.scopes!.unstaged[1], base.scopes!.unstaged[2], base.scopes!.unstaged[3]]);
    expect(next.revision).toBe("rev");
    expect(next.scopes!.unstaged.map((f) => f.displayPath)).toEqual(["c.txt"]);
    expect(next.scopes!.staged.map((f) => [f.displayPath, f.status, f.pending ?? false])).toEqual([
      ["a.txt", "modified", true], ["gone.txt", "deleted", true], ["new.txt", "added", true], ["s.txt", "added", false]
    ]);
    expect(next.files).toBe(next.scopes!.unstaged);
    expect(base.scopes!.unstaged).toHaveLength(4);
  });

  it("unstaging a rename shows the old path as deleted and the new path as untracked", () => {
    const renamed = file("new-name.txt", "renamed", { oldPathId: "id:old-name.txt", oldDisplayPath: "old-name.txt" });
    const base = { ...snapshot([], [renamed, file("added.txt", "added")]), scope: "staged" as const };
    const next = optimisticMove(base, "unstage", [renamed, base.scopes!.staged[1]]);
    expect(next.scopes!.staged).toEqual([]);
    expect(next.scopes!.unstaged.map((f) => [f.displayPath, f.status])).toEqual([["added.txt", "untracked"], ["new-name.txt", "untracked"], ["old-name.txt", "deleted"]]);
    expect(next.files).toBe(next.scopes!.staged);
    expect(pathIdsFor([renamed], true)).toEqual(["id:new-name.txt", "id:old-name.txt"]);
    expect(pathIdsFor([renamed, renamed], false)).toEqual(["id:new-name.txt"]);
  });
});

describe("row actions and write gating", () => {
  it("offers stage / unstage / discard per scope; conflicts are marked resolved; gitlinks cannot be discarded", () => {
    expect(rowActions("unstaged", file("a", "modified"))).toEqual({ primary: "stage", discard: true, discardBlocked: null });
    expect(rowActions("staged", file("a", "modified"))).toMatchObject({ primary: "unstage", discard: false });
    expect(rowActions("all", file("a", "modified"))).toEqual({ primary: null, discard: true, discardBlocked: null });
    expect(rowActions("unstaged", file("c", "conflicted"))).toMatchObject({ primary: "markResolved", discard: false });
    expect(rowActions("unstaged", file("sub", "modified", { gitlink: true }))).toMatchObject({ primary: "stage", discard: false, discardBlocked: expect.stringContaining("gitlink") });
  });

  it("blocks writes while verifying, while another write runs, and in unsupported in-progress states", () => {
    const snap = snapshot([], []);
    expect(writeBlockedReason({ snapshot: snap, verifying: false, running: null })).toBeNull();
    expect(writeBlockedReason({ snapshot: snap, verifying: true, running: null })).toContain("校验");
    expect(writeBlockedReason({ snapshot: snap, verifying: false, running: "暂存" })).toContain("暂存");
    expect(writeBlockedReason({ snapshot: null, verifying: false, running: null })).not.toBeNull();
    const rebasing = { ...snap, inProgress: { merge: false, rebase: true, cherryPick: false, revert: false, bisect: false } };
    expect(unsupportedInProgress(rebasing)).toContain("rebase");
    expect(writeBlockedReason({ snapshot: rebasing, verifying: false, running: null })).toContain("rebase");
    expect(unsupportedInProgress({ ...snap, inProgress: { merge: true, rebase: false, cherryPick: false, revert: false, bisect: false } })).toBeNull();
  });
});

describe("selection after a write operation", () => {
  const list = (names: string[]) => names.map((n) => file(n, "modified"));
  it("keeps the selected file when it is still listed, otherwise moves to the next remaining file", () => {
    const before = list(["a", "b", "c", "d"]);
    expect(selectionAfterOperation(before, list(["a", "b", "c", "d"]), "id:b")).toBe("id:b");
    expect(selectionAfterOperation(before, list(["a", "c", "d"]), "id:b")).toBe("id:c");
    expect(selectionAfterOperation(before, list(["a", "b"]), "id:d")).toBe("id:b");
    expect(selectionAfterOperation(before, list(["a", "d"]), "id:b")).toBe("id:d");
    expect(selectionAfterOperation(before, [], "id:b")).toBeNull();
  });
});

describe("commit drafts are saved per project", () => {
  it("round-trips drafts, clears them, and survives corrupted storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    saveDraft(storage, "a", "feat: 草稿\n\n正文");
    saveDraft(storage, "b", "other");
    expect(loadDraft(storage, "a")).toBe("feat: 草稿\n\n正文");
    expect(loadDraft(storage, "b")).toBe("other");
    saveDraft(storage, "a", "");
    expect(loadDraft(storage, "a")).toBe("");
    expect(JSON.parse(store.get(DRAFTS_KEY)!)).toEqual({ b: "other" });
    store.set(DRAFTS_KEY, "{broken");
    expect(loadDraft(storage, "b")).toBe("");
    saveDraft(storage, "c", "fresh");
    expect(loadDraft(storage, "c")).toBe("fresh");
  });
});

it("explains undoing a normal, merge and root commit differently (B07)", () => {
  expect(undoCommitText({ oid: "a".repeat(40), subject: "s", parents: ["b".repeat(40)] })).toContain("回退一个提交");
  expect(undoCommitText({ oid: "a".repeat(40), subject: "s", parents: ["b".repeat(40), "c".repeat(40)] })).toContain("第一个父提交 bbbbbbbb");
  expect(undoCommitText({ oid: "a".repeat(40), subject: "s", parents: [] })).toContain("根提交");
});
