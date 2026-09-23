use super::*;

#[derive(Clone)]
pub(super) struct ReadSnapshot {
    pub revision: String,
    pub files: HashMap<String, (FileChange, String)>,
}

// Catalogs are obtained once per listing, not once per file. Reads query only
// the selected paths, so unrelated worktree/index/ref edits cannot starve them.
pub(super) type Catalog = HashMap<Vec<u8>, Vec<u8>>;
fn catalog(bytes: &[u8]) -> Catalog {
    let mut result: Catalog = HashMap::new();
    for entry in bytes.split(|b| *b == 0).filter(|v| !v.is_empty()) {
        if let Some(tab) = entry.iter().position(|b| *b == b'\t') {
            let value = result.entry(entry[tab + 1..].to_vec()).or_default();
            value.extend_from_slice(&entry[..tab]);
            value.push(0);
        }
    }
    result
}
impl GitAdapter {
    pub(super) fn guard_catalogs(
        &self,
        scope: CompareScope,
        paths: &[&str],
    ) -> Result<(Catalog, Catalog), GitError> {
        let mut args = vec!["ls-files", "--stage", "-z", "--"];
        args.extend_from_slice(paths);
        let index = catalog(&run_required(&self.git, &self.worktree, &args)?.stdout);
        let head = if scope != CompareScope::Unstaged && self.has_head() {
            let mut args = vec!["ls-tree", "-r", "-z", "HEAD", "--"];
            args.extend_from_slice(paths);
            catalog(&run_required(&self.git, &self.worktree, &args)?.stdout)
        } else {
            Catalog::new()
        };
        Ok((index, head))
    }
    fn file_guard(
        &self,
        scope: CompareScope,
        file: &FileChange,
        index: &Catalog,
        head: &Catalog,
    ) -> Result<String, GitError> {
        let path = URL_SAFE_NO_PAD
            .decode(&file.path_id)
            .map_err(|_| GitError::UnsafePath)?;
        let old = file
            .old_path_id
            .as_ref()
            .map(|p| URL_SAFE_NO_PAD.decode(p))
            .transpose()
            .map_err(|_| GitError::UnsafePath)?
            .unwrap_or_else(|| path.clone());
        let mut hash = Sha256::new();
        for key in [&path, &old] {
            hash.update(key);
            // Index membership also protects transitions into/out of conflict.
            hash.update(index.get(key).map(Vec::as_slice).unwrap_or_default());
            if scope != CompareScope::Unstaged {
                hash.update(head.get(key).map(Vec::as_slice).unwrap_or_default());
            }
        }
        if scope != CompareScope::Staged || matches!(file.status, FileStatus::Conflicted) {
            if let Ok(relative) = std::str::from_utf8(&path) {
                validate_relative(relative)?;
                match fs::symlink_metadata(self.worktree.join(relative)) {
                    Ok(meta) => {
                        hash.update([
                            1,
                            u8::from(meta.is_file()),
                            u8::from(meta.file_type().is_symlink()),
                        ]);
                        hash.update(meta.len().to_le_bytes());
                        update_modified(&mut hash, &meta);
                    }
                    Err(error) => hash.update(format!("{:?}", error.kind())),
                }
            }
        }
        Ok(hex::encode(hash.finalize()))
    }
    pub(super) fn capture_read_snapshot(
        &self,
        scope: CompareScope,
        revision: String,
        files: &[FileChange],
        catalogs: (Catalog, Catalog),
    ) -> Result<ReadSnapshot, GitError> {
        let (index, head) = catalogs;
        let mut guards = HashMap::new();
        for file in files {
            guards.insert(
                file.path_id.clone(),
                (file.clone(), self.file_guard(scope, file, &index, &head)?),
            );
        }
        Ok(ReadSnapshot {
            revision,
            files: guards,
        })
    }
    pub(super) fn selected_guard(
        &self,
        scope: CompareScope,
        file: &FileChange,
    ) -> Result<String, GitError> {
        let path = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(&file.path_id)
                .map_err(|_| GitError::UnsafePath)?,
        )
        .map_err(|_| GitError::UnsupportedPathEncoding)?;
        let old = file
            .old_path_id
            .as_ref()
            .map(|p| URL_SAFE_NO_PAD.decode(p))
            .transpose()
            .map_err(|_| GitError::UnsafePath)?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| GitError::UnsupportedPathEncoding)?
            .unwrap_or_else(|| path.clone());
        let (index, head) = self.guard_catalogs(scope, &[&path, &old])?;
        self.file_guard(scope, file, &index, &head)
    }
}
