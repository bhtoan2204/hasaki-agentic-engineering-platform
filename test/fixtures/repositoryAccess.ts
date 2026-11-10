/**
 * Test fixture for suites that are about execution, not repository authorization (engine, code intelligence,
 * analytics, remotes ...). Since migration 045 access is deny-by-default; these suites opt into the two explicit,
 * documented policies an installation could choose, instead of a bypass in production code:
 *  - every (non-benchmark) repository registered in this test database is shared with every user, now and later;
 *  - Bitbucket verification is "trusted" (platform grants are not cross-checked against Bitbucket).
 * Authorization itself is covered by test/repository-access.test.ts.
 */
import { pool } from "../../src/db/pool.ts";
import { config } from "../../src/config.ts";

export async function shareAllRepositoriesForTests() {
  await pool.query("ALTER TABLE repositories ALTER COLUMN shared_access SET DEFAULT 'pull_request'");
  await pool.query("UPDATE repositories SET shared_access = 'pull_request' WHERE provider <> 'benchmark' AND shared_access <> 'pull_request'");
  config.bitbucket.accessVerification = "trusted";
}
