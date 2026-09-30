//! 在系统文件管理器中显示工作区内的文件或目录（文件列表右键菜单）。

use crate::git::{validate_relative, GitError};
use std::path::{Path, PathBuf};

/// 要显示的目标：已存在的文件在其所在目录中选中；目录直接打开。
#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    Select(PathBuf),
    Open(PathBuf),
}

/// 把 `/` 分隔的仓库相对路径解析为显示目标（空串为仓库根目录）。
/// 路径已不存在（如已删除的文件）时回退到最近的仍存在的上级目录，最远到仓库根目录。
pub fn target(worktree: &Path, relative: &str) -> Result<Target, GitError> {
    let relative = relative.trim_end_matches('/');
    let mut full = worktree.to_path_buf();
    if !relative.is_empty() {
        validate_relative(relative)?;
        full.extend(relative.split('/'));
    }
    if full.is_file() {
        return Ok(Target::Select(full));
    }
    while !full.is_dir() && full != worktree {
        full.pop();
    }
    Ok(Target::Open(full))
}

pub fn open(target: &Target) -> Result<(), String> {
    use std::process::Command;
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        // explorer 自行解析参数：/select, 后的路径需单独加引号（Windows 路径不含引号字符）。
        match target {
            Target::Select(path) => Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.display())).spawn(),
            Target::Open(path) => Command::new("explorer").arg(path).spawn(),
        }
    };
    #[cfg(target_os = "macos")]
    let result = match target {
        Target::Select(path) => Command::new("open").arg("-R").arg(path).spawn(),
        Target::Open(path) => Command::new("open").arg(path).spawn(),
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = match target {
        Target::Select(path) => Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn(),
        Target::Open(path) => Command::new("xdg-open").arg(path).spawn(),
    };
    result.map(|_| ()).map_err(|e| format!("无法打开文件管理器：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_files_directories_and_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/c.txt"), "x").unwrap();
        assert_eq!(target(root, "a/b/c.txt").unwrap(), Target::Select(root.join("a").join("b").join("c.txt")));
        assert_eq!(target(root, "a/b").unwrap(), Target::Open(root.join("a").join("b")));
        assert_eq!(target(root, "a/b/").unwrap(), Target::Open(root.join("a").join("b")));
        assert_eq!(target(root, "a/gone/deleted.txt").unwrap(), Target::Open(root.join("a")));
        assert_eq!(target(root, "missing").unwrap(), Target::Open(root.to_path_buf()));
        assert_eq!(target(root, "").unwrap(), Target::Open(root.to_path_buf()));
    }

    #[test]
    fn rejects_paths_outside_the_worktree() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../x", "a/../../x", "/etc", "C:/Windows"] {
            assert!(target(dir.path(), bad).is_err(), "{bad}");
        }
    }
}
