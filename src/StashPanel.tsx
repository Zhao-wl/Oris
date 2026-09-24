import { useEffect, useState } from "react";
import { shortOid, stashChanges, stashList, statusLetter, type ChangedFile, type StashChanges, type StashEntry } from "./history-api";
import type { HistoryFileOpen } from "./HistoryPanel";
import { isStale } from "./history-model";
import { errorText } from "./error-message";
import type { FileChange } from "./types";

export interface StashPushOptions { message: string; includeUntracked: boolean; pathIds: string[] | null }

interface Props {
  repoId: string;
  /** stash 变化（watcher 的 stash 事件、写操作结束）时递增。 */
  version: number;
  hidden: boolean;
  /** 当前选中的本地文件（多选优先），用于“只储藏选中的文件”。 */
  selectedFiles: FileChange[];
  blocked: string | null;
  activeKey: string | null;
  onPush(options: StashPushOptions): Promise<boolean>;
  onApply(entry: StashEntry, pop: boolean): void;
  onDrop(entry: StashEntry): void;
  onOpenFile(open: HistoryFileOpen): void;
  onCount?(count: number): void;
}

const time = (seconds: number) => new Date(seconds * 1000).toLocaleString();

/** 底部 Git 区“Stash”页（R-STASH，参考图“Stash”场景）：储藏表单、列表、所选 stash 的文件（在同一个 diff 阅读器中查看）。 */
export default function StashPanel({ repoId, version, hidden, selectedFiles, blocked, activeKey, onPush, onApply, onDrop, onOpenFile, onCount }: Props) {
  const [entries, setEntries] = useState<StashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<StashChanges | null>(null);
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(false);
  const [onlySelected, setOnlySelected] = useState(false);
  useEffect(() => {
    let live = true;
    void stashList(repoId).then((list) => {
      if (!live) return;
      setEntries(list); setError(null); onCount?.(list.length);
      setSelected((current) => (current && list.some((e) => e.oid === current) ? current : list[0]?.oid ?? null));
    }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId, version]);
  useEffect(() => {
    if (!selected) { setChanges(null); return; }
    let live = true;
    void stashChanges(repoId, selected).then((result) => { if (live) setChanges(result); }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId, selected]);
  const entry = entries?.find((e) => e.oid === selected) ?? null;
  const pathIds = selectedFiles.flatMap((file) => (file.oldPathId ? [file.pathId, file.oldPathId] : [file.pathId]));
  const pushBlocked = blocked ?? (onlySelected && !pathIds.length ? "没有选中的文件：先在文件列表中选择（Ctrl / Shift 可多选）" : null);
  const submit = async () => {
    if (pushBlocked) return;
    const ok = await onPush({ message, includeUntracked: untracked, pathIds: onlySelected ? pathIds : null });
    if (ok) setMessage("");
  };
  const open = (file: ChangedFile, part: "tracked" | "untracked") => {
    if (!entry || !changes) return;
    const untrackedPart = part === "untracked";
    onOpenFile({
      key: `stash:${entry.oid}:${part}:${file.pathId}`,
      source: `stash@{${entry.index}}${untrackedPart ? " · 未跟踪" : ""}`,
      file,
      left: untrackedPart ? { oid: null, label: "空树（未跟踪文件）" } : { oid: changes.base, label: `储藏时的 HEAD ${shortOid(changes.base)}` },
      right: { oid: untrackedPart ? changes.untrackedCommit! : entry.oid, label: `stash@{${entry.index}}${untrackedPart ? " 未跟踪部分" : ""} ${shortOid(entry.oid)}` }
    });
  };
  const fileRows = (files: ChangedFile[], part: "tracked" | "untracked") => <ul className="log-files">{files.map((file) => <li key={part + file.pathId} className={activeKey === `stash:${entry?.oid}:${part}:${file.pathId}` ? "active" : ""}>
    <button type="button" className="log-file" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => open(file, part)}><span className={`status-letter ${file.status}`}>{statusLetter[file.status]}</span><span className="log-file-path">{file.path}</span>{file.oldPath && <span className="log-file-old">← {file.oldPath}</span>}</button>
  </li>)}</ul>;
  return <div className="git-body stash-layout" hidden={hidden}>
    <section className="stash-form" aria-label="储藏当前改动">
      <strong>储藏当前改动</strong>
      <input aria-label="stash 说明" placeholder="说明（可选）" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}/>
      <label><input type="checkbox" aria-label="包含未跟踪文件" checked={untracked} onChange={(event) => setUntracked(event.target.checked)}/> 包含未跟踪文件</label>
      <label title={selectedFiles.length ? selectedFiles.map((f) => f.displayPath).join("\n") : undefined}><input type="checkbox" aria-label="只储藏选中的文件" checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)}/> 只储藏选中的文件（{selectedFiles.length} 个）</label>
      <button type="button" className="primary" disabled={!!pushBlocked} title={pushBlocked ?? "储藏为新的 stash@{0}，工作区与暂存区中的这些改动会被移走"} onClick={() => void submit()}>储藏</button>
      {pushBlocked && <small className="commit-reason">{pushBlocked}</small>}
    </section>
    <section className="stash-list" aria-label="stash 列表">
      {error && <div className="log-error">{error}</div>}
      {entries && !entries.length && <div className="log-empty">没有 stash</div>}
      {entries?.map((item) => <div key={item.oid} role="option" aria-selected={item.oid === selected} className={`stash-row${item.oid === selected ? " selected" : ""}`} onClick={() => setSelected(item.oid)}>
        <span className="stash-text">stash@{`{${item.index}}`} · {item.message || "（无说明）"}<small>{item.branch || "—"} · {time(item.time)} · {shortOid(item.oid)}{item.untracked ? " · 含未跟踪" : ""}</small></span>
        {item.oid === selected && <span className="stash-actions">
          <button type="button" disabled={!!blocked} title={blocked ?? "应用后保留这条 stash"} onClick={(event) => { event.stopPropagation(); onApply(item, false); }}>应用</button>
          <button type="button" disabled={!!blocked} title={blocked ?? "应用成功且没有冲突后删除这条 stash；出现冲突时保留"} onClick={(event) => { event.stopPropagation(); onApply(item, true); }}>弹出</button>
          <button type="button" className="danger" disabled={!!blocked} title={blocked ?? undefined} onClick={(event) => { event.stopPropagation(); onDrop(item); }}>删除…</button>
        </span>}
      </div>)}
    </section>
    <aside className="stash-detail" aria-label="stash 内容">
      {!entry ? <div className="log-empty">选择一条 stash 查看内容</div> : !changes || changes.oid !== entry.oid ? <div className="log-empty">正在读取…</div> : <>
        <div className="log-group">已跟踪文件 · {changes.tracked.length}（相对储藏时的 HEAD {shortOid(changes.base)}）</div>
        {changes.tracked.length ? fileRows(changes.tracked, "tracked") : <div className="log-empty">没有已跟踪文件的改动</div>}
        {changes.untrackedCommit && <><div className="log-group">未跟踪文件 · {changes.untracked.length}</div>{fileRows(changes.untracked, "untracked")}</>}
      </>}
    </aside>
  </div>;
}
