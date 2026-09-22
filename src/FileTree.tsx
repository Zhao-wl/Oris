import type { CSSProperties } from "react";
import type { FileChange } from "./types";

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
  const label = showPath ? file.displayPath : file.displayPath.split("/").at(-1) ?? file.displayPath;
  return (
    <button
      key={file.pathId}
      role="option"
      aria-selected={file.pathId === selectedPathId}
      aria-label={file.displayPath}
      className={file.pathId === selectedPathId ? "file selected" : "file"}
      style={{ "--tree-depth": depth } as CSSProperties}
      onClick={() => onSelect(file)}
    >
      <span className="file-icon">◇</span>
      <span className="file-path" title={file.displayPath}>{label}</span>
      <span className={`status ${file.status}`}>
        {file.status === "deleted" ? "D" : file.status === "typeChanged" ? "T" : "M"}
      </span>
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
  const files = [...node.files].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
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
      .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
      .map((file) => (
        <FileButton key={file.pathId} file={file} selectedPathId={selectedPathId} onSelect={onSelect} showPath />
      ))}</>;
  }
  const tree = buildTree(files);
  return <Directory node={tree} depth={0} selectedPathId={selectedPathId} onSelect={onSelect} />;
}
