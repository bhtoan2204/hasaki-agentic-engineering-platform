import { one, pool, type Db } from "../db/pool.ts";

/** settings key written by migration 112. */
export const INSTALLATION_SETTING = "shared_results.installation_id";

let cached: string | null = null;
/**
 * The scope of every shared-result key: the installation id (a UUID created once, by the migration). It is not the
 * per-machine instance id: every instance sharing the database must produce the same keys.
 */
export async function installationId(db: Db = pool): Promise<string> {
  if (cached) return cached;
  const row = await one<{ value: string }>(db, "SELECT value FROM settings WHERE key = $1", [
    INSTALLATION_SETTING,
  ]);
  if (!row?.value)
    throw new Error("shared results scope is missing: migration 112 has not been applied");
  return (cached = row.value);
}
/** Tests: forget the cached id. */
export const resetInstallationIdForTests = () => void (cached = null);
