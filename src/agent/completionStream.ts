/**
 * Real provider progress, reported while a completion runs. Nothing here is synthesized: `text` is the answer the
 * provider has produced so far (cumulative, a provider may revise it), `reasoning` is provider-reported
 * thinking/reasoning summary text, `activity` is an execution step the provider reported (tool call, command).
 */
export type CompletionStreamEvent =
  | { type: "started" }
  | { type: "text"; text: string }
  | { type: "reasoning"; delta: string }
  | { type: "activity"; label: string };
export type CompletionStreamListener = (event: CompletionStreamEvent) => void;

export const activityLabel = (kind: string, detail?: unknown) => {
  const d = typeof detail === "string" ? detail.replace(/\s+/g, " ").trim() : "";
  return (d ? `${kind}: ${d}` : kind).slice(0, 160);
};
