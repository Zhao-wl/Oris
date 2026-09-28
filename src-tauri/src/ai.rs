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

    #[test]
    fn parses_versions_from_tool_output() {
        assert_eq!(parse_version("codex-cli 0.144.6"), Some((0, 144, 6)));
        assert_eq!(parse_version("codex-cli 0.158.0-alpha.2.1"), Some((0, 158, 0)));
        assert_eq!(parse_version("2.1.263 (Claude Code)"), Some((2, 1, 263)));
        assert_eq!(parse_version("no version"), None);
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
        let message = cli_failure(output, false, Some(1), None);
        assert!(message.starts_with("AI 工具退出码 1；请在终端重新登录该 AI 工具"));
        assert!(message.ends_with("工具输出：\nFailed to authenticate. API Error: 401 OAuth access token is invalid."));
    }

    #[test]
    fn failure_dedupes_codex_errors_and_appends_version_warning() {
        let error = r#"ERROR: {"type":"error","status":400,"error":{"message":"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}"#;
        let output = format!("OpenAI Codex v0.144.6\nmodel: gpt-6-astra\n{error}\n{error}\n");
        let message = cli_failure(&output, false, Some(1), Some("版本提示".into()));
        assert_eq!(message, format!("AI 工具退出码 1；请升级该 AI 工具，或改用较新的可执行文件\n工具输出：\n{error}\n版本提示"));
    }

    #[test]
    fn failure_asks_to_update_claude_for_newer_models() {
        let output = "\nAPI Error: 400 Claude Code 2.1.263 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.\n";
        assert!(cli_failure(output, false, Some(1), None).starts_with("AI 工具退出码 1；请升级该 AI 工具，或改用较新的可执行文件\n工具输出：\nAPI Error: 400"));
        assert!(CLAUDE_MODELS.iter().all(|model| model.starts_with("claude-")));
    }

    #[test]
    fn failure_recognises_unknown_claude_model() {
        let output = "\"claude-haiku-4.5\" isn't described by this version's model catalog; update Claude Code\n[claude-code:unrecognized_model] {\"model\":\"claude-haiku-4.5\"}\nThere's an issue with the selected model (claude-haiku-4.5). It may not exist or you may not have access to it.\n";
        assert_eq!(
            cli_failure(output, false, Some(1), None),
            "AI 工具退出码 1；请检查所选模型是否可用\n工具输出：\nThere's an issue with the selected model (claude-haiku-4.5). It may not exist or you may not have access to it."
        );
    }

    #[test]
    fn excerpt_falls_back_to_last_lines_and_limits_length() {
        assert_eq!(error_excerpt("a\n\nb\nc\nd\n"), "b\nc\nd");
        assert_eq!(error_excerpt("  \n"), "");
        assert_eq!(error_excerpt(&"x".repeat(900)).chars().count(), 801);
        assert_eq!(cli_failure("", true, None, None), format!("AI 工具超过 {} 秒，已终止；请在终端运行该 AI 工具检查详细错误", CLI_TIMEOUT.as_secs()));
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
        .map_err(|e| format!("读取 AI 响应失败：{e}"))?;
    if body.len() > 2_000_000 {
        return Err("AI 响应过大".into());
    }
    if !status.is_success() {
        return Err(format!(
            "AI 服务返回 HTTP {}，请检查 API Key、模型权限与 Base URL",
            status.as_u16()
        ));
    }
    serde_json::from_str(&body).map_err(|_| "AI 响应不是 JSON".into())
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
    let base = base_url(profile)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let api_key = key(&profile.id)?;
    let request = client.get(endpoint(&base, "models"));
    let request = if profile.provider == "anthropic" {
        request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(api_key)
    };
    let data = response_json(
        request
            .send()
            .await
            .map_err(|e| format!("模型查询失败：{e}"))?,
    )
    .await?;
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
    Ok(ModelList { models, warning: None })
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
fn cli_failure(output: &str, timed_out: bool, code: Option<i32>, warning: Option<String>) -> String {
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
    let mut message = if timed_out {
        format!("AI 工具超过 {} 秒，已终止；{hint}", CLI_TIMEOUT.as_secs())
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
                .arg(system_prompt)
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
                return Err(cli_failure(&failure_output(&stderr_path, &output_path), false, status.code(), version_warning()));
            }
            let output = fs::read_to_string(output_path)
                .map_err(|e| format!("读取 AI 工具结果失败：{e}"))?;
            return Ok(output.chars().take(100_000).collect());
        }
        if start.elapsed() > CLI_TIMEOUT {
            end_tree(&tree, &mut child);
            return Err(cli_failure(&failure_output(&stderr_path, &output_path), true, None, version_warning()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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
    let base = base_url(profile)?;
    let api_key = key(&profile.id)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let request = match profile.provider.as_str() {
        "anthropic" => client.post(endpoint(&base, "messages")).header("x-api-key", api_key).header("anthropic-version", "2023-06-01")
            .json(&json!({ "model": profile.model, "max_tokens": 2048, "system": system_prompt, "messages": [{"role":"user","content":prompt}] })),
        "openai" => client.post(endpoint(&base, "responses")).bearer_auth(api_key)
            .json(&json!({ "model": profile.model, "instructions": system_prompt, "input": prompt, "store": false })),
        _ => client.post(endpoint(&base, "chat/completions")).bearer_auth(api_key)
            .json(&json!({ "model": profile.model, "messages": [{"role":"system","content":system_prompt},{"role":"user","content":prompt}] })),
    };
    let response = cancellable(request.send(), &cancelled).await?
        .map_err(|e| format!("AI 请求失败：{e}"))?;
    let data = cancellable(response_json(response), &cancelled).await??;
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
