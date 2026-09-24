import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { layoutGraph, type GraphLayout, type GraphRow } from "./history-graph";
import { commitChanges, compareRevisions, fileHistory, readLog, readRefs, shortOid, shortRef, statusLetter, trackingText, type Branch, type ChangedFile, type CommitChanges, type CommitInfo, type Comparison, type FileHistory, type LogCursor, type RefsView, type SearchKind } from "./history-api";
import { ROW_HEIGHT, isStale, movedEndpoint, nodeX, rowSegments, LANE_WIDTH, type PinnedEndpoint } from "./history-model";
import { errorText } from "./error-message";

/** 在主 diff 阅读器中打开的历史文件（两端都是固定的提交 OID；left 为 null 表示空树）。 */
export interface HistoryFileOpen {
  key: string;
  /** 来源说明，例如“提交 abcd1234”“比较 A → B”“文件历史”。 */
  source: string;
  file: ChangedFile;
  left: { oid: string | null; label: string };
  right: { oid: string; label: string };
}

export interface FileHistoryRequest { pathId: string; path: string; start: string; nonce: number }

interface Props {
  repoId: string;
  /** refs 变化（watcher 的 refs 事件、写操作结束）时递增：重读分支列表与日志。 */
  refsVersion: number;
  hidden: boolean;
  fileHistoryRequest: FileHistoryRequest | null;
  activeKey: string | null;
  onOpenFile(open: HistoryFileOpen): void;
  onFetch(): void;
  fetchBlocked: string | null;
  fetchText: string;
  onRefs?(refs: RefsView): void;
  /** V2-03：提交右键“检出（分离 HEAD）”“从这里新建分支”。 */
  onCheckout?(oid: string): void;
  onNewBranch?(start: { ref: string; label: string }): void;
  writeBlocked?: string | null;
}

const PAGE_SIZE = 200;
const OVERSCAN = 12;
const searchLabels: Record<SearchKind, string> = { message: "消息", author: "作者", sha: "SHA" };
const time = (seconds: number) => new Date(seconds * 1000).toLocaleString();

type Mode =
  | { kind: "commit" }
  | { kind: "compare"; a: PinnedEndpoint; b: PinnedEndpoint; result: Comparison | null; error: string | null }
  | { kind: "file"; request: FileHistoryRequest; history: FileHistory | null; loading: boolean; error: string | null; selected: string | null };

interface Menu { x: number; y: number; endpoint: PinnedEndpoint }

/** 底部 Git 区“日志”页（R-HISTORY / R-BRANCH / R-COMPARE / R-FILEHISTORY）：分支列表、提交图与列表、提交详情。只读，选择分支只筛选历史。 */
export default function HistoryPanel(props: Props) {
  const { repoId, refsVersion, hidden, fileHistoryRequest, activeKey, onOpenFile, onFetch, fetchBlocked, fetchText, onRefs, onCheckout, onNewBranch, writeBlocked } = props;
  const [refs, setRefs] = useState<RefsView | null>(null);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [searchKind, setSearchKind] = useState<SearchKind>("message");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState<{ kind: SearchKind; text: string } | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [cursor, setCursor] = useState<LogCursor | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [changes, setChanges] = useState<CommitChanges | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [compareStart, setCompareStart] = useState<PinnedEndpoint | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "commit" });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const logRequest = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedOid);
  selectedRef.current = selectedOid;

  // ---------- 分支与日志 ----------
  const onRefsRef = useRef(onRefs);
  onRefsRef.current = onRefs;
  const loadRefs = useCallback(() => {
    void readRefs(repoId).then((view) => { setRefs(view); setRefsError(null); onRefsRef.current?.(view); }, (error) => { if (!isStale(error)) setRefsError(errorText(error)); });
  }, [repoId]);

  /** 读取第一页（重置已加载的结果）；已选中的提交仍在结果中时保持选择。 */
  const loadFirst = useCallback(() => {
    const request = ++logRequest.current;
    setLogLoading(true); setLogError(null);
    void readLog(repoId, { refs: filter ? [filter] : [], search: search && search.text.trim() ? { kind: search.kind, text: search.text.trim() } : null, pageSize: PAGE_SIZE }, null).then((page) => {
      if (request !== logRequest.current) return;
      setCommits(page.commits); setCursor(page.next); setLogLoading(false);
      const keep = selectedRef.current && page.commits.some((c) => c.oid === selectedRef.current);
      if (!keep) setSelectedOid(page.commits[0]?.oid ?? null);
    }, (error) => {
      if (request !== logRequest.current || isStale(error)) return;
      setLogLoading(false); setCommits([]); setCursor(null); setLogError(errorText(error));
    });
  }, [repoId, filter, search]);

  /** 正在续读的游标（同步标记）：滚动事件连续到达时，同一页只请求一次。 */
  const inflight = useRef<string | null>(null);
  const loadMore = useCallback(() => {
    if (!cursor || logLoading) return;
    const key = `${logRequest.current}:${cursor.skip}`;
    if (inflight.current === key) return;
    inflight.current = key;
    const request = logRequest.current;
    setLogLoading(true);
    void readLog(repoId, { refs: [], search: search && search.text.trim() ? { kind: search.kind, text: search.text.trim() } : null, pageSize: PAGE_SIZE }, cursor).then((page) => {
      if (request !== logRequest.current) return;
      // 游标固定了起点 OID：追加的提交不会改变已显示提交的身份与顺序。
      setCommits((current) => { const seen = new Set(current.map((c) => c.oid)); return [...current, ...page.commits.filter((c) => !seen.has(c.oid))]; });
      setCursor(page.next); setLogLoading(false);
    }, (error) => { if (inflight.current === key) inflight.current = null; if (request === logRequest.current && !isStale(error)) { setLogLoading(false); setLogError(errorText(error)); } });
  }, [repoId, cursor, logLoading, search]);

  useEffect(() => { loadRefs(); }, [loadRefs, refsVersion]);
  useEffect(() => { loadFirst(); }, [loadFirst, refsVersion]);

  const layout: GraphLayout = useMemo(() => {
    try { return layoutGraph(commits); } catch { return { rows: [], continuations: [], width: 0 }; }
  }, [commits]);
  const loaded = useMemo(() => new Set(commits.map((c) => c.oid)), [commits]);
  const byOid = useMemo(() => new Map(commits.map((c, i) => [c.oid, i])), [commits]);
  const selected = selectedOid ? commits[byOid.get(selectedOid) ?? -1] ?? null : null;

  // ---------- 选中提交的变化文件（默认第一个父节点，合并提交可选父节点） ----------
  useEffect(() => { setParent(null); }, [selectedOid]);
  useEffect(() => {
    if (!selectedOid) { setChanges(null); return; }
    let live = true;
    setChangesError(null);
    void commitChanges(repoId, selectedOid, parent).then((result) => { if (live) setChanges(result); }, (error) => { if (live && !isStale(error)) { setChanges(null); setChangesError(errorText(error)); } });
    return () => { live = false; };
  }, [repoId, selectedOid, parent, refsVersion]);

  // ---------- 文件历史 ----------
  const loadFileHistory = useCallback((request: FileHistoryRequest, next: LogCursor | null, previous: FileHistory | null) => {
    setMode((current) => current.kind === "file" && current.request.nonce === request.nonce ? { ...current, loading: true } : { kind: "file", request, history: null, loading: true, error: null, selected: null });
    void fileHistory(repoId, request.start, request.pathId, 100, next).then((result) => {
      setMode((current) => current.kind !== "file" || current.request.nonce !== request.nonce ? current : { ...current, loading: false, error: null, history: previous ? { entries: [...previous.entries, ...result.entries], next: result.next, reachedOrigin: result.reachedOrigin } : result });
    }, (error) => {
      if (isStale(error)) return;
      setMode((current) => current.kind !== "file" || current.request.nonce !== request.nonce ? current : { ...current, loading: false, error: errorText(error) });
    });
  }, [repoId]);
  useEffect(() => { if (fileHistoryRequest) loadFileHistory(fileHistoryRequest, null, null); }, [fileHistoryRequest, loadFileHistory]);

  // ---------- 比较（直接比较两个端点，非共同基线） ----------
  const runCompare = useCallback((a: PinnedEndpoint, b: PinnedEndpoint) => {
    setMode({ kind: "compare", a, b, result: null, error: null });
    // 两端都传已固定的 OID：比较期间 ref 移动不会悄悄替换端点。
    void compareRevisions(repoId, a.oid, b.oid).then((result) => setMode((current) => current.kind === "compare" && current.a === a && current.b === b ? { ...current, result } : current), (error) => {
      if (!isStale(error)) setMode((current) => current.kind === "compare" && current.a === a && current.b === b ? { ...current, error: errorText(error) } : current);
    });
  }, [repoId]);
  const compareWith = (endpoint: PinnedEndpoint) => {
    setMenu(null);
    if (!compareStart) { setCompareStart(endpoint); return; }
    runCompare(compareStart, endpoint);
  };
  const refEndpoint = (branch: Branch): PinnedEndpoint => ({ ref: branch.fullName, oid: branch.oid, label: branch.name });
  const commitEndpoint = (commit: CommitInfo): PinnedEndpoint => ({ ref: commit.oid, oid: commit.oid, label: `${shortOid(commit.oid)} ${commit.subject}` });

  // ---------- 选择、键盘与滚动 ----------
  const select = (oid: string, scroll = false) => { setSelectedOid(oid); if (scroll) setScrollTarget(oid); };
  useLayoutEffect(() => {
    if (!scrollTarget || !list.current) return;
    const index = byOid.get(scrollTarget);
    if (index === undefined) return;
    const container = list.current;
    const top = index * ROW_HEIGHT;
    if (top < container.scrollTop || top + ROW_HEIGHT > container.scrollTop + container.clientHeight) container.scrollTop = Math.max(0, top - container.clientHeight / 2);
    setScrollTarget(null);
  }, [scrollTarget, byOid]);
  const jumpHead = () => {
    const head = refs?.head.oid;
    if (!head) return;
    if (byOid.has(head)) { select(head, true); return; }
    // HEAD 不在当前结果中（被筛选、搜索或尚未加载）：改为浏览 HEAD 所在的分支，HEAD 位于第一行。
    setSearch(null); setSearchText("");
    setFilter(refs.head.detached || !refs.head.branch ? "HEAD" : refs.head.branch);
    selectedRef.current = head; setSelectedOid(head); setScrollTarget(head);
  };
  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!commits.length) return;
    const index = selectedOid ? byOid.get(selectedOid) ?? 0 : -1;
    const move = (next: number) => { event.preventDefault(); const bounded = Math.max(0, Math.min(commits.length - 1, next)); select(commits[bounded].oid, true); if (bounded >= commits.length - 5) loadMore(); };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "PageDown") move(index + 10);
    else if (event.key === "PageUp") move(index - 10);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(commits.length - 1);
    else if (event.key === "Enter" && changes?.files[0] && selected) { event.preventDefault(); openCommitFile(selected, changes, changes.files[0]); }
  };
  const [view, setView] = useState({ top: 0, height: 240 });
  useLayoutEffect(() => {
    const container = list.current;
    if (!container) return;
    const measure = () => {
      setView((current) => (current.top === container.scrollTop && current.height === container.clientHeight ? current : { top: container.scrollTop, height: container.clientHeight || 240 }));
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - ROW_HEIGHT * 8) loadMoreRef.current();
    };
    measure();
    container.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => { container.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [hidden, mode.kind]);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // ---------- 打开文件 ----------
  const openCommitFile = (commit: CommitInfo, result: CommitChanges, file: ChangedFile) => {
    const index = result.parent ? result.parents.indexOf(result.parent) : -1;
    onOpenFile({
      key: `commit:${commit.oid}:${result.parent ?? "root"}:${file.pathId}`,
      source: `提交 ${shortOid(commit.oid)}`,
      file,
      left: { oid: result.parent, label: result.parent ? `父提交 ${shortOid(result.parent)}${result.parents.length > 1 ? `（第 ${index + 1} 个父节点）` : ""}` : "空树（根提交）" },
      right: { oid: commit.oid, label: `提交 ${shortOid(commit.oid)}` }
    });
  };
  const openCompareFile = (result: Comparison, a: PinnedEndpoint, b: PinnedEndpoint, file: ChangedFile) => onOpenFile({
    key: `compare:${result.left}:${result.right}:${file.pathId}`,
    source: `比较 ${shortRef(a.label)} → ${shortRef(b.label)}`,
    file,
    left: { oid: result.left, label: `A · ${shortRef(a.label)} @ ${shortOid(result.left)}` },
    right: { oid: result.right, label: `B · ${shortRef(b.label)} @ ${shortOid(result.right)}` }
  });

  const moved = mode.kind === "compare" ? [movedEndpoint(mode.a, refs), movedEndpoint(mode.b, refs)].filter(Boolean) as string[] : [];
  const current = refs?.local.find((b) => b.current) ?? null;
  const headLabel = refs ? refs.head.detached ? `分离 HEAD @ ${shortOid(refs.head.oid)}` : refs.head.unborn ? `${shortRef(refs.head.branch ?? "")}（尚无提交）` : shortRef(refs.head.branch ?? "") : "…";
  const start = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(layout.rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);
  const graphWidth = Math.max(1, layout.width) * LANE_WIDTH;

  return <div className="git-body log-layout" hidden={hidden} onContextMenu={(event) => { if (!(event.target as Element).closest("[data-endpoint]")) setMenu(null); }}>
    <aside className="log-branches" aria-label="分支">
      <div className="log-head"><strong>分支</strong><span className="spacer"/><button type="button" disabled={!!fetchBlocked} title={fetchBlocked ?? "获取远端状态：只更新远端跟踪分支等 Git 元数据，不修改工作区"} onClick={onFetch}>获取…</button></div>
      <div className="log-current" title={current ? trackingText(current.tracking).title : undefined}>当前工作分支：<strong>● {headLabel}</strong>{current && <span className="log-track">{trackingText(current.tracking).short}</span>}</div>
      <div className="log-fetch-time">{fetchText}</div>
      {refsError && <div className="log-error">{refsError}</div>}
      {refs?.shallow && <div className="log-note">浅克隆：领先 / 落后数不可靠，显示为未知</div>}
      <div className="log-branch-list" role="listbox" aria-label="按分支筛选历史">
        <button type="button" role="option" aria-selected={filter === null} className={`log-branch${filter === null ? " browsing" : ""}`} onClick={() => setFilter(null)}>全部分支</button>
        {refs && refs.local.length > 0 && <div className="log-group">本地分支 · {refs.local.length}</div>}
        {refs?.local.map((branch) => <BranchRow key={branch.fullName} branch={branch} browsing={filter === branch.fullName} onPick={() => setFilter(branch.fullName)} onMenu={(x, y) => setMenu({ x, y, endpoint: refEndpoint(branch) })}/>)}
        {refs && refs.remote.length > 0 && <div className="log-group">远端跟踪分支 · {refs.remote.length}</div>}
        {refs?.remote.map((branch) => <BranchRow key={branch.fullName} branch={branch} browsing={filter === branch.fullName} onPick={() => setFilter(branch.fullName)} onMenu={(x, y) => setMenu({ x, y, endpoint: refEndpoint(branch) })}/>)}
      </div>
      <div className="log-note">选择分支只筛选历史，不切换工作分支；右键设为比较端点</div>
    </aside>
    <section className="log-commits-pane" aria-label={mode.kind === "file" ? "文件历史" : "提交历史"}>
      {mode.kind === "file" ? <FileHistoryList mode={mode} activeKey={activeKey} onBack={() => setMode({ kind: "commit" })} onMore={() => mode.history?.next && loadFileHistory(mode.request, mode.history.next, mode.history)} onOpen={(entry) => {
        setMode({ ...mode, selected: entry.commit.oid });
        const parentOid = entry.commit.parents[0] ?? null;
        onOpenFile({ key: `file:${entry.commit.oid}:${entry.pathId}`, source: `文件历史 · ${mode.request.path}`, file: { path: entry.path, oldPath: entry.renamedFrom, pathId: entry.pathId, oldPathId: entry.renamedFromId, status: entry.status }, left: { oid: parentOid, label: parentOid ? `父提交 ${shortOid(parentOid)}${entry.commit.parents.length > 1 ? "（第 1 个父节点）" : ""}` : "空树（根提交）" }, right: { oid: entry.commit.oid, label: `提交 ${shortOid(entry.commit.oid)}` } });
      }}/> : <>
        <div className="log-toolbar">
          <select aria-label="搜索类型" value={searchKind} onChange={(event) => setSearchKind(event.target.value as SearchKind)}>{(Object.keys(searchLabels) as SearchKind[]).map((kind) => <option key={kind} value={kind}>{searchLabels[kind]}</option>)}</select>
          <input aria-label="搜索提交" placeholder={searchKind === "sha" ? "SHA 前缀（至少 4 位）" : `按${searchLabels[searchKind]}搜索（字面量）`} value={searchText} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setSearch(searchText.trim() ? { kind: searchKind, text: searchText } : null); } }}/>
          <button type="button" onClick={() => setSearch(searchText.trim() ? { kind: searchKind, text: searchText } : null)}>搜索</button>
          {search && <button type="button" className="quiet" onClick={() => { setSearch(null); setSearchText(""); }}>清除</button>}
          <button type="button" onClick={jumpHead} disabled={!refs?.head.oid} title="定位到 HEAD（当前检出的提交）">跳到 HEAD</button>
          <span className="spacer"/>
          <span className="log-count">{filter ? `浏览 ${shortRef(filter)} · ` : ""}{commits.length} 个提交{cursor ? " · 还有更多" : ""}{logLoading ? " · 读取中…" : ""}</span>
        </div>
        {compareStart && <div className="log-compare-start">比较起点：{shortRef(compareStart.label)} @ {shortOid(compareStart.oid)}<span className="spacer"/>在提交或分支上右键“与比较起点比较”<button type="button" className="quiet" onClick={() => setCompareStart(null)}>取消</button></div>}
        {logError && <div className="log-error">{logError}</div>}
        <div ref={list} className="log-commits" role="listbox" tabIndex={0} aria-label="提交列表" aria-activedescendant={selectedOid ? `commit-${selectedOid}` : undefined} onKeyDown={onListKey}>
          <div style={{ position: "relative", height: layout.rows.length * ROW_HEIGHT }} data-commit-count={layout.rows.length}>
            {layout.rows.slice(start, end).map((row, offset) => {
              const commit = commits[start + offset];
              return <CommitRow key={row.oid} row={row} commit={commit} top={(start + offset) * ROW_HEIGHT} graphWidth={graphWidth} loaded={loaded} selected={row.oid === selectedOid} head={refs?.head.oid === row.oid} onPick={() => { select(row.oid); setMode({ kind: "commit" }); }} onMenu={(x, y) => setMenu({ x, y, endpoint: commitEndpoint(commit) })}/>;
            })}
          </div>
          {!logLoading && !commits.length && !logError && <div className="log-empty">{search ? "没有匹配的提交" : "没有提交"}</div>}
          {layout.continuations.length > 0 && !logLoading && <div className="log-continuation" style={{ top: layout.rows.length * ROW_HEIGHT }}>{cursor ? `┆ 更早的提交尚未加载（${layout.continuations.length} 条连线在此延续），继续滚动加载` : `┆ ${layout.continuations.length} 条连线指向结果之外的提交（筛选 / 搜索未包含）`}</div>}
        </div>
      </>}
    </section>
    <aside className="log-detail" aria-label="提交详情">
      {mode.kind === "compare" ? <CompareDetail mode={mode} moved={moved} activeKey={activeKey} onSwap={() => runCompare(mode.b, mode.a)} onRefresh={() => {
        const renew = (endpoint: PinnedEndpoint) => { const branch = refs && [...refs.local, ...refs.remote].find((b) => b.fullName === endpoint.ref); const oid = endpoint.ref === "HEAD" ? refs?.head.oid : branch?.oid; return oid ? { ...endpoint, oid } : endpoint; };
        runCompare(renew(mode.a), renew(mode.b));
      }} onClose={() => { setMode({ kind: "commit" }); setCompareStart(null); }} onOpen={(file) => mode.result && openCompareFile(mode.result, mode.a, mode.b, file)}/>
        : mode.kind === "file" ? <FileHistoryDetail mode={mode}/>
        : selected ? <CommitDetail commit={selected} changes={changes} error={changesError} activeKey={activeKey} onParent={setParent} onOpen={(file) => changes && openCommitFile(selected, changes, file)} onHistory={(file) => loadFileHistory({ pathId: file.pathId, path: file.path, start: selected.oid, nonce: Date.now() }, null, null)}/>
        : <div className="log-empty">选择一个提交查看元信息与变化文件</div>}
    </aside>
    {menu && <EndpointMenu menu={menu} hasStart={!!compareStart} blocked={writeBlocked ?? null} onClose={() => setMenu(null)} onStart={() => { setCompareStart(menu.endpoint); setMenu(null); }} onCompare={() => compareWith(menu.endpoint)}
      onCheckout={onCheckout && menu.endpoint.ref === menu.endpoint.oid ? () => { setMenu(null); onCheckout(menu.endpoint.oid); } : undefined}
      onNewBranch={onNewBranch ? () => { setMenu(null); onNewBranch({ ref: menu.endpoint.ref, label: menu.endpoint.label }); } : undefined}/>}
  </div>;
}

const BranchRow = memo(function BranchRow({ branch, browsing, onPick, onMenu }: { branch: Branch; browsing: boolean; onPick(): void; onMenu(x: number, y: number): void }) {
  const tracking = branch.kind === "local" ? trackingText(branch.tracking) : null;
  return <button type="button" role="option" aria-selected={browsing} data-endpoint className={`log-branch${browsing ? " browsing" : ""}${branch.current ? " current" : ""}`} title={`${branch.fullName} @ ${shortOid(branch.oid)}${tracking ? `\n${tracking.title}` : ""}`} onClick={onPick} onContextMenu={(event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); }}>
    <span className="log-branch-name">{branch.current ? "● " : ""}{branch.name}</span>{tracking && <span className={`log-track ${branch.tracking?.state ?? ""}`}>{tracking.short}</span>}
  </button>;
});

const laneClass = (lane: number) => `lane-${lane % 6}`;

const CommitRow = memo(function CommitRow({ row, commit, top, graphWidth, loaded, selected, head, onPick, onMenu }: { row: GraphRow; commit: CommitInfo; top: number; graphWidth: number; loaded: ReadonlySet<string>; selected: boolean; head: boolean; onPick(): void; onMenu(x: number, y: number): void }) {
  const segments = rowSegments(row, loaded);
  const refs = commit.refs.filter((r) => r.kind !== "head");
  // HEAD 标注：来自该页日志自身的装饰（与分支列表是否已读取无关）。
  const isHead = head || commit.refs.some((r) => r.kind === "head");
  return <div id={`commit-${commit.oid}`} role="option" aria-selected={selected} data-endpoint data-oid={commit.oid} className={`log-row${selected ? " selected" : ""}`} style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT }} onClick={onPick} onContextMenu={(event) => { event.preventDefault(); onPick(); onMenu(event.clientX, event.clientY); }}>
    <svg className="log-graph" width={graphWidth} height={ROW_HEIGHT} aria-hidden="true">
      {segments.map((s, i) => <line key={i} className={`${laneClass(s.lane)}${s.dashed ? " dashed" : ""}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}/>)}
      <circle className={`${laneClass(row.lane)}${commit.parents.length > 1 ? " merge" : ""}${isHead ? " head" : ""}`} cx={nodeX(row)} cy={ROW_HEIGHT / 2} r={commit.parents.length > 1 ? 4 : 3.5}/>
    </svg>
    <span className="log-subject">{isHead && <span className="ref-chip head">HEAD</span>}{refs.map((r) => <span key={r.name} className={`ref-chip ${r.kind}${r.current ? " current" : ""}`} title={r.name}>{shortRef(r.name)}</span>)}{commit.subject || "（无提交信息）"}</span>
    <span className="log-author" title={commit.authorEmail}>{commit.authorName}</span>
    <span className="log-date">{time(commit.authorTime)}</span>
    <span className="log-sha">{shortOid(commit.oid)}</span>
  </div>;
});

function FileList({ files, activeKey, keyFor, onOpen, onHistory }: { files: ChangedFile[]; activeKey: string | null; keyFor(file: ChangedFile): string; onOpen(file: ChangedFile): void; onHistory?(file: ChangedFile): void }) {
  const move = (event: ReactKeyboardEvent<HTMLElement>, index: number) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = files[index + delta];
    if (next) { onOpen(next); ((event.currentTarget.parentElement?.parentElement?.children[index + delta] as HTMLElement | undefined)?.querySelector("button") as HTMLElement | null)?.focus(); }
  };
  if (!files.length) return <div className="log-empty">没有文件变化</div>;
  return <ul className="log-files" aria-label="变化文件">{files.map((file, index) => <li key={file.pathId + (file.oldPathId ?? "")} className={activeKey === keyFor(file) ? "active" : ""}>
    <button type="button" className="log-file" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => onOpen(file)} onKeyDown={(event) => move(event, index)}><span className={`status-letter ${file.status}`}>{statusLetter[file.status]}</span><span className="log-file-path">{file.path}</span>{file.oldPath && <span className="log-file-old">← {file.oldPath}</span>}</button>
    {onHistory && <button type="button" className="quiet log-file-history" title={`查看 ${file.path} 的文件历史`} onClick={() => onHistory(file)}>历史</button>}
  </li>)}</ul>;
}

function CommitDetail({ commit, changes, error, activeKey, onParent, onOpen, onHistory }: { commit: CommitInfo; changes: CommitChanges | null; error: string | null; activeKey: string | null; onParent(parent: string): void; onOpen(file: ChangedFile): void; onHistory(file: ChangedFile): void }) {
  const current = changes?.oid === commit.oid ? changes : null;
  return <div className="log-detail-body">
    <strong className="log-detail-subject">{commit.subject || "（无提交信息）"}</strong>
    <div className="log-meta"><span className="log-sha-full" title="提交 SHA">{commit.oid}</span></div>
    <div className="log-meta">作者 {commit.authorName} &lt;{commit.authorEmail}&gt; · {time(commit.authorTime)}</div>
    {(commit.committerName !== commit.authorName || commit.committerTime !== commit.authorTime) && <div className="log-meta">提交者 {commit.committerName} · {time(commit.committerTime)}</div>}
    <div className="log-meta log-parents">{commit.parents.length === 0 ? "根提交：相对空树比较" : commit.parents.length === 1 ? <>父提交 {shortOid(commit.parents[0])}</> : <>合并提交，比较父节点：{commit.parents.map((p, i) => <button key={p} type="button" className={`parent-pick${current?.parent === p ? " active" : ""}`} aria-pressed={current?.parent === p} onClick={() => onParent(p)}>{i + 1} · {shortOid(p)}</button>)}</>}</div>
    {commit.body && <pre className="log-body">{commit.body}</pre>}
    {error && <div className="log-error">{error}</div>}
    {current ? <><div className="log-group">变化文件 · {current.files.length}{current.parent ? ` · 相对 ${shortOid(current.parent)}` : " · 相对空树"}</div>
      <FileList files={current.files} activeKey={activeKey} keyFor={(file) => `commit:${commit.oid}:${current.parent ?? "root"}:${file.pathId}`} onOpen={onOpen} onHistory={onHistory}/></> : !error && <div className="log-empty">正在读取变化文件…</div>}
  </div>;
}

function CompareDetail({ mode, moved, activeKey, onSwap, onRefresh, onClose, onOpen }: { mode: Extract<Mode, { kind: "compare" }>; moved: string[]; activeKey: string | null; onSwap(): void; onRefresh(): void; onClose(): void; onOpen(file: ChangedFile): void }) {
  return <div className="log-detail-body">
    <div className="log-head"><strong>直接比较（非共同基线）</strong><span className="spacer"/><button type="button" onClick={onSwap} title="交换方向（仍使用已固定的 OID）">⇄ 交换方向</button><button type="button" className="quiet" onClick={onClose}>关闭</button></div>
    <div className="log-meta">A：{shortRef(mode.a.label)} · <span className="log-sha-full">{mode.a.oid}</span></div>
    <div className="log-meta">B：{shortRef(mode.b.label)} · <span className="log-sha-full">{mode.b.oid}</span></div>
    {moved.length > 0 && <div className="log-moved" role="status">{moved.join("；")}。当前比较仍使用上面固定的 OID。<button type="button" onClick={onRefresh}>按新位置重新比较</button></div>}
    {mode.error && <div className="log-error">{mode.error}</div>}
    {mode.result ? <><div className="log-group">A → B 的变化文件 · {mode.result.files.length}</div><FileList files={mode.result.files} activeKey={activeKey} keyFor={(file) => `compare:${mode.result!.left}:${mode.result!.right}:${file.pathId}`} onOpen={onOpen}/></> : !mode.error && <div className="log-empty">正在比较…</div>}
  </div>;
}

function FileHistoryList({ mode, activeKey, onBack, onMore, onOpen }: { mode: Extract<Mode, { kind: "file" }>; activeKey: string | null; onBack(): void; onMore(): void; onOpen(entry: FileHistory["entries"][number]): void }) {
  const entries = mode.history?.entries ?? [];
  return <>
    <div className="log-toolbar"><button type="button" onClick={onBack}>← 返回提交历史</button><strong className="log-file-title" title={mode.request.path}>文件历史：{mode.request.path}</strong><span className="spacer"/><span className="log-count">自 {mode.request.start === "HEAD" ? "HEAD" : shortOid(mode.request.start)} · {entries.length} 条{mode.loading ? " · 读取中…" : ""}</span></div>
    {mode.error && <div className="log-error">{mode.error}</div>}
    <ul className="log-history" aria-label="文件历史记录">
      {entries.map((entry) => <li key={entry.commit.oid + entry.pathId} className={`${mode.selected === entry.commit.oid ? "selected" : ""}${activeKey === `file:${entry.commit.oid}:${entry.pathId}` ? " active" : ""}`}>
        <button type="button" className="log-history-row" onClick={() => onOpen(entry)}><span className={`status-letter ${entry.status}`}>{statusLetter[entry.status]}</span><span className="log-sha">{shortOid(entry.commit.oid)}</span><span className="log-subject">{entry.commit.subject}</span><span className="log-date">{time(entry.commit.authorTime)}</span><span className="log-file-path" title={entry.path}>{entry.path}</span></button>
        {entry.renamedFrom && <div className="log-rename-boundary" role="note">↳ rename 跟随边界：此提交由 {entry.renamedFrom} 改名而来，更早的记录使用原路径（由 Git 的 rename 检测判断）</div>}
      </li>)}
    </ul>
    {!mode.loading && mode.history && (mode.history.next ? <button type="button" className="log-more" onClick={onMore}>加载更多</button>
      : mode.history.reachedOrigin ? <div className="log-note">已到达文件起点（新增该文件的提交）</div>
      : entries.length ? <div className="log-note warning">记录在此中断：Git 没有找到更早的连续记录（可能超出 rename 检测阈值或历史被截断），不能确认更早的同名文件是同一文件</div>
      : <div className="log-empty">该路径在起点提交的历史中没有记录（例如尚未提交的新文件）</div>)}
  </>;
}

function FileHistoryDetail({ mode }: { mode: Extract<Mode, { kind: "file" }> }) {
  const entry = mode.history?.entries.find((e) => e.commit.oid === mode.selected);
  if (!entry) return <div className="log-empty">选择一条记录，在主阅读器中查看该提交对此文件的改动（相对第一个父节点）</div>;
  const { commit } = entry;
  return <div className="log-detail-body">
    <strong className="log-detail-subject">{commit.subject}</strong>
    <div className="log-meta"><span className="log-sha-full">{commit.oid}</span></div>
    <div className="log-meta">作者 {commit.authorName} · {time(commit.authorTime)}</div>
    <div className="log-meta">该提交中的路径：{entry.path}{entry.renamedFrom ? `（由 ${entry.renamedFrom} 改名）` : ""}</div>
    {commit.parents.length > 1 && <div className="log-note">合并提交：与第一个父节点比较</div>}
    {commit.body && <pre className="log-body">{commit.body}</pre>}
  </div>;
}

function EndpointMenu({ menu, hasStart, blocked, onClose, onStart, onCompare, onCheckout, onNewBranch }: { menu: Menu; hasStart: boolean; blocked: string | null; onClose(): void; onStart(): void; onCompare(): void; onCheckout?(): void; onNewBranch?(): void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => { if (!host.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key, true); };
  }, [onClose]);
  return <div ref={host} className="file-menu log-menu" role="menu" style={{ left: menu.x, top: menu.y }} aria-label="比较">
    <span className="file-menu-note">{shortRef(menu.endpoint.label)} @ {shortOid(menu.endpoint.oid)}</span>
    <button type="button" role="menuitem" onClick={onStart}>设为比较起点（A）</button>
    <button type="button" role="menuitem" disabled={!hasStart} title={hasStart ? undefined : "先把另一个提交或分支设为比较起点"} onClick={onCompare}>与比较起点比较（A → 此处）</button>
    {onCheckout && <button type="button" role="menuitem" disabled={!!blocked} title={blocked ?? "检出该提交查看（分离 HEAD），不移动任何分支"} onClick={onCheckout}>检出（分离 HEAD）</button>}
    {onNewBranch && <button type="button" role="menuitem" disabled={!!blocked} title={blocked ?? undefined} onClick={onNewBranch}>从这里新建分支…</button>}
  </div>;
}
