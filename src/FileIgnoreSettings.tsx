import { useState } from "react";
import { useSettings, type SettingsStore } from "./settings";
import { applyFileIgnoreOperation, type FileIgnoreOperation, type FileIgnoreRule } from "./file-ignore";

export default function FileIgnoreSettings({ settings, repoId, repoName, preview }: { settings: SettingsStore; repoId: string | null; repoName: string; preview?: { showIgnored: boolean; ignoredCount: number; onChange(value: boolean): void } }) {
  const rules = useSettings(settings, s => s.fileIgnore.rules);
  const [editing, setEditing] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<FileIgnoreRule["kind"]>("glob");
  const [global, setGlobal] = useState(!repoId);
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [error, setError] = useState("");
  const apply = (op: FileIgnoreOperation) => {
    try {
      const next = applyFileIgnoreOperation(settings.get().fileIgnore.rules, op, repoId);
      if (!settings.update("fileIgnore", "rules", next)) throw new Error("无法保存忽略规则，原设置已保留");
      setError(""); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
  };
  const reset = () => { setEditing(null); setPattern(""); };
  const save = () => {
    const existing = rules.find(r => r.id === editing);
    const rule: FileIgnoreRule = { id: editing ?? crypto.randomUUID(), repoId: global ? null : repoId, kind, pattern, caseSensitive, enabled: existing?.enabled ?? true };
    if (apply({ action: editing ? "update" : "add", rule })) reset();
  };
  return <div className="settings-page file-ignore-settings">
    <p className="settings-note">只隐藏 Oris 本地变更列表中的文件，保留真实 Git 状态。规则即时生效并保存，不修改 Git ignore 配置。</p>
    {preview && <div className="settings-row ignore-preview"><label><input type="checkbox" aria-label="临时显示被忽略文件" disabled={!repoId} checked={preview.showIgnored} onChange={event => preview.onChange(event.target.checked)}/>临时显示被忽略文件</label><small role="status">当前比较范围匹配 {preview.ignoredCount} 个文件，关闭后恢复隐藏。</small></div>}
    <div className="ignore-rule-form">
      <label>作用范围<select aria-label="忽略规则作用范围" disabled={!!editing} value={global ? "global" : "repository"} onChange={e => setGlobal(e.target.value === "global")}><option value="global">全局 · 所有仓库</option><option value="repository" disabled={!repoId}>当前仓库 · {repoName || "未打开"}</option></select></label>
      <label>匹配方式<select aria-label="忽略规则匹配方式" value={kind} onChange={e => setKind(e.target.value as FileIgnoreRule["kind"])}><option value="glob">glob 模式</option><option value="name">精确文件名 · 任意目录</option><option value="path">精确路径 · 相对仓库根目录</option></select></label>
      <label>规则<input aria-label="忽略规则模式" value={pattern} placeholder="**/.DS_Store" maxLength={256} onChange={e => setPattern(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); save(); } }}/></label>
      <label><input type="checkbox" aria-label="忽略规则区分大小写" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)}/>区分大小写</label>
      <div><button type="button" disabled={!pattern} onClick={save}>{editing ? "保存规则" : "添加规则"}</button>{editing && <button type="button" onClick={reset}>取消编辑</button>}</div>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <p className="settings-note">路径可用 / 或反斜杠。glob 中 * 匹配段内任意字符，? 匹配单个字符，** 匹配零层或多层目录；** 必须独占一段。无 / 的 *.log 匹配任意目录文件名；logs/** 相对仓库根目录；**/.DS_Store 包含根目录。不支持取反、字符组和花括号。默认区分大小写，可按规则关闭。</p>
    <ul className="ignore-rule-list" aria-label="全局与当前仓库忽略规则">{rules.filter(r => r.repoId === null || r.repoId === repoId).map(r => <li key={r.id}>
      <label><input type="checkbox" aria-label={`启用 ${r.pattern}`} checked={r.enabled} onChange={e => apply({ action: "setEnabled", id: r.id, repoId: r.repoId, enabled: e.target.checked })}/><code>{r.pattern}</code></label>
      <small>{r.repoId === null ? "全局" : "当前仓库"} · {r.kind === "path" ? "路径" : r.kind === "name" ? "文件名" : "glob"} · {r.caseSensitive ? "区分大小写" : "不区分大小写"}</small>
      <button type="button" aria-label={`编辑 ${r.pattern}`} onClick={() => { setEditing(r.id); setPattern(r.pattern); setKind(r.kind); setGlobal(r.repoId === null); setCaseSensitive(r.caseSensitive); setError(""); }}>编辑</button>
      <button type="button" aria-label={`删除 ${r.pattern}`} onClick={() => { if (apply({ action: "delete", id: r.id, repoId: r.repoId }) && editing === r.id) reset(); }}>删除</button>
    </li>)}</ul>
    {!rules.some(r => r.repoId === null || r.repoId === repoId) && <p className="settings-note">尚未配置规则。也可以用 AI 输入“当前项目忽略所有目录下的 .DS_Store”。</p>}
  </div>;
}
