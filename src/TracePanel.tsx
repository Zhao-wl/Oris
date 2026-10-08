import { useEffect, useRef, useState } from "react";
import { cancelTraceQuery, readFileBlame, readLineHistory, searchHistoryContent, TraceGate, type BlamePage, type ContentSearchPage, type ContentSearchQuery, type Direction, type LineHistoryPage, type LineRange, type SearchEntry, type TraceEntry, type TraceSource, type TraceIdentity } from "./trace-api";
import { shortOid } from "./history-api";
import { errorText } from "./error-message";
import "./trace.css";

interface Props {
  repoId: string; source: TraceSource | null; label: string; initialRefs: string[];
  onClose(): void;
  onCompare(entry: TraceEntry | SearchEntry): void;
  onLocate(oid: string, path: string): void;
  onReturn(): void;
}
const identityOf = (source: TraceSource): TraceIdentity => ({ contentId: source.contentId, snapshotRevision: source.snapshotRevision, side: source.side });
const rangeText = (range: LineRange | null) => range ? `${range.start}–${range.end} 行` : "无此侧行段";
const statsText = (page: { elapsedMs: number; outputBytes: number }) => `${page.elapsedMs} ms · ${(page.outputBytes / 1024).toFixed(1)} KiB Git 输出`;
const reasonLabels: Record<string, string> = { origin: "选中行段已追溯至引入点", page: "还有更早历史", uncommitted: "未提交引入，无法继续", shallow: "到达浅克隆边界", untraceable: "无法继续追溯", budget: "超出预算，结果不完整", limit: "达到累计扫描上限", complete: "本地可用范围扫描完成", scanBudget: "本页扫描预算用尽，可继续" };
const statusLabels: Record<string, string> = { snapshot: "阅读快照", renamed: "重命名", modified: "修改", added: "新增", deleted: "删除", copied: "复制", typeChanged: "类型变化" };

export default function TracePanel({ repoId, source, label, initialRefs, onClose, onCompare, onLocate, onReturn }: Props) {
  const [tab, setTab] = useState<"blame" | "lines" | "search">(source ? "blame" : "search");
  const [start, setStart] = useState(source?.query.line ?? 1);
  const [end, setEnd] = useState(source?.endLine ?? 1);
  const [refs, setRefs] = useState(initialRefs.join(", ") || "HEAD");
  const [text, setText] = useState(""); const [direction, setDirection] = useState<Direction>("both");
  const [onlyFile, setOnlyFile] = useState(false); const [scanBudget, setScanBudget] = useState(30);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [cancelled, setCancelled] = useState(false);
  const [blame, setBlame] = useState<BlamePage | null>(null); const [blameStart, setBlameStart] = useState(1);
  const [lines, setLines] = useState<LineHistoryPage | null>(null); const [search, setSearch] = useState<ContentSearchPage | null>(null);
  const [searched, setSearched] = useState<ContentSearchQuery | null>(null);
  const gate = useRef(new TraceGate());
  const active = useRef(true);
  const cancel = () => {
    const id = gate.current.cancel();
    if (id) void cancelTraceQuery(repoId, id).catch(() => {});
    setBusy(false); setCancelled(true);
  };
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; const id = gate.current.cancel(); if (id) void cancelTraceQuery(repoId, id).catch(() => {}); };
  }, [repoId]);
  // 条件一改变就取消旧请求并丢弃旧游标；分页只复用已提交的完整条件。
  useEffect(() => { cancel(); setLines(null); setCancelled(false); }, [start, end]);
  useEffect(() => { cancel(); setSearch(null); setSearched(null); setCancelled(false); }, [refs, text, direction, onlyFile, scanBudget]);
  const run = async <T,>(work: (id: string) => Promise<T>, accept: (data: T) => void) => {
    const old = gate.current.cancel(); if (old) void cancelTraceQuery(repoId, old).catch(() => {});
    const id = crypto.randomUUID(); gate.current.begin(id); setBusy(true); setError(""); setCancelled(false);
    try { const data = await work(id); if (active.current && gate.current.accepts(id)) accept(data); }
    catch (error) { if (active.current && gate.current.accepts(id)) setError(errorText(error)); }
    finally { if (active.current && gate.current.accepts(id)) { gate.current.finish(id); setBusy(false); } }
  };
  const loadBlame = (first: number) => {
    if (!source) return;
    void run(id => readFileBlame(repoId, id, source.query, identityOf(source), first), data => { setBlame(data); setBlameStart(first); });
  };
  const loadLines = (more = false) => {
    if (!source) return;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 1000) { setError("请选择 1–1000 行的连续行段"); return; }
    const query = { source: { ...source.query, line: start }, identity: identityOf(source), endLine: end, pageSize: 20 };
    void run(id => readLineHistory(repoId, id, query, more ? lines?.next ?? null : null), data => setLines(more && lines ? { ...data, entries: [...lines.entries, ...data.entries].slice(-200), scanned: lines.scanned + data.scanned, note: `${data.note}${lines.entries.length + data.entries.length > 200 ? " 面板仅保留最近 200 个变化。" : ""}` } : data));
  };
  const loadSearch = (more = false) => {
    const query = more && searched ? searched : { refs: refs.split(",").map(r => r.trim()).filter(Boolean), pathId: onlyFile ? source?.query.pathId ?? null : null, text, direction, pageSize: 20, scanBudget };
    if (!query.text || !query.refs.length) { setError("请输入内容文本和至少一个引用"); return; }
    void run(id => searchHistoryContent(repoId, id, query, more ? search?.next ?? null : null), data => { setSearched(query); setSearch(data); });
  };
  const changeTab = (next: typeof tab) => { cancel(); setCancelled(false); setError(""); setTab(next); };
  return <aside className="trace-panel" role="dialog" aria-label="代码追溯">
    <header><strong>代码追溯</strong><button onClick={onReturn}>返回阅读位置</button><button onClick={onClose} aria-label="关闭代码追溯">×</button></header>
    <p className="trace-caption" title={label}>{label || "仓库历史内容搜索"}</p>
    {source && <p className="trace-caption">{source.side === "a" ? "左" : "右"}侧 · {source.query.contents !== null ? `阅读快照 ${source.contentId?.slice(0, 12) ?? "文件历史"}` : `固定版本 ${shortOid(source.query.revision)}`} · 仓库 {repoId.slice(0, 12)}</p>}
    <nav aria-label="追溯模式">{([ ["blame", "整文件归属"], ["lines", "连续行历史"], ["search", "历史内容搜索"] ] as const).map(([value, name]) => <button key={value} aria-pressed={tab === value} disabled={!source && value !== "search"} onClick={() => changeTab(value)}>{name}</button>)}</nav>
    {tab === "blame" && <div className="trace-controls"><button disabled={busy} onClick={() => loadBlame(1)}>加载整文件归属</button><span>每页 200 行，按需加载</span></div>}
    {tab === "lines" && <div className="trace-controls"><label>起始行<input type="number" min="1" max="100000" value={start} onChange={e => setStart(Number(e.target.value))}/></label><label>结束行<input type="number" min={start} max="100000" value={end} onChange={e => setEnd(Number(e.target.value))}/></label><button disabled={busy} onClick={() => loadLines()}>追踪行段</button><p>沿第一父节点；重命名由 Git 相似度检测，替换块范围会标为推断。每页最多扫描 100 提交。</p></div>}
    {tab === "search" && <form className="trace-controls" onSubmit={e => { e.preventDefault(); loadSearch(); }}>
      <label>引用范围<input value={refs} onChange={e => setRefs(e.target.value)} placeholder="HEAD 或 refs/heads/main，逗号分隔"/></label>
      <label>内容文本<input value={text} onChange={e => setText(e.target.value)} placeholder="区分大小写的单行字面文本"/></label>
      <label>变化<select value={direction} onChange={e => setDirection(e.target.value as Direction)}><option value="both">新增与删除</option><option value="added">新增</option><option value="deleted">删除</option></select></label>
      <label>每页扫描提交数<input type="number" min="1" max="100" value={scanBudget} onChange={e => setScanBudget(Number(e.target.value))}/></label>
      <label><input type="checkbox" disabled={!source} checked={onlyFile} onChange={e => setOnlyFile(e.target.checked)}/>仅当前路径（含本次重命名两端）</label>
      <button disabled={busy} type="submit">搜索历史内容</button><p>搜索真实 patch 增删行。每次最多 10 秒 / 8 MiB Git 输出，最多扫描 10000 提交；每文件展示前 20 个命中片段。</p>
    </form>}
    {busy && <div role="status">正在查询… <button onClick={cancel}>取消查询</button></div>}
    {cancelled && <p role="status">查询已取消；旧响应不会进入当前结果。</p>}{error && <p role="alert">{error}</p>}
    <div className="trace-results">
      {tab === "blame" && blame && <><p>{blame.totalLines} 行 · {statsText(blame)}{blame.shallow && " · 浅克隆，来源可能不完整"}</p>
        {blame.rows.map(row => <div className={`trace-blame-row ${row.oid ? "" : "uncommitted"}`} key={row.line}><span>{row.line}</span><button title={`${row.summary}\n${row.path}:${row.originalLine}`} disabled={!row.oid} onClick={() => row.oid && onLocate(row.oid, row.path)}>{row.oid ? shortOid(row.oid) : "未提交"}</button><span title={row.summary}>{row.author}</span><button title="追踪此行" onClick={() => { setStart(row.line); setEnd(row.line); changeTab("lines"); }}>追踪</button><code>{row.text}</code></div>)}
        <div className="trace-pagination"><button disabled={busy || blameStart === 1} onClick={() => loadBlame(Math.max(1, blameStart - 200))}>上一页</button><span>{blameStart}–{blame.rows.at(-1)?.line ?? blameStart}</span><button disabled={busy || !blame.next} onClick={() => blame.next && loadBlame(blame.next)}>下一页</button></div></>}
      {tab === "lines" && lines && <><p role="status">{reasonLabels[lines.reason] ?? lines.reason}。{lines.note}</p><p>已扫描 {lines.scanned} 提交 · {statsText(lines)}</p>
        {lines.entries.map((entry, i) => <article key={`${entry.oid}:${entry.pathId}:${i}`}><strong>{entry.oid ? shortOid(entry.oid) : "未提交快照"} · {statusLabels[entry.status] ?? entry.status}</strong><p>{entry.oldPath} → {entry.path}<br/>{rangeText(entry.oldRange)} → {rangeText(entry.newRange)}{entry.inferred && " · 替换块范围推断"}{entry.merge && " · 合并：第一父节点"}</p><pre>{entry.patch.join("\n")}</pre><button disabled={!entry.oid} onClick={() => onCompare(entry)}>比较本次修改前后版本</button></article>)}
        {!lines.entries.length && <p>本页没有匹配变化。{lines.next ? "可继续追踪更早历史。" : "请查看上方停止原因。"}</p>}<button disabled={busy || !lines.next} onClick={() => loadLines(true)}>继续追踪</button></>}
      {tab === "search" && search && <><p role="status">{reasonLabels[search.reason] ?? search.reason}。{search.note}</p><p>固定起点 {search.tips.map(shortOid).join(", ")} · 本页扫描 {search.scanned} 提交 · {statsText(search)}</p>
        {search.entries.map((entry, i) => <article key={`${entry.oid}:${entry.parent}:${entry.pathId}:${i}`}><strong>{shortOid(entry.oid)} · {entry.path}</strong><p>父版本 {shortOid(entry.parent)} · {entry.matchCount} 处命中{entry.matchCount > entry.hits.length && "（片段已截断）"}</p><pre>{entry.hits.map(hit => `${hit.direction === "added" ? "+" : "-"}${hit.line}: ${hit.text}`).join("\n")}</pre><button onClick={() => onCompare(entry)}>比较命中修改前后版本</button></article>)}
        {!search.entries.length && <p>{search.next ? "本页没有匹配，仍有未扫描提交。" : search.reason === "complete" ? "本地可用范围内没有匹配增删行。" : "查询未完成，请查看停止原因。"}</p>}
        <div className="trace-pagination"><button disabled={busy || !search.next} onClick={() => loadSearch(true)}>下一页</button><span>分页基于固定提交 OID，后续引用移动不影响结果</span></div></>}
    </div>
  </aside>;
}
