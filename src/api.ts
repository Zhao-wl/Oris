import { invoke } from "@tauri-apps/api/core";
import type { CompareScope, ConflictVersion, ContentPair, RepositoryDetails, RepositorySnapshot } from "./types";

export const openRepository = (path: string, scope: CompareScope, gitExecutable: string | null, requestId: string) =>
  invoke<RepositorySnapshot>("open_repository", { path, scope, gitExecutable, requestId });

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
