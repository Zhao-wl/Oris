//! 写通道进程：固定参数模板、非交互、输出逐行转发与脱敏、可取消整个进程树（技术方案 §3、§4）。
//!
//! Windows 用 Job Object 终止 git 及其派生的 hook 进程；其他平台用进程组。
//! 不做任何自动重试。
use super::super::{git_command, GitError};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

/// 每个仓库保留的最近一次操作输出上限（技术方案 §7）。
pub const OUTPUT_LIMIT: usize = 256 * 1024;
/// 捕获为数据的 stdout 上限（如 hash-object 输出的 OID 列表、cat-file 读取的备份对象）。
const STDOUT_LIMIT: usize = 64 * 1024 * 1024 + 4096;

/// 写通道命令：去掉 `--no-optional-locks`，允许 hooks 与 filter；继续禁用 external diff 与 fsmonitor 命令，
/// 编辑器设为 Git 内置的空操作 `:`，任何命令都不会停在编辑器或终端提示上。
pub(crate) fn write_command(git: &Path, cwd: &Path) -> Command {
    let mut command = git_command(git);
    command
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("diff.external=")
        .arg("-c")
        .arg("diff.trustExitCode=false")
        .arg("-C")
        .arg(cwd)
        .env("GIT_EXTERNAL_DIFF", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", ":")
        .env("GIT_SEQUENCE_EDITOR", ":")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_LITERAL_PATHSPECS", "1");
    command
}

/// 一次操作的取消标记与当前进程树。
#[derive(Default)]
pub struct CancelHandle {
    cancelled: AtomicBool,
    tree: Mutex<Option<ProcessTree>>,
}

impl CancelHandle {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(tree) = self.tree.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            tree.terminate();
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// 操作输出：逐行脱敏，按上限保留，并实时转发给界面。
pub struct OutputLog<'a> {
    text: Mutex<String>,
    truncated: AtomicBool,
    sink: &'a (dyn Fn(&str) + Sync),
}

impl<'a> OutputLog<'a> {
    pub fn new(sink: &'a (dyn Fn(&str) + Sync)) -> Self {
        Self { text: Mutex::new(String::new()), truncated: AtomicBool::new(false), sink }
    }
    pub fn line(&self, raw: &str) {
        let line = redact(raw.trim_end());
        if line.trim().is_empty() {
            return;
        }
        (self.sink)(&line);
        let mut text = self.text.lock().unwrap_or_else(|p| p.into_inner());
        if text.len() + line.len() + 1 > OUTPUT_LIMIT {
            self.truncated.store(true, Ordering::SeqCst);
            return;
        }
        text.push_str(&line);
        text.push('\n');
    }
    pub fn snapshot(&self) -> (String, bool) {
        (self.text.lock().unwrap_or_else(|p| p.into_inner()).clone(), self.truncated.load(Ordering::SeqCst))
    }
}

/// 脱敏：URL 中的 `user:password@` 替换为 `***@`（技术方案 §8）。
pub fn redact(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(scheme) = rest.find("://") {
        let (head, tail) = rest.split_at(scheme + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"').unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(at) => {
                out.push_str("***");
                out.push_str(&tail[at..end]);
            }
            None => out.push_str(&tail[..end]),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

pub struct CallResult {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr_tail: String,
    pub cancelled: bool,
}

impl CallResult {
    pub fn summary(&self) -> String {
        if !self.stderr_tail.trim().is_empty() {
            self.stderr_tail.trim().to_owned()
        } else {
            format!("退出码 {}", self.code.unwrap_or(-1))
        }
    }
}

/// 在写通道上执行一条 Git 命令。`log_stdout` 为 false 时 stdout 作为数据返回，不进入操作输出。
pub fn run(
    git: &Path,
    cwd: &Path,
    args: &[&OsStr],
    stdin: Option<Vec<u8>>,
    log_stdout: bool,
    cancel: &CancelHandle,
    log: &OutputLog,
    counter: &std::sync::atomic::AtomicU32,
) -> Result<CallResult, GitError> {
    if cancel.is_cancelled() {
        return Ok(CallResult { success: false, code: None, stdout: Vec::new(), stderr_tail: String::new(), cancelled: true });
    }
    let mut command = write_command(git, cwd);
    command.args(args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    ProcessTree::prepare(&mut command);
    let mut child = command.spawn().map_err(|e| GitError::GitUnavailable(e.to_string()))?;
    counter.fetch_add(1, Ordering::SeqCst);
    {
        let tree = ProcessTree::attach(&child);
        let mut slot = cancel.tree.lock().unwrap_or_else(|p| p.into_inner());
        *slot = Some(tree);
    }
    // 取消可能在 spawn 与登记进程树之间到达：登记后再检查一次。
    if cancel.is_cancelled() {
        if let Some(tree) = cancel.tree.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            tree.terminate();
        }
    }
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    let (sender, receiver) = mpsc::channel::<(bool, Vec<u8>)>();
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let pump = |mut stream: Box<dyn Read + Send>, is_err: bool, sender: mpsc::Sender<(bool, Vec<u8>)>| {
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if sender.send((is_err, buffer[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        })
    };
    let out_thread = pump(Box::new(stdout), false, sender.clone());
    let err_thread = pump(Box::new(stderr), true, sender);
    let mut stdout_data = Vec::new();
    let mut pending = [Vec::new(), Vec::new()];
    let mut stderr_lines: Vec<String> = Vec::new();
    let flush_lines = |is_err: bool, chunk: &[u8], pending: &mut [Vec<u8>; 2], stderr_lines: &mut Vec<String>, finish: bool| {
        let slot = &mut pending[usize::from(is_err)];
        slot.extend_from_slice(chunk);
        loop {
            let Some(position) = slot.iter().position(|b| *b == b'\n' || *b == b'\r') else { break };
            let line: Vec<u8> = slot.drain(..=position).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
            if is_err {
                stderr_lines.push(text.clone());
                if stderr_lines.len() > 40 {
                    stderr_lines.remove(0);
                }
            }
            log.line(&text);
        }
        if finish && !slot.is_empty() {
            let text = String::from_utf8_lossy(slot).into_owned();
            slot.clear();
            if is_err {
                stderr_lines.push(text.clone());
            }
            log.line(&text);
        }
    };
    // 读取直到两个管道都关闭；hook 派生的后台进程可能继续持有管道，因此 git 退出后最多再等 500 ms。
    let mut exited_at: Option<std::time::Instant> = None;
    let mut status = None;
    loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok((is_err, chunk)) => {
                if !is_err && !log_stdout {
                    if stdout_data.len() + chunk.len() <= STDOUT_LIMIT {
                        stdout_data.extend_from_slice(&chunk);
                    }
                } else {
                    flush_lines(is_err, &chunk, &mut pending, &mut stderr_lines, false);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if status.is_none() {
            if let Ok(Some(done)) = child.try_wait() {
                status = Some(done);
                exited_at = Some(std::time::Instant::now());
            }
        } else if exited_at.is_some_and(|at| at.elapsed() > Duration::from_millis(500)) {
            break;
        }
    }
    let status = match status {
        Some(status) => status,
        None => child.wait().map_err(|e| GitError::Io(e.to_string()))?,
    };
    if out_thread.is_finished() {
        let _ = out_thread.join();
    }
    if err_thread.is_finished() {
        let _ = err_thread.join();
    }
    flush_lines(false, &[], &mut pending, &mut stderr_lines, true);
    flush_lines(true, &[], &mut pending, &mut stderr_lines, true);
    cancel.tree.lock().unwrap_or_else(|p| p.into_inner()).take();
    let cancelled = cancel.is_cancelled();
    let tail: Vec<&String> = stderr_lines.iter().filter(|l| !l.trim().is_empty()).collect();
    let stderr_tail = tail[tail.len().saturating_sub(12)..].iter().map(|l| redact(l)).collect::<Vec<_>>().join("\n");
    Ok(CallResult { success: status.success() && !cancelled, code: status.code(), stdout: stdout_data, stderr_tail, cancelled })
}

/// 可整体终止的进程树。
pub struct ProcessTree {
    #[cfg(windows)]
    job: Option<windows_job::Job>,
    #[cfg(unix)]
    pgid: u32,
    #[cfg(not(any(windows, unix)))]
    _unused: (),
}

impl ProcessTree {
    fn prepare(command: &mut Command) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(not(unix))]
        let _ = command;
    }

    fn attach(child: &std::process::Child) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // 登记前已派生的孙进程极少（git 在读取 index、执行 hook 之前需要数十毫秒）。
            let job = windows_job::Job::create().filter(|job| job.assign(child.as_raw_handle()));
            Self { job }
        }
        #[cfg(unix)]
        {
            Self { pgid: child.id() }
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = child;
            Self { _unused: () }
        }
    }

    fn terminate(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg("-KILL").arg("--").arg(format!("-{}", self.pgid)).status();
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// 不设置 KILL_ON_JOB_CLOSE：正常结束时 hook 有意留在后台的进程保持与终端中相同的行为，只有取消才终止整棵树。
    pub struct Job(Handle);
    // SAFETY：Job 句柄可在线程间传递与共享；只调用线程安全的 Win32 API。
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn create() -> Option<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            (!handle.is_null()).then_some(Self(handle))
        }
        pub fn assign(&self, process: std::os::windows::io::RawHandle) -> bool {
            unsafe { AssignProcessToJobObject(self.0, process as Handle) != 0 }
        }
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_credentials_in_urls() {
        assert_eq!(redact("fatal: https://alice:s3cret@example.com/repo.git"), "fatal: https://***@example.com/repo.git");
        assert_eq!(redact("ssh://git@host:22/x and https://h/x"), "ssh://***@host:22/x and https://h/x");
        assert_eq!(redact("no url here"), "no url here");
    }
}
