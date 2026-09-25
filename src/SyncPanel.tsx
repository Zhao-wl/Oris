import { useEffect, useRef, useState, type ReactNode } from "react";
import { mergeMessage, readRefs, shortOid, shortRef, trackingText, type Branch, type RefsView } from "./history-api";
import { errorText } from "./error-message";
import { isStale } from "./history-model";

function Shell({ title, className = "", children, onCancel, footer }: { title: string; className?: string; children: ReactNode; onCancel(): void; footer: ReactNode }) {
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRef.current(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className={`confirm-dialog branch-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <h3>{title}</h3>
      {children}
      <div className="confirm-footer">{footer}</div>
    </div>
  </div>;
}

export interface SyncActions {
  onFetch(): void;
  onPull(): void;
  onPush(): void;
  onSetUpstream(branch: Branch): void;
}

/** 标题栏“同步”入口（参考图“分支与同步”）：当前分支、上游与领先 / 落后，展开获取 / 拉取 / 推送。 */
export function SyncPopover({ repoId, refsVersion, blocked, fetchText, actions, onClose }: { repoId: string; refsVersion: number; blocked: string | null; fetchText: string; actions: SyncActions; onClose(): void }) {
  const [refs, setRefs] = useState<RefsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let live = true;
    void readRefs(repoId).then((view) => { if (live) { setRefs(view); setError(null); } }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId, refsVersion]);
  useEffect(() => {
    const close = (event: Event) => { const target = event.target as Element; if (!host.current?.contains(target) && !target.closest?.(".sync-button")) closeRef.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector(".dialog-overlay")) { event.preventDefault(); closeRef.current(); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key, true); };
  }, []);
  const current = refs?.local.find((b) => b.current) ?? null;
  const detached = !!refs?.head.detached;
  const hasUpstream = !!current?.tracking && current.tracking.state !== "noUpstream";
  const upstreamGone = current?.tracking?.state === "gone";
  const tracking = trackingText(current?.tracking ?? null);
  const pullReason = blocked ?? (detached ? "分离 HEAD：请先切换到分支" : !current ? "当前没有分支" : !hasUpstream ? "当前分支没有上游：先设置上游" : upstreamGone ? "上游分支已不存在：请先获取远端状态或更换上游" : null);
  const pushReason = blocked ?? (detached ? "分离 HEAD：不能推送，请先切换到分支或从这里新建分支" : !current ? "当前没有分支" : !refs?.remotes.length ? "没有配置 remote" : null);
  return <div ref={host} className="branch-popover sync-popover" role="dialog" aria-label="同步">
    <div className="branch-popover-head"><strong>同步当前分支</strong></div>
    {error && <div className="log-error">{error}</div>}
    {!refs && !error && <div className="log-empty">正在读取分支…</div>}
    {refs && <div className="sync-summary">
      <div>{detached ? `分离 HEAD @ ${shortOid(refs.head.oid)}` : current ? `● ${current.name}` : "尚无提交"}{current && hasUpstream && <> → {shortRef((current.tracking as { upstream: string }).upstream)}</>}</div>
      <div className="log-track" title={tracking.title}>{current ? tracking.short : ""}</div>
      <small title="领先 / 落后基于本地的远端跟踪引用，获取远端状态后才会更新">{fetchText}</small>
    </div>}
    <div className="sync-row"><span>获取远端状态<small>只更新远端跟踪分支，不改工作区</small></span><button type="button" disabled={!!blocked} title={blocked ?? undefined} onClick={actions.onFetch}>获取…</button></div>
    <div className="sync-row"><span>拉取到当前分支<small>仅快进或合并，不做 rebase</small></span><button type="button" disabled={!!pullReason} title={pullReason ?? undefined} onClick={actions.onPull}>选项…</button></div>
    {refs && current && !detached && !hasUpstream && <div className="sync-hint">当前分支没有上游，拉取不可用。<button type="button" disabled={!!blocked} onClick={() => actions.onSetUpstream(current)}>设置上游…</button></div>}
    <div className="sync-row"><span>推送当前分支<small>不推送 tag，不强制推送</small></span><button type="button" disabled={!!pushReason} title={pushReason ?? undefined} onClick={actions.onPush}>预览…</button></div>
    {(pullReason || pushReason) && refs && <small className="sync-reason">{[pullReason && `拉取：${pullReason}`, pushReason && pushReason !== pullReason && `推送：${pushReason}`].filter(Boolean).join("；")}</small>}
  </div>;
}

/** 拉取：仅快进（默认）或合并；说明 pull.rebase 配置不会生效。 */
export function PullDialog({ refs, blocked, onConfirm, onCancel }: { refs: RefsView | null; blocked: string | null; onConfirm(mode: "ffOnly" | "merge"): void; onCancel(): void }) {
  const [mode, setMode] = useState<"ffOnly" | "merge">("ffOnly");
  const current = refs?.local.find((b) => b.current) ?? null;
  const tracking = current?.tracking;
  const upstream = tracking && tracking.state !== "noUpstream" ? shortRef(tracking.upstream) : null;
  const rebase = refs?.pullRebase && refs.pullRebase !== "false" ? refs.pullRebase : null;
  const reason = blocked ?? (!refs ? "正在读取…" : !upstream ? "当前分支没有上游" : null);
  return <Shell title="拉取当前分支" className="pull-dialog" onCancel={onCancel} footer={<>
    {reason && <span className="fetch-reason">{reason}</span>}
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!!reason} onClick={() => onConfirm(mode)}>拉取</button>
  </>}>
    <p>{!refs ? "正在读取当前分支与上游…" : `来源：${upstream ?? "—"}`}{tracking?.state === "known" ? `（本地快照：落后 ${tracking.behind}、领先 ${tracking.ahead}；拉取时会先获取最新状态）` : ""}</p>
    <label className="dialog-check"><input type="radio" name="pull-mode" aria-label="仅快进" checked={mode === "ffOnly"} onChange={() => setMode("ffOnly")}/> 仅快进（默认）：本地没有上游之外的提交时才更新</label>
    <label className="dialog-check"><input type="radio" name="pull-mode" aria-label="合并远端改动" checked={mode === "merge"} onChange={() => setMode("merge")}/> 合并远端改动：能快进时快进，已分叉时生成合并提交</label>
    {rebase && <p className="confirm-warning pull-rebase-note">你的 Git 配置了 pull.rebase={rebase}：Oris 不做 rebase，会以合并方式执行（--no-rebase）。</p>}
    <p className="confirm-note">不递归子模块、不自动储藏。工作区改动阻止拉取时，会询问是否先储藏。</p>
  </Shell>;
}

/** 推送预览：目标、提交数；没有上游时选择 remote（只有一个时默认选中），推送后设为上游。 */
export function PushDialog({ refs, blocked, onConfirm, onCancel }: { refs: RefsView | null; blocked: string | null; onConfirm(remote: string | null): void; onCancel(): void }) {
  const current = refs?.local.find((b) => b.current) ?? null;
  const tracking = current?.tracking;
  const upstream = tracking && tracking.state !== "noUpstream" && tracking.state !== "gone" ? tracking.upstream : null;
  const remotes = refs?.remotes ?? [];
  const [remote, setRemote] = useState<string>("");
  const initialized = useRef(false);
  useEffect(() => { if (refs && !initialized.current) { initialized.current = true; setRemote(remotes.length === 1 ? remotes[0] : ""); } }, [refs]);
  const reason = blocked ?? (!refs ? "正在读取…" : !current ? "当前没有分支" : !upstream && !remote ? "请选择要推送到的 remote" : null);
  return <Shell title="推送当前分支" className="push-dialog" onCancel={onCancel} footer={<>
    {reason && <span className="fetch-reason">{reason}</span>}
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!!reason} onClick={() => onConfirm(upstream ? null : remote)}>推送</button>
  </>}>
    {!refs ? <p>正在读取当前分支与上游…</p> : upstream ? <p>目标：{shortRef(upstream)}{tracking?.state === "known" ? `。将推送领先的 ${tracking.ahead} 个提交（基于本地快照）` : ""}</p>
      : <>
        <p>分支 {current?.name ?? "—"} 还没有上游：推送到所选 remote 的同名分支，并设为上游。</p>
        <label className="dialog-field">remote<select aria-label="推送的 remote" value={remote} onChange={(event) => setRemote(event.target.value)}>
          <option value="">请选择…</option>
          {remotes.map((name) => <option key={name} value={name}>{name}</option>)}
        </select></label>
      </>}
    <p className="confirm-note">只推送当前分支；不推送 tag；没有强制推送。远端有本地没有的提交时推送会被拒绝，请先拉取。</p>
  </Shell>;
}

/** 合并到当前分支：遵循 merge.ff，可选总是创建合并提交。 */
export function MergeDialog({ target, current, mergeFf, blocked, onConfirm, onCancel }: { target: { ref: string; oid: string; label: string }; current: string; mergeFf: string | null; blocked: string | null; onConfirm(noFf: boolean): void; onCancel(): void }) {
  const [noFf, setNoFf] = useState(mergeFf === "false");
  return <Shell title={`合并到 ${current}`} className="merge-dialog" onCancel={onCancel} footer={<>
    {blocked && <span className="fetch-reason">{blocked}</span>}
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!!blocked} onClick={() => onConfirm(noFf)}>合并</button>
  </>}>
    <p>把 <strong>{target.label}</strong>（{shortOid(target.oid)}）合并到当前分支 <strong>{current}</strong>。</p>
    <label className="dialog-check"><input type="checkbox" aria-label="总是创建合并提交" checked={noFf} onChange={(event) => setNoFf(event.target.checked)}/> 总是创建合并提交（--no-ff）</label>
    {mergeFf === "only" && <p className="confirm-warning merge-ff-only-note">你的配置 merge.ff=only 只允许快进：无法快进时合并会失败；勾选“总是创建合并提交”会覆盖该配置。</p>}
    <p className="confirm-note">{mergeFf ? `遵循你的 merge.ff=${mergeFf}；` : "默认能快进时快进；"}出现冲突时进入“合并进行中”：冲突只读查看，在外部解决后标记已解决，再完成合并或中止合并。</p>
  </Shell>;
}

/** 完成合并：可编辑的默认合并信息（来自 MERGE_MSG）。 */
export function MergeCommitDialog({ repoId, blocked, onConfirm, onCancel }: { repoId: string; blocked: string | null; onConfirm(message: string): void; onCancel(): void }) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { void mergeMessage(repoId).then((text) => setMessage(text ?? ""), () => setMessage("")); }, [repoId]);
  const reason = blocked ?? (message === null ? "正在读取默认合并信息…" : !message.trim() ? "合并信息不能为空" : null);
  return <Shell title="完成合并" className="merge-commit-dialog" onCancel={onCancel} footer={<>
    {reason && <span className="fetch-reason">{reason}</span>}
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!!reason} onClick={() => onConfirm(message ?? "")}>完成合并</button>
  </>}>
    <p>所有冲突都已标记解决。以下为默认合并信息，可修改：</p>
    <textarea aria-label="合并信息" value={message ?? ""} onChange={(event) => setMessage(event.target.value)} rows={5}/>
    <p className="confirm-note">提交 hooks 照常执行；签名按你的 Git 配置。</p>
  </Shell>;
}
