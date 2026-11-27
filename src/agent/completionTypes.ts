import type { z } from "zod";
import type { CompletionStreamListener } from "./completionStream.ts";
import type { ProviderTelemetry } from "./metrics.ts";
import type { AgentProvider } from "./provider.ts";

export interface Completion {
  text: string;
  provider: AgentProvider;
  /** Set when the provider kept a session the caller can resume with only the new content. */
  session_id?: string | null;
  metrics: {
    telemetry_id: string;
    provider_execution_ms: number;
    provider: AgentProvider;
    model: string | null;
    model_source: string;
    cost_usd: number | null;
    tokens: Record<string, number | null | undefined> | null;
    /** What the provider reported about the work inside this completion; null when it reports nothing. */
    telemetry: ProviderTelemetry | null;
    /**
     * How tools were served when the caller offered native tools: "native" (the provider runs the loop) or "chat-tool"
     * (it cannot, so the caller's prompt-block protocol applies). Absent when no tools were offered.
     */
    tool_protocol?: "native" | "chat-tool";
  };
}

/**
 * A provider-side conversation the caller wants to continue (send only what is new). Providers without one ignore it
 * and return no `session_id`, so the caller keeps sending complete prompts.
 */
export interface CompletionSession {
  keep: boolean;
  resume?: string | null;
}

/** An image block of the request (bytes as base64; never written to logs or telemetry). */
export interface CompletionImage {
  media_type: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

/**
 * Platform tools offered as native tool calls (Claude: an in-process MCP server of the Agent SDK). Only these tools exist
 * in the session: built-in file, shell and web tools stay disabled, and `call` is the caller's own authorization,
 * validation and audit path. The provider runs the tool loop; `call` returns the text the model sees.
 */
export interface NativeTools {
  tools: Array<{ name: string; description: string; shape: Record<string, z.ZodType> }>;
  call: (name: string, args: unknown) => Promise<string>;
  maxTurns: number;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  model: string;
  effort: string;
  timeoutMs: number;
  onStream?: CompletionStreamListener;
  session?: CompletionSession;
  images?: CompletionImage[];
  nativeTools?: NativeTools;
}

/** MCP tool names allow [a-zA-Z0-9_-]: `code.read_file` is offered as `code_read_file`. */
export const nativeToolName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

export type CompletionRunner = (
  prompt: string,
  options: CompletionOptions,
) => Promise<{
  text: string;
  model?: string;
  cost_usd?: number | null;
  tokens: Completion["metrics"]["tokens"];
  session_id?: string | null;
  telemetry?: ProviderTelemetry | null;
}>;
