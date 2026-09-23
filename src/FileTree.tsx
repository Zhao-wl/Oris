import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import type { FileChange } from "./types";

export const compareFiles = (a: FileChange, b: FileChange) => {
  const rank = (f: FileChange) => f.status === "deleted" ? 1 : f.status === "added" || f.status === "untracked" ? 2 : 0;
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
  return (
    <button
      key={file.pathId}
      role="option"
      aria-selected={file.pathId === selectedPathId}
      aria-label={file.displayPath}
      title={file.oldDisplayPath ? `${file.oldDisplayPath} → ${file.displayPath}` : file.displayPath}
      className={file.pathId === selectedPathId ? "file selected" : "file"}
      style={{ "--tree-depth": depth, ...style } as CSSProperties}
      onClick={() => onSelect(file)}
    >
      <span className="file-icon">◇</span>
      <TailPath path={label} fullPath={file.displayPath}/>
      {file.oldDisplayPath && <span className="old-path" title={file.oldDisplayPath}>← {file.oldDisplayPath}</span>}
      {file.additions !== null ? <span className="line-stat">+{file.additions} −{file.deletions ?? 0}</span>
        : statsPending && file.status !== "conflicted" && <span className="line-stat pending" title="增删统计正在后台补齐">…</span>}
      <span className={`status ${file.status}`}>{statusLabels[file.status]}</span>
    </button>
  );
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

export default function FileTree({ files, selectedPathId, mode, statsPending = false, onSelect }: Props) {
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
