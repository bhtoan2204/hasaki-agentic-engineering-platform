import type pg from "pg";
import { pool, one, q, withTx, json } from "../db/pool.ts";
import { encryptSecret, decryptSecret } from "../auth/crypto.ts";

export const LEGACY_INTEGRATION_KEYS = [
  "argocd_token",
  "splunk_cookie",
  "kafka_ui_cookie",
  "vault_token",
] as const;

/** Explicit operator action after the credential owner has been verified. Never called during startup. */
export async function claimLegacyIntegrationCredentials(
  userId: number,
  keys: string[],
  db: pg.Pool = pool,
) {
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !keys.length ||
    keys.some(
      (key) => !LEGACY_INTEGRATION_KEYS.includes(key as (typeof LEGACY_INTEGRATION_KEYS)[number]),
    )
  ) {
    throw new Error("Provide an explicit user ID and supported integration credential keys");
  }
  return withTx(async (c) => {
    const owner = await one(c, "SELECT id, active, role FROM users WHERE id = $1 FOR UPDATE", [
      userId,
    ]);
    if (!owner?.active || owner.role !== "admin")
      throw new Error("Legacy credential claim requires a verified active administrator owner");
    const source = await q<{ key: string; value: string }>(
      c,
      "SELECT key, value FROM settings WHERE key = ANY($1) AND value <> '' ORDER BY key FOR UPDATE",
      [[...new Set(keys)]],
    );
    const moved: string[] = [];
    for (const { key, value } of source) {
      const existing = await one<{ ciphertext: string }>(
        c,
        "SELECT ciphertext FROM user_secrets WHERE user_id = $1 AND kind = $2 FOR UPDATE",
        [userId, key],
      );
      if (existing) {
        if (decryptSecret(existing.ciphertext) !== value)
          throw new Error(
            `Personal ${key} already exists and differs; it was not overwritten. Reconnect manually or review ownership.`,
          );
      } else {
        const ciphertext = encryptSecret(value);
        if (decryptSecret(ciphertext) !== value)
          throw new Error("Credential encryption verification failed");
        await q(c, "INSERT INTO user_secrets (user_id, kind, ciphertext) VALUES ($1, $2, $3)", [
          userId,
          key,
          ciphertext,
        ]);
      }
      // Preserve the settings row, with the complete credential now held in encrypted user storage.
      await q(c, "UPDATE settings SET value = '' WHERE key = $1", [key]);
      moved.push(key);
    }
    if (moved.length)
      await q(
        c,
        `INSERT INTO audit_log (actor_id, action, resource_type, resource_id, detail)
      VALUES ($1, 'integration.legacy_claim', 'user', $2, $3)`,
        [
          userId,
          String(userId),
          json({ keys: moved, source: "settings", storage: "encrypted user_secrets" }),
        ],
      );
    return { userId, moved };
  }, db);
}
