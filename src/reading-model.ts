// 阅读模型的文件级说明（任务 05）：编码 / BOM / 换行 / 末尾换行 / mode 的状态与变化，
// 以及二进制、编码不支持、超预算、LFS、子模块、符号链接等不能按文本比较的内容的明确说明。
// 目标：任何“看起来没有差异”的情况都说明原因，不能因为解码失败或规范化显示成无变化（R-DIFF / A11 / A12）。
import type { ContentPair, DiffDocument, SideKind, TextSide } from "./types";

const encodingLabels: Record<TextSide["encoding"], string> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "binary-or-unsupported": "非文本",
  missing: "缺失"
};
const eolLabels: Record<TextSide["eol"], string> = { lf: "LF", crlf: "CRLF", mixed: "混合换行", none: "无换行" };

export const sideKind = (side: TextSide): SideKind => side.kind ?? (side.encoding === "missing" ? "missing" : side.text === null ? "unavailable" : "text");

/** 端点标题中的简短状态：UTF-8 · BOM · CRLF · 无末尾换行。 */
export function sideLabel(side: TextSide): string {
  const kind = sideKind(side);
  if (kind === "missing") return "不存在";
  if (kind === "gitlink") return "子模块";
  if (kind === "symlink") return "符号链接";
  if (kind === "image") return "图片";
  if (kind === "binary") return `二进制 · ${formatBytes(side.byteLength)}`;
  if (kind === "unsupportedEncoding") return `编码不支持 · ${formatBytes(side.byteLength)}`;
  if (kind === "unavailable" && side.text === null) return "不可读";
  const parts = [encodingLabels[side.encoding] ?? side.encoding];
  if (side.bom) parts.push("BOM");
  parts.push(eolLabels[side.eol] ?? side.eol);
  if (side.hasFinalNewline === false) parts.push("无末尾换行");
  if (kind === "tooLarge") parts.push("超出显示预算");
  if (kind === "lfsPointer") parts.push("LFS 指针");
  return parts.join(" · ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const modeLabel = (mode: string | null | undefined) => mode === "100755" ? "100755（可执行）" : mode === "100644" ? "100644" : mode ?? "—";

/** 两侧都存在时，文本之外的元信息变化（编码、BOM、换行符、末尾换行、文件模式）。 */
export function metaChanges(left: TextSide, right: TextSide): string[] {
  if (sideKind(left) === "missing" || sideKind(right) === "missing") return [];
  const changes: string[] = [];
  const bothText = left.text !== null && right.text !== null;
  if (bothText && left.encoding !== right.encoding) changes.push(`编码：${encodingLabels[left.encoding]} → ${encodingLabels[right.encoding]}`);
  if (bothText && !!left.bom !== !!right.bom) changes.push(right.bom ? "新增 BOM" : "移除 BOM");
  if (bothText && left.eol !== right.eol) changes.push(`换行符：${eolLabels[left.eol]} → ${eolLabels[right.eol]}`);
  if (bothText && left.hasFinalNewline !== null && right.hasFinalNewline !== null && left.hasFinalNewline !== right.hasFinalNewline && left.byteLength > 0 && right.byteLength > 0) {
    changes.push(right.hasFinalNewline ? "新增末尾换行" : "移除末尾换行（新版本无末尾换行）");
  }
  const leftMode = left.details?.mode, rightMode = right.details?.mode;
  if (leftMode && rightMode && leftMode !== rightMode) changes.push(`文件模式：${modeLabel(leftMode)} → ${modeLabel(rightMode)}`);
  return changes;
}

/**
 * 两侧文本在当前阅读规则下没有差异块，但内容标识不同：说明原因（换行、BOM、编码、mode 或空白规则）。
 * 返回 null 表示确实相同或还不能判断。
 */
export function noVisibleDifferenceReason(pair: ContentPair, document: DiffDocument | null): string | null {
  if (!document || document.hunks.length > 0) return null;
  if (pair.left.text === null || pair.right.text === null) return null;
  const meta = metaChanges(pair.left, pair.right);
  const sameBytes = pair.left.contentId === pair.right.contentId;
  if (sameBytes && !meta.length) return null;
  if (meta.length) return `文本内容相同，只有${meta.join("、")}。`;
  if (document.whitespace === "ignore") return "忽略空白后没有差异：两侧只有行内空白（空格、制表符）不同。";
  // editorText 把 CR 归一为 LF：行内 CR 的增删在阅读器中不可见。
  return "按当前阅读规则显示的文本相同，但两侧字节不同（例如个别行的换行符不同）。";
}

export interface SpecialDescription {
  kind: "binary" | "unsupportedEncoding" | "tooLarge" | "gitlink" | "symlink" | "unavailable";
  title: string;
  lines: string[];
}

const short = (oid: string | null | undefined) => oid ? oid.slice(0, 12) : "—";

/**
 * 不能按文本比较的文件：返回说明（标题 + 每侧的事实）。可以按文本阅读（包括 LFS 指针）时返回 null。
 * 一侧不存在（新增 / 删除）时只描述存在的一侧。
 */
export function describeSpecial(pair: ContentPair, labels: [string, string]): SpecialDescription | null {
  const sides: [TextSide, TextSide] = [pair.left, pair.right];
  const kinds = sides.map(sideKind);
  const present = kinds.map((kind) => kind !== "missing");
  const pick = (...wanted: SpecialDescription["kind"][]) => kinds.find((kind): kind is SpecialDescription["kind"] => (wanted as string[]).includes(kind));
  const kind = pick("gitlink", "symlink", "binary", "unsupportedEncoding", "tooLarge")
    ?? (kinds.some((k) => k === "unavailable") && sides.some((side, i) => present[i] && side.text === null && !side.details?.image) ? "unavailable" : undefined);
  if (!kind) return null;
  const changed = pair.left.contentId !== pair.right.contentId;
  const each = (render: (side: TextSide) => string) => sides.flatMap((side, i) => present[i] ? [`${labels[i]}：${render(side)}`] : [`${labels[i]}：不存在`]);
  if (kind === "gitlink") {
    const lines = each((side) => {
      const info = side.details?.submodule;
      if (sideKind(side) !== "gitlink") return side.details?.reason ?? sideLabel(side);
      if (info?.initialized === false) return "子模块未初始化（Oris 不会初始化或更新子模块）";
      const flags = [info?.trackedChanges && "有已跟踪文件的修改", info?.untrackedChanges && "有未跟踪文件"].filter(Boolean);
      return `提交 ${short(info?.commit)}${flags.length ? `（子模块工作区${flags.join("、")}）` : ""}`;
    });
    const commits = sides.map((side) => side.details?.submodule?.commit ?? null);
    const verdict = present.every(Boolean) ? (commits[0] && commits[1] && commits[0] !== commits[1] ? "子模块指向的提交已改变" : commits[0] === commits[1] && commits[0] ? "子模块指向的提交相同" : "无法比较子模块提交") : present[0] ? "删除子模块条目" : "新增子模块条目";
    return { kind, title: `子模块（gitlink）· ${verdict}`, lines: [...lines, "只显示提交指针，不读取子模块内的文件；需要查看时请在子模块中打开"] };
  }
  if (kind === "symlink") {
    const lines = each((side) => sideKind(side) === "symlink" ? `→ ${side.details?.linkTarget ?? "（目标不可读）"}` : sideLabel(side));
    return { kind, title: `符号链接 · ${changed ? "目标已改变" : "目标相同"}`, lines: [...lines, "Oris 不跟随符号链接读取目标内容"] };
  }
  const reason = pair.degradation ?? sides.map((side) => side.details?.reason).find(Boolean) ?? "";
  const sizes = each((side) => `${sideLabel(side)}`);
  const verdict = present.every(Boolean) ? (changed ? "内容不同" : "内容相同") : present[0] ? "文件被删除" : "新增文件";
  if (kind === "binary") return { kind, title: `二进制文件 · ${verdict}`, lines: [...sizes, "不提供十六进制或专用格式比较；只比较大小与内容标识"] };
  if (kind === "unsupportedEncoding") return { kind, title: `编码不受支持 · ${verdict}`, lines: [...sizes, reason] };
  if (kind === "tooLarge") return { kind, title: `超出显示预算 · ${verdict}`, lines: [...sizes, reason, "已显示范围：无（未加载全文）。可以继续切换其他文件"] };
  return { kind, title: "无法读取内容", lines: [...sizes, reason] };
}

/** LFS 指针的说明（指针文本本身仍按文本阅读）。 */
export function lfsNotice(pair: ContentPair): string | null {
  const sides = [pair.left, pair.right].filter((side) => sideKind(side) === "lfsPointer");
  if (!sides.length) return null;
  const facts = sides.map((side) => {
    const d = side.details;
    return `sha256 ${short(d?.lfsOid)} · ${d?.lfsSize !== undefined ? formatBytes(d.lfsSize) : "大小未知"} · ${d?.lfsLocal ? "本地缓存中有对象" : "本地缓存中没有对象"}`;
  });
  return `Git LFS 指针：显示的是指针文本，不是文件内容；Oris 不会自动下载 LFS 对象。${facts.join("；")}`;
}

export const isSvgPath = (path: string) => /\.svg$/i.test(path);

/** 平台快捷键文字：macOS 用 ⌘ / ⌥ / ⇧，其他平台用 Ctrl / Alt / Shift。 */
export const isMacPlatform = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
export function shortcut(keys: string, mac = isMacPlatform()): string {
  if (!mac) return keys;
  return keys.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧");
}
