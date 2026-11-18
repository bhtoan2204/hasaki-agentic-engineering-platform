import type { ManualChatMode } from "./types.ts";

export type ToolGroup = "repo" | "knowledge" | "observability" | "platform" | "database";

/**
 * Tool groups a mode may use. Chat has no mutating tool: shell, source edits, git push, merge, deploy and
 * database writes do not exist in the catalog. AUTO resolves to a manual mode before tools are selected.
 */
export const MODE_GROUPS: Record<ManualChatMode, ToolGroup[]> = {
  ASK: ["repo", "knowledge", "platform"],
  INVESTIGATE: ["repo", "knowledge", "platform", "observability", "database"],
  PLAN: ["repo", "knowledge", "platform"],
  DELEGATE: ["repo", "knowledge", "platform"],
};
