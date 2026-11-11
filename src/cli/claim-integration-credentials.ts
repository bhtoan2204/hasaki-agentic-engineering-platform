/** Only after explicit verification of the old credential's owner:
 * node --env-file=.env src/cli/claim-integration-credentials.ts --user-id 1 --kind splunk_cookie
 * No credential values are accepted in argv or printed.
 */
import { pool } from "../db/pool.ts";
import { claimLegacyIntegrationCredentials } from "../integrations/legacy.ts";
const args = process.argv.slice(2);
let userId: number | undefined;
const keys: string[] = [];
try {
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--user-id") userId = Number(args[i + 1]);
    else if (args[i] === "--kind" && args[i + 1]) keys.push(args[i + 1]);
    else
      throw new Error(
        "Usage: --user-id <verified-admin-id> --kind <integration-key> [--kind <integration-key>]",
      );
  }
  if (!userId) throw new Error("An explicit verified --user-id is required");
  console.log(JSON.stringify(await claimLegacyIntegrationCredentials(userId, keys)));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
