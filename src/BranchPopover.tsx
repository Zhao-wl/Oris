import { useEffect, useMemo, useRef, useState } from "react";
import { readRefs, shortOid, trackingText, type Branch, type RefsView } from "./history-api";
import { errorText } from "./error-message";
import { isStale } from "./history-model";

export interface BranchActions {
  onSwitch(branch: Branch): void;
  onTrack(branch: Branch): void;
  onNew(start: { ref: string; label: string } | null): void;
  onRename(branch: Branch): void;
  onDelete(branch: Branch): void;
  onSetUpstream(branch: Branch): void;
  /** V2-04：把该分支合并到当前分支。 */
  onMerge?(branch: Branch): void;
}

/**
 * 标题栏分支弹层（R-BRANCHOP，参考图“分支与同步”）：搜索，本地 / 远端分组；本地分支可切换，
 * “更多”中提供从这里新建、重命名、删除、设置上游；远端跟踪分支“检出”为同名本地跟踪分支。
 */
export default function BranchPopover({ repoId, refsVersion, blocked, actions, onClose }: { repoId: string; refsVersion: number; blocked: string | null; actions: BranchActions; onClose(): void }) {
  const [refs, setRefs] = useState<RefsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [more, setMore] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let live = true;
    void readRefs(repoId).then((view) => { if (live) { setRefs(view); setError(null); } }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId, refsVersion]);
  useEffect(() => {
    input.current?.focus();
    const close = (event: Event) => { const target = event.target as Element; if (!host.current?.contains(target) && !target.closest?.(".branch-button")) closeRef.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector(".dialog-overlay")) { event.preventDefault(); closeRef.current(); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key, true); };
  }, []);
  const needle = query.trim().toLocaleLowerCase();
  const match = (branch: Branch) => !needle || branch.name.toLocaleLowerCase().includes(needle);
  const local = useMemo(() => (refs?.local ?? []).filter(match), [refs, needle]);
  const remote = useMemo(() => (refs?.remote ?? []).filter(match), [refs, needle]);
  const current = refs?.local.find((b) => b.current) ?? null;
  const act = (run: () => void) => { setMore(null); run(); };
  return <div ref={host} className="branch-popover" role="dialog" aria-label="分支">
    <div className="branch-popover-head"><strong>分支</strong><span className="spacer"/>{refs && <span className="branch-popover-head-state">{refs.head.detached ? `分离 HEAD @ ${shortOid(refs.head.oid)}` : current ? `当前 ${current.name}` : refs.head.unborn ? "尚无提交" : ""}</span>}</div>
    <input ref={input} aria-label="搜索分支" placeholder="搜索分支" value={query} onChange={(event) => setQuery(event.target.value)}/>
    <button type="button" className="branch-new" disabled={!!blocked} title={blocked ?? "从当前 HEAD、分支或提交新建分支"} onClick={() => act(() => actions.onNew(null))}>＋ 新建分支…</button>
    {error && <div className="log-error">{error}</div>}
    {blocked && <div className="branch-blocked">{blocked}</div>}
    <div className="branch-popover-list">
      {!refs && !error && <div className="log-empty">正在读取分支…</div>}
      {refs && <div className="log-group">本地分支 · {local.length}</div>}
      {local.map((branch) => <div key={branch.fullName} className={`branch-row${branch.current ? " current" : ""}`}>
        <span className="branch-row-name" title={`${branch.fullName} @ ${shortOid(branch.oid)}`}>{branch.current ? "● " : ""}{branch.name}</span>
        <span className={`log-track ${branch.tracking?.state ?? ""}`} title={trackingText(branch.tracking).title}>{trackingText(branch.tracking).short}</span>
        {branch.current ? <small>当前</small> : <button type="button" disabled={!!blocked} title={blocked ?? `切换到 ${branch.name}`} onClick={() => act(() => actions.onSwitch(branch))}>切换</button>}
        <button type="button" aria-label={`${branch.name} 的更多操作`} aria-expanded={more === branch.fullName} onClick={() => setMore(more === branch.fullName ? null : branch.fullName)}>更多 ▾</button>
        {more === branch.fullName && <div className="branch-more" role="menu">
          <button type="button" role="menuitem" disabled={!!blocked} onClick={() => act(() => actions.onNew({ ref: branch.fullName, label: branch.name }))}>从这里新建分支…</button>
          <button type="button" role="menuitem" disabled={!!blocked} onClick={() => act(() => actions.onRename(branch))}>重命名…</button>
          <button type="button" role="menuitem" disabled={!!blocked || !refs?.remote.length} title={!refs?.remote.length ? "没有远端跟踪分支" : undefined} onClick={() => act(() => actions.onSetUpstream(branch))}>{branch.tracking && branch.tracking.state !== "noUpstream" ? "更换上游…" : "设置上游…"}</button>
          {actions.onMerge && !branch.current && <button type="button" role="menuitem" disabled={!!blocked || !!refs?.head.detached} title={refs?.head.detached ? "分离 HEAD 时不能合并" : undefined} onClick={() => act(() => actions.onMerge!(branch))}>合并到当前分支…</button>}
          <button type="button" role="menuitem" className="danger" disabled={!!blocked || branch.current} title={branch.current ? "不能删除当前分支，请先切换到其他分支" : undefined} onClick={() => act(() => actions.onDelete(branch))}>删除…</button>
        </div>}
      </div>)}
      {refs && <div className="log-group">远端跟踪分支 · {remote.length}</div>}
      {remote.map((branch) => <div key={branch.fullName} className="branch-row">
        <span className="branch-row-name" title={`${branch.fullName} @ ${shortOid(branch.oid)}`}>{branch.name}</span>
        <button type="button" disabled={!!blocked} title={blocked ?? "建立同名本地跟踪分支并切换"} onClick={() => act(() => actions.onTrack(branch))}>检出</button>
        <button type="button" aria-label={`从 ${branch.name} 新建分支`} disabled={!!blocked} onClick={() => act(() => actions.onNew({ ref: branch.fullName, label: branch.name }))}>新建…</button>
        {actions.onMerge && <button type="button" aria-label={`把 ${branch.name} 合并到当前分支`} disabled={!!blocked || !!refs?.head.detached} title={refs?.head.detached ? "分离 HEAD 时不能合并" : blocked ?? undefined} onClick={() => act(() => actions.onMerge!(branch))}>合并…</button>}
      </div>)}
      {refs && !local.length && !remote.length && <div className="log-empty">没有匹配的分支</div>}
    </div>
  </div>;
}
