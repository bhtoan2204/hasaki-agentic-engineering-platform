import { randomUUID } from "node:crypto";
import { log } from "../logging.ts";
import { assertModelAllowed } from "./modelPolicy.ts";
import {
  type Completion,
  type CompletionImage,
  type CompletionRunner,
  type CompletionSession,
  type NativeTools,
} from "./completionTypes.ts";
export {
  nativeToolName,
  type Completion,
  type CompletionImage,
  type CompletionOptions,
  type CompletionRunner,
  type CompletionSession,
  type NativeTools,
} from "./completionTypes.ts";
export type { CompletionStreamEvent, CompletionStreamListener } from "./completionStream.ts";
import type { CompletionRun } from "./configuration.ts";
export type { CompletionRun } from "./configuration.ts";
import { loadAgentConfiguration } from "./configurationStore.ts";
import type { AgentProvider } from "./provider.ts";
import { providerCapabilities, VISION_PROVIDERS } from "./providerCapabilities.ts";
export { NATIVE_TOOL_PROVIDERS, VISION_PROVIDERS } from "./providerCapabilities.ts";
import { antigravityComplete } from "./providers/antigravity/complete.ts";
import { claudeComplete } from "./providers/claude/complete.ts";
import { codexComplete } from "./providers/codex/complete.ts";
import { copilotComplete } from "./providers/copilot/complete.ts";
import { cursorCompleteRunner } from "./providers/cursor/complete.ts";
import { resolveStepAgent } from "./stepAgent.ts";

/** Explicit per-request agent values (e.g. a chat conversation's selection), validated like a step's `config.agent`. */
export interface CompletionAgentOverride {
  provider?: AgentProvider;
  model?: string | null;
  reasoning_effort?: string | null;
}

export function completionAgent(
  run: CompletionRun | null | undefined,
  agent: CompletionAgentOverride = {},
) {
  if (run?.agent_configuration === null)
    throw new Error("Historical run requires configuration recovery before completion");
  const explicit = Object.fromEntries(Object.entries(agent).filter(([, v]) => v != null));
  return resolveStepAgent(run ?? {}, {
    type: "agent",
    config: Object.keys(explicit).length ? { agent: explicit } : {},
  })!;
}

export class ProviderCapabilityError extends Error {}

const runners: Record<AgentProvider, CompletionRunner> = {
  claude: claudeComplete,
  codex: codexComplete,
  cursor: cursorCompleteRunner,
  antigravity: antigravityComplete,
  copilot: copilotComplete,
};

/** The real provider runners (evaluation wraps them to measure prompts; chat uses them through completeForRun). */
export const completionRunners: Readonly<Record<AgentProvider, CompletionRunner>> = runners;

/** One tools-free completion using the same frozen analysis routing as ordinary agent steps. */
export async function completeForRun(
  run: CompletionRun | null | undefined,
  prompt: string,
  signal?: AbortSignal,
  providers?: Record<AgentProvider, CompletionRunner> | null,
  agent: CompletionAgentOverride = {},
  onStream?: import("./completionStream.ts").CompletionStreamListener,
  session?: CompletionSession,
  extras: { images?: CompletionImage[]; nativeTools?: NativeTools } = {},
): Promise<Completion> {
  signal?.throwIfAborted();
  const runnerMap = providers ?? runners;
  const configured =
    run?.agent_configuration === undefined
      ? { ...run, agent_configuration: await loadAgentConfiguration() }
      : run;
  const resolved = completionAgent(configured, agent);
  const caps = providerCapabilities(resolved.provider);
  if (extras.images?.length && !caps.completion.visionImages)
    throw new ProviderCapabilityError(
      `${resolved.provider} cannot read images in chat; choose a vision-capable provider (${VISION_PROVIDERS.join(", ")}) or AUTO`,
    );
  const toolProtocol = extras.nativeTools
    ? caps.completion.chatNativeTools
      ? "native"
      : "chat-tool"
    : undefined;
  if (toolProtocol === "chat-tool")
    log.info("completion.native_tools_unavailable", {
      provider: resolved.provider,
      protocol: toolProtocol,
    });
  const timeoutMs = Math.min(resolved.timeout_ms ?? 600_000, 600_000);
  const deadline = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  const result = await runnerMap[resolved.provider](prompt, {
    model: resolved.model ?? "",
    effort: resolved.reasoning_effort ?? "",
    timeoutMs,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    ...(onStream ? { onStream } : {}),
    ...(session ? { session } : {}),
    ...(extras.images?.length ? { images: extras.images } : {}),
    ...(extras.nativeTools && caps.completion.chatNativeTools
      ? { nativeTools: extras.nativeTools }
      : {}),
  });
  // Whatever model the provider reports (an account default included) is checked, not only what was requested.
  assertModelAllowed(result.model || resolved.model, `${resolved.provider} completion`);
  return {
    text: result.text,
    provider: resolved.provider,
    session_id: result.session_id ?? null,
    metrics: {
      telemetry_id: randomUUID(),
      provider_execution_ms: Date.now() - started,
      provider: resolved.provider,
      model: result.model || resolved.model,
      model_source: resolved.field_sources?.model ?? "account/CLI default (external)",
      cost_usd: result.cost_usd ?? null,
      tokens: result.tokens,
      telemetry: result.telemetry ?? null,
      ...(toolProtocol ? { tool_protocol: toolProtocol } : {}),
    },
  };
}
