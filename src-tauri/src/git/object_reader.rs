//! 每仓库一个常驻 batch 读取器；缓存可在多个读取器之间共享。
use super::{readonly_command, GitError};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const DEFAULT_CACHE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_CACHED_BLOB_BYTES: usize = 4 * 1024 * 1024;
/// 全局常驻 cat-file 进程上限（技术方案 §7）。
pub const MAX_LIVE_READERS: usize = 5;
pub const DEFAULT_IDLE: Duration = Duration::from_secs(60);

/// 按 OID 的有界读取结果：超过上限时只报告大小，不把内容留在内存中。
#[derive(Debug, Clone)]
pub enum BlobRead {
    Bytes(Arc<[u8]>),
    TooLarge(usize),
    Missing,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub bytes: usize,
    pub entries: usize,
}

pub struct BlobCache {
    limit: usize,
    size: usize,
    values: HashMap<String, Arc<[u8]>>,
    order: VecDeque<String>,
    hits: u64,
    misses: u64,
}
impl BlobCache {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            size: 0,
            values: HashMap::new(),
            order: VecDeque::new(),
            hits: 0,
            misses: 0,
        }
    }
    pub fn get(&mut self, oid: &str) -> Option<Arc<[u8]>> {
        match self.values.get(oid).cloned() {
            Some(value) => {
                self.hits += 1;
                self.order.retain(|key| key != oid);
                self.order.push_back(oid.into());
                Some(value)
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }
    pub fn insert(&mut self, oid: String, bytes: Arc<[u8]>) {
        if bytes.len() > MAX_CACHED_BLOB_BYTES || bytes.len() > self.limit {
            return;
        }
        if let Some(old) = self.values.remove(&oid) {
            self.size -= old.len();
            self.order.retain(|key| key != &oid);
        }
        while self.size + bytes.len() > self.limit {
            if let Some(key) = self.order.pop_front() {
                if let Some(old) = self.values.remove(&key) {
                    self.size -= old.len();
                }
            } else {
                break;
            }
        }
        self.size += bytes.len();
        self.order.push_back(oid.clone());
        self.values.insert(oid, bytes);
    }
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            hits: self.hits,
            misses: self.misses,
            bytes: self.size,
            entries: self.values.len(),
        }
    }
}

static GLOBAL_CACHE: OnceLock<Arc<Mutex<BlobCache>>> = OnceLock::new();
pub fn global_cache() -> Arc<Mutex<BlobCache>> {
    GLOBAL_CACHE
        .get_or_init(|| Arc::new(Mutex::new(BlobCache::new(DEFAULT_CACHE_BYTES))))
        .clone()
}

enum Fetched {
    Bytes(Vec<u8>),
    TooLarge(usize),
    Missing,
}

/// 登记在全局池中的读取器。池限制同时存活的 cat-file 进程数（按最近使用淘汰），并回收空闲进程。
pub struct PooledReader {
    id: u64,
    inner: Mutex<ObjectReader>,
}
pub type SharedReader = Arc<PooledReader>;

struct PoolEntry {
    id: u64,
    reader: std::sync::Weak<PooledReader>,
    touched: Instant,
}
struct ReaderPool {
    entries: Mutex<Vec<PoolEntry>>,
    next: std::sync::atomic::AtomicU64,
    limit: std::sync::atomic::AtomicUsize,
}
static POOL: OnceLock<ReaderPool> = OnceLock::new();
fn pool() -> &'static ReaderPool {
    POOL.get_or_init(|| {
        // 后台每 5 s 回收空闲进程；只持有弱引用，项目关闭后条目自然失效。
        std::thread::Builder::new()
            .name("oris-cat-file-reaper".into())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_secs(5));
                expire_idle_readers();
            })
            .ok();
        ReaderPool {
            entries: Mutex::new(Vec::new()),
            next: std::sync::atomic::AtomicU64::new(1),
            limit: std::sync::atomic::AtomicUsize::new(MAX_LIVE_READERS),
        }
    })
}

impl PooledReader {
    /// 在持有读取器锁的情况下执行读取，之后更新池的最近使用顺序并执行进程上限。
    pub fn with<T>(&self, f: impl FnOnce(&mut ObjectReader) -> T) -> T {
        let result = {
            let mut reader = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            f(&mut reader)
        };
        let pool = pool();
        let limit = pool.limit.load(std::sync::atomic::Ordering::Relaxed);
        let mut entries = pool.entries.lock().unwrap_or_else(|p| p.into_inner());
        entries.retain(|e| e.reader.strong_count() > 0);
        if let Some(entry) = entries.iter_mut().find(|e| e.id == self.id) {
            entry.touched = Instant::now();
        }
        entries.sort_by_key(|e| std::cmp::Reverse(e.touched));
        let mut live = 0;
        for entry in entries.iter() {
            let Some(reader) = entry.reader.upgrade() else { continue };
            let Ok(mut guard) = reader.inner.try_lock() else {
                live += 1;
                continue;
            };
            if guard.is_live() {
                live += 1;
                if live > limit && entry.id != self.id {
                    guard.release();
                    live -= 1;
                }
            }
        }
        result
    }
    pub fn close(&self) {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).close();
    }
    pub fn is_live(&self) -> bool {
        self.inner.lock().map(|r| r.is_live()).unwrap_or(false)
    }
}

/// 为仓库创建一个登记在全局池中的读取器（共享全局 BlobCache）。
pub fn shared_reader(git: &Path, worktree: &Path, idle: Duration) -> SharedReader {
    let pool = pool();
    let id = pool.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let reader = Arc::new(PooledReader {
        id,
        inner: Mutex::new(ObjectReader::with_global_cache(git, worktree, idle)),
    });
    pool.entries
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(PoolEntry {
            id,
            reader: Arc::downgrade(&reader),
            touched: Instant::now(),
        });
    reader
}

/// 回收所有空闲超时的常驻进程，返回回收数量。
pub fn expire_idle_readers() -> usize {
    let readers: Vec<_> = pool()
        .entries
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter_map(|e| e.reader.upgrade())
        .collect();
    readers
        .iter()
        .filter(|r| r.inner.try_lock().map(|mut g| g.expire_idle()).unwrap_or(false))
        .count()
}

/// 当前存活的常驻 cat-file 进程数（用于资源断言与诊断）。
pub fn live_reader_count() -> usize {
    let readers: Vec<_> = pool()
        .entries
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter_map(|e| e.reader.upgrade())
        .collect();
    readers.iter().filter(|r| r.is_live()).count()
}

struct Batch {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}
pub struct ObjectReader {
    git: PathBuf,
    worktree: PathBuf,
    idle: Duration,
    last_used: Option<Instant>,
    batch: Option<Batch>,
    cache: Arc<Mutex<BlobCache>>,
    closed: bool,
}
impl ObjectReader {
    pub fn new(git: &Path, worktree: &Path, idle: Duration, cache: Arc<Mutex<BlobCache>>) -> Self {
        Self {
            git: git.into(),
            worktree: worktree.into(),
            idle,
            last_used: None,
            batch: None,
            cache,
            closed: false,
        }
    }
    pub fn with_global_cache(git: &Path, worktree: &Path, idle: Duration) -> Self {
        Self::new(git, worktree, idle, global_cache())
    }
    fn start(&mut self) -> Result<(), GitError> {
        let mut child = readonly_command(&self.git, &self.worktree, &["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| GitError::GitUnavailable(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| GitError::Io("cat-file stdin 不可用".into()))?;
        let stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| GitError::Io("cat-file stdout 不可用".into()))?,
        );
        self.batch = Some(Batch {
            child,
            stdin,
            stdout,
        });
        Ok(())
    }
    fn stop(&mut self) {
        if let Some(mut batch) = self.batch.take() {
            drop(batch.stdin);
            let _ = batch.child.kill();
            let _ = batch.child.wait();
        }
        self.last_used = None;
    }
    pub fn close(&mut self) {
        self.stop();
        self.closed = true;
    }
    pub fn expire_idle(&mut self) -> bool {
        if self.last_used.is_some_and(|at| at.elapsed() >= self.idle) {
            self.stop();
            true
        } else {
            false
        }
    }
    fn request_limited(&mut self, oid: &str, limit: usize) -> Result<Fetched, GitError> {
        let batch = self
            .batch
            .as_mut()
            .ok_or_else(|| GitError::Io("cat-file 未启动".into()))?;
        batch
            .stdin
            .write_all(oid.as_bytes())
            .and_then(|_| batch.stdin.write_all(b"\n"))
            .and_then(|_| batch.stdin.flush())
            .map_err(|e| GitError::Io(e.to_string()))?;
        let mut header = Vec::new();
        batch
            .stdout
            .read_until(b'\n', &mut header)
            .map_err(|e| GitError::Io(e.to_string()))?;
        if header.is_empty() {
            return Err(GitError::Io("cat-file 提前退出".into()));
        }
        if header.ends_with(b" missing\n") {
            return Ok(Fetched::Missing);
        }
        let fields: Vec<_> = header.split(|b| *b == b' ').collect();
        if fields.len() != 3 {
            return Err(GitError::CommandFailed("cat-file 响应头无效".into()));
        }
        let length: usize = std::str::from_utf8(
            fields[2]
                .strip_suffix(b"\n")
                .ok_or_else(|| GitError::Io("cat-file 响应不完整".into()))?,
        )
        .map_err(|e| GitError::Io(e.to_string()))?
        .parse()
        .map_err(|e: std::num::ParseIntError| GitError::Io(e.to_string()))?;
        let is_blob = fields[1] == b"blob";
        if !is_blob || length > limit {
            // 丢弃对象内容（分块读取，内存有界），保持批处理流同步。
            let mut remaining = length + 1;
            let mut sink = [0u8; 64 * 1024];
            while remaining > 0 {
                let take = remaining.min(sink.len());
                batch
                    .stdout
                    .read_exact(&mut sink[..take])
                    .map_err(|e| GitError::Io(e.to_string()))?;
                remaining -= take;
            }
            if !is_blob {
                return Err(GitError::CommandFailed("cat-file 返回非 blob 对象".into()));
            }
            return Ok(Fetched::TooLarge(length));
        }
        let mut data = vec![0; length];
        batch
            .stdout
            .read_exact(&mut data)
            .map_err(|e| GitError::Io(e.to_string()))?;
        let mut end = [0];
        batch
            .stdout
            .read_exact(&mut end)
            .map_err(|e| GitError::Io(e.to_string()))?;
        if end != *b"\n" {
            return Err(GitError::Io("cat-file 响应分隔符错误".into()));
        }
        Ok(Fetched::Bytes(data))
    }
    /// 单次请求最多在原进程失败后重启一次。missing 不重试。
    pub fn read_blob(&mut self, oid: &str) -> Result<Option<Arc<[u8]>>, GitError> {
        Ok(match self.read_blob_limited(oid, usize::MAX)? {
            BlobRead::Bytes(bytes) => Some(bytes),
            BlobRead::Missing => None,
            BlobRead::TooLarge(_) => unreachable!("unbounded read"),
        })
    }
    /// 当前是否持有常驻 cat-file 进程。
    pub fn is_live(&self) -> bool {
        self.batch.is_some()
    }
    /// 停止常驻进程但保留读取器（下次读取时重新启动）。
    pub fn release(&mut self) {
        self.stop();
    }
    /// 有界读取：超过 `limit` 字节的对象只返回大小。命中缓存时不启动进程。
    pub fn read_blob_limited(&mut self, oid: &str, limit: usize) -> Result<BlobRead, GitError> {
        if self.closed {
            return Err(GitError::Io("读取器已关闭".into()));
        }
        if !((oid.len() == 40 || oid.len() == 64) && oid.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err(GitError::CommandFailed("无效对象 OID".into()));
        }
        if let Some(value) = self
            .cache
            .lock()
            .map_err(|e| GitError::Io(e.to_string()))?
            .get(oid)
        {
            if value.len() <= limit {
                return Ok(BlobRead::Bytes(value));
            }
            return Ok(BlobRead::TooLarge(value.len()));
        }
        self.expire_idle();
        if let Some(batch) = self.batch.as_mut() {
            if batch
                .child
                .try_wait()
                .map_err(|e| GitError::Io(e.to_string()))?
                .is_some()
            {
                self.stop();
                self.start()?;
            }
        }
        if self.batch.is_none() {
            self.start()?;
        }
        let result = match self.request_limited(oid, limit) {
            Ok(value) => Ok(value),
            Err(_) => {
                self.stop();
                self.start()?;
                self.request_limited(oid, limit)
            }
        }?;
        self.last_used = Some(Instant::now());
        Ok(match result {
            Fetched::Bytes(bytes) => {
                let value: Arc<[u8]> = bytes.into();
                if let Ok(mut cache) = self.cache.lock() {
                    cache.insert(oid.into(), value.clone());
                }
                BlobRead::Bytes(value)
            }
            Fetched::TooLarge(size) => BlobRead::TooLarge(size),
            Fetched::Missing => BlobRead::Missing,
        })
    }
    #[cfg(test)]
    pub(crate) fn kill_for_test(&mut self) {
        if let Some(batch) = self.batch.as_mut() {
            batch.child.kill().unwrap();
            batch.child.wait().unwrap();
        }
    }
}
impl Drop for ObjectReader {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};
    fn git(dir: &Path, args: &[&str]) -> Vec<u8> {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        git(dir.path(), &["config", "user.email", "test@example.test"]);
        dir
    }
    #[test]
    fn oid_content_recovery_idle_and_readonly() {
        let dir = repo();
        let p = dir.path();
        fs::write(p.join("file"), b"a\0b\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "init"]);
        let oid = String::from_utf8(git(p, &["rev-parse", "HEAD:file"]))
            .unwrap()
            .trim()
            .to_owned();
        let before = ["file", ".git/index", ".git/HEAD", ".git/config"]
            .map(|f| fs::read(p.join(f)).unwrap());
        let cache = Arc::new(Mutex::new(BlobCache::new(64)));
        let mut reader =
            ObjectReader::new(Path::new("git"), p, Duration::from_millis(1), cache.clone());
        let got = reader.read_blob(&oid).unwrap().unwrap();
        assert_eq!(&*got, &*git(p, &["show", "HEAD:file"]));
        assert_eq!(reader.read_blob(&oid).unwrap().unwrap(), got);
        reader.kill_for_test();
        cache.lock().unwrap().values.clear();
        cache.lock().unwrap().order.clear();
        assert_eq!(reader.read_blob(&oid).unwrap().unwrap(), got);
        std::thread::sleep(Duration::from_millis(2));
        assert!(reader.expire_idle());
        reader.close();
        assert!(reader.read_blob(&oid).is_err());
        let after = ["file", ".git/index", ".git/HEAD", ".git/config"]
            .map(|f| fs::read(p.join(f)).unwrap());
        assert_eq!(before, after);
    }
    #[test]
    fn lru_and_missing() {
        let mut cache = BlobCache::new(4);
        cache.insert("a".into(), Arc::from(&b"aa"[..]));
        cache.insert("b".into(), Arc::from(&b"bb"[..]));
        assert!(cache.get("a").is_some());
        cache.insert("c".into(), Arc::from(&b"cc"[..]));
        assert!(cache.get("b").is_none());
        assert_eq!(
            cache.stats(),
            CacheStats {
                hits: 1,
                misses: 1,
                bytes: 4,
                entries: 2
            }
        );
        let dir = repo();
        let mut reader = ObjectReader::new(
            Path::new("git"),
            dir.path(),
            Duration::from_secs(60),
            Arc::new(Mutex::new(BlobCache::new(0))),
        );
        assert!(reader.read_blob(&"0".repeat(40)).unwrap().is_none());
    }
    #[test]
    fn invalid_git_and_fsmonitor_command() {
        let dir = repo();
        let p = dir.path();
        fs::write(p.join("file"), b"x").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "init"]);
        let oid = String::from_utf8(git(p, &["rev-parse", "HEAD:file"]))
            .unwrap()
            .trim()
            .to_owned();
        let marker = p.join("marker");
        git(
            p,
            &[
                "config",
                "core.fsmonitor",
                &format!("echo evil > {}", marker.display()),
            ],
        );
        let mut reader = ObjectReader::new(
            Path::new("git"),
            p,
            Duration::from_secs(60),
            Arc::new(Mutex::new(BlobCache::new(0))),
        );
        assert_eq!(&*reader.read_blob(&oid).unwrap().unwrap(), b"x");
        assert!(!marker.exists());
        reader.kill_for_test();
        reader.git = PathBuf::from("does-not-exist-git");
        let result = reader.read_blob(&oid);
        assert!(
            result.is_err(),
            "result={result:?}, cache={:?}",
            reader.cache.lock().unwrap().stats()
        );
        let mut bad = ObjectReader::new(
            Path::new("does-not-exist-git"),
            p,
            Duration::from_secs(60),
            Arc::new(Mutex::new(BlobCache::new(0))),
        );
        assert!(bad.read_blob(&oid).is_err());
    }
}
