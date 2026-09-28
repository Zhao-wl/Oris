import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import ConfirmDialog from "./ConfirmDialog";
import { useStore } from "./store";
import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS, updater as defaultUpdater, type UpdatePhase, type Updater } from "./update-model";

interface Props {
  autoCheck: boolean;
  /** 正在进行的写操作（例如“推送”）；重启前需要用户确认。 */
  busyReason: string | null;
  updater?: Updater;
}

const percent = (phase: Extract<UpdatePhase, { kind: "downloading" }>) =>
  phase.total ? Math.min(99, Math.floor((phase.downloaded / phase.total) * 100)) : null;

const describe = (info: { version: string; notes: string | null }) => `Oris ${info.version}${info.notes ? `\n\n${info.notes}` : ""}`;

/** 标题栏常驻更新提醒：没有更新时不占位；有更新后一直显示，直到重启完成。 */
export default function UpdateButton({ autoCheck, busyReason, updater = defaultUpdater }: Props) {
  const phase = useStore(updater.store, (state) => state.phase);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    // 浏览器预览与测试环境中没有更新后端。
    if (!autoCheck || !isTauri()) return;
    const first = window.setTimeout(() => void updater.check(), AUTO_CHECK_DELAY_MS);
    const every = window.setInterval(() => void updater.check(), AUTO_CHECK_INTERVAL_MS);
    return () => { window.clearTimeout(first); window.clearInterval(every); };
  }, [autoCheck, updater]);

  const restart = () => {
    if (busyReason) { setConfirming(true); return; }
    void updater.install();
  };

  let button: ReactNode = null;
  switch (phase.kind) {
    case "manual":
      button = <button type="button" className="update-button" title={`${describe(phase.info)}\n\n当前不是安装版，点击打开下载页`} onClick={() => void updater.openDownloadPage()}>新版本 {phase.info.version}</button>;
      break;
    case "downloading": {
      const value = percent(phase);
      button = <button type="button" className="update-button pending" disabled title={`正在后台下载 ${describe(phase.info)}`}>更新 {value === null ? "…" : `${value}%`}</button>;
      break;
    }
    case "ready":
      button = <button type="button" className="update-button" title={`${describe(phase.info)}\n\n已下载，点击安装并重启 Oris`} onClick={restart}>重启以更新</button>;
      break;
    case "installing":
      button = <button type="button" className="update-button pending" disabled>正在更新…</button>;
      break;
    case "failed":
      // 手动检查失败只在设置页提示，标题栏不打扰。
      if (phase.stage !== "check") button = <button type="button" className="update-button failed" title={`${phase.message}\n\n点击重试`} onClick={() => (phase.stage === "install" ? restart() : updater.retry())}>更新失败</button>;
      break;
  }
  return <>
    {button}
    {confirming && <ConfirmDialog
      request={{ title: "重启以更新", message: `正在${busyReason ?? "执行操作"}，现在重启会中断该操作。`, notes: ["也可以等操作完成后再点击「重启以更新」。"], confirmLabel: "仍然重启", danger: true }}
      onCancel={() => setConfirming(false)}
      onConfirm={() => { setConfirming(false); void updater.install(); }}
    />}
  </>;
}
