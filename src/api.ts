import { invoke } from "@tauri-apps/api/core";
import type { CompareScope, ContentPair, RepositorySnapshot } from "./types";

export const openRepository = (path: string, scope: CompareScope, gitExecutable: string | null, requestId: string) =>
  invoke<RepositorySnapshot>("open_repository", { path, scope, gitExecutable, requestId });

export const refreshRepository = (repoId: string, scope: CompareScope, requestId: string) =>
  invoke<RepositorySnapshot>("refresh_repository", { repoId, scope, requestId });

export const closeRepository = (repoId: string) => invoke<void>("close_repository", { repoId });

export const readContentPair = (
  repoId: string,
  scope: CompareScope,
  revision: string,
  pathId: string,
  gitExecutable: string | null,
  requestId: string
) => invoke<ContentPair>("read_content_pair", { repoId, scope, revision, pathId, gitExecutable, requestId });
