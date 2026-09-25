import { memo, useMemo, useState, type ReactNode } from "react";
import { shortOid, trackingText, type Branch, type RefsView, type StashEntry, type Tag } from "./history-api";
import type { PinnedEndpoint } from "./history-model";
import { stashLabel } from "./StashPanel";

/** 分组折叠状态（全局，不区分仓库）：保存折叠的分组键。 */
export const SIDEBAR_KEY = "oris.historySidebar.v1";
const DEFAULT_COLLAPSED = ["tags"];

function loadCollapsed(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? "null") as { collapsed?: unknown } | null;
    if (value && Array.isArray(value.collapsed)) return new Set(value.collapsed.filter((key): key is string => typeof key === "string"));
  } catch { /* 存储可选 */ }
  return new Set(DEFAULT_COLLAPSED);
}

interface Props {
  refs: RefsView | null;
  refsError: string | null;
  headLabel: string;
  current: Branch | null;
  fetchText: string;
  /** 正在浏览（筛选历史）的引用完整名；null 为全部分支。 */
  filter: string | null;
  onFilter(ref: string | null): void;
  stashes: StashEntry[] | null;
  stashError: string | null;
  selectedStash: string | null;
  onStash(entry: StashEntry): void;
  onNewStash?(): void;
  blocked: string | null;
  /** 双击本地分支：切换到该分支。 */
  onSwitch?(branch: Branch): void;
  /** 双击远端跟踪分支：建立同名本地跟踪分支并切换。 */
  onTrack?(branch: Branch): void;
  onMenu(x: number, y: number, endpoint: PinnedEndpoint): void;
}

/** 历史页左侧（参考 SourceTree 侧栏）：本地分支、标签、远端分支（按 remote 分组）、Stash，可搜索、可折叠。 */
export default function HistorySidebar(props: Props) {
  const { refs, refsError, headLabel, current, fetchText, filter, onFilter, stashes, stashError, selectedStash, onStash, onNewStash, blocked, onSwitch, onTrack, onMenu } = props;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (key: string) => setCollapsed((currentSet) => {
    const next = new Set(currentSet);
    if (!next.delete(key)) next.add(key);
    try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ collapsed: [...next] })); } catch { /* 存储可选 */ }
    return next;
  });
  const needle = query.trim().toLocaleLowerCase();
  const searching = needle.length > 0;
  const matches = (...texts: (string | null | undefined)[]) => !searching || texts.some((text) => text?.toLocaleLowerCase().includes(needle));
  const local = (refs?.local ?? []).filter((b) => matches(b.name));
  const tags = (refs?.tags ?? []).filter((t) => matches(t.name));
  const remoteGroups = useMemo(() => {
    const groups = new Map<string, Branch[]>();
    for (const branch of refs?.remote ?? []) {
      const key = branch.remote ?? "";
      groups.set(key, [...(groups.get(key) ?? []), branch]);
    }
    return [...groups.entries()];
  }, [refs]);
  const remoteShown = remoteGroups.map(([remote, branches]) => [remote, branches.filter((b) => matches(b.name))] as const).filter(([, branches]) => !searching || branches.length > 0);
  const remoteCount = remoteShown.reduce((sum, [, branches]) => sum + branches.length, 0);
  const stashShown = (stashes ?? []).filter((s) => matches(stashLabel(s), s.message, s.branch));
  // 搜索时展开全部分组，只列出匹配项。
  const open = (key: string) => searching || !collapsed.has(key);
  const endpoint = (ref: string, oid: string, label: string): PinnedEndpoint => ({ ref, oid, label });
  const rowTitle = (hint: string | null) => [hint, "单击筛选历史，右键比较"].filter(Boolean).join("；");
  return <aside className="log-branches" aria-label="分支">
    <input className="log-ref-search" type="search" aria-label="搜索分支" placeholder="搜索分支、标签、stash" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }}/>
    <div className="log-current" title={current ? trackingText(current.tracking).title : undefined}>当前工作分支：<strong>● {headLabel}</strong>{current && <span className="log-track">{trackingText(current.tracking).short}</span>}</div>
    {fetchText && <div className="log-fetch-time">{fetchText}</div>}
    {refsError && <div className="log-error">{refsError}</div>}
    {refs?.shallow && <div className="log-note">浅克隆：领先 / 落后数不可靠，显示为未知</div>}
    <div className="log-branch-list" aria-label="按分支筛选历史">
      {!searching && <div role="listbox" aria-label="全部分支"><button type="button" role="option" aria-selected={filter === null} className={`log-branch${filter === null ? " browsing" : ""}`} onClick={() => onFilter(null)}>全部分支</button></div>}
      <Group id="local" label="本地分支" count={local.length} open={open("local")} searching={searching} onToggle={toggle}>
        {local.map((branch) => <RefRow key={branch.fullName} name={branch.name} fullName={branch.fullName} oid={branch.oid} current={branch.current} browsing={filter === branch.fullName}
          extra={{ ...trackingText(branch.tracking), state: branch.tracking?.state ?? "" }} title={rowTitle(branch.current ? "当前工作分支" : blocked ?? "双击切换到该分支")}
          onPick={() => onFilter(branch.fullName)} onOpen={!branch.current && !blocked && onSwitch ? () => onSwitch(branch) : undefined} onMenu={(x, y) => onMenu(x, y, endpoint(branch.fullName, branch.oid, branch.name))}/>)}
      </Group>
      <Group id="tags" label="标签" count={tags.length} open={open("tags")} searching={searching} onToggle={toggle}>
        {tags.map((tag: Tag) => <RefRow key={tag.fullName} name={tag.name} fullName={tag.fullName} oid={tag.oid} current={false} browsing={filter === tag.fullName} extra={null} title={rowTitle(tag.annotated ? "附注标签" : null)}
          onPick={() => onFilter(tag.fullName)} onMenu={(x, y) => onMenu(x, y, endpoint(tag.fullName, tag.oid, tag.name))}/>)}
      </Group>
      <Group id="remote" label="远端分支" count={remoteCount} open={open("remote")} searching={searching} onToggle={toggle} container>
        {remoteShown.map(([remote, branches]) => <Group key={remote} id={`remote:${remote}`} label={remote || "其他"} count={branches.length} open={open(`remote:${remote}`)} searching={searching} onToggle={toggle} nested>
          {branches.map((branch) => <RefRow key={branch.fullName} name={remote && branch.name.startsWith(`${remote}/`) ? branch.name.slice(remote.length + 1) : branch.name} fullName={branch.fullName} oid={branch.oid} current={false} browsing={filter === branch.fullName} extra={null}
            title={rowTitle(blocked ?? "双击建立同名本地跟踪分支并切换")} onPick={() => onFilter(branch.fullName)} onOpen={!blocked && onTrack ? () => onTrack(branch) : undefined} onMenu={(x, y) => onMenu(x, y, endpoint(branch.fullName, branch.oid, branch.name))}/>)}
        </Group>)}
      </Group>
      <Group id="stash" label="Stash" count={stashShown.length} open={open("stash")} searching={searching} onToggle={toggle}
        action={onNewStash && <button type="button" className="log-group-action" disabled={!!blocked} title={blocked ?? "储藏当前改动"} onClick={onNewStash}>储藏…</button>}>
        {stashError && <div className="log-error">{stashError}</div>}
        {stashShown.map((entry) => <button key={entry.oid} type="button" role="option" aria-selected={entry.oid === selectedStash} className={`log-branch log-stash${entry.oid === selectedStash ? " browsing" : ""}`} title={`${stashLabel(entry)} · ${entry.message || "（无说明）"}\n${entry.branch || "—"} · ${shortOid(entry.oid)}${entry.untracked ? " · 含未跟踪" : ""}`} onClick={() => onStash(entry)}>
          <span className="log-branch-name">{stashLabel(entry)} · {entry.message || "（无说明）"}</span>
        </button>)}
      </Group>
    </div>
  </aside>;
}

function Group({ id, label, count, open, searching, nested, container, action, onToggle, children }: { id: string; label: string; count: number; open: boolean; searching: boolean; nested?: boolean; container?: boolean; action?: ReactNode; onToggle(id: string): void; children: ReactNode }) {
  if (searching && count === 0) return null;
  return <div className={`log-ref-group${nested ? " nested" : ""}`} data-group={id}>
    <div className="log-group-row">
      <button type="button" className="log-group-head" aria-expanded={open} disabled={searching} title={searching ? "搜索时展开全部分组" : open ? "折叠" : "展开"} onClick={() => onToggle(id)}><span className={`log-chevron${open ? " open" : ""}`} aria-hidden="true">›</span><span className="log-group-label">{label} · {count}</span></button>
      {action}
    </div>
    {open && (container ? <div className="log-ref-subgroups">{children}</div> : <div role="listbox" aria-label={label}>{children}</div>)}
  </div>;
}

const RefRow = memo(function RefRow({ name, fullName, oid, current, browsing, extra, title, onPick, onOpen, onMenu }: { name: string; fullName: string; oid: string; current: boolean; browsing: boolean; extra: { short: string; title: string; state: string } | null; title: string; onPick(): void; onOpen?(): void; onMenu(x: number, y: number): void }) {
  return <button type="button" role="option" aria-selected={browsing} data-endpoint data-ref={fullName} className={`log-branch${browsing ? " browsing" : ""}${current ? " current" : ""}`}
    title={`${fullName} @ ${shortOid(oid)}${extra ? `\n${extra.title}` : ""}\n${title}`}
    onClick={onPick} onDoubleClick={onOpen ? (event) => { event.preventDefault(); onOpen(); } : undefined} onContextMenu={(event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); }}>
    <span className="log-branch-name">{current ? "● " : ""}{name}</span>{extra && <span className={`log-track ${extra.state}`}>{extra.short}</span>}
  </button>;
});
