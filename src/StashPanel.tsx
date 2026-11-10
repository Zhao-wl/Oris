import { useCallback, useEffect, useRef, useState } from "react";
import { shortOid, stashChanges, stashList, type ChangedFile, type StashChanges, type StashEntry } from "./history-api";
import type { HistoryFileOpen } from "./HistoryPanel";
import { isStale } from "./history-model";
import { errorText } from "./error-message";
import FileList, { ChangedFileSearch } from "./ChangedFileList";
import type { FileChange } from "./types";
import AiInputFrame from "./AiInputFrame";
import { cancelAiGeneration } from "./ai-api";
import { MenuShell } from "./FileTree";

export interface StashPushOptions { message: string; includeUntracked: boolean; files: FileChange[] }

const time = (seconds: number) => new Date(seconds * 1000).toLocaleString();

/** stash 列表（R-STASH）：`version` 在 stash 变化（watcher 的 stash 事件、写操作结束）时递增。 */
export function useStashList(repoId: string | null, version: number) {
  const [result, setResult] = useState<{ repoId: string; version: number; entries: StashEntry[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!repoId) return;
    let live = true;
    void stashList(repoId).then(
      (entries) => { if (live) setResult({ repoId, version, entries, error: null }); },
      (error) => { if (live && !isStale(error)) setResult({ repoId, version, entries: null, error: errorText(error) }); }
    );
    return () => { live = false; };
  }, [repoId, version]);
  const current = result?.repoId === repoId ? result : null;
  return { entries: current?.entries ?? null, error: current?.version === version ? current.error : null, ready: current?.version === version };
}

export const stashLabel = (entry: StashEntry) => `stash@{${entry.index}}`;

export function StashForm({ selectedFiles, blocked, onPush, onClose, onGenerate }: {
  selectedFiles: FileChange[]; blocked: string | null; onPush(options: StashPushOptions): Promise<boolean>;
  onClose(): void; onGenerate(files: FileChange[], requestId: string): Promise<string>;
}) {
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<string | null>(null);
  const saving = useRef(false);
  const files = untracked ? selectedFiles : selectedFiles.filter((file) => file.status !== "untracked");
  const pushBlocked = blocked ?? (!files.length ? "当前选项下没有可储藏的改动" : null);
  const stop = useCallback(() => {
    if (!request.current) return;
    const id = request.current;
    request.current = null;
    void cancelAiGeneration(id).catch(() => {});
  }, []);
  useEffect(() => () => stop(), [stop]);
  const generate = async () => {
    if (pushBlocked || request.current || saving.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError("");
    try {
      const name = await onGenerate(files, id);
      if (request.current === id) setMessage(name);
    } catch (reason) {
      if (request.current === id) setError(errorText(reason));
    } finally {
      if (request.current === id) { request.current = null; setBusy(false); }
    }
  };
  const submit = async () => {
    if (pushBlocked || request.current || saving.current) return;
    saving.current = true;
    setSubmitting(true);
    setError("");
    try {
      if (await onPush({ message, includeUntracked: untracked, files })) onClose();
      else setError("储藏失败，请查看操作详情后重试");
    } catch (reason) { setError(errorText(reason)); }
    finally { saving.current = false; setSubmitting(false); }
  };
  return <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
    <form className="confirm-dialog stash-form" role="dialog" aria-modal="true" aria-label="储藏所选文件"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!submitting) onClose(); } }}>
      <h3>储藏所选文件</h3>
      <label htmlFor="stash-name">储藏名称</label>
      <AiInputFrame className="stash-name-field" busy={busy} disabled={!!pushBlocked || submitting} label="AI 生成储藏名称" sendText="AI 生成"
        onSend={() => void generate()} onStop={() => { stop(); setBusy(false); }}>
        <input type="text" id="stash-name" autoFocus placeholder="留空使用分支名 + 时间戳" maxLength={160} value={message} readOnly={busy || submitting}
          onChange={(event) => setMessage(event.target.value)}/>
      </AiInputFrame>
      {selectedFiles.some((file) => file.status === "untracked") && <label><input type="checkbox" checked={untracked} disabled={busy || submitting} onChange={(event) => { setUntracked(event.target.checked); setError(""); }}/> 包含未跟踪文件</label>}
      <p aria-live="polite">{pushBlocked ?? `将储藏 ${files.length} 个文件的改动`}</p>
      {error && <p className="confirm-warning" role="alert">{error}</p>}
      <div className="confirm-footer">
        <button type="button" disabled={submitting} onClick={onClose}>取消</button>
        <button type="submit" className="primary" disabled={!!pushBlocked || busy || submitting}>储藏</button>
      </div>
    </form>
  </div>;
}

type StashList = ReturnType<typeof useStashList>;
interface StashMenuTarget { entry: StashEntry; row: HTMLButtonElement; x: number; y: number }

export default function StashPanel({ repoId, list, hidden, blocked, activeKey, reveal, onApply, onDrop, onOpenFile }: {
  repoId: string; list: StashList; hidden: boolean; blocked: string | null; activeKey: string | null;
  reveal: { oid: string } | null; onApply(entry: StashEntry, pop: boolean): void; onDrop(entry: StashEntry): void; onOpenFile(open: HistoryFileOpen): void;
}) {
  const [picked, setPicked] = useState<{ entry: StashEntry; reveal: typeof reveal } | null>(null);
  const [menu, setMenu] = useState<StashMenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => { if (hidden || !list.ready) closeMenu(); }, [hidden, list.ready, closeMenu]);
  const entries = list.entries ?? [];
  const wanted = picked && picked.reveal === reveal ? picked.entry : null;
  const selected = (wanted
    ? entries.find((entry) => entry.oid === wanted.oid && entry.index === wanted.index) ?? entries.find((entry) => entry.oid === wanted.oid)
    : entries.find((entry) => entry.oid === reveal?.oid)) ?? entries[0];
  const openMenu = (entry: StashEntry, row: HTMLButtonElement, x: number, y: number) => {
    setPicked({ entry, reveal });
    setMenu({ entry, row, x, y });
  };
  const run = (action: (entry: StashEntry) => void) => {
    if (!menu || blocked || !list.ready) return;
    menu.row.focus();
    closeMenu();
    action(menu.entry);
  };
  return <div className="stash-layout" hidden={hidden} aria-label="Stash">
    <section className="stash-list" aria-label="储藏列表">
      <div className="stash-list-heading"><strong>储藏列表</strong>{list.entries && <span className="dim">{entries.length} 条</span>}</div>
      <div className="stash-list-scroll" role="listbox" aria-label="储藏条目">
        {entries.map((entry) => <button key={`${entry.index}:${entry.oid}`} type="button" className="log-stash" role="option"
          aria-selected={entry === selected} aria-haspopup="menu" title={`${stashLabel(entry)} · ${entry.message}\n${entry.branch} · ${time(entry.time)}`}
          onClick={() => setPicked({ entry, reveal })}
          onContextMenu={(event) => { event.preventDefault(); openMenu(entry, event.currentTarget, event.clientX, event.clientY); }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const row = event.currentTarget;
            const rect = row.getBoundingClientRect();
            openMenu(entry, row, rect.left + 12, rect.bottom);
          }}>
          <span className="stash-row-title"><code>{stashLabel(entry)}</code><strong>{entry.message || "（无说明）"}</strong></span>
          <span className="stash-row-meta"><span>{entry.branch || "—"}</span><time>{time(entry.time)}</time></span>
        </button>)}
        {list.error ? <div className="log-error" role="alert">{list.error}</div> : !list.ready && !list.entries
          ? <div className="log-empty">正在读取…</div> : !entries.length ? <div className="log-empty">当前仓库暂无储藏</div> : null}
      </div>
    </section>
    <section className="log-detail" aria-label="储藏详情">
      {!hidden && selected && <StashDetail key={selected.oid} repoId={repoId} entry={selected} activeKey={activeKey} onOpenFile={onOpenFile}/>}
    </section>
    {!hidden && menu && list.ready && entries.includes(menu.entry) && <MenuShell x={menu.x} y={menu.y} label="储藏操作" onClose={closeMenu}>
      <button type="button" role="menuitem" disabled={!!blocked} title={blocked ?? undefined} onClick={() => run((entry) => onApply(entry, false))}>应用并保留</button>
      <button type="button" role="menuitem" disabled={!!blocked} title={blocked ?? undefined} onClick={() => run((entry) => onApply(entry, true))}>应用后移除</button>
      <button type="button" role="menuitem" className="danger" disabled={!!blocked} title={blocked ?? undefined} onClick={() => run(onDrop)}>删除…</button>
    </MenuShell>}
  </div>;
}

/** 所选 stash 的内容在主 diff 阅读器中查看。 */
function StashDetail({ repoId, entry, activeKey, onOpenFile }: { repoId: string; entry: StashEntry; activeKey: string | null; onOpenFile(open: HistoryFileOpen): void }) {
  const [changes, setChanges] = useState<StashChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const { oid } = entry;
  useEffect(() => {
    let live = true;
    setError(null);
    void stashChanges(repoId, oid).then((result) => { if (live) setChanges(result); }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId, oid]);
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
  return <div className="log-detail-body stash-detail" aria-label="stash 内容">
    <div className="log-detail-header">
      <strong className="log-detail-subject">{stashLabel(entry)} · {entry.message || "（无说明）"}</strong>
      {changes?.oid === entry.oid && <ChangedFileSearch value={fileFilter} onChange={setFileFilter}/>}
    </div>
    <div className="log-meta">{entry.branch || "—"} · {time(entry.time)} · <span className="log-sha-full">{entry.oid}</span>{entry.untracked ? " · 含未跟踪" : ""}</div>
    {error && <div className="log-error">{error}</div>}
    {!changes || changes.oid !== entry.oid ? !error && <div className="log-empty">正在读取…</div> : <>
      <FileList files={changes.tracked} filter={fileFilter} label="已跟踪文件" context={`（相对储藏时的 HEAD ${shortOid(changes.base)}）`} emptyMessage="没有已跟踪文件的改动"
        activeKey={activeKey} keyFor={(file) => `stash:${entry.oid}:tracked:${file.pathId}`} onOpen={(file) => open(file, "tracked")}/>
      {changes.untrackedCommit && <FileList files={changes.untracked} filter={fileFilter} label="未跟踪文件"
        activeKey={activeKey} keyFor={(file) => `stash:${entry.oid}:untracked:${file.pathId}`} onOpen={(file) => open(file, "untracked")}/>}
    </>}
  </div>;
}
