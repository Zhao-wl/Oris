import { useEffect, useRef, useState, type ReactNode } from "react";
import { headCommitInfo, type BackupSummary, type HeadCommitInfo, type OperationKind, type OperationOutcome, type OperationStatus } from "./operations-api";
import { loadDraft, operationLabels, saveDraft } from "./operations-model";
import { errorText } from "./error-message";

export type GitTab = "log" | "commit" | "output";

export interface RunningOperation { opId: string; kind: OperationKind }
export interface OperationRecord { kind: OperationKind; status: OperationStatus; message: string; output: string; outputTruncated?: boolean; at: number }

interface Props {
  repoId: string | null;
  tab: GitTab | null;
  onTab(tab: GitTab | null): void;
  stagedCount: number;
  /** HEAD / 上游变化的键：变化时重新读取 HEAD 信息。 */
  headKey: string;
  /** 当前快照中的 HEAD OID；HEAD 信息与之不一致时视为正在读取，修订与撤销暂不可用。 */
  headOid: string | null;
  mergeInProgress: boolean;
  blockedReason: string | null;
  running: RunningOperation | null;
  lines: string[];
  last: OperationRecord | null;
  lastCommit: OperationRecord | null;
  backups: BackupSummary[];
  onCommit(message: string, amend: boolean, keepMessage: boolean, expectedHead: string | null): Promise<OperationOutcome | null>;
  onUndoCommit(head: HeadCommitInfo): void;
  onUndoDiscard(backupId: string): void;
  onCancel(): void;
  /** “历史”页内容（任务 04；V2-03 的 Stash 已并入其左侧）：挂载后保持，切换页签时只隐藏，保留已加载的历史与选择。 */
  logContent?: ReactNode;
}

const statusText: Record<OperationStatus, string> = { succeeded: "成功", failed: "失败", cancelled: "已取消", needsConfirmation: "等待确认" };
const statusMark: Record<OperationStatus, string> = { succeeded: "✓", failed: "✗", cancelled: "■", needsConfirmation: "?" };

/** 底部 Git 区（混合发布参考图）：可收起的“历史”“提交”与“操作输出”页签。 */
export default function GitPanel(props: Props) {
  const { repoId, tab, onTab, stagedCount, running } = props;
  return <section className={`git-panel${tab ? " open" : ""}`} aria-label="Git 区">
    <div className="git-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "log"} className={tab === "log" ? "active" : ""} onClick={() => onTab(tab === "log" ? null : "log")}>历史</button>
      <button type="button" role="tab" aria-selected={tab === "commit"} className={tab === "commit" ? "active" : ""} onClick={() => onTab(tab === "commit" ? null : "commit")}>提交 · {stagedCount}</button>
      <button type="button" role="tab" aria-selected={tab === "output"} className={tab === "output" ? "active" : ""} onClick={() => onTab(tab === "output" ? null : "output")}>操作输出{running ? " ⟳" : ""}</button>
      <span className="spacer"/>
      <button type="button" className="git-fold" onClick={() => onTab(tab ? null : "commit")} aria-label={tab ? "收起 Git 区" : "展开 Git 区"}>{tab ? "收起 ↓" : "展开 ↑"}</button>
    </div>
    {props.logContent}
    {tab === "commit" && repoId && <CommitTab key={repoId} {...props} repoId={repoId}/>}
    {tab === "output" && <OutputTab {...props}/>}
  </section>;
}

function CommitTab({ repoId, stagedCount, headKey, headOid, mergeInProgress, blockedReason, running, lines, lastCommit, onCommit, onUndoCommit, onCancel }: Props & { repoId: string }) {
  const [message, setMessage] = useState(() => loadDraft(localStorage, repoId));
  const [amend, setAmend] = useState(false);
  const [loadedHead, setHead] = useState<HeadCommitInfo | null>(null);
  // 只使用与当前快照 HEAD 一致的信息，避免对旧 HEAD 执行修订或撤销（后端还会按 expectedHead 再核对一次）。
  const head = loadedHead && loadedHead.oid === headOid ? loadedHead : null;
  const headLoading = !!headOid && !head;
  const [headError, setHeadError] = useState<string | null>(null);
  const savedDraft = useRef(message);
  useEffect(() => {
    let live = true;
    void headCommitInfo(repoId).then((info) => { if (live) { setHead(info); setHeadError(null); } }, (error) => { if (live) { setHead(null); setHeadError(errorText(error)); } });
    return () => { live = false; };
  }, [repoId, headKey]);
  const update = (value: string) => {
    setMessage(value);
    // amend 时显示的是原提交信息，不覆盖草稿。
    if (!amend) { savedDraft.current = value; try { saveDraft(localStorage, repoId, value); } catch { /* 存储可选 */ } }
  };
  const toggleAmend = (value: boolean) => {
    setAmend(value);
    if (value) { savedDraft.current = message; setMessage(head?.message ?? ""); }
    else setMessage(savedDraft.current);
  };
  const committing = running && (running.kind === "commit" || running.kind === "amend" || running.kind === "undoCommit");
  const keepMessage = amend && !!head && message.trim() === head.message.trim();
  const pushedReason = head?.pushed ? `HEAD 已包含在上游 ${head.upstream ?? ""} 中：修订与撤销需要强制推送，Oris 不支持，请在命令行处理` : null;
  const commitBlocked = blockedReason
    ?? (amend && headLoading ? "正在读取 HEAD…" : null)
    ?? (amend && !head ? "还没有提交，无法修订" : null)
    ?? (amend ? pushedReason : null) ?? (amend && mergeInProgress ? "合并进行中不能修订提交" : null)
    ?? (!amend && stagedCount === 0 ? "没有已暂存的内容：先在“未暂存”范围暂存文件" : null)
    ?? (!keepMessage && !message.trim() ? "请填写提交信息（首行为摘要）" : null);
  const undoBlocked = blockedReason ?? (headLoading ? "正在读取 HEAD…" : null) ?? (!head ? "还没有提交" : null) ?? pushedReason ?? (mergeInProgress ? "合并进行中不能撤销提交" : null) ?? (head?.detached && head.parents.length === 0 ? "分离 HEAD 上的根提交不能撤销" : null);
  const submit = async () => {
    if (commitBlocked) return;
    const outcome = await onCommit(message, amend, keepMessage, amend ? head?.oid ?? null : null);
    if (outcome?.status === "succeeded") {
      savedDraft.current = "";
      setMessage(""); setAmend(false);
      try { saveDraft(localStorage, repoId, ""); } catch { /* 存储可选 */ }
    }
  };
  return <div className="git-body commit-layout">
    <textarea aria-label="提交信息" placeholder={"提交摘要（必填）\n\n详细说明…"} value={message} onChange={(event) => update(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }}/>
    <div className="commit-side">
      <strong>{amend ? "修订最近一次提交" : `提交暂存区 · ${stagedCount} 个文件`}</strong>
      <small>草稿按项目保存；未暂存内容不会进入提交{amend ? "；信息不改时只并入暂存内容" : ""}</small>
      <label title={pushedReason ?? undefined}><input type="checkbox" aria-label="修订最近一次提交（amend）" checked={amend} disabled={!head || !!committing} onChange={(event) => toggleAmend(event.target.checked)}/> 修订最近一次提交（amend）</label>
      <div className="commit-buttons">
        <button type="button" className="primary" disabled={!!commitBlocked || !!committing} title={commitBlocked ?? "Ctrl+Enter"} onClick={() => void submit()}>{amend ? "修订提交" : "提交"}</button>
        <button type="button" className="quiet" disabled={!!undoBlocked || !!committing} title={undoBlocked ?? (head ? `撤销 ${head.oid.slice(0, 8)} ${head.subject}` : undefined)} onClick={() => head && onUndoCommit(head)}>撤销最近提交…</button>
        {committing && <button type="button" onClick={onCancel}>取消</button>}
      </div>
      {commitBlocked && !committing && <small className="commit-reason">{commitBlocked}</small>}
      {headError && <small className="commit-reason">无法读取 HEAD：{headError}</small>}
      {committing && <div className="commit-progress" role="status"><span>正在{operationLabels[running!.kind]}…（hooks 运行中可取消）</span>{lines.length > 0 && <pre>{lines.slice(-6).join("\n")}</pre>}</div>}
      {!committing && lastCommit && <div className={`commit-result ${lastCommit.status}`} role="status"><span>{statusMark[lastCommit.status]} {lastCommit.message}</span>{lastCommit.status !== "succeeded" && lastCommit.output && <pre aria-label="hook 输出">{lastCommit.output}</pre>}</div>}
    </div>
  </div>;
}

function OutputTab({ running, lines, last, backups, blockedReason, onUndoDiscard, onCancel }: Props) {
  return <div className="git-body output-layout">
    <div className="output-main">
      {running ? <>
        <div className="output-head"><strong>正在{operationLabels[running.kind]}…</strong><button type="button" onClick={onCancel}>取消</button></div>
        <pre aria-label="操作输出">{lines.join("\n")}</pre>
      </> : last ? <>
        <div className="output-head"><strong className={`output-status ${last.status}`}>{statusMark[last.status]} {operationLabels[last.kind]} · {statusText[last.status]}</strong><span>{new Date(last.at).toLocaleTimeString()}</span></div>
        <p className="output-message">{last.message}</p>
        {last.output ? <pre aria-label="操作输出">{last.output}{last.outputTruncated ? "\n…（输出超过 256 KiB，已截断）" : ""}</pre> : <p className="output-empty">Git 没有输出</p>}
      </> : <p className="output-empty">最近一次写操作的 Git 输出在这里显示；失败时保留错误摘要。</p>}
    </div>
    <aside className="output-backups" aria-label="可撤销的丢弃">
      <strong>可撤销的丢弃</strong>
      {backups.length === 0 && <p className="output-empty">没有丢弃记录</p>}
      {backups.map((backup) => <div key={backup.id} className="backup-row">
        <span title={backup.paths.join("\n")}>{new Date(backup.createdAt).toLocaleTimeString()} · {backup.files} 个文件{backup.unrecoverable ? `（${backup.unrecoverable} 个不可撤销）` : ""}<small>{backup.paths.slice(0, 3).join("、")}{backup.files > 3 ? " …" : ""}</small></span>
        <button type="button" disabled={!!blockedReason} title={blockedReason ?? "恢复丢弃前的工作区与暂存内容"} onClick={() => onUndoDiscard(backup.id)}>撤销丢弃</button>
      </div>)}
    </aside>
  </div>;
}
