//! 轻量快照持久化（技术方案 §5.5）：再次打开时先显示上次快照并标“校验中”。
//! 只保存前端提交的轻量状态（文件列表、OID、分支、inProgress、阅读锚点），不含文件内容。
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// 单个项目快照上限。
pub const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
/// 最多保留的项目快照数，按最近写入保留。
pub const MAX_SNAPSHOTS: usize = 20;
/// 快照格式版本；读取到其他版本时视为不存在。
pub const SNAPSHOT_VERSION: u32 = 1;

pub struct SnapshotStore {
    dir: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SaveOutcome {
    Saved,
    TooLarge(usize),
}

impl SnapshotStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn file_for(&self, worktree: &str) -> PathBuf {
        // 路径哈希作为文件名：前端提供的字符串不会参与路径拼接。
        self.dir.join(format!("{}.json", hex::encode(Sha256::digest(worktree.as_bytes()))))
    }

    /// 写入（原子替换）。超过上限时不写并删除旧快照，避免显示过期内容。
    pub fn save(&self, worktree: &str, json: &[u8]) -> std::io::Result<SaveOutcome> {
        let target = self.file_for(worktree);
        if json.len() > MAX_SNAPSHOT_BYTES {
            let _ = fs::remove_file(&target);
            return Ok(SaveOutcome::TooLarge(json.len()));
        }
        fs::create_dir_all(&self.dir)?;
        let temporary = target.with_extension("json.tmp");
        fs::write(&temporary, wrap(worktree, json))?;
        fs::rename(&temporary, &target)?;
        self.prune()?;
        Ok(SaveOutcome::Saved)
    }

    pub fn load(&self, worktree: &str) -> Option<Vec<u8>> {
        let bytes = fs::read(self.file_for(worktree)).ok()?;
        if bytes.len() > MAX_SNAPSHOT_BYTES + 4096 {
            return None;
        }
        unwrap(worktree, &bytes)
    }

    pub fn remove(&self, worktree: &str) {
        let _ = fs::remove_file(self.file_for(worktree));
    }

    fn prune(&self) -> std::io::Result<()> {
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(&self.dir)?
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in files.into_iter().skip(MAX_SNAPSHOTS) {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }

    pub fn count(&self) -> usize {
        fs::read_dir(&self.dir)
            .map(|dir| dir.filter_map(Result::ok).filter(|e| e.path().extension().is_some_and(|x| x == "json")).count())
            .unwrap_or(0)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// `{"version":1,"worktreePath":"…","snapshot":<前端 JSON>}`：用长度前缀的头部避免解析整份快照。
fn wrap(worktree: &str, json: &[u8]) -> Vec<u8> {
    let header = format!("ORIS-SNAPSHOT {SNAPSHOT_VERSION} {}\n{worktree}\n", worktree.len());
    let mut bytes = header.into_bytes();
    bytes.extend_from_slice(json);
    bytes
}

fn unwrap(worktree: &str, bytes: &[u8]) -> Option<Vec<u8>> {
    let newline = bytes.iter().position(|b| *b == b'\n')?;
    let header = std::str::from_utf8(&bytes[..newline]).ok()?;
    let mut parts = header.split(' ');
    if parts.next()? != "ORIS-SNAPSHOT" || parts.next()?.parse::<u32>().ok()? != SNAPSHOT_VERSION {
        return None;
    }
    let length: usize = parts.next()?.parse().ok()?;
    let rest = &bytes[newline + 1..];
    if rest.len() < length + 1 || &rest[..length] != worktree.as_bytes() || rest[length] != b'\n' {
        return None;
    }
    Some(rest[length + 1..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_version_path_binding_size_and_count_limits() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnapshotStore::new(dir.path().join("snapshots"));
        assert!(store.load("C:/repo").is_none());
        assert_eq!(store.save("C:/repo", br#"{"files":[]}"#).unwrap(), SaveOutcome::Saved);
        assert_eq!(store.load("C:/repo").unwrap(), br#"{"files":[]}"#);
        assert!(store.load("C:/other").is_none());
        // 版本不兼容或内容损坏：视为不存在。
        let file = store.file_for("C:/repo");
        let mut bytes = fs::read(&file).unwrap();
        bytes[14] = b'9';
        fs::write(&file, &bytes).unwrap();
        assert!(store.load("C:/repo").is_none());
        fs::write(&file, b"garbage").unwrap();
        assert!(store.load("C:/repo").is_none());
        // 大小上限：刚好 2 MiB 可写，超出 1 字节拒绝并删除旧快照。
        let exact = vec![b' '; MAX_SNAPSHOT_BYTES];
        assert_eq!(store.save("C:/big", &exact).unwrap(), SaveOutcome::Saved);
        assert_eq!(store.load("C:/big").unwrap().len(), MAX_SNAPSHOT_BYTES);
        let over = vec![b' '; MAX_SNAPSHOT_BYTES + 1];
        assert_eq!(store.save("C:/big", &over).unwrap(), SaveOutcome::TooLarge(MAX_SNAPSHOT_BYTES + 1));
        assert!(store.load("C:/big").is_none());
        // 数量上限：写入 25 个项目后只保留最近 20 个。
        for i in 0..25 {
            store.save(&format!("C:/p{i}"), b"{}").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(store.count(), MAX_SNAPSHOTS);
        assert!(store.load("C:/p24").is_some());
        assert!(store.load("C:/p0").is_none());
        store.remove("C:/p24");
        assert!(store.load("C:/p24").is_none());
    }
}
