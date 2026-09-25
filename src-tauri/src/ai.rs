//! AI 只负责生成文本与文件建议；Git 写入始终走 ops 写通道。
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc},
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

fn codex_models() -> Vec<String> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|p| PathBuf::from(p).join(".codex"))
        });
    let Some(root) = root else { return Vec::new() };
    let Ok(bytes) = fs::read(root.join("models_cache.json")) else {
        return Vec::new();
    };
    let Ok(data) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    data.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("slug").and_then(Value::as_str))
        .take(100)
        .map(str::to_owned)
        .collect()
}

pub fn detect_tools() -> Vec<ToolCandidate> {
    [("codex", "codex"), ("claude", "claude")]
        .into_iter()
        .filter_map(|(provider, name)| {
            let executable = find_executable(name)?;
            let mut process = Command::new(&executable)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            let started = Instant::now();
            let okay = loop {
                if let Ok(Some(status)) = process.try_wait() {
                    break status.success();
                }
                if started.elapsed() > Duration::from_secs(5) {
                    let _ = process.kill();
                    let _ = process.wait();
                    break false;
                }
                std::thread::sleep(Duration::from_millis(30));
            };
            if !okay {
                return None;
            }
            let models = if provider == "codex" {
                codex_models()
            } else {
                vec!["sonnet".into(), "opus".into(), "haiku".into()]
            };
            Some(ToolCandidate {
                provider: provider.into(),
                executable: executable.to_string_lossy().into_owned(),
                models,
            })
        })
        .collect()
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

pub async fn list_models(profile: &AiProfile) -> Result<Vec<String>, String> {
    if profile.kind == "cli" {
        return Ok(match profile.provider.as_str() {
            "codex" => codex_models(),
            "claude" => vec!["sonnet".into(), "opus".into(), "haiku".into()],
            _ => Vec::new(),
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
    Ok(models)
}

const CLI_TIMEOUT: Duration = Duration::from_secs(300);

fn cli_failure(stderr: &str, timed_out: bool, code: Option<i32>) -> String {
    let lower = stderr.to_ascii_lowercase();
    let hint = if lower.contains("login") || lower.contains("authentication") || lower.contains("unauthorized") {
        "请检查 AI 工具的登录状态"
    } else if lower.contains("model") && (lower.contains("unsupported") || lower.contains("not found") || lower.contains("does not exist")) {
        "请检查所选模型是否可用"
    } else if lower.contains("network") || lower.contains("connection") || lower.contains("timed out") {
        "请检查网络连接与代理配置"
    } else {
        "请在终端运行该 AI 工具检查详细错误"
    };
    if timed_out {
        format!("AI 工具超过 {} 秒，已终止；{hint}", CLI_TIMEOUT.as_secs())
    } else {
        format!("AI 工具退出码 {}；{hint}", code.unwrap_or(-1))
    }
}

fn run_cli(profile: &AiProfile, _cwd: &Path, system_prompt: &str, prompt: &str, cancelled: &AtomicBool) -> Result<String, String> {
    let executable = if profile.executable.trim().is_empty() {
        find_executable(&profile.provider).ok_or_else(|| "未找到 AI 工具，请在设置中指定可执行文件".to_owned())?
    } else {
        PathBuf::from(profile.executable.trim())
    };
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let output_path = temp.path().join("result.txt");
    let stderr_path = temp.path().join("stderr.txt");
    let mut cmd = Command::new(&executable);
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
    let mut child = cmd.spawn().map_err(|e| format!("启动 AI 工具失败：{e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let start = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("AI 生成已取消".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
                return Err(cli_failure(&stderr, false, status.code()));
            }
            let output = fs::read_to_string(output_path)
                .map_err(|e| format!("读取 AI 工具结果失败：{e}"))?;
            return Ok(output.chars().take(100_000).collect());
        }
        if start.elapsed() > CLI_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
            return Err(cli_failure(&stderr, true, None));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub async fn generate(profile: &AiProfile, cwd: &Path, system_prompt: &str, prompt: &str, cancelled: Arc<AtomicBool>) -> Result<String, String> {
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
