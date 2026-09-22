import { invoke } from "@tauri-apps/api/core";
import type { ContentPair, RepositorySnapshot } from "./types";

export const openRepository = (path: string, gitExecutable: string | null, requestId: string) =>
  invoke<RepositorySnapshot>("open_repository", { path, gitExecutable, requestId });

export const readContentPair = (
  repoId: string,
  revision: string,
  pathId: string,
  gitExecutable: string | null,
  requestId: string
) => invoke<ContentPair>("read_content_pair", { repoId, revision, pathId, gitExecutable, requestId });
