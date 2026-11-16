export interface AgentValues {
  model?: string | null;
  reasoning_effort?: string | null;
  max_turns?: number;
  timeout_ms?: number;
  options?: { sandbox?: boolean; max_concurrent?: number };
}

export const agentDefaultFields = [
  "model",
  "reasoning_effort",
  "max_turns",
  "timeout_ms",
  "options.sandbox",
  "options.max_concurrent",
] as const;
export function changedDefaultFields(before: AgentValues, after: AgentValues): string[] {
  return agentDefaultFields.filter((key) => {
    if (key === "options.sandbox") return before.options?.sandbox !== after.options?.sandbox;
    if (key === "options.max_concurrent")
      return before.options?.max_concurrent !== after.options?.max_concurrent;
    return before[key] !== after[key];
  });
}
/** Reuse the same intent-preserving payload for saves and previews. */
export function providerDraftPatch(
  draft: {
    enabled: boolean;
    defaults: AgentValues;
    profiles: Record<string, Record<string, AgentValues>>;
  },
  fields: readonly string[],
) {
  return {
    enabled: draft.enabled,
    profiles: draft.profiles,
    ...(fields.length ? { defaults: draft.defaults, default_fields: [...fields] } : {}),
  };
}
