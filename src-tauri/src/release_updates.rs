//! macOS 当前发布手动 DMG，不能用仅含 Windows 的 Tauri 更新清单检查版本。
use reqwest::Client;
use semver::Version;
use serde::Deserialize;
use std::time::Duration;

const RELEASES_API: &str = "https://api.github.com/repos/Zhao-wl/Oris/releases";
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 10;

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    state: String,
    size: u64,
}

#[derive(Debug)]
pub struct ManualUpdate {
    pub version: Version,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub release_page: String,
}

fn select_release(releases: Vec<Release>, current: &Version, arch: &str) -> Option<ManualUpdate> {
    releases
        .into_iter()
        .filter_map(|release| {
            let version = Version::parse(
                release
                    .tag_name
                    .strip_prefix('v')
                    .unwrap_or(&release.tag_name),
            )
            .ok()?;
            if release.draft
                || release.prerelease
                || !version.pre.is_empty()
                || release.published_at.is_none()
                || !version.cmp_precedence(current).is_gt()
            {
                return None;
            }
            let dmg = format!("Oris_{version}_{arch}.dmg");
            let universal = format!("Oris_{version}_universal.dmg");
            if !release.assets.iter().any(|asset| {
                asset.state == "uploaded"
                    && asset.size > 0
                    && (asset.name == dmg || asset.name == universal)
            }) {
                return None;
            }
            Some(ManualUpdate {
                version,
                notes: release.body.filter(|body| !body.trim().is_empty()),
                date: release
                    .published_at
                    .map(|date| date.split('T').next().unwrap_or(&date).to_string()),
                // URL 由固定仓库与已通过 semver 校验的 tag 构造，不接受服务端提供的任意 URL。
                release_page: format!(
                    "https://github.com/Zhao-wl/Oris/releases/tag/{}",
                    release.tag_name
                ),
            })
        })
        .max_by(|a, b| a.version.cmp_precedence(&b.version))
}

pub async fn check_macos_release(
    current: &Version,
    arch: &str,
) -> Result<Option<ManualUpdate>, String> {
    fetch_releases(RELEASES_API, current, arch).await
}

async fn fetch_releases(
    endpoint: &str,
    current: &Version,
    arch: &str,
) -> Result<Option<ManualUpdate>, String> {
    if !matches!(arch, "aarch64" | "x86_64") {
        return Err(format!("不支持的 macOS 架构：{arch}"));
    }
    let client = Client::builder()
        .user_agent(concat!("Oris/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("更新网络组件不可用：{e}"))?;
    let mut newest: Option<ManualUpdate> = None;
    for page in 1..=MAX_PAGES {
        let response = client
            .get(format!("{endpoint}?per_page={PAGE_SIZE}&page={page}"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("无法获取 macOS 更新信息：{e}"))?;
        if matches!(response.status().as_u16(), 403 | 429) {
            return Err("GitHub 更新请求被限制，请稍后重试".into());
        }
        let releases: Vec<Release> = response
            .error_for_status()
            .map_err(|e| format!("无法获取 macOS 更新信息：{e}"))?
            .json()
            .await
            .map_err(|e| format!("macOS 更新信息格式无效：{e}"))?;
        let last_page = releases.len() < PAGE_SIZE;
        if let Some(candidate) = select_release(releases, current, arch) {
            if newest
                .as_ref()
                .is_none_or(|previous| candidate.version.cmp_precedence(&previous.version).is_gt())
            {
                newest = Some(candidate);
            }
        }
        if last_page {
            return Ok(newest);
        }
    }
    Err("macOS 发布记录过多，未能完成更新检查，请打开 GitHub Releases 查看".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn release(version: &str, arch: &str) -> Value {
        json!({
            "tag_name": format!("v{version}"), "draft": false, "prerelease": false,
            "body": "修复问题", "published_at": "2026-10-08T15:13:01Z",
            "assets": [{"name": format!("Oris_{version}_{arch}.dmg"), "state": "uploaded", "size": 100}]
        })
    }

    fn select(values: Vec<Value>, current: &str, arch: &str) -> Option<ManualUpdate> {
        select_release(
            serde_json::from_value(json!(values)).unwrap(),
            &Version::parse(current).unwrap(),
            arch,
        )
    }

    #[test]
    fn finds_mac_only_release_and_uses_its_tag_page() {
        // Windows latest.json 仍是 0.8.2，不影响 macOS 找到独立发布的 0.8.3。
        let update = select(
            vec![
                release("0.8.3", "aarch64"),
                release("0.8.2", "x64-setup.exe"),
            ],
            "0.8.2",
            "aarch64",
        )
        .unwrap();
        assert_eq!(update.version.to_string(), "0.8.3");
        assert_eq!(update.notes.as_deref(), Some("修复问题"));
        assert_eq!(update.date.as_deref(), Some("2026-10-08"));
        assert_eq!(
            update.release_page,
            "https://github.com/Zhao-wl/Oris/releases/tag/v0.8.3"
        );
    }

    #[test]
    fn filters_architecture_and_accepts_universal_bundles() {
        assert!(select(vec![release("0.8.3", "aarch64")], "0.8.2", "x86_64").is_none());
        for arch in ["aarch64", "x86_64"] {
            assert!(select(vec![release("0.8.3", arch)], "0.8.2", arch).is_some());
            assert!(select(vec![release("0.8.3", "universal")], "0.8.2", arch).is_some());
        }
    }

    #[test]
    fn ignores_unpublished_prerelease_invalid_or_unavailable_assets() {
        let mut values = vec![];
        for field in ["draft", "prerelease"] {
            let mut value = release("0.9.0", "aarch64");
            value[field] = json!(true);
            values.push(value);
        }
        values.push(release("0.9.0-beta.1", "aarch64"));
        values.push(release("not-a-version", "aarch64"));
        let mut unpublished = release("0.9.0", "aarch64");
        unpublished["published_at"] = Value::Null;
        values.push(unpublished);
        for (field, value) in [
            ("state", json!("new")),
            ("size", json!(0)),
            ("name", json!("Oris_0.9.0_aarch64.dmg.sha256")),
        ] {
            let mut invalid = release("0.9.0", "aarch64");
            invalid["assets"][0][field] = value;
            values.push(invalid);
        }
        assert!(select(values, "0.8.2", "aarch64").is_none());
    }

    #[test]
    fn compares_semver_and_never_downgrades() {
        let values = vec![
            release("0.9.0", "aarch64"),
            release("0.10.0", "aarch64"),
            release("0.8.3", "aarch64"),
        ];
        assert_eq!(
            select(values, "0.8.2", "aarch64")
                .unwrap()
                .version
                .to_string(),
            "0.10.0"
        );
        for current in ["0.8.3", "0.8.4", "0.8.3+build.1"] {
            assert!(select(vec![release("0.8.3", "aarch64")], current, "aarch64").is_none());
        }
        let mut blank = release("0.8.3", "aarch64");
        blank["body"] = json!("  \n");
        assert!(select(vec![blank], "0.8.2", "aarch64")
            .unwrap()
            .notes
            .is_none());
    }

    // 只创建短生命周期的本机 HTTP 服务，不启动应用或操作系统窗口。
    fn server(responses: Vec<(u16, String)>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/releases", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let response = format!(
                    "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
                requests.push(String::from_utf8(request).unwrap());
            }
            requests
        });
        (endpoint, handle)
    }

    #[test]
    fn fetches_all_pages_and_sets_github_headers() {
        let first = vec![release("0.9.0", "x86_64"); PAGE_SIZE];
        let (endpoint, server) = server(vec![
            (200, json!(first).to_string()),
            (200, json!([release("0.8.3", "aarch64")]).to_string()),
        ]);
        let update = run(fetch_releases(
            &endpoint,
            &Version::parse("0.8.2").unwrap(),
            "aarch64",
        ))
        .unwrap()
        .unwrap();
        assert_eq!(update.version.to_string(), "0.8.3");
        let requests = server.join().unwrap();
        assert!(requests[0].contains("per_page=100&page=1"));
        assert!(requests[1].contains("per_page=100&page=2"));
        assert!(requests[0].to_lowercase().contains("user-agent: oris/"));
        assert!(requests[0].contains("application/vnd.github+json"));
    }

    #[test]
    fn network_failures_are_errors_instead_of_up_to_date() {
        for (status, body) in [(403, "{}"), (429, "{}"), (500, "{}"), (200, "invalid json")] {
            let (endpoint, server) = server(vec![(status, body.into())]);
            let error = run(fetch_releases(
                &endpoint,
                &Version::parse("0.8.2").unwrap(),
                "aarch64",
            ))
            .unwrap_err();
            if matches!(status, 403 | 429) {
                assert!(error.contains("请稍后重试"));
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn empty_release_list_is_success_without_an_update() {
        let (endpoint, server) = server(vec![(200, "[]".into())]);
        assert!(run(fetch_releases(
            &endpoint,
            &Version::parse("0.8.3").unwrap(),
            "aarch64"
        ))
        .unwrap()
        .is_none());
        server.join().unwrap();
    }

    #[test]
    fn rejects_unsupported_architecture_without_a_network_request() {
        assert!(run(check_macos_release(
            &Version::parse("0.8.3").unwrap(),
            "unknown"
        ))
        .unwrap_err()
        .contains("不支持"));
    }

    #[test]
    fn reports_incomplete_check_when_pagination_limit_is_reached() {
        let body = json!(vec![release("0.8.3", "aarch64"); PAGE_SIZE]).to_string();
        let (endpoint, server) = server(vec![(200, body); MAX_PAGES]);
        assert!(run(fetch_releases(
            &endpoint,
            &Version::parse("0.8.2").unwrap(),
            "aarch64"
        ))
        .unwrap_err()
        .contains("未能完成"));
        assert_eq!(server.join().unwrap().len(), MAX_PAGES);
    }
}
