//! Exercises the application's compiled context without constructing a window.
use tauri::utils::config::{FrontendDist, WebviewUrl};

fn main() {
    let context = oris_lib::application_context();
    let dist = context.config().build.frontend_dist.as_ref();
    println!("ENTRY_DIST={dist:?}");
    println!("CUSTOM_PROTOCOL={}", !tauri::is_dev());
    println!("EMBEDDED_ASSETS={}", context.assets().iter().count());
    assert!(!tauri::is_dev(), "release must use custom-protocol");
    assert!(
        matches!(dist, Some(FrontendDist::Directory(_))),
        "frontendDist must parse as Directory, never an external URL"
    );
    let main = context
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .expect("main window");
    assert!(
        matches!(&main.url, WebviewUrl::App(path) if path.to_str() == Some("index.html")),
        "main window must use embedded index.html"
    );
    println!("WINDOW_URL={:?}", main.url);
    let index = context
        .assets()
        .get(&"index.html".into())
        .expect("embedded index.html");
    let html = std::str::from_utf8(&index).expect("UTF-8 HTML");
    assert!(html.contains("id=\"root\""), "React mount missing");
    let mut scripts = 0;
    let mut styles = 0;
    for attribute in ["src=\"", "href=\""] {
        for part in html.split(attribute).skip(1) {
            let path = part.split('"').next().unwrap();
            if !(path.ends_with(".js") || path.ends_with(".css")) {
                continue;
            }
            assert!(
                path.starts_with("/assets/"),
                "unexpected resource URL: {path}"
            );
            let bytes = context
                .assets()
                .get(&path.into())
                .expect("referenced asset embedded");
            assert!(!bytes.is_empty(), "empty asset");
            if path.ends_with(".js") {
                scripts += 1;
            } else {
                styles += 1;
            }
            println!("RESOURCE_OK={path} bytes={}", bytes.len());
        }
    }
    assert!(scripts > 0 && styles > 0);
    assert!(
        context
            .assets()
            .iter()
            .any(|(path, _)| path.contains("diff-worker") && path.ends_with(".js")),
        "diff worker missing"
    );
    println!("ENTRY_ASSETS_PASS index_bytes={} scripts={scripts} styles={styles} root_request=index.html", index.len());
}
