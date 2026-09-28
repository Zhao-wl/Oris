import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";

/** 超过该行数时启用虚拟列表（技术方案 §5.7）。 */
export const VIRTUAL_THRESHOLD = 500;
const OVERSCAN = 12;

/**
 * 固定行高的虚拟列表：只渲染可视区域附近的行。
 * 滚动容器为最近的 `scrollParent` 祖先；行高取第一个匹配 `sampleRow` 的已渲染行。
 */
export default function VirtualRows({ count, scrollParent, sampleRow, render }: { count: number; scrollParent: string; sampleRow: string; render(index: number, style: CSSProperties): JSX.Element }) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800, rowHeight: 32 });
  useLayoutEffect(() => {
    const container = host.current?.closest(scrollParent) as HTMLElement | null;
    if (!container) return;
    const measure = () => {
      const sample = host.current?.querySelector<HTMLElement>(sampleRow);
      const rowHeight = sample?.getBoundingClientRect().height || 32;
      // 列表在滚动容器内容中的起始位置（容器之前可能还有其他内容，例如提交元信息）。
      const offset = host.current ? host.current.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop : 0;
      setView((current) => {
        const next = { top: Math.max(0, container.scrollTop - offset), height: container.clientHeight || 800, rowHeight };
        return current.top === next.top && current.height === next.height && current.rowHeight === next.rowHeight ? current : next;
      });
    };
    measure();
    container.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => { container.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [count, scrollParent, sampleRow]);
  const start = Math.max(0, Math.floor(view.top / view.rowHeight) - OVERSCAN);
  const end = Math.min(count, Math.ceil((view.top + view.height) / view.rowHeight) + OVERSCAN);
  const rows: JSX.Element[] = [];
  for (let index = start; index < end; index++) rows.push(render(index, { position: "absolute", top: index * view.rowHeight, left: 0, right: 0 }));
  return <div ref={host} className="virtual-rows" style={{ position: "relative", height: count * view.rowHeight }} data-virtual-count={count}>{rows}</div>;
}
