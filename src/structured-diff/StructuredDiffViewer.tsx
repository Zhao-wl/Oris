import { useEffect, useState } from "react";
import type { StructuredFormat, StructuredResult } from "./model";
import { STRUCTURED_MAX_BYTES } from "./budget";
import "./structured-diff.css";

type Reply = { result: StructuredResult } | { error: string };
interface Props {
  format: StructuredFormat;
  left: string | null;
  right: string | null;
  onRaw(side?: "left" | "right", line?: number): void;
}

const labels = { added: "新增", deleted: "删除", modified: "修改", typeChanged: "类型变化" };

export default function StructuredDiffViewer({ format, left, right, onRaw }: Props) {
  const [reply, setReply] = useState<Reply | null>(null);
  useEffect(() => {
    // UTF-8 occupies at least one byte per UTF-16 code unit. Avoid copying oversized strings to the worker.
    if ([left, right].some(text => text !== null && text.length > STRUCTURED_MAX_BYTES)) {
      setReply({ error: "文件超过结构比较的 512 KiB 单侧预算" });
      return;
    }
    let worker: Worker;
    try { worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }); }
    catch { setReply({ error: "无法启动结构分析" }); return; }
    const complete = (value: Reply) => {
      clearTimeout(timeout);
      worker.terminate();
      setReply(value);
    };
    const timeout = window.setTimeout(() => complete({ error: "结构分析超过时间预算" }), 1500);
    worker.onmessage = ({ data }: MessageEvent<Reply>) => complete(data);
    worker.onerror = () => complete({ error: "结构分析失败" });
    worker.postMessage({ format, left, right });
    return () => { clearTimeout(timeout); worker.terminate(); };
  }, [format, left, right]);

  if (!reply) return <div className="state" role="status">正在分析文件结构…</div>;
  if ("error" in reply) return <div className="state warning" role="status">
    <p>{reply.error}</p>
    <button type="button" onClick={() => onRaw()}>打开原始差异</button>
  </div>;

  const { changes, reorderedKeys, originalChanged } = reply.result;
  return <section className="structured-diff" aria-label="结构差异">
    <p role="status">{changes.length
      ? `${changes.length} 处结构变化`
      : originalChanged ? "结构内容相同，原文有排版、表示方式或键顺序变化。" : "结构与原文相同。"}</p>
    {reorderedKeys.length > 0 && <details>
      <summary>{reorderedKeys.length} 处对象键顺序变化</summary>
      <ul>{reorderedKeys.map(path => <li key={path}><code>{path}</code></li>)}</ul>
    </details>}
    {changes.length > 0 && <table><thead><tr><th scope="col">字段</th><th scope="col">原值</th><th scope="col">新值</th></tr></thead>
      <tbody>{changes.map(change => <tr key={change.path}>
        <th scope="row"><small>{labels[change.kind]}</small><code>{change.path}</code></th>
        {(["left", "right"] as const).map(side => <td key={side}>{change[side] ? <>
          <code>{change[side].label}</code>
          <button type="button" onClick={() => onRaw(side, change[side]!.line)} title="在原始差异中查看此行">
            {side === "left" ? "左侧" : "右侧"}第 {change[side].line} 行
          </button>
        </> : <span>缺失</span>}</td>)}
      </tr>)}</tbody>
    </table>}
  </section>;
}
