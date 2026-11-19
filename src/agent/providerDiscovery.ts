import { isModelBlocked } from "./modelPolicy.ts";

export interface DiscoveredModel {
  slug: string;
  name: string;
  efforts?: string[];
}
export interface ProviderDiscovery {
  supportsModel?: boolean;
  models: DiscoveredModel[];
  available: boolean;
  discovery: "available" | "unavailable";
  discovered_at: string | null;
  cache: "probe" | "cache" | "stale";
  version?: string;
}
export type DiscoveryProbe = () => Promise<{
  ok: boolean;
  supportsModel?: boolean;
  models?: DiscoveredModel[];
  version?: string;
}>;

/** Account/worker/executable keys are supplied by the adapter boundary. Failed refreshes retain the last catalog. */
export class DiscoveryCache {
  private entries = new Map<string, ProviderDiscovery>();
  private pending = new Map<string, Promise<ProviderDiscovery>>();
  private readonly now: () => number;
  private readonly ttl: number;
  constructor(now = Date.now, ttl = 300_000) {
    this.now = now;
    this.ttl = ttl;
  }
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
        const value: ProviderDiscovery = {
          supportsModel: result.supportsModel,
          available: true,
          // Blocked models are never offered for selection.
          models: (result.models ?? []).filter(
            (m) => !isModelBlocked(m.slug) && !isModelBlocked(m.name),
          ),
          discovery: result.models ? "available" : "unavailable",
          version: result.version,
          discovered_at: new Date(this.now()).toISOString(),
          cache: "probe",
        };
        this.entries.set(key, value);
        return value;
      } catch {
        return {
          supportsModel: old?.supportsModel,
          available: false,
          models: old?.models ?? [],
          discovery: "unavailable" as const,
          discovered_at: old?.discovered_at ?? null,
          cache: old ? ("stale" as const) : ("probe" as const),
        };
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, job);
    return job;
  }
}
