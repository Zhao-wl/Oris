import { useEffect, useRef, useState, type ReactNode } from "react";
import { checkBranchName, shortOid, shortRef, type Branch, type RefsView } from "./history-api";
import { errorText } from "./error-message";

function Shell({ title, children, onCancel, footer }: { title: string; children: ReactNode; onCancel(): void; footer: ReactNode }) {
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRef.current(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="confirm-dialog branch-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <h3>{title}</h3>
      {children}
      <div className="confirm-footer">{footer}</div>
    </div>
  </div>;
}

/** 分支名输入：提交前用 Git 规则（check-ref-format --branch）校验，结果随输入更新。 */
function useBranchName(repoId: string, initial = "") {
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(initial ? null : "请输入分支名");
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!name.trim()) { setProblem("请输入分支名"); return; }
    let live = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void checkBranchName(repoId, name).then(() => { if (live) { setProblem(null); setChecking(false); } }, (error) => { if (live) { setProblem(errorText(error)); setChecking(false); } });
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [repoId, name]);
  return { name, setName, problem: checking ? "正在校验分支名…" : problem };
}

export interface NewBranchRequest { name: string; start: string; switch: boolean }

/** 新建分支：起点为当前 HEAD、选中的分支或提交；可选择创建后是否立即切换。 */
export function NewBranchDialog({ repoId, refs, initial, blocked, onConfirm, onCancel }: { repoId: string; refs: RefsView | null; initial: { ref: string; label: string } | null; blocked: string | null; onConfirm(request: NewBranchRequest): void; onCancel(): void }) {
  const { name, setName, problem } = useBranchName(repoId);
  const [start, setStart] = useState(initial?.ref ?? "HEAD");
  const [switchAfter, setSwitchAfter] = useState(true);
  const commitStart = initial && !initial.ref.startsWith("refs/") && initial.ref !== "HEAD";
  const exists = refs?.local.some((b) => b.name === name.trim());
  const reason = blocked ?? problem ?? (exists ? `本地分支 ${name.trim()} 已存在` : null);
  return <Shell title="新建分支" onCancel={onCancel} footer={<>
    {reason && <span className="fetch-reason">{reason}</span>}
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!!reason} onClick={() => onConfirm({ name: name.trim(), start, switch: switchAfter })}>{switchAfter ? "新建并切换" : "新建"}</button>
  </>}>
    <label className="dialog-field">分支名<input aria-label="新分支名" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 feature/login"/></label>
    <label className="dialog-field">起点<select aria-label="新分支起点" value={start} onChange={(event) => setStart(event.target.value)}>
      <option value="HEAD">当前 HEAD{refs?.head.oid ? `（${shortOid(refs.head.oid)}）` : ""}</option>
      {commitStart && <option value={initial.ref}>提交 {initial.label}</option>}
      {refs?.local.map((b) => <option key={b.fullName} value={b.fullName}>本地 {b.name}（{shortOid(b.oid)}）</option>)}
      {refs?.remote.map((b) => <option key={b.fullName} value={b.fullName}>远端 {b.name}（{shortOid(b.oid)}）</option>)}
    </select></label>
    <label className="dialog-check"><input type="checkbox" aria-label="创建后立即切换" checked={switchAfter} onChange={(event) => setSwitchAfter(event.target.checked)}/> 创建后立即切换</label>
    <p className="confirm-note">起点在执行前解析为提交 OID；新分支不设置上游（需要时在分支弹层“设置上游”）。</p>
  </Shell>;
}

export function RenameBranchDialog({ repoId, branch, refs, blocked, onConfirm, onCancel }: { repoId: string; branch: Branch; refs: RefsView | null; blocked: string | null; onConfirm(newName: string): void; onCancel(): void }) {
  const { name, setName, problem } = useBranchName(repoId, branch.name);
  const same = name.trim() === branch.name;
  const exists = !same && refs?.local.some((b) => b.name === name.trim());
  const reason = blocked ?? (same ? "新名称与原名称相同" : problem) ?? (exists ? `本地分支 ${name.trim()} 已存在` : null);
  return <Shell title={`重命名分支 ${branch.name}`} onCancel={onCancel} footer={<>
    {reason && <span className="fetch-reason">{reason}</span>}
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!!reason} onClick={() => onConfirm(name.trim())}>重命名</button>
  </>}>
    <label className="dialog-field">新名称<input aria-label="分支新名称" autoFocus value={name} onChange={(event) => setName(event.target.value)}/></label>
    <p className="confirm-note">只重命名本地分支；远端分支不会被重命名，上游配置随分支保留。</p>
  </Shell>;
}

export function UpstreamDialog({ branch, refs, blocked, onConfirm, onCancel }: { branch: Branch; refs: RefsView | null; blocked: string | null; onConfirm(upstream: string): void; onCancel(): void }) {
  const current = branch.tracking && branch.tracking.state !== "noUpstream" ? branch.tracking.upstream : "";
  const [upstream, setUpstream] = useState(current || (refs?.remote.find((b) => b.name.endsWith(`/${branch.name}`))?.fullName ?? ""));
  const reason = blocked ?? (!upstream ? "请选择远端跟踪分支" : upstream === current ? "与当前上游相同" : null);
  return <Shell title={`设置 ${branch.name} 的上游`} onCancel={onCancel} footer={<>
    {reason && <span className="fetch-reason">{reason}</span>}
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" className="primary" disabled={!!reason} onClick={() => onConfirm(upstream)}>设为上游</button>
  </>}>
    <p>当前上游：{current ? shortRef(current) : "无"}</p>
    <label className="dialog-field">远端跟踪分支<select aria-label="上游分支" value={upstream} onChange={(event) => setUpstream(event.target.value)}>
      <option value="">请选择…</option>
      {refs?.remote.map((b) => <option key={b.fullName} value={b.fullName}>{b.name}</option>)}
    </select></label>
    <p className="confirm-note">只修改本地配置（branch.{branch.name}.remote / merge），不联网、不推送。</p>
  </Shell>;
}

/** 远端分支检出时同名本地分支已存在：切换到已有分支，或用新名称建立跟踪分支。 */
export function TrackChoiceDialog({ repoId, remote, existing, refs, onSwitchExisting, onTrackAs, onCancel }: { repoId: string; remote: Branch; existing: string; refs: RefsView | null; onSwitchExisting(): void; onTrackAs(name: string): void; onCancel(): void }) {
  const { name, setName, problem } = useBranchName(repoId, `${existing}-2`);
  const exists = refs?.local.some((b) => b.name === name.trim());
  const reason = problem ?? (exists ? `本地分支 ${name.trim()} 也已存在` : null);
  return <Shell title={`检出 ${remote.name}`} onCancel={onCancel} footer={<>
    <button type="button" onClick={onCancel}>取消</button>
    <button type="button" onClick={onSwitchExisting}>切换到已有的 {existing}</button>
    <button type="button" className="primary" disabled={!!reason} title={reason ?? undefined} onClick={() => onTrackAs(name.trim())}>新建跟踪分支</button>
  </>}>
    <p>已存在同名本地分支 <strong>{existing}</strong>。可以切换到这个已有分支（不改变它的上游），或用另一个名称新建跟踪 {remote.name} 的本地分支。</p>
    <label className="dialog-field">新分支名<input aria-label="跟踪分支名" value={name} onChange={(event) => setName(event.target.value)}/></label>
    {reason && <p className="confirm-note">{reason}</p>}
  </Shell>;
}
