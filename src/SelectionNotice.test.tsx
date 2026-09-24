// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SelectionNotice, { SELECTION_NOTICE_DURATION_MS } from "./SelectionNotice";

let root: Root;
let host: HTMLDivElement;
const render = async (message: string, onDismiss: () => void) => { await act(async () => root.render(<SelectionNotice message={message} onDismiss={onDismiss}/>)); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("dismisses itself after the display duration", async () => {
  const onDismiss = vi.fn(); await render("已改为第一个可用变化文件：a.md", onDismiss);
  expect(host.textContent).toContain("已改为第一个可用变化文件：a.md");
  await act(async () => { vi.advanceTimersByTime(SELECTION_NOTICE_DURATION_MS - 1); }); expect(onDismiss).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); }); expect(onDismiss).toHaveBeenCalledOnce();
});
it("closes from the close button and restarts the timer only when the message changes", async () => {
  const onDismiss = vi.fn(); await render("甲", onDismiss);
  await act(async () => { vi.advanceTimersByTime(SELECTION_NOTICE_DURATION_MS - 100); });
  await render("甲", vi.fn(() => onDismiss())); // 父组件重渲染不重新计时
  await act(async () => { vi.advanceTimersByTime(100); }); expect(onDismiss).toHaveBeenCalledOnce();
  await render("乙", onDismiss);
  await act(async () => { vi.advanceTimersByTime(SELECTION_NOTICE_DURATION_MS - 1); }); expect(onDismiss).toHaveBeenCalledOnce();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')!.click()); expect(onDismiss).toHaveBeenCalledTimes(2);
});
