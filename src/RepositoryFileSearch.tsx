import { useEffect, useRef, useState } from "react";
import ClearableInput from "./ClearableInput";
import { errorText } from "./error-message";
import { useFileHistoryMenu } from "./file-history-menu";
import { searchRepositoryFiles, type RepositoryFile, type RepositoryFileSearch as SearchResult } from "./history-api";
import PathText from "./PathText";

export default function RepositoryFileSearch({ repoId, head, onOpen, onClose }: {
  repoId: string;
  head: string | null;
  onOpen(file: RepositoryFile, start: string): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<{ key: string; result?: SearchResult; error?: string } | null>(null);
  const term = query.trim();
  const key = JSON.stringify([head, term]);
  const ready = response?.key === key ? response : null;
  const pick = (file: RepositoryFile) => {
    const start = ready?.result?.start;
    if (start) onOpen(file, start);
  };
  const context = useFileHistoryMenu(pick);
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector("input")?.focus();
    return () => { if (origin?.isConnected) origin.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let live = true;
    const timeout = window.setTimeout(() => {
      void searchRepositoryFiles(repoId, term).then(
        result => { if (live) setResponse({ key, result }); },
        error => { if (live) setResponse({ key, error: errorText(error) }); }
      );
    }, term ? 140 : 0);
    return () => { live = false; window.clearTimeout(timeout); };
  }, [repoId, term, key]);
  return <div className="dialog-overlay"><section ref={dialog} className="repository-file-search" role="dialog" aria-modal="true" aria-labelledby="repository-file-search-title"
    onKeyDown={event => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
    }}>
    <div className="panel-title"><strong id="repository-file-search-title">搜索整个仓库</strong><button type="button" className="icon-button" aria-label="关闭仓库文件搜索" onClick={onClose}>×</button></div>
    <div className="repository-search-body">
      <ClearableInput aria-label="仓库文件名或路径" placeholder="输入文件名或路径…" value={query} onValueChange={value => { context.close(); setQuery(value); }} clearLabel="清除仓库文件搜索"
        onKeyDown={event => {
          if (event.key === "Enter" && ready?.result?.files[0]) { event.preventDefault(); pick(ready.result.files[0]); }
          if (event.key === "ArrowDown") { event.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>(".repository-search-result")?.focus(); }
        }}/>
      <div className="dim repository-search-scope" role="status">
        {!ready ? "正在读取仓库文件…" : ready.error ? `无法搜索仓库文件：${ready.error}` : ready.result ?
          ready.result.total ? `包含未修改的文件 · ${ready.result.total} 项匹配${ready.result.total > ready.result.files.length ? `，显示前 ${ready.result.files.length} 项` : ""}`
            : ready.result.start ? "仓库中没有匹配的文件" : "仓库还没有提交" : null}
      </div>
      <ul className="repository-search-results" aria-label="仓库文件结果">
        {ready?.result?.files.map(file => <li key={file.pathId}>
          <button type="button" className="repository-search-result" onClick={() => pick(file)} {...context.bindings(file)}>
            <PathText path={file.path}/><span className="dim">历史记录</span>
          </button>
        </li>)}
      </ul>
    </div>
    {context.popup}
  </section></div>;
}
