import { describe, expect, it, vi } from "vitest";
import { createUpdater, type UpdateApi } from "./update-model";
import type { UpdateCheck, UpdateProgress } from "./update-api";

const info = { version: "0.2.0", notes: "修复若干问题", date: "2026-09-28" };
const bridge = (check: () => Promise<UpdateCheck>) => {
  let progress: ((p: UpdateProgress) => void) | null = null;
  const api = {
    checkUpdate: vi.fn(check),
    downloadUpdate: vi.fn(async () => { progress?.({ version: "0.2.0", downloaded: 50, total: 100 }); return "0.2.0"; }),
    installUpdate: vi.fn(async () => {}),
    openReleasesPage: vi.fn(async () => {}),
    onUpdateProgress: vi.fn(async (handler: (p: UpdateProgress) => void) => { progress = handler; return () => {}; })
  };
  return api as typeof api & UpdateApi;
};

describe("update state machine", () => {
  it("downloads an installable update in the background and waits for the user to restart", async () => {
    const api = bridge(async () => ({ currentVersion: "0.1.0", installable: true, available: info }));
    const updater = createUpdater(api, () => 42);
    await updater.check();
    expect(api.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.store.get()).toMatchObject({ currentVersion: "0.1.0", checkedAt: 42, upToDate: false, phase: { kind: "ready", info } });
    expect(api.installUpdate).not.toHaveBeenCalled();
    // 待重启时的定时检查不会打断已下载的更新。
    await updater.check();
    expect(api.checkUpdate).toHaveBeenCalledOnce();
    await updater.install();
    expect(api.installUpdate).toHaveBeenCalledOnce();
  });

  it("does not download when the running copy cannot be updated in place", async () => {
    const api = bridge(async () => ({ currentVersion: "0.1.0", installable: false, available: info }));
    const updater = createUpdater(api);
    await updater.check();
    expect(updater.store.get().phase).toEqual({ kind: "manual", info });
    expect(api.downloadUpdate).not.toHaveBeenCalled();
    await updater.openDownloadPage();
    expect(api.openReleasesPage).toHaveBeenCalledOnce();
  });

  it("keeps automatic check failures silent but reports manual ones", async () => {
    const api = bridge(async () => { throw "网络不可用"; });
    const updater = createUpdater(api);
    await updater.check();
    expect(updater.store.get().phase).toEqual({ kind: "idle" });
    await updater.check({ manual: true });
    expect(updater.store.get().phase).toEqual({ kind: "failed", stage: "check", info: null, message: "网络不可用" });
  });

  it("reports up to date and retries a failed download", async () => {
    const api = bridge(async () => ({ currentVersion: "0.2.0", installable: true, available: null }));
    const updater = createUpdater(api);
    await updater.check({ manual: true });
    expect(updater.store.get()).toMatchObject({ upToDate: true, phase: { kind: "idle" } });

    api.checkUpdate.mockResolvedValue({ currentVersion: "0.1.0", installable: true, available: info });
    api.downloadUpdate.mockRejectedValueOnce(new Error("签名校验失败"));
    await updater.check();
    expect(updater.store.get().phase).toEqual({ kind: "failed", stage: "download", info, message: "签名校验失败" });
    updater.retry();
    await vi.waitFor(() => expect(updater.store.get().phase.kind).toBe("ready"));
  });

  it("returns to a retryable state when the installer cannot start", async () => {
    const api = bridge(async () => ({ currentVersion: "0.1.0", installable: true, available: info }));
    api.installUpdate.mockRejectedValueOnce("安装更新失败：拒绝访问");
    const updater = createUpdater(api);
    await updater.check();
    await updater.install();
    expect(updater.store.get().phase).toEqual({ kind: "failed", stage: "install", info, message: "安装更新失败：拒绝访问" });
    await updater.install();
    expect(api.installUpdate).toHaveBeenCalledTimes(2);
  });
});
