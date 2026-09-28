import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { statusLetter, type ChangedFile } from "./history-api";
import PathText from "./PathText";
import VirtualRows, { VIRTUAL_THRESHOLD } from "./VirtualRows";

/** 提交 / 比较 / stash 的变化文件列表；文件很多时改用虚拟列表，滚动容器为外层 `.log-detail`。 */
export default function FileList({ files, activeKey, keyFor, onOpen, onHistory }: { files: ChangedFile[]; activeKey: string | null; keyFor(file: ChangedFile): string; onOpen(file: ChangedFile): void; onHistory?(file: ChangedFile): void }) {
  const host = useRef<HTMLElement | null>(null);
  const move = (event: ReactKeyboardEvent<HTMLElement>, index: number) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = files[index + delta];
    if (!next) return;
    onOpen(next);
    // 虚拟列表中目标行可能尚未渲染：先滚到可见附近，下一帧再聚焦。
    const focus = () => {
      const button = host.current?.querySelector<HTMLElement>(`[data-file-index="${index + delta}"] .log-file`);
      button?.focus();
      button?.scrollIntoView?.({ block: "nearest" });
      return !!button;
    };
    if (!focus()) requestAnimationFrame(focus);
  };
  if (!files.length) return <div className="log-empty">没有文件变化</div>;
  const content = (file: ChangedFile, index: number) => <>
    <button type="button" className="log-file" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => onOpen(file)} onKeyDown={(event) => move(event, index)}><span className={`status-letter ${file.status}`}>{statusLetter[file.status]}</span><PathText path={file.path} className="log-file-path" title={file.path}/>{file.oldPath && <PathText path={file.oldPath} prefix="← " className="log-file-old"/>}</button>
    {onHistory && <button type="button" className="quiet log-file-history" title={`查看 ${file.path} 的文件历史`} onClick={() => onHistory(file)}>历史</button>}
  </>;
  const rowKey = (file: ChangedFile) => file.pathId + (file.oldPathId ?? "");
  // 大提交（例如整仓导入的根提交有十万级文件）只渲染可视区域附近的行，否则一次性生成的 DOM 会让界面卡死。
  if (files.length > VIRTUAL_THRESHOLD) return <div ref={(node) => { host.current = node; }} className="log-files" role="list" aria-label="变化文件">
    <VirtualRows count={files.length} scrollParent=".log-detail" sampleRow=".log-file-row" render={(index, style) => {
      const file = files[index];
      return <div key={rowKey(file)} role="listitem" data-file-index={index} style={style} className={`log-file-row${activeKey === keyFor(file) ? " active" : ""}`}>{content(file, index)}</div>;
    }}/>
  </div>;
  return <ul ref={(node) => { host.current = node; }} className="log-files" aria-label="变化文件">{files.map((file, index) => <li key={rowKey(file)} data-file-index={index} className={activeKey === keyFor(file) ? "active" : ""}>{content(file, index)}</li>)}</ul>;
}
