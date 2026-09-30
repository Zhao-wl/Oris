import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GroupMember } from "./types";
import { pickerOrder } from "./repo-group";

/** 成员徽标中的改动状态（V2-D83）：count 为 undefined 时显示“未扫描”，不显示成 0。 */
export interface MemberBadge { count?: number; scanning?: boolean; dirty?: boolean }

interface Props {
  rootName: string;
  members: GroupMember[];
  /** 尚在读取成员列表（打开工作区后的第一次发现）。 */
  loading: boolean;
  currentRepoId: string | null;
  badges: Record<string, MemberBadge>;
  ignored: string[];
  onSelect(member: GroupMember): void;
  onRescan(): void;
  onRemoveManual(member: GroupMember): void;
  onClose(): void;
}

const hint = (member: GroupMember, owner: GroupMember | undefined) => member.state === "uninitialized"
  ? { text: "未初始化，Oris 不执行初始化。可在命令行执行", command: `git submodule update --init -- ${member.relativePath}` }
  : member.state === "missing"
    ? { text: "worktree 目录已不存在。可在命令行执行", command: owner?.relativePath ? `git -C ${owner.relativePath} worktree prune` : "git worktree prune" }
    : member.state === "invalid"
      ? { text: "已不是位于工作区内的独立仓库，可以移出", command: null }
      : null;

const stateLabel: Record<GroupMember["state"], string> = { ready: "", uninitialized: "未初始化", missing: "目录缺失", invalid: "无效" };
/** 分组标题：worktree 跟随所属仓库的分组。 */
const groupLabel = (member: GroupMember, rootId: string | null) => member.kind === "superproject" || (member.kind === "worktree" && member.parentRepoId === rootId) ? "父仓库" : member.kind === "manual" ? "手动加入" : "子模块";

/**
 * 标题栏的仓库选择器（R-WORKSPACE，[工作区效果图](../docs/design/07-workspace-ui.md)）：
 * 搜索名称或路径，↑↓ 选择（跳过不可打开的成员），Enter 切换，Esc 关闭。
 */
export default function RepoPicker({ rootName, members, loading, currentRepoId, badges, ignored, onSelect, onRescan, onRemoveManual, onClose }: Props) {
  const [query, setQuery] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const ordered = useMemo(() => pickerOrder(members), [members]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => ordered.filter((member) => !needle || `${member.name} ${member.relativePath}`.toLocaleLowerCase().includes(needle)), [ordered, needle]);
  const openable = (member: GroupMember | undefined) => !!member && member.state === "ready" && !!member.repoId;
  const [cursor, setCursor] = useState(() => Math.max(0, ordered.findIndex((member) => member.repoId === currentRepoId)));
  useEffect(() => { setCursor((index) => (openable(visible[index]) ? index : Math.max(0, visible.findIndex(openable)))); }, [visible]);
  useEffect(() => {
    input.current?.focus();
    const close = (event: Event) => { const target = event.target as Element; if (!host.current?.contains(target) && !target.closest?.(".repo-picker-button")) closeRef.current(); };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, []);
  useEffect(() => { host.current?.querySelector(".repo-row.cursor")?.scrollIntoView?.({ block: "nearest" }); }, [cursor]);
  const move = (step: number) => {
    if (!visible.some(openable)) return;
    let index = cursor;
    do index = (index + step + visible.length) % visible.length; while (!openable(visible[index]));
    setCursor(index);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "Enter") { event.preventDefault(); const member = visible[cursor]; if (openable(member)) onSelect(member); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  const submodules = members.filter((member) => member.kind === "submodule").length;
  // 同一仓库有多个不可用的 worktree（常见于其他工具留下的已删除目录）时合并成一行说明，不逐条占用列表；搜索时照常逐条显示。
  const collapsed = new Map<string, GroupMember[]>();
  if (!needle) {
    for (const member of visible) {
      if (member.kind !== "worktree" || member.state === "ready" || !member.parentRepoId) continue;
      collapsed.set(member.parentRepoId, [...(collapsed.get(member.parentRepoId) ?? []), member]);
    }
    for (const [owner, list] of collapsed) if (list.length < 2) collapsed.delete(owner);
  }
  let lastGroup = "";
  return <div ref={host} className="repo-picker" role="dialog" aria-label="选择仓库" onKeyDown={onKeyDown}>
    <div className="repo-picker-head">工作区 {rootName} · {submodules} 个子模块</div>
    <input ref={input} aria-label="搜索仓库" placeholder="搜索仓库（名称或路径）" value={query} onChange={(event) => setQuery(event.target.value)}/>
    <div className="repo-picker-list" role="listbox" aria-label="仓库">
      {loading && !members.length && <div className="log-empty">正在读取工作区成员…</div>}
      {visible.map((member, index) => {
        const label = groupLabel(member, members[0]?.repoId ?? null);
        const head = label !== lastGroup ? <div className="log-group" key={`g-${label}`}>{label}</div> : null;
        lastGroup = label;
        const group = member.parentRepoId ? collapsed.get(member.parentRepoId) : undefined;
        if (group?.includes(member)) {
          if (group[0] !== member) return null;
          const owner = members.find((entry) => entry.repoId === member.parentRepoId);
          return [head, <div key={`unavailable:${member.parentRepoId}`} role="option" aria-disabled="true" aria-selected={false} className="repo-row worktree disabled" title={group.map((entry) => entry.worktreePath).join("\n")}>
            <span className="repo-row-icon" aria-hidden="true">⤷</span>
            <span className="repo-row-name">{`${group.length} 个 worktree 不可用`}<small>{owner?.name ?? ""} 的 worktree，目录已缺失或尚未就绪</small></span>
            <span className="repo-badges"><span className="repo-badge">不可用</span></span>
            <span className="repo-row-hint">悬停查看路径。可在命令行执行 <code>{owner?.relativePath ? `git -C ${owner.relativePath} worktree prune` : "git worktree prune"}</code>（被锁定的需先 unlock）</span>
          </div>];
        }
        const badge = member.repoId ? badges[member.repoId] : undefined;
        const disabled = !openable(member);
        const current = member.repoId === currentRepoId;
        const note = hint(member, members.find((entry) => entry.repoId && entry.repoId === member.parentRepoId));
        const key = member.repoId ?? `${member.kind}:${member.worktreePath}`;
        return [head, <div key={key} role="option" aria-selected={current} aria-disabled={disabled}
          className={`repo-row${member.kind === "worktree" ? " worktree" : ""}${disabled ? " disabled" : ""}${current ? " current" : ""}${index === cursor ? " cursor" : ""}`}
          onPointerEnter={() => { if (!disabled) setCursor(index); }}
          onClick={() => { if (!disabled) onSelect(member); }}>
          <span className="repo-row-icon" aria-hidden="true">{member.kind === "superproject" ? "▦" : member.kind === "worktree" ? "⤷" : "◫"}</span>
          <span className="repo-row-name" title={member.worktreePath}>{member.name}<small>{member.kind === "worktree" ? "worktree · " : ""}{member.relativePath || member.worktreePath}</small></span>
          <span className="repo-badges">
            {disabled ? <span className="repo-badge">{stateLabel[member.state]}</span> : <>
              <span className="repo-badge branch">{member.branch ?? (member.headOid ? `detached @ ${member.headOid.slice(0, 7)}` : "—")}</span>
              {member.kind === "submodule" && member.recordedOid && member.headOid && member.recordedOid !== member.headOid && <span className="repo-badge drift" title={`当前提交与父仓库记录的指针不同（记录 ${member.recordedOid.slice(0, 7)}）`}>偏离记录</span>}
              {badge?.dirty && !badge.scanning && <span className="repo-badge dirty" title="打开工作区后在外部发生了变化，切换过去时刷新">有变化</span>}
              {badge?.scanning ? <span className="repo-badge scan">读取中…</span>
                : badge?.count === undefined ? <span className="repo-badge scan" title="尚未读取改动数">未扫描</span>
                  : badge.count ? <span className="repo-badge changes">{badge.count} 个改动</span> : <span className="repo-badge">无改动</span>}
            </>}
            {member.kind === "manual" && <button type="button" className="repo-remove" title="从工作区移出（不删除目录）" onClick={(event) => { event.stopPropagation(); onRemoveManual(member); }}>移出</button>}
          </span>
          {note && <span className="repo-row-hint">{note.text}{note.command && <> <code>{note.command}</code></>}</span>}
        </div>];
      })}
      {!loading && members.length > 0 && !visible.length && <div className="log-empty">没有匹配的仓库</div>}
      {ignored.length > 0 && <div className="repo-picker-ignored" title={ignored.join("\n")}>.gitmodules 中有 {ignored.length} 个条目已忽略：{ignored.join("；")}</div>}
    </div>
    <div className="repo-picker-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 切换 · <kbd>Esc</kbd> 关闭</span><span className="spacer"/><button type="button" className="quiet" onClick={onRescan}>刷新全部状态</button></div>
  </div>;
}
