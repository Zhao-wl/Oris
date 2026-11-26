import { useCallback, useState, type KeyboardEvent, type MouseEvent } from "react";
import { MenuShell } from "./FileTree";

export function useFileHistoryMenu<T>(onOpen: ((item: T) => void) | undefined) {
  const [menu, setMenu] = useState<{ item: T; x: number; y: number; origin: HTMLElement } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const dismiss = useCallback(() => {
    setMenu(null);
    menu?.origin.focus();
  }, [menu]);
  const bindings = (item: T | null) => item !== null && onOpen ? {
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ item, x: event.clientX, y: event.clientY, origin: event.currentTarget });
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ item, x: rect.left, y: rect.bottom, origin: event.currentTarget });
    }
  } : {};
  const popup = menu && onOpen && <MenuShell x={menu.x} y={menu.y} label="文件历史操作" onClose={dismiss}>
    <button type="button" role="menuitem" onClick={() => { close(); onOpen(menu.item); }}>历史记录</button>
  </MenuShell>;
  return { bindings, popup, close };
}
