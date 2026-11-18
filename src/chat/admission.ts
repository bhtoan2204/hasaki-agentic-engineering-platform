import {
  isUsableAgent,
  healthSkipReason,
  nextHealthyProvider,
  probeAgentHealth,
  type AgentHealth,
} from "../agent/health.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import {
  AGENT_PROVIDERS,
  parseAgentProvider,
  providerEnabled,
  type AgentProvider,
} from "../agent/provider.ts";
import { chatFailure, ChatTurnError, classifyProviderError, type ChatFailure } from "./failures.ts";

export type ProviderStrategy = "auto" | "manual";

export interface ProviderAttempt {
  provider: AgentProvider;
  model: string | null;
  effort: string | null;
  started_at: string;
  finished_at?: string;
  ok: boolean;
  skip_reason?: string | null;
  failure?: ChatFailure | null;
  duration_ms?: number;
}

export interface AdmissionResult {
  provider: AgentProvider;
  model: string | null;
  effort: string | null;
  strategy: ProviderStrategy;
  health: AgentHealth[];
  skipped: Array<{ provider: string; reason: string }>;
  reason: string;
}

/** Test seam: inject health rows without probing CLIs. */
let healthSeam: (() => Promise<AgentHealth[]>) | undefined;
export function setChatHealthProbe(fn: (() => Promise<AgentHealth[]>) | undefined) {
  healthSeam = fn;
}

export async function loadChatHealth(): Promise<AgentHealth[]> {
  if (healthSeam) return healthSeam();
  return probeAgentHealth();
}

/**
 * Bounded admission before inference. Enabled ≠ usable.
 * Manual + fallback disabled → fail immediately on unhealthy pin.
 * AUTO → skip unhealthy and pick the next eligible provider.
 */
export async function admitProvider(input: {
  strategy: ProviderStrategy;
  preferred: string | null | undefined;
  model: string | null | undefined;
  effort: string | null | undefined;
  fallbackEnabled: boolean;
  avoid?: ReadonlySet<string>;
}): Promise<AdmissionResult> {
  const cfg = await loadAgentConfiguration();
  const health = await loadChatHealth();
  const flags = Object.fromEntries(
    AGENT_PROVIDERS.map((p) => [p, cfg.providers[p].enabled]),
  ) as Record<AgentProvider, boolean>;
  const order = providerOrder(cfg.default_provider, input.preferred);
  const avoid = new Set(input.avoid ?? []);
  const skipped: AdmissionResult["skipped"] = [];

  if (input.strategy === "manual") {
    const pinned = parseAgentProvider(input.preferred);
    if (!pinned)
      throw new ChatTurnError(
        chatFailure("NO_ELIGIBLE_PROVIDER", "No provider selected", {
          actions: ["open_settings", "retry_other_provider"],
        }),
      );
    if (!providerEnabled(pinned, flags))
      throw new ChatTurnError(
        chatFailure("PROVIDER_DISABLED", `Provider ${pinned} is disabled in Settings`, {
          provider: pinned,
          actions: ["open_settings", "retry_other_provider"],
        }),
      );
    const row = health.find((h) => h.provider === pinned);
    if (!isUsableAgent(row)) {
      const reason = healthSkipReason(row) ?? "not usable";
      if (!input.fallbackEnabled)
        throw new ChatTurnError(
          failureFromHealth(pinned, reason),
        );
      skipped.push({ provider: pinned, reason });
      avoid.add(pinned);
    } else {
      return {
        provider: pinned,
        model: input.model ?? null,
        effort: input.effort ?? null,
        strategy: "manual",
        health,
        skipped,
        reason: `manual selection: ${pinned}`,
      };
    }
  }

  // AUTO (or manual with fallback after pin failed): first healthy eligible provider.
  const next = nextHealthyProvider(order, avoid, health, flags);
  if (!next) {
    for (const p of order) {
      if (avoid.has(p)) continue;
      const parsed = parseAgentProvider(p);
      if (!parsed || !providerEnabled(parsed, flags)) {
        if (parsed) skipped.push({ provider: parsed, reason: "disabled" });
        continue;
      }
      skipped.push({
        provider: parsed,
        reason: healthSkipReason(health.find((h) => h.provider === parsed)) ?? "not usable",
      });
    }
    throw new ChatTurnError(
      chatFailure(
        "NO_ELIGIBLE_PROVIDER",
        "No eligible provider is currently usable. Refresh health or open Settings.",
        {
          actions: ["refresh_health", "open_settings", "retry"],
          details: { skipped },
        },
      ),
    );
  }
  const preferred = parseAgentProvider(input.preferred);
  const reason =
    preferred && preferred !== next
      ? `AUTO selected ${next} (${healthSkipReason(health.find((h) => h.provider === preferred)) ?? "preferred unavailable"})`
      : `AUTO selected ${next}`;
  if (preferred && preferred !== next) {
    skipped.push({
      provider: preferred,
      reason: healthSkipReason(health.find((h) => h.provider === preferred)) ?? "skipped",
    });
  }
  return {
    provider: next,
    // Model/effort from another provider must not leak across; AUTO resets incompatible pins.
    model: preferred && preferred === next ? (input.model ?? null) : null,
    effort: preferred && preferred === next ? (input.effort ?? null) : null,
    strategy: input.strategy,
    health,
    skipped,
    reason,
  };
}

function providerOrder(defaultProvider: AgentProvider, preferred: string | null | undefined) {
  const pin = parseAgentProvider(preferred);
  const rest = AGENT_PROVIDERS.filter((p) => p !== pin && p !== defaultProvider);
  return [...(pin ? [pin] : []), defaultProvider, ...rest.filter((p) => p !== defaultProvider)];
}

function failureFromHealth(provider: AgentProvider, reason: string): ChatFailure {
  if (/quota/i.test(reason))
    return chatFailure("QUOTA_EXHAUSTED", `${provider}: ${reason}`, { provider });
  if (/auth|login|credential/i.test(reason))
    return chatFailure("AUTHENTICATION_REQUIRED", `${provider}: ${reason}`, { provider });
  return chatFailure("PROVIDER_UNAVAILABLE", `${provider}: ${reason}`, {
    provider,
    actions: ["refresh_health", "open_settings", "retry_other_provider"],
  });
}

/** Whether a post-start failure may try another eligible provider (never for permission denials). */
export function mayFallback(failure: ChatFailure, strategy: ProviderStrategy, fallbackEnabled: boolean) {
  if (failure.code === "PERMISSION_DENIED" || failure.code === "CANCELED") return false;
  if (strategy === "manual" && !fallbackEnabled) return false;
  return (
    strategy === "auto" ||
    fallbackEnabled ||
    [
      "PROVIDER_UNAVAILABLE",
      "AUTHENTICATION_REQUIRED",
      "QUOTA_EXHAUSTED",
      "RATE_LIMITED",
      "PROVIDER_STARTUP_TIMEOUT",
      "TURN_TIMEOUT",
      "INTERNAL_ERROR",
    ].includes(failure.code)
  );
}

export function asChatFailure(err: unknown, provider?: string | null): ChatFailure {
  if (err instanceof ChatTurnError) return err.failure;
  return classifyProviderError(err, provider);
}

export const ADMISSION = {
  maxProviderAttempts: 3,
  admissionTimeoutMs: 5_000,
  firstActivityMs: 60_000,
} as const;
