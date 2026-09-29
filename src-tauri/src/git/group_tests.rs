//! 任务 V2-07 工作区：发现与归属（B31）、父仓库排除子仓库与指针开关（B32、B33）、嵌套仓库与历史指针（B34）。
//! 全部在临时仓库中进行；发现与扫描前后记录各成员的 refs / index / config，断言只读。
use super::group::{self, MemberKind, MemberState};
use super::*;

fn git_in(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"])
        .args(args)
        .env("GIT_AUTHOR_NAME", "Alice")
        .env("GIT_AUTHOR_EMAIL", "alice@example.invalid")
        .env("GIT_COMMITTER_NAME", "Alice")
        .env("GIT_COMMITTER_EMAIL", "alice@example.invalid")
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn repo_with_commit(dir: &Path, file: &str) {
    fs::create_dir_all(dir).unwrap();
    git_in(dir, &["init", "-q", "-b", "main"]);
    fs::write(dir.join(file), "one\n").unwrap();
    git_in(dir, &["add", "-A"]);
    git_in(dir, &["commit", "-qm", "init"]);
}

fn canon(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap()
}

fn gp() -> &'static Path {
    Path::new("git")
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
}

/// 父仓库 + 子模块 battle（带父目录内的 worktree 与一个已删除目录的 worktree）、client（内有独立嵌套仓库）、
/// audio（未初始化）、tools（自身含子模块 deep）；`.gitmodules` 追加绝对路径与越界路径的条目。
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = canon(dir.path());
    let sources = base.join("sources");
    for name in ["battle", "client", "audio", "tools", "deep"] {
        repo_with_commit(&sources.join(name), &format!("{name}.txt"));
    }
    let deep = sources.join("deep").to_string_lossy().replace('\\', "/");
    git_in(&sources.join("tools"), &["submodule", "add", "-q", &deep, "deep"]);
    git_in(&sources.join("tools"), &["commit", "-qm", "add deep"]);
    let root = base.join("game-workspace");
    repo_with_commit(&root, "AGENTS.md");
    for name in ["battle", "client", "audio", "tools"] {
        let url = sources.join(name).to_string_lossy().replace('\\', "/");
        git_in(&root, &["submodule", "add", "-q", &url, name]);
    }
    git_in(&root, &["commit", "-qm", "add submodules"]);
    git_in(&root, &["submodule", "deinit", "-q", "-f", "audio"]);
    // 放在父仓库目录中的 battle worktree，以及工作区外、随后删除目录的 worktree。
    git_in(&root.join("battle"), &["worktree", "add", "-q", "--detach", &root.join("battle-r2").to_string_lossy()]);
    let outside = base.join("outside-wt");
    git_in(&root.join("battle"), &["worktree", "add", "-q", "--detach", &outside.to_string_lossy()]);
    fs::remove_dir_all(&outside).unwrap();
    // client 中的独立嵌套仓库（未登记为子模块）。
    repo_with_commit(&root.join("client").join(".gdconfig_tmp"), "cfg.json");
    let mut modules = fs::read_to_string(root.join(".gitmodules")).unwrap();
    modules.push_str("[submodule \"evil\"]\n\tpath = ../escape\n[submodule \"abs\"]\n\tpath = C:/Windows\n");
    fs::write(root.join(".gitmodules"), modules).unwrap();
    Fixture { _dir: dir, root, outside }
}

/// refs、index、config 与 HEAD 的指纹（B17：发现与扫描不写任何成员）。
fn fingerprint(repos: &[PathBuf]) -> Vec<String> {
    repos
        .iter()
        .map(|repo| {
            let git_dir = PathBuf::from(git_in(repo, &["rev-parse", "--absolute-git-dir"]));
            let read = |p: PathBuf| fs::read(p).map(|b| hex::encode(Sha256::digest(b))).unwrap_or_default();
            format!(
                "{}|{}|{}|{}|{}",
                git_in(repo, &["for-each-ref", "--format=%(refname) %(objectname)"]),
                read(git_dir.join("index")),
                read(git_dir.join("config")),
                read(git_dir.join("HEAD")),
                git_in(repo, &["status", "--porcelain=v2", "--ignore-submodules=all"]),
            )
        })
        .collect()
}

#[test]
fn b31_discovers_members_worktrees_and_ignores_unsafe_entries() {
    let fx = fixture();
    let repos = vec![fx.root.clone(), fx.root.join("battle"), fx.root.join("client"), fx.root.join("tools")];
    let before = fingerprint(&repos);
    let found = group::discover(gp(), &fx.root, &[]).unwrap();
    assert!(found.is_group);
    let names: Vec<(&str, MemberKind, MemberState)> = found.members.iter().map(|m| (m.name.as_str(), m.kind, m.state)).collect();
    assert_eq!(names[0], ("game-workspace", MemberKind::Superproject, MemberState::Ready));
    let find = |name: &str| found.members.iter().find(|m| m.name == name).unwrap_or_else(|| panic!("缺少成员 {name}：{names:?}"));
    assert_eq!(find("battle").state, MemberState::Ready);
    assert_eq!(find("client").state, MemberState::Ready);
    assert_eq!(find("tools").state, MemberState::Ready);
    assert_eq!(find("audio").state, MemberState::Uninitialized);
    assert!(find("audio").repo_id.is_none());
    // worktree 挂在所属仓库下；目录已删除的标为缺失。
    let battle_id = find("battle").repo_id.clone();
    let r2 = find("battle-r2");
    assert_eq!((r2.kind, r2.state), (MemberKind::Worktree, MemberState::Ready));
    assert_eq!(r2.parent_repo_id, battle_id);
    assert_eq!(r2.relative_path, "battle-r2");
    let missing = find("outside-wt");
    assert_eq!((missing.kind, missing.state), (MemberKind::Worktree, MemberState::Missing));
    assert!(missing.repo_id.is_none());
    // 只列一层：子模块的子模块、未登记的独立嵌套仓库都不在列表中。
    assert!(found.members.iter().all(|m| m.name != "deep" && m.name != ".gdconfig_tmp"), "{names:?}");
    // 记录的指针与子仓库 HEAD。
    let battle = find("battle");
    assert_eq!(battle.recorded_oid.as_deref(), Some(git_in(&fx.root.join("battle"), &["rev-parse", "HEAD"]).as_str()));
    assert_eq!(battle.head_oid, battle.recorded_oid);
    assert_eq!(battle.branch.as_deref(), Some("main"));
    // 不安全的 .gitmodules 条目被忽略并说明原因。
    assert_eq!(found.ignored.len(), 2, "{:?}", found.ignored);
    assert!(found.ignored.iter().any(|i| i.starts_with("evil")));
    assert!(found.ignored.iter().any(|i| i.starts_with("abs")));
    // repoId 与 GitAdapter::open 一致，切换成员时复用同一份快照与状态。
    let adapter = GitAdapter::open(fx.root.join("client").to_string_lossy().into_owned(), None).unwrap();
    assert_eq!(find("client").repo_id.as_deref(), Some(adapter.repo_id()));
    assert_eq!(found.selected_repo_id.as_deref(), found.members[0].repo_id.as_deref());
    assert_eq!(fingerprint(&repos), before, "发现过程不得写入任何成员");
    assert!(!fx.outside.exists());
}

/// 真实工作区中见到的情况：工具在别处创建、与所属仓库同名的 worktree；目录还在但不是完整 worktree（`.git` 缺失，
/// 相当于停在 `locked initializing`）时 Git 会向上找到别的仓库，不能把它当成就绪成员，所属仓库也不能被重复列出。
#[test]
fn b31_incomplete_or_same_named_worktrees_are_not_duplicated() {
    let fx = fixture();
    let base = fx.root.parent().unwrap().to_path_buf();
    let named = base.join("tool-a").join("battle");
    git_in(&fx.root.join("battle"), &["worktree", "add", "-q", "--detach", &named.to_string_lossy()]);
    let broken = fx.root.join("battle-broken");
    git_in(&fx.root.join("battle"), &["worktree", "add", "-q", "--detach", &broken.to_string_lossy()]);
    fs::remove_file(broken.join(".git")).unwrap();
    let found = group::discover(gp(), &fx.root, &[]).unwrap();
    let battle_path = canon(&fx.root.join("battle")).to_string_lossy().into_owned();
    let ready_battles = found.members.iter().filter(|m| m.state == MemberState::Ready && m.worktree_path == battle_path).count();
    assert_eq!(ready_battles, 1, "{:?}", found.members.iter().map(|m| (&m.name, &m.worktree_path, m.state)).collect::<Vec<_>>());
    let same_named = found.members.iter().find(|m| m.name == "tool-a/battle").expect("同名 worktree 带上级目录");
    assert_eq!((same_named.kind, same_named.state), (MemberKind::Worktree, MemberState::Ready));
    let incomplete = found.members.iter().find(|m| m.name == "battle-broken").unwrap();
    assert_eq!(incomplete.state, MemberState::Missing);
    assert!(incomplete.repo_id.is_none());
}

#[test]
fn b31_member_directories_resolve_to_the_owning_workspace() {
    let fx = fixture();
    let root_id = group::discover(gp(), &fx.root, &[]).unwrap().members[0].repo_id.clone();
    // 直接添加子模块目录（及其子目录）、子模块的 worktree：都归属父仓库的工作区并选中自身。
    for (path, name) in [(fx.root.join("battle"), "battle"), (fx.root.join("client"), "client"), (fx.root.join("battle-r2"), "battle-r2")] {
        let found = group::discover(gp(), &path, &[]).unwrap();
        assert!(found.is_group, "{}", path.display());
        assert_eq!(found.members[0].repo_id, root_id);
        let selected = found.members.iter().find(|m| m.repo_id == found.selected_repo_id).unwrap();
        assert_eq!(selected.name, name);
    }
    // 子模块的子模块（初始化后）直接添加时按普通项目处理。
    git_in(&fx.root.join("tools"), &["submodule", "update", "-q", "--init", "deep"]);
    let deep = group::discover(gp(), &fx.root.join("tools").join("deep"), &[]).unwrap();
    assert!(!deep.is_group);
    assert_eq!(deep.members.len(), 1);
    // 独立嵌套仓库本身不是工作区。
    let nested = group::discover(gp(), &fx.root.join("client").join(".gdconfig_tmp"), &[]).unwrap();
    assert!(!nested.is_group);
}

#[test]
fn b31_manual_members_must_be_standalone_repositories_inside_the_workspace() {
    let fx = fixture();
    let nested = fx.root.join("client").join(".gdconfig_tmp").to_string_lossy().into_owned();
    let elsewhere = tempfile::tempdir().unwrap();
    repo_with_commit(elsewhere.path(), "x.txt");
    let manual = vec![nested, elsewhere.path().to_string_lossy().into_owned(), fx.root.join("battle").to_string_lossy().into_owned()];
    let found = group::discover(gp(), &fx.root, &manual).unwrap();
    let manual_members: Vec<_> = found.members.iter().filter(|m| m.kind == MemberKind::Manual).collect();
    assert_eq!(manual_members.len(), 3);
    assert_eq!(manual_members[0].state, MemberState::Ready);
    assert_eq!(manual_members[0].relative_path, "client/.gdconfig_tmp");
    // 工作区外的仓库、已是子模块的目录都不能作为手动成员。
    assert_eq!(manual_members[1].state, MemberState::Invalid);
    assert_eq!(manual_members[2].state, MemberState::Invalid);
}

#[test]
fn b31_repositories_with_only_worktrees_are_not_workspaces() {
    let dir = tempfile::tempdir().unwrap();
    let root = canon(dir.path()).join("plain");
    repo_with_commit(&root, "a.txt");
    git_in(&root, &["worktree", "add", "-q", "--detach", &root.join("wt").to_string_lossy()]);
    let found = group::discover(gp(), &root, &[]).unwrap();
    assert!(!found.is_group);
    assert_eq!(found.members.len(), 1);
}

#[test]
fn b33_pointer_switch_controls_gitlink_rows_and_never_scans_submodule_content() {
    let fx = fixture();
    let battle = fx.root.join("battle");
    fs::write(battle.join("battle.txt"), "two\n").unwrap();
    git_in(&battle, &["commit", "-qam", "move pointer"]);
    fs::write(battle.join("dirty.txt"), "untracked in submodule\n").unwrap();
    fs::write(fx.root.join("client").join("client.txt"), "modified in submodule\n").unwrap();
    // 父仓库自己的改动。
    fs::write(fx.root.join("AGENTS.md"), "changed\n").unwrap();
    let adapter = GitAdapter::open(fx.root.to_string_lossy().into_owned(), None).unwrap();
    let names = |snapshot: &RepositorySnapshot| snapshot.files.iter().map(|f| (f.display_path.clone(), f.gitlink)).collect::<Vec<_>>();
    let off = adapter.snapshot_v2("off".into(), CompareScope::Unstaged, false).unwrap();
    // 关闭：没有任何子模块条目，也不含子模块内部的文件；.gitmodules 被追加过，照常作为父仓库文件显示。
    assert_eq!(names(&off), vec![(".gitmodules".to_owned(), false), ("AGENTS.md".to_owned(), false)]);
    adapter.set_submodule_pointers(true);
    let on = adapter.snapshot_v2("on".into(), CompareScope::Unstaged, false).unwrap();
    // 打开：只有提交指针变化的 battle 一行；client 只有内部改动（dirty），不显示。
    assert_eq!(names(&on), vec![(".gitmodules".to_owned(), false), ("AGENTS.md".to_owned(), false), ("battle".to_owned(), true)]);
    assert_ne!(off.revision, on.revision);
    // 指针行带两侧提交：未暂存为 index 中记录的提交 → 子模块当前 HEAD（只读文件得到，不启动 Git）。
    let pointer = on.files.iter().find(|f| f.display_path == "battle").unwrap().submodule.clone().unwrap();
    assert_eq!(pointer.old.as_deref(), Some(git_in(&fx.root, &["rev-parse", "HEAD:battle"]).as_str()));
    assert_eq!(pointer.new.as_deref(), Some(git_in(&battle, &["rev-parse", "HEAD"]).as_str()));
    assert!(on.files.iter().filter(|f| !f.gitlink).all(|f| f.submodule.is_none()));
    assert_eq!(group::change_count(gp(), &fx.root, false).unwrap(), 2);
    assert_eq!(group::change_count(gp(), &fx.root, true).unwrap(), 3);
    assert_eq!(group::change_count(gp(), &battle, false).unwrap(), 1);
}

#[test]
fn b34_nested_repositories_are_listed_separately_not_as_untracked_files() {
    let fx = fixture();
    fs::write(fx.root.join("notes.txt"), "plain untracked\n").unwrap();
    fs::create_dir_all(fx.root.join("plain-dir")).unwrap();
    fs::write(fx.root.join("plain-dir").join("f.txt"), "x\n").unwrap();
    let adapter = GitAdapter::open(fx.root.to_string_lossy().into_owned(), None).unwrap();
    let snapshot = adapter.snapshot_v2("n".into(), CompareScope::Unstaged, false).unwrap();
    let paths: Vec<&str> = snapshot.files.iter().map(|f| f.display_path.as_str()).collect();
    assert!(paths.contains(&"notes.txt") && paths.contains(&"plain-dir/f.txt"), "{paths:?}");
    assert!(paths.iter().all(|p| !p.starts_with("battle-r2")), "{paths:?}");
    assert_eq!(snapshot.nested_repos, vec!["battle-r2".to_owned()]);
    let all = snapshot.scopes.as_ref().unwrap().all.iter().map(|f| f.display_path.as_str()).collect::<Vec<_>>();
    assert!(all.iter().all(|p| !p.starts_with("battle-r2")));
    // client 中的独立嵌套仓库同样只作说明。
    let client = GitAdapter::open(fx.root.join("client").to_string_lossy().into_owned(), None).unwrap();
    let client_snapshot = client.snapshot_v2("c".into(), CompareScope::Unstaged, false).unwrap();
    assert!(client_snapshot.files.is_empty(), "{:?}", client_snapshot.files.iter().map(|f| &f.display_path).collect::<Vec<_>>());
    assert_eq!(client_snapshot.nested_repos, vec![".gdconfig_tmp".to_owned()]);
}

#[test]
fn b34_history_reports_submodule_pointer_changes() {
    let fx = fixture();
    let battle = fx.root.join("battle");
    let old = git_in(&battle, &["rev-parse", "HEAD"]);
    fs::write(battle.join("battle.txt"), "two\n").unwrap();
    git_in(&battle, &["commit", "-qam", "move pointer"]);
    let new = git_in(&battle, &["rev-parse", "HEAD"]);
    git_in(&fx.root, &["add", "battle", "AGENTS.md"]);
    git_in(&fx.root, &["commit", "-qm", "bump battle"]);
    let head = git_in(&fx.root, &["rev-parse", "HEAD"]);
    let changes = log::commit_changes(gp(), &fx.root, &head, None).unwrap();
    assert_eq!(changes.files.len(), 1);
    let entry = &changes.files[0];
    assert_eq!(entry.path, "battle");
    let pointer = entry.submodule.as_ref().expect("gitlink 条目带指针");
    assert_eq!((pointer.old.as_deref(), pointer.new.as_deref()), (Some(old.as_str()), Some(new.as_str())));
    // 添加子模块的提交：新增的 gitlink 没有旧指针；普通文件没有 submodule 字段。
    let added = git_in(&fx.root, &["rev-parse", "HEAD~1"]);
    let first = log::commit_changes(gp(), &fx.root, &added, None).unwrap();
    let battle_add = first.files.iter().find(|f| f.path == "battle").unwrap();
    assert_eq!(battle_add.submodule.as_ref().unwrap().old, None);
    assert!(first.files.iter().find(|f| f.path == ".gitmodules").unwrap().submodule.is_none());
}
