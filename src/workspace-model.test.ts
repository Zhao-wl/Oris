import { describe, expect, it } from "vitest";
import type { ContentPair, RepositoryInfo } from "./types";
import { ContentCache, RequestGate, moveProject, projectName, saveWorkspace, defaultAnchor, emptyWorkspace, loadWorkspace, removeProject, resolveReadingSelection, upsertProject } from "./workspace-model";

const repo = (id: string, path = `C:/${id}`): RepositoryInfo => ({
  repoId: id, displayName: "same-name", worktreePath: path, gitDir: `${path}/.git`, commonDir: `${path}/.git`, branch: "main"
});

const pair = (id: string, bytes: number): ContentPair => ({
  requestId: id, repoId: id, revision: "r", pathId: "p", displayPath: "p",
  left: { endpoint: "head", text: "", byteLength: bytes, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: "l" },
  right: { endpoint: "workingTree", text: "", byteLength: 0, encoding: "utf-8", eol: "none", hasFinalNewline: false, contentId: "r" },
  stale: false, degradation: null
});

describe("workspace model", () => {
  it("deduplicates by stable repo id while preserving same-name different paths", () => {
    let state = emptyWorkspace();
    state = upsertProject(state, { repo: repo("a", "C:/one/same"), gitExecutable: "", pinned: false, lastOpenedAt: 1, anchor: defaultAnchor() });
    state = upsertProject(state, { repo: repo("b", "D:/two/same"), gitExecutable: "", pinned: true, lastOpenedAt: 2, anchor: defaultAnchor() });
    state = upsertProject(state, { repo: repo("a", "C:/one/same"), gitExecutable: "git", pinned: false, lastOpenedAt: 3, anchor: defaultAnchor() });
    expect(state.projects.map((project) => project.repo.repoId)).toEqual(["a", "b"]);
    expect(state.projects).toHaveLength(2);
  });

  it("removes only the record and repairs the active selection", () => {
    const state = {
      version: 2 as const, activeRepoId: "a",
      projects: ["a", "b"].map((id) => ({ repo: repo(id), gitExecutable: "", pinned: false, lastOpenedAt: 0, anchor: defaultAnchor() }))
    };
    expect(removeProject(state, "a")).toMatchObject({ activeRepoId: "b", projects: [{ repo: { repoId: "b" } }] });
  });

  it("rejects corrupt and duplicate persisted records", () => {
    const value = JSON.stringify({ version: 2, activeRepoId: "missing", projects: [
      { repo: repo("a"), gitExecutable: "", pinned: false, lastOpenedAt: 1, anchor: { scope: "bad" } },
      { repo: repo("a"), gitExecutable: "", pinned: true, lastOpenedAt: 2 },
      { broken: true }
    ] });
    const state = loadWorkspace({ getItem: () => value });
    expect(state.projects).toHaveLength(1);
    expect(state.activeRepoId).toBe("a");
    expect(state.projects[0].anchor.scope).toBe("unstaged");
  });

  it("evicts content by entry count and byte budget", () => {
    const cache = new ContentCache(5, 2);
    cache.set("a:1", pair("a", 3));
    cache.set("a:2", pair("a", 2));
    cache.get("a:1");
    cache.set("b:1", pair("b", 2));
    expect(cache.get("a:2")).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 2, bytes: 5, budget: 5 });
    cache.clearRepo("a");
    expect(cache.stats().entries).toBe(1);
  });

  it("drops a delayed A result after B becomes active", () => {
    const gate = new RequestGate();
    gate.activate("slow-A");
    gate.activate("fast-B");
    expect(gate.accepts("slow-A")).toBe(false);
    expect(gate.accepts("fast-B")).toBe(true);
  });

  it("reports an invalidated reading selection before choosing a legal fallback", () => {
    const files = [{ pathId: "current" }, { pathId: "other" }];
    expect(resolveReadingSelection(files, "missing")).toEqual({ selected: files[0], invalidated: true });
    expect(resolveReadingSelection(files, "other")).toEqual({ selected: files[1], invalidated: false });
    expect(resolveReadingSelection([], "missing")).toEqual({ selected: null, invalidated: true });
  });

  it("records 30 hot five-project model switches", () => {
    let state = emptyWorkspace();
    const cache = new ContentCache();
    for (let index = 0; index < 5; index += 1) {
      const id = `repo-${index}`;
      state = upsertProject(state, { repo: repo(id), gitExecutable: "", pinned: false, lastOpenedAt: index, anchor: defaultAnchor() });
      cache.set(`${id}:all:r:p`, pair(id, 1024));
    }
    const samples: number[] = [];
    for (let run = 0; run < 30; run += 1) {
      const project = state.projects[run % state.projects.length];
      const started = performance.now();
      state = upsertProject(state, { ...project, lastOpenedAt: run + 10 });
      expect(cache.get(`${project.repo.repoId}:all:r:p`)).toBeDefined();
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const p50 = samples[14];
    const p95 = samples[28];
    console.log(`ORIS_TASK02_HOT_MODEL {"projects":5,"runs":30,"p50Ms":${p50.toFixed(3)},"p95Ms":${p95.toFixed(3)}}`);
    expect(p95).toBeLessThan(200);
  });
});


describe("feedback project order", () => {
  it("migrates existing v2 array order and keeps it through access, pin and reload", () => {
    const old = { version: 2, activeRepoId: "a", projects: ["a", "b", "c"].map((id, i) => ({ repo: repo(id), gitExecutable: "", pinned: i === 2, lastOpenedAt: 100 - i, anchor: defaultAnchor() })) };
    let state = loadWorkspace({ getItem: () => JSON.stringify(old) });
    state = upsertProject(state, { ...state.projects[1], pinned: true, lastOpenedAt: 999, customName: "我的项目" });
    expect(state.projects.map(p => p.repo.repoId)).toEqual(["a", "b", "c"]);
    state = moveProject(state, "c", "a");
    let persisted = ""; saveWorkspace({ setItem: (_, value) => { persisted = value; } }, state);
    state = loadWorkspace({ getItem: () => persisted });
    expect(state.projects.map(p => p.repo.repoId)).toEqual(["c", "a", "b"]);
    expect(projectName(state.projects[2])).toBe("我的项目");
    expect(projectName({ ...state.projects[2], customName: "  " })).toBe("same-name");
    expect(state.projects[2].repo.worktreePath).toBe("C:/b");
  });
});


it("shares the existing cache budget with computed documents and drops both on repository invalidation", () => {
  const cache = new ContentCache(400, 2);
  const document = { requestId: "r", contentIds: ["l", "r"] as [string, string], changes: [], hunks: [], elapsedMs: 1 };
  cache.set("a:1", pair("a", 200)); cache.setDocument("a:1", document);
  expect(cache.getDocument("a:1")).toBe(document);
  expect(cache.stats().bytes).toBe(328);
  cache.set("b:1", pair("b", 200));
  expect(cache.get("a:1")).toBeUndefined(); expect(cache.getDocument("a:1")).toBeUndefined();
  cache.setDocument("b:1", document); cache.clearRepo("b");
  expect(cache.stats().bytes).toBe(0);
});
