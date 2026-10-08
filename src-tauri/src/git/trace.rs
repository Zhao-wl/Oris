//! 拓展 02 共用的有界只读进程。取消只终止本请求创建的 Git 子进程；不执行外部 diff/textconv。
use super::*;
use std::{
    io::Read,
    process::Stdio,
    sync::mpsc,
    time::{Duration, Instant},
};

pub const OUTPUT_BUDGET: usize = 8 * 1024 * 1024;
pub const TIME_BUDGET: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum Failure {
    Cancelled,
    Budget,
    Git(GitError),
}
impl From<GitError> for Failure {
    fn from(e: GitError) -> Self {
        Self::Git(e)
    }
}
impl Failure {
    pub fn error(self) -> GitError {
        match self {
            Self::Cancelled => GitError::StaleRequest,
            Self::Budget => {
                GitError::CommandFailed("追溯达到时间或输出预算，请缩小范围后重试".into())
            }
            Self::Git(e) => e,
        }
    }
}
pub struct Budget<'a> {
    started: Instant,
    bytes: usize,
    stale: &'a dyn Fn() -> bool,
}
impl<'a> Budget<'a> {
    pub fn new(stale: &'a dyn Fn() -> bool) -> Self {
        Self {
            started: Instant::now(),
            bytes: 0,
            stale,
        }
    }
    pub fn check(&self) -> Result<(), Failure> {
        if (self.stale)() {
            Err(Failure::Cancelled)
        } else if self.started.elapsed() >= TIME_BUDGET || self.bytes >= OUTPUT_BUDGET {
            Err(Failure::Budget)
        } else {
            Ok(())
        }
    }
    pub fn elapsed_ms(&self) -> u128 {
        self.started.elapsed().as_millis()
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn run(&mut self, adapter: &GitAdapter, args: &[&str]) -> Result<Vec<u8>, Failure> {
        self.run_status(adapter, args, false)
    }
    pub fn run_status(
        &mut self,
        adapter: &GitAdapter,
        args: &[&str],
        allow_diff: bool,
    ) -> Result<Vec<u8>, Failure> {
        self.check()?;
        let mut child = readonly_command(&adapter.git, &adapter.worktree, args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| GitError::GitUnavailable(e.to_string()))?;
        // 有界队列：每个读取线程最多领先主线程 8 个 8 KiB 块；永不无界 output()。
        let (sender, receiver) = mpsc::sync_channel(8);
        let readers: Vec<_> = [
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            Box::new(child.stderr.take().unwrap()),
        ]
        .into_iter()
        .enumerate()
        .map(|(stream, mut pipe)| {
            let sender = sender.clone();
            std::thread::spawn(move || {
                let mut buffer = [0; 8192];
                loop {
                    match pipe.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if sender.send((stream, Ok(buffer[..n].to_vec()))).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = sender.send((stream, Err(e.to_string())));
                            break;
                        }
                    }
                }
            })
        })
        .collect();
        drop(sender);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let result = loop {
            if let Err(reason) = self.check() {
                break Err(reason);
            }
            match receiver.recv_timeout(Duration::from_millis(10)) {
                Ok((stream, Ok(bytes))) => {
                    self.bytes += bytes.len();
                    if self.bytes > OUTPUT_BUDGET {
                        break Err(Failure::Budget);
                    }
                    if stream == 0 {
                        stdout.extend(bytes);
                    } else {
                        let available = 65536usize.saturating_sub(stderr.len());
                        stderr.extend(bytes.into_iter().take(available));
                    }
                }
                Ok((_, Err(e))) => break Err(Failure::Git(GitError::Io(e))),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => match child.try_wait() {
                    Ok(Some(status))
                        if status.success() || (allow_diff && status.code() == Some(1)) =>
                    {
                        break Ok(stdout)
                    }
                    Ok(Some(_)) => {
                        break Err(Failure::Git(GitError::CommandFailed(format!(
                            "追溯 Git 查询失败（可能缺少对象或版本/路径不存在）：{}",
                            String::from_utf8_lossy(&stderr)
                        ))))
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Err(e) => break Err(Failure::Git(GitError::Io(e.to_string()))),
                },
            }
        };
        if result.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        drop(receiver);
        for reader in readers {
            let _ = reader.join();
        }
        self.check()?;
        result
    }
}

pub fn oid(value: &str) -> Result<(), GitError> {
    if (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(GitError::CommandFailed("追溯需要完整提交 OID".into()))
    }
}
pub fn binding<T: Serialize>(query: &T) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(query).expect("trace query serializes"),
    ))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub content_id: Option<String>,
    pub snapshot_revision: Option<String>,
    pub side: String,
}
pub fn verify_identity(
    identity: Option<&Identity>,
    bytes: &[u8],
    local: bool,
) -> Result<(), GitError> {
    if let Some(identity) = identity {
        if !matches!(identity.side.as_str(), "a" | "b") {
            return Err(GitError::StaleRequest);
        }
        if let Some(id) = &identity.content_id {
            if *id != hash_bytes(bytes) {
                return Err(GitError::StaleRequest);
            }
        }
        if local
            && (identity.content_id.is_none()
                || identity
                    .snapshot_revision
                    .as_deref()
                    .unwrap_or_default()
                    .is_empty())
        {
            return Err(GitError::StaleRequest);
        }
    } else if local {
        return Err(GitError::CommandFailed(
            "本地追溯需要阅读快照 revision/contentId".into(),
        ));
    }
    Ok(())
}
pub fn parents(
    adapter: &GitAdapter,
    oid: &str,
    budget: &mut Budget<'_>,
) -> Result<Vec<String>, Failure> {
    // 直接读对象 header，保留浅克隆边界真实 parent；不把浅边界冒充根提交。
    let raw = budget.run(adapter, &["cat-file", "-p", oid])?;
    let text = String::from_utf8_lossy(&raw);
    Ok(text
        .lines()
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.strip_prefix("parent ").map(str::to_owned))
        .collect())
}
pub fn changes(
    adapter: &GitAdapter,
    oid: &str,
    parent: Option<&str>,
    budget: &mut Budget<'_>,
) -> Result<Vec<log::ChangedFile>, Failure> {
    let mut args = vec![
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-z",
        "-r",
        "-M",
        "--no-ext-diff",
        "--no-textconv",
    ];
    if let Some(parent) = parent {
        args.extend([parent, oid]);
    } else {
        args.extend(["--root", oid]);
    }
    args.push("--");
    Ok(log::parse_raw(&budget.run(adapter, &args)?)?)
}
pub fn patch(
    adapter: &GitAdapter,
    oid: &str,
    parent: Option<&str>,
    file: &log::ChangedFile,
    budget: &mut Budget<'_>,
) -> Result<String, Failure> {
    let path = content::decode_path(&file.path_id)?;
    let old = file
        .old_path_id
        .as_deref()
        .map(content::decode_path)
        .transpose()?;
    let mut args = vec![
        "diff-tree",
        "--no-commit-id",
        "-r",
        "-p",
        "-M",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=0",
    ];
    if let Some(parent) = parent {
        args.extend([parent, oid]);
    } else {
        args.extend(["--root", oid]);
    }
    args.extend(["--", &path]);
    if let Some(old) = &old {
        args.push(old);
    }
    String::from_utf8(budget.run(adapter, &args)?).map_err(|_| {
        Failure::Git(GitError::CommandFailed(
            "历史内容不是 UTF-8 文本，无法继续追溯".into(),
        ))
    })
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;
