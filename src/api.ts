import { invoke } from "@tauri-apps/api/core";
import type { CompareScope, ConflictVersion, ContentPair, GroupDiscovery, RepositoryDetails, RepositorySnapshot } from "./types";

/** `submodulePointers`：子模块指针开关（V2-D80，默认关闭）。 */
export const openRepository = (path: string, scope: CompareScope, gitExecutable: string | null, requestId: string, submodulePointers = false) =>
  invoke<RepositorySnapshot>("open_repository", { path, scope, gitExecutable, requestId, submodulePointers });

/** 工作区发现（V2-07）：只读，不打开仓库。`manual` 为手动加入的独立嵌套仓库路径。 */
export const discoverGroup = (path: string, manual: string[], gitExecutable: string | null) =>
  invoke<GroupDiscovery>("discover_group", { path, manual, gitExecutable });

/** 成员徽标的改动数（V2-D83）：一次只读 status。 */
export const memberChangeCount = (path: string, submodulePointers: boolean, gitExecutable: string | null) =>
  invoke<number>("member_change_count", { path, submodulePointers, gitExecutable });

/** 工作区共用一个 watcher（V2-D82）；第一个成员为父仓库。 */
export const watchGroup = (key: string, members: { repoId: string; worktreePath: string; gitDir: string; commonDir: string }[], gitExecutable: string | null) =>
  invoke<void>("watch_group", { key, members, gitExecutable });

export const setSubmodulePointers = (repoId: string, show: boolean) => invoke<void>("set_submodule_pointers", { repoId, show });

/** `manual` 为 true 时允许后端回写 index stat 缓存（V2-D09，仅用户手动刷新）。 */
export const refreshRepository = (repoId: string, scope: CompareScope, requestId: string, manual = false) =>
  invoke<RepositorySnapshot>("refresh_repository", { repoId, scope, requestId, manual });

export const repositoryDetails = (repoId: string, revision: string) =>
  invoke<RepositoryDetails>("repository_details", { repoId, revision });

/** 返回 false 表示该项目的 watcher 曾被 LRU 淘汰，期间的变化未知，需要完整刷新。 */
export const activateRepository = (repoId: string) => invoke<boolean>("activate_repository", { repoId });

export const closeRepository = (repoId: string) => invoke<void>("close_repository", { repoId });

interface FrameHeader {
  pair: ContentPair;
  textRanges: [[number, number] | null, [number, number] | null];
  imageRanges: [[number, number] | null, [number, number] | null];
  fallbackRanges?: [[number, number] | null, [number, number] | null];
}

const utf8 = new TextDecoder("utf-8");

/** 解码后端二进制帧：`ORC1` + u32 头长度 + JSON 头 + 文本 / 图片载荷。 */
export function decodeContentFrame(frame: ArrayBuffer | Uint8Array | ContentPair): ContentPair {
  if (!(frame instanceof ArrayBuffer) && !(frame instanceof Uint8Array)) return frame;
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length < 8 || utf8.decode(bytes.subarray(0, 4)) !== "ORC1") throw new Error("内容帧格式无效");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const header = JSON.parse(utf8.decode(bytes.subarray(8, 8 + headerLength))) as FrameHeader;
  const payload = bytes.subarray(8 + headerLength);
  const sides = [header.pair.left, header.pair.right];
  sides.forEach((side, index) => {
    const text = header.textRanges[index];
    if (text) side.text = utf8.decode(payload.subarray(text[0], text[0] + text[1]));
    const fallback = header.fallbackRanges?.[index];
    if (fallback) side.latin1 = utf8.decode(payload.subarray(fallback[0], fallback[0] + fallback[1]));
    const image = header.imageRanges[index];
    if (image && side.details?.image) side.details.image.bytes = payload.slice(image[0], image[0] + image[1]);
  });
  return header.pair;
}

export const readContentPair = async (
  repoId: string,
  scope: CompareScope,
  revision: string,
  pathId: string,
  gitExecutable: string | null,
  requestId: string,
  versions?: [ConflictVersion, ConflictVersion],
  prefetch = false
) => decodeContentFrame(await invoke<ArrayBuffer | ContentPair>("read_content_pair", { repoId, scope, revision, pathId, gitExecutable, requestId, versions, prefetch }));

export const cancelContentRead = (repoId?: string) => invoke<void>("cancel_content_read", { repoId: repoId ?? null });

export const saveSnapshot = (worktreePath: string, json: string) => invoke<boolean>("save_snapshot", { worktreePath, json });
export const loadSnapshot = (worktreePath: string) => invoke<string | null>("load_snapshot", { worktreePath });
export const removeSnapshot = (worktreePath: string) => invoke<void>("remove_snapshot", { worktreePath });

export interface GitValidation {
  ok: boolean;
  executable: string;
  version: string | null;
  minimumVersion: string;
  error: string | null;
}
/** 设置窗口修改 Git 路径时校验（执行一次 `git --version`，不访问任何仓库）。null 表示自动发现。 */
export const validateGit = (executable: string | null) => invoke<GitValidation>("validate_git", { executable });

/** 在系统文件管理器中显示工作区内的文件（选中）或目录（打开）；relative 为 `/` 分隔的仓库相对路径，已删除时打开最近的上级目录。 */
export const revealInFileManager = (repoId: string, relative: string) => invoke<void>("reveal_in_file_manager", { repoId, relative });
