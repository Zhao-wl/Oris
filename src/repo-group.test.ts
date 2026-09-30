import { describe, expect, it } from "vitest";
import { applyDiscovery, changeCountOf, groupEntry, groupRootOf, joinPath, pickerOrder, rememberMember, removeGroup, samePath, tabKey, tabProjects } from "./repo-group";
import type { GroupDiscovery, GroupMember } from "./types";
import { defaultAnchor, loadWorkspace, saveWorkspace, type ProjectRecord, type WorkspaceState } from "./workspace-model";

const ROOT = "E:\\X20\\game-workspace";
const member = (name: string, kind: GroupMember["kind"], extra: Partial<GroupMember> = {}): GroupMember => ({
  repoId: `id-${name}`,
  kind,
  name,
  worktreePath: kind === "superproject" ? ROOT : `${ROOT}\\${name}`,
  relativePath: kind === "superproject" ? "" : name,
  parentRepoId: kind === "superproject" ? null : "id-game-workspace",
  state: "ready",
  gitDir: `${ROOT}\\.git${kind === "superproject" ? "" : `\\modules\\${name}`}`,
  commonDir: `${ROOT}\\.git${kind === "superproject" ? "" : `\\modules\\${name}`}`,
  branch: "dev",
  headOid: "a".repeat(40),
  recordedOid: null,
  ...extra
});
const discovery = (selected = "id-game-workspace", extra: GroupMember[] = []): GroupDiscovery => ({
  isGroup: true,
  selectedRepoId: selected,
  ignored: [],
  members: [
    member("game-workspace", "superproject"),
    member("audio", "submodule", { repoId: null, state: "uninitialized", gitDir: null, commonDir: null }),
    member("battle", "submodule"),
    member("battle-r2", "worktree", { parentRepoId: "id-battle" }),
    member("client", "submodule"),
    ...extra
  ]
});
const record = (repoId: string, name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord => ({
  repo: { repoId, displayName: name, worktreePath: `D:\\${name}`, gitDir: "", commonDir: "", branch: "main" },
  gitExecutable: "",
  pinned: false,
  lastOpenedAt: 1,
  anchor: defaultAnchor(),
  ...extra
});
const state = (projects: ProjectRecord[], activeRepoId: string | null = projects[0]?.repo.repoId ?? null): WorkspaceState => ({ version: 2, activeRepoId, projects });

describe("工作区项目记录（V2-D76、V2-D79）", () => {
  it("添加工作区：父仓库成为标签，就绪成员补建隐藏记录，未初始化的不建记录", () => {
    const applied = applyDiscovery(state([record("oris", "Oris")]), discovery(), "");
    const tabs = tabProjects(applied.state).map((project) => project.repo.repoId);
    expect(tabs).toEqual(["oris", "id-game-workspace"]);
    expect(applied.state.projects.filter((project) => project.groupId === "id-game-workspace").map((project) => project.repo.displayName)).toEqual(["battle", "battle-r2", "client"]);
    expect(applied.merged).toEqual([]);
    expect(applied.selected).toBe("id-game-workspace");
  });

  it("已有的独立成员项目直接并入，保留别名与阅读位置，工作区占用第一个被并入项目的位置", () => {
    const anchor = { ...defaultAnchor(), selectedPathId: "keep-me", scope: "staged" as const };
    const before = state([record("oris", "Oris"), record("id-client", "client", { customName: "客户端", anchor }), record("skippa", "Skippa"), record("id-battle", "battle")]);
    const applied = applyDiscovery(before, discovery("id-client"), "");
    expect(tabProjects(applied.state).map((project) => project.repo.repoId)).toEqual(["oris", "id-game-workspace", "skippa"]);
    expect(applied.merged).toEqual(["客户端", "battle"]);
    const client = applied.state.projects.find((project) => project.repo.repoId === "id-client")!;
    expect(client.customName).toBe("客户端");
    expect(client.anchor).toEqual(anchor);
    expect(client.groupId).toBe("id-game-workspace");
    // 直接添加子模块目录：选中该子模块（V2-D79）。
    expect(applied.selected).toBe("id-client");
    expect(groupRootOf(applied.state, "id-client")?.repo.repoId).toBe("id-game-workspace");
  });

  it("父仓库原来就是独立项目时保持其位置；重新发现时移除已不存在的成员，不重复并入", () => {
    const first = applyDiscovery(state([record("id-game-workspace", "game-workspace"), record("oris", "Oris")]), discovery(), "").state;
    expect(tabProjects(first).map((project) => project.repo.repoId)).toEqual(["id-game-workspace", "oris"]);
    const shrunk: GroupDiscovery = { ...discovery(), members: discovery().members.filter((m) => m.name !== "battle-r2") };
    const again = applyDiscovery(first, shrunk, "");
    expect(again.merged).toEqual([]);
    expect(again.state.projects.some((project) => project.repo.repoId === "id-battle-r2")).toBe(false);
    expect(again.state.projects.length).toBe(first.projects.length - 1);
  });

  it("工作区标签恢复上次选中的成员；移除工作区时一并移除全部成员记录", () => {
    const applied = applyDiscovery(state([record("oris", "Oris")]), discovery(), "").state;
    const remembered = rememberMember({ ...applied, activeRepoId: "id-client" }, "id-client");
    const root = tabProjects(remembered).find((project) => project.group)!;
    expect(groupEntry(remembered, root).repo.repoId).toBe("id-client");
    expect(tabKey(remembered, "id-client")).toBe("id-game-workspace");
    expect(tabKey(remembered, "oris")).toBe("oris");
    const { state: after, removed } = removeGroup({ ...remembered, activeRepoId: "id-client" }, "id-game-workspace");
    expect(removed.sort()).toEqual(["id-battle", "id-battle-r2", "id-client", "id-game-workspace"]);
    expect(after.projects.map((project) => project.repo.repoId)).toEqual(["oris"]);
    expect(after.activeRepoId).toBe("oris");
  });

  it("持久化保留工作区字段；成员引用的工作区缺失时退回为普通项目", () => {
    const applied = applyDiscovery(state([record("oris", "Oris")]), discovery(), "").state;
    const withPointer = { ...applied, projects: applied.projects.map((project) => project.group ? { ...project, showSubmodulePointers: true } : project) };
    const storage = new Map<string, string>();
    saveWorkspace({ setItem: (key, value) => storage.set(key, value) }, withPointer);
    const loaded = loadWorkspace({ getItem: (key) => storage.get(key) ?? null });
    expect(loaded.projects).toEqual(withPointer.projects);
    const orphaned = { ...withPointer, projects: withPointer.projects.filter((project) => !project.group) };
    saveWorkspace({ setItem: (key, value) => storage.set(key, value) }, orphaned);
    const reloaded = loadWorkspace({ getItem: (key) => storage.get(key) ?? null });
    expect(reloaded.projects.every((project) => !project.groupId)).toBe(true);
  });
});

describe("选择器与路径", () => {
  it("父仓库 → 子模块（worktree 紧随所属仓库）→ 手动加入", () => {
    const manual = member("gdconfig_tmp", "manual");
    const rootWorktree = member("ws-wt", "worktree", { parentRepoId: "id-game-workspace" });
    const ordered = pickerOrder([...discovery("id-game-workspace", [manual, rootWorktree]).members]);
    expect(ordered.map((m) => m.name)).toEqual(["game-workspace", "ws-wt", "audio", "battle", "battle-r2", "client", "gdconfig_tmp"]);
  });

  it("路径比较与拼接、改动数按路径去重", () => {
    expect(samePath("E:\\X20\\ws\\battle-r2", "e:/x20/ws/battle-r2/")).toBe(true);
    expect(samePath("/home/a/B", "/home/a/b")).toBe(false);
    expect(joinPath("E:\\ws", "client/.gdconfig_tmp")).toBe("E:\\ws\\client\\.gdconfig_tmp");
    expect(changeCountOf({ files: [], scopes: { unstaged: [{ pathId: "a" }, { pathId: "b" }], staged: [{ pathId: "a" }] } })).toBe(2);
  });
});
