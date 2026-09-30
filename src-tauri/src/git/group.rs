//! 工作区发现（任务 V2-07，技术方案 §10.2）：识别“父仓库 + 子模块 + worktree”的结构，全部走只读通道。
//!
//! - 只读取 `.gitmodules` 中的 `path`（`git config --file`，不读 `url` 等字段），路径必须是相对路径且规范化后位于父仓库内；
//! - 不执行任何 `git submodule` 子命令，不初始化、不更新；
//! - 成员的 repoId 与 [`GitAdapter::open`](super::GitAdapter::open) 的计算方式相同（规范化后的工作区根路径哈希）。
#![cfg_attr(not(feature = "desktop"), allow(dead_code))]
use super::{canonical_output_path, hash_bytes, run_readonly, run_required, GitError};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemberKind {
    Superproject,
    Submodule,
    Worktree,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemberState {
    Ready,
    /// 子模块目录不是已初始化的仓库。
    Uninitialized,
    /// worktree 登记仍在，但目录已不存在。
    Missing,
    /// 手动加入的路径已不是位于工作区内的独立仓库。
    Invalid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    /// 就绪成员的 repoId；未初始化 / 缺失的成员为 None。
    pub repo_id: Option<String>,
    pub kind: MemberKind,
    pub name: String,
    /// 工作区根路径（绝对路径；未初始化时为按 `.gitmodules` 拼出的路径）。
    pub worktree_path: String,
    /// 相对父仓库根的显示路径（`/` 分隔；位于父仓库外时为绝对路径）。
    pub relative_path: String,
    /// worktree 所属仓库的 repoId。
    pub parent_repo_id: Option<String>,
    pub state: MemberState,
    pub git_dir: Option<String>,
    pub common_dir: Option<String>,
    /// 当前分支；detached 时为 None。
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    /// 父仓库 index 中记录的子模块提交（只对子模块有意义）。
    pub recorded_oid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDiscovery {
    /// 是否为工作区（父仓库 `.gitmodules` 中至少有一个子模块条目，V2-D76）。
    pub is_group: bool,
    /// 父仓库与全部成员（父仓库在第一位；不是工作区时只有所选仓库自身）。
    pub members: Vec<GroupMember>,
    /// 所选目录对应的成员 repoId（直接添加子模块目录时为该子模块，V2-D79）。
    pub selected_repo_id: Option<String>,
    /// 被忽略的 `.gitmodules` 条目与原因（绝对路径、越界路径等）。
    pub ignored: Vec<String>,
}

struct RepoPaths {
    worktree: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

fn repo_paths(git: &Path, dir: &Path) -> Result<RepoPaths, GitError> {
    let output = run_required(git, dir, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"])?;
    let text = String::from_utf8(output.stdout).map_err(|_| GitError::UnsupportedPathEncoding)?;
    let mut lines = text.lines();
    Ok(RepoPaths {
        worktree: canonical_output_path(lines.next())?,
        git_dir: canonical_output_path(lines.next())?,
        common_dir: canonical_output_path(lines.next())?,
    })
}

/// 所选目录的路径与所属父仓库合并为一次 `rev-parse`（lc5：打开工作区时的 Git 启动都在关键路径上）。
/// `--show-superproject-working-tree` 不在子模块中时不输出，因此第 4 行存在即为父仓库工作区。
fn repo_paths_and_superproject(git: &Path, dir: &Path) -> Result<(RepoPaths, Option<PathBuf>), GitError> {
    let output = run_required(git, dir, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-superproject-working-tree"])?;
    let text = String::from_utf8(output.stdout).map_err(|_| GitError::UnsupportedPathEncoding)?;
    let mut lines = text.lines();
    let paths = RepoPaths {
        worktree: canonical_output_path(lines.next())?,
        git_dir: canonical_output_path(lines.next())?,
        common_dir: canonical_output_path(lines.next())?,
    };
    let superproject = lines.next().map(str::trim).filter(|line| !line.is_empty()).and_then(|line| dunce::canonicalize(line).ok());
    Ok((paths, superproject))
}

fn superproject_of(git: &Path, worktree: &Path) -> Option<PathBuf> {
    let output = run_readonly(git, worktree, &["rev-parse", "--show-superproject-working-tree"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    dunce::canonicalize(line).ok()
}

fn repo_id_of(worktree: &Path) -> String {
    hash_bytes(worktree.to_string_lossy().as_bytes())
}

/// 当前分支与 HEAD 提交；两者都是只读 plumbing。
fn head_of(git: &Path, worktree: &Path) -> (Option<String>, Option<String>) {
    let text = |args: &[&str]| {
        run_readonly(git, worktree, args)
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .filter(|t| !t.is_empty())
    };
    // 两次查询互不依赖：并行启动，打开工作区时少一次串行的 Git 启动。
    std::thread::scope(|scope| {
        let branch = scope.spawn(|| text(&["symbolic-ref", "--quiet", "--short", "HEAD"]));
        let head = text(&["rev-parse", "--verify", "--quiet", "HEAD"]);
        (branch.join().unwrap_or(None), head)
    })
}

/// `.gitmodules` 中的 (名称, 路径)。只读取 `submodule.<name>.path`。
pub(super) fn gitmodule_paths(git: &Path, root: &Path) -> Vec<(String, String)> {
    if !root.join(".gitmodules").is_file() {
        return Vec::new();
    }
    let Ok(output) = run_readonly(git, root, &["config", "--file", ".gitmodules", "--null", "--get-regexp", r"^submodule\..*\.path$"]) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut entries = Vec::new();
    // `--null`：每项为 “键\n值\0”。
    for item in output.stdout.split(|b| *b == 0).filter(|i| !i.is_empty()) {
        let text = String::from_utf8_lossy(item);
        let Some((key, value)) = text.split_once('\n') else { continue };
        let Some(name) = key.strip_prefix("submodule.").and_then(|k| k.strip_suffix(".path")) else { continue };
        entries.push((name.to_owned(), value.to_owned()));
    }
    entries
}

/// 校验 `.gitmodules` 路径：相对路径、不含 `..`、不为空；返回规范化前的绝对路径。
fn member_dir(root: &Path, value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("路径为空".into());
    }
    let relative = Path::new(trimmed);
    if relative.is_absolute() || relative.has_root() || trimmed.contains(':') {
        return Err("不是相对路径".into());
    }
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("路径越出父仓库".into());
    }
    Ok(root.join(relative))
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

/// 父仓库 index 中各子模块路径记录的提交（`ls-files -s`，mode 160000）。
fn recorded_pointers(git: &Path, root: &Path, paths: &[String]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if paths.is_empty() {
        return map;
    }
    let mut args = vec!["ls-files", "-s", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    let Ok(output) = run_readonly(git, root, &args) else { return map };
    for item in output.stdout.split(|b| *b == 0).filter(|i| !i.is_empty()) {
        let text = String::from_utf8_lossy(item);
        let Some((meta, path)) = text.split_once('\t') else { continue };
        let fields: Vec<&str> = meta.split(' ').collect();
        if fields.len() >= 2 && fields[0] == "160000" {
            map.insert(path.to_owned(), fields[1].to_owned());
        }
    }
    map
}

struct LinkedWorktree {
    path: PathBuf,
    branch: Option<String>,
    head: Option<String>,
    prunable: bool,
}

/// `worktree list --porcelain -z` 中除主工作区以外的 linked worktree。
fn linked_worktrees(git: &Path, worktree: &Path) -> Vec<LinkedWorktree> {
    let Ok(output) = run_readonly(git, worktree, &["worktree", "list", "--porcelain", "-z"]) else { return Vec::new() };
    if !output.status.success() {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut current: Option<LinkedWorktree> = None;
    let mut first = true;
    let flush = |entry: Option<LinkedWorktree>, first: &mut bool, result: &mut Vec<LinkedWorktree>| {
        if let Some(entry) = entry {
            if !std::mem::replace(first, false) {
                result.push(entry);
            }
        }
    };
    for field in output.stdout.split(|b| *b == 0) {
        let text = String::from_utf8_lossy(field);
        if text.is_empty() {
            flush(current.take(), &mut first, &mut result);
            continue;
        }
        if let Some(path) = text.strip_prefix("worktree ") {
            flush(current.take(), &mut first, &mut result);
            current = Some(LinkedWorktree { path: PathBuf::from(path), branch: None, head: None, prunable: false });
        } else if let Some(entry) = current.as_mut() {
            if let Some(head) = text.strip_prefix("HEAD ") {
                entry.head = Some(head.to_owned());
            } else if let Some(branch) = text.strip_prefix("branch ") {
                entry.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_owned());
            } else if text == "prunable" || text.starts_with("prunable ") {
                entry.prunable = true;
            }
        }
    }
    flush(current.take(), &mut first, &mut result);
    result
}

fn ready_member(git: &Path, kind: MemberKind, name: String, root: &Path, paths: &RepoPaths, parent: Option<String>, recorded: Option<String>) -> GroupMember {
    let (branch, head_oid) = head_of(git, &paths.worktree);
    GroupMember {
        repo_id: Some(repo_id_of(&paths.worktree)),
        kind,
        name,
        worktree_path: paths.worktree.to_string_lossy().into_owned(),
        relative_path: display_relative(root, &paths.worktree),
        parent_repo_id: parent,
        state: MemberState::Ready,
        git_dir: Some(paths.git_dir.to_string_lossy().into_owned()),
        common_dir: Some(paths.common_dir.to_string_lossy().into_owned()),
        branch,
        head_oid,
        recorded_oid: recorded,
    }
}

fn unavailable(kind: MemberKind, name: String, root: &Path, path: &Path, parent: Option<String>, state: MemberState, recorded: Option<String>) -> GroupMember {
    GroupMember {
        repo_id: None,
        kind,
        name,
        worktree_path: path.to_string_lossy().into_owned(),
        relative_path: display_relative(root, path),
        parent_repo_id: parent,
        state,
        git_dir: None,
        common_dir: None,
        branch: None,
        head_oid: None,
        recorded_oid: recorded,
    }
}

/// 一个仓库（父仓库或子模块）的 linked worktree 成员。
/// 只有解析出的工作区根正好是登记的路径才算就绪：目录还在但不是完整 worktree（例如停在 `locked initializing`）时，
/// Git 会向上找到别的仓库，不能把它当成这个 worktree（否则所属仓库会被重复列出）。
fn worktree_members(git: &Path, root: &Path, owner: &RepoPaths) -> Vec<GroupMember> {
    let owner_id = repo_id_of(&owner.worktree);
    let owner_name = owner.worktree.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    linked_worktrees(git, &owner.worktree)
        .into_iter()
        .map(|linked| {
            let base = linked.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // 与所属仓库同名（常见于工具在别处创建的 worktree）时带上上级目录，便于区分。
            let name = match linked.path.parent().and_then(|p| p.file_name()) {
                Some(parent) if base == owner_name => format!("{}/{base}", parent.to_string_lossy()),
                _ => base,
            };
            let exists = !linked.prunable && linked.path.is_dir();
            let canonical = dunce::canonicalize(&linked.path).ok();
            let resolved = exists
                .then(|| repo_paths(git, &linked.path).ok())
                .flatten()
                .filter(|paths| canonical.as_ref() == Some(&paths.worktree) && paths.worktree != owner.worktree);
            match resolved {
                Some(paths) => {
                    let mut member = ready_member(git, MemberKind::Worktree, name, root, &paths, Some(owner_id.clone()), None);
                    if member.branch.is_none() {
                        member.branch = linked.branch;
                    }
                    member.head_oid = member.head_oid.or(linked.head);
                    member
                }
                None => {
                    let path = dunce::canonicalize(&linked.path).unwrap_or(linked.path);
                    unavailable(MemberKind::Worktree, name, root, &path, Some(owner_id.clone()), MemberState::Missing, None)
                }
            }
        })
        .collect()
}

/// 子模块 linked worktree 的父仓库：common dir 形如 `<父仓库>/.git/modules/<名称>`（可能多级）。
fn superproject_by_common_dir(common_dir: &Path) -> Option<PathBuf> {
    let mut current = common_dir;
    while let Some(parent) = current.parent() {
        if parent.file_name().is_some_and(|n| n == "modules") {
            if let Some(dot_git) = parent.parent().filter(|p| p.file_name().is_some_and(|n| n == ".git")) {
                return dot_git.parent().map(Path::to_path_buf);
            }
        }
        current = parent;
    }
    None
}

/// 发现 `path` 所在的工作区。`manual` 为用户手动加入的独立嵌套仓库路径（V2-D77）。
pub fn discover(git: &Path, path: &Path, manual: &[String]) -> Result<GroupDiscovery, GitError> {
    let requested = dunce::canonicalize(path).map_err(|error| GitError::InvalidRepository(error.to_string()))?;
    // 路径与所属父仓库一次读出（lc5：原先分两次 rev-parse，都在打开项目的关键路径上）。
    let (selected, superproject) = repo_paths_and_superproject(git, &requested)?;
    // 归属（V2-D79）：子模块目录报告父仓库；子模块的 worktree 用 common dir 推出父仓库。父仓库本身也是子模块时按普通项目处理。
    let candidate = superproject.or_else(|| superproject_by_common_dir(&selected.common_dir).filter(|root| root.join(".gitmodules").is_file()));
    let root = match candidate {
        Some(root) if superproject_of(git, &root).is_none() && !gitmodule_paths(git, &root).is_empty() => root,
        Some(_) => return Ok(single(git, &selected)),
        None => selected.worktree.clone(),
    };
    let modules = gitmodule_paths(git, &root);
    if modules.is_empty() {
        return Ok(single(git, &selected));
    }
    // 添加的就是父仓库时，路径已在上面读出，不再重复 rev-parse。
    let root_paths = if root == selected.worktree { RepoPaths { worktree: selected.worktree.clone(), git_dir: selected.git_dir.clone(), common_dir: selected.common_dir.clone() } } else { repo_paths(git, &root)? };
    let mut ignored = Vec::new();
    let mut valid: Vec<(String, String, PathBuf)> = Vec::new();
    for (name, value) in modules {
        match member_dir(&root_paths.worktree, &value) {
            Ok(dir) => valid.push((name, value.trim_end_matches('/').to_owned(), dir)),
            Err(reason) => ignored.push(format!("{name}（{value}）：{reason}")),
        }
    }
    let root_id = repo_id_of(&root_paths.worktree);
    // 各成员的读取相互独立，并行执行以缩短打开时间（技术方案 §10.6）；父仓库 index 中记录的指针（ls-files -s）也与之并行，
    // 结束后按 `.gitmodules` 中的顺序填回各子模块（lc5）。
    let (recorded, groups): (std::collections::HashMap<String, String>, Vec<Vec<GroupMember>>) = std::thread::scope(|scope| {
        let root_ref = &root_paths;
        let paths: Vec<String> = valid.iter().map(|(_, p, _)| p.clone()).collect();
        let recorded = scope.spawn(move || recorded_pointers(git, &root_ref.worktree, &paths));
        let mut handles = vec![scope.spawn(move || {
            // 分支 / HEAD 与 linked worktree 列表互不依赖：并行读取。
            let (head, worktrees) = std::thread::scope(|inner| {
                let worktrees = inner.spawn(|| worktree_members(git, &root_ref.worktree, root_ref));
                (head_of(git, &root_ref.worktree), worktrees.join().unwrap_or_default())
            });
            let (branch, head_oid) = head;
            let mut members = vec![GroupMember {
                repo_id: Some(repo_id_of(&root_ref.worktree)),
                kind: MemberKind::Superproject,
                name: root_ref.worktree.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                worktree_path: root_ref.worktree.to_string_lossy().into_owned(),
                relative_path: String::new(),
                parent_repo_id: None,
                state: MemberState::Ready,
                git_dir: Some(root_ref.git_dir.to_string_lossy().into_owned()),
                common_dir: Some(root_ref.common_dir.to_string_lossy().into_owned()),
                branch,
                head_oid,
                recorded_oid: None,
            }];
            members.extend(worktrees);
            members
        })];
        for (name, _, dir) in &valid {
            let root_dir = &root_ref.worktree;
            let root_id = root_id.clone();
            handles.push(scope.spawn(move || {
                let initialized = dir
                    .join(".git")
                    .exists()
                    .then(|| repo_paths(git, dir).ok())
                    .flatten()
                    .filter(|paths| dunce::canonicalize(dir).is_ok_and(|d| d == paths.worktree));
                match initialized {
                    Some(paths) if paths.worktree.starts_with(root_dir) => std::thread::scope(|inner| {
                        let worktrees = inner.spawn(|| worktree_members(git, root_dir, &paths));
                        let mut members = vec![ready_member(git, MemberKind::Submodule, name.clone(), root_dir, &paths, Some(root_id), None)];
                        members.extend(worktrees.join().unwrap_or_default());
                        members
                    }),
                    _ => vec![unavailable(MemberKind::Submodule, name.clone(), root_dir, dir, Some(root_id), MemberState::Uninitialized, None)],
                }
            }));
        }
        let groups: Vec<Vec<GroupMember>> = handles.into_iter().map(|h| h.join().unwrap_or_default()).collect();
        (recorded.join().unwrap_or_default(), groups)
    });
    // 子模块成员是第 2 组起每组的第一项，顺序与 valid 相同。
    let mut groups = groups;
    for (group, (_, relative, _)) in groups.iter_mut().skip(1).zip(&valid) {
        if let Some(first) = group.first_mut() {
            first.recorded_oid = recorded.get(relative).cloned();
        }
    }
    let mut members: Vec<GroupMember> = groups.into_iter().flatten().collect();
    for value in manual {
        let dir = PathBuf::from(value);
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let paths = dunce::canonicalize(&dir).ok().and_then(|d| repo_paths(git, &d).ok().filter(|p| p.worktree == d));
        let member = match paths {
            Some(paths)
                if paths.worktree.starts_with(&root_paths.worktree)
                    && paths.worktree != root_paths.worktree
                    && !members.iter().any(|m| m.worktree_path == paths.worktree.to_string_lossy()) =>
            {
                ready_member(git, MemberKind::Manual, name, &root_paths.worktree, &paths, Some(root_id.clone()), None)
            }
            _ => unavailable(MemberKind::Manual, name, &root_paths.worktree, &dir, Some(root_id.clone()), MemberState::Invalid, None),
        };
        members.push(member);
    }
    let selected_id = repo_id_of(&selected.worktree);
    let selected_repo_id = members.iter().any(|m| m.repo_id.as_deref() == Some(&selected_id)).then_some(selected_id);
    Ok(GroupDiscovery { is_group: true, members, selected_repo_id, ignored })
}

/// 不是工作区：只返回所选仓库自身。
fn single(git: &Path, selected: &RepoPaths) -> GroupDiscovery {
    let name = selected.worktree.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let member = ready_member(git, MemberKind::Superproject, name, &selected.worktree, selected, None, None);
    GroupDiscovery { is_group: false, selected_repo_id: member.repo_id.clone(), members: vec![member], ignored: Vec::new() }
}

/// 成员的改动数（徽标，V2-D83）：一次只读 status，不读取内容；子模块指针按该仓库的开关计入。
pub fn change_count(git: &Path, worktree: &Path, show_submodule_pointers: bool) -> Result<usize, GitError> {
    let mut args = vec!["status", "--porcelain=v2", "-z", "--untracked-files=all"];
    if worktree.join(".gitmodules").is_file() {
        args.push(if show_submodule_pointers { "--ignore-submodules=dirty" } else { "--ignore-submodules=all" });
    }
    let raw = run_required(git, worktree, &args)?.stdout;
    let (_, files) = super::status_v2::parse(&raw)?;
    Ok(files.all.iter().filter(|entry| !super::scan::is_nested_repo(worktree, entry)).count())
}
