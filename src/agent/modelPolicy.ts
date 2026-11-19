import { config } from "../config.ts";

/**
 * Platform-wide model blocklist (`agent.blockedModels`, case-insensitive substrings; default: Fable). Enforced where a
 * model is chosen (configuration documents, step/run/chat selection), where models are offered (provider catalogs) and
 * where a provider reports the model it actually runs — an account/CLI default included — so no path can use one.
 */
export const blockedModelPatterns = () =>
  (config.agent.blockedModels ?? ["fable"]).map((p) => p.trim().toLowerCase()).filter(Boolean);

export function isModelBlocked(model: string | null | undefined) {
  const m = String(model ?? "").toLowerCase();
  return !!m && blockedModelPatterns().some((p) => m.includes(p));
}

export class BlockedModelError extends Error {}

export function assertModelAllowed(model: string | null | undefined, where: string) {
  if (isModelBlocked(model))
    throw new BlockedModelError(
      `model "${model}" is blocked by platform policy (agent.blockedModels) — ${where}; choose another model`,
    );
}
