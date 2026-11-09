import { pool, q, one } from "../db/pool.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";

export async function putUserSecret(userId: number, kind: string, plain: string) {
  const ciphertext = encryptSecret(plain);
  await q(
    pool,
    `INSERT INTO user_secrets (user_id, kind, ciphertext) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = now()`,
    [userId, kind, ciphertext],
  );
}

export async function getUserSecret(userId: number, kind: string): Promise<string | null> {
  const row = await one<{ ciphertext: string }>(pool, "SELECT ciphertext FROM user_secrets WHERE user_id = $1 AND kind = $2", [userId, kind]);
  if (!row) return null;
  return decryptSecret(row.ciphertext);
}

export async function deleteUserSecret(userId: number, kind: string) {
  await q(pool, "DELETE FROM user_secrets WHERE user_id = $1 AND kind = $2", [userId, kind]);
}

export async function putSharedSecret(kind: string, plain: string) {
  const ciphertext = encryptSecret(plain);
  await q(
    pool,
    `INSERT INTO shared_secrets (kind, ciphertext) VALUES ($1, $2)
     ON CONFLICT (kind) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = now()`,
    [kind, ciphertext],
  );
}

export async function getSharedSecret(kind: string): Promise<string | null> {
  const row = await one<{ ciphertext: string }>(pool, "SELECT ciphertext FROM shared_secrets WHERE kind = $1", [kind]);
  if (!row) return null;
  return decryptSecret(row.ciphertext);
}

export async function usersWithSecret(kind: string): Promise<Array<{ id: number; active: boolean }>> {
  return q(pool, `SELECT u.id, u.active FROM user_secrets s JOIN users u ON u.id = s.user_id WHERE s.kind = $1`, [kind]);
}
