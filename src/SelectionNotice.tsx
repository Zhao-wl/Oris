import { useEffect, useRef } from "react";

export const SELECTION_NOTICE_DURATION_MS = 5000;

/** 阅读位置失效提示：显示一段时间后自动关闭，也可手动关闭；文案变化时重新计时。 */
export default function SelectionNotice({ message, onDismiss, duration = SELECTION_NOTICE_DURATION_MS }: { message: string; onDismiss: () => void; duration?: number }) {
  // onDismiss 由父组件每次渲染重建；计时只按文案重启，到点时调用最新的回调。
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(), duration);
    return () => window.clearTimeout(timer);
  }, [message, duration]);
  return <div className="selection-notice" role="status"><strong>阅读位置已调整</strong><span>{message}</span><button type="button" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}>×</button></div>;
}
