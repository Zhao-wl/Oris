// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RepoPicker from "./RepoPicker";
import type { GroupMember } from "./types";

const member = (name: string, kind: GroupMember["kind"], extra: Partial<GroupMember> = {}): GroupMember => ({
  repoId: `id-${name}`, kind, name, worktreePath: `E:/ws/${name}`, relativePath: kind === "superproject" ? "" : name, parentRepoId: kind === "superproject" ? null : "id-ws",
  state: "ready", gitDir: "g", commonDir: "g", branch: "dev", headOid: "b".repeat(40), recordedOid: null, ...extra,
});
const missing = (name: string) => member(name, "worktree", { repoId: null, state: "missing", parentRepoId: "id-client", worktreePath: `C:/tools/${name}`, relativePath: `C:/tools/${name}`, gitDir: null, commonDir: null });
const members = [member("ws", "superproject"), member("client", "submodule"), member("0bf2/client", "worktree", { parentRepoId: "id-client" }), missing("2773/client"), missing("51f9/client"), missing("a25d/client")];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (onSelect = vi.fn()) => {
  await act(async () => root.render(<RepoPicker rootName="ws" members={members} loading={false} currentRepoId="id-ws" badges={{}} ignored={[]} onSelect={onSelect} onRescan={vi.fn()} onRemoveManual={vi.fn()} onClose={vi.fn()}/>));
  return onSelect;
};
const names = () => [...host.querySelectorAll(".repo-row .repo-row-name")].map((n) => n.firstChild?.textContent);

describe("仓库选择器", () => {
  it("同一仓库的多个不可用 worktree 合并成一行，给出 prune 做法；就绪的 worktree 照常列出", async () => {
    await render();
    expect(names()).toEqual(["ws", "client", "0bf2/client", "3 个 worktree 不可用"]);
    const summary = [...host.querySelectorAll(".repo-row")].pop()!;
    expect(summary.getAttribute("aria-disabled")).toBe("true");
    expect(summary.textContent).toContain("git -C client worktree prune");
    expect(summary.getAttribute("title")).toContain("C:/tools/2773/client");
  });

  it("搜索时逐条显示；键盘选择跳过不可用的成员", async () => {
    const onSelect = await render();
    await act(async () => {
      const input = host.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2773");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(names()).toEqual(["2773/client"]);
    await act(async () => {
      const input = host.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "client");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const picker = host.querySelector(".repo-picker")!;
    await act(async () => { picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await act(async () => { picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await act(async () => { picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toMatch(/^(client|0bf2\/client)$/);
  });
});
