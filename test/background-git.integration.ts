/**
 * Background Git sync by consent: work nobody started in person runs as a user who opted in, with that user's own
 * token, only for repositories that user can read; revoking the consent (or losing the token or the access) stops the
 * next job, which then indexes only the checkout already in the workspace (never contacting the remote).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { putUserSecret } from "../src/auth/secrets.ts";
import { repositories } from "../src/repos/service.ts";
import {
  backgroundDelegate,
  backgroundGitStatus,
  setBackgroundGit,
} from "../src/repos/backgroundGit.ts";
import { diagnostic, enqueue, runIndexOnce } from "../src/codeIntelligence/indexer.ts";

let alice = 0;
let bob = 0;
const NAME = "bg-sync-repo";

before(async () => {
  config.codeIntelligence.enabled = true;
  // Grants are not cross-checked against Bitbucket here (the documented "trusted" policy); access itself is the grant.
  config.bitbucket.accessVerification = "trusted";
  alice = (
    await createUser({
      username: `bg-alice-${Date.now()}`,
      password: "local-test-password",
      role: "member",
    })
  ).id;
  bob = (
    await createUser({
      username: `bg-bob-${Date.now()}`,
      password: "local-test-password",
      role: "member",
    })
  ).id;
  await q(
    pool,
    `INSERT INTO repositories (name, provider, remote_slug, repository_url, shared_access)
     VALUES ($1, 'bitbucket', 'team/bg-sync-repo', 'https://bitbucket.org/team/bg-sync-repo.git', 'none')`,
    [NAME],
  );
});
after(async () => {
  config.codeIntelligence.enabled = false;
  await pool.end();
});

const repo = async () => (await repositories.get(NAME))!;
const grantRead = (userId: number) =>
  q(
    pool,
    `INSERT INTO user_repository_access (user_id, repository_id, can_read)
     SELECT $1, id, true FROM repositories WHERE name = $2`,
    [userId, NAME],
  );

test("a delegate needs consent, a token for the host and read access — all three", async () => {
  assert.equal(await backgroundDelegate(await repo()), null, "nobody consented");
  await setBackgroundGit(alice, true);
  assert.deepEqual(await backgroundGitStatus(alice), { enabled: true, hosts: [] });
  assert.equal(await backgroundDelegate(await repo()), null, "consent without a Bitbucket token");
  await putUserSecret(alice, "bitbucket_user", "alice@example.com");
  await putUserSecret(alice, "bitbucket_token", "token-of-alice");
  assert.equal(
    await backgroundDelegate(await repo()),
    null,
    "token, but no read access to the repository",
  );
  await grantRead(alice);
  assert.equal(await backgroundDelegate(await repo()), alice);
  // Bob can read and has a token, but did not consent: never chosen.
  await putUserSecret(bob, "bitbucket_user", "bob@example.com");
  await putUserSecret(bob, "bitbucket_token", "token-of-bob");
  await grantRead(bob);
  await setBackgroundGit(alice, false);
  assert.equal(await backgroundDelegate(await repo()), null);
});

test("background indexing runs as the consenting user; after revocation it never contacts the remote", async () => {
  await setBackgroundGit(alice, true);
  const job = await enqueue(NAME); // no user in context: startup / idle
  const [row] = await q<{ requested_by: number; delegated: boolean }>(
    pool,
    "SELECT requested_by, delegated FROM code_intelligence.runs WHERE id = $1",
    [job!.id],
  );
  assert.deepEqual(row, { requested_by: alice, delegated: true });

  await setBackgroundGit(alice, false); // revoked before the job runs
  await runIndexOnce();
  const [after] = await q<{ error: string | null }>(
    pool,
    "SELECT error FROM code_intelligence.runs WHERE id = $1",
    [job!.id],
  );
  // Not "authentication required": with no account the job did not try the remote and reports the missing checkout.
  assert.match(
    after.error ?? "",
    /Not in the platform workspace yet and no account for background sync/,
  );
});

test("an indexing failure says what is missing", () => {
  assert.match(
    diagnostic(
      new Error("Bitbucket authentication required: save personal credentials in Integrations"),
    ),
    /needs Git credentials/,
  );
  assert.match(
    diagnostic(new Error("Repository x unavailable locally; configure repositories.x")),
    /platform workspace/,
  );
});
