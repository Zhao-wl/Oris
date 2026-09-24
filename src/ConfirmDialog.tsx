import { useEffect, useRef } from "react";

export interface ConfirmRequest {
  title: string;
  message: string;
  /** 受影响的文件等条目（超过 200 个时只列出前 200 个）。 */
  items?: string[];
  notes?: string[];
  /** 醒目标注，例如“不可撤销”。 */
  warning?: string;
  confirmLabel: string;
  danger?: boolean;
}

const MAX_ITEMS = 200;

/** 写操作确认框（R-OPSAFE 确认分级）：会改变工作区或历史的操作需要确认；危险操作默认焦点在“取消”。 */
export default function ConfirmDialog({ request, onConfirm, onCancel }: { request: ConfirmRequest; onConfirm(): void; onCancel(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (request.danger ? cancel : confirm).current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [request, onCancel]);
  const items = request.items ?? [];
  return <div className="dialog-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={request.title}>
      <h3>{request.title}</h3>
      {request.warning && <p className="confirm-warning">{request.warning}</p>}
      <p>{request.message}</p>
      {items.length > 0 && <ul className="confirm-items">{items.slice(0, MAX_ITEMS).map((item) => <li key={item} title={item}>{item}</li>)}{items.length > MAX_ITEMS && <li className="more">…还有 {items.length - MAX_ITEMS} 个</li>}</ul>}
      {request.notes?.map((note) => <p key={note} className="confirm-note">{note}</p>)}
      <div className="confirm-footer">
        <button type="button" ref={cancel} onClick={onCancel}>取消</button>
        <button type="button" ref={confirm} className={request.danger ? "danger-button" : "primary"} onClick={onConfirm}>{request.confirmLabel}</button>
      </div>
    </div>
  </div>;
}
