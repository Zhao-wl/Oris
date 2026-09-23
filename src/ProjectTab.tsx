import { useRef, useState, type PointerEvent } from "react";
import { projectName, type ProjectRecord } from "./workspace-model";

// 移动超过该距离才视为拖动，否则按点击处理。
const DRAG_THRESHOLD = 4;

interface Props {
  project: ProjectRecord;
  active: boolean;
  onSelect(): void;
  onRename(name: string): void;
  onRemove(): void;
  /** 拖动到另一个页签上松开时调用，参数为目标页签的 repoId。 */
  onReorder(targetRepoId: string): void;
}

// Tauri 在 Windows 上默认接管原生拖放（dragDropEnabled），HTML5 drag 事件不会到达 WebView，
// 因此用 Pointer Events 自行实现页签排序。
const tabAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>(".project-tab[data-repo-id]") ?? null;
const clearDropTarget = () => document.querySelectorAll(".project-tab.drop-target").forEach(node => node.classList.remove("drop-target"));

export default function ProjectTab({ project, active, onSelect, onRename, onRemove, onReorder }: Props) {
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const editingNow = useRef(false);
  const pointer = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const name = projectName(project);
  const repoId = project.repo.repoId;
  const beginEdit = () => {
    editingNow.current = true;
    setDraft(project.customName ?? ""); setEditing(true);
  };
  const finishEdit = (save: boolean) => {
    if (!editingNow.current) return;
    editingNow.current = false;
    if (save) onRename(draft.trim());
    setEditing(false);
  };
  const dropTarget = (event: PointerEvent) => {
    const target = tabAt(event.clientX, event.clientY);
    return target && target.dataset.repoId !== repoId ? target : null;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || editingNow.current) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = pointer.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.dragging) {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD) return;
      state.dragging = true; setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const target = dropTarget(event);
    if (!target?.classList.contains("drop-target")) { clearDropTarget(); target?.classList.add("drop-target"); }
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>, drop: boolean) => {
    const state = pointer.current;
    if (!state || state.id !== event.pointerId) return;
    pointer.current = null;
    if (!state.dragging) return;
    clearDropTarget(); setDragging(false);
    // 拖动结束后浏览器仍会派发一次 click，需要忽略，避免拖动时顺带切换项目。
    suppressClick.current = true;
    const target = drop ? dropTarget(event) : null;
    if (target?.dataset.repoId) onReorder(target.dataset.repoId);
  };
  return <div className={`project-tab${active ? " active" : ""}${dragging ? " dragging" : ""}`} title={project.repo.worktreePath} data-repo-id={repoId}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={event => endPointer(event, true)} onPointerCancel={event => endPointer(event, false)}
    onClick={() => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      if (!editingNow.current) onSelect();
    }}>
    <span className="project-drag" aria-hidden="true">⠿</span>
    {editing ? <div className="project-label">
      <input autoFocus className="project-rename" aria-label="项目显示名称" value={draft} placeholder={project.repo.displayName}
        onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishEdit(false); }
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        }} onBlur={() => finishEdit(true)}/>
      <small title={project.repo.worktreePath}>{project.repo.worktreePath}</small>
    </div> : <button type="button" className="project-switch" aria-pressed={active}
      onKeyDown={event => { if (event.key === "F2") { event.preventDefault(); beginEdit(); } }}>
      <span title={`${name} · 双击重命名（F2）`} onDoubleClick={event => { event.stopPropagation(); beginEdit(); }}>{name}</span>
      <small title={project.repo.worktreePath}>{project.repo.worktreePath}</small>
    </button>}
    <button type="button" className="project-close" aria-label={`移除项目 ${name}`} title="只移除 Oris 记录，不删除目录"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onRemove(); }}>×</button>
  </div>;
}
