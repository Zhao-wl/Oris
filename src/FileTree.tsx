import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { CompareScope, ContentUnchanged, FileChange } from "./types";
import { rowActions } from "./operations-model";

export type FileAction = "stage" | "unstage" | "markResolved" | "discard";

/**
 * 文件行上的写操作入口（R-STAGE / R-DISCARD）。选择即批量目标：Ctrl / Cmd + 点击切换、Shift + 点击连续选择，
 * 右键菜单对全部选中项操作；行右侧的按钮只作用于该行。
 */
export interface FileActions {
  scope: CompareScope;
  /** 写入口不可用的原因（校验中、其他写操作进行中、不支持的进行中状态）；null 为可用。 */
  disabledReason: string | null;
  /** 多选集合（少于 2 项时为单选，以 selectedPathId 为准）。 */
  selection: ReadonlySet<string>;
  /** 选择变化；focus 为需要在 diff 中显示的文件（null 表示保持当前显示）。 */
  onSelection(pathIds: string[], focus: FileChange | null): void;
  onAction(action: FileAction, files: FileChange[]): void;
}

interface ActionsContextValue extends FileActions {
  selectedPathId: string | null;
  clickRow(file: FileChange, modifiers: { toggle: boolean; range: boolean }): void;
  openMenu(file: FileChange, x: number, y: number): void;
}

const ActionsContext = createContext<ActionsContextValue | null>(null);

/** 行是否处于选中状态：多选时看集合，单选时看当前阅读的文件。 */
const isSelected = (actions: ActionsContextValue | null, pathId: string, selectedPathId: string | null) =>
  actions && actions.selection.size > 1 ? actions.selection.has(pathId) : pathId === selectedPathId;

const actionLabels: Record<Exclude<FileAction, "discard">, string> = { stage: "暂存", unstage: "取消暂存", markResolved: "标记已解决" };

/** 列表标注与说明：status 按 stat 缓存报修改，但规范化后内容一致（常见于 autocrlf 下编辑器改写行尾）。 */
export const contentUnchangedLabels: Record<ContentUnchanged, { short: string; detail: string }> = {
  eol: { short: "仅行尾", detail: "仅行尾（CRLF/LF）变化：Git 按行尾规则规范化后内容与比较基准一致，暂存不会产生内容变化" },
  normalized: { short: "内容未变", detail: "Git 规范化（如 clean filter / 行尾规则）后内容与比较基准一致，暂存不会产生内容变化" }
};

/** 内容未变的文件排在最后：与列表末尾的折叠区顺序一致，键盘切换与默认选中都先经过真实变化。 */
export const compareFiles = (a: FileChange, b: FileChange) => {
  const rank = (f: FileChange) => f.contentUnchanged ? 3 : f.status === "deleted" ? 1 : f.status === "added" || f.status === "untracked" ? 2 : 0;
  return rank(a) - rank(b) || (a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0);
};

function TailPath({ path, fullPath }: { path: string; fullPath: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const [label, setLabel] = useState(path);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    const fit = () => {
      context.font = getComputedStyle(element).font;
      const width = element.clientWidth;
      const chars = Array.from(path);
      if (context.measureText(path).width <= width) { setLabel(path); return; }
      let lo = 0, hi = chars.length;
      while (lo < hi) {
        const middle = Math.floor((lo + hi) / 2);
        if (context.measureText("…" + chars.slice(middle).join("")).width > width) lo = middle + 1;
        else hi = middle;
      }
      setLabel("…" + chars.slice(lo).join(""));
    };
    fit(); const observer = new ResizeObserver(fit); observer.observe(element);
    return () => observer.disconnect();
  }, [path]);
  return <span className="file-path" ref={host} title={fullPath}>{label}</span>;
}

interface DirectoryNode {
  name: string;
  path: string;
  directories: Map<string, DirectoryNode>;
  files: FileChange[];
}

interface Props {
  files: FileChange[];
  selectedPathId: string | null;
  mode: "flat" | "tree";
  /** 增删统计仍在后台补齐：显示占位，不能显示为 0。 */
  statsPending?: boolean;
  onSelect(file: FileChange): void;
  /** 写操作入口；不提供时文件行只用于阅读。 */
  actions?: FileActions;
}

/** 超过该行数时启用虚拟列表（技术方案 §5.7）。 */
export const VIRTUAL_THRESHOLD = 500;
const OVERSCAN = 12;

function FileButton({ file, selectedPathId, onSelect, depth = 0, showPath = false, statsPending = false, style }: {
  file: FileChange;
  selectedPathId: string | null;
  onSelect(file: FileChange): void;
  depth?: number;
  showPath?: boolean;
  statsPending?: boolean;
  style?: CSSProperties;
}) {
  const statusLabels = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "?", conflicted: "U", typeChanged: "T" } as const;
  const label = showPath ? file.displayPath : file.displayPath.split("/").at(-1) ?? file.displayPath;
  const actions = useContext(ActionsContext);
  const allowed = actions ? rowActions(actions.scope, file) : null;
  const run = (event: ReactMouseEvent, action: FileAction) => { event.stopPropagation(); actions?.onAction(action, [file]); };
  const selected = isSelected(actions, file.pathId, selectedPathId);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (actions) actions.clickRow(file, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }); else onSelect(file); }
    if (actions && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      actions.openMenu(file, rect.left + 24, rect.bottom);
    }
  };
  return (
    <div
      key={file.pathId}
      role="option"
      tabIndex={0}
      aria-selected={selected}
      aria-label={file.displayPath}
      title={file.oldDisplayPath ? `${file.oldDisplayPath} → ${file.displayPath}` : file.displayPath}
      className={`file${selected ? " selected" : ""}${file.pending ? " pending" : ""}`}
      style={{ "--tree-depth": depth, ...style } as CSSProperties}
      onClick={(event) => { if (actions) actions.clickRow(file, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }); else onSelect(file); }}
      onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
      onKeyDown={onKeyDown}
      onContextMenu={actions ? (event) => { event.preventDefault(); actions.openMenu(file, event.clientX, event.clientY); } : undefined}
    >
      <span className="file-icon">◇</span>
      <TailPath path={label} fullPath={file.displayPath}/>
      {file.oldDisplayPath && <span className="old-path" title={file.oldDisplayPath}>← {file.oldDisplayPath}</span>}
      {file.pending ? <span className="line-stat pending-mark" title="等待 Git 确认">确认中</span>
        : file.contentUnchanged ? <span className="line-stat unchanged" title={contentUnchangedLabels[file.contentUnchanged].detail}>{contentUnchangedLabels[file.contentUnchanged].short}</span>
        : file.additions !== null ? <span className="line-stat">+{file.additions} −{file.deletions ?? 0}</span>
        : statsPending && file.status !== "conflicted" && <span className="line-stat pending" title="增删统计正在后台补齐">…</span>}
      {actions && allowed && <span className="file-actions">
        {allowed.primary && <button type="button" className="file-action" disabled={!!actions.disabledReason || file.pending} title={actions.disabledReason ?? `${actionLabels[allowed.primary]} ${file.displayPath}`} onClick={(event) => run(event, allowed.primary!)}>{actionLabels[allowed.primary]}</button>}
      </span>}
      <span className={`status ${file.status}`}>{statusLabels[file.status]}</span>
    </div>
  );
}

/**
 * 右键菜单（丢弃只在这里提供）：右键点在已选中的文件上时作用于全部选中项（批量）；点在未选中的文件上时先单选该文件。
 * 暂存 / 取消暂存作用于其中的普通文件，冲突文件另有“标记已解决”；有任一文件不能丢弃时“丢弃…”不可用并说明原因。
 */
function FileMenu({ menu, files, onClose }: { menu: { file: FileChange; x: number; y: number; targets: string[] }; files: FileChange[]; onClose(): void }) {
  const actions = useContext(ActionsContext)!;
  const host = useRef<HTMLDivElement>(null);
  const picked = files.filter((file) => menu.targets.includes(file.pathId));
  const targets = picked.length ? picked : [menu.file];
  const regular = targets.filter((file) => file.status !== "conflicted");
  const conflicts = targets.filter((file) => file.status === "conflicted");
  const blocked = targets.map((file) => rowActions(actions.scope, file)).find((a) => !a.discard)?.discardBlocked ?? null;
  const pending = targets.some((file) => file.pending) ? "等待 Git 确认上一次操作" : null;
  const disabled = actions.disabledReason ?? pending;
  useEffect(() => {
    host.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (event: Event) => { if (!host.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key, true); };
  }, [onClose]);
  const act = (action: FileAction, list: FileChange[]) => { onClose(); actions.onAction(action, list); };
  const count = (list: FileChange[]) => (targets.length > 1 ? `（${list.length} 个文件）` : "");
  const stagingLabel = actions.scope === "staged" ? "取消暂存" : "暂存";
  const stagingReason = actions.scope === "all" ? "“全部”范围不区分暂存区，请在“未暂存”范围暂存" : !regular.length ? "所选都是冲突文件，请使用“标记已解决”" : null;
  return <div ref={host} className="file-menu" role="menu" style={{ left: menu.x, top: menu.y }} aria-label="文件操作">
    {targets.length > 1 && <span className="file-menu-note">已选中 {targets.length} 个文件</span>}
    <button type="button" role="menuitem" disabled={!!disabled || !!stagingReason} title={disabled ?? stagingReason ?? undefined} onClick={() => act(actions.scope === "staged" ? "unstage" : "stage", regular)}>{stagingLabel}{count(regular)}</button>
    {conflicts.length > 0 && <button type="button" role="menuitem" disabled={!!disabled} title={disabled ?? undefined} onClick={() => act("markResolved", conflicts)}>标记已解决{count(conflicts)}</button>}
    {actions.scope !== "staged" && <button type="button" role="menuitem" className="danger" disabled={!!disabled || !!blocked} title={disabled ?? blocked ?? "丢弃前会备份，可撤销"} onClick={() => act("discard", targets)}>丢弃…{count(targets)}</button>}
    {actions.scope === "staged" && <span className="file-menu-note">已暂存范围不提供丢弃，请先取消暂存</span>}
  </div>;
}

function buildTree(files: FileChange[]): DirectoryNode {
  const root: DirectoryNode = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const segments = file.displayPath.split("/");
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      const childPath = directory.path ? `${directory.path}/${segment}` : segment;
      let child = directory.directories.get(segment);
      if (!child) {
        child = { name: segment, path: childPath, directories: new Map(), files: [] };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }
  return root;
}

function Directory({ node, depth, selectedPathId, onSelect, statsPending = false }: {
  node: DirectoryNode;
  depth: number;
  selectedPathId: string | null;
  onSelect(file: FileChange): void;
  statsPending?: boolean;
}) {
  const directories = [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort(compareFiles);
  const content = (
    <>
      {directories.map((directory) => (
        <Directory
          key={directory.path}
          node={directory}
          depth={depth + 1}
          selectedPathId={selectedPathId}
          onSelect={onSelect}
          statsPending={statsPending}
        />
      ))}
      {files.map((file) => (
        <FileButton key={file.pathId} file={file} selectedPathId={selectedPathId} onSelect={onSelect} depth={depth} statsPending={statsPending} />
      ))}
    </>
  );
  if (!node.name) return content;
  return (
    <details className="tree-directory" open>
      <summary style={{ "--tree-depth": depth - 1 } as CSSProperties}>
        <span className="directory-chevron">›</span>
        <span className="directory-icon">▱</span>
        <span title={node.path}>{node.name}</span>
      </summary>
      {content}
    </details>
  );
}

type Row = { kind: "file"; file: FileChange; depth: number } | { kind: "dir"; node: DirectoryNode; depth: number };

function flattenTree(node: DirectoryNode, depth: number, collapsed: Set<string>, rows: Row[]) {
  for (const directory of [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push({ kind: "dir", node: directory, depth });
    if (!collapsed.has(directory.path)) flattenTree(directory, depth + 1, collapsed, rows);
  }
  for (const file of [...node.files].sort(compareFiles)) rows.push({ kind: "file", file, depth });
}

/** 固定行高的虚拟列表：只渲染可视区域附近的行，滚动容器为外层 `.files`。 */
function VirtualRows({ count, render }: { count: number; render(index: number, style: CSSProperties): JSX.Element }) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800, rowHeight: 28 });
  useLayoutEffect(() => {
    const container = host.current?.closest(".files") as HTMLElement | null;
    if (!container) return;
    const measure = () => {
      const sample = host.current?.querySelector<HTMLElement>(".file, .tree-row");
      const rowHeight = sample?.getBoundingClientRect().height || 28;
      const offset = host.current ? host.current.offsetTop - container.offsetTop : 0;
      setView((current) => {
        const next = { top: Math.max(0, container.scrollTop - offset), height: container.clientHeight || 800, rowHeight };
        return current.top === next.top && current.height === next.height && current.rowHeight === next.rowHeight ? current : next;
      });
    };
    measure();
    container.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => { container.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [count]);
  const start = Math.max(0, Math.floor(view.top / view.rowHeight) - OVERSCAN);
  const end = Math.min(count, Math.ceil((view.top + view.height) / view.rowHeight) + OVERSCAN);
  const rows: JSX.Element[] = [];
  for (let index = start; index < end; index++) rows.push(render(index, { position: "absolute", top: index * view.rowHeight, left: 0, right: 0 }));
  return <div ref={host} className="virtual-rows" style={{ position: "relative", height: count * view.rowHeight }} data-virtual-count={count}>{rows}</div>;
}

/** 列表末尾的折叠区：默认收起，只由点击展开 / 收起；收起时若选中项在其中，分割线文字高亮提示。 */
function UnchangedFold({ files, selectedPathId, mode, onSelect }: Omit<Props, "statsPending" | "actions">) {
  const [expanded, setExpanded] = useState(false);
  const containsSelection = files.some((file) => file.pathId === selectedPathId);
  const label = `${files.length}个折叠内容`;
  return (
    <div className="unchanged-fold">
      <button
        type="button"
        className={!expanded && containsSelection ? "fold-divider has-selection" : "fold-divider"}
        aria-expanded={expanded}
        title="Git status 报告修改，但按 Git 规则规范化后内容与比较基准一致"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="fold-label">{expanded ? "▾" : "▸"} {label}</span>
      </button>
      {expanded && <FileList files={files} selectedPathId={selectedPathId} mode={mode} onSelect={onSelect} />}
    </div>
  );
}

export default function FileTree({ files, selectedPathId, mode, statsPending = false, onSelect, actions }: Props) {
  const changed = useMemo(() => files.filter((file) => !file.contentUnchanged), [files]);
  const unchanged = useMemo(() => files.filter((file) => file.contentUnchanged), [files]);
  const [menu, setMenu] = useState<{ file: FileChange; x: number; y: number; targets: string[] } | null>(null);
  const anchor = useRef<string | null>(null);
  // 最新的选择（含尚未重渲染的连续点击），每次渲染按 props 重置。
  const latest = useRef<string[]>([]);
  latest.current = actions && actions.selection.size > 1 ? [...actions.selection] : selectedPathId ? [selectedPathId] : [];
  const focused = useRef(selectedPathId);
  focused.current = selectedPathId;
  // 列表的显示顺序（Shift 连续选择按此计算）。
  const order = useMemo(() => {
    const sortedUnchanged = [...unchanged].sort(compareFiles);
    if (mode === "flat") return [...[...changed].sort(compareFiles), ...sortedUnchanged].map((file) => file.pathId);
    const rows: Row[] = [];
    flattenTree(buildTree(changed), 0, new Set(), rows);
    return [...rows.flatMap((row) => (row.kind === "file" ? [row.file.pathId] : [])), ...sortedUnchanged.map((file) => file.pathId)];
  }, [changed, unchanged, mode]);
  const context = useMemo<ActionsContextValue | null>(() => {
    if (!actions) return null;
    const byId = new Map(files.map((file) => [file.pathId, file]));
    const apply = (ids: string[], focus: FileChange | null) => {
      latest.current = ids;
      if (focus) focused.current = focus.pathId;
      actions.onSelection(ids, focus);
    };
    const clickRow = (file: FileChange, { toggle, range }: { toggle: boolean; range: boolean }) => {
      const current = latest.current;
      if (range) {
        const from = order.indexOf(anchor.current ?? focused.current ?? file.pathId);
        const to = order.indexOf(file.pathId);
        const [start, end] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
        apply(order.slice(start, end + 1), file);
      } else if (toggle) {
        anchor.current = file.pathId;
        if (current.includes(file.pathId)) {
          const next = current.filter((id) => id !== file.pathId);
          if (!next.length) return;
          apply(next, file.pathId === focused.current ? byId.get(next[0]) ?? null : null);
        } else apply([...current, file.pathId], file);
      } else {
        anchor.current = file.pathId;
        apply([file.pathId], file);
      }
    };
    const openMenu = (file: FileChange, x: number, y: number) => {
      const current = latest.current;
      if (current.length > 1 && current.includes(file.pathId)) { setMenu({ file, x, y, targets: [...current] }); return; }
      if (file.pathId !== focused.current || current.length > 1) clickRow(file, { toggle: false, range: false });
      setMenu({ file, x, y, targets: [file.pathId] });
    };
    return { ...actions, selectedPathId, clickRow, openMenu };
  }, [actions, files, order, selectedPathId]);
  const closeMenu = useMemo(() => () => setMenu(null), []);
  const list = !unchanged.length
    ? <FileList files={files} selectedPathId={selectedPathId} mode={mode} statsPending={statsPending} onSelect={onSelect} />
    : <>
      <FileList files={changed} selectedPathId={selectedPathId} mode={mode} statsPending={statsPending} onSelect={onSelect} />
      <UnchangedFold files={unchanged} selectedPathId={selectedPathId} mode={mode} onSelect={onSelect} />
    </>;
  return <ActionsContext.Provider value={context}>{list}{menu && context && <FileMenu menu={menu} files={files} onClose={closeMenu}/>}</ActionsContext.Provider>;
}

function FileList({ files, selectedPathId, mode, statsPending = false, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const sorted = useMemo(() => [...files].sort(compareFiles), [files]);
  const virtual = files.length > VIRTUAL_THRESHOLD;
  const treeRows = useMemo(() => {
    if (!virtual || mode !== "tree") return [];
    const rows: Row[] = [];
    flattenTree(buildTree(files), 0, collapsed, rows);
    return rows;
  }, [virtual, mode, files, collapsed]);
  if (mode === "flat") {
    if (virtual) return <VirtualRows count={sorted.length} render={(index, style) => (
      <FileButton key={sorted[index].pathId} file={sorted[index]} selectedPathId={selectedPathId} onSelect={onSelect} showPath statsPending={statsPending} style={style} />
    )} />;
    return <>{sorted.map((file) => (
      <FileButton key={file.pathId} file={file} selectedPathId={selectedPathId} onSelect={onSelect} showPath statsPending={statsPending} />
    ))}</>;
  }
  if (virtual) {
    const toggle = (path: string) => setCollapsed((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
    return <VirtualRows count={treeRows.length} render={(index, style) => {
      const row = treeRows[index];
      if (row.kind === "file") return <FileButton key={row.file.pathId} file={row.file} selectedPathId={selectedPathId} onSelect={onSelect} depth={row.depth + 1} statsPending={statsPending} style={style} />;
      const open = !collapsed.has(row.node.path);
      return <div key={`dir:${row.node.path}`} role="treeitem" aria-expanded={open} className={`tree-row tree-directory-row${open ? " open" : ""}`} style={{ ...style, "--tree-depth": row.depth } as CSSProperties} onClick={() => toggle(row.node.path)}>
        <span className="directory-chevron">›</span><span className="directory-icon">▱</span><span title={row.node.path}>{row.node.name}</span>
      </div>;
    }} />;
  }
  const tree = buildTree(files);
  return <Directory node={tree} depth={0} selectedPathId={selectedPathId} onSelect={onSelect} statsPending={statsPending} />;
}
