import { invoke } from "@tauri-apps/api/core";
import type { AiProfile } from "./settings";

export interface ToolCandidate { provider: "codex" | "claude"; executable: string; models: string[] }
export interface AiCandidate { pathId: string; displayPath: string; oldPathId: string | null }
export interface AiPlan { message: string; pathIds: string[]; revision: string; candidates: AiCandidate[]; selectionWarning?: string | null }

export const detectAiTools = () => invoke<ToolCandidate[]>("detect_ai_tools");
export const setAiKey = (id: string, key: string | null) => invoke<void>("set_ai_key", { id, key });
export const listAiModels = (profile: AiProfile) => invoke<string[]>("list_ai_models", { profile });
export const generateAiCommit = (repoId: string, profile: AiProfile, description: string | null, systemPrompt: string, requestId?: string) =>
  invoke<AiPlan>("generate_ai_commit", { repoId, profile, description, systemPrompt, requestId });
export const cancelAiGeneration = (requestId: string) => invoke<void>("cancel_ai_generation", { requestId });
