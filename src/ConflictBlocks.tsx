import { useMemo, useState } from "react";
import type { ContentPair } from "./types";
import { parseConflictBlocks } from "./conflict-blocks";

export function ConflictBlocks({ pair, branch }: { pair: ContentPair; branch: string }) {
  const blocks = useMemo(() => parseConflictBlocks(pair.right.text ?? ""), [pair]);
  const [index, setIndex] = useState(0);
  const block = blocks[Math.min(index, blocks.length - 1)];
  return <div className="conflict-block-reader">
    <p>依据当前工作文件中的 Git 冲突标记展示。第一方为 index stage 2，第二方为 index stage 3；变基时 stage 2 是变基目标，stage 3 是正在重放的提交，不能简单理解为“我的 / 别人的”。</p>
    {!block ? <div role="status"><strong>未发现完整的文本冲突块</strong><p>这不表示冲突已解决：可能已手动移除标记，或属于删除／修改、二进制、文件类型冲突。请通过“全文件比较”检查双方版本，再决定是否标记已解决。</p>{pair.right.details?.reason && <p>{pair.right.details.reason}</p>}</div> : <>
      <nav aria-label="冲突块导航"><button disabled={index <= 0} onClick={() => setIndex(i => i - 1)}>上一处冲突</button><strong aria-live="polite">冲突 {Math.min(index + 1, blocks.length)} / {blocks.length}</strong><button disabled={index >= blocks.length - 1} onClick={() => setIndex(i => i + 1)}>下一处冲突</button><span>工作文件第 {block.line}–{block.endLine} 行</span></nav>
      <div className="conflict-block-sides"><section><h3>第一方 · {block.oursLabel}</h3><p>stage 2 · 当前检出：{branch || "分离 HEAD"}</p><pre>{block.ours || "（此侧内容为空）"}</pre></section><section><h3>第二方 · {block.theirsLabel}</h3><p>stage 3 · 正在合入／重放的一方</p><pre>{block.theirs || "（此侧内容为空）"}</pre></section></div>
      <details key={block.line}><summary>展开共同祖先{block.base === null ? "（完整文件 · stage 1）" : "（此冲突块）"}</summary>{block.base === null && <p>当前标记没有包含祖先片段，以下为 index stage 1 的完整文件，不是此块对应行。</p>}<pre>{block.base ?? pair.left.text ?? "共同祖先不存在或无法读取（例如双方新增）。"}</pre></details>
    </>}
  </div>;
}
