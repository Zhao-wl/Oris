import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openRepository, readContentPair } from "./api";
import { calculateDiff } from "./diff";
import DiffViewer, { type DiffViewerHandle } from "./DiffViewer";
import FileTree from "./FileTree";
import type { ContentPair, DiffDocument, RepositorySnapshot } from "./types";

const newRequestId = () => crypto.randomUUID();
const editorText = (text: string) => text.replace(/\r\n?/g, "\n");
const SIDEBAR_MIN_WIDTH = 180;
const DIFF_MIN_WIDTH = 480;
const RECENT_REPOSITORY_KEY = "oris.recentRepository.v1";

interface RecentRepository {
  path: string;
  gitExecutable: string;
}

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "操作失败";
}

function saveRecentRepository(value: RecentRepository) {
  try {
    localStorage.setItem(RECENT_REPOSITORY_KEY, JSON.stringify(value));
  } catch {
    // The repository is already open. Storage availability must not break reading.
  }
}

function readRecentRepository(): RecentRepository | null {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_REPOSITORY_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<RecentRepository>;
    if (typeof candidate.path !== "string" || !candidate.path.trim()) return null;
    return {
      path: candidate.path,
      gitExecutable: typeof candidate.gitExecutable === "string" ? candidate.gitExecutable : ""
    };
  } catch {
    return null;
  }
}

function ToggleButton({ label, pressed, onClick }: { label: string; pressed: boolean; onClick(): void }) {
  return (
    <button
      className={`toggle-button ${pressed ? "active" : "inactive"}`}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span>{label}</span>
    </button>
  );
}

export default function App() {
  const [path, setPath] = useState("");
  const [gitExecutable, setGitExecutable] = useState("");
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [pair, setPair] = useState<ContentPair | null>(null);
  const [diffDocument, setDiffDocument] = useState<DiffDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [highlight, setHighlight] = useState<"words" | "lines">("words");
  const [collapsed, setCollapsed] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [alignChanges, setAlignChanges] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [dark, setDark] = useState(true);
  const [filter, setFilter] = useState("");
  const [fileView, setFileView] = useState<"flat" | "tree">("flat");
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);
  const [position, setPosition] = useState({ current: 0, total: 0 });
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [splitLayout, setSplitLayout] = useState({ ratio: 0.5, leftWidth: 0 });
  const latestRequest = useRef("");
  const restoreAttempted = useRef(false);
  const viewer = useRef<DiffViewerHandle>(null);
  const workspace = useRef<HTMLElement>(null);
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const clampSidebarWidth = useCallback((width: number) => {
    const available = workspace.current?.clientWidth ?? window.innerWidth;
    const maximum = Math.max(SIDEBAR_MIN_WIDTH, available - DIFF_MIN_WIDTH - 6);
    return Math.round(Math.min(maximum, Math.max(SIDEBAR_MIN_WIDTH, width)));
  }, []);

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    sidebarResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = sidebarResize.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setSidebarWidth(clampSidebarWidth(active.startWidth + event.clientX - active.startX));
  };

  const endSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResize.current?.pointerId !== event.pointerId) return;
    sidebarResize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const selectFile = useCallback(async (
    nextSnapshot: RepositorySnapshot,
    pathId: string,
    effectiveGitExecutable = gitExecutable
  ) => {
    const requestId = newRequestId();
    latestRequest.current = requestId;
    setSelectedPathId(pathId);
    setPair(null);
    setDiffDocument(null);
    setError(null);
    setLoading(true);
    try {
      const result = await readContentPair(
        nextSnapshot.repo.repoId,
        nextSnapshot.revision,
        pathId,
        effectiveGitExecutable || null,
        requestId
      );
      if (latestRequest.current !== requestId) return;
      if (result.stale) throw new Error("仓库内容在读取期间发生变化，请刷新后重试。旧结果未显示。");
      setPair(result);
      if (result.left.text !== null && result.right.text !== null) {
        const computed = await calculateDiff(
          requestId,
          [result.left.contentId, result.right.contentId],
          editorText(result.left.text),
          editorText(result.right.text)
        );
        if (latestRequest.current !== requestId) return;
        setDiffDocument(computed);
      }
    } catch (nextError) {
      if (latestRequest.current === requestId) setError(errorText(nextError));
    } finally {
      if (latestRequest.current === requestId) setLoading(false);
    }
  }, [gitExecutable]);

  const loadRepository = useCallback(async (
    repositoryPath: string,
    effectiveGitExecutable = gitExecutable,
    restoring = false
  ) => {
    if (!repositoryPath.trim()) return;
    const requestId = newRequestId();
    latestRequest.current = requestId;
    setError(null);
    setLoading(true);
    setPair(null);
    setDiffDocument(null);
    setRestoreStatus(restoring ? "正在恢复上次成功打开的仓库…" : null);
    try {
      const result = await openRepository(repositoryPath.trim(), effectiveGitExecutable || null, requestId);
      if (latestRequest.current !== requestId) return;
      setPath(result.repo.worktreePath);
      setGitExecutable(effectiveGitExecutable);
      setSnapshot(result);
      saveRecentRepository({ path: result.repo.worktreePath, gitExecutable: effectiveGitExecutable });
      if (restoring) setRestoreStatus("已恢复上次成功打开的仓库");
      const first = result.files[0];
      if (first) await selectFile(result, first.pathId, effectiveGitExecutable);
      else setSelectedPathId(null);
    } catch (nextError) {
      if (latestRequest.current === requestId) {
        const message = errorText(nextError);
        setError(restoring ? `上次仓库恢复失败：${message}。请选择或输入一个有效仓库后重新载入。` : message);
        if (restoring) setRestoreStatus("上次仓库未能恢复");
      }
    } finally {
      if (latestRequest.current === requestId) setLoading(false);
    }
  }, [gitExecutable, selectFile]);

  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    const recent = readRecentRepository();
    if (!recent) return;
    setPath(recent.path);
    setGitExecutable(recent.gitExecutable);
    void loadRepository(recent.path, recent.gitExecutable, true);
  }, [loadRepository]);

  const chooseRepository = async () => {
    const selected = await open({ directory: true, multiple: false, title: "打开已有 Git 仓库" });
    if (typeof selected === "string") await loadRepository(selected);
  };

  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return snapshot?.files.filter((file) => file.displayPath.toLocaleLowerCase().includes(query)) ?? [];
  }, [snapshot, filter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F7") {
        event.preventDefault();
        viewer.current?.navigate(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const current = workspace.current;
    if (!current) return;
    const observer = new ResizeObserver(() => setSidebarWidth((width) => clampSidebarWidth(width)));
    observer.observe(current);
    return () => observer.disconnect();
  }, [clampSidebarWidth]);

  const selectedFile = snapshot?.files.find((file) => file.pathId === selectedPathId);
  const readable = pair?.left.text !== null && pair?.right.text !== null;
  const handlePositionChange = useCallback((current: number, total: number) => {
    setPosition({ current, total });
  }, []);
  const handleSplitLayoutChange = useCallback((ratio: number, leftWidth: number) => {
    setSplitLayout((current) =>
      Math.abs(current.ratio - ratio) < 0.0001 && current.leftWidth === leftWidth
        ? current
        : { ratio, leftWidth }
    );
  }, []);

  return (
    <main className={dark ? "app dark" : "app light"}>
      <header className="titlebar">
        <span className="logo">O</span>
        <strong>{snapshot?.repo.displayName ?? "Oris"}</strong>
        {snapshot && <span className="branch">⑂ {snapshot.repo.branch}</span>}
        <span className="spacer" />
        <span className="readonly">▣ 只读</span>
        <button onClick={() => setDark((value) => !value)} aria-label="切换主题">{dark ? "☀" : "☾"}</button>
      </header>

      <section className="openbar">
        <button className="primary" onClick={chooseRepository}>打开仓库</button>
        <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="仓库绝对路径" aria-label="仓库路径" />
        <button onClick={() => void loadRepository(path)} disabled={loading || !path.trim()}>载入</button>
        <details>
          <summary>Git 设置</summary>
          <input value={gitExecutable} onChange={(event) => setGitExecutable(event.target.value)} placeholder="留空自动发现 Git" aria-label="Git 可执行文件" />
        </details>
        {snapshot && <button onClick={() => void loadRepository(snapshot.repo.worktreePath)} disabled={loading}>刷新</button>}
        {restoreStatus && <span className="restore-status" role="status">{restoreStatus}</span>}
      </section>

      <section
        className="workspace"
        ref={workspace}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="sidebar">
          <div className="panel-title"><strong>变更</strong><span>Index → Working Tree</span></div>
          <div className="scope-row">
            <div className="scope selected">工作区</div>
            <select
              className="file-view-select"
              aria-label="文件显示方式"
              title={fileView === "flat" ? "平铺显示相对路径" : "树状显示目录"}
              value={fileView}
              onChange={(event) => setFileView(event.target.value as "flat" | "tree")}
            >
              <option value="flat">☷</option>
              <option value="tree">⑂</option>
            </select>
          </div>
          <input className="filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选文件" />
          <div className="files" role="listbox" aria-label="tracked 未暂存变更">
            {snapshot && (
              <FileTree
                files={visibleFiles}
                selectedPathId={selectedPathId}
                mode={fileView}
                onSelect={(file) => void selectFile(snapshot, file.pathId)}
              />
            )}
            {snapshot && !visibleFiles.length && <div className="empty">{filter ? "没有匹配文件" : "没有 tracked 未暂存变更"}</div>}
            {!snapshot && <div className="empty">打开真实 Git 仓库以查看变化</div>}
          </div>
          <footer>{snapshot ? `${snapshot.files.length} 个文件` : "未连接仓库"}</footer>
        </aside>

        <div
          className="workspace-resizer"
          role="separator"
          aria-label="调整文件侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={beginSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={endSidebarResize}
          onPointerCancel={endSidebarResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setSidebarWidth((width) => clampSidebarWidth(width + (event.key === "ArrowLeft" ? -16 : 16)));
          }}
        />

        <section className="editor">
          <div className="tabbar"><strong>{selectedFile?.displayPath ?? "Diff"}</strong><span className="spacer" />{diffDocument && <span>{diffDocument.hunks.length} 处差异 · Worker {diffDocument.elapsedMs.toFixed(1)} ms</span>}</div>
          <div className="toolbar">
            <button onClick={() => viewer.current?.navigate(-1)} disabled={!position.total} title="上一处差异 · Shift+F7">↑</button>
            <button onClick={() => viewer.current?.navigate(1)} disabled={!position.total} title="下一处差异 · F7">↓</button>
            <span>{position.current} / {position.total}</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as "split" | "unified")} aria-label="Diff 布局">
              <option value="split">并排视图</option><option value="unified">统一视图</option>
            </select>
            <select value={highlight} onChange={(event) => setHighlight(event.target.value as "words" | "lines")} aria-label="高亮粒度">
              <option value="words">按词高亮</option><option value="lines">按行高亮</option>
            </select>
            <ToggleButton label="折叠上下文" pressed={collapsed} onClick={() => setCollapsed((value) => !value)} />
            <ToggleButton label="自动换行" pressed={wrap} onClick={() => setWrap((value) => !value)} />
            <ToggleButton label="对齐变化" pressed={alignChanges} onClick={() => setAlignChanges((value) => !value)} />
            <label className="font-control">字号 <input type="range" min="11" max="18" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /><output>{fontSize}</output></label>
          </div>
          <div
            className={mode === "split" ? "endpoints split" : "endpoints"}
            style={{ "--diff-header-left-width": `${splitLayout.leftWidth}px` } as CSSProperties}
          >
            <span>▣ Index（暂存区）</span>
            {mode === "split" && <span className="endpoint-gutter" aria-hidden="true" />}
            <span className="right-endpoint">
              <span>▣ Working Tree（工作区）</span>
              {pair && <span className="encoding">{pair.right.encoding} · {pair.right.eol.toUpperCase()}{pair.right.hasFinalNewline === false ? " · 无末尾换行" : ""}</span>}
            </span>
          </div>
          <div className="content">
            {loading && <div className="state">正在读取真实仓库…</div>}
            {error && <div className="state error"><strong>无法显示差异</strong><p>{error}</p></div>}
            {!loading && !error && pair?.degradation && <div className="state warning"><strong>内容已降级</strong><p>{pair.degradation}</p></div>}
            {!loading && !error && readable && pair && diffDocument && (
              <DiffViewer
                ref={viewer}
                left={editorText(pair.left.text ?? "")}
                right={editorText(pair.right.text ?? "")}
                document={diffDocument!}
                mode={mode}
                highlight={highlight}
                collapsed={collapsed}
                wrap={wrap}
                fontSize={fontSize}
                dark={dark}
                alignChanges={alignChanges}
                onPositionChange={handlePositionChange}
                onSplitLayoutChange={handleSplitLayoutChange}
              />
            )}
            {!loading && !error && !pair && <div className="state">选择一个变化文件开始阅读</div>}
          </div>
          <footer className="diff-footer"><span>蓝：修改　绿：新增　灰：删除</span><span className="spacer" />{snapshot && <span>Git {snapshot.git.version} · revision {snapshot.revision.slice(0, 8)}</span>}</footer>
        </section>
      </section>
      <footer className="statusbar"><span>{snapshot ? `${snapshot.repo.worktreePath} · ${snapshot.repo.branch}` : "工作区 → 差异浏览"}</span><span className="spacer" /><span>本机 Git · 无仓库写入</span></footer>
    </main>
  );
}
