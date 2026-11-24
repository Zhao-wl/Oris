import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { parseConflictBlocks, type ConflictBlock } from "../conflict-blocks";
import type { ContentPair, TextSide } from "../types";
import type { ConflictIdentity } from "../operations-api";
import "./conflict-editor.css";

export type ConflictSource = { repoId: string; pathId: string; path: string; identity: ConflictIdentity; versions: [TextSide, TextSide, TextSide, TextSide] };

export function conflictSource(base: ContentPair, sides: ContentPair): ConflictSource {
  if (base.stale || sides.stale || base.repoId !== sides.repoId || base.pathId !== sides.pathId || base.revision !== sides.revision ||
      base.left.endpoint !== "stage1" || sides.left.endpoint !== "stage2" || sides.right.endpoint !== "stage3" || base.right.endpoint !== "workingTree") {
    throw new Error("冲突版本已变化，请重新读取。");
  }
  const worktree = base.right;
  if (worktree.text === null || worktree.encoding !== "utf-8" || (worktree.kind && worktree.kind !== "text") || worktree.eol === "mixed" || /\r(?!\n)/.test(worktree.text)) {
    throw new Error("此工作区版本只能查看。编辑需要普通 UTF-8 文本和一致的换行格式。");
  }
  const stage = (side: TextSide) => {
    if (side.encoding === "missing") return null;
    if (!side.details?.oid || !["100644", "100755"].includes(side.details.mode ?? "") || side.text === null || (side.kind && side.kind !== "text")) {
      throw new Error("部分 index 版本不支持文本编辑，请使用现有只读版本查看。");
    }
    return { oid: side.details.oid, mode: side.details.mode! };
  };
  return { repoId: base.repoId, pathId: base.pathId, path: base.displayPath,
    identity: { repoId: base.repoId, revision: base.revision, stages: [stage(base.left), stage(sides.left), stage(sides.right)], worktreeContentId: worktree.contentId },
    versions: [base.left, sides.left, sides.right, worktree],
  };
}

export function adoptConflictBlock(text: string, block: ConflictBlock, choice: "first" | "second" | "both") {
  const chosen = choice === "first" ? block.oursLines : choice === "second" ? block.theirsLines : [...block.oursLines, ...block.theirsLines];
  const lines = text.split("\n");
  return [...lines.slice(0, block.line - 1), ...chosen, ...lines.slice(block.endLine)].join("\n");
}

const versionLabels = ["Base · stage 1", "第一方 · stage 2", "第二方 · stage 3"] as const;

function SourceVersion({ side, label, excerpt }: { side: TextSide; label: string; excerpt?: string | null }) {
  const marker = useRef<HTMLElement>(null);
  const panel = useRef<HTMLPreElement>(null);
  const text = useMemo(() => side.text?.replace(/\r\n/g, "\n") ?? "", [side.text]);
  const start = excerpt ? text.indexOf(excerpt) : -1;
  const length = excerpt?.length ?? 0;
  const linked = start >= 0 && length > 0 && (start === 0 || text[start - 1] === "\n") &&
    (start + length === text.length || text[start + length] === "\n") && text.indexOf(excerpt!, start + 1) < 0;
  useEffect(() => {
    if (linked && marker.current && panel.current) {
      panel.current.scrollTop += marker.current.getBoundingClientRect().top - panel.current.getBoundingClientRect().top;
    }
  }, [excerpt, linked]);
  return <section><h3>{label}</h3><pre ref={panel}>{side.encoding === "missing" ? "此版本缺失" : linked
    ? <>{text.slice(0, start)}<mark ref={marker}>{excerpt}</mark>{text.slice(start + length)}</> : text}</pre></section>;
}

export default function ConflictEditor({ source, dialogRef, busy, message, onSave, onResolve, onReload, onUndo, onClose }: {
  source: ConflictSource;
  dialogRef: Ref<HTMLElement>;
  busy: boolean;
  message: string | null;
  onSave(text: string): Promise<void>;
  onResolve(): void;
  onReload(): void;
  onUndo?(): void;
  onClose(dirty: boolean): void;
}) {
  const current = source.versions[3];
  const original = useMemo(() => current.text!.replace(/\r\n/g, "\n"), [current.text]);
  const [draft, setDraft] = useState(original);
  const [selected, setSelected] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { editor.current?.focus(); }, []);
  const changed = draft !== original;
  const blocks = useMemo(() => parseConflictBlocks(draft), [draft]);
  const index = Math.min(selected, blocks.length - 1);
  const block = blocks[index];
  const choose = (choice: "first" | "second" | "both") => {
    if (block) setDraft(adoptConflictBlock(draft, block, choice));
  };
  const move = (next: number) => {
    setSelected(next);
    if (editor.current) {
      const lineHeight = Number.parseFloat(getComputedStyle(editor.current).lineHeight);
      editor.current.scrollTop = Math.max(0, (blocks[next].line - 2) * lineHeight);
    }
  };
  return <div className="dialog-overlay">
    <section ref={dialogRef} tabIndex={-1} className="conflict-editor" role="dialog" aria-label="冲突编辑器" aria-modal="true" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(changed); }
    }}>
      <div className="panel-title"><strong>编辑冲突</strong><span title={source.path}>{source.path}</span>
        <button type="button" disabled={busy} onClick={() => onClose(changed)} aria-label="关闭冲突编辑器">×</button></div>
      <div className="conflict-editor-sources">
        {versionLabels.map((label, i) => <SourceVersion key={label} label={label} side={source.versions[i]} excerpt={[block?.base, block?.ours, block?.theirs][i]}/>)}
      </div>
      <div className="conflict-editor-block" aria-label="工作区冲突块">
        <span role="status">{blocks.length ? `未处理 ${blocks.length} 块 · 当前第 ${index + 1} 块` : "没有完整的冲突标记块"}</span>
        {block && <>
          <button type="button" disabled={busy || index <= 0} onClick={() => move(index - 1)}>上一块</button>
          <button type="button" disabled={busy || index >= blocks.length - 1} onClick={() => move(index + 1)}>下一块</button>
          <button type="button" disabled={busy} onClick={() => choose("first")}>采用第一方</button>
          <button type="button" disabled={busy} onClick={() => choose("second")}>采用第二方</button>
          <button type="button" disabled={busy} onClick={() => choose("both")}>依次保留两方</button>
        </>}
      </div>
      {block && <div className="conflict-editor-block-preview" aria-label="当前冲突片段">
        <pre aria-label="第一方片段">{block.ours}</pre><pre aria-label="第二方片段">{block.theirs}</pre>
      </div>}
      <label className="conflict-result">工作区结果
        <textarea ref={editor} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} spellCheck={false} wrap="off"/>
      </label>
      {message && <p role="status">{message}</p>}
      <div className="conflict-editor-footer">
        <span>UTF-8{current.bom ? " BOM" : ""} · {current.eol === "crlf" ? "CRLF" : "LF"}</span><span className="spacer"/>
        {onUndo && <button type="button" disabled={busy || changed} onClick={onUndo}>撤销保存</button>}
        <button type="button" disabled={busy} onClick={onReload}>{changed ? "放弃草稿并重新读取" : "重新读取"}</button>
        <button type="button" disabled={busy || changed || blocks.length > 0} onClick={onResolve}>标记已解决</button>
        <button type="button" className="primary" disabled={busy || !changed} onClick={() => void onSave(draft)}>保存结果</button>
      </div>
    </section>
  </div>;
}
