import type { SpecialDescription } from "./reading-model";

/** 不能按文本比较的文件（二进制、编码不支持、超预算、子模块、符号链接）的明确说明（任务 05）。 */
export default function SpecialFileView({ description, compact = false }: { description: SpecialDescription; compact?: boolean }) {
  return <section className={`special-file ${description.kind}${compact ? " compact" : ""}`} role="status" aria-label={description.title}>
    <strong>{description.title}</strong>
    <ul>{description.lines.filter(Boolean).map((line, index) => <li key={index}>{line}</li>)}</ul>
  </section>;
}
