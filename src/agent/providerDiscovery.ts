import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config, codexConfig, antigravityConfig, copilotConfig } from "../config.ts";
import { currentUserId } from "../auth/execution.ts";
import { agentEnvironment } from "./environment.ts";
import { cursorBinary, cursorCapabilities } from "./cursor/run.ts";
import { codexCapabilities } from "./codex/run.ts";
import { antigravityCapabilities } from "./antigravity/capabilities.ts";
import { copilotCapabilities } from "./copilot/capabilities.ts";
import type { AgentProvider } from "./provider.ts";

export interface DiscoveredModel { slug: string; name: string; efforts?: string[] }
export interface ProviderDiscovery {
  models: DiscoveredModel[];
  available: boolean;
  discovery: "available" | "unavailable";
  discovered_at: string | null;
  cache: "probe" | "cache" | "stale";
  version?: string;
}
export type DiscoveryProbe = () => Promise<{ ok: boolean; models?: DiscoveredModel[]; version?: string }>;

/** Account/worker/executable keys are supplied by the adapter boundary. Failed refreshes retain the last catalog. */
export class DiscoveryCache {
  private entries = new Map<string, ProviderDiscovery>();
  private pending = new Map<string, Promise<ProviderDiscovery>>();
  private readonly now: () => number;
  private readonly ttl: number;
  constructor(now = Date.now, ttl = 300_000) { this.now = now; this.ttl = ttl; }
  async get(key: string, probe: DiscoveryProbe, refresh = false): Promise<ProviderDiscovery> {
    const old = this.entries.get(key);
    if (!refresh && old?.discovered_at && this.now() - Date.parse(old.discovered_at) < this.ttl)
      return { ...old, cache: "cache" };
    const running = this.pending.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        const result = await probe();
        if (!result.ok) throw new Error("Provider unavailable");
        const value: ProviderDiscovery = { available: true, models: result.models ?? [],
          discovery: result.models ? "available" : "unavailable", version: result.version,
          discovered_at: new Date(this.now()).toISOString(), cache: "probe" };
        this.entries.set(key, value);
        return value;
      } catch {
        return { available: false, models: old?.models ?? [], discovery: "unavailable" as const,
          discovered_at: old?.discovered_at ?? null, cache: old ? "stale" as const : "probe" as const };
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, job);
    return job;
  }
}
const catalogs = new DiscoveryCache();
async function claudeDiscovery() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  // Keep stdin open for control requests, without sending a model prompt.
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (!controller.signal.aborted)
          await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { done: true, value: undefined };
      },
    }),
  };
  const session = query({ prompt, options: {
    env: agentEnvironment(process.env, "claude"), tools: [], settingSources: [], persistSession: false,
    abortController: controller,
  } });
  try {
    const models = await session.supportedModels();
    return { ok: true, models: models.map((m) => ({ slug: m.value, name: m.displayName, efforts: m.supportedEffortLevels ?? [] })) };
  } finally { controller.abort(); session.close(); clearTimeout(timer); }
}
export async function discoverProvider(provider: AgentProvider, refresh = false) {
  const probes: Record<AgentProvider, { bin: string; probe: DiscoveryProbe }> = {
    claude: { bin: config.agent.claudeBin ?? "sdk", probe: claudeDiscovery },
    codex: { bin: codexConfig().bin, probe: async () => {
      const c = await codexCapabilities(refresh, { model: "", effort: "" });
      return { ...c, models: c.models?.map((m) => ({ ...m, name: m.slug })) };
    } },
    cursor: { bin: cursorBinary(), probe: async () => cursorCapabilities(refresh) },
    antigravity: { bin: antigravityConfig().bin, probe: async () => antigravityCapabilities(refresh, { model: "", effort: "" }) },
    copilot: { bin: copilotConfig().bin, probe: async () => copilotCapabilities(refresh, { model: "", effort: "" }) },
  };
  const adapter = probes[provider];
  return catalogs.get(`${provider}:${adapter.bin}:${config.instanceId}:${currentUserId() ?? "worker"}`, adapter.probe, refresh);
}
