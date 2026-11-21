import { handoffReadiness } from "./handoff.ts";
import {
  AGENT_PROVIDERS,
  parseAgentProvider,
  providerEnabled,
  type AgentProvider,
  type ProviderFlags,
} from "./provider.ts";
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
  flags?: ProviderFlags,
): AgentProvider | null {
  for (const provider of order) {
    if (avoid.has(provider)) continue;
    const parsed = parseAgentProvider(provider);
    if (!parsed || !providerEnabled(parsed, flags)) continue;
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
        reason: !ready.ok ? ready.error : quota === "exhausted" ? "quota exhausted" : undefined,
      } satisfies AgentHealth;
    }),
  );
}

/**
 * Readiness shared by concurrent callers and reused for a few seconds. A probe starts every provider's readiness
 * check — `claude auth status` alone is a ~0.3 s, ~150 MiB process — so probing on every chat admission put that cost
 * in front of every first answer and multiplied it by the number of turns starting together. Remembered quota is
 * applied on every read (it changes when a call fails, not when the probe runs). Invalidated when a call fails as
 * unavailable or unauthenticated, and by an explicit health refresh.
 */
export const HEALTH_REUSE_MS = 10_000;
let shared: { at: number; rows: Promise<AgentHealth[]> } | null = null;
let prober: () => Promise<AgentHealth[]> = () => probeAgentHealth();

export async function sharedAgentHealth(): Promise<AgentHealth[]> {
  if (!shared || Date.now() - shared.at > HEALTH_REUSE_MS) {
    const rows = prober();
    const entry = { at: Date.now(), rows };
    shared = entry;
    rows.catch(() => {
      if (shared === entry) shared = null;
    });
  }
  const rows = await shared.rows;
  return rows.map((h) =>
    h.quota !== "exhausted" && rememberedQuota(h.provider) === "exhausted"
      ? { ...h, quota: "exhausted" as const, reason: h.reason ?? "quota exhausted" }
      : h,
  );
}

export function invalidateSharedAgentHealth() {
  shared = null;
}

/** A fresh probe made elsewhere (the provider status page, "Refresh health") becomes the shared reading. */
export function primeSharedAgentHealth(rows: AgentHealth[]) {
  shared = { at: Date.now(), rows: Promise.resolve(rows) };
}

/** Benchmarks and tests: replace what a shared probe runs (the reuse above still applies). */
export function setSharedHealthProber(fn: (() => Promise<AgentHealth[]>) | undefined) {
  if (process.env.PLATFORM_TEST !== "1") throw new Error("Health prober override disabled");
  prober = fn ?? (() => probeAgentHealth());
  shared = null;
}
