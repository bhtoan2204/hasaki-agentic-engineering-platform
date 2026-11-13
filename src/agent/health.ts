import { handoffReadiness } from "./handoff.ts";
import { AGENT_PROVIDERS, type AgentProvider } from "./provider.ts";
import type { EffectiveAgent } from "./stepAgent.ts";

const QUOTA_TTL_MS = 30 * 60_000;
const quotaUntil = new Map<string, number>();

export interface AgentHealth {
  provider: AgentProvider;
  connected: boolean;
  /** `unknown` is still usable: quota is often visible only after a request fails. */
  quota: "ok" | "exhausted" | "unknown";
  reason?: string;
}

export function rememberProviderQuota(provider: string, ttlMs = QUOTA_TTL_MS) {
  quotaUntil.set(provider, Date.now() + ttlMs);
}

export function rememberedQuota(provider: string): "exhausted" | "unknown" {
  const until = quotaUntil.get(provider);
  return until != null && until > Date.now() ? "exhausted" : "unknown";
}

export function clearProviderHealthForTests() {
  if (process.env.PLATFORM_TEST !== "1") throw new Error("Health reset disabled");
  quotaUntil.clear();
}

export function isUsableAgent(health: AgentHealth | undefined) {
  return !!health && health.connected && health.quota !== "exhausted";
}

export function healthSkipReason(health: AgentHealth | undefined) {
  if (!health) return "health unknown";
  if (!health.connected) return health.reason ?? "not connected";
  if (health.quota === "exhausted") return health.reason ?? "quota exhausted";
  return null;
}

/** First provider in priority order that is connected and not out of quota. */
export function nextHealthyProvider(
  order: readonly string[],
  avoid: ReadonlySet<string>,
  health: readonly AgentHealth[],
): AgentProvider | null {
  for (const provider of order) {
    if (avoid.has(provider)) continue;
    const row = health.find((h) => h.provider === provider);
    if (isUsableAgent(row)) return row!.provider;
  }
  return null;
}

function stubAgent(provider: AgentProvider): EffectiveAgent {
  return {
    provider,
    model: null,
    reasoning_effort: null,
    execution_profile: "STANDARD",
    source: "health",
  };
}

/** Login and known quota only. Does not call a model or spend tokens. */
export async function probeAgentHealth(
  providers: readonly AgentProvider[] = AGENT_PROVIDERS,
): Promise<AgentHealth[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const until = quotaUntil.get(provider);
      const remembered = until != null && until > Date.now();
      const ready = await handoffReadiness(stubAgent(provider));
      const quota =
        remembered || ready.quota === "exhausted"
          ? "exhausted"
          : ready.quota === "ok"
            ? "ok"
            : "unknown";
      return {
        provider,
        connected: ready.ok,
        quota,
        reason: !ready.ok
          ? ready.error
          : quota === "exhausted"
            ? "quota exhausted"
            : undefined,
      } satisfies AgentHealth;
    }),
  );
}
