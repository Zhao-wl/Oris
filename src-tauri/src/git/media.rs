use super::*;
use base64::engine::general_purpose::STANDARD;
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use std::io::{Cursor, Read};

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_EDGE: u32 = 16_384;
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_ALLOCATION: u64 = 256 * 1024 * 1024;
pub(super) struct ImageBudget {
    pixels: u64,
    allocation: u64,
}
impl Default for ImageBudget {
    fn default() -> Self {
        Self {
            pixels: MAX_PIXELS,
            allocation: MAX_ALLOCATION,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideDetails {
    pub state: &'static str,
    pub size_known: bool,
    pub reason: Option<String>,
    pub oid: Option<String>,
    pub mode: Option<String>,
    /// SHA-256 of the LFS entity when this side was stored as an LFS pointer.
    pub lfs_oid: Option<String>,
    pub image: Option<ImagePayload>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
    #[serde(skip)]
    pub allocation_bytes: u64,
    pub mime: &'static str,
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub orientation: u8,
}

fn details(state: &'static str) -> SideDetails {
    SideDetails {
        state,
        size_known: false,
        reason: None,
        oid: None,
        mode: None,
        lfs_oid: None,
        image: None,
    }
}
fn reject(side: &mut TextSide, state: &'static str, reason: impl ToString) {
    side.text = None;
    side.encoding = "binary-or-unsupported";
    let info = side.details.get_or_insert_with(|| details(state));
    info.state = state;
    info.reason = Some(reason.to_string());
    info.image = None;
}

pub fn image_path(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(OsStr::to_str)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp")
    )
}

/// Parses a complete Git LFS pointer (spec v1): `(sha256 oid, declared size)`.
pub fn lfs_pointer(bytes: &[u8]) -> Option<(String, u64)> {
    if bytes.len() >= 1024 {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.strip_suffix('\n')?.split('\n');
    if !matches!(
        lines.next()?,
        "version https://git-lfs.github.com/spec/v1" | "version https://hawser.github.com/spec/v1"
    ) {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        let (key, value) = line.split_once(' ')?;
        match key {
            "oid" => {
                let hex = value.strip_prefix("sha256:")?;
                if hex.len() != 64 || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
                    return None;
                }
                oid = Some(hex.to_owned());
            }
            "size" => size = Some(value.parse().ok()?),
            _ => {}
        }
    }
    Some((oid?, size?))
}

pub fn check_dimensions(width: u32, height: u32, remaining: u64) -> Result<u64, String> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || pixels > MAX_PIXELS
        || pixels > remaining
    {
        return Err("图片超过边长 16384 / 单图或双侧总计 40 MP 预算".into());
    }
    Ok(pixels)
}

// Inspect container chunks, never search arbitrary compressed payload for animation markers.
fn animated(bytes: &[u8], format: ImageFormat) -> Result<bool, String> {
    if format == ImageFormat::Png {
        let mut pos = 8usize;
        while pos < bytes.len() {
            let header = bytes.get(pos..pos + 8).ok_or("PNG 块截断")?;
            let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
            let end = pos
                .checked_add(12)
                .and_then(|v| v.checked_add(len))
                .ok_or("PNG 块溢出")?;
            if end > bytes.len() {
                return Err("PNG 数据截断".into());
            }
            if &header[4..8] == b"acTL" {
                return Ok(true);
            }
            if &header[4..8] == b"IEND" {
                return Ok(false);
            }
            pos = end;
        }
        return Err("PNG 缺少 IEND".into());
    }
    if format == ImageFormat::WebP {
        let size = bytes.get(4..8).ok_or("WebP 头截断")?;
        if u32::from_le_bytes(size.try_into().unwrap()) as usize + 8 != bytes.len() {
            return Err("WebP 容器长度无效".into());
        }
        let mut pos = 12usize;
        while pos < bytes.len() {
            let header = bytes.get(pos..pos + 8).ok_or("WebP 块截断")?;
            let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let end = pos
                .checked_add(8)
                .and_then(|v| v.checked_add(len + (len & 1)))
                .ok_or("WebP 块溢出")?;
            if end > bytes.len() {
                return Err("WebP 数据截断".into());
            }
            if &header[..4] == b"ANIM"
                || &header[..4] == b"ANMF"
                || (&header[..4] == b"VP8X" && bytes.get(pos + 8).is_some_and(|v| v & 2 != 0))
            {
                return Ok(true);
            }
            pos = end;
        }
    }
    if format == ImageFormat::Jpeg && !bytes.ends_with(&[0xff, 0xd9]) {
        return Err("JPEG 缺少结束标记或尾部无效".into());
    }
    Ok(false)
}

fn inspect_image(
    bytes: &[u8],
    remaining: u64,
    allocation_remaining: u64,
) -> Result<ImagePayload, String> {
    let format = image::guess_format(bytes).map_err(|_| "签名不是 PNG/JPEG/WebP")?;
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => return Err("仅支持静态 PNG/JPEG/WebP".into()),
    };
    if animated(bytes, format)? {
        return Err("动画 APNG/WebP 不支持预览".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("图片头解码失败：{e}"))?;
    let (width, height) = decoder.dimensions();
    let pixels = check_dimensions(width, height, remaining)?;
    let allocation_bytes = (pixels * 4).max(decoder.total_bytes()) + bytes.len() as u64 * 8;
    if allocation_bytes > allocation_remaining {
        return Err("双侧受控图片分配估算超过 256 MiB".into());
    }
    let orientation = decoder
        .orientation()
        .map_err(|e| format!("方向读取失败：{e}"))?
        .to_exif();
    // Validate the entire image before exposing compressed bytes to the WebView.
    let decoded =
        image::DynamicImage::from_decoder(decoder).map_err(|e| format!("图片解码失败：{e}"))?;
    drop(decoded);
    let (display_width, display_height) = if orientation >= 5 {
        (height, width)
    } else {
        (width, height)
    };
    Ok(ImagePayload {
        allocation_bytes,
        mime,
        base64: STANDARD.encode(bytes),
        width,
        height,
        display_width,
        display_height,
        orientation,
    })
}

impl GitAdapter {
    pub(super) fn read_side(
        &self,
        endpoint: &'static str,
        relative: &str,
        missing: bool,
        remaining: &mut ImageBudget,
    ) -> TextSide {
        let mut side = text_side(endpoint, Vec::new(), missing).0;
        side.details = Some(details(if missing { "missing" } else { "ready" }));
        if missing {
            return side;
        }
        let result = self.side_bytes(endpoint, relative, &mut side);
        match result {
            Err(error) => {
                reject(&mut side, "unavailable", error);
                return side;
            }
            Ok(None) => return side,
            Ok(Some(mut bytes)) => {
                side.source_id = Some(hash_bytes(&bytes));
                if image_path(relative) {
                    if let Some((oid, size)) = lfs_pointer(&bytes) {
                        side.details.as_mut().unwrap().lfs_oid = Some(oid.clone());
                        match self.lfs_object(&oid, size) {
                            Ok(object) => bytes = object,
                            Err((state, reason)) => {
                                side.content_id = hash_bytes(&bytes);
                                side.byte_length = bytes.len();
                                reject(&mut side, state, reason);
                                return side;
                            }
                        }
                    }
                }
                side.content_id = hash_bytes(&bytes);
                side.byte_length = bytes.len();
                side.details.as_mut().unwrap().size_known = true;
                let signature = image::guess_format(&bytes).ok();
                if image_path(relative)
                    || matches!(
                        signature,
                        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
                    )
                {
                    side.text = None;
                    side.encoding = "binary-or-unsupported";
                    match inspect_image(&bytes, remaining.pixels, remaining.allocation) {
                        Ok(payload) => {
                            let pixels = u64::from(payload.width) * u64::from(payload.height);
                            // Reserve RGBA plus compressed/IPC/base64/Blob copies. Native GPU copies remain platform-measured.
                            remaining.pixels -= pixels;
                            remaining.allocation -= payload.allocation_bytes;
                            side.details.as_mut().unwrap().image = Some(payload);
                        }
                        Err(reason) => reject(&mut side, "unavailable", reason),
                    }
                } else {
                    let info = side.details.take();
                    let (mut text, reason) = text_side(endpoint, bytes, false);
                    text.details = info;
                    text.source_id = side.source_id.take();
                    if let Some(reason) = reason {
                        reject(&mut text, "unavailable", reason);
                    }
                    side = text;
                }
            }
        }
        side
    }

    /// Reads a verified entity from the local LFS store only; never fetches or runs filters.
    fn lfs_object(&self, oid: &str, size: u64) -> Result<Vec<u8>, (&'static str, String)> {
        if size > MAX_IMAGE_BYTES as u64 {
            return Err((
                "overBudget",
                format!("LFS 对象声明 {size} 字节，超过每侧 20 MiB 读取预算"),
            ));
        }
        let path = self
            .common_dir
            .join("lfs")
            .join("objects")
            .join(&oid[..2])
            .join(&oid[2..4])
            .join(oid);
        let mut bytes = Vec::new();
        match fs::File::open(&path) {
            Ok(file) => file
                .take(MAX_IMAGE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| ("unavailable", format!("LFS 本地对象读取失败：{e}")))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err((
                    "unavailable",
                    format!("Git LFS 指针，本地缓存中没有该对象（不会自动拉取）：sha256 {oid}"),
                ))
            }
            Err(e) => return Err(("unavailable", format!("LFS 本地对象读取失败：{e}"))),
        };
        if bytes.len() as u64 != size || hash_bytes(&bytes) != oid {
            return Err((
                "unavailable",
                "LFS 本地对象与指针的 size/SHA-256 不一致".into(),
            ));
        }
        Ok(bytes)
    }

    pub(super) fn source_still_matches(&self, side: &TextSide, relative: &str) -> bool {
        let Some(expected) = &side.source_id else {
            return true;
        };
        let mut probe = text_side(side.endpoint, vec![], false).0;
        probe.details = Some(details("ready"));
        // Re-check source bytes, including the LFS pointer rather than decoded entity.
        // This is bounded to 20 MiB by the same safe reader as the initial read.
        matches!(self.side_bytes(side.endpoint, relative, &mut probe), Ok(Some(bytes)) if hash_bytes(&bytes) == *expected)
    }

    fn side_bytes(
        &self,
        endpoint: &str,
        relative: &str,
        side: &mut TextSide,
    ) -> Result<Option<Vec<u8>>, GitError> {
        validate_relative(relative)?;
        if endpoint == "workingTree" {
            let mut path = self.worktree.clone();
            for component in Path::new(relative).components() {
                path.push(component);
                match fs::symlink_metadata(&path) {
                    Ok(meta) if meta.file_type().is_symlink() => return Err(GitError::UnsafePath),
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        *side = text_side("workingTree", vec![], true).0;
                        side.details = Some(details("missing"));
                        return Ok(None);
                    }
                    Err(e) => return Err(GitError::Io(e.to_string())),
                }
            }
            let meta = fs::symlink_metadata(&path).map_err(|e| GitError::Io(e.to_string()))?;
            if !meta.is_file() {
                return Err(GitError::UnsafePath);
            }
            side.byte_length = meta.len() as usize;
            side.details.as_mut().unwrap().size_known = true;
            if meta.len() > MAX_IMAGE_BYTES as u64 {
                reject(side, "overBudget", "输入超过每侧 20 MiB 读取预算");
                return Ok(None);
            }
            let mut bytes = Vec::new();
            fs::File::open(path)
                .map_err(|e| GitError::Io(e.to_string()))?
                .take((MAX_IMAGE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| GitError::Io(e.to_string()))?;
            if bytes.len() > MAX_IMAGE_BYTES {
                reject(side, "overBudget", "读取期间输入超过 20 MiB");
                return Ok(None);
            }
            return Ok(Some(bytes));
        }
        let output = if endpoint == "head" {
            run_required(
                &self.git,
                &self.worktree,
                &["ls-tree", "-z", "HEAD", "--", relative],
            )?
        } else {
            run_required(
                &self.git,
                &self.worktree,
                &["ls-files", "--stage", "-z", "--", relative],
            )?
        };
        let stage = match endpoint {
            "stage1" => "1",
            "stage2" => "2",
            "stage3" => "3",
            _ => "0",
        };
        let record = output
            .stdout
            .split(|b| *b == 0)
            .filter_map(|record| {
                let tab = record.iter().position(|b| *b == b'\t')?;
                if &record[tab + 1..] != relative.as_bytes() {
                    return None;
                }
                let fields: Vec<&str> = std::str::from_utf8(&record[..tab])
                    .ok()?
                    .split_whitespace()
                    .collect();
                if fields.len() != 3 || (endpoint != "head" && fields[2] != stage) {
                    return None;
                }
                Some((
                    fields[0].to_owned(),
                    fields[if endpoint == "head" { 2 } else { 1 }].to_owned(),
                ))
            })
            .next();
        let Some((mode, oid)) = record else {
            side.text = Some(String::new());
            side.encoding = "missing";
            side.details = Some(details("missing"));
            return Ok(None);
        };
        let info = side.details.as_mut().unwrap();
        info.oid = Some(oid.clone());
        info.mode = Some(mode.clone());
        if mode != "100644" && mode != "100755" {
            reject(
                side,
                "unsupported",
                format!("不支持普通内容读取的 Git mode {mode}"),
            );
            return Ok(None);
        }
        let size = run_required(&self.git, &self.worktree, &["cat-file", "-s", &oid])?;
        let size: usize = String::from_utf8_lossy(&size.stdout)
            .trim()
            .parse()
            .map_err(|_| GitError::Io("对象大小不可用".into()))?;
        side.byte_length = size;
        side.details.as_mut().unwrap().size_known = true;
        if size > MAX_IMAGE_BYTES {
            reject(side, "overBudget", "输入超过每侧 20 MiB 读取预算");
            return Ok(None);
        }
        // Immutable OID and preflight size bound cat-file output; raw blobs never run filters.
        Ok(Some(
            run_required(&self.git, &self.worktree, &["cat-file", "blob", &oid])?.stdout,
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, RgbaImage};
    fn encoded(format: ImageFormat, w: u32, h: u32) -> Vec<u8> {
        let image =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, image::Rgba([40, 80, 120, 160])));
        let mut out = Cursor::new(Vec::new());
        if format == ImageFormat::Jpeg {
            image.to_rgb8().write_to(&mut out, format).unwrap();
        } else {
            image.write_to(&mut out, format).unwrap();
        }
        out.into_inner()
    }
    #[test]
    fn dimensions_at_and_around_limits() {
        for edge in [MAX_EDGE - 1, MAX_EDGE] {
            assert!(check_dimensions(edge, 1, MAX_PIXELS).is_ok());
        }
        assert!(check_dimensions(MAX_EDGE + 1, 1, MAX_PIXELS).is_err());
        for remaining in [MAX_PIXELS - 1, MAX_PIXELS, MAX_PIXELS + 1] {
            assert_eq!(
                check_dimensions(8000, 5000, remaining).is_ok(),
                remaining >= MAX_PIXELS
            );
        }
        assert!(check_dimensions(8000, 5001, MAX_PIXELS).is_err());
        assert!(check_dimensions(8000, 4999, MAX_PIXELS).is_ok());
        assert!(check_dimensions(0, 1, MAX_PIXELS).is_err());
    }
    #[test]
    fn decode_preflight_edges_pixels_and_allocation() {
        let bytes = encoded(ImageFormat::Png, MAX_EDGE, 1);
        assert!(inspect_image(&bytes, MAX_PIXELS, MAX_ALLOCATION).is_ok());
        let bytes = encoded(ImageFormat::Png, MAX_EDGE + 1, 1);
        assert!(inspect_image(&bytes, MAX_PIXELS, MAX_ALLOCATION).is_err());
        let bytes = encoded(ImageFormat::Png, 7, 3);
        for remaining in [20, 21, 22] {
            assert_eq!(
                inspect_image(&bytes, remaining, MAX_ALLOCATION).is_ok(),
                remaining >= 21
            );
        }
        let allocation = 7 * 3 * 4 + bytes.len() as u64 * 8;
        for available in [allocation - 1, allocation, allocation + 1] {
            assert_eq!(
                inspect_image(&bytes, MAX_PIXELS, available).is_ok(),
                available >= allocation
            );
        }
    }
    #[test]
    #[ignore = "explicit 40 MP full decode boundary probe"]
    fn forty_megapixel_decode_boundary() {
        let bytes = encoded(ImageFormat::Png, 8000, 5000);
        assert!(inspect_image(&bytes, MAX_PIXELS - 1, MAX_ALLOCATION).is_err());
        assert!(inspect_image(&bytes, MAX_PIXELS, MAX_ALLOCATION).is_ok());
        assert!(inspect_image(&bytes, MAX_PIXELS + 1, MAX_ALLOCATION).is_ok());
        let bytes = encoded(ImageFormat::Png, 8000, 5001);
        assert!(inspect_image(&bytes, MAX_PIXELS, MAX_ALLOCATION).is_err());
    }
    #[test]
    fn static_formats_transparency_truncation_animation_and_orientation() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let bytes = encoded(format, 7, 3);
            let image = inspect_image(&bytes, MAX_PIXELS, MAX_ALLOCATION).unwrap();
            assert_eq!((image.width, image.height), (7, 3));
            assert!(inspect_image(&bytes[..bytes.len() / 2], MAX_PIXELS, MAX_ALLOCATION).is_err());
        }
        let mut png = encoded(ImageFormat::Png, 7, 3);
        let chunk = [
            0, 0, 0, 8, b'a', b'c', b'T', b'L', 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        png.splice(33..33, chunk);
        assert!(inspect_image(&png, MAX_PIXELS, MAX_ALLOCATION)
            .unwrap_err()
            .contains("动画"));
        let mut webp = encoded(ImageFormat::WebP, 7, 3);
        webp.extend_from_slice(&[b'A', b'N', b'I', b'M', 0, 0, 0, 0]);
        let len = (webp.len() - 8) as u32;
        webp[4..8].copy_from_slice(&len.to_le_bytes());
        assert!(inspect_image(&webp, MAX_PIXELS, MAX_ALLOCATION)
            .unwrap_err()
            .contains("动画"));
        let jpeg = encoded(ImageFormat::Jpeg, 7, 3);
        for orientation in 1u8..=8 {
            let mut bytes = jpeg.clone();
            let exif = [
                0xff,
                0xe1,
                0,
                34,
                b'E',
                b'x',
                b'i',
                b'f',
                0,
                0,
                b'I',
                b'I',
                42,
                0,
                8,
                0,
                0,
                0,
                1,
                0,
                0x12,
                1,
                3,
                0,
                1,
                0,
                0,
                0,
                orientation,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
            ];
            bytes.splice(2..2, exif);
            let decoded = inspect_image(&bytes, MAX_PIXELS, MAX_ALLOCATION).unwrap();
            assert_eq!(decoded.orientation, orientation);
            assert_eq!(
                (decoded.display_width, decoded.display_height),
                if orientation >= 5 { (3, 7) } else { (7, 3) }
            );
        }
    }
    fn git(root: &Path, args: &[&str]) {
        assert!(git_command(Path::new("git"))
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    fn manifest(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn collect(root: &Path, path: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    collect(root, &path, out)
                } else {
                    out.push((
                        path.strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(path).unwrap(),
                    ));
                }
            }
        }
        let mut result = vec![];
        collect(root, root, &mut result);
        result.sort();
        result
    }
    #[test]
    fn lfs_pointer_resolves_from_local_store_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        let image = encoded(ImageFormat::Png, 5, 4);
        let oid = hash_bytes(&image);
        let pointer = |oid: &str, size: usize| {
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {size}\n")
        };
        assert_eq!(
            lfs_pointer(pointer(&oid, image.len()).as_bytes()),
            Some((oid.clone(), image.len() as u64))
        );
        assert_eq!(lfs_pointer(pointer("xyz", 1).as_bytes()), None);
        assert_eq!(lfs_pointer(&image), None);
        fs::write(root.join("a.png"), pointer(&oid, image.len())).unwrap();
        fs::write(root.join("b.png"), pointer(&"0".repeat(64), 10)).unwrap();
        git(root, &["add", "."]);
        let store = root
            .join(".git/lfs/objects")
            .join(&oid[..2])
            .join(&oid[2..4]);
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join(&oid), &image).unwrap();
        let adapter = GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap();
        let mut budget = ImageBudget::default();
        let side = adapter.read_side("index", "a.png", false, &mut budget);
        let details = side.details.unwrap();
        assert_eq!(details.lfs_oid.as_deref(), Some(oid.as_str()));
        assert_eq!(details.image.unwrap().width, 5);
        assert_eq!(side.byte_length, image.len());
        let side = adapter.read_side("workingTree", "a.png", false, &mut budget);
        assert_eq!(side.details.unwrap().image.unwrap().height, 4);
        let missing = adapter.read_side("index", "b.png", false, &mut budget);
        let details = missing.details.unwrap();
        assert_eq!(details.state, "unavailable");
        assert!(details.reason.unwrap().contains("本地缓存中没有"));
        fs::write(store.join(&oid), &image[1..]).unwrap();
        let corrupt = adapter.read_side("index", "a.png", false, &mut budget);
        assert!(corrupt.details.unwrap().reason.unwrap().contains("不一致"));
    }
    #[test]
    fn change_filter_skips_ignored_and_object_writes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        fs::write(root.join(".gitignore"), "Library/\n*.tmp\n").unwrap();
        fs::create_dir_all(root.join("Library/sub")).unwrap();
        let adapter = GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap();
        let filter = adapter.change_filter();
        let root = dunce::canonicalize(root).unwrap();
        let ignored = vec![
            root.join("Library/sub/a.bin"),
            root.join("x.tmp"),
            root.join(".git/objects/ab/cd"),
            root.join(".git/lfs/tmp/x"),
        ];
        assert!(!filter.relevant(&ignored));
        assert!(filter.relevant(&[ignored.clone(), vec![root.join("src.png")]].concat()));
        assert!(filter.relevant(&[root.join(".git/index")]));
        assert!(filter.relevant(&[PathBuf::new()]));
    }
    #[test]
    fn real_git_three_scopes_missing_empty_bad_and_readonly() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.name", "Oris"]);
        git(root, &["config", "user.email", "oris@example.invalid"]);
        let path = root.join("image [x].png");
        fs::write(&path, encoded(ImageFormat::Png, 2, 3)).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(&path, encoded(ImageFormat::Jpeg, 4, 5)).unwrap();
        git(root, &["add", "."]);
        fs::write(&path, encoded(ImageFormat::WebP, 6, 7)).unwrap();
        let before = manifest(root);
        let adapter = GitAdapter::open(root.to_string_lossy().into_owned(), None).unwrap();
        for (scope, widths) in [
            (CompareScope::Staged, (2, 4)),
            (CompareScope::Unstaged, (4, 6)),
            (CompareScope::All, (2, 6)),
        ] {
            let snapshot = adapter.snapshot_for_scope("s".into(), scope).unwrap();
            let pair = adapter
                .read_content_pair_for_scope(
                    "p".into(),
                    scope,
                    snapshot.revision,
                    snapshot.files[0].path_id.clone(),
                )
                .unwrap();
            assert_eq!(pair.left.details.unwrap().image.unwrap().width, widths.0);
            assert_eq!(pair.right.details.unwrap().image.unwrap().width, widths.1);
        }
        assert_eq!(manifest(root), before);
        fs::write(&path, []).unwrap();
        let mut budget = ImageBudget::default();
        let empty = adapter.read_side("workingTree", "image [x].png", false, &mut budget);
        assert_eq!(empty.byte_length, 0);
        assert_eq!(empty.details.unwrap().state, "unavailable");
        fs::remove_file(&path).unwrap();
        let absent = adapter.read_side("workingTree", "image [x].png", false, &mut budget);
        assert_eq!(absent.encoding, "missing");
        for size in [MAX_IMAGE_BYTES - 1, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES + 1] {
            let file = fs::File::create(&path).unwrap();
            file.set_len(size as u64).unwrap();
            let side = adapter.read_side("workingTree", "image [x].png", false, &mut budget);
            assert_eq!(side.byte_length, size);
            assert_eq!(
                side.details.unwrap().state == "overBudget",
                size > MAX_IMAGE_BYTES
            );
        }
    }
}
