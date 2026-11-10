import AiInputFrame from "./AiInputFrame";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { headCommitInfo, type BackupSummary, type HeadCommitInfo, type OperationKind, type OperationOutcome, type OperationStatus } from "./operations-api";
import { loadDraft, operationLabels, saveDraft } from "./operations-model";
import { errorText } from "./error-message";

export type GitTab = "log" | "commit" | "stash" | "output";

export interface RunningOperation { opId: string; kind: OperationKind }
export interface OperationRecord { kind: OperationKind; status: OperationStatus; message: string; output: string; outputTruncated?: boolean; stashOid?: string; at: number }

interface Props {
  repoId: string | null;
  tab: GitTab | null;
  onTab(tab: GitTab | null): void;
  stagedCount: number;
  ignoredStagedPaths?: string[];
  /** HEAD / 上游变化的键：变化时重新读取 HEAD 信息。 */
  headKey: string;
  /** 当前快照中的 HEAD OID；HEAD 信息与之不一致时视为正在读取，撤销暂不可用。 */
  headOid: string | null;
  mergeInProgress: boolean;
  blockedReason: string | null;
  running: RunningOperation | null;
  lines: string[];
  last: OperationRecord | null;
  lastCommit: OperationRecord | null;
  backups: BackupSummary[];
  /** push：提交成功后推送当前分支。 */
  onCommit(message: string, push: boolean): Promise<OperationOutcome | null>;
  onUndoCommit(head: HeadCommitInfo): void;
  onUndoDiscard(backupId: string): void;
  onCancel(): void;
  onGenerateMessage?(): Promise<string>;
  /** 历史挂载后保持，切换页签时只隐藏，保留已加载的历史与选择。 */
  logContent?: ReactNode;
  stashContent?: ReactNode;
  stashCount?: number;
  filesContent?: ReactNode;
  filesTools?: ReactNode;
}

const statusText: Record<OperationStatus, string> = { succeeded: "成功", failed: "失败", cancelled: "已取消", needsConfirmation: "等待确认" };
const statusMark: Record<OperationStatus, string> = { succeeded: "✓", failed: "✗", cancelled: "■", needsConfirmation: "?" };

/** 底部 Git 区：文件、历史和 Stash 页签。 */
export default function GitPanel(props: Props) {
  const { repoId, tab, onTab } = props;
  const clampHeight = (height: number) => Math.max(160, Math.min(Math.max(160, window.innerHeight - 240), height));
  const [height, setHeight] = useState(() => { try { const saved = Number(localStorage.getItem("oris.bottomHeight.v1")); return clampHeight(saved > 0 ? saved : 330); } catch { return 330; } });
  const drag = useRef<{ id: number; y: number; height: number } | null>(null);
  const resize = (value: number) => { const next = clampHeight(value); setHeight(next); try { localStorage.setItem("oris.bottomHeight.v1", String(next)); } catch { /* 可选 */ } };
  useEffect(() => { const fit = () => setHeight(h => clampHeight(h)); window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit); }, []);
  return <section className={`git-panel${tab ? " open" : ""}`} aria-label="Git 区" style={tab ? { height } : undefined}>
    <div className="git-resizer" role="separator" aria-label="调整下方区域高度" aria-orientation="horizontal" aria-valuenow={height} tabIndex={0}
      onPointerDown={event => { if (event.button !== 0) return; drag.current = { id: event.pointerId, y: event.clientY, height }; event.currentTarget.setPointerCapture?.(event.pointerId); if (!tab) onTab("commit"); event.preventDefault(); }}
      onPointerMove={event => { const start = drag.current; if (start?.id === event.pointerId) resize(start.height + start.y - event.clientY); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); if (!tab) onTab("commit"); resize(height + (event.key === "ArrowUp" ? 20 : -20)); } }}/>
    <div className="git-tabs" role="tablist" aria-label="仓库内容">
      <button type="button" role="tab" aria-selected={tab === "commit" || tab === "output"} className={tab === "commit" || tab === "output" ? "active" : ""} onClick={() => onTab("commit")}>文件</button>
      <button type="button" role="tab" aria-selected={tab === "log"} className={tab === "log" ? "active" : ""} onClick={() => onTab("log")}>历史</button>
      <button type="button" role="tab" aria-label="Stash" aria-selected={tab === "stash"} className={tab === "stash" ? "active" : ""} onClick={() => onTab("stash")}>Stash{props.stashCount ? <small className="stash-count"> {props.stashCount}</small> : null}</button>
      <span className="spacer"/>{tab === "commit" && props.filesTools}
      <button type="button" className="git-fold" title={tab ? "收起下方区域" : "展开下方区域"} onClick={() => onTab(tab ? null : "commit")} aria-label={tab ? "收起 Git 区" : "展开 Git 区"}>{tab ? "⌄" : "⌃"}</button>
    </div>
    {props.logContent}
    {props.stashContent}
    {tab === "stash" && !repoId && <div className="log-empty">使用 + 添加项目</div>}
    {(tab === "commit" || tab === "output") && <div className="files-layout">{props.filesContent}{repoId ? <CommitTab key={repoId} {...props} repoId={repoId}/> : <div className="empty">使用 + 添加项目</div>}</div>}
    {tab === "output" && <div className="dialog-overlay"><section className="operation-dialog" role="dialog" aria-label="操作详情"><div className="panel-title"><strong>操作详情</strong><button onClick={() => onTab("commit")} aria-label="关闭操作详情">×</button></div><OutputTab {...props}/></section></div>}
  </section>;
}

function CommitTab({ repoId, stagedCount, ignoredStagedPaths = [], headKey, headOid, mergeInProgress, blockedReason, running, lines, lastCommit, onCommit, onUndoCommit, onCancel, onGenerateMessage }: Props & { repoId: string }) {
  const [message, setMessage] = useState(() => loadDraft(localStorage, repoId));
  const [push, setPush] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState("");
  const [loadedHead, setHead] = useState<HeadCommitInfo | null>(null);
  // 只使用与当前快照 HEAD 一致的信息，避免对旧 HEAD 执行撤销（后端还会按 expectedHead 再核对一次）。
  const head = loadedHead && loadedHead.oid === headOid ? loadedHead : null;
  const headLoading = !!headOid && !head;
  const [headError, setHeadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void headCommitInfo(repoId).then((info) => { if (live) { setHead(info); setHeadError(null); } }, (error) => { if (live) { setHead(null); setHeadError(errorText(error)); } });
    return () => { live = false; };
  }, [repoId, headKey]);
  const update = (value: string) => {
    setMessage(value);
    try { saveDraft(localStorage, repoId, value); } catch { /* 存储可选 */ }
  };
  const committing = running && (running.kind === "commit" || running.kind === "undoCommit");
  const pushedReason = head?.pushed ? `HEAD 已包含在上游 ${head.upstream ?? ""} 中：撤销需要强制推送，Oris 不支持，请在命令行处理` : null;
  const pushReason = head?.detached ? "分离 HEAD：不能推送" : null;
  const commitBlocked = blockedReason
    ?? (stagedCount === 0 ? "没有已暂存的内容，请先暂存改动" : null)
    ?? (!message.trim() ? "请填写提交信息（首行为摘要）" : null);
  const undoBlocked = blockedReason ?? (headLoading ? "正在读取 HEAD…" : null) ?? (!head ? "还没有提交" : null) ?? pushedReason ?? (mergeInProgress ? "合并进行中不能撤销提交" : null) ?? (head?.detached && head.parents.length === 0 ? "分离 HEAD 上的根提交不能撤销" : null);
  const submit = async () => {
    if (commitBlocked) return;
    const outcome = await onCommit(message, push && !pushReason);
    if (outcome?.status === "succeeded") {
      setMessage("");
      try { saveDraft(localStorage, repoId, ""); } catch { /* 存储可选 */ }
    }
  };
  const generateMessage = async () => {
    if (!onGenerateMessage) return;
    setAiGenerating(true); setAiError("");
    try { update(await onGenerateMessage()); }
    catch (error) { setAiError(String(error)); }
    finally { setAiGenerating(false); }
  };
  return <div className="git-body commit-layout">
    <div className="commit-editor"><AiInputFrame busy={aiGenerating} disabled={!onGenerateMessage||stagedCount===0||!!running} label="根据暂存内容生成提交信息" onSend={()=>void generateMessage()}><textarea aria-label="提交信息" placeholder={"提交摘要（必填）\n\n详细说明…"} value={message} readOnly={aiGenerating} onChange={(event) => update(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }}/>
      </AiInputFrame>
    </div>
    <div className="commit-side">
      {ignoredStagedPaths.length > 0 && <details className="ignore-commit-warning" open><summary>包含 {ignoredStagedPaths.length} 个被忽略的已暂存文件，仍会提交</summary><ul>{ignoredStagedPaths.map(path => <li key={path}>{path}</li>)}</ul><small>忽略只影响列表，不会自动取消暂存。</small></details>}
      <label title={pushReason ?? "提交成功后推送当前分支；没有上游时先选择 remote"}><input type="checkbox" aria-label="提交并推送" checked={push && !pushReason} disabled={!!pushReason || !!committing} onChange={(event) => setPush(event.target.checked)}/> 提交并推送</label>
      <div className="commit-buttons">
        <button type="button" className="primary" disabled={!!commitBlocked || !!committing} title={commitBlocked ?? "Ctrl+Enter"} onClick={() => void submit()}>{push && !pushReason ? "提交并推送" : "提交"}</button>

        {committing && <button type="button" onClick={onCancel}>取消</button>}
      </div>
      {aiError && <small className="commit-reason" role="alert">{aiError}</small>}
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
