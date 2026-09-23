//! V2-01 验收测试：B01 / B02 / B17 / B18 与资源上限。全部在真实临时仓库中进行。
use super::object_reader::{self, BlobCache, DEFAULT_CACHE_BYTES, MAX_CACHED_BLOB_BYTES, MAX_LIVE_READERS};
use super::*;
use std::time::Duration;

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.autocrlf=false", "-c", "user.name=V2", "-c", "user.email=v2@example.invalid", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    output.stdout
}

fn git_input(root: &Path, args: &[&str], input: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    output.stdout
}

fn init() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    dir
}

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn adapter(root: &Path) -> GitAdapter {
    GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap()
}

type Row = (String, String, Option<String>);
fn rows(files: &[FileChange]) -> Vec<Row> {
    let mut rows: Vec<Row> = files
        .iter()
        .map(|f| (f.path_id.clone(), format!("{:?}", f.status), f.old_path_id.clone()))
        .collect();
    rows.sort();
    rows
}

/// B01：同一仓库状态下，V2 一次 status（+ 后台修正）得到的三个范围与 V1 逐命令结果逐项一致。
fn assert_matches_v1(root: &Path, label: &str) {
    let adapter = adapter(root);
    for scope in [CompareScope::Unstaged, CompareScope::Staged, CompareScope::All] {
        let v1 = adapter.snapshot_for_scope_v1(format!("{label}-v1"), scope).unwrap();
        let v2 = adapter.snapshot_for_scope(format!("{label}-v2"), scope).unwrap();
        assert_eq!(rows(&v2.files), rows(&v1.files), "{label} {scope:?}");
        // 统计：V1 有值的条目 V2 也一致（后台补齐后）。
        let stats = |files: &[FileChange]| {
            let mut s: Vec<_> = files.iter().map(|f| (f.path_id.clone(), f.additions, f.deletions)).collect();
            s.sort();
            s
        };
        assert_eq!(stats(&v2.files), stats(&v1.files), "{label} {scope:?} stats");
    }
}

fn manifest(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_path_buf();
            if rel.starts_with(".git/objects") || rel.starts_with(".git/logs") {
                continue;
            }
            if entry.file_type().unwrap().is_dir() {
                stack.push(path);
            } else {
                entries.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    entries.sort();
    entries
}

#[test]
fn b01_mixed_changes_special_paths_renames_and_conflicts_match_v1() {
    let dir = init();
    let p = dir.path();
    for (rel, text) in [
        ("keep.txt", "keep\n"),
        ("modify unstaged.txt", "base\n"),
        ("staged.txt", "base\n"),
        ("both.txt", "base\n"),
        ("delete staged.txt", "gone\n"),
        ("delete unstaged.txt", "gone\n"),
        ("rename old 中文 #.txt", "rename me please, enough content to be similar\n"),
        ("dir/[x] bracket.txt", "x\n"),
        ("conflict.txt", "base\n"),
    ] {
        write(p, rel, text.as_bytes());
    }
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    // 冲突：真实 merge。
    git(p, &["switch", "-qc", "side"]);
    write(p, "conflict.txt", b"side\n");
    git(p, &["commit", "-qam", "side"]);
    git(p, &["switch", "-q", "main"]);
    write(p, "conflict.txt", b"main\n");
    git(p, &["commit", "-qam", "main"]);
    let merge = Command::new("git").arg("-C").arg(p).args(["merge", "side"]).output().unwrap();
    assert!(!merge.status.success());
    write(p, "modify unstaged.txt", b"changed\n");
    write(p, "staged.txt", b"staged\n");
    write(p, "both.txt", b"index\n");
    git(p, &["add", "staged.txt", "both.txt"]);
    write(p, "both.txt", b"worktree\n");
    git(p, &["rm", "-q", "delete staged.txt"]);
    fs::remove_file(p.join("delete unstaged.txt")).unwrap();
    git(p, &["mv", "rename old 中文 #.txt", "renamed 新 名.txt"]);
    write(p, "untracked space.txt", b"u1\nu2\n");
    write(p, "dir/[x] bracket.txt", b"y\n");
    assert_matches_v1(p, "mixed");
}

#[test]
fn b01_worktree_only_renames_empty_head_and_cancelled_layers_match_v1() {
    // 仅工作区 rename：未暂存删除 + 未跟踪新增（两个版本都显示 D + ?），以及未暂存删除 + 暂存新增（“全部”范围配对为 rename）。
    let dir = init();
    let p = dir.path();
    let body = b"line one of a long enough body\nline two\nline three\nline four\n";
    // a 与 b 内容不同，避免 rename 配对出现歧义（相同内容时 Git 可把任一删除配给新路径）。
    write(p, "a.txt", b"alpha one\nalpha two\nalpha three\nalpha four\n");
    write(p, "b.txt", body);
    write(p, "c.txt", b"head\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    fs::rename(p.join("a.txt"), p.join("a-moved.txt")).unwrap();
    fs::remove_file(p.join("b.txt")).unwrap();
    write(p, "b-staged.txt", body);
    git(p, &["add", "b-staged.txt"]);
    // 双层修改且工作区回到 HEAD：HEAD → 工作区无变化。
    write(p, "c.txt", b"index\n");
    git(p, &["add", "c.txt"]);
    write(p, "c.txt", b"head\n");
    assert_matches_v1(p, "worktree-renames");
    let all = adapter(p).snapshot_for_scope("all".into(), CompareScope::All).unwrap();
    assert!(all.files.iter().any(|f| f.display_path == "b-staged.txt" && matches!(f.status, FileStatus::Renamed) && f.old_display_path.as_deref() == Some("b.txt")));
    assert!(!all.files.iter().any(|f| f.display_path == "c.txt"));
    // 暂存 rename 后工作区又删除新路径。
    let dir = init();
    let p = dir.path();
    write(p, "old.txt", body);
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    git(p, &["mv", "old.txt", "new.txt"]);
    fs::remove_file(p.join("new.txt")).unwrap();
    assert_matches_v1(p, "rename-then-delete");
    // 空 HEAD：暂存、未跟踪、暂存后工作区删除。
    let empty = init();
    let p = empty.path();
    write(p, "first.txt", b"first\n");
    write(p, "gone.txt", b"gone\n");
    git(p, &["add", "-A"]);
    fs::remove_file(p.join("gone.txt")).unwrap();
    write(p, "loose.txt", b"loose\n");
    assert_matches_v1(p, "unborn");
}

#[test]
fn b01_non_utf8_index_path_and_external_operations_match_v1() {
    let dir = init();
    let p = dir.path();
    write(p, "seed.txt", b"seed\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "seed"]);
    let oid = String::from_utf8(git_input(p, &["hash-object", "-w", "--stdin"], b"content")).unwrap();
    let mut input = format!("100644 {} 0\t", oid.trim()).into_bytes();
    input.extend_from_slice(b"odd\xff name\0");
    git_input(p, &["update-index", "-z", "--index-info"], &input);
    let state = adapter(p).snapshot_for_scope("odd".into(), CompareScope::Staged).unwrap();
    assert!(state.files.iter().any(|f| URL_SAFE_NO_PAD.decode(&f.path_id).unwrap() == b"odd\xff name"));
    assert_matches_v1(p, "non-utf8");
    // B03 后端部分：关闭期间的外部修改 / 暂存 / 提交 / 切换分支后，重新扫描与 V1 一致。
    let dir = init();
    let p = dir.path();
    write(p, "file.txt", b"one\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "one"]);
    let before = adapter(p).snapshot_for_scope("before".into(), CompareScope::All).unwrap();
    write(p, "file.txt", b"two\n");
    git(p, &["add", "file.txt"]);
    git(p, &["commit", "-qm", "two"]);
    git(p, &["switch", "-qc", "topic"]);
    write(p, "file.txt", b"three\n");
    let after = adapter(p).snapshot_for_scope("after".into(), CompareScope::All).unwrap();
    assert_ne!(before.revision, after.revision);
    assert_eq!(after.repo.branch, "topic");
    assert_matches_v1(p, "after-external");
}

#[test]
fn b01_revision_covers_repeated_worktree_edits_and_is_shared_by_scopes() {
    let dir = init();
    let p = dir.path();
    write(p, "file.txt", b"one\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "one"]);
    write(p, "file.txt", b"two\n");
    let a = adapter(p);
    let first = a.snapshot_v2("1".into(), CompareScope::Unstaged, false).unwrap();
    let staged = a.snapshot_v2("2".into(), CompareScope::Staged, false).unwrap();
    assert_eq!(first.revision, staged.revision, "三个范围共享一个 revision");
    std::thread::sleep(Duration::from_millis(20));
    write(p, "file.txt", b"three, a different size\n");
    let second = a.snapshot_v2("3".into(), CompareScope::Unstaged, false).unwrap();
    assert_ne!(first.revision, second.revision, "已修改文件再次被改写时 revision 必须变化");
    assert!(!first.stats_ready);
    let details = a.details(&second.revision).unwrap();
    assert_eq!(details.stats.unstaged, vec![(URL_SAFE_NO_PAD.encode("file.txt"), Some(1), Some(1))]);
    let branch = first.branch_info.unwrap();
    assert_eq!(branch.head.as_deref(), Some("main"));
    assert!(branch.upstream.is_none() && branch.ahead.is_none());
    assert!(!first.in_progress.unwrap().merge);
}

fn text_identity(side: &TextSide) -> (String, Option<String>, usize, &'static str, &'static str, Option<bool>, String, Option<String>, Option<String>, Option<String>, Option<Vec<u8>>) {
    let details = side.details.as_ref();
    (
        side.endpoint.to_owned(),
        side.text.clone(),
        side.byte_length,
        side.encoding,
        side.eol,
        side.has_final_newline,
        side.content_id.clone(),
        details.map(|d| d.state.to_owned()),
        details.and_then(|d| d.oid.clone()),
        details.and_then(|d| d.reason.clone()),
        details.and_then(|d| d.image.as_ref().map(|i| i.raw.clone())),
    )
}

/// B02：按 OID 读取的结果与 V1 读取路径逐字节一致（文本、图片、缺失、冲突 stage、rename 原路径）。
#[test]
fn b02_oid_reads_match_v1_bytes_for_every_file_and_scope() {
    let dir = init();
    let p = dir.path();
    let png = {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(3, 2, image::Rgba([1, 2, 3, 255])))
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    };
    write(p, "text.txt", b"a\r\nb\r\n");
    write(p, "img.png", &png);
    write(p, "bin.dat", b"\0\x01\x02");
    write(p, "old name.txt", b"some content that will be renamed\nmore lines\n");
    write(p, "conflict.txt", b"base\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    git(p, &["switch", "-qc", "side"]);
    write(p, "conflict.txt", b"side\n");
    git(p, &["commit", "-qam", "side"]);
    git(p, &["switch", "-q", "main"]);
    write(p, "conflict.txt", b"main\n");
    git(p, &["commit", "-qam", "main"]);
    assert!(!Command::new("git").arg("-C").arg(p).args(["merge", "side"]).output().unwrap().status.success());
    write(p, "text.txt", b"a\nb\nc");
    git(p, &["add", "text.txt"]);
    write(p, "text.txt", b"worktree only\n");
    write(p, "bin.dat", b"\0\x09");
    git(p, &["mv", "old name.txt", "new name.txt"]);
    write(p, "untracked.txt", "新文件\n".as_bytes());
    let mut changed_png = png.clone();
    changed_png.truncate(png.len() / 2);
    write(p, "img.png", &changed_png);
    let a = adapter(p);
    let mut compared = 0;
    for scope in [CompareScope::Unstaged, CompareScope::Staged, CompareScope::All] {
        let v1 = a.snapshot_for_scope_v1("v1".into(), scope).unwrap();
        let v2 = a.snapshot_for_scope("v2".into(), scope).unwrap();
        for file in &v2.files {
            let versions: Vec<Option<[ConflictVersion; 2]>> = if matches!(file.status, FileStatus::Conflicted) {
                vec![
                    None,
                    Some([ConflictVersion::Stage1, ConflictVersion::WorkingTree]),
                    Some([ConflictVersion::Stage3, ConflictVersion::Stage2]),
                ]
            } else {
                vec![None]
            };
            for version in versions {
                let new = a
                    .read_content_pair_versions("n".into(), scope, v2.revision.clone(), file.path_id.clone(), version)
                    .unwrap();
                let old = a
                    .read_content_pair_v1("o".into(), scope, v1.revision.clone(), file.path_id.clone(), version)
                    .unwrap();
                assert_eq!(text_identity(&new.left), text_identity(&old.left), "{scope:?} {} left", file.display_path);
                assert_eq!(text_identity(&new.right), text_identity(&old.right), "{scope:?} {} right", file.display_path);
                assert_eq!(new.degradation, old.degradation);
                compared += 1;
            }
        }
    }
    assert!(compared >= 14, "compared {compared}");
}

/// B02：Git 操作之后，未变化文件的对象仍命中缓存（不启动 cat-file）；cat-file 异常退出后恢复一次。
#[test]
fn b02_cache_survives_git_operations_and_cat_file_recovers_once() {
    let dir = init();
    let p = dir.path();
    write(p, "stable.txt", b"stable head\n");
    write(p, "other.txt", b"other\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    write(p, "stable.txt", b"stable index\n");
    git(p, &["add", "stable.txt"]);
    write(p, "stable.txt", b"stable worktree\n");
    let a = adapter(p);
    let first = a.snapshot_for_scope("1".into(), CompareScope::All).unwrap();
    let id = URL_SAFE_NO_PAD.encode("stable.txt");
    let pair = a.read_content_pair_for_scope("r".into(), CompareScope::All, first.revision.clone(), id.clone()).unwrap();
    assert_eq!(pair.left.text.as_deref(), Some("stable head\n"));
    // 外部 Git 操作改变 revision（暂存另一个文件），但 stable.txt 的 HEAD 对象不变。
    write(p, "other.txt", b"other changed\n");
    git(p, &["add", "other.txt"]);
    let second = a.snapshot_for_scope("2".into(), CompareScope::All).unwrap();
    assert_ne!(first.revision, second.revision);
    a.reader.with(|reader| reader.release());
    assert!(!a.reader.is_live());
    let again = a.read_content_pair_for_scope("r2".into(), CompareScope::All, second.revision.clone(), id.clone()).unwrap();
    assert_eq!(again.left.content_id, pair.left.content_id);
    assert!(!a.reader.is_live(), "未变化对象应命中 BlobCache，不启动 cat-file");
    // 异常退出恢复：杀掉常驻进程后读取未缓存对象仍成功（自动重启一次）。
    let staged = a
        .read_content_pair_for_scope("s".into(), CompareScope::Staged, second.revision.clone(), URL_SAFE_NO_PAD.encode("other.txt"))
        .unwrap();
    assert_eq!(staged.right.text.as_deref(), Some("other changed\n"));
    a.reader.with(|reader| reader.kill_for_test());
    write(p, "fresh.txt", b"fresh content for a new object\n");
    git(p, &["add", "fresh.txt"]);
    let third = a.snapshot_for_scope("3".into(), CompareScope::Staged).unwrap();
    let fresh = a
        .read_content_pair_for_scope("f".into(), CompareScope::Staged, third.revision, URL_SAFE_NO_PAD.encode("fresh.txt"))
        .unwrap();
    assert_eq!(fresh.right.text.as_deref(), Some("fresh content for a new object\n"));
    a.close();
    assert!(!a.reader.is_live());
}

/// B17：stat 信息过期时，浏览路径（扫描、统计、读取、预取检查）不改写 index / refs / config / 工作区；
/// 只有手动刷新（refresh_index=true）才回写 index 的 stat 缓存。
#[test]
fn b17_readonly_paths_never_write_index_and_manual_refresh_is_the_only_writeback() {
    let dir = init();
    let p = dir.path();
    for i in 0..300 {
        write(p, &format!("files/{i:03}.txt"), format!("file {i}\n").as_bytes());
    }
    write(p, "change.txt", b"base\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    write(p, "change.txt", b"changed\n");
    write(p, "new.txt", b"new\n");
    std::thread::sleep(Duration::from_millis(1100));
    // 只改 mtime、不改内容：index 中的 stat 信息全部过期。
    for i in 0..300 {
        let path = p.join(format!("files/{i:03}.txt"));
        let bytes = fs::read(&path).unwrap();
        fs::write(&path, bytes).unwrap();
    }
    let before = manifest(p);
    let a = adapter(p);
    for scope in [CompareScope::Unstaged, CompareScope::Staged, CompareScope::All] {
        let snap = a.snapshot_v2("s".into(), scope, false).unwrap();
        let details = a.details(&snap.revision).unwrap();
        assert!(!details.all.is_empty());
        for file in &snap.files {
            let _ = a.prefetch_allowed(scope, &snap.revision, &file.path_id, PREFETCH_LIMIT).unwrap();
            let _ = a.read_content_pair_for_scope("r".into(), scope, snap.revision.clone(), file.path_id.clone()).unwrap();
        }
    }
    assert_eq!(before, manifest(p), "只读路径改写了仓库文件（含 .git/index）");
    // 手动刷新：允许回写 stat 缓存，index 发生变化但内容语义不变。
    let refreshed = a.snapshot_v2("manual".into(), CompareScope::Unstaged, true).unwrap();
    let after = manifest(p);
    let index_changed = before.iter().find(|(path, _)| path == Path::new(".git/index")) != after.iter().find(|(path, _)| path == Path::new(".git/index"));
    assert!(index_changed, "手动刷新应回写 index stat 缓存");
    let changed: Vec<_> = before.iter().zip(after.iter()).filter(|(x, y)| x != y).map(|(x, _)| x.0.clone()).collect();
    assert_eq!(changed, vec![PathBuf::from(".git/index")]);
    let plain = a.snapshot_v2("plain".into(), CompareScope::Unstaged, false).unwrap();
    assert_eq!(rows(&plain.files), rows(&refreshed.files));
    assert_eq!(plain.revision, refreshed.revision, "stat 回写不应改变 revision");
}

/// B18：只读通道上的 V2 路径不执行 external diff / textconv / fsmonitor 命令；前端提供的 pathId 不能变成参数。
#[test]
fn b18_malicious_config_is_not_executed_on_v2_paths() {
    let dir = init();
    let p = dir.path();
    write(p, ".gitattributes", b"*.ts diff=evil\n");
    write(p, "code.ts", b"old\n");
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    write(p, "code.ts", b"new\n");
    git(p, &["add", "code.ts"]);
    write(p, "code.ts", b"newer\n");
    let extension = if cfg!(windows) { "cmd" } else { "sh" };
    let mut markers = Vec::new();
    for key in ["diff.external", "core.fsmonitor", "diff.evil.textconv", "diff.evil.command"] {
        let marker = p.join(format!("{}.marker", key.replace('.', "-")));
        let script = p.join(format!("{}.{extension}", key.replace('.', "-")));
        if cfg!(windows) {
            fs::write(&script, format!("@echo off\r\necho ran> \"{}\"\r\n", marker.display())).unwrap();
        } else {
            fs::write(&script, format!("#!/bin/sh\necho ran > '{}'\n", marker.display())).unwrap();
            let _ = Command::new("chmod").arg("+x").arg(&script).status();
        }
        git(p, &["config", key, &script.to_string_lossy()]);
        markers.push(marker);
    }
    let a = adapter(p);
    for scope in [CompareScope::Unstaged, CompareScope::Staged, CompareScope::All] {
        let snap = a.snapshot_v2("s".into(), scope, false).unwrap();
        a.details(&snap.revision).unwrap();
        for file in &snap.files {
            let _ = a.read_content_pair_for_scope("r".into(), scope, snap.revision.clone(), file.path_id.clone());
        }
        let _ = a.snapshot_v2("m".into(), scope, true).unwrap();
    }
    for marker in &markers {
        assert!(!marker.exists(), "外部命令被执行：{}", marker.display());
    }
    let snap = a.snapshot_v2("x".into(), CompareScope::All, false).unwrap();
    for hostile in ["../outside.txt", "--output=pwned", "-c core.pager=evil"] {
        let result = a.read_content_pair_for_scope("h".into(), CompareScope::All, snap.revision.clone(), URL_SAFE_NO_PAD.encode(hostile));
        assert!(matches!(result, Err(GitError::UnsafePath | GitError::StaleRequest)), "{hostile}: {result:?}");
    }
    assert!(!p.join("pwned").exists());
}

/// 资源上限（技术方案 §7）：常驻 cat-file 全局 ≤ 5 且空闲回收；BlobCache 32 MiB、单对象 4 MiB 不进缓存。
#[test]
fn resource_limits_cat_file_pool_idle_reaping_and_blob_cache_budget() {
    let repos: Vec<_> = (0..7)
        .map(|i| {
            let dir = init();
            write(dir.path(), "f.txt", format!("unique content {i} {:?}\n", std::time::SystemTime::now()).as_bytes());
            git(dir.path(), &["add", "-A"]);
            git(dir.path(), &["commit", "-qm", "c"]);
            dir
        })
        .collect();
    let readers: Vec<_> = repos
        .iter()
        .map(|dir| {
            let oid = String::from_utf8(git(dir.path(), &["rev-parse", "HEAD:f.txt"])).unwrap().trim().to_owned();
            (object_reader::shared_reader(Path::new("git"), dir.path(), Duration::from_millis(200)), oid)
        })
        .collect();
    for (reader, oid) in &readers {
        reader.with(|r| r.release());
        let bytes = reader.with(|r| r.read_blob_limited(oid, 1024)).unwrap();
        assert!(matches!(bytes, object_reader::BlobRead::Bytes(_)));
        let own_live = readers.iter().filter(|(r, _)| r.is_live()).count();
        assert!(own_live <= MAX_LIVE_READERS, "live {own_live}");
    }
    std::thread::sleep(Duration::from_millis(300));
    object_reader::expire_idle_readers();
    assert_eq!(readers.iter().filter(|(r, _)| r.is_live()).count(), 0, "空闲进程应被回收");
    // 超过上限的对象只报告大小，不进入内存。
    let big = init();
    write(big.path(), "big.bin", &vec![7u8; 6 * 1024 * 1024]);
    git(big.path(), &["add", "-A"]);
    git(big.path(), &["commit", "-qm", "big"]);
    let oid = String::from_utf8(git(big.path(), &["rev-parse", "HEAD:big.bin"])).unwrap().trim().to_owned();
    let reader = object_reader::shared_reader(Path::new("git"), big.path(), Duration::from_secs(5));
    assert!(matches!(reader.with(|r| r.read_blob_limited(&oid, 1024 * 1024)).unwrap(), object_reader::BlobRead::TooLarge(n) if n == 6 * 1024 * 1024));
    // 超限对象被丢弃后，同一进程的批处理流仍保持同步，可继续读取。
    write(big.path(), "small.txt", b"small
");
    git(big.path(), &["add", "-A"]);
    git(big.path(), &["commit", "-qm", "small"]);
    let small = String::from_utf8(git(big.path(), &["rev-parse", "HEAD:small.txt"])).unwrap().trim().to_owned();
    assert!(matches!(reader.with(|r| r.read_blob_limited(&small, 1024)).unwrap(), object_reader::BlobRead::Bytes(b) if &*b == b"small
"));
    reader.close();
    let mut cache = BlobCache::new(DEFAULT_CACHE_BYTES);
    for i in 0..40 {
        cache.insert(format!("{i:040}"), Arc::from(vec![0u8; 1024 * 1024]));
        assert!(cache.stats().bytes <= DEFAULT_CACHE_BYTES);
    }
    assert_eq!(cache.stats().bytes, 32 * 1024 * 1024);
    cache.insert("f".repeat(40), Arc::from(vec![0u8; MAX_CACHED_BLOB_BYTES + 1]));
    assert!(cache.get(&"f".repeat(40)).is_none());
}

/// B02：大内容以二进制帧传输：文本与图片字节不经 JSON 转义 / base64，解码后与原内容逐字节一致。
#[test]
fn b02_binary_frame_carries_text_and_image_bytes_verbatim() {
    let dir = init();
    let p = dir.path();
    let png = {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(2, 2, image::Rgba([9, 8, 7, 255])))
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    };
    let text = "引号\"与反斜杠\\ 和换行\r\n".repeat(2000);
    write(p, "t.txt", b"old\n");
    write(p, "i.png", &png);
    git(p, &["add", "-A"]);
    git(p, &["commit", "-qm", "base"]);
    write(p, "t.txt", text.as_bytes());
    let a = adapter(p);
    let snap = a.snapshot_for_scope("s".into(), CompareScope::Unstaged).unwrap();
    let text_pair = a.read_content_pair_for_scope("t".into(), CompareScope::Unstaged, snap.revision.clone(), URL_SAFE_NO_PAD.encode("t.txt")).unwrap();
    let frame = text_pair.encode_frame();
    assert_eq!(&frame[..4], b"ORC1");
    let header_len = u32::from_le_bytes(frame[4..8].try_into().unwrap()) as usize;
    let header: serde_json::Value = serde_json::from_slice(&frame[8..8 + header_len]).unwrap();
    let payload = &frame[8 + header_len..];
    let range = header["textRanges"][1].as_array().unwrap();
    let (start, len) = (range[0].as_u64().unwrap() as usize, range[1].as_u64().unwrap() as usize);
    assert_eq!(&payload[start..start + len], text.as_bytes());
    assert!(header["pair"]["right"]["text"].is_null(), "文本不应再出现在 JSON 头中");
    assert!(frame.len() < text.len() + 4096, "帧大小应接近原文字节数（无转义膨胀）");
    let image_repo = init();
    let q = image_repo.path();
    write(q, "i.png", &png);
    git(q, &["add", "-A"]);
    let unborn = adapter(q);
    let staged = unborn.snapshot_for_scope("i".into(), CompareScope::Staged).unwrap();
    let image_pair = unborn.read_content_pair_for_scope("i".into(), CompareScope::Staged, staged.revision, URL_SAFE_NO_PAD.encode("i.png")).unwrap();
    let frame = image_pair.encode_frame();
    let header_len = u32::from_le_bytes(frame[4..8].try_into().unwrap()) as usize;
    let header: serde_json::Value = serde_json::from_slice(&frame[8..8 + header_len]).unwrap();
    let range = header["imageRanges"][1].as_array().unwrap();
    let (start, len) = (range[0].as_u64().unwrap() as usize, range[1].as_u64().unwrap() as usize);
    assert_eq!(&frame[8 + header_len + start..8 + header_len + start + len], png.as_slice());
    assert_eq!(header["pair"]["right"]["details"]["image"]["base64"], "");
}

/// 常驻 cat-file 不附带 conhost.exe（Windows）：避免每个常驻读取器额外约 11 MiB 的控制台宿主进程。
#[cfg(windows)]
#[test]
fn resident_cat_file_has_no_console_host() {
    let dir = init();
    write(dir.path(), "f.txt", b"x\n");
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-qm", "c"]);
    let oid = String::from_utf8(git(dir.path(), &["rev-parse", "HEAD:f.txt"])).unwrap().trim().to_owned();
    let reader = object_reader::shared_reader(Path::new("git"), dir.path(), Duration::from_secs(30));
    reader.with(|r| r.read_blob(&oid)).unwrap();
    let pid = reader.with(|r| r.child_pid_for_test()).unwrap();
    let query = format!("@(Get-CimInstance Win32_Process -Filter \"ParentProcessId={pid} AND Name='conhost.exe'\").Count");
    let output = Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &query]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    reader.close();
}
