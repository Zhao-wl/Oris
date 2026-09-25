//! 任务 04 预制模块：分支与上游（R-BRANCH）。
//!
//! ahead / behind 来自 `for-each-ref` 的 `%(upstream:track)`，由 Git 按真实可达性计算；
//! 无上游、上游已消失、未知三种情况分别表达，不能用 0/0 代替。浅克隆的可达性不完整，记为未知。
#![cfg_attr(not(test), allow(dead_code))]
use super::{run_readonly, run_required, GitError};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Tracking {
    /// 没有配置上游。
    NoUpstream,
    /// 配置了上游，但对应的远端跟踪引用已不存在。
    Gone { upstream: String },
    /// 基于本地引用快照的领先 / 落后提交数（不代表服务器实时状态）。
    Known { upstream: String, ahead: u64, behind: u64 },
    /// 无法可靠计算（例如浅克隆、解析失败）。
    Unknown { upstream: String, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// 完整引用名，如 `refs/heads/main`、`refs/remotes/origin/main`。
    pub full_name: String,
    /// 短名，如 `main`、`origin/main`。
    pub name: String,
    pub kind: BranchKind,
    pub oid: String,
    /// 当前工作分支（HEAD 指向的本地分支）。
    pub current: bool,
    /// 仅本地分支有上游信息；远端跟踪分支为 None。
    pub tracking: Option<Tracking>,
    /// 本地分支上游所属的 remote（`branch.<name>.remote`）；远端跟踪分支为其所属 remote。
    pub remote: Option<String>,
}

/// 指向提交的标签（附注标签已解引用到提交）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    /// 完整引用名，如 `refs/tags/v1.0`。
    pub full_name: String,
    pub name: String,
    /// 标签最终指向的提交 OID。
    pub oid: String,
    /// 附注标签（有标签对象）。
    pub annotated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadState {
    /// 当前分支完整名；detached 或读取失败时为 None。
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub detached: bool,
    /// 当前分支尚无提交（空仓库）。
    pub unborn: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub head: HeadState,
    pub local: Vec<Branch>,
    pub remote: Vec<Branch>,
    /// 指向提交的标签；指向树 / blob 或多层嵌套的标签不列出。
    pub tags: Vec<Tag>,
    pub shallow: bool,
    /// 已配置的 remote 名称（`git remote`）。
    pub remotes: Vec<String>,
}

/// 解析 `%(upstream:track,nobracket)`：空字符串表示与上游一致。
pub fn parse_track(value: &str) -> Option<Result<(u64, u64), ()>> {
    let value = value.trim();
    if value == "gone" {
        return None;
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in value.split(", ").filter(|p| !p.is_empty()) {
        let (word, number) = part.split_once(' ')?;
        let Ok(number) = number.parse::<u64>() else { return Some(Err(())) };
        match word {
            "ahead" => ahead = number,
            "behind" => behind = number,
            _ => return Some(Err(())),
        }
    }
    Some(Ok((ahead, behind)))
}

pub fn read_head(git: &Path, worktree: &Path) -> HeadState {
    let symbolic = run_readonly(git, worktree, &["symbolic-ref", "-q", "HEAD"]).ok().filter(|o| o.status.success());
    let branch = symbolic.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).filter(|s| !s.is_empty());
    let oid = run_readonly(git, worktree, &["rev-parse", "-q", "--verify", "HEAD^{commit}"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
    HeadState { detached: branch.is_none() && oid.is_some(), unborn: branch.is_some() && oid.is_none(), branch, oid }
}

pub fn read_refs(git: &Path, worktree: &Path) -> Result<RefsSnapshot, GitError> {
    let head = read_head(git, worktree);
    let shallow = run_readonly(git, worktree, &["rev-parse", "--is-shallow-repository"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false);
    let output = run_required(
        git,
        worktree,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00%(upstream:track,nobracket)%00%(symref)%00%(upstream:remotename)%00%(*objectname)%00%(*objecttype)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let rows: Vec<Vec<&str>> = text.lines().map(|line| line.split('\0').collect()).filter(|f: &Vec<&str>| f.len() == 9).collect();
    let existing: HashSet<&str> = rows.iter().map(|f| f[0]).collect();
    let (mut local, mut remote, mut tags) = (Vec::new(), Vec::new(), Vec::new());
    for fields in &rows {
        let (full_name, oid, object_type, upstream, track, symref, remote_name) = (fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]);
        if let Some(name) = full_name.strip_prefix("refs/tags/") {
            let (peeled, peeled_type) = (fields[7], fields[8]);
            let target = match object_type {
                "commit" => Some((oid, false)),
                "tag" if peeled_type == "commit" => Some((peeled, true)),
                _ => None,
            };
            if let Some((target, annotated)) = target {
                tags.push(Tag { full_name: full_name.to_owned(), name: name.to_owned(), oid: target.to_owned(), annotated });
            }
            continue;
        }
        // refs/remotes/<remote>/HEAD 是指向默认分支的符号引用，不作为独立分支。
        if !symref.is_empty() || object_type != "commit" {
            continue;
        }
        if let Some(name) = full_name.strip_prefix("refs/heads/") {
            let tracking = if upstream.is_empty() {
                Tracking::NoUpstream
            } else if !existing.contains(upstream) || track.trim() == "gone" {
                Tracking::Gone { upstream: upstream.to_owned() }
            } else if shallow {
                Tracking::Unknown { upstream: upstream.to_owned(), reason: "浅克隆的提交历史不完整，领先 / 落后数不可靠".into() }
            } else {
                match parse_track(track) {
                    Some(Ok((ahead, behind))) => Tracking::Known { upstream: upstream.to_owned(), ahead, behind },
                    None => Tracking::Gone { upstream: upstream.to_owned() },
                    Some(Err(())) => Tracking::Unknown { upstream: upstream.to_owned(), reason: format!("无法解析上游状态：{track}") },
                }
            };
            local.push(Branch {
                full_name: full_name.to_owned(),
                name: name.to_owned(),
                kind: BranchKind::Local,
                oid: oid.to_owned(),
                current: head.branch.as_deref() == Some(full_name),
                tracking: Some(tracking),
                remote: (!remote_name.is_empty()).then(|| remote_name.to_owned()),
            });
        } else if let Some(name) = full_name.strip_prefix("refs/remotes/") {
            remote.push(Branch {
                full_name: full_name.to_owned(),
                name: name.to_owned(),
                kind: BranchKind::Remote,
                oid: oid.to_owned(),
                current: false,
                tracking: None,
                remote: None,
            });
        }
    }
    let remotes: Vec<String> = run_readonly(git, worktree, &["remote"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default();
    // 远端跟踪分支按最长匹配的 remote 名归属（remote 名本身可以含 `/`）。
    for branch in &mut remote {
        branch.remote = remotes.iter().filter(|r| branch.name.starts_with(&format!("{r}/"))).max_by_key(|r| r.len()).cloned();
    }
    Ok(RefsSnapshot { head, local, remote, tags, shallow, remotes })
}
