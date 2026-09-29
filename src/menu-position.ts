import { useLayoutEffect, useState, type RefObject } from "react";

const EDGE = 4;

/**
 * 把以 (x, y) 为锚点的浮层放进视口：下方放不下就翻到锚点上方，右侧放不下就向左移，仍放不下时贴住视口边缘。
 */
export function fitInViewport(x: number, y: number, width: number, height: number, viewWidth: number, viewHeight: number) {
  const left = x + width > viewWidth - EDGE ? viewWidth - EDGE - width : x;
  const top = y + height > viewHeight - EDGE ? y - height : y;
  return {
    left: Math.max(EDGE, Math.min(left, viewWidth - EDGE - width)),
    top: Math.max(EDGE, Math.min(top, viewHeight - EDGE - height)),
  };
}

/** 右键菜单定位：绘制前量出菜单尺寸再修正，避免靠近窗口底部 / 右侧时菜单跑出屏幕。 */
export function useMenuPosition(host: RefObject<HTMLElement | null>, x: number, y: number) {
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) { setPosition({ left: x, top: y }); return; }
    setPosition(fitInViewport(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
  }, [host, x, y]);
  return position;
}
