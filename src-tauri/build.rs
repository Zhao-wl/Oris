fn main() {
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            assert!(
                !tauri_build::is_dev(),
                "Oris release requires --features tauri/custom-protocol"
            );
        }
        if !tauri_build::is_dev() {
            use tauri_utils::{config::FrontendDist, platform::Target};
            let root = std::env::current_dir().expect("build directory");
            let target = Target::from_triple(&std::env::var("TARGET").unwrap());
            let (base, _) =
                tauri_utils::config::parse::read_from(target, &root).expect("Tauri config");
            let overlay: serde_json::Value = std::env::var("TAURI_CONFIG")
                .map(|text| serde_json::from_str(&text).expect("TAURI_CONFIG JSON"))
                .unwrap_or(serde_json::Value::Null);
            let value = overlay
                .pointer("/build/frontendDist")
                .or_else(|| base.pointer("/build/frontendDist"))
                .expect("frontendDist")
                .clone();
            let dist: FrontendDist = serde_json::from_value(value).expect("frontendDist type");
            println!("cargo:warning=Oris production frontendDist parsed as {dist:?}");
            let FrontendDist::Directory(path) = dist else {
                panic!("Oris release frontendDist must be an embedded directory, not a URL; use a relative path without a Windows drive prefix");
            };
            assert!(
                root.join(path).join("index.html").is_file(),
                "release frontendDist/index.html is missing"
            );
        }
        tauri_build::build();
        // Tauri links the Common Controls activation manifest into bins only.
        // The no-window entry verifier is an example and needs the same manifest.
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
            let resource = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
                "libresource.a"
            } else {
                "resource.lib"
            };
            let path =
                std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join(resource);
            println!("cargo:rustc-link-arg-examples={}", path.display());
        }
    }
}
