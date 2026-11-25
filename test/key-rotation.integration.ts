import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { decryptDetailed, keyRing } from "../src/auth/crypto.ts";
import { rotateSecrets, verifySecrets } from "../src/auth/rotation.ts";
import {
  getSharedSecret,
  getUserSecret,
  putSharedSecret,
  putUserSecret,
} from "../src/auth/secrets.ts";
import { forgetUserSessions } from "../src/auth/sessionCache.ts";
import { createUser } from "../src/auth/users.ts";
import { pool, q } from "../src/db/pool.ts";
import { handle } from "../src/http/app.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";

const OLD = "rotation-old-secret-0123456789";
const NEW = "rotation-new-secret-9876543210";
const original = {
  secret: process.env.AUTH_SECRET,
  previous: process.env.AUTH_SECRET_PREVIOUS,
  format: process.env.AUTH_CIPHERTEXT_FORMAT,
};

function useKeys(current: string, previous?: string, format?: string) {
  process.env.AUTH_SECRET = current;
  if (previous) process.env.AUTH_SECRET_PREVIOUS = previous;
  else delete process.env.AUTH_SECRET_PREVIOUS;
  if (format) process.env.AUTH_CIPHERTEXT_FORMAT = format;
  else delete process.env.AUTH_CIPHERTEXT_FORMAT;
}

/** What the platform wrote before key ids existed, written independently of the code under test. */
function legacyCiphertext(secret: string, plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

let userId: number;
let server: Server;
let base: string;
const username = "rotation-admin";
const password = "rotation-test-password";
const kinds = ["hasaki_token", "github_token", "bitbucket_token"];

const stored = async () =>
  new Map(
    (
      await q<{ k: string; ciphertext: string }>(
        pool,
        "SELECT 'u:' || user_id || ':' || kind AS k, ciphertext FROM user_secrets UNION ALL SELECT 's:' || kind, ciphertext FROM shared_secrets",
      )
    ).map((r) => [r.k, r.ciphertext]),
  );

before(async () => {
  useKeys(OLD);
  userId = (await createUser({ username, password, role: "admin" })).id;
  // Old-format rows, exactly as a deployment from before this change has them.
  for (const kind of kinds)
    await q(pool, "INSERT INTO user_secrets(user_id, kind, ciphertext) VALUES ($1, $2, $3)", [
      userId,
      kind,
      legacyCiphertext(OLD, `plain-${kind}`),
    ]);
  await q(pool, "INSERT INTO shared_secrets(kind, ciphertext) VALUES ('splunk_token', $1)", [
    legacyCiphertext(OLD, "shared-plain"),
  ]);
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [name, value] of Object.entries(original)) {
    const env = {
      secret: "AUTH_SECRET",
      previous: "AUTH_SECRET_PREVIOUS",
      format: "AUTH_CIPHERTEXT_FORMAT",
    }[name]!;
    if (value === undefined) delete process.env[env];
    else process.env[env] = value;
  }
  await pool.end();
});

test("values stored before key ids existed are still readable", async () => {
  useKeys(OLD);
  for (const kind of kinds) assert.equal(await getUserSecret(userId, kind), `plain-${kind}`);
  assert.equal(await getSharedSecret("splunk_token"), "shared-plain");
});

test("dry run reports the work and changes nothing", async () => {
  useKeys(NEW, OLD, "v2");
  const before = await stored();
  const reports = await rotateSecrets({ dryRun: true });
  assert.deepEqual(
    reports.map((r) => [r.table, r.scanned, r.rewritten, r.failed]),
    [
      ["user_secrets", 3, 3, 0],
      ["shared_secrets", 1, 1, 0],
    ],
  );
  assert.deepEqual(await stored(), before);
});

test("rotation re-encrypts in batches under the new key and every value still reads", async () => {
  useKeys(NEW, OLD, "v2");
  const stamps = () =>
    q<{ updated_at: string }>(pool, "SELECT updated_at FROM user_secrets ORDER BY kind").then(
      (rows) => rows.map((r) => String(r.updated_at)),
    );
  const stampsBefore = await stamps();
  const reports = await rotateSecrets({ batchSize: 2 });
  assert.deepEqual(
    await stamps(),
    stampsBefore,
    "updated_at keeps meaning 'when the user changed it'",
  );
  assert.deepEqual(
    reports.map((r) => [r.table, r.scanned, r.rewritten, r.alreadyCurrent, r.failed]),
    [
      ["user_secrets", 3, 3, 0, 0],
      ["shared_secrets", 1, 1, 0, 0],
    ],
  );
  const kid = keyRing().current.kid;
  for (const value of (await stored()).values()) assert.ok(value.startsWith(`v2:${kid}:`), value);
  for (const kind of kinds) assert.equal(await getUserSecret(userId, kind), `plain-${kind}`);
  assert.equal(await getSharedSecret("splunk_token"), "shared-plain");
});

test("running it again changes nothing (idempotent)", async () => {
  useKeys(NEW, OLD, "v2");
  const before = await stored();
  const reports = await rotateSecrets();
  assert.deepEqual(
    reports.map((r) => [r.rewritten, r.alreadyCurrent, r.failed]),
    [
      [0, 3, 0],
      [0, 1, 0],
    ],
  );
  assert.deepEqual(await stored(), before);
});

test("once the old key is dropped the rotated values still read", async () => {
  useKeys(NEW, undefined, "v2");
  for (const kind of kinds) assert.equal(await getUserSecret(userId, kind), `plain-${kind}`);
});

test("a wrong or missing key fails with a clear error and loses nothing", async () => {
  useKeys(OLD, undefined, "v2");
  await assert.rejects(
    getUserSecret(userId, "hasaki_token"),
    /not configured: add the old secret to AUTH_SECRET_PREVIOUS/,
  );
  useKeys(NEW, undefined, "v2");
  await q(pool, "INSERT INTO user_secrets(user_id, kind, ciphertext) VALUES ($1, 'orphan', $2)", [
    userId,
    legacyCiphertext(OLD, "orphan-plain"),
  ]);
  await assert.rejects(
    getUserSecret(userId, "orphan"),
    /no configured key decrypts this stored secret/,
  );
  await q(
    pool,
    "INSERT INTO user_secrets(user_id, kind, ciphertext) VALUES ($1, 'garbage', 'AAAA')",
    [userId],
  );

  // The CLI logic reports both, rewrites nothing for them, and still converts the healthy rows.
  const orphanBefore = (await stored()).get(`u:${userId}:orphan`);
  const reports = await rotateSecrets();
  const users = reports.find((r) => r.table === "user_secrets")!;
  assert.equal(users.failed, 2);
  assert.equal(users.rewritten, 0);
  assert.equal((await stored()).get(`u:${userId}:orphan`), orphanBefore);
  assert.match(users.failures.join("\n"), /orphan.*no configured key/);

  // With the old key listed again, the orphan is rescued; nothing was lost.
  useKeys(NEW, OLD, "v2");
  const rescue = await rotateSecrets();
  assert.equal(rescue.find((r) => r.table === "user_secrets")!.rewritten, 1);
  assert.equal(await getUserSecret(userId, "orphan"), "orphan-plain");
  await q(pool, "DELETE FROM user_secrets WHERE kind IN ('orphan', 'garbage') AND user_id = $1", [
    userId,
  ]);
});

test("verify counts values per key and reports workspace checkpoints separately", async () => {
  useKeys(NEW, OLD, "v2");
  await definitions.create({
    key: "rotation-verify",
    spec: { name: "Rotation verify", steps: [{ key: "input", type: "human_input" }] },
  });
  const run = await startRun({ definitionKey: "rotation-verify", ownerId: userId });
  const insert = (content: string) =>
    q(
      pool,
      "INSERT INTO workflow_artifacts(run_id, kind, name, content) VALUES ($1, 'execution_checkpoint_workspace', 'ws', $2)",
      [run.id, content],
    );
  await insert(legacyCiphertext(OLD, "snapshot-1"));
  await insert((await stored()).get(`s:splunk_token`)!);
  const report = await verifySecrets();
  const kid = keyRing().current.kid;
  const oldKid = keyRing().all[1].kid;
  assert.deepEqual(report.tables.find((t) => t.table === "user_secrets")!.byKey, {
    [`v2:${kid}`]: 3,
  });
  assert.equal(
    report.tables.reduce((n, t) => n + t.failed, 0),
    0,
  );
  assert.deepEqual(report.checkpoints.byKey, { [`legacy:${oldKid}`]: 1, [`v2:${kid}`]: 1 });
  assert.equal(report.checkpoints.failed, 0);

  // Dropping the old key makes the legacy checkpoint undecryptable, and verify says so.
  useKeys(NEW, undefined, "v2");
  const dropped = await verifySecrets();
  assert.equal(dropped.checkpoints.failed, 1);
});

test("--format legacy converts back, under the current key", async () => {
  useKeys(NEW, OLD, "v2");
  const reports = await rotateSecrets({ format: "legacy" });
  assert.equal(
    reports.reduce((n, r) => n + r.rewritten, 0),
    4,
  );
  for (const value of (await stored()).values()) assert.ok(!value.startsWith("v2:"));
  useKeys(NEW);
  for (const kind of kinds) assert.equal(await getUserSecret(userId, kind), `plain-${kind}`);
  assert.equal(decryptDetailed((await stored()).get(`s:splunk_token`)!).kid, keyRing().current.kid);
  // New writes follow the configured format.
  useKeys(NEW, undefined, "v2");
  await putSharedSecret("splunk_token", "again");
  assert.match((await stored()).get("s:splunk_token")!, /^v2:/);
  await putUserSecret(userId, "hasaki_token", "again-user");
  assert.equal(await getUserSecret(userId, "hasaki_token"), "again-user");
});

test("a session created before a rotation keeps working while the old key is listed", async () => {
  useKeys(OLD);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  await login.arrayBuffer();
  const me = () =>
    fetch(`${base}/api/auth/me`, { headers: { cookie } }).then(
      async (r) => (await r.arrayBuffer(), r.status),
    );

  useKeys(NEW, OLD);
  forgetUserSessions(userId);
  assert.equal(await me(), 200, "old-key session after rotation");

  useKeys(NEW);
  forgetUserSessions(userId);
  assert.equal(await me(), 401, "once the old key is dropped that session is gone");
});

test("the CLI prints counts, honours --dry-run and exits non-zero when a value cannot be decrypted", async () => {
  useKeys(NEW, OLD, "v2");
  await rotateSecrets(); // start from a fully rotated database
  await q(
    pool,
    "UPDATE user_secrets SET ciphertext = $2 WHERE user_id = $1 AND kind = 'github_token'",
    [userId, legacyCiphertext(OLD, "cli-plain")],
  );
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/cli/rotate-keys.ts", ...args],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
  const keys = { AUTH_SECRET: NEW, AUTH_SECRET_PREVIOUS: OLD, AUTH_CIPHERTEXT_FORMAT: "v2" };
  const before = await stored();
  const dry = run(["--dry-run"], keys);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /user_secrets: scanned=\d+ would-rewrite=1 /);
  assert.match(dry.stdout, /dry run: nothing was written/);
  assert.deepEqual(await stored(), before);

  const real = run([], keys);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /user_secrets: scanned=\d+ rewritten=1 /);
  assert.equal(await getUserSecret(userId, "github_token"), "cli-plain");
  const again = run([], keys);
  assert.match(again.stdout, /rewritten=0 /);

  // Without the old key a legacy value is undecryptable: reported, exit code 1.
  await q(
    pool,
    "UPDATE user_secrets SET ciphertext = $2 WHERE user_id = $1 AND kind = 'github_token'",
    [userId, legacyCiphertext(OLD, "cli-plain")],
  );
  const missing = run(["--verify"], {
    AUTH_SECRET: NEW,
    AUTH_SECRET_PREVIOUS: "",
    AUTH_CIPHERTEXT_FORMAT: "v2",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /undecryptable=1/);
  assert.equal(run(["--format", "v9"], keys).status, 1);
});
