import { useState } from "react";
import { useSettings, type SettingsStore } from "./settings";
import { AI_CONTEXTS, RECOMMENDED_AI_COMMANDS, exportAiRules, importAiRules, parseAiRuleBundle, resolveAiRoute, validCommandTag,
  type AiCommand, type AiRuleBundle, type AiRuleSet, type ImportConflict } from "./ai-rules";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

const freshId = () => crypto.randomUUID();
function BindingSelect({ value, onChange, settings, label, inheritLabel = "跟随默认配置" }: {
  value: string | null; onChange(value: string | null): void; settings: SettingsStore; label: string; inheritLabel?: string;
}) {
  const profiles = useSettings(settings, v => v.ai.profiles);
  return <select aria-label={label} value={value === null ? "__inherit" : value} onChange={e => onChange(e.target.value === "__inherit" ? null : e.target.value)}>
    <option value="__inherit">{inheritLabel}</option><option value="">待绑定 · 禁止执行</option>
    {value && !profiles.some(p => p.id === value) && <option value={value}>配置已删除 · 禁止执行</option>}
    {profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model || "未选择模型"}{p.kind === "api" && !p.hasKey ? "（缺少密钥）" : ""}</option>)}
  </select>;
}
export function AiCommandsPage({ settings, onRoutes, initialCommandId }: { settings: SettingsStore; onRoutes(): void; initialCommandId?: string }) {
  const rules = useSettings(settings, v => v.ai.ruleSet);
  const [selected, setSelected] = useState(initialCommandId ?? rules.commands[0]?.id ?? "");
  const [draft, setDraft] = useState<AiCommand | null>(null);
  const [error, setError] = useState("");
  const [recommendOpen, setRecommendOpen] = useState(false);
  const current = rules.commands.find(c => c.id === selected) ?? rules.commands[0];
  const edited = draft ?? current;
  const change = (patch: Partial<AiCommand>) => edited && setDraft({ ...edited, ...patch });
  const update = (next: AiRuleSet) => { if (!settings.update("ai", "ruleSet", next)) { setError("保存失败，请检查标识、重复名称和字段范围"); return false; } setError(""); return true; };
  const select = (c: AiCommand) => { setSelected(c.id); setDraft(null); setError(""); };
  const create = (source?: AiCommand) => {
    const c: AiCommand = source ? { ...structuredClone(source), id: freshId() } : { id: freshId(), tag: "新指令", name: "新指令", description: "", prompt: "", mode: "answer", contexts: ["diff"], enabled: true };
    const base = c.tag; let n = 2; while (rules.commands.some(x => x.tag.toLowerCase() === c.tag.toLowerCase())) c.tag = `${base.slice(0, 32)}_${n++}`;
    if (update({ ...rules, commands: [...rules.commands, c], routes: [...rules.routes, { id: freshId(), commandId: c.id, profileId: null, enabled: true }] })) select(c);
  };
  const route = edited && rules.routes.find(r => r.commandId === edited.id);
  return <div className="settings-page ai-rules-page">
    <div className="ai-page-head"><p className="settings-note">定义任务、提示词和上下文；模型由路由规则选择。编辑后点击保存。</p><div className="ai-page-actions"><button onClick={() => setRecommendOpen(v => !v)}>添加推荐</button><button className="primary" onClick={() => create()} disabled={rules.commands.length >= 100}>＋ 新建指令</button></div></div>
    {recommendOpen && <section className="ai-recommend-list" aria-label="推荐指令">{RECOMMENDED_AI_COMMANDS.map(c => <button key={c.id} disabled={rules.commands.some(x => x.tag.toLowerCase() === c.tag.toLowerCase())} onClick={() => create(c)}>添加 @{c.tag}</button>)}</section>}
    <div className="ai-command-layout"><div className="ai-command-list" aria-label="AI 指令列表">{rules.commands.map(c => <button key={c.id} aria-pressed={c.id === edited?.id} onClick={() => select(c)}><strong>@{c.tag}</strong><small>{c.enabled ? c.description || c.name : "已停用"}</small></button>)}</div>
      {edited ? <div className="ai-command-editor"><div className="ai-rule-two"><label>指令标识<input aria-label="指令标识" value={edited.tag} maxLength={40} onChange={e => change({ tag: e.target.value })}/></label><label>显示名称<input aria-label="指令显示名称" value={edited.name} maxLength={100} onChange={e => change({ name: e.target.value })}/></label></div>
        <label>菜单说明<input aria-label="指令菜单说明" value={edited.description} maxLength={200} onChange={e => change({ description: e.target.value })}/></label>
        <label>工作模式<select aria-label="指令工作模式" value={edited.mode} onChange={e => change({ mode: e.target.value as AiCommand["mode"] })}><option value="answer">仅回答 · 不执行应用操作</option><option value="action">允许应用操作 · 遵循应用校验</option></select></label>
        <fieldset><legend>携带上下文</legend><div className="ai-context-checks">{Object.entries(AI_CONTEXTS).map(([key, label]) => <label key={key}><input type="checkbox" checked={edited.contexts.includes(key as keyof typeof AI_CONTEXTS)} onChange={e => change({ contexts: e.target.checked ? [...edited.contexts, key as keyof typeof AI_CONTEXTS] : edited.contexts.filter(x => x !== key) })}/>{label}</label>)}</div></fieldset>
        <label>提示词正文<textarea aria-label="指令提示词" rows={6} maxLength={10000} value={edited.prompt} onChange={e => change({ prompt: e.target.value })}/></label>
        <div className="ai-route-reference"><span>关联路由：{route ? route.enabled ? route.profileId === null ? "跟随默认配置" : settings.get().ai.profiles.find(p => p.id === route.profileId)?.name ?? "待绑定" : "已停用" : "未配置"}</span><button onClick={onRoutes}>编辑路由 ↗</button></div>
        <div className="ai-rule-footer"><div className="ai-page-actions"><label><input type="checkbox" checked={edited.enabled} onChange={e => change({ enabled: e.target.checked })}/>启用</label><button onClick={() => create(edited)}>复制</button><button onClick={() => { if (update({ ...rules, commands: rules.commands.filter(c => c.id !== edited.id), routes: rules.routes.filter(r => r.commandId !== edited.id) })) { setDraft(null); setSelected(""); } }}>删除</button></div>
          <div className="ai-page-actions"><button disabled={!RECOMMENDED_AI_COMMANDS.some(c => c.tag === edited.tag)} onClick={() => { const c = RECOMMENDED_AI_COMMANDS.find(c => c.tag === edited.tag); if (c) setDraft({ ...structuredClone(c), id: edited.id }); }}>恢复推荐</button><button className="primary" onClick={() => {
            if (!validCommandTag(edited.tag) || rules.commands.some(c => c.id !== edited.id && c.tag.toLowerCase() === edited.tag.toLowerCase())) { setError("指令标识须为 1–40 个字母、数字、下划线或连字符，且不能重复"); return; }
            if (update({ ...rules, commands: rules.commands.map(c => c.id === edited.id ? edited : c) })) setDraft(null);
          }}>保存</button></div></div>
      </div> : <p className="settings-note">暂无指令，请新建或添加推荐指令。</p>}
    </div>{error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}
export function AiRoutesPage({ settings, onCommands }: { settings: SettingsStore; onCommands(id: string): void }) {
  const ai = useSettings(settings, v => v.ai), rules = ai.ruleSet;
  const [preview, setPreview] = useState("@审查 检查当前文件的边界条件");
  const [result, setResult] = useState<string | null>(null), [error, setError] = useState("");
  const [bundle, setBundle] = useState<AiRuleBundle | null>(null), [mappings, setMappings] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"merge" | "replace">("merge"), [conflict, setConflict] = useState<ImportConflict>("keep");
  const [exportOpen, setExportOpen] = useState(false), [exportName, setExportName] = useState("我的 AI 规则");
  const [exportSelection, setExportSelection] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const update = (next: AiRuleSet) => { setResult(null); if (!settings.update("ai", "ruleSet", next)) setError("规则无效，原设置未修改"); else setError(""); };
  const load = (text: string) => { try { setBundle(parseAiRuleBundle(text)); setMappings({}); setError(""); setExportOpen(false); } catch (e) { setError(String(e)); } };
  const importFile = async () => { setBusy(true); setError(""); try {
    const path = await open({ multiple: false, filters: [{ name: "AI 规则", extensions: ["json"] }] });
    if (typeof path === "string") load(await invoke<string>("read_ai_rules_file", { path }));
  } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const exportFile = async () => { setBusy(true); setError(""); try {
    const selected = new Set(exportSelection);
    const subset = { ...rules, commands: rules.commands.filter(c => selected.has(c.id)), routes: rules.routes.filter(r => selected.has(r.commandId)) };
    const content = JSON.stringify(exportAiRules(subset, ai.profiles, exportName), null, 2);
    const path = await save({ defaultPath: "oris-ai-rules.json", filters: [{ name: "AI 规则", extensions: ["json"] }] });
    if (path) { await invoke("write_ai_rules_file", { path, content }); setResult("规则集已导出，不包含密钥、登录信息和本机路径。"); setExportOpen(false); }
  } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <div className="settings-page ai-rules-page"><div className="ai-page-head"><p className="settings-note">按指令匹配完整 AI 配置；规则停用或目标失效时停止，不自动换模型。</p><div className="ai-page-actions"><button disabled={busy} onClick={() => void importFile()}>导入</button><button onClick={() => { setExportOpen(v => !v); setExportSelection(rules.commands.map(c => c.id)); setBundle(null); }}>导出</button></div></div>
    <div className="ai-route-default"><label>默认路由<BindingSelect settings={settings} label="默认路由" value={rules.defaultProfileId} inheritLabel="跟随当前 AI 配置" onChange={defaultProfileId => update({ ...rules, defaultProfileId })}/></label><label>生成已暂存提交信息<BindingSelect settings={settings} label="提交信息生成路由" value={rules.stagedMessageProfileId} onChange={stagedMessageProfileId => update({ ...rules, stagedMessageProfileId })}/></label></div>
    <div className="ai-routes-table-wrap"><table className="ai-routes-table"><thead><tr><th>启用</th><th>匹配指令／规则</th><th>AI 配置与模型</th><th>操作</th></tr></thead><tbody>{rules.commands.map(c => {
      const r = rules.routes.find(r => r.commandId === c.id);
      const patch = (p: Partial<NonNullable<typeof r>>) => update({ ...rules, routes: r ? rules.routes.map(x => x.id === r.id ? { ...r, ...p } : x) : [...rules.routes, { id: freshId(), commandId: c.id, profileId: null, enabled: true, ...p }] });
      const bound = r?.profileId ?? rules.defaultProfileId ?? ai.activeId;
      const profile = ai.profiles.find(p => p.id === bound);
      const ready = profile?.model.trim() && (profile.kind === "cli" || profile.hasKey);
      return <tr key={c.id}><td><input type="checkbox" aria-label={`启用 @${c.tag} 路由`} checked={!!r?.enabled} onChange={e => patch({ enabled: e.target.checked })}/></td><td><strong>@{c.tag}</strong><small>{c.name}规则</small>{!c.enabled && <small>指令已停用</small>}</td><td><BindingSelect settings={settings} value={r?.profileId ?? null} label={`@${c.tag} 路由模型`} onChange={profileId => patch({ profileId })}/>{!ready && <small className="settings-warning">待配置 · 禁止执行</small>}</td><td><button onClick={() => onCommands(c.id)}>指令 ↗</button></td></tr>;
    })}</tbody></table></div>
    <section className="ai-route-preview"><h4>路由预览</h4><div className="ai-page-actions"><input aria-label="路由预览输入" value={preview} onChange={e => { setPreview(e.target.value); setResult(null); }}/><button onClick={() => { try { const r = resolveAiRoute(ai, preview); setResult(`${r.commandTag ? `@${r.commandTag}` : "无显式指令"} → ${r.ruleName} → ${r.profile.name} · ${r.profile.model} → ${r.mode === "answer" ? "仅回答" : "允许应用操作"}`); setError(""); } catch (e) { setError(String(e)); setResult(null); } }}>匹配</button></div><p className="settings-note">只解析规则，不调用 AI。</p></section>
    {bundle && <section className="ai-rule-transfer" aria-label="导入预览"><h4>导入预览 · {bundle.name}</h4><p>{bundle.commands.length} 条指令，{bundle.routes.length} 条路由；{bundle.commands.filter(c => rules.commands.some(x => x.tag.toLowerCase() === c.tag.toLowerCase())).length} 条同名指令。</p>
      {bundle.targets.map(t => <label key={t.id}>目标「{t.name}」{t.model && <small>模型提示：{t.provider} · {t.model}</small>}<select aria-label={`导入目标 ${t.name}`} value={mappings[t.id] ?? ""} onChange={e => setMappings(v => ({ ...v, [t.id]: e.target.value }))}><option value="">待绑定 · 禁止执行</option>{ai.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>)}
      <div className="ai-rule-two"><label>导入方式<select aria-label="导入方式" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="merge">合并到当前规则集</option><option value="replace">替换整个规则集</option></select></label>{mode === "merge" && <label>同名指令<select aria-label="同名指令处理" value={conflict} onChange={e => setConflict(e.target.value as ImportConflict)}><option value="keep">保留现有项</option><option value="replace">替换现有项</option><option value="rename">重命名导入项</option></select></label>}</div>
      <p className="settings-note">{mode === "replace" ? "替换会移除当前规则集，使用本文件的指令、路由及默认目标。" : "合并保留当前默认路由。"}未绑定的目标可保存为待配置，使用时会被阻止。</p>
      <div className="ai-page-actions"><button className="primary" onClick={() => { try { const next = importAiRules(rules, bundle, mappings, mode, conflict); if (!settings.update("ai", "ruleSet", next)) throw new Error("规则无效，原设置未修改"); setBundle(null); setError(""); setResult("规则集已导入。"); } catch (e) { setError(String(e)); } }}>{mode === "replace" ? "替换规则集" : "合并规则"}</button><button onClick={() => setBundle(null)}>取消</button></div>
    </section>}
    {exportOpen && <section className="ai-rule-transfer" aria-label="导出规则集"><h4>导出规则集</h4><label>名称<input aria-label="规则集名称" value={exportName} maxLength={100} onChange={e => setExportName(e.target.value)}/></label><div className="ai-context-checks"><button onClick={() => setExportSelection(rules.commands.map(c => c.id))}>全选</button><button onClick={() => setExportSelection([])}>清空选择</button>{rules.commands.map(c => <label key={c.id}><input type="checkbox" checked={exportSelection.includes(c.id)} onChange={e => setExportSelection(v => e.target.checked ? [...v, c.id] : v.filter(x => x !== c.id))}/>@{c.tag}</label>)}</div><p className="settings-note">包含所选指令、关联路由、默认路由和目标提示；不包含凭据、本机路径或对话记录。</p><div className="ai-page-actions"><button className="primary" disabled={busy} onClick={() => void exportFile()}>保存 JSON 文件</button><button onClick={() => setExportOpen(false)}>取消</button></div></section>}
    {result && <p className="settings-ok" role="status">{result}</p>}{error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}
