import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { ensureTestOwner } from "../src/auth/testOwner.ts";
import { decryptSecret } from "../src/auth/crypto.ts";
import { claimLegacyIntegrationCredentials } from "../src/integrations/legacy.ts";
import { resolveRepoPath } from "../src/repos/paths.ts";
import { expandRepoEntry } from "../src/repos/service.ts";
import { config } from "../src/config.ts";

before(() => migrate());
after(() => pool.end());

test("local checkout name survives another machine's shared layout; explicit mappings still win", () => {
  const root = join(process.env.TEST_ROOT!, "legacy-layout");
  mkdirSync(join(root, "oms-api", ".git"), { recursive: true });
  const repo = { name: "oms-api", path: "oms-src/oms-api" };
  const local = { ...config, reposRoot: root, repositories: {} };
  assert.equal(resolveRepoPath(repo, local), join(root, "oms-api"));
  assert.equal(resolveRepoPath(repo, { ...local, repositories: { "oms-api": "/explicit/oms-api" } }), "/explicit/oms-api");
  mkdirSync(join(root, "oms-src", "oms-api", ".git"), { recursive: true });
  assert.equal(resolveRepoPath(repo, local), join(root, "oms-src", "oms-api"));
});

test("explicit verified owner claim encrypts legacy credentials, clears global login and records audit", async () => {
  const userId = await ensureTestOwner();
  await q(pool, "INSERT INTO settings (key, value) VALUES ('splunk_cookie', 'fake-old-cookie')");
  assert.deepEqual(await claimLegacyIntegrationCredentials(userId, ["splunk_cookie"]), { userId, moved: ["splunk_cookie"] });
  const saved = await one(pool, "SELECT ciphertext FROM user_secrets WHERE user_id = $1 AND kind = 'splunk_cookie'", [userId]);
  assert.equal(decryptSecret(saved.ciphertext), "fake-old-cookie");
  assert.ok(!saved.ciphertext.includes("fake-old-cookie"));
  assert.equal((await one(pool, "SELECT value FROM settings WHERE key = 'splunk_cookie'")).value, "");
  assert.ok(await one(pool, "SELECT id FROM audit_log WHERE actor_id = $1 AND action = 'integration.legacy_claim'", [userId]));
  assert.deepEqual(await claimLegacyIntegrationCredentials(userId, ["splunk_cookie"]), { userId, moved: [] });
});

test("claim refuses overwrite and rolls back the whole credential transfer", async () => {
  const userId = await ensureTestOwner();
  await q(pool, "UPDATE settings SET value = 'different-source' WHERE key = 'splunk_cookie'");
  await q(pool, "INSERT INTO settings (key, value) VALUES ('argocd_token', 'fake-argo-token')");
  await assert.rejects(claimLegacyIntegrationCredentials(userId, ["argocd_token", "splunk_cookie"]), /not overwritten/);
  assert.equal(await one(pool, "SELECT 1 FROM user_secrets WHERE user_id = $1 AND kind = 'argocd_token'", [userId]), undefined);
  assert.equal((await one(pool, "SELECT value FROM settings WHERE key = 'argocd_token'")).value, "fake-argo-token");
  assert.equal((await one(pool, "SELECT value FROM settings WHERE key = 'splunk_cookie'")).value, "different-source");
  assert.equal(decryptSecret((await one(pool, "SELECT ciphertext FROM user_secrets WHERE user_id = $1 AND kind = 'splunk_cookie'", [userId])).ciphertext), "fake-old-cookie");
  await assert.rejects(claimLegacyIntegrationCredentials(userId, ["unsupported_key"]), /supported/);
});

test("group discovery excludes linked worktrees without excluding primary checkouts or submodules", () => {
  const group = join(config.reposRoot, "discovery");
  mkdirSync(join(group, "primary", ".git"), { recursive: true });
  const internal = join(group, "primary", ".git", "worktrees", "topic");
  mkdirSync(internal, { recursive: true });
  writeFileSync(join(internal, "commondir"), "../..\n");
  mkdirSync(join(group, "primary-topic"), { recursive: true });
  writeFileSync(join(group, "primary-topic", ".git"), `gitdir: ${internal}\n`);
  mkdirSync(join(group, "submodule"), { recursive: true });
  writeFileSync(join(group, "submodule", ".git"), "gitdir: ../primary/.git/modules/submodule\n");
  assert.deepEqual(expandRepoEntry("discovery").sort(), ["discovery/primary", "discovery/submodule"]);
});
