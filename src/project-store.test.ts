import { describe, expect, it, vi } from "vitest";
import { decodeContentFrame } from "./api";
import { ProjectStore, filesForScope, parsePersistedSnapshot, persistableSnapshot, scopeView, statsPending } from "./project-store";
import { createStore } from "./store";
import type { ContentPair, FileChange, RepositoryDetails, RepositorySnapshot } from "./types";
import { DiffCache } from "./workspace-model";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const file = (pathId: string, status: FileChange["status"] = "modified", extra: Partial<FileChange> = {}): FileChange => ({
  pathId, displayPath: pathId, oldPathId: null, oldDisplayPath: null, status, additions: null, deletions: null, ...extra
});
const snapshot = (revision = "r1"): RepositorySnapshot => ({
  requestId: "s", scope: "unstaged", revision, scannedAt: 1, files: [file("a")], statsReady: false,
  repo: { repoId: "repo", displayName: "repo", worktreePath: "C:/repo", gitDir: "C:/repo/.git", commonDir: "C:/repo/.git", branch: "main" },
  git: { executable: "git", version: "2.44", supported: true, minimumVersion: "2.31" },
  scopes: { unstaged: [file("a")], staged: [file("b")], all: [file("a"), file("old", "deleted"), file("new", "added")] }
});
const details = (revision = "r1"): RepositoryDetails => ({
  revision, elapsedMs: 3,
  stats: { unstaged: [["a", 2, 1]], staged: [["b", 5, 0]], all: [["a", 2, 1], ["new", 0, 0]] },
  all: [file("a"), file("new", "renamed", { oldPathId: "old", oldDisplayPath: "old" })]
});

describe("V2 project store", () => {
  it("createStore notifies subscribers only on real changes", () => {
    const store = createStore({ count: 0 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const same = store.get();
    store.set(same);
    expect(listener).not.toHaveBeenCalled();
    store.set((value) => ({ count: value.count + 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set({ count: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("filters scopes locally, merges background stats and the corrected all scope", () => {
    const snap = snapshot();
    expect(statsPending(snap, null)).toBe(true);
    expect(filesForScope(snap, null, "staged").map((f) => f.pathId)).toEqual(["b"]);
    expect(filesForScope(snap, null, "all").map((f) => f.pathId)).toEqual(["a", "old", "new"]);
    expect(filesForScope(snap, null, "unstaged")[0].additions).toBeNull();
    const ready = details();
    expect(statsPending(snap, ready)).toBe(false);
    const all = filesForScope(snap, ready, "all");
    expect(all.map((f) => [f.pathId, f.status, f.oldPathId])).toEqual([["a", "modified", null], ["new", "renamed", "old"]]);
    expect(all[0].additions).toBe(2);
    // 引用稳定：同一 (snapshot, details, scope) 返回同一数组。
    expect(filesForScope(snap, ready, "all")).toBe(all);
    // 其他 revision 的统计不能套用到当前快照。
    expect(filesForScope(snap, details("r2"), "unstaged")[0].additions).toBeNull();
    expect(scopeView(snap, ready, "staged")).toMatchObject({ scope: "staged", statsReady: true });
  });

  it("marks files whose content is unchanged after Git normalization, only in the reported scopes", () => {
    const snap = snapshot();
    const marked = { ...details(), stats: { unstaged: [], staged: [], all: [] }, contentUnchanged: { unstaged: [["a", "eol"]] } } as RepositoryDetails;
    expect(filesForScope(snap, marked, "unstaged")[0]).toMatchObject({ pathId: "a", contentUnchanged: "eol", additions: null });
    expect(filesForScope(snap, marked, "all").find((f) => f.pathId === "a")?.contentUnchanged).toBeUndefined();
    // 旧版本后端的详情没有该字段。
    expect(filesForScope(snapshot(), details(), "unstaged")[0].contentUnchanged).toBeUndefined();
  });

  it("tracks verifying/dirty per project and blocks writes until verification completes", () => {
    const projects = new ProjectStore();
    expect(projects.canWrite("repo")).toBe(false);
    projects.update("repo", { snapshot: snapshot(), verifying: true });
    expect(projects.canWrite("repo")).toBe(false);
    projects.update("other", { dirty: true });
    const before = projects.get("repo");
    projects.update("other", { dirty: false });
    expect(projects.get("repo")).toBe(before);
    projects.update("repo", { verifying: false });
    expect(projects.canWrite("repo")).toBe(true);
    projects.remove("repo");
    expect(projects.get("repo")).toBeUndefined();
  });

  it("persists a lightweight versioned snapshot bound to the worktree path", () => {
    const json = persistableSnapshot(snapshot(), details());
    expect(json).not.toContain("\"text\"");
    const restored = parsePersistedSnapshot(json, "C:/repo");
    expect(restored?.scopes?.all.find((f) => f.pathId === "new")?.status).toBe("renamed");
    expect(restored?.statsReady).toBe(true);
    expect(parsePersistedSnapshot(json, "C:/elsewhere")).toBeNull();
    expect(parsePersistedSnapshot(json.replace("\"version\":1", "\"version\":9"), "C:/repo")).toBeNull();
    expect(parsePersistedSnapshot("{broken", "C:/repo")).toBeNull();
  });

  it("decodes the binary content frame without JSON escaping", () => {
    const pair = {
      requestId: "q", repoId: "repo", revision: "r1", pathId: "a", displayPath: "a", stale: false, degradation: null,
      left: { endpoint: "index", text: null, byteLength: 4, encoding: "utf-8", eol: "lf", hasFinalNewline: true, contentId: "l" },
      right: { endpoint: "workingTree", text: null, byteLength: 1, encoding: "binary-or-unsupported", eol: "none", hasFinalNewline: null, contentId: "r",
        details: { state: "ready", reason: null, oid: null, mode: null, image: { mime: "image/png", base64: "", width: 1, height: 1, displayWidth: 1, displayHeight: 1, orientation: 1 } } }
    } as unknown as ContentPair;
    const text = new TextEncoder().encode("中文\n");
    const header = new TextEncoder().encode(JSON.stringify({ pair, textRanges: [[0, text.length], null], imageRanges: [null, [text.length, 3]] }));
    const frame = new Uint8Array(8 + header.length + text.length + 3);
    frame.set(new TextEncoder().encode("ORC1"), 0);
    new DataView(frame.buffer).setUint32(4, header.length, true);
    frame.set(header, 8);
    frame.set(text, 8 + header.length);
    frame.set([137, 80, 78], 8 + header.length + text.length);
    const decoded = decodeContentFrame(frame.buffer);
    expect(decoded.left.text).toBe("中文\n");
    expect(decoded.right.text).toBeNull();
    expect([...decoded.right.details!.image!.bytes!]).toEqual([137, 80, 78]);
    expect(() => decodeContentFrame(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it("DiffCache is keyed by content ids, survives revision changes and stays within 12 entries", () => {
    const cache = new DiffCache();
    const document = (id: string) => ({ requestId: id, contentIds: [id, id] as [string, string], changes: [], hunks: [], elapsedMs: 0 });
    cache.set("left", "right", document("x"));
    expect(cache.get("left", "right")?.requestId).toBe("x");
    expect(cache.get("left", "right", "ignore-whitespace")).toBeUndefined();
    for (let i = 0; i < 20; i++) cache.set(`l${i}`, `r${i}`, document(String(i)));
    expect(cache.stats().entries).toBe(12);
    expect(cache.get("left", "right")).toBeUndefined();
    expect(cache.get("l19", "r19")?.requestId).toBe("19");
  });
});
