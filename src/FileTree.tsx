import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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
  onSelect(file: FileChange): void;
}

function FileButton({ file, selectedPathId, onSelect, depth = 0, showPath = false }: {
  file: FileChange;
  selectedPathId: string | null;
  onSelect(file: FileChange): void;
  depth?: number;
  showPath?: boolean;
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
      style={{ "--tree-depth": depth } as CSSProperties}
      onClick={() => onSelect(file)}
    >
      <span className="file-icon">◇</span>
      <TailPath path={label} fullPath={file.displayPath}/>
      {file.oldDisplayPath && <span className="old-path" title={file.oldDisplayPath}>← {file.oldDisplayPath}</span>}
      {file.additions !== null && <span className="line-stat">+{file.additions} −{file.deletions ?? 0}</span>}
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

function Directory({ node, depth, selectedPathId, onSelect }: {
  node: DirectoryNode;
  depth: number;
  selectedPathId: string | null;
  onSelect(file: FileChange): void;
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
        />
      ))}
      {files.map((file) => (
        <FileButton key={file.pathId} file={file} selectedPathId={selectedPathId} onSelect={onSelect} depth={depth} />
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

export default function FileTree({ files, selectedPathId, mode, onSelect }: Props) {
  if (mode === "flat") {
    return <>{[...files]
      .sort(compareFiles)
      .map((file) => (
        <FileButton key={file.pathId} file={file} selectedPathId={selectedPathId} onSelect={onSelect} showPath />
      ))}</>;
  }
  const tree = buildTree(files);
  return <Directory node={tree} depth={0} selectedPathId={selectedPathId} onSelect={onSelect} />;
}
