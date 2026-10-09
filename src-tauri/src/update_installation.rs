//! 只允许已复制到标准应用目录的 macOS 包更新，排除 DMG、开发目录及 App Translocation。
use std::path::Path;

pub fn macos_installation(executable: &Path, home: Option<&Path>) -> bool {
    let Some(macos) = executable.parent() else { return false };
    let Some(contents) = macos.parent() else { return false };
    let Some(bundle) = contents.parent() else { return false };
    if macos.file_name().is_none_or(|name| name != "MacOS")
        || contents.file_name().is_none_or(|name| name != "Contents")
        || bundle.extension().is_none_or(|extension| extension != "app")
    { return false; }
    let Some(directory) = bundle.parent() else { return false };
    directory == Path::new("/Applications")
        || home.is_some_and(|home| directory == home.join("Applications"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_only_updates_installed_bundles() {
        let home = Some(Path::new("/Users/test"));
        for path in ["/Applications/Oris.app/Contents/MacOS/oris", "/Users/test/Applications/Oris.app/Contents/MacOS/oris"] {
            assert!(macos_installation(Path::new(path), home), "{path}");
        }
        for path in ["/Volumes/Oris/Oris.app/Contents/MacOS/oris", "/private/var/AppTranslocation/test/d/Oris.app/Contents/MacOS/oris", "/tmp/Applications/Oris.app/Contents/MacOS/oris", "/Applications/oris", "/Applications/Oris.app/oris", "/Users/other/Applications/Oris.app/Contents/MacOS/oris", "/tmp/target/release/oris"] {
            assert!(!macos_installation(Path::new(path), home), "{path}");
        }
        assert!(!macos_installation(Path::new("/Users/test/Applications/Oris.app/Contents/MacOS/oris"), None));
    }
}
