import type { ManualChatMode } from "./types.ts";

export type ToolGroup =
  "repo" | "knowledge" | "observability" | "platform" | "database" | "integrations";

/**
 * Tool groups a mode may use. Chat cannot run a mutation on its own: shell, source edits, git push, merge, deploy
 * and database writes do not exist; a mutating integration tool only proposes an operation the owner confirms.
 * AUTO resolves to a manual mode before tools are selected.
 */
export const MODE_GROUPS: Record<ManualChatMode, ToolGroup[]> = {
  ASK: ["repo", "knowledge", "platform", "integrations"],
  INVESTIGATE: ["repo", "knowledge", "platform", "observability", "database", "integrations"],
  PLAN: ["repo", "knowledge", "platform"],
  DELEGATE: ["repo", "knowledge", "platform"],
};
