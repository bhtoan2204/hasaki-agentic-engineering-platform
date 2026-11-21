import { z } from "zod";
import { one, pool, q, withTx, type Db } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { AGENT_PROVIDERS, parseAgentProvider, type AgentProvider } from "./provider.ts";
import {
  convertLegacyConfiguration,
  legacyAgentConfiguration,
  parseAgentConfiguration,
  patchProviderConfiguration,
  refreshEnvironmentDefaults,
  type AgentConfiguration,
} from "./configuration.ts";

const KEY = "agent_configuration";
/** Legacy API inputs are a normalization delegate, never a second execution source. */
export async function importLegacyAgentPatch(db: Db, patch: Record<string, unknown>) {
  await loadAgentConfiguration(db);
  const row = await one<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
    [KEY],
  );
  const original = parseAgentConfiguration(JSON.parse(row!.value));
  const next = convertLegacyConfiguration(original, patch);
  for (const provider of AGENT_PROVIDERS)
    if (JSON.stringify(next.providers[provider]) !== JSON.stringify(original.providers[provider]))
      next.providers[provider].revision = original.providers[provider].revision + 1;
  if (next.default_provider !== original.default_provider)
    next.default_revision = (original.default_revision ?? 0) + 1;
  await q(db, "UPDATE settings SET value=$2 WHERE key=$1", [KEY, JSON.stringify(next)]);
}
/** Read from the shared table on every boundary. No process-global routing cache. */
export async function loadAgentConfiguration(db?: Db): Promise<AgentConfiguration> {
  if (!db) {
    // The document exists after the first load: one read, without holding a transaction (BEGIN/COMMIT and a pool
    // connection for the duration) on every chat turn and completion. Only the one-time legacy import needs the lock.
    const row = await one<{ value: string }>(pool, "SELECT value FROM settings WHERE key=$1", [
      KEY,
    ]);
    if (row) return refreshEnvironmentDefaults(parseAgentConfiguration(JSON.parse(row.value)));
    return withTx((c) => loadAgentConfiguration(c));
  }
  const row = await one<{ value: string }>(db, "SELECT value FROM settings WHERE key=$1", [KEY]);
  if (row) return refreshEnvironmentDefaults(parseAgentConfiguration(JSON.parse(row.value)));
  const old = await one<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE key='operator' FOR SHARE",
  );
  const legacy = old?.value ? z.record(z.string(), z.unknown()).parse(JSON.parse(old.value)) : {};
  const imported = convertLegacyConfiguration(legacyAgentConfiguration(), legacy);
  // Another transaction may import first. Read its authoritative document after the insert resolves.
  await q(db, "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING", [
    KEY,
    JSON.stringify(imported),
  ]);
  const saved = await one<{ value: string }>(db, "SELECT value FROM settings WHERE key=$1", [KEY]);
  return refreshEnvironmentDefaults(parseAgentConfiguration(JSON.parse(saved!.value)));
}

export async function saveProviderConfiguration(
  provider: AgentProvider,
  revision: number,
  patch: unknown,
) {
  return withTx(async (db) => {
    await loadAgentConfiguration(db);
    const row = await one<{ value: string }>(
      db,
      "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
      [KEY],
    );
    let next: AgentConfiguration;
    try {
      next = patchProviderConfiguration(
        parseAgentConfiguration(JSON.parse(row!.value)),
        provider,
        revision,
        patch,
      );
    } catch (error) {
      throw new HttpError(
        /revision conflict/.test(String(error)) ? 409 : 400,
        (error as Error).message,
      );
    }
    await q(db, "UPDATE settings SET value=$2 WHERE key=$1", [KEY, JSON.stringify(next)]);
    return next;
  });
}

export async function saveDefaultProvider(raw: unknown) {
  const input = z
    .object({ provider: z.string(), revision: z.number().int().nonnegative() })
    .strict()
    .parse(raw);
  const provider = parseAgentProvider(input.provider);
  if (!provider) throw new HttpError(400, "Unknown provider");
  return withTx(async (db) => {
    await loadAgentConfiguration(db);
    const row = await one<{ value: string }>(
      db,
      "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
      [KEY],
    );
    const next = parseAgentConfiguration(JSON.parse(row!.value));
    if ((next.default_revision ?? 0) !== input.revision)
      throw new HttpError(409, "Default provider revision conflict");
    next.default_provider = provider;
    next.default_revision = input.revision + 1;
    parseAgentConfiguration(next);
    await q(db, "UPDATE settings SET value=$2 WHERE key=$1", [KEY, JSON.stringify(next)]);
    return next;
  });
}
