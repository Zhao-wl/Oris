import { useEffect, useRef, useState } from "react";
import { validateGit, type GitValidation } from "./api";
import { DEFAULT_AI_PROMPTS, DEFAULT_SCHEMES, FONT_SIZE_MAX, FONT_SIZE_MIN, useSettings, type SettingsStore } from "./settings";
import { schemeIndex, type SchemeIndexEntry } from "./themes/runtime";
import notices from "./themes/generated/NOTICES.txt?raw";
import { detectAiTools, listAiModels, setAiKey, testAiConnection, type ToolCandidate } from "./ai-api";
import type { AiProfile } from "./settings";
import { displayAiShortcut, isMacPlatform } from "./ai-shortcut";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "./store";
import { updater } from "./update-model";
import { AiCommandsPage, AiRoutesPage } from "./AiRulesSettings";
import FileIgnoreSettings from "./FileIgnoreSettings";

interface Props {
  settings: SettingsStore;
  onClose(): void;
  /** 当前项目实际使用的 Git（来自最近一次快照）。 */
  gitInUse: { executable: string; version: string; minimumVersion: string } | null;
  repoId?: string | null;
  repoName?: string;
  initialCategory?: string;
  ignorePreview?: { showIgnored: boolean; ignoredCount: number; onChange(value: boolean): void };
}

function SchemeList({ title, entries, value, onChange }: { title: string; entries: SchemeIndexEntry[]; value: string; onChange(id: string): void }) {
  return <section className="scheme-column" aria-label={title}>
    <h4>{title}</h4>
    <div className="scheme-list" role="listbox" aria-label={title}>
      {entries.map((entry) => <button key={entry.id} role="option" aria-selected={entry.id === value} className={entry.id === value ? "scheme-item selected" : "scheme-item"} onClick={() => onChange(entry.id)}>
        <span className="scheme-swatches" aria-hidden="true">{entry.preview.slice(0, 6).map((color, index) => <i key={index} style={{ background: color }} />)}</span>
        <span className="scheme-name">{entry.name}</span>
        {(entry.type === "hcDark" || entry.type === "hcLight") && <span className="scheme-tag">高对比</span>}
        {(entry.id === DEFAULT_SCHEMES.lightScheme || entry.id === DEFAULT_SCHEMES.darkScheme) && <span className="scheme-tag">默认</span>}
      </button>)}
    </div>
  </section>;
}

function AppearancePage({ settings }: { settings: SettingsStore }) {
  const appearance = useSettings(settings, (s) => s.appearance);
  const light = schemeIndex.filter((s) => s.type === "light" || s.type === "hcLight");
  const dark = schemeIndex.filter((s) => s.type === "dark" || s.type === "hcDark");
  const set = <K extends keyof typeof appearance>(key: K, value: (typeof appearance)[K]) => settings.update("appearance", key, value as never);
  return <div className="settings-page">
    <div className="settings-row">
      <label>主题模式</label>
      <div className="segmented" role="radiogroup" aria-label="主题模式">
        {([["light", "浅色"], ["dark", "深色"], ["system", "跟随系统"]] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={appearance.themeMode === value} className={appearance.themeMode === value ? "active" : ""} onClick={() => set("themeMode", value)}>{label}</button>)}
      </div>
    </div>
    <div className="settings-row column">
      <div className="settings-row-head">
        <label>配色方案</label>
        <button onClick={() => { set("lightScheme", DEFAULT_SCHEMES.lightScheme); set("darkScheme", DEFAULT_SCHEMES.darkScheme); }}>恢复默认配色</button>
      </div>
      <div className="scheme-columns">
        <SchemeList title="浅色方案" entries={light} value={appearance.lightScheme} onChange={(id) => set("lightScheme", id)} />
        <SchemeList title="深色方案" entries={dark} value={appearance.darkScheme} onChange={(id) => set("darkScheme", id)} />
      </div>
    </div>
    <div className="settings-row">
      <label htmlFor="settings-font-size">Diff 字号</label>
      <input id="settings-font-size" type="range" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} value={appearance.fontSize} onChange={(event) => set("fontSize", Number(event.target.value))} />
      <output>{appearance.fontSize}</output>
      <small>Ctrl/Cmd + = / - / 0</small>
    </div>
    <p className="settings-note">diff 颜色：蓝为修改、绿为新增、灰为删除，色值随配色方案变化。修改即时生效并自动保存。</p>
    <details className="settings-notices">
      <summary>配色方案的第三方许可（VS Code、Colorsublime，MIT）</summary>
      <pre>{notices}</pre>
    </details>
  </div>;
}

function GitPage({ settings, gitInUse }: { settings: SettingsStore; gitInUse: Props["gitInUse"] }) {
  const executable = useSettings(settings, (s) => s.git.executable);
  const [draft, setDraft] = useState(executable);
  const [result, setResult] = useState<GitValidation | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => setDraft(executable), [executable]);
  const commit = async () => {
    const value = draft.trim();
    if (value === executable) return;
    setChecking(true);
    try {
      const validation = await validateGit(value || null);
      setResult(validation);
      // 校验失败时保留原来的有效设置（R-SETTINGS）。
      if (validation.ok) settings.update("git", "executable", value);
    } catch (error) {
      setResult({ ok: false, executable: value, version: null, minimumVersion: "2.31.0", error: String(error) });
    } finally { setChecking(false); }
  };
  return <div className="settings-page">
    <div className="settings-row">
      <label htmlFor="settings-git">Git 可执行文件</label>
      <input id="settings-git" value={draft} placeholder="留空时自动发现" onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={(event) => { if (event.key === "Enter") void commit(); }} />
    </div>
    <dl className="git-facts">
      <dt>当前设置</dt><dd>{executable || "（自动发现）"}</dd>
      <dt>实际使用</dt><dd>{gitInUse ? `${gitInUse.executable} · ${gitInUse.version}` : "尚未打开项目"}</dd>
      <dt>最低要求</dt><dd>{gitInUse?.minimumVersion ?? "2.31.0"}</dd>
    </dl>
    {checking && <p className="settings-note">正在校验…</p>}
    {result && (result.ok
      ? <p className="settings-ok">已校验：{result.executable} · Git {result.version}，新打开或重新载入的项目使用该路径。</p>
      : <p className="settings-error">未采用：{result.error}。继续使用原来的有效设置。</p>)}
    {settings.migratedGitExecutable && <p className="settings-note">已从旧的路径栏设置迁移：{settings.migratedGitExecutable}</p>}
    <p className="settings-note">原路径栏的“Git 设置”已移到这里，改为全局设置（V2-D24）。</p>
  </div>;
}

function AiPage({ settings }: { settings: SettingsStore }) {
  const ai = useSettings(settings, (value) => value.ai);
  const [detected, setDetected] = useState<ToolCandidate[]>([]);
  const [detectedOnce, setDetectedOnce] = useState(false);
  const [modelsById, setModelsById] = useState<Record<string, string[]>>({});
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [testingId, setTestingId] = useState("");
  const [connections, setConnections] = useState<Record<string, { profile: string; ok: boolean; message: string }>>({});
  const [editingId, setEditingId] = useState(() => ai.activeId || ai.profiles[0]?.id || "");
  const selected = ai.profiles.find((profile) => profile.id === editingId) ?? ai.profiles[0];
  const unusedDrafts = ai.profiles.filter((profile) => !profile.model.trim() && !profile.hasKey && !profile.executable.trim() && !profile.baseUrl.trim());
  const providerLabel = (profile: AiProfile) => ({ codex: "Codex", claude: "Claude Code", openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", compatible: "兼容 API" })[profile.provider];
  const newProfile = (kind: AiProfile["kind"], provider: AiProfile["provider"], executable = "") => {
    const existing = ai.profiles.find((profile) => profile.kind === kind && profile.provider === provider && (executable
      ? profile.executable === executable
      : !profile.model.trim() && !profile.executable.trim() && !profile.baseUrl.trim() && !profile.hasKey));
    if (existing) { setEditingId(existing.id); setKeyDraft(""); return; }
    const profile: AiProfile = { id: crypto.randomUUID().replaceAll("-", ""), name: provider === "codex" ? "Codex" : provider === "claude" ? "Claude Code" : provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : provider === "deepseek" ? "DeepSeek" : "兼容接口", kind, provider, executable, baseUrl: "", model: "", hasKey: false };
    settings.update("ai", "profiles", [...ai.profiles, profile]);
    setEditingId(profile.id);
    setModelsById((current) => ({ ...current, [profile.id]: kind === "cli" ? detected.find((tool) => tool.provider === provider)?.models ?? [] : [] }));
    setError(""); setKeyDraft("");
  };
  const change = (patch: Partial<AiProfile>) => {
    if (!selected) return;
    settings.update("ai", "profiles", ai.profiles.map((profile) => profile.id === selected.id ? { ...profile, ...patch } : profile));
  };
  const check = async () => {
    setBusy(true); setError(""); setWarning("");
    try { const tools = await detectAiTools(); setDetected(tools); setDetectedOnce(true); setWarning(tools.flatMap((tool) => tool.warning ? [tool.warning] : []).join("\n")); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const fetchModels = async (profile: AiProfile) => {
    setBusy(true); setError(""); setWarning("");
    try { setModelsById((current) => ({ ...current, [profile.id]: [] })); const found = await listAiModels(profile); setModelsById((current) => ({ ...current, [profile.id]: found.models })); setWarning(found.warning ?? ""); }
    catch (failure) { setError(`${String(failure)}；仍可手动输入模型 ID`); }
    finally { setBusy(false); }
  };
  const saveKey = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try { await setAiKey(selected.id, keyDraft || null); change({ hasKey: !!keyDraft }); setKeyDraft(""); setConnections((current) => { const next = { ...current }; delete next[selected.id]; return next; }); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const testConnection = async (profile: AiProfile) => {
    setBusy(true); setTestingId(profile.id);
    setConnections((current) => { const next = { ...current }; delete next[profile.id]; return next; });
    const snapshot = JSON.stringify(profile);
    try {
      await testAiConnection(profile);
      setConnections((current) => ({ ...current, [profile.id]: { profile: snapshot, ok: true, message: "连接成功：模型已返回响应" } }));
    } catch (failure) {
      setConnections((current) => ({ ...current, [profile.id]: { profile: snapshot, ok: false, message: `连接失败：${String(failure)}` } }));
    } finally { setBusy(false); setTestingId(""); }
  };
  const remove = async (target: AiProfile) => {
    if (target.kind === "api" && target.hasKey) await setAiKey(target.id, null).catch(() => {});
    const profiles = ai.profiles.filter((profile) => profile.id !== target.id);
    settings.update("ai", "profiles", profiles);
    if (selected?.id === target.id) setEditingId(profiles[0]?.id ?? "");
    if (ai.activeId === target.id) settings.update("ai", "activeId", profiles.find((profile) => profile.model.trim() && (profile.kind === "cli" || profile.hasKey))?.id ?? "");
    setKeyDraft("");
  };
  const clearUnused = () => {
    const unused = new Set(unusedDrafts.map((profile) => profile.id));
    const profiles = ai.profiles.filter((profile) => !unused.has(profile.id));
    settings.update("ai", "profiles", profiles);
    if (selected && unused.has(selected.id)) setEditingId(profiles[0]?.id ?? "");
    if (unused.has(ai.activeId)) settings.update("ai", "activeId", "");
    setKeyDraft("");
  };
  return <div className="settings-page ai-settings">
    <div className="settings-row column">
      <div className="settings-row-head"><label>AI 配置组合</label><button type="button" disabled={busy} onClick={() => void check()}>自动检测本机工具</button></div>
      {detected.length > 0 && <div className="ai-detected">{detected.filter((tool) => !ai.profiles.some((profile) => profile.kind === "cli" && profile.provider === tool.provider && profile.executable === tool.executable)).map((tool) => <button key={tool.provider} type="button" onClick={() => newProfile("cli", tool.provider, tool.executable)}>添加 {tool.provider === "codex" ? "Codex" : "Claude Code"}</button>)}</div>}
      {detectedOnce && detected.length === 0 && <small>未检测到 Codex 或 Claude Code，可手动添加工具路径。</small>}
      <div className="ai-add"><button type="button" onClick={() => newProfile("cli", "codex")}>手动添加工具</button><button type="button" onClick={() => newProfile("api", "openai")}>添加 API</button>{unusedDrafts.length > 0 && <button type="button" onClick={clearUnused}>清理未配置项 · {unusedDrafts.length}</button>}</div>
      {ai.profiles.length > 0 && <div className="ai-profile-list">{ai.profiles.map((profile) => {
        const models = modelsById[profile.id] ?? [];
        const available = !!profile.model.trim() && (profile.kind === "cli" || profile.hasKey);
        const unsavedKey = profile.kind === "api" && profile.id === selected?.id && !!keyDraft;
        const connection = connections[profile.id]?.profile === JSON.stringify(profile) ? connections[profile.id] : undefined;
        return <div className="ai-profile-item" key={profile.id}><div className={profile.id === selected?.id ? "ai-profile-card editing" : "ai-profile-card"}>
          <button type="button" className="ai-profile-edit" aria-label={`编辑 ${profile.name}`} onClick={() => { setEditingId(profile.id); setKeyDraft(""); }}><strong>{providerLabel(profile)}{profile.kind === "api" ? " API" : ""}</strong><span>{profile.model || "未选择模型"}</span></button>
          <select aria-label={`${profile.name} 模型`} value={models.includes(profile.model) ? profile.model : ""} onChange={(event) => settings.update("ai", "profiles", ai.profiles.map((item) => item.id === profile.id ? { ...item, model: event.target.value } : item))}><option value="">{profile.model && !models.includes(profile.model) ? profile.model : "选择模型"}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select>
          <button type="button" disabled={busy} onClick={() => void fetchModels(profile)}>检测模型</button>
          <button type="button" disabled={busy || !available || unsavedKey} aria-label={`测试 ${profile.name} 连接`} title={unsavedKey ? "请先保存密钥" : !available ? "请先选择模型，API 配置还需保存密钥" : "发送简短请求测试连接（最长约 30 秒）"} onClick={() => void testConnection(profile)}>{testingId === profile.id ? "测试中…" : "测试连接"}</button>
          <button type="button" className={ai.activeId === profile.id ? "primary" : ""} disabled={!available} aria-label={`使用 ${profile.name}`} aria-pressed={ai.activeId === profile.id} onClick={() => settings.update("ai", "activeId", profile.id)}>{ai.activeId === profile.id ? "使用中" : "使用"}</button>
          <button type="button" className="ai-profile-remove" aria-label={`删除 ${profile.name} 配置`} title="删除此配置" onClick={() => void remove(profile)}>×</button>
        </div>
          {testingId === profile.id && <p className="settings-note" role="status">正在测试连接…</p>}
          {connection && <p className={connection.ok ? "settings-ok" : "settings-error"} role={connection.ok ? "status" : "alert"}>{connection.message}</p>}
        </div>;
      })}</div>}
    </div>
    {selected && <>
      <div className="settings-row"><label htmlFor="ai-profile-name">名称</label><input id="ai-profile-name" value={selected.name} onChange={(event) => change({ name: event.target.value })}/></div>
      <div className="settings-row"><label htmlFor="ai-provider">来源</label><select id="ai-provider" value={selected.provider} onChange={(event) => { change({ provider: event.target.value as AiProfile["provider"], model: "" }); setModelsById((current) => ({ ...current, [selected.id]: [] })); }}>
        {(selected.kind === "cli" ? ["codex", "claude"] : ["openai", "anthropic", "deepseek", "compatible"]).map((provider) => <option key={provider} value={provider}>{provider}</option>)}
      </select></div>
      {selected.kind === "cli" ? <div className="settings-row"><label htmlFor="ai-executable">可执行文件</label><input id="ai-executable" value={selected.executable} placeholder="留空时从 PATH 查找" onChange={(event) => change({ executable: event.target.value })}/></div> : <>
        <div className="settings-row"><label htmlFor="ai-base-url">Base URL</label><input id="ai-base-url" value={selected.baseUrl} placeholder="留空使用厂商默认地址" onChange={(event) => change({ baseUrl: event.target.value })}/></div>
        <div className="settings-row"><label htmlFor="ai-key">API Key</label><input id="ai-key" type="password" value={keyDraft} placeholder={selected.hasKey ? "已保存；输入新值可替换" : "输入 API Key"} onChange={(event) => setKeyDraft(event.target.value)}/><button type="button" disabled={busy} onClick={() => void saveKey()}>{keyDraft ? "保存密钥" : "清除密钥"}</button></div>
      </>}
      <div className="settings-row"><label htmlFor="ai-model-manual">模型 ID</label><input id="ai-model-manual" value={selected.model} placeholder="也可手动输入模型 ID" onChange={(event) => change({ model: event.target.value })}/></div>
      <p className="settings-note">测试连接会向该模型发送一次简短请求，可能产生少量用量费用；最长等待约 30 秒。{selected.kind === "api" && "使用已保存的 API Key；输入新密钥后请先保存。"}</p>
    </>}
    <section className="ai-prompt-settings" aria-label="操作系统提示词">
      <h4>操作系统提示词</h4>
      <p className="settings-note">按操作分别设置，切换 AI 组合时沿用这些提示词；输出格式与文件范围仍由 Oris 校验。</p>
      {([
        ["stagedMessage", "根据暂存内容生成提交信息"],
        ["describedCommit", "根据描述选择文件并生成提交信息"],
        ["commandCenter", "AI 操作入口"],
      ] as const).map(([key, label]) => <div className="ai-prompt-field" key={key}>
        <div className="settings-row-head"><label htmlFor={`ai-prompt-${key}`}>{label}</label><button type="button" disabled={ai.prompts[key] === DEFAULT_AI_PROMPTS[key]} onClick={() => settings.update("ai", "prompts", { ...ai.prompts, [key]: DEFAULT_AI_PROMPTS[key] })}>恢复默认</button></div>
        <textarea id={`ai-prompt-${key}`} aria-label={`${label}系统提示词`} value={ai.prompts[key]} maxLength={10_000} onChange={(event) => settings.update("ai", "prompts", { ...ai.prompts, [key]: event.target.value })}/>
      </div>)}
    </section>
    {warning && <p className="settings-warning" role="status">{warning}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <p className="settings-note">列表只显示已添加的配置，新增项会自动保存。API Key 保存在系统凭据存储中；模型查询失败时可手动输入模型 ID。</p>
    <div className="settings-note ai-data-note" aria-label="AI 发送的数据">
      <p>AI 为可选功能：只有在你生成提交信息、发送 AI 指令、查询模型或测试连接时，Oris 才会把下列内容发送给当前 AI 组合（API 服务或本机的 codex / claude 工具），不会在后台自动发送。</p>
      <ul>
        <li>测试连接：仅发送固定的简短测试文本，不发送项目文件内容。</li>
        <li>生成提交信息：已暂存的文件列表与已暂存的改动（最多约 90 KB）。</li>
        <li>按描述选择文件提交：候选文件列表、已暂存与未暂存的改动（各最多约 90 KB）、未跟踪文件开头最多 2 KB（最多 40 个），合计最多约 18 万字符。</li>
        <li>AI 指令：按指令的上下文选择发送仓库状态、文件列表、分支与远端、当前打开文件两侧的内容（各最多 12,000 字符）、可提交文件差异（最多 40,000 字符）、最近 20 条提交标题与作者、外观及 AI 组合名称和模型；操作需要时另附 stash、丢弃备份或 HEAD 信息。主会话首次发送后固定模型，传输记录最多 48 块、240,000 字符；一次性指令按各自路由执行，并携带最近 24 条消息、合计 32,000 字符的会话背景。结果返回主会话，关闭后不保存。达到上限时裁剪较早记录并提示。</li>
      </ul>
      <p>API Key 只随请求发送给该组合的服务地址。</p>
    </div>
  </div>;
}

function UpdatePage({ settings }: { settings: SettingsStore }) {
  const mac = isMacPlatform();
  const autoCheck = useSettings(settings, (value) => value.update.autoCheck);
  const state = useStore(updater.store, (value) => value);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { getVersion().then(setVersion, () => {}); }, []);
  const { phase } = state;
  const status = phase.kind === "checking" ? "正在检查…"
    : phase.kind === "manual" ? `发现新版本 ${phase.info.version}。当前版本需要手动更新，请从下载页获取安装包。`
    : phase.kind === "downloading" ? `正在后台下载 ${phase.info.version}…`
    : phase.kind === "ready" ? `${phase.info.version} 已下载，点击标题栏的「重启以更新」完成安装。`
    : phase.kind === "installing" ? "正在启动安装程序…"
    : phase.kind === "failed" ? null
    : state.upToDate ? "已是最新版本。" : null;
  return <div className="settings-page">
    <dl className="git-facts">
      <dt>当前版本</dt><dd>{state.currentVersion ?? version ?? "未知"}</dd>
      <dt>上次检查</dt><dd>{state.checkedAt ? new Date(state.checkedAt).toLocaleString() : "尚未检查"}</dd>
    </dl>
    <div className="settings-row">
      <label htmlFor="settings-update-auto">自动检查更新</label>
      <input id="settings-update-auto" type="checkbox" checked={autoCheck} onChange={(event) => settings.update("update", "autoCheck", event.target.checked)} />
      <small>{mac ? "启动后与每 4 小时检查一次；有新版本时提示下载" : "启动后与每 4 小时检查一次；有新版本时在后台下载"}</small>
    </div>
    <div className="settings-row">
      <button type="button" disabled={["checking", "downloading", "installing"].includes(phase.kind)} onClick={() => void updater.check({ manual: true })}>检查更新</button>
      {phase.kind === "manual" && <button type="button" onClick={() => void updater.openDownloadPage()}>打开下载页</button>}
    </div>
    {status && <p className="settings-note" role="status">{status}</p>}
    {phase.kind === "failed" && <p className="settings-error" role="alert">{phase.message}</p>}
    {"info" in phase && phase.info?.notes && <pre className="update-notes">{phase.info.notes}</pre>}
    <p className="settings-note">{mac
      ? "更新包来自 GitHub Releases。macOS 当前使用手动安装包；下载 DMG 后退出 Oris，将 Oris.app 拖入“应用程序”替换旧版。"
      : "更新包来自 GitHub Releases，安装前校验签名；安装时 Oris 会退出并在完成后自动重启。"}</p>
  </div>;
}

function ShortcutsPage({ settings }: { settings: SettingsStore }) {
  const ai = useSettings(settings, (value) => value.ai);
  return <div className="settings-page"><div className="settings-row"><label htmlFor="ai-shortcut">AI 输入快捷键</label><input id="ai-shortcut" readOnly value={displayAiShortcut(ai.shortcut)} onKeyDown={(event) => {
      event.preventDefault();
      if (event.key === "Backspace") { settings.update("ai", "shortcut", ""); return; }
      if (!["Control", "Meta", "Shift", "Alt"].includes(event.key) && (event.ctrlKey || event.metaKey) && event.key.length === 1) {
        settings.update("ai", "shortcut", `${event.metaKey ? "Meta" : "Ctrl"}${event.shiftKey ? "+Shift" : ""}${event.altKey ? "+Alt" : ""}+${event.key.toUpperCase()}`);
      }
    }}/><small>在输入框中按组合键录入；Backspace 清除，仅 Oris 窗口内生效</small></div>
  </div>;
}

export default function SettingsDialog({ settings, onClose, gitInUse, repoId = null, repoName = "", initialCategory, ignorePreview }: Props) {
  const categories = [...settings.registry.list(), { id: "shortcuts", label: "快捷键", order: 40, settings: [] }];
  const [active, setActive] = useState(initialCategory ?? categories[0]?.id ?? "appearance");
  const [aiExpanded, setAiExpanded] = useState(false);
  const [gitExpanded, setGitExpanded] = useState(initialCategory === "git" || initialCategory === "fileIgnore");
  const [aiCommandId, setAiCommandId] = useState<string>();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1} ref={dialog}>
      <nav className="settings-nav" aria-label="设置分类">
        {categories.filter(category => category.id !== "fileIgnore").map((category) => category.id === "git" ? <div className="settings-git-group" key="git">
          <button className={active === "git" ? "active" : ""} aria-current={active === "git"} aria-expanded={gitExpanded} aria-controls="settings-git-subnav" onClick={() => { setGitExpanded(active === "git" ? !gitExpanded : true); setActive("git"); }}>Git<span aria-hidden="true">{gitExpanded ? "⌄" : "›"}</span></button>
          <div id="settings-git-subnav" className="settings-git-subnav" hidden={!gitExpanded}><button className={active === "fileIgnore" ? "active" : ""} aria-current={active === "fileIgnore"} onClick={() => setActive("fileIgnore")}>忽略文件</button></div>
        </div> : category.id === "ai" ? <div className="settings-ai-group" key="ai">
          <button aria-expanded={aiExpanded} aria-controls="settings-ai-subnav" onClick={() => { setAiExpanded(v => !v); if (!aiExpanded && !["ai", "ai-commands", "ai-routes"].includes(active)) setActive("ai"); }}>AI<span aria-hidden="true">{aiExpanded ? "⌄" : "›"}</span></button>
          <div id="settings-ai-subnav" className="settings-ai-subnav" hidden={!aiExpanded}>{[["ai", "连接与模型"], ["ai-commands", "指令"], ["ai-routes", "规则路由"]].map(([id, label]) => <button key={id} className={active === id ? "active" : ""} aria-current={active === id} onClick={() => setActive(id)}>{label}</button>)}</div>
        </div> : <button key={category.id} className={category.id === active ? "active" : ""} aria-current={category.id === active} onClick={() => setActive(category.id)}>{category.label}</button>)}
        <span className="settings-nav-more">更多分类（以后）</span>
      </nav>
      <div className="settings-body">
        <header><h3>{active === "ai-commands" ? "AI 指令" : active === "ai-routes" ? "规则路由" : active === "ai" ? "AI · 连接与模型" : categories.find((c) => c.id === active)?.label}</h3><button aria-label="关闭设置" onClick={onClose}>×</button></header>
        {settings.notice === "corrupted" && <p className="settings-error">设置文件已损坏，已使用默认值（项目列表不受影响）。</p>}
        {settings.notice === "incompatible" && <p className="settings-error">设置文件版本不兼容，已使用默认值。</p>}
        {active === "fileIgnore" ? <FileIgnoreSettings key={repoId} settings={settings} repoId={repoId} repoName={repoName} preview={ignorePreview}/> : active === "appearance" ? <AppearancePage settings={settings} /> : active === "git" ? <GitPage settings={settings} gitInUse={gitInUse} /> : active === "shortcuts" ? <ShortcutsPage settings={settings} /> : active === "update" ? <UpdatePage settings={settings} /> : active === "ai-commands" ? <AiCommandsPage settings={settings} initialCommandId={aiCommandId} onRoutes={() => setActive("ai-routes")}/> : active === "ai-routes" ? <AiRoutesPage settings={settings} onCommands={id => { setAiCommandId(id); setActive("ai-commands"); }}/> : <AiPage settings={settings} />}
      </div>
    </div>
  </div>;
}
