import type { ReactNode } from "react";

/**
 * 单行路径文字：放得下时左对齐；放不下时保留末尾（文件名一侧），省略号在开头。
 *
 * 外层用 `dir="rtl"` 让溢出与省略号落在开头，`text-align:left` 保持放得下时左对齐；
 * 内层 `<bdi dir="ltr">` 隔离路径本身，开头 / 结尾的标点（如 `.gitignore`）不会被重排。
 * `prefix`（如“← ”）放在路径框外，路径被截断时也保留。
 */
export default function PathText({ path, className, title, prefix }: { path: string; className?: string; title?: string; prefix?: ReactNode }) {
  const text = <span className={prefix || !className ? "path-text" : `path-text ${className}`} dir="rtl" title={prefix ? undefined : title ?? path}><bdi dir="ltr">{path}</bdi></span>;
  if (!prefix) return text;
  return <span className={className ? `path-prefixed ${className}` : "path-prefixed"} title={title ?? path}><span className="path-prefix">{prefix}</span>{text}</span>;
}
