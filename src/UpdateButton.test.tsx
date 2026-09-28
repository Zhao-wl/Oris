// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UpdateButton from "./UpdateButton";
import { createUpdater, type UpdateApi } from "./update-model";

const info = { version: "0.2.0", notes: null, date: null };
let root: Root;
let host: HTMLDivElement;
let api: { -readonly [K in keyof UpdateApi]: UpdateApi[K] } & { installUpdate: ReturnType<typeof vi.fn> };
const buttons = () => [...host.querySelectorAll("button")];
const click = async (element: Element) => { await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  api = {
    checkUpdate: vi.fn(async () => ({ currentVersion: "0.1.0", installable: true, available: info })),
    downloadUpdate: vi.fn(async () => "0.2.0"),
    installUpdate: vi.fn(async () => {}),
    openReleasesPage: vi.fn(async () => {}),
    onUpdateProgress: vi.fn(async () => () => {})
  };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("takes no space without an update, then stays visible as 重启以更新", async () => {
  const updater = createUpdater(api);
  await act(async () => root.render(<UpdateButton autoCheck={false} busyReason={null} updater={updater}/>));
  expect(host.textContent).toBe("");
  await act(async () => updater.check());
  const restart = buttons().find((b) => b.textContent === "重启以更新")!;
  expect(restart.title).toContain("Oris 0.2.0");
  await click(restart);
  expect(api.installUpdate).toHaveBeenCalledOnce();
});

it("asks before restarting while a write operation is running", async () => {
  const updater = createUpdater(api);
  await act(async () => root.render(<UpdateButton autoCheck={false} busyReason="推送" updater={updater}/>));
  await act(async () => updater.check());
  await click(buttons().find((b) => b.textContent === "重启以更新")!);
  expect(api.installUpdate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alertdialog"]')!.textContent).toContain("正在推送");
  await click(buttons().find((b) => b.textContent === "取消")!);
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  await click(buttons().find((b) => b.textContent === "重启以更新")!);
  await click(buttons().find((b) => b.textContent === "仍然重启")!);
  expect(api.installUpdate).toHaveBeenCalledOnce();
});

it("links the portable copy to the download page instead of installing", async () => {
  api.checkUpdate = vi.fn(async () => ({ currentVersion: "0.1.0", installable: false, available: info }));
  const updater = createUpdater(api);
  await act(async () => root.render(<UpdateButton autoCheck={false} busyReason={null} updater={updater}/>));
  await act(async () => updater.check());
  await click(buttons().find((b) => b.textContent === "新版本 0.2.0")!);
  expect(api.openReleasesPage).toHaveBeenCalledOnce();
  expect(api.downloadUpdate).not.toHaveBeenCalled();
});
