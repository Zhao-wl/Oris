import { parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node as YamlNode } from "yaml";
import { STRUCTURED_MAX_BYTES } from "./budget";

export type StructuredFormat = "json" | "yaml";
type Scalar = "string" | "number" | "integer" | "float" | "boolean" | "null";
type Field = { line: number; type: Scalar; value: string; label: string }
  | { line: number; type: "object" | "array"; fields: Map<string, Field> };
type ChangeKind = "added" | "deleted" | "modified" | "typeChanged";
type LocatedValue = { line: number; label: string };
export interface FieldChange { kind: ChangeKind; path: string; left?: LocatedValue; right?: LocatedValue }
export interface StructuredResult { changes: FieldChange[]; reorderedKeys: string[]; originalChanged: boolean }

const maxDepth = 40;
const maxNodes = 20_000;
const maxChanges = 2_000;

export function compareStructured(format: StructuredFormat, left: string | null, right: string | null): StructuredResult {
  const encoder = new TextEncoder();
  if ([left, right].some(value => value !== null && encoder.encode(value).byteLength > STRUCTURED_MAX_BYTES)) {
    throw new Error("文件超过结构比较的 512 KiB 单侧预算");
  }
  const changes: FieldChange[] = [];
  const reorderedKeys: string[] = [];
  const before = left === null ? undefined : parse(format, left);
  const after = right === null ? undefined : parse(format, right);
  const childPath = (path: string, key: string, type: "array" | "object") => type === "array" ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
  function visit(path: string, a?: Field, b?: Field) {
    if (!a && !b) return;
    if (path.length > 4096) throw new Error("结构字段路径超过预算");
    if (a && b && "fields" in a && "fields" in b && a.type === b.type) {
      const leftKeys = [...a.fields.keys()];
      const rightKeys = [...b.fields.keys()];
      if (a.type === "object") {
        const leftCommon = leftKeys.filter(key => b.fields.has(key));
        const rightCommon = rightKeys.filter(key => a.fields.has(key));
        if (leftCommon.some((key, index) => key !== rightCommon[index])) {
          if (reorderedKeys.length >= maxChanges) throw new Error("键顺序变化条目超过预算");
          reorderedKeys.push(path);
        }
      }
      for (const key of new Set([...leftKeys, ...rightKeys])) {
        visit(childPath(path, key, a.type), a.fields.get(key), b.fields.get(key));
      }
      return;
    }
    if (a && b && "value" in a && "value" in b && a.type === b.type && a.value === b.value) return;
    if (changes.length >= maxChanges) throw new Error("结构变化条目超过预算");
    changes.push({ kind: !a ? "added" : !b ? "deleted" : a.type === b.type ? "modified" : "typeChanged", path, left: a && describe(a), right: b && describe(b) });
    const collection = a ?? b;
    if ((!a || !b) && collection && "fields" in collection) {
      for (const [key, field] of collection.fields) visit(childPath(path, key, collection.type), a && field, b && field);
    }
  }
  visit("$", before, after);
  return { changes, reorderedKeys, originalChanged: left !== right };
}

function describe(field: Field): LocatedValue {
  if ("label" in field) return { line: field.line, label: field.label.length > 240 ? `${field.label.slice(0, 237)}…` : field.label };
  return { line: field.line, label: `${field.type === "object" ? "对象" : "数组"} · ${field.fields.size} 项` };
}

/** Use decimal source values to distinguish literals that round to the same JS number. */
function decimal(source: string): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match || (!match[2] && !match[3])) throw new Error("有无法精确比较的数值");
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  if (exponent.length > 12) throw new Error("数值指数超过结构比较预算");
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  return `${sign === "-" ? "-" : ""}${significant}e${BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length)}`;
}

function parse(format: StructuredFormat, text: string): Field {
  let count = 0;
  const budget = (depth: number) => {
    if (++count > maxNodes || depth > maxDepth) throw new Error("结构节点数或嵌套深度超过预算");
  };
  const lineCounter = new LineCounter();
  if (format === "json") {
    lineCounter.addNewLine(0);
    for (const boundary of text.matchAll(/\r\n|\n|\r/g)) lineCounter.addNewLine(boundary.index + boundary[0].length);
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
    if (!root || errors.length) throw new Error("JSON 格式无效");
    function read(node: JsonNode, depth: number, lineAt = node.offset): Field {
      budget(depth);
      const line = lineCounter.linePos(lineAt).line;
      if (node.type === "object") {
        const fields = new Map<string, Field>();
        for (const entry of node.children ?? []) {
          const [key, value] = entry.children!;
          if (fields.has(key.value)) throw new Error(`发现重复字段 ${JSON.stringify(String(key.value).slice(0, 120))}`);
          fields.set(key.value, read(value, depth + 1, key.offset));
        }
        return { line, type: "object", fields };
      }
      if (node.type === "array") return { line, type: "array", fields: new Map((node.children ?? []).map((item, index) => [String(index), read(item, depth + 1)])) };
      const label = text.slice(node.offset, node.offset + node.length);
      if (node.type === "property") throw new Error("JSON 字段格式无效");
      return { line, type: node.type, value: node.type === "number" ? decimal(label) : String(node.value ?? "null"), label };
    }
    return read(root, 0);
  }

  const docs = parseAllDocuments(text, { lineCounter, strict: true, uniqueKeys: true, intAsBigInt: true, schema: "core" });
  if (docs.length !== 1 || docs[0].errors.length || docs[0].warnings.length || docs[0].directives?.yaml.version === "1.1" || !docs[0].contents) {
    throw new Error("YAML 格式无效、包含多文档或使用了无法比较的内容");
  }
  function read(node: YamlNode, depth: number, lineAt = node.range?.[0] ?? 0): Field {
    budget(depth);
    if (isAlias(node) || node.anchor || node.tag) throw new Error("YAML 锚点、别名或显式标签需要使用原始文本比较");
    const line = lineCounter.linePos(lineAt).line;
    if (isMap(node)) {
      const fields = new Map<string, Field>();
      for (const item of node.items) {
        const key = item.key;
        if (!isScalar(key) || typeof key.value !== "string" || key.anchor || key.tag || key.value === "<<") throw new Error("YAML 包含不支持的键类型、锚点或合并键");
        if (fields.has(key.value)) throw new Error(`发现重复字段 ${JSON.stringify(key.value.slice(0, 120))}`);
        const offset = key.range?.[0] ?? lineAt;
        fields.set(key.value, item.value === null ? { line: lineCounter.linePos(offset).line, type: "null", value: "null", label: "null" } : read(item.value as YamlNode, depth + 1, offset));
      }
      return { line, type: "object", fields };
    }
    if (isSeq(node)) return { line, type: "array", fields: new Map(node.items.map((item, index) => [String(index), item === null
      ? { line, type: "null", value: "null", label: "null" } : read(item as YamlNode, depth + 1)])) };
    if (!isScalar(node)) throw new Error("不支持的 YAML 结构节点");
    const value = node.value;
    const label = value === null ? "null" : node.source ?? String(value);
    if (typeof value === "bigint") return { line, type: "integer", value: decimal(value.toString()), label };
    if (typeof value === "number") return { line, type: "float", value: /^[+-]?\./.test(label) && !/[0-9]/.test(label) ? String(value) : decimal(label), label };
    const type = value === null ? "null" : typeof value === "boolean" ? "boolean" : "string";
    return { line, type, value: String(value), label };
  }
  return read(docs[0].contents, 0);
}
