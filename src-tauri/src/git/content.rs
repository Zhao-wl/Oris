//! V2 ContentReader（技术方案 §5.2）：HEAD / index / 冲突 stage 按扫描时记录的 OID 经常驻
//! `cat-file --batch` 读取，工作区直接读文件系统。读取前后各做一次快速守卫：只 stat `.git/index`、
//! 读 HEAD/refs 文件与选中路径的工作区 stat；只有 index 或 HEAD 真的变化时才补一次单路径精确核对。
use super::media::ImageBudget;
use super::scan::{wt_stat, ScanState};
use super::status_v2::{Entry, Stage};
use super::*;

enum Source<'a> {
    Missing,
    NotFound,
    Object(&'a Stage),
    /// 工作区；附带 status 记录的工作区 mode 与子模块标志（用于识别 gitlink 目录与 mode 变化）。
    Worktree { mode: Option<&'a str>, sub: Option<&'a str> },
}

pub(super) fn decode_path(id: &str) -> Result<String, GitError> {
    let bytes = URL_SAFE_NO_PAD.decode(id).map_err(|_| GitError::UnsafePath)?;
    let relative = String::from_utf8(bytes).map_err(|_| GitError::UnsupportedPathEncoding)?;
    validate_relative(&relative)?;
    Ok(relative)
}

/// 某路径在 HEAD 中的对象：直接条目，或作为 rename 原路径出现在另一条目中。
fn head_stage<'a>(state: &'a ScanState, path_id: &str) -> Option<&'a Stage> {
    if let Some(entry) = state.entries.get(path_id) {
        if entry.old_path_id.is_none() {
            return entry.head.as_ref();
        }
    }
    state
        .entries
        .values()
        .find(|e| e.old_path_id.as_deref() == Some(path_id))
        .and_then(|e| e.head.as_ref())
}

fn expected_index(entry: Option<&Entry>) -> Vec<u8> {
    let mut expected = Vec::new();
    if let Some(entry) = entry {
        if let Some(stages) = &entry.conflict {
            for (number, stage) in stages.iter().enumerate() {
                if let Some(stage) = stage {
                    expected.extend_from_slice(format!("{} {} {}", stage.mode, stage.oid, number + 1).as_bytes());
                    expected.push(0);
                }
            }
        } else if let Some(index) = &entry.index {
            expected.extend_from_slice(format!("{} {} 0", index.mode, index.oid).as_bytes());
            expected.push(0);
        }
    }
    expected
}

fn expected_head(stage: Option<&Stage>) -> Vec<u8> {
    stage
        .map(|s| {
            let mut value = format!("{} blob {}", s.mode, s.oid).into_bytes();
            value.push(0);
            value
        })
        .unwrap_or_default()
}

impl GitAdapter {
    /// 读取前后的守卫：内容仍对应所请求的 revision，否则返回 StaleRequest（旧结果不落屏，A03）。
    fn guard(&self, state: &ScanState, scope: CompareScope, change: &FileChange) -> Result<(), GitError> {
        let conflicted = matches!(change.status, FileStatus::Conflicted);
        if scope != CompareScope::Staged || conflicted {
            if let Ok(relative) = decode_path(&change.path_id) {
                let now = wt_stat(&self.worktree.join(&relative));
                if state.wt.get(&change.path_id).is_some_and(|recorded| *recorded != now) {
                    return Err(GitError::StaleRequest);
                }
            }
        }
        let index_changed = self.index_stat() != state.index_stat;
        let head_changed = scope != CompareScope::Unstaged && self.refs_digest()? != state.refs_digest;
        if !index_changed && !head_changed {
            return Ok(());
        }
        let path = decode_path(&change.path_id)?;
        let old = change.old_path_id.as_deref().map(decode_path).transpose()?;
        let mut paths = vec![path.as_str()];
        if let Some(old) = old.as_deref() {
            paths.push(old);
        }
        let (index, head) = self.guard_catalogs(scope, &paths)?;
        if index_changed {
            let now = index.get(path.as_bytes()).cloned().unwrap_or_default();
            if now != expected_index(state.entries.get(&change.path_id)) {
                return Err(GitError::StaleRequest);
            }
        }
        if head_changed {
            let key = old.as_deref().unwrap_or(&path);
            let key_id = change.old_path_id.as_deref().unwrap_or(&change.path_id);
            let now = head.get(key.as_bytes()).cloned().unwrap_or_default();
            if now != expected_head(head_stage(state, key_id)) {
                return Err(GitError::StaleRequest);
            }
        }
        Ok(())
    }

    fn side_from(
        &self,
        endpoint: &'static str,
        relative: &str,
        source: Source<'_>,
        budget: &mut ImageBudget,
    ) -> TextSide {
        match source {
            Source::Missing => self.read_side_with(endpoint, relative, true, budget, |_| Ok(None)),
            Source::NotFound => self.read_side_with(endpoint, relative, false, budget, |side| {
                Self::not_found(side);
                Ok(None)
            }),
            Source::Object(stage) => self.read_side_with(endpoint, relative, false, budget, |side| {
                self.object_bytes(side, &stage.oid, &stage.mode)
            }),
            Source::Worktree { mode, sub } => self.read_side_with(endpoint, relative, false, budget, |side| {
                if self.worktree_special(relative, side, mode, sub)? {
                    return Ok(None);
                }
                let bytes = self.worktree_bytes(relative, side)?;
                if bytes.is_some() {
                    if let Some(info) = side.details.as_mut() {
                        info.mode = mode.filter(|m| *m != "000000").map(str::to_owned);
                    }
                }
                Ok(bytes)
            }),
        }
    }

    pub fn read_content_pair_cancellable(
        &self,
        request_id: String,
        scope: CompareScope,
        requested_revision: String,
        path_id: String,
        versions: Option<[ConflictVersion; 2]>,
        cancelled: impl Fn() -> bool,
    ) -> Result<ContentPair, GitError> {
        if cancelled() {
            return Err(GitError::StaleRequest);
        }
        let relative = decode_path(&path_id)?;
        let state = self.scan_state(&requested_revision).ok_or(GitError::StaleRequest)?;
        let change = state.change(scope, &path_id).ok_or(GitError::StaleRequest)?;
        self.guard(&state, scope, &change)?;
        let entry = state.entries.get(&path_id);
        let worktree = Source::Worktree {
            mode: entry.and_then(|e| e.worktree_mode.as_deref()),
            sub: entry.and_then(|e| e.sub.as_deref()),
        };
        let mut budget = ImageBudget::default();
        let (left, right) = if matches!(change.status, FileStatus::Conflicted) {
            let versions = versions.unwrap_or([ConflictVersion::Stage2, ConflictVersion::Stage3]);
            let stages = entry.and_then(|e| e.conflict.as_ref()).ok_or(GitError::StaleRequest)?;
            let read = |version: ConflictVersion, budget: &mut ImageBudget| {
                let source = match version {
                    ConflictVersion::WorkingTree => Source::Worktree { mode: None, sub: None },
                    ConflictVersion::Stage1 => stages[0].as_ref().map_or(Source::NotFound, Source::Object),
                    ConflictVersion::Stage2 => stages[1].as_ref().map_or(Source::NotFound, Source::Object),
                    ConflictVersion::Stage3 => stages[2].as_ref().map_or(Source::NotFound, Source::Object),
                };
                self.side_from(version.endpoint(), &relative, source, budget)
            };
            let left = read(versions[0], &mut budget);
            if cancelled() {
                return Err(GitError::StaleRequest);
            }
            (left, read(versions[1], &mut budget))
        } else {
            let old_relative = change
                .old_path_id
                .as_deref()
                .map(decode_path)
                .transpose()?
                .unwrap_or_else(|| relative.clone());
            let no_left = matches!(change.status, FileStatus::Added | FileStatus::Untracked);
            let left_missing = no_left || (scope != CompareScope::Unstaged && !state.has_head);
            let left_source = if left_missing {
                Source::Missing
            } else if scope == CompareScope::Unstaged {
                entry.and_then(|e| e.index.as_ref()).map_or(Source::NotFound, Source::Object)
            } else {
                let key = change.old_path_id.as_deref().unwrap_or(&path_id);
                head_stage(&state, key).map_or(Source::NotFound, Source::Object)
            };
            let left_endpoint = if left_missing { "emptyTree" } else { scope.left_endpoint() };
            let left = self.side_from(left_endpoint, &old_relative, left_source, &mut budget);
            if cancelled() {
                return Err(GitError::StaleRequest);
            }
            let right_source = if scope == CompareScope::Staged {
                entry.and_then(|e| e.index.as_ref()).map_or(Source::NotFound, Source::Object)
            } else {
                worktree
            };
            (left, self.side_from(scope.right_endpoint(), &relative, right_source, &mut budget))
        };
        // 读取后的代次检查由调用方负责（lib.rs）；这里只做内容守卫，不重试。
        self.guard(&state, scope, &change)?;
        let degradation = [left.details.as_ref(), right.details.as_ref()]
            .into_iter()
            .flatten()
            .find_map(|d| d.reason.clone());
        Ok(ContentPair {
            request_id,
            repo_id: self.repo_id.clone(),
            revision: requested_revision,
            path_id,
            display_path: change.display_path.clone(),
            left,
            right,
            stale: false,
            degradation,
        })
    }
}

fn is_commit_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 历史版本（任务 04）：两端都是已固定的提交 OID，按 `ls-tree` 查到的对象 OID 经常驻 cat-file 读取。
/// 从不读取 index 或工作区，因此历史中的合并提交不会用当前 index 的冲突 stage 冒充（A09）。
impl GitAdapter {
    /// commit:path → 对象（mode + OID）。只读 `ls-tree`，路径按字面量匹配；该提交中没有此路径时返回 None。
    pub fn tree_entry(&self, commit: &str, relative: &str) -> Result<Option<Stage>, GitError> {
        if !is_commit_oid(commit) {
            return Err(GitError::CommandFailed(format!("无效的提交 OID：{commit}")));
        }
        validate_relative(relative)?;
        let output = run_required(&self.git, &self.worktree, &["ls-tree", "-z", "--full-tree", commit, "--", relative])?;
        for record in output.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let Some(tab) = record.iter().position(|b| *b == b'\t') else { continue };
            if &record[tab + 1..] != relative.as_bytes() {
                continue;
            }
            let meta = String::from_utf8_lossy(&record[..tab]).into_owned();
            let mut parts = meta.split(' ');
            if let (Some(mode), Some(_kind), Some(oid)) = (parts.next(), parts.next(), parts.next()) {
                return Ok(Some(Stage { mode: mode.to_owned(), oid: oid.to_owned() }));
            }
        }
        Ok(None)
    }

    /// 读取某文件在两个提交中的内容。`left` 为 None 表示空树（根提交相对空树）；
    /// `old_path_id` 为 rename 时左侧的原路径。
    pub fn read_revision_pair(
        &self,
        request_id: String,
        left: Option<&str>,
        right: &str,
        path_id: &str,
        old_path_id: Option<&str>,
        cancelled: impl Fn() -> bool,
    ) -> Result<ContentPair, GitError> {
        let relative = decode_path(path_id)?;
        let old_relative = old_path_id.map(decode_path).transpose()?.unwrap_or_else(|| relative.clone());
        let mut budget = ImageBudget::default();
        let left_side = match left {
            None => self.side_from("emptyTree", &old_relative, Source::Missing, &mut budget),
            Some(commit) => match self.tree_entry(commit, &old_relative)? {
                Some(stage) => self.side_from("commit", &old_relative, Source::Object(&stage), &mut budget),
                None => self.side_from("commit", &old_relative, Source::NotFound, &mut budget),
            },
        };
        if cancelled() {
            return Err(GitError::StaleRequest);
        }
        let right_side = match self.tree_entry(right, &relative)? {
            Some(stage) => self.side_from("commit", &relative, Source::Object(&stage), &mut budget),
            None => self.side_from("commit", &relative, Source::NotFound, &mut budget),
        };
        if cancelled() {
            return Err(GitError::StaleRequest);
        }
        let degradation = [left_side.details.as_ref(), right_side.details.as_ref()].into_iter().flatten().find_map(|d| d.reason.clone());
        Ok(ContentPair {
            request_id,
            repo_id: self.repo_id.clone(),
            revision: format!("{}..{right}", left.unwrap_or("empty")),
            path_id: path_id.to_owned(),
            display_path: relative,
            left: left_side,
            right: right_side,
            stale: false,
            degradation,
        })
    }
}

/// 预取上限：只预取两侧都不超过该字节数的文本（技术方案 §5.7）。
pub const PREFETCH_LIMIT: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameHeader<'a> {
    pair: &'a ContentPair,
    text_ranges: [Option<(usize, usize)>; 2],
    image_ranges: [Option<(usize, usize)>; 2],
}

impl ContentPair {
    /// 二进制帧：`ORC1` + u32（LE）头长度 + JSON 头 + 载荷。文本与图片字节放在载荷中，
    /// 避免 JSON 字符串转义与 base64 的膨胀（技术方案 §5.2）。
    pub fn encode_frame(mut self) -> Vec<u8> {
        let mut payload = Vec::new();
        let mut text_ranges = [None, None];
        let mut image_ranges = [None, None];
        for (index, side) in [&mut self.left, &mut self.right].into_iter().enumerate() {
            if let Some(text) = side.text.take() {
                text_ranges[index] = Some((payload.len(), text.len()));
                payload.extend_from_slice(text.as_bytes());
            }
            if let Some(image) = side.details.as_mut().and_then(|d| d.image.as_mut()) {
                let raw = std::mem::take(&mut image.raw);
                image_ranges[index] = Some((payload.len(), raw.len()));
                payload.extend_from_slice(&raw);
            }
        }
        let header = serde_json::to_vec(&FrameHeader { pair: &self, text_ranges, image_ranges })
            .unwrap_or_else(|_| b"{}".to_vec());
        let mut frame = Vec::with_capacity(8 + header.len() + payload.len());
        frame.extend_from_slice(b"ORC1");
        frame.extend_from_slice(&(header.len() as u32).to_le_bytes());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(&payload);
        frame
    }
}

impl GitAdapter {
    /// 预取前的有界检查：冲突、图片、任一侧超过 `limit` 字节时不预取。
    /// 对象侧用有界读取探测大小（≤ 上限的对象同时进入 BlobCache，正式读取直接命中）。
    pub fn prefetch_allowed(
        &self,
        scope: CompareScope,
        revision: &str,
        path_id: &str,
        limit: usize,
    ) -> Result<bool, GitError> {
        let state = self.scan_state(revision).ok_or(GitError::StaleRequest)?;
        let change = state.change(scope, path_id).ok_or(GitError::StaleRequest)?;
        if matches!(change.status, FileStatus::Conflicted) || media::image_path(&change.display_path) {
            return Ok(false);
        }
        if scope != CompareScope::Staged {
            if let Some(stat) = state.wt.get(path_id) {
                if stat.len as usize > limit {
                    return Ok(false);
                }
            }
        }
        let entry = state.entries.get(path_id);
        let mut objects: Vec<&Stage> = Vec::new();
        match scope {
            CompareScope::Unstaged => objects.extend(entry.and_then(|e| e.index.as_ref())),
            CompareScope::Staged => {
                objects.extend(entry.and_then(|e| e.index.as_ref()));
                objects.extend(head_stage(&state, change.old_path_id.as_deref().unwrap_or(path_id)));
            }
            CompareScope::All => objects.extend(head_stage(&state, change.old_path_id.as_deref().unwrap_or(path_id))),
        }
        for stage in objects {
            if stage.mode != "100644" && stage.mode != "100755" {
                return Ok(false);
            }
            if let object_reader::BlobRead::TooLarge(_) = self.reader.with(|r| r.read_blob_limited(&stage.oid, limit))? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
