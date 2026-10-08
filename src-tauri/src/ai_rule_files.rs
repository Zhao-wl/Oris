use std::{io::{Read, Write}, path::Path};

const MAX_RULE_BYTES: usize = 1_000_000;
fn json_path(path: &str) -> Result<&Path, String> {
    let path = Path::new(path);
    if !path.is_absolute() || !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")) {
        return Err("请选择绝对路径的 JSON 文件".into());
    }
    Ok(path)
}
pub fn read(path: &str) -> Result<String, String> {
    let mut file = std::fs::File::open(json_path(path)?).map_err(|e| format!("无法读取规则文件：{e}"))?;
    let mut bytes = Vec::new();
    (&mut file).take((MAX_RULE_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RULE_BYTES { return Err("规则文件不能超过 1 MB".into()); }
    String::from_utf8(bytes).map_err(|_| "规则文件必须使用 UTF-8 编码".into())
}
pub fn write(path: &str, content: &str) -> Result<(), String> {
    let path = json_path(path)?;
    if content.len() > MAX_RULE_BYTES { return Err("规则文件不能超过 1 MB".into()); }
    let json: serde_json::Value = serde_json::from_str(content).map_err(|_| "规则内容不是有效 JSON")?;
    if json["format"] != "oris-ai-rules" || json["version"] != 1 { return Err("规则格式或版本无效".into()); }
    let parent = path.parent().ok_or("无效的文件路径")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| format!("无法保存规则文件：{e}"))?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_failed_export_preserves_original_file() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("rules.json"); let path = path.to_str().unwrap();
        let first = r#"{"format":"oris-ai-rules","version":1,"name":"规则"}"#;
        write(path, first).unwrap(); assert_eq!(read(path).unwrap(), first);
        assert!(write(path, "invalid").is_err()); assert_eq!(read(path).unwrap(), first);
        let second = r#"{"format":"oris-ai-rules","version":1,"name":"新规则"}"#;
        write(path, second).unwrap(); assert_eq!(read(path).unwrap(), second);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn rejects_oversized_and_non_json_files() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("rules.json");
        std::fs::write(&path, vec![b'a'; MAX_RULE_BYTES + 1]).unwrap();
        assert!(read(path.to_str().unwrap()).is_err());
        assert!(read("relative.json").is_err());
        assert!(write(dir.path().join("other.txt").to_str().unwrap(), "{}").is_err());
    }
}
