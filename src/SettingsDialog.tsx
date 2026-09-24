import { useEffect, useRef, useState } from "react";
import { validateGit, type GitValidation } from "./api";
import { DEFAULT_SCHEMES, FONT_SIZE_MAX, FONT_SIZE_MIN, useSettings, type SettingsStore } from "./settings";
import { schemeIndex, type SchemeIndexEntry } from "./themes/runtime";
import notices from "./themes/generated/NOTICES.txt?raw";

interface Props {
  settings: SettingsStore;
  onClose(): void;
  /** 当前项目实际使用的 Git（来自最近一次快照）。 */
  gitInUse: { executable: string; version: string; minimumVersion: string } | null;
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

export default function SettingsDialog({ settings, onClose, gitInUse }: Props) {
  const categories = settings.registry.list();
  const [active, setActive] = useState(categories[0]?.id ?? "appearance");
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
        {categories.map((category) => <button key={category.id} className={category.id === active ? "active" : ""} aria-current={category.id === active} onClick={() => setActive(category.id)}>{category.label}</button>)}
        <span className="settings-nav-more">更多分类（以后）</span>
      </nav>
      <div className="settings-body">
        <header><h3>{categories.find((c) => c.id === active)?.label}</h3><button aria-label="关闭设置" onClick={onClose}>×</button></header>
        {settings.notice === "corrupted" && <p className="settings-error">设置文件已损坏，已使用默认值（项目列表不受影响）。</p>}
        {settings.notice === "incompatible" && <p className="settings-error">设置文件版本不兼容，已使用默认值。</p>}
        {active === "appearance" ? <AppearancePage settings={settings} /> : <GitPage settings={settings} gitInUse={gitInUse} />}
      </div>
    </div>
  </div>;
}
