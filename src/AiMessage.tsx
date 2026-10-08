import { Fragment, useState, type ReactNode } from "react";
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="ai-code-block"><div><span>{language || "代码"}</span><button onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true), () => setCopied(false))}>{copied ? "已复制" : "复制代码"}</button></div><pre><code>{code}</code></pre></div>;
}
/** 基础 Markdown 使用文本节点渲染，不执行模型输出的 HTML。 */
export default function AiMessage({ text }: { text: string }) {
  return <div className="ai-message-content">{text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g).map((block, index) => {
    if (block.startsWith("```")) { const first = block.indexOf("\n"); return <CodeBlock key={index} language={block.slice(3, first)} code={block.slice(first + 1).replace(/```$/, "")}/>; }
    return block.split(/\n\s*\n/).filter(Boolean).map((paragraph, p) => {
      const lines = paragraph.split("\n");
      if (lines.every(line => /^[-*] /.test(line))) return <ul key={`${index}-${p}`}>{lines.map((line, i) => <li key={i}>{inline(line.slice(2))}</li>)}</ul>;
      if (lines.every(line => /^\d+\. /.test(line))) return <ol key={`${index}-${p}`}>{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\d+\. /, ""))}</li>)}</ol>;
      return <p key={`${index}-${p}`}>{lines.map((line, i) => <Fragment key={i}>{i > 0 && <br/>}{inline(line.replace(/^#{1,3} /, ""))}</Fragment>)}</p>;
    });
  })}</div>;
}
