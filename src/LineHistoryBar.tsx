import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type FocusEvent } from "react";
import { createPortal } from "react-dom";
import { readLineAttribution, readLineChange, shortOid, type LineAttribution } from "./history-api";
import type { DiffLineSelection } from "./diff-line-selection";
import { lineHistoryKey, lineQuery, relativeCommitTime, type LineHistoryContext } from "./line-history-model";
import { fitInViewport } from "./menu-position";
import { errorText } from "./error-message";

interface Props {
  context: LineHistoryContext;
  selection: { key: string; value: DiffLineSelection } | null;
  onJump(attribution: LineAttribution, author: boolean): void;
}

type Result = { key: string; data?: LineAttribution; error?: string };
const fullTime = (time: number) => new Date(time * 1000).toLocaleString(undefined, { timeZoneName: "short" });

export default function LineHistoryBar({ context, selection, onJump }: Props) {
  const contextKey = lineHistoryKey(context);
  const selected = selection?.key === contextKey ? selection.value : null;
  const query = useMemo(() => selected ? lineQuery(context, selected) : null, [context, selected]);
  const requestKey = `${contextKey}:${selected?.side}:${selected?.line}`;
  const [result, setResult] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ key: string; lines?: string[]; error?: string } | null>(null);
  const [copyNote, setCopyNote] = useState("");
  const cache = useRef(new Map<string, LineAttribution>());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight?: number }>({ left: 0, top: 0 });
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const data = result?.key === requestKey ? result.data : undefined;
  const error = result?.key === requestKey ? result.error : undefined;
  const commit = data?.commit;

  useEffect(() => {
    setOpen(false); setCopyNote("");
    if (!query || typeof query === "string") return;
    const cached = cache.current.get(requestKey);
    if (cached) { setResult({ key: requestKey, data: cached }); return; }
    let alive = true;
    const timer = setTimeout(() => {
      void readLineAttribution(context.pair.repoId, query).then(data => {
        if (!alive) return;
        cache.current.set(requestKey, data);
        while (cache.current.size > 128) cache.current.delete(cache.current.keys().next().value!);
        setResult({ key: requestKey, data });
      }, error => { if (alive) setResult({ key: requestKey, error: errorText(error) }); });
    }, 160);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, requestKey, context.pair.repoId]);

  const previewKey = commit ? `${context.pair.repoId}:${commit.oid}:${data.pathId}:${data.originalLine}` : "";
  useEffect(() => {
    if (!open || !commit || !data || preview?.key === previewKey) return;
    let alive = true;
    void readLineChange(context.pair.repoId, commit.oid, data.pathId, data.originalLine).then(lines => {
      if (alive) setPreview({ key: previewKey, lines });
    }, error => { if (alive) setPreview({ key: previewKey, error: errorText(error) }); });
    return () => { alive = false; };
  }, [open, previewKey, commit, data, context.pair.repoId, preview]);

  useLayoutEffect(() => {
    if (!open || !popup.current || !bar.current) return;
    const rect = bar.current.getBoundingClientRect();
    const size = popup.current.getBoundingClientRect();
    const point = fitInViewport((anchor.current?.x ?? rect.left) + 12, (anchor.current?.y ?? rect.top) + 10, size.width, size.height, window.innerWidth, window.innerHeight);
    setPosition({ ...point, maxHeight: Math.max(0, window.innerHeight - point.top - 4) });
    // 每次出现只定位一次；后续异步内容增长使用内部滚动，不改变浮层坐标。
  }, [open]);

  useEffect(() => {
    const close = () => setOpen(false);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !bar.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false); };
    window.addEventListener("blur", close); window.addEventListener("resize", close);
    document.addEventListener("keydown", escape); document.addEventListener("pointerdown", outside);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      window.removeEventListener("blur", close); window.removeEventListener("resize", close);
      document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside);
    };
  }, []);

  const keepOpen = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const show = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    keepOpen();
    if (open || !commit || (event.target instanceof Node && popup.current?.contains(event.target))) return;
    const rect = event.target instanceof Element ? event.target.getBoundingClientRect() : bar.current!.getBoundingClientRect();
    anchor.current = "clientX" in event && (event.clientX || event.clientY) ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom };
    setOpen(true);
  };
  const leave = () => { keepOpen(); closeTimer.current = setTimeout(() => setOpen(false), 400); };
  const jump = (author: boolean) => { if (data?.commit) { setOpen(false); onJump(data, author); } };
  const copy = async () => {
    if (!commit) return;
    try { await navigator.clipboard.writeText(commit.oid); setCopyNote("已复制 SHA"); }
    catch { setCopyNote("复制失败，可选中 SHA 手动复制"); }
  };
  const differentCommitter = commit && (commit.authorName !== commit.committerName || commit.authorEmail !== commit.committerEmail || commit.authorTime !== commit.committerTime);

  return <div className="line-history-bar" ref={bar} onMouseEnter={show} onMouseLeave={leave} onFocus={show}
    onBlur={event => { if (!(event.relatedTarget instanceof Node) || !popup.current?.contains(event.relatedTarget)) leave(); }}>
    <span className="line-history-location">{selected ? `${selected.side === "a" ? "左" : "右"}侧 · ${selected.line} 行` : "行提交信息"}</span>
    {!selected ? <span className="line-history-muted">选中一行查看提交记录</span>
      : typeof query === "string" ? <span className="line-history-muted">{query}</span>
      : error ? <span role="status" className="line-history-muted">无法读取行提交信息：{error}</span>
      : !data ? <span role="status" className="line-history-muted">正在读取行提交信息…</span>
      : !commit ? <span className="line-history-muted">未提交修改</span>
      : <><button type="button" className="line-history-link" onClick={() => jump(true)} title="在历史中按作者搜索并定位该提交">{commit.authorName}</button>
        <span className="line-history-muted">· {relativeCommitTime(commit.authorTime)} ·</span>
        <button type="button" className="line-history-summary" onClick={show} aria-expanded={open}>{commit.subject || "（无提交信息）"}</button>
        <span className="spacer"/><button type="button" className="line-history-link line-history-sha" onClick={() => jump(false)} title="在历史中定位该提交">{shortOid(commit.oid)}</button></>}
    {open && commit && data && createPortal(<div className="line-history-popover" ref={popup} style={position} role="dialog" aria-label="行提交详情" onMouseEnter={keepOpen} onMouseLeave={leave} onFocus={keepOpen}
      onBlur={event => { if (!(event.relatedTarget instanceof Node) || (!popup.current?.contains(event.relatedTarget) && !bar.current?.contains(event.relatedTarget))) leave(); }}>
      <button type="button" className="line-history-close" onClick={() => setOpen(false)} aria-label="关闭提交详情">×</button>
      <div className="line-history-author"><button type="button" className="line-history-link" onClick={() => jump(true)}>{commit.authorName}</button><time dateTime={new Date(commit.authorTime * 1000).toISOString()}>{fullTime(commit.authorTime)}</time></div>
      <div className="line-history-muted line-history-email">{commit.authorEmail}</div>
      <p className="line-history-message">{commit.subject || "（无提交信息）"}</p>{commit.body && <p className="line-history-body">{commit.body}</p>}
      {differentCommitter && <p className="line-history-muted">提交者：{commit.committerName} &lt;{commit.committerEmail}&gt;<br/>{fullTime(commit.committerTime)}</p>}
      <div className="line-history-commit"><button type="button" className="line-history-link line-history-sha" onClick={() => jump(false)} title={commit.oid}>{shortOid(commit.oid)}</button><button type="button" className="line-history-link" onClick={() => void copy()}>复制 SHA</button><span className="line-history-muted">{data.path}:{data.originalLine}</span></div>
      <div className="line-history-patch">{preview?.key !== previewKey ? <span className="line-history-muted">正在读取提交变化…</span> : preview.error ? <span className="line-history-muted">无法读取变化：{preview.error}</span> : preview.lines?.length ? preview.lines.map((line, index) => <div key={index} className={line.startsWith('+') ? "added" : line.startsWith('-') ? "deleted" : "context"}>{line}</div>) : <span className="line-history-muted">该行相对第一个父节点没有独立变化片段</span>}</div>
      <div className="line-history-caption">{commit.parents.length ? `相对父提交 ${shortOid(commit.parents[0])}${commit.parents.length > 1 ? "（第 1 个父节点）" : ""}` : "相对空树（根提交）"}{data.shallow && " · 浅克隆，较早的来源记录可能不完整"}</div>
      {copyNote && <div className="line-history-muted" role="status">{copyNote}</div>}
    </div>, document.body)}
  </div>;
}
