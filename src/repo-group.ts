import type { GroupDiscovery, GroupMember, RepositoryInfo } from "./types";
import { defaultAnchor, projectName, type ProjectRecord, type WorkspaceState } from "./workspace-model";

/**
 * 工作区（任务 V2-07）的项目记录规则：
 * - 每个成员仓库仍是一条普通项目记录（阅读锚点、别名、提交草稿、快照都按 repoId 保存，切换成员复用项目切换）；
 * - 成员带 `groupId`，不单独占项目标签；父仓库记录带 `group`，就是项目栏上的工作区标签；
 * - `activeRepoId` 始终是当前仓库（可能是成员），项目栏按它所属的工作区高亮标签。
 */

/** 项目栏显示的记录：普通项目与工作区父仓库。 */
export const tabProjects = (state: WorkspaceState) => state.projects.filter((project) => !project.groupId);

/** 该仓库所属工作区的父仓库记录；普通项目返回 null。 */
export function groupRootOf(state: WorkspaceState, repoId: string | null | undefined): ProjectRecord | null {
  if (!repoId) return null;
  const record = state.projects.find((project) => project.repo.repoId === repoId);
  if (!record) return null;
  if (record.group) return record;
  if (!record.groupId) return null;
  return state.projects.find((project) => project.repo.repoId === record.groupId && project.group) ?? null;
}

/** 项目栏标签对应的仓库 id（工作区标签为其当前 / 上次选中的成员）。 */
export function tabKey(state: WorkspaceState, repoId: string | null | undefined) {
  return groupRootOf(state, repoId)?.repo.repoId ?? repoId ?? null;
}

/** 点击工作区标签时打开的成员：上次选中的成员仍存在则用它，否则父仓库。 */
export function groupEntry(state: WorkspaceState, root: ProjectRecord): ProjectRecord {
  const last = root.group?.lastRepoId;
  return state.projects.find((project) => project.repo.repoId === last && (project.groupId === root.repo.repoId || project === root)) ?? root;
}

/** 由发现结果得到成员的仓库信息（与 open_repository 返回的一致）。 */
export function memberRepo(member: GroupMember): RepositoryInfo | null {
  if (member.state !== "ready" || !member.repoId || !member.gitDir || !member.commonDir) return null;
  return {
    repoId: member.repoId,
    displayName: member.name,
    worktreePath: member.worktreePath,
    gitDir: member.gitDir,
    commonDir: member.commonDir,
    branch: member.branch ?? (member.headOid ? `detached @ ${member.headOid.slice(0, 7)}` : "unborn HEAD")
  };
}

export interface GroupApplied {
  state: WorkspaceState;
  /** 此前作为独立项目添加、这次并入工作区的成员名称（V2-D78，用于一次性提示）。 */
  merged: string[];
  /** 应当打开的成员 repoId。 */
  selected: string;
}

/**
 * 把一次发现结果写入项目列表（V2-D78）：已有的独立成员项目直接并入（保留别名与锚点），新成员补建记录，
 * 已不在工作区中的成员记录移除。工作区标签占用父仓库原来的位置；父仓库原来不在列表中时占用第一个被并入成员的位置。
 */
export function applyDiscovery(state: WorkspaceState, discovery: GroupDiscovery, gitExecutable: string): GroupApplied {
  const rootMember = discovery.members[0];
  const rootInfo = memberRepo(rootMember);
  if (!discovery.isGroup || !rootInfo) throw new Error("不是工作区");
  const rootId = rootInfo.repoId;
  const ready = discovery.members.slice(1).map((member) => ({ member, repo: memberRepo(member) })).filter((entry) => entry.repo) as { member: GroupMember; repo: RepositoryInfo }[];
  const readyIds = new Set(ready.map((entry) => entry.repo.repoId));
  const merged: string[] = [];
  const existingRoot = state.projects.find((project) => project.repo.repoId === rootId);
  let insertAt = existingRoot ? state.projects.indexOf(existingRoot) : -1;
  const kept: ProjectRecord[] = [];
  const byId = new Map<string, ProjectRecord>();
  state.projects.forEach((project, index) => {
    const id = project.repo.repoId;
    if (id === rootId) return;
    if (readyIds.has(id)) {
      if (!project.groupId || project.groupId !== rootId) {
        if (!project.groupId) merged.push(projectName(project));
        if (insertAt < 0 && !project.groupId) insertAt = index;
      }
      byId.set(id, project);
      return;
    }
    // 原属于该工作区、已不再是就绪成员的记录（子模块被移除、worktree 已删除）不再保留。
    if (project.groupId === rootId) return;
    kept.push(project);
  });
  const lastRepoId = existingRoot?.group?.lastRepoId;
  const selected = discovery.selectedRepoId && (discovery.selectedRepoId === rootId || readyIds.has(discovery.selectedRepoId))
    ? discovery.selectedRepoId
    : lastRepoId && (lastRepoId === rootId || readyIds.has(lastRepoId)) ? lastRepoId : rootId;
  const now = Date.now();
  const rootRecord: ProjectRecord = {
    ...(existingRoot ?? { gitExecutable, pinned: false, lastOpenedAt: now, anchor: defaultAnchor() }),
    repo: existingRoot ? { ...rootInfo, displayName: existingRoot.repo.displayName } : rootInfo,
    group: { lastRepoId: selected, manual: existingRoot?.group?.manual ?? [] }
  };
  delete rootRecord.groupId;
  const members: ProjectRecord[] = ready.map(({ repo }) => {
    const existing = byId.get(repo.repoId);
    const record: ProjectRecord = existing
      ? { ...existing, repo: { ...existing.repo, branch: repo.branch }, groupId: rootId }
      : { repo, gitExecutable, pinned: false, lastOpenedAt: 0, anchor: defaultAnchor(), groupId: rootId };
    delete record.group;
    return record;
  });
  // 标签位置按删除父仓库与被并入成员之前的下标换算。
  const before = insertAt < 0 ? kept.length : state.projects.slice(0, insertAt).filter((project) => kept.includes(project)).length;
  const projects = [...kept.slice(0, before), rootRecord, ...kept.slice(before), ...members];
  return { state: { ...state, projects }, merged, selected };
}

/** 移除整个工作区（只删除应用记录，不删除目录）；返回被移除的全部仓库 id。 */
export function removeGroup(state: WorkspaceState, rootId: string): { state: WorkspaceState; removed: string[] } {
  const removed = state.projects.filter((project) => project.repo.repoId === rootId || project.groupId === rootId).map((project) => project.repo.repoId);
  const projects = state.projects.filter((project) => !removed.includes(project.repo.repoId));
  const activeRemoved = !state.activeRepoId || removed.includes(state.activeRepoId);
  const nextTab = projects.find((project) => !project.groupId);
  const next = nextTab ? groupEntry({ ...state, projects }, nextTab).repo.repoId : null;
  return { state: { ...state, projects, activeRepoId: activeRemoved ? next : state.activeRepoId }, removed };
}

/** 记录工作区上次选中的成员（切换或重启后恢复，V2-D77）。 */
export function rememberMember(state: WorkspaceState, repoId: string): WorkspaceState {
  const root = groupRootOf(state, repoId);
  if (!root || root.group?.lastRepoId === repoId) return state;
  return { ...state, projects: state.projects.map((project) => project === root ? { ...project, group: { lastRepoId: repoId, manual: project.group?.manual ?? [] } } : project) };
}

/** 修改手动加入的成员路径（V2-D76）。 */
export function setManualMembers(state: WorkspaceState, rootId: string, manual: string[]): WorkspaceState {
  return { ...state, projects: state.projects.map((project) => project.repo.repoId === rootId && project.group ? { ...project, group: { ...project.group, manual } } : project) };
}

/** 路径比较：统一分隔符；Windows 路径不区分大小写。 */
export function samePath(a: string, b: string) {
  const norm = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  const left = norm(a), right = norm(b);
  return /^[a-z]:\//i.test(left) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function joinPath(base: string, relative: string) {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${relative.replace(/\//g, separator)}`;
}

/** 徽标中的改动数：一次扫描中未暂存与已暂存涉及的不同路径数。 */
export function changeCountOf(snapshot: { files: { pathId: string }[]; scopes?: { unstaged: { pathId: string }[]; staged: { pathId: string }[] } | null }) {
  if (!snapshot.scopes) return snapshot.files.length;
  return new Set([...snapshot.scopes.unstaged, ...snapshot.scopes.staged].map((file) => file.pathId)).size;
}

/** 选择器中的显示顺序：父仓库 → 子模块（按 `.gitmodules` 顺序，各自的 worktree 紧随其后）→ 手动加入。 */
export function pickerOrder(members: GroupMember[]): GroupMember[] {
  const root = members[0];
  if (!root) return [];
  const worktreesOf = (repoId: string | null) => members.filter((member) => member.kind === "worktree" && member.parentRepoId === repoId && repoId);
  const ordered: GroupMember[] = [root, ...worktreesOf(root.repoId)];
  for (const member of members) {
    if (member.kind !== "submodule") continue;
    ordered.push(member, ...worktreesOf(member.repoId));
  }
  ordered.push(...members.filter((member) => member.kind === "manual"));
  // 所属仓库未就绪的 worktree（极少见）放在最后，不丢失。
  ordered.push(...members.filter((member) => !ordered.includes(member)));
  return ordered;
}
