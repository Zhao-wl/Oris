import { useEffect, useState } from "react";
import { shortOid, stashChanges, stashList, statusLetter, type ChangedFile, type StashChanges, type StashEntry } from "./history-api";
import type { HistoryFileOpen } from "./HistoryPanel";
import { isStale } from "./history-model";
import { errorText } from "./error-message";
import PathText from "./PathText";
import type { FileChange } from "./types";

export interface StashPushOptions { message: string; includeUntracked: boolean; pathIds: string[] | null }

const time = (seconds: number) => new Date(seconds * 1000).toLocaleString();

/** stash 列表（R-STASH）：`version` 在 stash 变化（watcher 的 stash 事件、写操作结束）时递增。 */
export function useStashList(repoId: string, version: number) {
  const [entries, setEntries] = useState<StashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void stashList(repoId).then((list) => { if (live) { setEntries(list); setError(null); } }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId, version]);
  return { entries, error };
}

export const stashLabel = (entry: StashEntry) => `stash@{${entry.index}}`;

/** “储藏当前改动”表单（历史页右侧）。 */
export function StashForm({ selectedFiles, blocked, onPush, onClose }: { selectedFiles: FileChange[]; blocked: string | null; onPush(options: StashPushOptions): Promise<boolean>; onClose(): void }) {
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(false);
  const [onlySelected, setOnlySelected] = useState(false);
  const pathIds = selectedFiles.flatMap((file) => (file.oldPathId ? [file.pathId, file.oldPathId] : [file.pathId]));
  const pushBlocked = blocked ?? (onlySelected && !pathIds.length ? "没有选中的文件：先在文件列表中选择（Ctrl / Shift 可多选）" : null);
  const submit = async () => {
    if (pushBlocked) return;
    const ok = await onPush({ message, includeUntracked: untracked, pathIds: onlySelected ? pathIds : null });
    if (ok) { setMessage(""); onClose(); }
  };
  return <section className="log-detail-body stash-form" aria-label="储藏当前改动">
    <div className="log-head"><strong>储藏当前改动</strong><span className="spacer"/><button type="button" className="quiet" onClick={onClose}>关闭</button></div>
    <input autoFocus aria-label="stash 说明" placeholder="说明（可选）" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}/>
    <label><input type="checkbox" aria-label="包含未跟踪文件" checked={untracked} onChange={(event) => setUntracked(event.target.checked)}/> 包含未跟踪文件</label>
    <label title={selectedFiles.length ? selectedFiles.map((f) => f.displayPath).join("\n") : undefined}><input type="checkbox" aria-label="只储藏选中的文件" checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)}/> 只储藏选中的文件（{selectedFiles.length} 个）</label>
    <button type="button" className="primary" disabled={!!pushBlocked} title={pushBlocked ?? "储藏为新的 stash@{0}，工作区与暂存区中的这些改动会被移走"} onClick={() => void submit()}>储藏</button>
    {pushBlocked && <small className="commit-reason">{pushBlocked}</small>}
  </section>;
}

/** 所选 stash 的内容与操作（历史页右侧）：文件在同一个 diff 阅读器中查看。 */
export function StashDetail({ repoId, entry, version, blocked, activeKey, onApply, onDrop, onOpenFile }: { repoId: string; entry: StashEntry | null; version: number; blocked: string | null; activeKey: string | null; onApply(entry: StashEntry, pop: boolean): void; onDrop(entry: StashEntry): void; onOpenFile(open: HistoryFileOpen): void }) {
  const [changes, setChanges] = useState<StashChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const oid = entry?.oid ?? null;
  useEffect(() => {
    if (!oid) { setChanges(null); return; }
    let live = true;
    setError(null);
    void stashChanges(repoId, oid).then((result) => { if (live) setChanges(result); }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId, oid, version]);
  if (!entry) return <div className="log-empty">这条 stash 已不存在</div>;
  const open = (file: ChangedFile, part: "tracked" | "untracked") => {
    if (!changes) return;
    const untrackedPart = part === "untracked";
    onOpenFile({
      key: `stash:${entry.oid}:${part}:${file.pathId}`,
      source: `${stashLabel(entry)}${untrackedPart ? " · 未跟踪" : ""}`,
      file,
      left: untrackedPart ? { oid: null, label: "空树（未跟踪文件）" } : { oid: changes.base, label: `储藏时的 HEAD ${shortOid(changes.base)}` },
      right: { oid: untrackedPart ? changes.untrackedCommit! : entry.oid, label: `${stashLabel(entry)}${untrackedPart ? " 未跟踪部分" : ""} ${shortOid(entry.oid)}` }
    });
  };
  const fileRows = (files: ChangedFile[], part: "tracked" | "untracked") => <ul className="log-files">{files.map((file) => <li key={part + file.pathId} className={activeKey === `stash:${entry.oid}:${part}:${file.pathId}` ? "active" : ""}>
    <button type="button" className="log-file" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => open(file, part)}><span className={`status-letter ${file.status}`}>{statusLetter[file.status]}</span><PathText path={file.path} className="log-file-path" title={file.path}/>{file.oldPath && <PathText path={file.oldPath} prefix="← " className="log-file-old"/>}</button>
  </li>)}</ul>;
  return <div className="log-detail-body stash-detail" aria-label="stash 内容">
    <strong className="log-detail-subject">{stashLabel(entry)} · {entry.message || "（无说明）"}</strong>
    <div className="log-meta">{entry.branch || "—"} · {time(entry.time)} · <span className="log-sha-full">{entry.oid}</span>{entry.untracked ? " · 含未跟踪" : ""}</div>
    <div className="stash-actions">
      <button type="button" disabled={!!blocked} title={blocked ?? "应用后保留这条 stash"} onClick={() => onApply(entry, false)}>应用</button>
      <button type="button" disabled={!!blocked} title={blocked ?? "应用成功且没有冲突后删除这条 stash；出现冲突时保留"} onClick={() => onApply(entry, true)}>弹出</button>
      <button type="button" className="danger" disabled={!!blocked} title={blocked ?? undefined} onClick={() => onDrop(entry)}>删除…</button>
    </div>
    {error && <div className="log-error">{error}</div>}
    {!changes || changes.oid !== entry.oid ? !error && <div className="log-empty">正在读取…</div> : <>
      <div className="log-group">已跟踪文件 · {changes.tracked.length}（相对储藏时的 HEAD {shortOid(changes.base)}）</div>
      {changes.tracked.length ? fileRows(changes.tracked, "tracked") : <div className="log-empty">没有已跟踪文件的改动</div>}
      {changes.untrackedCommit && <><div className="log-group">未跟踪文件 · {changes.untracked.length}</div>{fileRows(changes.untracked, "untracked")}</>}
    </>}
  </div>;
}
