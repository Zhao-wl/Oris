import { useEffect, useRef, useState, type ReactNode } from "react";
import { mergeMessage, readRefs, shortOid, type RefsView } from "./history-api";
import { errorText } from "./error-message";
import { isStale, type PullMode } from "./history-model";

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

export type SyncKind = "fetch" | "pull" | "push";
/** 标题栏同步按钮所需的分支状态：直接取自当前快照（`status` 的 branch 头），打开时不另读 refs。 */
export interface SyncBranch { head: string | null; upstream: string | null; ahead: number | null; behind: number | null }

export interface SyncToolbarProps {
  repoId: string;
  branch: SyncBranch;
  blocked: string | null;
  running: SyncKind | null;
  fetchAge: string | null;
  fetchTitle: string;
  pullMode: PullMode;
  menu: SyncKind | null;
  onMenu(menu: SyncKind | null): void;
  onFetch(remote: string | null): void;
  onPull(): void;
  onPush(): void;
  onCancel(): void;
  onPullMode(mode: PullMode): void;
  onChangeUpstream(): void;
}

const runningLabels: Record<SyncKind, string> = { fetch: "获取中", pull: "拉取中", push: "推送中" };
const pullModes: [PullMode, string, string][] = [
  ["ffOnly", "仅快进", "本地没有上游之外的提交时才更新；已分叉时询问"],
  ["merge", "合并远端改动", "能快进时快进，已分叉时生成合并提交"]
];

/**
 * 标题栏同步入口（[同步工具栏改版参考图](../docs/design/06-sync-toolbar-ui.md)）：获取 / 拉取 / 推送三个分体按钮。
 * 主按钮直接执行，▾ 打开选项；执行中主按钮变为取消。
 */
export function SyncToolbar(props: SyncToolbarProps) {
  const { branch, blocked, running, menu, onMenu } = props;
  const host = useRef<HTMLSpanElement>(null);
  const menuRef = useRef(onMenu);
  menuRef.current = onMenu;
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!host.current?.contains(event.target as Node)) menuRef.current(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector(".dialog-overlay")) { event.preventDefault(); menuRef.current(null); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key, true); };
  }, [menu]);
  const detached = !branch.head;
  const count = (value: number | null, arrow: string) => <span className={`sync-count${value ? "" : " zero"}`}>{arrow}{value ?? "?"}</span>;
  const reasons: Record<SyncKind, string | null> = {
    fetch: blocked,
    pull: blocked ?? (detached ? "分离 HEAD：请先切换到分支" : !branch.upstream ? "当前分支没有上游：先推送（发布分支），或在 拉取 ▾ 中设置上游" : null),
    push: blocked ?? (detached ? "分离 HEAD：不能推送，请先切换到分支或从这里新建分支" : null)
  };
  const titles: Record<SyncKind, string> = {
    fetch: `获取远端状态：只更新远端跟踪分支，不改工作区。${props.fetchTitle}`,
    pull: `从 ${branch.upstream ?? "上游"} 拉取（${props.pullMode === "ffOnly" ? "仅快进" : "合并远端改动"}）；不做 rebase`,
    push: branch.upstream ? `推送到 ${branch.upstream}；只推送当前分支，不推送 tag，不强制推送` : `当前分支没有上游：推送到 remote 的同名分支并设为上游`
  };
  const labels: Record<SyncKind, ReactNode> = {
    fetch: <>⟳ 获取{props.fetchAge && <small>{props.fetchAge}</small>}</>,
    pull: <>{branch.upstream ? count(branch.behind, "↓") : "↓"} 拉取</>,
    push: branch.upstream ? <>{count(branch.ahead, "↑")} 推送</> : <>↑ 发布分支</>
  };
  const run: Record<SyncKind, () => void> = { fetch: () => props.onFetch(null), pull: props.onPull, push: props.onPush };
  const split = (kind: SyncKind) => {
    const active = running === kind;
    const reason = reasons[kind];
    return <span key={kind} className={`sync-split sync-${kind}`}>
      <button type="button" className={`sync-main${active ? " running" : ""}`} disabled={!active && !!reason} title={active ? "点击取消" : reason ?? titles[kind]}
        onClick={() => { onMenu(null); if (active) props.onCancel(); else run[kind](); }}>
        {active ? <><span className="sync-spin" aria-hidden="true"/>{runningLabels[kind]}… <small>✕ 取消</small></> : labels[kind]}
      </button>
      <button type="button" className="sync-more" aria-label={`${{ fetch: "获取", pull: "拉取", push: "推送" }[kind]}选项`} aria-expanded={menu === kind} disabled={!!running}
        onClick={() => onMenu(menu === kind ? null : kind)}>▾</button>
      {menu === kind && <SyncMenu kind={kind} {...props} reason={reason}/>}
    </span>;
  };
  return <span ref={host} className="sync-toolbar">{(["fetch", "pull", "push"] as const).map(split)}</span>;
}

function SyncMenu({ kind, repoId, branch, pullMode, reason, onMenu, onFetch, onPush, onPullMode, onChangeUpstream }: SyncToolbarProps & { kind: SyncKind; reason: string | null }) {
  if (kind === "fetch") return <FetchMenu repoId={repoId} reason={reason} onFetch={(remote) => { onMenu(null); onFetch(remote); }}/>;
  if (kind === "pull") return <div className="sync-menu" role="menu" aria-label="拉取选项">
    <div className="sync-menu-head">拉取方式（选中即设为本仓库默认）</div>
    {pullModes.map(([mode, label, note]) => <button key={mode} type="button" role="menuitemradio" aria-checked={pullMode === mode} className="sync-menu-item" onClick={() => { onMenu(null); onPullMode(mode); }}>
      <span className="sync-dot">{pullMode === mode ? "●" : ""}</span><span>{label}<small>{note}</small></span>
    </button>)}
    <hr/>
    <button type="button" role="menuitem" className="sync-menu-item" disabled={!branch.head} onClick={() => { onMenu(null); onChangeUpstream(); }}><span className="sync-dot"/><span>{branch.upstream ? "更换上游…" : "设置上游…"}</span></button>
    <div className="sync-menu-note">不做 rebase；配置了 pull.rebase 时也以合并执行。不递归子模块、不自动储藏。</div>
  </div>;
  return <div className="sync-menu" role="menu" aria-label="推送选项">
    <div className="sync-menu-head">{!branch.head ? "分离 HEAD：不能推送" : branch.upstream ? `推送 ${branch.head} → ${branch.upstream}${branch.ahead !== null ? `：领先 ${branch.ahead} 个提交` : ""}` : `${branch.head} 还没有上游：推送到 remote 的同名分支并设为上游`}</div>
    <button type="button" role="menuitem" className="sync-menu-item" disabled={!!reason} title={reason ?? undefined} onClick={() => { onMenu(null); onPush(); }}><span className="sync-dot"/><span>{branch.upstream ? "推送" : "发布分支"}</span></button>
    <div className="sync-menu-note">只推送当前分支；不推送 tag；不提供强制推送。远端有本地没有的提交时会被拒绝，请先拉取。</div>
  </div>;
}

/** 获取 ▾：展开时才读取 remote 列表（主按钮不需要）。 */
function FetchMenu({ repoId, reason, onFetch }: { repoId: string; reason: string | null; onFetch(remote: string): void }) {
  const [refs, setRefs] = useState<RefsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readRefs(repoId).then((view) => { if (live) setRefs(view); }, (e) => { if (live && !isStale(e)) setError(errorText(e)); });
    return () => { live = false; };
  }, [repoId]);
  return <div className="sync-menu" role="menu" aria-label="获取选项">
    <div className="sync-menu-head">获取远端状态（只更新远端跟踪分支与标签，不改工作区）</div>
    {error && <div className="sync-menu-note log-error">{error}</div>}
    {!refs && !error && <div className="sync-menu-note">正在读取 remote…</div>}
    {refs && !refs.remotes.length && <div className="sync-menu-note">该仓库没有配置 remote；Oris 不会新增 remote</div>}
    {refs?.remotes.map((remote) => <button key={remote} type="button" role="menuitem" className="sync-menu-item" disabled={!!reason} title={reason ?? undefined} onClick={() => onFetch(remote)}>
      <span className="sync-dot">{remote === refs.defaultRemote ? "●" : ""}</span><span>{remote}{remote === refs.defaultRemote && <small>当前分支上游所属，主按钮默认</small>}</span>
    </button>)}
    <div className="sync-menu-note">不 prune、不递归子模块；认证使用本机已有凭据，Oris 不弹出密码输入。</div>
  </div>;
}

/** 一键获取 / 推送无法确定 remote 时（没有可用上游且有多个 remote）：选择一个后重试。 */
export function RemoteChoiceDialog({ kind, remotes, message, onConfirm, onCancel }: { kind: "fetch" | "push"; remotes: string[]; message: string; onConfirm(remote: string): void; onCancel(): void }) {
  const [remote, setRemote] = useState(remotes[0] ?? "");
  return <Shell title={kind === "fetch" ? "选择要获取的 remote" : "选择要发布到的 remote"} className="remote-choice-dialog" onCancel={onCancel} footer={<>
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!remote} onClick={() => onConfirm(remote)}>{kind === "fetch" ? "获取" : "发布"}</button>
  </>}>
    <p>{message}</p>
    {remotes.map((name) => <label key={name} className="dialog-check"><input type="radio" name="remote-choice" aria-label={name} checked={remote === name} onChange={() => setRemote(name)}/> {name}</label>)}
    {kind === "push" && <p className="confirm-note">推送到所选 remote 的同名分支，并设为上游。</p>}
  </Shell>;
}

export interface SyncToastState { id: number; kind: SyncKind; status: "succeeded" | "failed" | "cancelled"; title: string; detail: string | null; actions: { label: string; run(): void }[] }

/** 同步结果提示（右下角）：成功几秒后消失；失败保留，并给出下一步动作。 */
export function SyncToast({ toast, onDismiss }: { toast: SyncToastState; onDismiss(): void }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (toast.status !== "succeeded") return;
    const timer = window.setTimeout(() => dismissRef.current(), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return <div className={`sync-toast ${toast.status}`} role={toast.status === "failed" ? "alert" : "status"}>
    <span className="sync-toast-text">{toast.title}{toast.detail && <small>{toast.detail}</small>}</span>
    {toast.actions.map((action) => <button key={action.label} type="button" onClick={() => { onDismiss(); action.run(); }}>{action.label}</button>)}
    <button type="button" className="quiet" aria-label="关闭提示" onClick={onDismiss}>×</button>
  </div>;
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
