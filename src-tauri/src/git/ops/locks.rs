//! 残留锁文件（V2-D65）：拉取前发现 `index.lock`，或获取 / 拉取 / 推送时 Git 报告锁文件已存在，
//! 由界面二次确认后删除锁文件再重试。Oris 从不自动删除、也不自动重试；删除只接受仓库 Git 目录
//! （含共享的 common dir）内、以 `.lock` 结尾的普通文件，并且同样要先拿到仓库写锁。
use super::*;

/// 一次最多删除的锁文件数（Git 一次失败只会报告少量锁）。
const MAX_LOCKS: usize = 32;

/// Git 输出中“已存在”的锁文件：`Unable to create '<path>.lock': File exists`（去重，保持出现顺序）。
pub(super) fn reported_locks(text: &str) -> Vec<String> {
    const HEAD: &str = "Unable to create '";
    let mut paths: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some(start) = line.find(HEAD) else { continue };
        let rest = &line[start + HEAD.len()..];
        let Some(end) = rest.find("': File exists") else { continue };
        let path = &rest[..end];
        if path.ends_with(".lock") && !paths.iter().any(|p| p == path) && paths.len() < MAX_LOCKS {
            paths.push(path.to_owned());
        }
    }
    paths
}

/// “多久之前修改”：只用于确认框里帮助判断锁是否残留。
fn age_text(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let seconds = std::time::SystemTime::now().duration_since(modified).unwrap_or_default().as_secs();
    Some(match seconds {
        0..=59 => format!("{seconds} 秒前"),
        60..=3599 => format!("{} 分钟前", seconds / 60),
        3600..=86_399 => format!("{} 小时前", seconds / 3600),
        _ => format!("{} 天前", seconds / 86_400),
    })
}

impl GitAdapter {
    pub(super) fn index_lock_path(&self) -> PathBuf {
        self.git_dir.join("index.lock")
    }

    /// 锁文件的确认说明：`what` 为重试的操作（“拉取”“推送 main 到 origin/main”等）。
    pub(super) fn stale_lock_confirmation(&self, paths: Vec<String>, what: &str) -> Confirmation {
        let ages: Vec<String> = paths
            .iter()
            .filter_map(|raw| {
                let path = self.lock_candidate(raw);
                let name = path.file_name()?.to_string_lossy().into_owned();
                Some(format!("{name}（{}修改）", age_text(&path)?))
            })
            .collect();
        let mut message = format!(
            "仓库中存在 Git 锁文件，{what}无法继续。锁文件通常是正在运行的 Git 进程持有，或是之前被终止、崩溃的 Git 进程留下的。确认没有其他 Git 进程（终端、IDE、其他 Git 客户端）正在操作该仓库后，可以删除锁文件并重试{what}"
        );
        if !ages.is_empty() {
            message.push_str(&format!("。最近修改：{}", ages.join("、")));
        }
        Confirmation { reason: "staleLock", message, paths }
    }

    /// 从 Git 输出中识别锁文件冲突；有时在失败结果上附加“删除锁文件并重试”的确认。
    pub(super) fn attach_stale_locks(&self, step: &mut Step, output: &str, what: &str) {
        let paths = reported_locks(output);
        if !paths.is_empty() {
            step.confirmation = Some(self.stale_lock_confirmation(paths, what));
        }
    }

    fn lock_candidate(&self, raw: &str) -> PathBuf {
        let path = Path::new(raw);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.worktree.join(path)
        }
    }

    /// 校验一个待删除的锁文件：必须在 Git 目录或 common dir 内、文件名以 `.lock` 结尾、是普通文件（不跟随链接）。
    /// 已不存在时返回 None（外部进程已经释放）。
    fn stale_lock_target(&self, raw: &str) -> Result<Option<PathBuf>, GitError> {
        let invalid = || GitError::WriteBlocked(format!("拒绝删除：{raw} 不是该仓库 Git 目录中的锁文件"));
        let path = self.lock_candidate(raw);
        let name = path.file_name().filter(|n| n.to_string_lossy().ends_with(".lock") && n.len() > ".lock".len()).ok_or_else(invalid)?;
        let Ok(parent) = dunce::canonicalize(path.parent().ok_or_else(invalid)?) else {
            return Ok(None);
        };
        if !(parent.starts_with(&self.git_dir) || parent.starts_with(&self.common_dir)) {
            return Err(invalid());
        }
        let target = parent.join(name);
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_file() => Ok(Some(target)),
            Ok(_) => Err(invalid()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(GitError::Io(error.to_string())),
        }
    }

    /// 删除用户确认过的锁文件；先全部校验再删除，已不存在的跳过。返回实际删除的路径。
    /// 调用方须持有该仓库的写锁（[`Runner::begin`]），保证 Oris 自己没有正在运行的写操作。
    pub fn remove_stale_locks(&self, paths: &[String]) -> Result<Vec<String>, GitError> {
        if paths.is_empty() || paths.len() > MAX_LOCKS {
            return Err(GitError::WriteBlocked("没有可删除的锁文件".into()));
        }
        let targets = paths.iter().map(|raw| self.stale_lock_target(raw)).collect::<Result<Vec<_>, _>>()?;
        let mut removed = Vec::new();
        for target in targets.into_iter().flatten() {
            match fs::remove_file(&target) {
                Ok(()) => removed.push(target.display().to_string()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(GitError::Io(format!("无法删除 {}：{error}", target.display()))),
            }
        }
        Ok(removed)
    }
}
