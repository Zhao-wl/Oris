import { useEffect, useRef } from "react";

export type SwitchChoice = "discard" | "merge";

export interface SwitchRequest {
  target: string;
  message: string;
  paths: string[];
  /** Git 报告未跟踪文件会被覆盖：放弃时一并删除未跟踪文件，不能带着改动切换。 */
  untracked: boolean;
  /** 有已暂存的改动：`switch --merge` 会拒绝。 */
  staged: boolean;
}

const MAX_ITEMS = 200;

function split(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/** Git 因本地改动拒绝切换时的选择：放弃修改后切换 / 带着改动切换 / 取消。默认焦点在“取消”。 */
export default function SwitchDialog({ request, onChoose, onCancel }: { request: SwitchRequest; onChoose(choice: SwitchChoice): void; onCancel(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [request, onCancel]);
  const { target, paths, untracked, staged } = request;
  const mergeBlocked = untracked ? "未跟踪文件会被覆盖，Git 不能带着改动切换" : staged ? "有已暂存的改动，Git 不能带着改动切换；可先取消暂存" : null;
  return <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="confirm-dialog switch-dialog" role="alertdialog" aria-modal="true" aria-label={`切换到 ${target}`}>
      <h3>切换到 <span className="switch-target">{target}</span></h3>
      <p className="switch-reason">{request.message}</p>
      {paths.length > 0 && <>
        <div className="switch-files-head">{untracked ? "会被覆盖的未跟踪文件" : "有本地改动的文件"} · {paths.length}</div>
        <ul className="switch-files">
          {paths.slice(0, MAX_ITEMS).map((path) => { const { name, dir } = split(path); return <li key={path} title={path}><span className="switch-file-name">{name}</span>{dir && <span className="switch-file-dir">{dir}</span>}</li>; })}
          {paths.length > MAX_ITEMS && <li className="more">…还有 {paths.length - MAX_ITEMS} 个</li>}
        </ul>
      </>}
      <div className="switch-options">
        <button type="button" className="switch-option danger" onClick={() => onChoose("discard")}>
          <strong>放弃修改后切换</strong>
          <span>{untracked ? "丢弃全部本地改动，包括未跟踪文件" : "丢弃已跟踪文件的全部改动，未跟踪文件保留"}。丢弃前自动备份，结果中给出找回命令</span>
        </button>
        <button type="button" className="switch-option" disabled={!!mergeBlocked} title={mergeBlocked ?? undefined} onClick={() => onChoose("merge")}>
          <strong>带着改动切换</strong>
          <span>{mergeBlocked ?? `把改动带到 ${target}；与目标版本冲突的文件会写入冲突标记，需要手动解决`}</span>
        </button>
      </div>
      <div className="confirm-footer"><button type="button" ref={cancel} onClick={onCancel}>取消</button></div>
    </div>
  </div>;
}
