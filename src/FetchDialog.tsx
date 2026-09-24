import { useEffect, useRef, useState } from "react";
import type { RefsView } from "./history-api";

/**
 * 显式获取远端状态（R-REMOTE）：说明会更新本地 Git 元数据、不修改工作区；默认目标为当前分支上游所属的 remote，
 * 没有有效上游时由用户从已有 remote 中选择。不 prune、不递归子模块、不附带 pull / push。
 */
export default function FetchDialog({ refs, fetchText, blocked, onConfirm, onCancel }: { refs: RefsView | null; fetchText: string; blocked: string | null; onConfirm(remote: string): void; onCancel(): void }) {
  const [remote, setRemote] = useState<string>("");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (refs?.defaultRemote) setRemote((current) => current || refs.defaultRemote!); }, [refs]);
  useEffect(() => {
    cancel.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onCancel]);
  const remotes = refs?.remotes ?? [];
  const reason = blocked ?? (!refs ? "正在读取 remote…" : !remotes.length ? "该仓库没有配置 remote；Oris 不会新增 remote" : !remote ? "请选择要获取的 remote" : null);
  return <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="confirm-dialog fetch-dialog" role="dialog" aria-modal="true" aria-label="获取远端状态">
      <h3>获取远端状态</h3>
      <p>从所选 remote 获取远端跟踪分支与标签，更新本地 Git 元数据（<code>refs/remotes</code>、<code>FETCH_HEAD</code> 等）。不修改工作区、暂存区与当前分支；不拉取合并、不推送、不 prune、不递归子模块。认证使用本机已有的凭据（Git Credential Manager、ssh-agent），Oris 不会弹出密码输入。</p>
      <label className="fetch-remote">remote：
        <select aria-label="获取的 remote" value={remote} onChange={(event) => setRemote(event.target.value)} disabled={!remotes.length}>
          {!refs?.defaultRemote && <option value="">请选择…</option>}
          {remotes.map((name) => <option key={name} value={name}>{name}{name === refs?.defaultRemote ? "（当前分支上游）" : ""}</option>)}
        </select>
      </label>
      <p className="confirm-note">{refs?.defaultRemote ? `默认获取当前分支上游所属的 ${refs.defaultRemote}。` : refs ? "当前分支没有有效上游，请选择一个已有的 remote。" : ""}</p>
      <p className="confirm-note">{fetchText}</p>
      <p className="confirm-note">获取失败或取消时，结束前已写入的远端跟踪引用不会回滚；Oris 会重新读取实际引用并如实说明。</p>
      <div className="confirm-footer">
        {reason && <span className="fetch-reason">{reason}</span>}
        <button type="button" ref={cancel} onClick={onCancel}>取消</button>
        <button type="button" className="primary" disabled={!!reason} onClick={() => onConfirm(remote)}>获取</button>
      </div>
    </div>
  </div>;
}
