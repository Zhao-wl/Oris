// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProjectTab from "./ProjectTab";
import { defaultAnchor } from "./workspace-model";

let root: Root;
let host: HTMLDivElement;
let props: ComponentProps<typeof ProjectTab>;
const render = async () => { await act(async () => root.render(<ProjectTab {...props}/>)); };
const event = async (selector: string, value: Event) => { await act(async () => host.querySelector(selector)!.dispatchEvent(value)); };
const edit = () => event('.project-switch span', new MouseEvent('dblclick', { bubbles: true }));
const input = async (value: string) => { await act(async () => {
  const field = host.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}); };
const pointer = (selector: string, type: string, clientX: number) => event(selector, new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX, clientY: 5 }));
const key = (key: string, isComposing = false) => event('input', new KeyboardEvent('keydown', { key, isComposing, bubbles: true }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  props = {
    project: { repo: { repoId: 'a', displayName: '原仓库', worktreePath: 'D:/中文 长路径/a', gitDir: 'D:/a/.git', commonDir: 'D:/a/.git', branch: 'main' }, customName: '别名', pinned: true, lastOpenedAt: 0, gitExecutable: '', anchor: defaultAnchor() },
    active: false, onSelect: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), onReorder: vi.fn(),
  };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'elementFromPoint'); document.body.replaceChildren(); });

it('keeps the full path tooltip and removes pin/name-action controls even for legacy pinned records', async () => {
  await render(); expect(host.querySelector('.project-switch span')!.textContent).toBe('别名');
  expect(host.textContent).not.toMatch(/★|○|固定|重命名/);
  expect(host.querySelector('small')!.title).toBe(props.project.repo.worktreePath);
  expect(host.querySelector('.project-close')!.textContent).toBe('×');
  expect(host.querySelector('.project-close')!.getAttribute('aria-label')).toBe('移除项目 别名');
});
it('edits in place on double click; Enter saves a trimmed name exactly once', async () => {
  await render(); await edit(); await input('  新中文名称  '); await key('Enter');
  expect(props.onRename).toHaveBeenCalledExactlyOnceWith('新中文名称'); expect(host.querySelector('input')).toBeNull();
});
it('confirms on blur and lets an empty value fall back to the repository name', async () => {
  await render(); await edit(); await input('   ');
  await act(async () => (host.querySelector('input') as HTMLInputElement).blur());
  expect(props.onRename).toHaveBeenCalledExactlyOnceWith('');
  props.project = { ...props.project, customName: '' }; await render();
  expect(host.querySelector('.project-switch span')!.textContent).toBe('原仓库');
});
it('supports keyboard F2 and Escape cancellation without blur saving the cancelled value', async () => {
  await render(); await event('.project-switch', new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  await input('取消的名称'); await key('Escape');
  expect(props.onRename).not.toHaveBeenCalled(); expect(host.querySelector('.project-switch span')!.textContent).toBe('别名');
});
it('does not commit Enter during Chinese IME composition', async () => {
  await render(); await edit(); await input('中文'); await key('Enter', true);
  expect(props.onRename).not.toHaveBeenCalled(); expect(host.querySelector('input')).not.toBeNull();
});
it('the close button removes only through its own callback without selecting or bubbling', async () => {
  const bubbled = vi.fn(); await act(async () => root.render(<div onClick={bubbled}><ProjectTab {...props}/></div>));
  await event('.project-close', new MouseEvent('click', { bubbles: true }));
  expect(props.onRemove).toHaveBeenCalledTimes(1); expect(props.onSelect).not.toHaveBeenCalled(); expect(bubbled).not.toHaveBeenCalled(); expect(props.onReorder).not.toHaveBeenCalled();
});
it('selects from anywhere on the tab and shows no status text', async () => {
  await render(); expect(host.querySelector('.project-state')).toBeNull(); expect(host.textContent).not.toContain('已同步');
  for (const selector of ['.project-tab', '.project-drag', '.project-switch small']) await event(selector, new MouseEvent('click', { bubbles: true }));
  expect(props.onSelect).toHaveBeenCalledTimes(3);
});
it('reorders by pointer drag onto another tab without also selecting', async () => {
  const other = document.createElement('div'); other.className = 'project-tab'; other.dataset.repoId = 'b'; document.body.append(other);
  await render(); document.elementFromPoint = () => other;
  await pointer('.project-tab', 'pointerdown', 10); await pointer('.project-tab', 'pointermove', 40);
  expect(host.querySelector('.project-tab.dragging')).not.toBeNull(); expect(other.classList.contains('drop-target')).toBe(true);
  await pointer('.project-tab', 'pointerup', 40); await event('.project-tab', new MouseEvent('click', { bubbles: true }));
  expect(props.onReorder).toHaveBeenCalledExactlyOnceWith('b'); expect(props.onSelect).not.toHaveBeenCalled();
  expect(other.classList.contains('drop-target')).toBe(false); expect(host.querySelector('.project-tab.dragging')).toBeNull();
});
it('treats tiny pointer movement as a click and ignores dragging while editing', async () => {
  const other = document.createElement('div'); other.className = 'project-tab'; other.dataset.repoId = 'b'; document.body.append(other);
  await render(); document.elementFromPoint = () => other;
  await pointer('.project-tab', 'pointerdown', 10); await pointer('.project-tab', 'pointermove', 12); await pointer('.project-tab', 'pointerup', 12);
  await event('.project-tab', new MouseEvent('click', { bubbles: true }));
  expect(props.onReorder).not.toHaveBeenCalled(); expect(props.onSelect).toHaveBeenCalledTimes(1);
  await edit(); await pointer('.project-tab', 'pointerdown', 10); await pointer('.project-tab', 'pointermove', 60); await pointer('.project-tab', 'pointerup', 60);
  await event('input', new MouseEvent('click', { bubbles: true }));
  expect(props.onReorder).not.toHaveBeenCalled(); expect(props.onSelect).toHaveBeenCalledTimes(1);
});
