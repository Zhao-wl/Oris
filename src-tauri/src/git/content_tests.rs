//! 任务 05：内容解码、EOL、无末尾换行、编码失败与特殊文件（A11 / A12）。全部在真实临时仓库中进行，
//! 并断言读取前后仓库不变（只读通道）。
use super::*;

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.autocrlf=false", "-c", "user.name=T05", "-c", "user.email=t05@example.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
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

fn state(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
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
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                entries.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    entries.sort();
    entries
}

fn id(path: &str) -> String {
    URL_SAFE_NO_PAD.encode(path)
}

/// 读取某路径在给定范围内的两侧内容。
fn read(root: &Path, scope: CompareScope, path: &str) -> ContentPair {
    let adapter = GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap();
    let snapshot = adapter.snapshot_for_scope("snap".into(), scope).unwrap();
    assert!(snapshot.files.iter().any(|f| f.display_path == path), "{path} 不在 {scope:?} 范围：{:?}", snapshot.files.iter().map(|f| &f.display_path).collect::<Vec<_>>());
    adapter.read_content_pair_for_scope("read".into(), scope, snapshot.revision, id(path)).unwrap()
}

#[test]
fn a12_unicode_crlf_final_newline_and_encoding_failures_have_explicit_states() {
    let dir = init();
    let root = dir.path();
    write(root, "中文 目录/说明.txt", "第一行\n第二行\n".as_bytes());
    write(root, "crlf.txt", b"one\r\ntwo\r\n");
    write(root, "final.txt", b"a\nb\n");
    write(root, "gbk.txt", b"plain ascii\n");
    write(root, "bom.txt", b"same text\n");
    write(root, "utf16.txt", b"x\n");
    write(root, "bin.dat", b"\x00\x01\x02");
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", "base"]);

    write(root, "中文 目录/说明.txt", "第一行\n第二行（修改）😀\n".as_bytes());
    write(root, "crlf.txt", b"one\ntwo\n");
    write(root, "final.txt", b"a\nb");
    // GBK 编码的“中文”：不是有效 UTF-8，也不含 NUL。
    write(root, "gbk.txt", &[0xD6, 0xD0, 0xCE, 0xC4, b'\n']);
    write(root, "bom.txt", b"\xEF\xBB\xBFsame text\n");
    let mut utf16 = vec![0xFF, 0xFE];
    for unit in "中文 UTF-16\n".encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    write(root, "utf16.txt", &utf16);
    write(root, "bin.dat", b"\x00\x01\x03\x04");
    let before = state(root);

    // Unicode / 中文路径与内容
    let pair = read(root, CompareScope::Unstaged, "中文 目录/说明.txt");
    assert_eq!(pair.display_path, "中文 目录/说明.txt");
    assert_eq!(pair.right.text.as_deref(), Some("第一行\n第二行（修改）😀\n"));
    assert_eq!((pair.left.kind, pair.right.kind), ("text", "text"));
    assert_eq!(pair.right.encoding, "utf-8");

    // CRLF → LF：两侧 EOL 分别标出，文本保持原始换行（界面据 eol 字段给出“换行符变化”说明）
    let pair = read(root, CompareScope::Unstaged, "crlf.txt");
    assert_eq!((pair.left.eol, pair.right.eol), ("crlf", "lf"));
    assert_eq!(pair.left.text.as_deref(), Some("one\r\ntwo\r\n"));
    assert_ne!(pair.left.content_id, pair.right.content_id);

    // 无末尾换行
    let pair = read(root, CompareScope::Unstaged, "final.txt");
    assert_eq!((pair.left.has_final_newline, pair.right.has_final_newline), (Some(true), Some(false)));

    // 不支持的编码：不显示文本，也不当成无变化
    let pair = read(root, CompareScope::Unstaged, "gbk.txt");
    assert_eq!(pair.right.kind, "unsupportedEncoding");
    assert!(pair.right.text.is_none());
    let reason = pair.degradation.clone().unwrap();
    assert!(reason.contains("编码不受支持") && reason.contains("未显示为无差异"), "{reason}");
    assert_eq!(pair.left.kind, "text");

    // UTF-8 BOM：文本相同，BOM 与 contentId 不同
    let pair = read(root, CompareScope::Unstaged, "bom.txt");
    assert_eq!(pair.left.text, pair.right.text);
    assert_eq!((pair.left.bom, pair.right.bom), (false, true));
    assert_ne!(pair.left.content_id, pair.right.content_id);

    // 带 BOM 的 UTF-16 LE 按文本解码
    let pair = read(root, CompareScope::Unstaged, "utf16.txt");
    assert_eq!((pair.right.encoding, pair.right.bom, pair.right.kind), ("utf-16le", true, "text"));
    assert_eq!(pair.right.text.as_deref(), Some("中文 UTF-16\n"));

    // 含 NUL：二进制，保留大小与内容标识
    let pair = read(root, CompareScope::Unstaged, "bin.dat");
    assert_eq!((pair.left.kind, pair.right.kind), ("binary", "binary"));
    assert_eq!((pair.left.byte_length, pair.right.byte_length), (3, 4));
    assert_ne!(pair.left.content_id, pair.right.content_id);
    assert!(pair.degradation.unwrap().contains("二进制"));

    assert_eq!(state(root), before, "读取不修改工作区、index、refs 与 config");
}

#[test]
fn decode_rules_are_strict_and_do_not_guess() {
    let decoded = |bytes: &[u8]| text_side("workingTree", bytes.to_vec(), false);
    // UTF-16 BE
    let mut be = vec![0xFE, 0xFF];
    for unit in "ab\n".encode_utf16() {
        be.extend_from_slice(&unit.to_be_bytes());
    }
    let (side, reason) = decoded(&be);
    assert_eq!((side.encoding, side.text.as_deref(), reason), ("utf-16be", Some("ab\n"), None));
    // 奇数字节的 UTF-16、孤立代理项、BOM 之后的无效 UTF-8 都是不支持的编码
    assert_eq!(decoded(&[0xFF, 0xFE, 0x61]).0.kind, "unsupportedEncoding");
    assert_eq!(decoded(&[0xFF, 0xFE, 0x00, 0xD8, 0x61, 0x00]).0.kind, "unsupportedEncoding");
    assert_eq!(decoded(&[0xEF, 0xBB, 0xBF, 0xFF]).0.kind, "unsupportedEncoding");
    // Latin-1 / Windows-1252 字节不会被当成 UTF-8 猜测
    assert_eq!(decoded(b"caf\xE9\n").0.kind, "unsupportedEncoding");
    // UTF-32 LE BOM（FF FE 00 00）不按 UTF-16 解码：含 NUL，按二进制
    assert_eq!(decoded(&[0xFF, 0xFE, 0, 0, 0x61, 0, 0, 0]).0.kind, "binary");
    // 超预算：明确 tooLarge，不截断
    let (side, reason) = decoded(&vec![b'x'; MAX_TEXT_BYTES + 1]);
    assert_eq!((side.kind, side.text.is_none()), ("tooLarge", true));
    assert!(reason.unwrap().contains("未静默截断"));
    let (side, reason) = decoded(&"y".repeat(MAX_LINE_CHARS + 1).into_bytes());
    assert_eq!((side.kind, side.encoding), ("tooLarge", "utf-8"));
    assert!(reason.unwrap().contains("最长行"));
    // 空文件是存在的空文本，不是缺失
    let (side, _) = decoded(b"");
    assert_eq!((side.kind, side.encoding, side.text.as_deref(), side.eol), ("text", "utf-8", Some(""), "none"));
}

#[test]
fn a11_lfs_pointer_svg_symlink_and_mode_change_are_identified() {
    let dir = init();
    let root = dir.path();
    let oid = "a".repeat(64);
    let pointer = format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12345\n");
    write(root, "model.bin", pointer.as_bytes());
    write(root, "icon.svg", br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>
"#);
    write(root, "tool.sh", b"#!/bin/sh\necho hi\n");
    git(root, &["add", "-A"]);
    // 符号链接以 index 条目形式写入（Windows 上无需创建真实链接）：blob 内容就是目标。
    let target = git_input(root, &["hash-object", "-w", "--stdin"], b"../outside/secret.txt");
    git(root, &["update-index", "--add", "--cacheinfo", &format!("120000,{},link", String::from_utf8_lossy(&target).trim())]);
    git(root, &["commit", "-qm", "base"]);

    let other = format!("version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize 99\n", "b".repeat(64));
    write(root, "model.bin", other.as_bytes());
    write(root, "icon.svg", br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(2)</script></svg>
"#);
    git(root, &["add", "model.bin", "icon.svg"]);
    git(root, &["update-index", "--chmod=+x", "tool.sh"]);
    let retarget = git_input(root, &["hash-object", "-w", "--stdin"], b"docs/readme.md");
    git(root, &["update-index", "--cacheinfo", &format!("120000,{},link", String::from_utf8_lossy(&retarget).trim())]);
    let before = state(root);

    let pair = read(root, CompareScope::Staged, "model.bin");
    assert_eq!((pair.left.kind, pair.right.kind), ("lfsPointer", "lfsPointer"));
    let details = pair.right.details.as_ref().unwrap();
    assert_eq!((details.lfs_oid.as_deref(), details.lfs_size, details.lfs_local), (Some("b".repeat(64).as_str()), Some(99), Some(false)));
    assert!(pair.right.text.as_deref().unwrap().starts_with("version https://git-lfs"), "指针文本照常显示");

    // SVG 只作为文本读取（界面按文本阅读，不渲染、不执行脚本）
    let pair = read(root, CompareScope::Staged, "icon.svg");
    assert_eq!(pair.right.kind, "text");
    assert!(pair.right.text.unwrap().contains("<script>alert(2)"));

    // 仅 mode 变化：文本相同、mode 不同
    let pair = read(root, CompareScope::Staged, "tool.sh");
    assert_eq!(pair.left.text, pair.right.text);
    let modes = (pair.left.details.as_ref().unwrap().mode.clone(), pair.right.details.as_ref().unwrap().mode.clone());
    assert_eq!(modes, (Some("100644".into()), Some("100755".into())));

    // 符号链接：显示目标，不跟随
    let pair = read(root, CompareScope::Staged, "link");
    assert_eq!((pair.left.kind, pair.right.kind), ("symlink", "symlink"));
    assert_eq!(pair.left.details.as_ref().unwrap().link_target.as_deref(), Some("../outside/secret.txt"));
    assert_eq!(pair.right.details.as_ref().unwrap().link_target.as_deref(), Some("docs/readme.md"));
    assert!(pair.left.text.is_none() && pair.right.text.is_none());

    assert_eq!(state(root), before);
}

#[test]
fn a11_submodule_gitlink_shows_commits_without_initializing() {
    let upstream = init();
    write(upstream.path(), "lib.txt", b"v1\n");
    git(upstream.path(), &["add", "-A"]);
    git(upstream.path(), &["commit", "-qm", "v1"]);
    let first = String::from_utf8(git(upstream.path(), &["rev-parse", "HEAD"])).unwrap().trim().to_owned();
    write(upstream.path(), "lib.txt", b"v2\n");
    git(upstream.path(), &["commit", "-qam", "v2"]);
    let second = String::from_utf8(git(upstream.path(), &["rev-parse", "HEAD"])).unwrap().trim().to_owned();

    let dir = init();
    let root = dir.path();
    write(root, "readme.md", b"super\n");
    git(root, &["add", "-A"]);
    // 已初始化的子模块：先克隆到 sub，再以 gitlink 记录第一个提交
    git(root, &["clone", "-q", &upstream.path().to_string_lossy(), "sub"]);
    git(&root.join("sub"), &["checkout", "-q", &first]);
    git(root, &["add", "sub"]);
    // 未初始化的子模块：只有 gitlink 条目与空目录
    git(root, &["update-index", "--add", "--cacheinfo", &format!("160000,{first},empty")]);
    fs::create_dir_all(root.join("empty")).unwrap();
    git(root, &["commit", "-qm", "gitlinks"]);
    // 子模块工作区移动到第二个提交并留下未跟踪文件
    git(&root.join("sub"), &["checkout", "-q", &second]);
    write(&root.join("sub"), "scratch.txt", b"untracked\n");
    // 未初始化子模块在 index 中被改为指向第二个提交
    git(root, &["update-index", "--cacheinfo", &format!("160000,{second},empty")]);
    let before = state(root);

    let pair = read(root, CompareScope::Unstaged, "sub");
    assert_eq!((pair.left.kind, pair.right.kind), ("gitlink", "gitlink"));
    let left = pair.left.details.as_ref().unwrap().submodule.as_ref().unwrap();
    let right = pair.right.details.as_ref().unwrap().submodule.as_ref().unwrap();
    assert_eq!(left.commit.as_deref(), Some(first.as_str()));
    assert_eq!(right.commit.as_deref(), Some(second.as_str()));
    assert_eq!(right.initialized, Some(true));
    assert!(right.commit_changed && right.untracked_changes, "status v2 的子模块标志");
    assert!(pair.left.text.is_none() && pair.right.text.is_none());

    let pair = read(root, CompareScope::Staged, "empty");
    assert_eq!((pair.left.kind, pair.right.kind), ("gitlink", "gitlink"));
    assert_eq!(pair.left.details.as_ref().unwrap().submodule.as_ref().unwrap().commit.as_deref(), Some(first.as_str()));
    assert_eq!(pair.right.details.as_ref().unwrap().submodule.as_ref().unwrap().commit.as_deref(), Some(second.as_str()));

    assert_eq!(state(root), before, "不初始化子模块、不改动任何文件");
    assert!(!root.join("empty/.git").exists());
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
