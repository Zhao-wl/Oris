//! AI 只负责生成文本与文件建议；Git 写入始终走 ops 写通道。
use crate::git::ops::process::ProcessTree;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub kind: String,
    pub provider: String,
    pub executable: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCandidate {
    pub provider: String,
    pub executable: String,
    pub models: Vec<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<String>,
    pub warning: Option<String>,
}

fn secret_entry(id: &str) -> Result<keyring::Entry, String> {
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || id.len() > 80
        || id.is_empty()
    {
        return Err("AI 配置 ID 无效".into());
    }
    keyring::Entry::new("Oris AI", id).map_err(|e| format!("系统凭据存储不可用：{e}"))
}

pub fn set_key(id: &str, value: Option<&str>) -> Result<(), String> {
    let entry = secret_entry(id)?;
    match value {
        Some(key) if !key.trim().is_empty() => entry
            .set_password(key.trim())
            .map_err(|e| format!("保存 API Key 失败：{e}")),
        _ => {
            let _ = entry.delete_credential();
            Ok(())
        }
    }
}

fn key(id: &str) -> Result<String, String> {
    secret_entry(id)?
        .get_password()
        .map_err(|_| "未找到该配置的 API Key，请在设置中填写".into())
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.into()]
    } else {
        vec![name.into()]
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        for name in &names {
            let path = dir.join(name);
            if path.is_file() {
                return fs::canonicalize(&path).ok().or(Some(path));
            }
        }
    }
    // Finder 启动的 macOS 应用通常拿不到交互式 shell 的 PATH。
    // Codex 桌面版还会将 CLI 放在应用包内，而不是安装为全局命令。
    #[cfg(target_os = "macos")]
    {
        let mut dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".npm-global/bin"));
            dirs.push(home.join("Applications/ChatGPT.app/Contents/Resources"));
            dirs.push(home.join("Applications/Codex.app/Contents/Resources"));
        }
        dirs.push(PathBuf::from("/Applications/ChatGPT.app/Contents/Resources"));
        dirs.push(PathBuf::from("/Applications/Codex.app/Contents/Resources"));
        for dir in dirs {
            let path = dir.join(name);
            if path.is_file() {
                return fs::canonicalize(&path).ok().or(Some(path));
            }
        }
    }
    None
}

/// Codex 桌面版与各 CLI 共用的 `~/.codex/models_cache.json`；由最近运行的那个 Codex 写入。
fn codex_cache() -> Option<Value> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|p| PathBuf::from(p).join(".codex"))
        })?;
    let bytes = fs::read(root.join("models_cache.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn codex_models() -> Vec<String> {
    let Some(data) = codex_cache() else { return Vec::new() };
    data.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("slug").and_then(Value::as_str))
        .take(100)
        .map(str::to_owned)
        .collect()
}

/// 取文本中首个 `x.y.z` 版本号，忽略 `-alpha` 等预发布后缀。
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.')).find_map(|token| {
        let mut parts = token.split('.');
        Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
    })
}

/// `.cmd` / `.bat` 由 cmd.exe 解释，Rust 拒绝向它们传递含换行的参数（无法安全转义，启动时报
/// “batch file arguments are invalid”）；npm 安装的 claude.cmd 属于这种情况。此时把换行换成空格（内容不变，只是不分行），
/// 其他可执行文件原样传递。
fn batch_safe_argument<'a>(executable: &Path, text: &'a str) -> std::borrow::Cow<'a, str> {
    let batch = executable.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if batch && text.contains(['\r', '\n']) {
        std::borrow::Cow::Owned(text.replace("\r\n", " ").replace(['\r', '\n'], " "))
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

/// 结束 AI 工具的整棵进程树，再回收直接子进程。
fn end_tree(tree: &ProcessTree, child: &mut std::process::Child) {
    tree.terminate();
    let _ = child.kill();
    let _ = child.wait();
}

/// AI CLI 的进程工厂：Windows 下不弹出控制台窗口（npm 装的 `.cmd` 包装同样适用）。
fn cli_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 运行 `<tool> --version`，5 秒内成功退出时返回其 stdout。
fn tool_version(executable: &Path) -> Option<String> {
    let mut output = tempfile::tempfile().ok()?;
    let mut command = cli_command(executable);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(output.try_clone().ok()?)
        .stderr(Stdio::null());
    ProcessTree::prepare(&mut command);
    let mut process = command.spawn().ok()?;
    let tree = ProcessTree::attach(&process);
    let started = Instant::now();
    let okay = loop {
        if let Ok(Some(status)) = process.try_wait() {
            break status.success();
        }
        if started.elapsed() > Duration::from_secs(5) {
            end_tree(&tree, &mut process);
            break false;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    if !okay {
        return None;
    }
    let mut bytes = Vec::new();
    output.seek(SeekFrom::Start(0)).ok()?;
    output.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// 模型列表来自更新的 Codex（常见于桌面版自带 CLI 比 PATH 上的新）时，旧 CLI 可能无法使用其中的模型。
fn codex_version_warning(cli_version: &str, cache: Option<&Value>) -> Option<String> {
    let cache_version = cache?.get("client_version")?.as_str()?;
    let (cli, cached) = (parse_version(cli_version)?, parse_version(cache_version)?);
    (cli < cached).then(|| {
        format!(
            "当前 Codex CLI 版本为 {}.{}.{}，低于写入模型列表的 Codex {cache_version}（通常是 Codex 桌面版），列表中的新模型可能无法使用；请升级该 CLI，或在“可执行文件”中改用较新的 codex",
            cli.0, cli.1, cli.2
        )
    })
}

fn codex_warning_for(executable: &Path) -> Option<String> {
    codex_version_warning(&tool_version(executable)?, codex_cache().as_ref())
}

/// Claude Code 的模型用完整 ID：`sonnet` 等别名由 CLI 按自身版本解析，旧版本会解析到账号已无法访问的型号。
/// 新模型发布后需同步更新；列表外的模型仍可在设置中手动输入。
const CLAUDE_MODELS: [&str; 4] = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"];

fn claude_models() -> Vec<String> {
    CLAUDE_MODELS.iter().map(|&model| model.to_owned()).collect()
}

fn cli_executable(profile: &AiProfile) -> Option<PathBuf> {
    if profile.executable.trim().is_empty() {
        find_executable(&profile.provider)
    } else {
        Some(PathBuf::from(profile.executable.trim()))
    }
}

pub fn detect_tools() -> Vec<ToolCandidate> {
    [("codex", "codex"), ("claude", "claude")]
        .into_iter()
        .filter_map(|(provider, name)| {
            let executable = find_executable(name)?;
            let version = tool_version(&executable)?;
            let (models, warning) = if provider == "codex" {
                (codex_models(), codex_version_warning(&version, codex_cache().as_ref()))
            } else {
                (claude_models(), None)
            };
            Some(ToolCandidate {
                provider: provider.into(),
                executable: executable.to_string_lossy().into_owned(),
                models,
                warning,
            })
        })
        .collect()
}

#[cfg(test)]
mod failure_tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn cli_command_creates_no_console_window() {
        let script = "Add-Type -Name Native -Namespace Oris -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();'; [Oris.Native]::GetConsoleWindow().ToInt64()";
        let output = cli_command(Path::new("powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    /// 带唯一标记的测试孙进程（`ping -w <标记>`）的 PID；只查询本测试创建的进程。
    #[cfg(windows)]
    fn marked_pings(marker: u32) -> Vec<u32> {
        let script = format!("Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object {{ $_.CommandLine -match ' -w {marker} ' }} | ForEach-Object {{ $_.ProcessId }}");
        let output = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().unwrap();
        String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| line.trim().parse().ok()).collect()
    }

    /// 假的 codex 命令行工具（临时目录中的 .cmd）：记录工作目录与参数，再启动一个孙进程并等待。
    /// 取消时整个进程树都要结束（npm 安装的 codex.cmd 同样是 cmd.exe → node 两层）；工作目录是临时目录，参数带只读沙箱。
    #[cfg(windows)]
    #[test]
    fn cancelled_cli_ends_the_process_tree_and_runs_sandboxed_in_a_temp_dir() {
        let dir = tempfile::tempdir().unwrap();
        let marker = 3000 + std::process::id() % 5000;
        let record = dir.path().join("record");
        fs::create_dir_all(&record).unwrap();
        let fake = dir.path().join("fake-codex.cmd");
        let record_text = record.to_string_lossy();
        fs::write(&fake, format!("@echo off\r\ncd > \"{record_text}\\cwd.txt\"\r\necho %* > \"{record_text}\\args.txt\"\r\nping -n 30 -w {marker} 127.0.0.1 > nul\r\n")).unwrap();
        let profile = AiProfile { id: "test".into(), kind: "cli".into(), provider: "codex".into(), executable: fake.to_string_lossy().into_owned(), base_url: String::new(), model: "fake-model".into() };
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let canceller = std::thread::spawn(move || {
            // 等孙进程启动后再取消。
            let started = Instant::now();
            while marked_pings(marker).is_empty() && started.elapsed() < Duration::from_secs(20) {
                std::thread::sleep(Duration::from_millis(200));
            }
            flag.store(true, Ordering::Relaxed);
        });
        let result = run_cli(&profile, Path::new("."), "system", "prompt", &cancelled);
        canceller.join().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let left = marked_pings(marker);
        // 清理：只结束本测试标记的进程。
        for pid in &left {
            let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
        }
        assert_eq!(result.unwrap_err(), "AI 生成已取消");
        assert!(left.is_empty(), "取消后孙进程仍在运行：{left:?}");
        let cwd = fs::read_to_string(record.join("cwd.txt")).unwrap();
        let cwd = cwd.trim().to_owned();
        assert_ne!(Path::new(&cwd), std::env::current_dir().unwrap(), "不应在当前目录运行");
        let temp = std::env::temp_dir();
        let temp_long = dunce::canonicalize(&temp).unwrap_or(temp.clone());
        assert!(Path::new(&cwd).starts_with(&temp) || Path::new(&cwd).starts_with(&temp_long), "应在临时目录运行：{cwd}");
        let args = fs::read_to_string(record.join("args.txt")).unwrap();
        for expected in ["exec", "--sandbox read-only", "--ephemeral", "--skip-git-repo-check", "-m fake-model", "--output-last-message"] {
            assert!(args.contains(expected), "参数缺少 {expected}：{args}");
        }
    }

    /// npm 安装的 claude.cmd：多行系统提示词也能启动（换行换成空格），结果从 stdout 读取；参数不提供任何工具。
    #[cfg(windows)]
    #[test]
    fn claude_batch_wrapper_accepts_multiline_system_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("args.txt");
        let fake = dir.path().join("claude.cmd");
        fs::write(&fake, format!("@echo off\r\necho %* > \"{}\"\r\necho {{\"kind\":\"answer\",\"message\":\"ok\"}}\r\n", record.to_string_lossy())).unwrap();
        let profile = AiProfile { id: "test".into(), kind: "cli".into(), provider: "claude".into(), executable: fake.to_string_lossy().into_owned(), base_url: String::new(), model: "claude-haiku-4-5".into() };
        // cmd.exe 的 echo 按系统代码页写文件：这里用 ASCII 文本，读取时按字节比较。
        let output = run_cli(&profile, Path::new("."), "line1\nline2 \"quoted\"\r\nline3", "prompt", &AtomicBool::new(false)).unwrap();
        assert_eq!(parse_json_output(&output).unwrap()["message"], "ok");
        let args = String::from_utf8_lossy(&fs::read(&record).unwrap()).into_owned();
        assert!(args.contains("line1 line2") && args.contains("line3"), "{args}");
        for expected in ["-p", "--tools \"\"", "mcp__*", "--max-turns 1", "--no-session-persistence"] {
            assert!(args.contains(expected), "参数缺少 {expected}：{args}");
        }
        // .exe 等其他可执行文件原样传递。
        assert_eq!(batch_safe_argument(Path::new("claude.exe"), "a\nb"), "a\nb");
        assert_eq!(batch_safe_argument(Path::new("CLAUDE.CMD"), "a\r\nb\nc"), "a b c");
    }

    #[test]
    fn parses_versions_from_tool_output() {
        assert_eq!(parse_version("codex-cli 0.144.6"), Some((0, 144, 6)));
        assert_eq!(parse_version("codex-cli 0.158.0-alpha.2.1"), Some((0, 158, 0)));
        assert_eq!(parse_version("2.1.263 (Claude Code)"), Some((2, 1, 263)));
        assert_eq!(parse_version("no version"), None);
    }

    #[cfg(windows)]
    #[test]
    fn connection_cli_returns_text_and_honours_its_own_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("claude.cmd");
        fs::write(&fake, "@echo off\r\necho OK\r\n").unwrap();
        let profile = AiProfile { id: "connection-test".into(), kind: "cli".into(), provider: "claude".into(), executable: fake.to_string_lossy().into_owned(), base_url: String::new(), model: "fake-model".into() };
        let output = run_cli_with_timeout(&profile, CONNECTION_SYSTEM_PROMPT, CONNECTION_PROMPT, &AtomicBool::new(false), CONNECTION_TIMEOUT).unwrap();
        connection_response(&output).unwrap();
        assert_eq!(output.trim(), "OK");

        fs::write(&fake, "@echo off\r\nping -n 10 127.0.0.1 > nul\r\n").unwrap();
        let started = Instant::now();
        let error = run_cli_with_timeout(&profile, CONNECTION_SYSTEM_PROMPT, CONNECTION_PROMPT, &AtomicBool::new(false), Duration::from_secs(1)).unwrap_err();
        assert!(error.contains("超过 1 秒"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn warns_only_when_cli_is_older_than_model_cache() {
        let cache = json!({ "client_version": "0.158.0" });
        let warning = codex_version_warning("codex-cli 0.144.6", Some(&cache)).unwrap();
        assert!(warning.contains("0.144.6") && warning.contains("0.158.0"));
        assert!(codex_version_warning("codex-cli 0.158.0-alpha.2.1", Some(&cache)).is_none());
        assert!(codex_version_warning("codex-cli 0.160.0", Some(&cache)).is_none());
        assert!(codex_version_warning("codex-cli 0.144.6", Some(&json!({}))).is_none());
        assert!(codex_version_warning("codex-cli 0.144.6", None).is_none());
    }

    #[test]
    fn failure_shows_claude_stdout_error_and_login_hint() {
        let output = "\"claude-haiku-4.5\" isn't described by this version's model catalog\n\nFailed to authenticate. API Error: 401 OAuth access token is invalid.\n";
        let message = cli_failure(output, None, Some(1), None);
        assert!(message.starts_with("AI 工具退出码 1；请在终端重新登录该 AI 工具"));
        assert!(message.ends_with("工具输出：\nFailed to authenticate. API Error: 401 OAuth access token is invalid."));
    }

    #[test]
    fn failure_dedupes_codex_errors_and_appends_version_warning() {
        let error = r#"ERROR: {"type":"error","status":400,"error":{"message":"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}"#;
        let output = format!("OpenAI Codex v0.144.6\nmodel: gpt-6-astra\n{error}\n{error}\n");
        let message = cli_failure(&output, None, Some(1), Some("版本提示".into()));
        assert_eq!(message, format!("AI 工具退出码 1；请升级该 AI 工具，或改用较新的可执行文件\n工具输出：\n{error}\n版本提示"));
    }

    #[test]
    fn failure_asks_to_update_claude_for_newer_models() {
        let output = "\nAPI Error: 400 Claude Code 2.1.263 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.\n";
        assert!(cli_failure(output, None, Some(1), None).starts_with("AI 工具退出码 1；请升级该 AI 工具，或改用较新的可执行文件\n工具输出：\nAPI Error: 400"));
        assert!(CLAUDE_MODELS.iter().all(|model| model.starts_with("claude-")));
    }

    #[test]
    fn failure_recognises_unknown_claude_model() {
        let output = "\"claude-haiku-4.5\" isn't described by this version's model catalog; update Claude Code\n[claude-code:unrecognized_model] {\"model\":\"claude-haiku-4.5\"}\nThere's an issue with the selected model (claude-haiku-4.5). It may not exist or you may not have access to it.\n";
        assert_eq!(
            cli_failure(output, None, Some(1), None),
            "AI 工具退出码 1；请检查所选模型是否可用\n工具输出：\nThere's an issue with the selected model (claude-haiku-4.5). It may not exist or you may not have access to it."
        );
    }

    #[test]
    fn excerpt_falls_back_to_last_lines_and_limits_length() {
        assert_eq!(error_excerpt("a\n\nb\nc\nd\n"), "b\nc\nd");
        assert_eq!(error_excerpt("  \n"), "");
        assert_eq!(error_excerpt(&"x".repeat(900)).chars().count(), 801);
        assert_eq!(cli_failure("", Some(CLI_TIMEOUT), None, None), format!("AI 工具超过 {} 秒，已终止；请在终端运行该 AI 工具检查详细错误", CLI_TIMEOUT.as_secs()));
        assert!(cli_failure("", Some(CONNECTION_TIMEOUT), None, None).contains("超过 30 秒"));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod detection_tests {
    use super::*;

    #[test]
    fn detects_bundled_codex_when_installed() {
        let bundled = Path::new("/Applications/ChatGPT.app/Contents/Resources/codex");
        if bundled.is_file() {
            assert!(detect_tools().iter().any(|tool| tool.provider == "codex"));
        }
    }
}

fn base_url(profile: &AiProfile) -> Result<String, String> {
    let default = match profile.provider.as_str() {
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com/v1",
        "deepseek" => "https://api.deepseek.com",
        _ => "",
    };
    let base = if profile.base_url.trim().is_empty() {
        default
    } else {
        profile.base_url.trim()
    };
    let url = reqwest::Url::parse(base).map_err(|_| "Base URL 无效".to_owned())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Base URL 不得包含账号、密码、查询参数或片段".into());
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Base URL 必须使用 HTTPS；本机地址可使用 HTTP".into());
    }
    Ok(base.trim_end_matches('/').to_owned())
}

fn endpoint(base: &str, part: &str) -> String {
    format!("{}/{}", base, part.trim_start_matches('/'))
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 AI 响应失败：{}", request_error(&e)))?;
    if body.len() > 2_000_000 {
        return Err("AI 响应过大".into());
    }
    if !status.is_success() {
        let code = status.as_u16();
        return Err(match code {
            401 | 403 => format!("AI 服务拒绝了请求（HTTP {code}）：请检查 API Key 与该模型的访问权限"),
            429 => format!("AI 服务限流或额度不足（HTTP {code}）：请稍后再试；Oris 不会自动重试"),
            _ => format!("AI 服务返回 HTTP {code}，请检查 API Key、模型权限与 Base URL"),
        });
    }
    serde_json::from_str(&body).map_err(|_| "AI 响应不是 JSON".into())
}

/// reqwest 错误的中文说明（超时、连接失败单独说明，不附带英文原文以外的内部细节）。
fn request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "AI 服务在限定时间内没有响应，已停止；请检查网络或稍后重试（Oris 不会自动重试）".into()
    } else if error.is_connect() {
        "无法连接 AI 服务：请检查网络、代理与 Base URL".into()
    } else {
        format!("网络错误（{error}）")
    }
}

/// 查询模型的超时。
pub(crate) const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
/// HTTP 生成的超时。
pub(crate) const HTTP_TIMEOUT: Duration = Duration::from_secs(120);

/// API 提供方的模型列表（不读取密钥，便于测试指向本机假服务）。
pub(crate) async fn http_models(profile: &AiProfile, api_key: &str, timeout: Duration) -> Result<Vec<String>, String> {
    let base = base_url(profile)?;
    let client = reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())?;
    let request = client.get(endpoint(&base, "models"));
    let request = if profile.provider == "anthropic" {
        request.header("x-api-key", api_key).header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(api_key)
    };
    let data = response_json(request.send().await.map_err(|e| format!("模型查询失败：{}", request_error(&e)))?).await?;
    let mut models: Vec<String> = data
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}

/// API 提供方的一次生成（不读取密钥；取消时丢弃请求，连接随之关闭）。
pub(crate) async fn http_generate(profile: &AiProfile, api_key: &str, system_prompt: &str, prompt: &str, cancelled: &AtomicBool, timeout: Duration) -> Result<String, String> {
    let base = base_url(profile)?;
    let client = reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())?;
    let request = match profile.provider.as_str() {
        "anthropic" => client.post(endpoint(&base, "messages")).header("x-api-key", api_key).header("anthropic-version", "2023-06-01")
            .json(&json!({ "model": profile.model, "max_tokens": 2048, "system": system_prompt, "messages": [{"role":"user","content":prompt}] })),
        "openai" => client.post(endpoint(&base, "responses")).bearer_auth(api_key)
            .json(&json!({ "model": profile.model, "instructions": system_prompt, "input": prompt, "store": false })),
        _ => client.post(endpoint(&base, "chat/completions")).bearer_auth(api_key)
            .json(&json!({ "model": profile.model, "messages": [{"role":"system","content":system_prompt},{"role":"user","content":prompt}] })),
    };
    let response = cancellable(request.send(), cancelled).await?
        .map_err(|e| format!("AI 请求失败：{}", request_error(&e)))?;
    let data = cancellable(response_json(response), cancelled).await??;
    let content = match profile.provider.as_str() {
        "anthropic" => data.pointer("/content/0/text").and_then(Value::as_str),
        "openai" => data.get("output_text").and_then(Value::as_str).or_else(|| {
            data.get("output")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|item| {
                    item.get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .find(|item| item.get("type").and_then(Value::as_str) == Some("output_text"))
                .and_then(|item| item.get("text").and_then(Value::as_str))
        }),
        _ => data
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
    };
    content
        .map(str::to_owned)
        .ok_or_else(|| "AI 没有返回文本".into())
}

#[cfg(feature = "desktop")]
pub async fn list_models(profile: &AiProfile) -> Result<ModelList, String> {
    if profile.kind == "cli" {
        return Ok(match profile.provider.as_str() {
            "codex" => {
                let executable = cli_executable(profile);
                let warning = tauri::async_runtime::spawn_blocking(move || codex_warning_for(&executable?))
                    .await
                    .map_err(|e| e.to_string())?;
                ModelList { models: codex_models(), warning }
            }
            "claude" => ModelList { models: claude_models(), warning: None },
            _ => ModelList { models: Vec::new(), warning: None },
        });
    }
    base_url(profile)?;
    let api_key = key(&profile.id)?;
    Ok(ModelList { models: http_models(profile, &api_key, MODELS_TIMEOUT).await?, warning: None })
}

const CLI_TIMEOUT: Duration = Duration::from_secs(300);

/// 从 CLI 输出中摘出错误原文：优先取含错误关键词的行，没有时取末尾几行；去重并限长。
fn error_excerpt(output: &str) -> String {
    let lines: Vec<&str> = output.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let is_error = |line: &&str| {
        let lower = line.to_ascii_lowercase();
        ["error", "failed", "invalid", "denied", "unauthorized", "not exist"].iter().any(|word| lower.contains(word))
    };
    let picked: Vec<&str> = if lines.iter().any(is_error) { lines.iter().copied().filter(is_error).collect() } else { lines };
    let mut kept: Vec<&str> = Vec::new();
    for line in picked.into_iter().rev() {
        if !kept.contains(&line) {
            kept.push(line);
        }
        if kept.len() == 3 {
            break;
        }
    }
    kept.reverse();
    let excerpt = kept.join("\n");
    if excerpt.chars().count() > 800 {
        format!("{}…", excerpt.chars().take(800).collect::<String>())
    } else {
        excerpt
    }
}

/// `output` 为 stderr 与 stdout 的合并内容：Claude Code 的 `-p` 模式把认证等错误写到 stdout。
fn cli_failure(output: &str, timed_out: Option<Duration>, code: Option<i32>, warning: Option<String>) -> String {
    let lower = output.to_ascii_lowercase();
    let hint = if ["newer version", "or newer", "please upgrade", "claude update"].iter().any(|word| lower.contains(word)) {
        "请升级该 AI 工具，或改用较新的可执行文件"
    } else if ["login", "authenticat", "unauthorized", "401", "oauth"].iter().any(|word| lower.contains(word)) {
        "请在终端重新登录该 AI 工具"
    } else if lower.contains("model") && ["unsupported", "not found", "not exist", "unrecognized"].iter().any(|word| lower.contains(word)) {
        "请检查所选模型是否可用"
    } else if lower.contains("network") || lower.contains("connection") || lower.contains("timed out") {
        "请检查网络连接与代理配置"
    } else {
        "请在终端运行该 AI 工具检查详细错误"
    };
    let mut message = if let Some(timeout) = timed_out {
        format!("AI 工具超过 {} 秒，已终止；{hint}", timeout.as_secs())
    } else {
        format!("AI 工具退出码 {}；{hint}", code.unwrap_or(-1))
    };
    let excerpt = error_excerpt(output);
    if !excerpt.is_empty() {
        message.push_str("\n工具输出：\n");
        message.push_str(&excerpt);
    }
    if let Some(warning) = warning {
        message.push('\n');
        message.push_str(&warning);
    }
    message
}

fn run_cli(profile: &AiProfile, _cwd: &Path, system_prompt: &str, prompt: &str, cancelled: &AtomicBool) -> Result<String, String> {
    run_cli_with_timeout(profile, system_prompt, prompt, cancelled, CLI_TIMEOUT)
}

fn run_cli_with_timeout(profile: &AiProfile, system_prompt: &str, prompt: &str, cancelled: &AtomicBool, timeout: Duration) -> Result<String, String> {
    let executable = cli_executable(profile).ok_or_else(|| "未找到 AI 工具，请在设置中指定可执行文件".to_owned())?;
    let failure_output = |stderr_path: &Path, output_path: &Path| {
        let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
        let stdout = if profile.provider == "claude" { fs::read_to_string(output_path).unwrap_or_default() } else { String::new() };
        format!("{stderr}\n{stdout}")
    };
    let version_warning = || if profile.provider == "codex" { codex_warning_for(&executable) } else { None };
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let output_path = temp.path().join("result.txt");
    let stderr_path = temp.path().join("stderr.txt");
    let mut cmd = cli_command(&executable);
    match profile.provider.as_str() {
        "codex" => {
            let developer_config = format!("developer_instructions={}", serde_json::to_string(system_prompt).map_err(|e| e.to_string())?);
            cmd.arg("exec")
                .arg("--config")
                .arg(developer_config)
                .arg("--sandbox")
                .arg("read-only")
                .arg("--ephemeral")
                .arg("--skip-git-repo-check")
                .arg("-C")
                .arg(temp.path())
                .arg("-m")
                .arg(&profile.model)
                .arg("--output-last-message")
                .arg(&output_path)
                .arg("-");
            cmd.stdout(Stdio::null());
        }
        "claude" => {
            let file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
            cmd.arg("-p")
                .arg("--append-system-prompt")
                .arg(batch_safe_argument(&executable, system_prompt).as_ref())
                .arg("--model")
                .arg(&profile.model)
                .arg("--tools")
                .arg("")
                .arg("--disallowedTools")
                .arg("mcp__*")
                .arg("--max-turns")
                .arg("1")
                .arg("--no-session-persistence");
            cmd.stdout(file);
        }
        _ => return Err("不支持的 CLI 工具".into()),
    }
    let stderr_file = fs::File::create(&stderr_path).map_err(|e| e.to_string())?;
    cmd.current_dir(temp.path())
        .stdin(Stdio::piped())
        .stderr(stderr_file);
    ProcessTree::prepare(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("启动 AI 工具失败：{e}"))?;
    // 取消 / 超时时结束整棵进程树：npm 安装的 codex.cmd、claude.cmd 由 cmd.exe 再启动 node，只结束直接子进程会留下孙进程。
    let tree = ProcessTree::attach(&child);
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let start = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            end_tree(&tree, &mut child);
            return Err("AI 生成已取消".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err(cli_failure(&failure_output(&stderr_path, &output_path), None, status.code(), version_warning()));
            }
            let output = fs::read_to_string(output_path)
                .map_err(|e| format!("读取 AI 工具结果失败：{e}"))?;
            return Ok(output.chars().take(100_000).collect());
        }
        if start.elapsed() > timeout {
            end_tree(&tree, &mut child);
            return Err(cli_failure(&failure_output(&stderr_path, &output_path), Some(timeout), None, version_warning()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_SYSTEM_PROMPT: &str = "这是连通性测试。只回复 OK，不使用工具。";
const CONNECTION_PROMPT: &str = "请回复 OK。";

fn connection_response(output: &str) -> Result<(), String> {
    if output.trim().is_empty() {
        Err("AI 返回了空响应，请检查模型与服务配置".into())
    } else {
        Ok(())
    }
}

async fn http_test_connection(profile: &AiProfile, api_key: &str, timeout: Duration) -> Result<(), String> {
    let output = http_generate(profile, api_key, CONNECTION_SYSTEM_PROMPT, CONNECTION_PROMPT, &AtomicBool::new(false), timeout).await?;
    connection_response(&output)
}

/// 使用与正式生成相同的请求链路，只发送固定测试文本，不读取项目数据。
#[cfg(feature = "desktop")]
pub async fn test_connection(profile: &AiProfile) -> Result<(), String> {
    if profile.model.trim().is_empty() {
        return Err("请先为 AI 配置选择模型".into());
    }
    if profile.kind == "cli" {
        let profile = profile.clone();
        let output = tauri::async_runtime::spawn_blocking(move || {
            run_cli_with_timeout(&profile, CONNECTION_SYSTEM_PROMPT, CONNECTION_PROMPT, &AtomicBool::new(false), CONNECTION_TIMEOUT)
        }).await.map_err(|e| e.to_string())??;
        return connection_response(&output);
    }
    base_url(profile)?;
    http_test_connection(profile, &key(&profile.id)?, CONNECTION_TIMEOUT).await
}

#[cfg(feature = "desktop")]
pub async fn generate(profile: &AiProfile, cwd: &Path, system_prompt: &str, prompt: &str, cancelled: std::sync::Arc<AtomicBool>) -> Result<String, String> {
    if profile.model.trim().is_empty() {
        return Err("请先为 AI 配置选择模型".into());
    }
    if profile.kind == "cli" {
        let profile = profile.clone();
        let cwd = cwd.to_path_buf();
        let system_prompt = system_prompt.to_owned();
        let prompt = prompt.to_owned();
        return tauri::async_runtime::spawn_blocking(move || run_cli(&profile, &cwd, &system_prompt, &prompt, &cancelled))
            .await
            .map_err(|e| e.to_string())?;
    }
    base_url(profile)?;
    let api_key = key(&profile.id)?;
    http_generate(profile, &api_key, system_prompt, prompt, &cancelled, HTTP_TIMEOUT).await
}

async fn cancellable<F: std::future::Future>(future: F, cancelled: &AtomicBool) -> Result<F::Output, String> {
    let mut future = std::pin::pin!(future);
    loop {
        if cancelled.load(Ordering::Relaxed) { return Err("AI 生成已取消".into()); }
        if let Ok(result) = tokio::time::timeout(Duration::from_millis(50), &mut future).await {
            return Ok(result);
        }
    }
}

pub fn parse_json_output(output: &str) -> Result<Value, String> {
    let trimmed = output.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    let stripped = stripped.strip_suffix("```").unwrap_or(stripped).trim();
    serde_json::from_str(stripped).map_err(|_| "AI 未按要求返回 JSON，请重试或更换模型".into())
}

/// HTTP 路径对本机假模型服务的测试：服务只监听 127.0.0.1，在测试代码内启动，按脚本返回；不访问任何真实模型服务、不读取凭据。
#[cfg(test)]
mod http_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc};

    struct Reply {
        status: u16,
        body: String,
        delay: Duration,
    }

    fn ok(body: Value) -> Reply {
        Reply { status: 200, body: body.to_string(), delay: Duration::ZERO }
    }

    /// 收到的请求：路径、全部请求头（小写）与正文。
    #[derive(Debug)]
    struct Seen {
        path: String,
        headers: String,
        body: String,
    }

    /// 启动只接受一次连接的假服务；返回 base URL、请求记录，以及“回复前连接是否已被对方关闭”。
    fn serve(reply: Reply) -> (String, mpsc::Receiver<Seen>, mpsc::Receiver<bool>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, seen_rx) = mpsc::channel();
        let (closed_tx, closed_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut headers = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap_or(0);
                }
                headers.push_str(&lower);
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let path = request_line.split_whitespace().nth(1).unwrap_or("").to_owned();
            let _ = seen_tx.send(Seen { path, headers, body: String::from_utf8_lossy(&body).into_owned() });
            // 慢响应：等待期间检测对方是否已关闭连接（取消 / 超时）。
            let started = Instant::now();
            let mut probe = stream.try_clone().unwrap();
            probe.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
            while started.elapsed() < reply.delay {
                let mut byte = [0u8; 1];
                match probe.read(&mut byte) {
                    Ok(0) => {
                        let _ = closed_tx.send(true);
                        return;
                    }
                    Ok(_) => {}
                    Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    Err(_) => {
                        let _ = closed_tx.send(true);
                        return;
                    }
                }
            }
            let reason = match reply.status {
                200 => "OK",
                401 => "Unauthorized",
                429 => "Too Many Requests",
                _ => "Error",
            };
            let response = format!(
                "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.status,
                reply.body.len(),
                reply.body
            );
            let mut stream = stream;
            let _ = stream.write_all(response.as_bytes());
            let _ = closed_tx.send(false);
        });
        (format!("http://127.0.0.1:{port}/v1"), seen_rx, closed_rx)
    }

    fn profile(provider: &str, base: &str) -> AiProfile {
        AiProfile { id: "oris-test".into(), kind: "api".into(), provider: provider.into(), executable: String::new(), base_url: base.into(), model: "fake-model".into() }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    fn generate(provider: &str, reply: Reply, timeout: Duration) -> (Result<String, String>, Seen) {
        let (base, seen, _) = serve(reply);
        let cancelled = AtomicBool::new(false);
        let result = run(http_generate(&profile(provider, &base), "sk-oris-test", "系统提示", "用户输入", &cancelled, timeout));
        (result, seen.recv_timeout(Duration::from_secs(5)).unwrap())
    }

    #[test]
    fn compatible_openai_and_anthropic_requests_carry_prompt_key_and_return_the_plan() {
        let plan = json!({ "kind": "git", "summary": "暂存", "operation": { "kind": "stage", "pathIds": "all" } }).to_string();
        let (result, seen) = generate("compatible", ok(json!({ "choices": [{ "message": { "content": plan } }] })), HTTP_TIMEOUT);
        assert_eq!(result.unwrap(), plan);
        assert_eq!(seen.path, "/v1/chat/completions");
        assert!(seen.headers.contains("authorization: bearer sk-oris-test"));
        let body: Value = serde_json::from_str(&seen.body).unwrap();
        assert_eq!(body["model"], "fake-model");
        assert_eq!(body["messages"][0]["content"], "系统提示");
        assert_eq!(body["messages"][1]["content"], "用户输入");
        let (result, seen) = generate("openai", ok(json!({ "output_text": "{}" })), HTTP_TIMEOUT);
        assert_eq!(result.unwrap(), "{}");
        assert_eq!(seen.path, "/v1/responses");
        assert_eq!(serde_json::from_str::<Value>(&seen.body).unwrap()["store"], false, "OpenAI 请求不保存");
        let (result, seen) = generate("anthropic", ok(json!({ "content": [{ "type": "text", "text": "{\"kind\":\"answer\"}" }] })), HTTP_TIMEOUT);
        assert_eq!(result.unwrap(), "{\"kind\":\"answer\"}");
        assert_eq!(seen.path, "/v1/messages");
        assert!(seen.headers.contains("x-api-key: sk-oris-test") && !seen.headers.contains("authorization"));
    }

    #[test]
    fn http_errors_and_invalid_output_are_explained_in_chinese_without_retry() {
        for (status, expected) in [(401, "拒绝了请求（HTTP 401）"), (403, "拒绝了请求（HTTP 403）"), (429, "限流或额度不足（HTTP 429）"), (500, "AI 服务返回 HTTP 500")] {
            // 服务只接受一次连接：若 Oris 重试，第二次连接会失败并改变错误文字。
            let (base, seen, _) = serve(Reply { status, body: "{\"error\":\"x\"}".into(), delay: Duration::ZERO });
            let result = run(http_generate(&profile("compatible", &base), "k", "s", "p", &AtomicBool::new(false), HTTP_TIMEOUT));
            assert!(result.as_ref().unwrap_err().contains(expected), "{status}: {result:?}");
            assert!(seen.recv_timeout(Duration::from_secs(5)).is_ok());
        }
        let (result, _) = generate("compatible", Reply { status: 200, body: "<html>not json</html>".into(), delay: Duration::ZERO }, HTTP_TIMEOUT);
        assert_eq!(result.unwrap_err(), "AI 响应不是 JSON");
        let (result, _) = generate("compatible", ok(json!({ "choices": [{ "message": { "content": "好的，我来帮你暂存" } }] })), HTTP_TIMEOUT);
        assert_eq!(parse_json_output(&result.unwrap()).unwrap_err(), "AI 未按要求返回 JSON，请重试或更换模型");
        let (result, _) = generate("compatible", ok(json!({ "choices": [] })), HTTP_TIMEOUT);
        assert_eq!(result.unwrap_err(), "AI 没有返回文本");
    }

    #[test]
    fn cancel_closes_the_connection_and_timeout_is_explained() {
        // 取消：慢响应期间置位，调用立即结束，服务端看到连接被关闭。
        let (base, seen, closed) = serve(Reply { status: 200, body: "{}".into(), delay: Duration::from_secs(10) });
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let result = run(http_generate(&profile("compatible", &base), "k", "s", "p", &cancelled, HTTP_TIMEOUT));
        assert_eq!(result.unwrap_err(), "AI 生成已取消");
        assert!(started.elapsed() < Duration::from_secs(3), "取消后应立即结束：{:?}", started.elapsed());
        assert!(seen.recv_timeout(Duration::from_secs(5)).is_ok());
        assert_eq!(closed.recv_timeout(Duration::from_secs(5)), Ok(true), "取消后 HTTP 连接应关闭");
        // 超时：用短超时代替 120 s，服务端同样看到连接被关闭。
        let (base, _, closed) = serve(Reply { status: 200, body: "{}".into(), delay: Duration::from_secs(10) });
        let result = run(http_generate(&profile("compatible", &base), "k", "s", "p", &AtomicBool::new(false), Duration::from_millis(500)));
        let error = result.unwrap_err();
        assert!(error.contains("没有响应") && !error.contains("operation timed out"), "{error}");
        assert_eq!(closed.recv_timeout(Duration::from_secs(5)), Ok(true));
        // 连接失败：本机没有服务监听的端口。
        let unused = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let result = run(http_generate(&profile("compatible", &format!("http://127.0.0.1:{unused}")), "k", "s", "p", &AtomicBool::new(false), HTTP_TIMEOUT));
        assert!(result.unwrap_err().contains("无法连接 AI 服务"));
    }

    #[test]
    fn connection_test_uses_generation_routes_and_only_fixed_test_text() {
        for (provider, path, body) in [
            ("compatible", "/v1/chat/completions", json!({ "choices": [{ "message": { "content": "OK" } }] })),
            ("deepseek", "/v1/chat/completions", json!({ "choices": [{ "message": { "content": "OK" } }] })),
            ("openai", "/v1/responses", json!({ "output_text": "OK" })),
            ("anthropic", "/v1/messages", json!({ "content": [{ "type": "text", "text": "OK" }] })),
        ] {
            let (base, seen, _) = serve(ok(body));
            run(http_test_connection(&profile(provider, &base), "test-key", CONNECTION_TIMEOUT)).unwrap();
            let request = seen.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(request.path, path);
            let body: Value = serde_json::from_str(&request.body).unwrap();
            assert_eq!(body["model"], "fake-model");
            match provider {
                "openai" => { assert_eq!(body["input"], CONNECTION_PROMPT); assert_eq!(body["instructions"], CONNECTION_SYSTEM_PROMPT); }
                "anthropic" => { assert_eq!(body["messages"][0]["content"], CONNECTION_PROMPT); assert_eq!(body["system"], CONNECTION_SYSTEM_PROMPT); }
                _ => { assert_eq!(body["messages"][1]["content"], CONNECTION_PROMPT); assert_eq!(body["messages"][0]["content"], CONNECTION_SYSTEM_PROMPT); }
            }
        }
    }

    #[test]
    fn connection_test_rejects_auth_errors_empty_output_and_times_out() {
        for (reply, expected) in [
            (Reply { status: 401, body: "{}".into(), delay: Duration::ZERO }, "HTTP 401"),
            (ok(json!({ "choices": [{ "message": { "content": "  " } }] })), "空响应"),
            (ok(json!({ "choices": [] })), "没有返回文本"),
            (Reply { status: 200, body: "{}".into(), delay: Duration::from_secs(10) }, "没有响应"),
        ] {
            let (base, _, _) = serve(reply);
            let error = run(http_test_connection(&profile("compatible", &base), "test-key", Duration::from_millis(500))).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn models_are_listed_and_base_urls_are_restricted() {
        let (base, seen, _) = serve(ok(json!({ "data": [{ "id": "b" }, { "id": "a" }, { "id": "b" }] })));
        let models = run(http_models(&profile("deepseek", &base), "k", MODELS_TIMEOUT)).unwrap();
        assert_eq!(models, vec!["a", "b"]);
        assert_eq!(seen.recv_timeout(Duration::from_secs(5)).unwrap().path, "/v1/models");
        assert!(base_url(&profile("compatible", "http://example.com/v1")).unwrap_err().contains("HTTPS"));
        assert!(base_url(&profile("compatible", "https://user:pass@example.com/v1")).unwrap_err().contains("账号"));
        assert!(base_url(&profile("compatible", "https://example.com/v1?key=1")).unwrap_err().contains("查询参数"));
        assert_eq!(base_url(&profile("compatible", "http://127.0.0.1:9/v1/")).unwrap(), "http://127.0.0.1:9/v1");
        assert_eq!(base_url(&profile("openai", "")).unwrap(), "https://api.openai.com/v1");
    }
}
