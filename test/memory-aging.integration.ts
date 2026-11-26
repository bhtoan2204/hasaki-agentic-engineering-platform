import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { insertSnapshot } from "../src/context/repository.ts";
import { repositories } from "../src/repos/service.ts";
import { knowledge } from "../src/knowledge/service.ts";
import {
  restoreMemory,
  resetMemoryAgingThrottle,
  runMemoryAging,
  unpinMemory,
  restoreProcedureIfArchived,
} from "../src/knowledge/aging.ts";
import {
  dormantKeys,
  noteKnowledgeUsage,
  recordKnowledgeUsage,
} from "../src/knowledge/agingUsage.ts";
import { learnProcedure } from "../src/chat/memory.ts";
import { runtimeMetricsSnapshot } from "../src/runtimeMetrics.ts";
import { settleBackground } from "../src/workflow/background.ts";

const REPO = "aging-svc";
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: ENV }).trim();
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

let owner: number, other: number, shaA: string, shaB: string;
let seq = 0;
const runs: number[] = [];

before(async () => {
  await migrate();
  owner = (
    await createUser({ username: "aging-owner", password: "aging-owner-password", role: "member" })
  ).id;
  other = (
    await createUser({ username: "aging-other", password: "aging-other-password", role: "member" })
  ).id;
  // origin + clone: task A edits a.go and base edits a.go afterwards (STALE); task B edits b.go only (FRESH).
  const root = mkdtempSync(join(tmpdir(), "aging-"));
  const origin = join(root, "o.git");
  const clone = join(config.reposRoot, REPO);
  mkdirSync(config.reposRoot, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "release/prod", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, clone], { env: ENV });
  sh(clone, "checkout", "-qb", "release/prod");
  writeFileSync(join(clone, "a.go"), "package a\n");
  writeFileSync(join(clone, "b.go"), "package a\n");
  sh(clone, "add", ".");
  sh(clone, "commit", "-qm", "base");
  sh(clone, "push", "-q", "origin", "release/prod");
  for (const [branch, file] of [
    ["task-a", "a.go"],
    ["task-b", "b.go"],
  ]) {
    sh(clone, "checkout", "-qb", branch, "release/prod");
    writeFileSync(join(clone, file), `package a\n// ${branch}\n`);
    sh(clone, "commit", "-qam", branch);
  }
  shaA = sh(clone, "rev-parse", "task-a");
  shaB = sh(clone, "rev-parse", "task-b");
  sh(clone, "checkout", "-q", "release/prod");
  writeFileSync(join(clone, "a.go"), "package a\n// edited on the base later\n");
  sh(clone, "commit", "-qam", "base edits a.go");
  sh(clone, "push", "-q", "origin", "release/prod");
  sh(clone, "fetch", "-q", "origin");
  await repositories.upsert(REPO, { projects: ["AGING"] });
  await definitions.create({
    key: "aging-fixture",
    spec: { name: "aging", steps: [{ key: "only", type: "agent" }] },
  });
  for (let i = 0; i < 4; i++)
    runs.push(
      Number((await startRun({ definitionKey: "aging-fixture", ownerId: owner, start: false })).id),
    );
});
after(async () => {
  await settleBackground();
  await pool.end();
});
beforeEach(async () => {
  resetMemoryAgingThrottle();
  for (const k of Object.keys(config.memoryAging))
    delete (config.memoryAging as Record<string, unknown>)[k];
  await q(pool, "DELETE FROM knowledge_items WHERE category = 'task_memory'");
  await q(pool, "DELETE FROM knowledge_audit WHERE item_key LIKE 'memory.%'");
});

async function make(
  key: string,
  memory: Record<string, unknown>,
  o: { ownerId?: number; repo?: string; enabled?: boolean } = {},
) {
  const repo = o.repo === undefined ? REPO : o.repo;
  await knowledge.create({
    key,
    category: "task_memory",
    scope_type: repo ? "REPOSITORY" : "GLOBAL",
    scope_ref: repo,
    title: key,
    content: `content of ${key}`,
    enabled: o.enabled ?? true,
    applicability: repo ? { repos: [repo] } : {},
    metadata: { load: "on_demand", memory },
    created_by: "test",
    ownerId: o.ownerId ?? owner,
  });
  return key;
}
const facts = (run: number, over: Record<string, unknown> = {}) =>
  make(`memory.run-${run}.${REPO}.facts`, {
    run_id: run,
    repo: REPO,
    commit_sha: shaB,
    base_branch: "release/prod",
    files: ["b.go"],
    trust: "verified",
    confidence: "high",
    extracted_at: new Date().toISOString(),
    sources: [],
    ...over,
  });
const itemOf = (key: string) =>
  one<{ id: number; enabled: boolean; superseded_by: number | null }>(
    pool,
    "SELECT id, enabled, superseded_by FROM knowledge_items WHERE key = $1",
    [key],
  );
const agingOf = (key: string) =>
  one<Record<string, unknown>>(
    pool,
    "SELECT a.* FROM knowledge_aging a JOIN knowledge_items i ON i.id = a.item_id WHERE i.key = $1",
    [key],
  );
const auditOf = (key: string) =>
  q<{
    action: string;
    detail: Record<string, unknown>;
    item_id: number | null;
    item_key: string;
    owner_id: number | null;
  }>(
    pool,
    "SELECT action, detail, item_id, item_key, owner_id FROM knowledge_audit WHERE item_key = $1 ORDER BY id",
    [key],
  );
const eligible = async (key: string) =>
  !!(await one(pool, "SELECT 1 FROM retrieval.eligible_sources WHERE key = $1", [key]));
const pass = (o: Parameters<typeof runMemoryAging>[0] = {}) =>
  runMemoryAging({ intervalMs: 0, ...o });

test("a confirmed STALE item is archived with its reason, audited and removed from retrieval; Restore brings it back and pins it", async () => {
  const stale = await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  const fresh = await facts(runs[1]);
  assert.equal(await eligible(stale), true);
  const r = await pass();
  assert.deepEqual(
    r.actions.filter((a) => a.applied).map((a) => [a.key, a.policy, a.action]),
    [[stale, "stale", "archive"]],
  );
  assert.equal((await itemOf(fresh))!.enabled, true, "a FRESH item is untouched");
  const archived = await itemOf(stale);
  assert.equal(archived!.enabled, false);
  const a = await agingOf(stale);
  assert.equal(a!.state, "archived");
  assert.equal(a!.policy, "stale");
  assert.match(String(a!.reason), /changed on origin\/release\/prod since the task: a\.go/);
  const audit = await auditOf(stale);
  assert.deepEqual(
    audit.map((x) => x.action),
    ["created", "archived"],
  );
  assert.equal(audit[1].item_key, stale);
  assert.equal(audit[1].owner_id, owner);
  assert.deepEqual(
    [audit[1].detail.policy, audit[1].detail.by, audit[1].detail.state],
    ["stale", "memory aging", "archived"],
  );
  assert.equal(await eligible(stale), false, "gone from semantic retrieval");
  assert.ok(
    await one(pool, "SELECT 1 FROM retrieval.queue WHERE source_id = $1", [archived!.id]),
    "the retrieval worker is told to drop its embeddings",
  );
  const counted = runtimeMetricsSnapshot().memory_aging.actions;
  assert.ok(counted["stale.archive"] >= 1);

  const restored = await restoreMemory(stale, owner, "admin");
  assert.deepEqual([restored.enabled, restored.pinned], [true, true]);
  assert.equal(await eligible(stale), true, "back in semantic retrieval");
  assert.equal((await agingOf(stale))!.pinned, true);
  assert.deepEqual(
    (await auditOf(stale)).map((x) => x.action),
    ["created", "archived", "restored"],
  );
  await pass();
  assert.equal(
    (await itemOf(stale))!.enabled,
    true,
    "a pinned item is not archived again, though it is still STALE",
  );
  await assert.rejects(restoreMemory(stale, owner, "admin"), /not archived/);
  await unpinMemory(stale, owner, "admin");
  await pass();
  assert.equal((await itemOf(stale))!.enabled, false, "unpinned: aging looks at it again");
});

test("the CLI prints each policy's decisions and reasons; --dry-run changes nothing, a real run applies them", async () => {
  const stale = await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  const cli = (...args: string[]) =>
    execFileSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/cli/memoryAging.ts", ...args],
      {
        encoding: "utf8",
        env: process.env,
      },
    );
  const dry = cli("--dry-run", "--owner", String(owner));
  assert.match(dry, /DRY RUN \(nothing changed\)/);
  assert.match(
    dry,
    new RegExp(
      `stale \\(1\\)[\\s\\S]*archive\\s+${stale.replaceAll(".", "\\.")}[\\s\\S]*changed on origin/release/prod since the task: a\\.go`,
    ),
  );
  assert.equal((await itemOf(stale))!.enabled, true);
  assert.equal(JSON.parse(cli("--dry-run", "--json")).actions[0].applied, false);
  const real = cli("--repo", REPO);
  assert.match(real, /applied: /);
  assert.equal((await itemOf(stale))!.enabled, false);
});

test("running the pass twice changes nothing the second time", async () => {
  await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  await facts(runs[1]);
  await make(
    "memory.chat.pref1",
    { source: "chat", kind: "preference", trust: "human", claim: "Always use tabs" },
    { repo: "" },
  );
  await pass();
  const snapshot = async () => ({
    aging: await q(
      pool,
      "SELECT item_id, state, policy, reason, pinned, unknown_since FROM knowledge_aging ORDER BY item_id",
    ),
    audit: (
      await q(pool, "SELECT count(*)::int AS n FROM knowledge_audit WHERE item_key LIKE 'memory.%'")
    )[0].n,
    enabled: await q(
      pool,
      "SELECT key, enabled FROM knowledge_items WHERE category = 'task_memory' ORDER BY key",
    ),
  });
  const first = await snapshot();
  const second = await pass();
  assert.deepEqual(await snapshot(), first);
  assert.equal(second.actions.filter((a) => a.applied).length, 0);
});

test("a dry run reports what would happen and changes nothing", async () => {
  const stale = await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  const before = await q(pool, "SELECT * FROM knowledge_aging");
  const r = await pass({ dryRun: true });
  assert.deepEqual(
    r.actions.map((a) => [a.key, a.policy, a.applied]),
    [[stale, "stale", false]],
  );
  assert.equal((await itemOf(stale))!.enabled, true);
  assert.deepEqual(await q(pool, "SELECT * FROM knowledge_aging"), before, "no claims, no state");
  assert.equal((await auditOf(stale)).length, 1, "only the creation");
});

test("an unprovable item is archived only after a permanent reason lasted N days; a transient one never counts", async () => {
  const permanent = await facts(runs[0], { commit_sha: "" });
  const transient = await facts(runs[1], { repo: "elsewhere-not-cloned" });
  await repositories.upsert("elsewhere-not-cloned", { projects: ["AGING"] });
  const first = await pass();
  assert.equal(first.actions.length, 0);
  assert.ok((await agingOf(permanent))!.unknown_since, "the clock started");
  assert.equal(
    (await agingOf(transient))?.unknown_since ?? null,
    null,
    "a repository that is not cloned here is not evidence",
  );
  await q(
    pool,
    "UPDATE knowledge_aging SET unknown_since = $2 FROM knowledge_items i WHERE i.id = item_id AND i.key = $1",
    [permanent, ago(20)],
  );
  await q(
    pool,
    "UPDATE knowledge_aging SET unknown_since = $2, unknown_code = 'repo_missing' FROM knowledge_items i WHERE i.id = item_id AND i.key = $1",
    [transient, ago(20)],
  );
  const second = await pass();
  assert.deepEqual(
    second.actions.filter((a) => a.applied).map((a) => [a.key, a.policy]),
    [[permanent, "unknown"]],
  );
  assert.equal(
    (await agingOf(transient))!.unknown_since,
    null,
    "the transient sighting cleared the clock",
  );
  assert.equal((await itemOf(transient))!.enabled, true);
});

test("commit_missing is permanent only on the instance that ran the task", async () => {
  const gone = "0123456789abcdef0123456789abcdef01234567";
  const own = await facts(runs[0], { commit_sha: gone, files: ["own.go"] });
  const foreign = await facts(runs[1], { commit_sha: gone, files: ["foreign.go"] });
  await q(pool, "UPDATE workflow_runs SET worker_instance = $2 WHERE id = $1", [
    runs[0],
    config.instanceId,
  ]);
  await q(pool, "UPDATE workflow_runs SET worker_instance = 'some-other-machine' WHERE id = $1", [
    runs[1],
  ]);
  await pass();
  assert.equal(
    (await agingOf(own))!.unknown_code,
    "commit_missing",
    "recorded as permanent on its own instance",
  );
  assert.equal(
    (await agingOf(foreign))?.unknown_since ?? null,
    null,
    "on another instance it is only 'not in this clone'",
  );
  await q(pool, "UPDATE knowledge_aging SET unknown_since = $1", [ago(30)]);
  await pass();
  assert.equal((await itemOf(own))!.enabled, false);
  assert.equal((await itemOf(foreign))!.enabled, true);
});

test("never-approved conclusions are archived after 30 days; approved ones are not", async () => {
  const mk = (run: number, trust: string, days: number) =>
    make(
      `memory.run-${run}.${REPO}.conclusions`,
      {
        run_id: run,
        repo: REPO,
        commit_sha: shaB,
        base_branch: "release/prod",
        files: ["b.go"],
        trust,
        extracted_at: ago(days).toISOString(),
      },
      { enabled: trust === "approved" },
    );
  const old = await mk(runs[0], "unverified", 31);
  const rejected = await mk(runs[1], "rejected", 40);
  const young = await mk(runs[2], "unverified", 5);
  const approved = await mk(runs[3], "approved", 100);
  await q(pool, "UPDATE knowledge_usage SET last_loaded_at = now()");
  await recordKnowledgeUsage([(await itemOf(approved))!.id]);
  await pass();
  for (const k of [old, rejected]) assert.equal((await agingOf(k))!.state, "archived", k);
  assert.equal((await agingOf(young))?.state ?? "active", "active");
  assert.equal((await agingOf(approved))?.state ?? "active", "active");
  assert.equal(
    (await itemOf(old))!.enabled,
    false,
    "still disabled: restoring it never makes unverified text loadable",
  );
  assert.equal((await restoreMemory(old, owner, "admin")).enabled, false);
});

test("disuse: dormant then archived; approved items wait longer; preferences never expire by time", async () => {
  const idle = async (key: string, days: number) => {
    await q(pool, "UPDATE knowledge_items SET created_at = $2 WHERE key = $1", [key, ago(days)]);
  };
  const verified = await facts(runs[0]);
  const approvedRun = await make(`memory.run-${runs[1]}.${REPO}.conclusions`, {
    run_id: runs[1],
    repo: REPO,
    commit_sha: shaB,
    base_branch: "release/prod",
    files: ["b.go"],
    trust: "approved",
    extracted_at: ago(1).toISOString(),
  });
  const pref = await make(
    "memory.chat.pref-old",
    { source: "chat", kind: "preference", trust: "human", claim: "Always use tabs" },
    { repo: "" },
  );
  await idle(verified, 70);
  await idle(approvedRun, 70);
  await idle(pref, 3000);
  await pass();
  assert.equal(
    (await agingOf(verified))!.state,
    "dormant",
    "70 idle days: past the verified window",
  );
  assert.equal((await itemOf(verified))!.enabled, true, "dormant is still enabled");
  assert.equal(
    (await agingOf(approvedRun))?.state ?? "active",
    "active",
    "approved: longer window",
  );
  assert.equal((await itemOf(pref))!.enabled, true, "a preference never expires by time");
  assert.deepEqual(await dormantKeys([verified, approvedRun, pref]), new Set([verified]));
  await idle(verified, 130);
  await pass();
  assert.equal((await agingOf(verified))!.state, "archived");
  assert.equal((await agingOf(verified))!.policy, "disuse");
});

test("loading memory records usage (at most once per five minutes), wakes a dormant item, and never throws", async () => {
  const key = await facts(runs[0]);
  const id = (await itemOf(key))!.id;
  await recordKnowledgeUsage([id, id, undefined]);
  await recordKnowledgeUsage([id]);
  const usage = await one<{ loads: number }>(
    pool,
    "SELECT loads FROM knowledge_usage WHERE item_id = $1",
    [id],
  );
  assert.equal(usage!.loads, 1, "the second load inside five minutes is not a second write");
  await q(pool, "UPDATE knowledge_usage SET last_loaded_at = now() - interval '10 minutes'");
  await q(
    pool,
    "INSERT INTO knowledge_aging (item_id, state, policy) VALUES ($1, 'dormant', 'disuse') ON CONFLICT (item_id) DO UPDATE SET state = 'dormant'",
    [id],
  );
  await recordKnowledgeUsage([id]);
  assert.equal(
    (await one<{ loads: number }>(pool, "SELECT loads FROM knowledge_usage WHERE item_id = $1", [
      id,
    ]))!.loads,
    2,
  );
  assert.equal((await agingOf(key))!.state, "active", "loaded again: no longer dormant");
  noteKnowledgeUsage([987654321, null]);
  await settleBackground();
});

test("replacement: a newer verified memory covering all the files supersedes the older (disabled, linked, audited)", async () => {
  const older = await facts(runs[0], { files: ["b.go"], extracted_at: ago(5).toISOString() });
  const newer = await facts(runs[1], {
    files: ["b.go", "c.go"],
    extracted_at: ago(1).toISOString(),
  });
  await pass();
  const o = await itemOf(older);
  assert.equal(o!.enabled, false);
  assert.equal(o!.superseded_by, (await itemOf(newer))!.id);
  assert.equal((await agingOf(older))!.state, "superseded");
  assert.equal((await agingOf(older))!.replaced_by_key, newer);
  assert.equal((await itemOf(newer))!.enabled, true);
  assert.deepEqual(
    (await auditOf(older)).map((x) => x.action),
    ["created", "superseded"],
  );
  await restoreMemory(older, owner, "admin");
  assert.equal((await itemOf(older))!.superseded_by, null, "restoring clears the supersession");
});

test("cap: beyond N per owner and repository the least recently used are archived", async () => {
  config.memoryAging.capPerRepo = "2";
  const keys: string[] = [];
  for (let i = 0; i < 4; i++) {
    const k = await facts(900 + i, { files: [`f${i}.go`] });
    await q(pool, "UPDATE knowledge_items SET created_at = $2 WHERE key = $1", [k, ago(10 + i)]);
    keys.push(k);
  }
  await pass();
  const archived = (
    await q<{ key: string }>(
      pool,
      "SELECT i.key FROM knowledge_aging a JOIN knowledge_items i ON i.id = a.item_id WHERE a.state = 'archived' ORDER BY i.key",
    )
  ).map((r) => r.key);
  assert.deepEqual(archived, [keys[2], keys[3]].sort(), "the two idlest");
  assert.equal((await agingOf(keys[2]))!.policy, "cap");
});

test("lessons: a report on the evidence run archives a procedural lesson; another run on the same file only makes it dormant", async () => {
  const lesson = (n: string, evidenceRun: number) =>
    make(`memory.lesson.procedural.${REPO}.${n}`, {
      purpose: "procedural",
      run_id: evidenceRun,
      repo: REPO,
      files: ["b.go"],
      evidence: { run_id: evidenceRun },
      status: "active",
      trust: "verified",
      extracted_at: ago(20).toISOString(),
      commit_sha: shaB,
    });
  const own = await lesson("own", runs[0]);
  const shared = await lesson("shared", runs[2]);
  await facts(runs[1], { files: ["b.go", "x.go"] });
  const report = (run: number) =>
    q(
      pool,
      "INSERT INTO outcome_observations (kind, source_type, source_ref, run_id, owner_id, repo, verified, observed_at, recorded_by) VALUES ('regression_reported', 'manual', $1, $2, $3, $4, true, now() - interval '1 day', 'test')",
      [`t:${++seq}:${run}`, run, owner, REPO],
    );
  await report(runs[0]);
  await report(runs[1]);
  await pass();
  assert.equal((await agingOf(own))!.state, "archived");
  assert.equal((await agingOf(own))!.policy, "lesson_contradicted");
  assert.equal(
    (await agingOf(shared))!.state,
    "dormant",
    "a report about another run that touched the same file",
  );
  assert.equal((await itemOf(shared))!.enabled, true);
});

test("chat memory: only an exact-subject contradiction supersedes; unrelated or merely similar statements stay", async () => {
  const mk = (n: string, claim: string, days: number) =>
    make(
      `memory.chat.${n}`,
      { source: "chat", kind: "preference", trust: "human", claim },
      { repo: "" },
    ).then(async (k) => {
      await q(pool, "UPDATE knowledge_items SET created_at = $2 WHERE key = $1", [k, ago(days)]);
      return k;
    });
  const older = await mk("a1", "Always use tabs for Go files", 10);
  const newer = await mk("a2", "Never use tabs for Go files", 2);
  const similar = await mk("b1", "Always run gofmt", 10);
  await mk("b2", "Never run gofmt before commit", 2);
  await pass();
  assert.equal((await agingOf(older))!.state, "superseded");
  assert.equal((await agingOf(older))!.replaced_by_key, newer);
  assert.equal(
    (await itemOf(similar))!.enabled,
    true,
    "a different subject is not a contradiction",
  );
  assert.equal((await itemOf(newer))!.enabled, true);
  assert.equal(
    (await restoreMemory(older, owner, "owner")).pinned,
    true,
    "the owner can restore what was replaced",
  );
});

test("a procedure that failed is archived; when it succeeds again it comes back by itself, unpinned", async () => {
  const conv = (await one<{ id: number }>(
    pool,
    "INSERT INTO chat_conversations (owner_id) VALUES ($1) RETURNING id",
    [owner],
  ))!.id;
  const op = async (status: string, finished: Date) =>
    Number(
      (await one<{ id: number }>(
        pool,
        "INSERT INTO chat_operations (conversation_id, owner_id, tool, arguments, target, idempotency_key, status, expires_at, finished_at) VALUES ($1, $2, 'kafka.publish', '{}', '{\"topic\":\"orders\"}', $3, $4, now() + interval '1 day', $5) RETURNING id",
        [conv, owner, `k${++seq}`, status, finished],
      ))!.id,
    );
  const first = await op("succeeded", ago(5));
  const procedure = {
    owner_id: owner,
    conversation_id: conv,
    id: first,
    tool: "kafka.publish",
    target: { topic: "orders" },
    arguments: {},
    verification: null,
  };
  await learnProcedure(procedure);
  const key = (await one<{ key: string }>(
    pool,
    "SELECT key FROM knowledge_items WHERE key LIKE 'memory.chat.%' AND owner_id = $1",
    [owner],
  ))!.key;
  await op("failed", new Date(Date.now() + 60_000));
  await pass();
  assert.equal((await agingOf(key))!.state, "archived");
  assert.equal((await agingOf(key))!.policy, "procedure_failed");
  assert.equal((await itemOf(key))!.enabled, false);
  await learnProcedure({ ...procedure, id: await op("succeeded", new Date(Date.now() + 120_000)) });
  const back = await agingOf(key);
  assert.equal(back!.state, "restored");
  assert.equal(back!.pinned, false, "an automatic restore never pins");
  assert.equal((await itemOf(key))!.enabled, true);
  const audit = (await auditOf(key)).filter((x) => x.action === "restored");
  assert.equal(audit[0].detail.by, "auto: procedure succeeded again");
  await pass();
  assert.equal((await itemOf(key))!.enabled, true, "the latest run succeeded: it stays");
  assert.equal(await restoreProcedureIfArchived(owner, key), false);
  await assert.rejects(restoreMemory(key, owner, "x"), /not archived/);
});

test("purge: deleted for good long after archiving; the audit trail, past snapshots and retrieval rows stay consistent", async () => {
  const key = await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  const id = (await itemOf(key))!.id;
  await pass();
  await q(
    pool,
    "INSERT INTO retrieval.sources (source_id, model, source_version, content_hash, status, chunks) VALUES ($1, 'm', 1, 'h', 'indexed', 1)",
    [id],
  );
  await q(
    pool,
    "INSERT INTO retrieval.chunks (source_id, model, chunk, dims, embedding) VALUES ($1, 'm', 0, 3, '{1,2,3}')",
    [id],
  );
  const step = (await one<{ id: number }>(
    pool,
    "SELECT id FROM workflow_steps WHERE run_id = $1 LIMIT 1",
    [runs[0]],
  ))!.id;
  const content = {
    knowledge: [{ id, key, version: 1, content: "content of " + key, category: "task_memory" }],
  };
  const snapshot = await insertSnapshot(pool, runs[0], step, "hash-" + id, content);
  await pass();
  assert.ok(await itemOf(key), "archived 0 days: not deleted yet");
  await q(pool, "UPDATE knowledge_aging SET at = $2 WHERE item_id = $1", [id, ago(91)]);
  const r = await pass();
  assert.deepEqual(
    r.actions.filter((a) => a.applied).map((a) => [a.key, a.action]),
    [[key, "purge"]],
  );
  assert.equal((await itemOf(key)) ?? null, null);
  assert.equal(
    (await one(pool, "SELECT 1 FROM retrieval.chunks WHERE source_id = $1", [id])) ?? null,
    null,
  );
  assert.equal(
    (await one(pool, "SELECT 1 FROM retrieval.sources WHERE source_id = $1", [id])) ?? null,
    null,
  );
  const trail = await auditOf(key);
  assert.deepEqual(
    trail.map((x) => x.action),
    ["created", "archived", "purged"],
    "the audit survives the item",
  );
  assert.ok(trail.every((x) => x.item_id === null && x.owner_id === owner));
  const kept = await one<{ content: typeof content }>(
    pool,
    "SELECT content FROM context_snapshots WHERE id = $1",
    [snapshot],
  );
  assert.equal(
    kept!.content.knowledge[0].content,
    "content of " + key,
    "past runs still show what they were given",
  );
  config.memoryAging.purgeDays = "0";
});

test("purge disabled (0 days) never deletes", async () => {
  config.memoryAging.purgeDays = "0";
  const key = await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  await pass();
  await q(pool, "UPDATE knowledge_aging SET at = $1", [ago(1000)]);
  await pass();
  assert.ok(await itemOf(key));
});

test("two instances running at once: every decision is applied exactly once and no item is checked twice", async () => {
  const stale: string[] = [];
  for (let i = 0; i < 6; i++)
    stale.push(
      await facts(800 + i, {
        commit_sha: shaA,
        files: ["a.go", `own${i}.go`],
        extracted_at: ago(i).toISOString(),
      }),
    );
  config.memoryAging.concurrency = "2";
  const [x, y] = await Promise.all([
    runMemoryAging({ intervalMs: 3_600_000 }),
    runMemoryAging({ intervalMs: 3_600_000 }),
  ]);
  const applied = [...x.actions, ...y.actions].filter((a) => a.applied);
  assert.equal(applied.length, 6);
  assert.equal(new Set(applied.map((a) => a.key)).size, 6, "no item decided by both");
  assert.equal(x.freshnessChecked + y.freshnessChecked, 6, "no item checked by both");
  for (const k of stale)
    assert.deepEqual(
      (await auditOf(k)).map((a) => a.action),
      ["created", "archived"],
      k,
    );
});

test("two passes that both look at everything (the CLI case) still change each item once", async () => {
  const stale: string[] = [];
  for (let i = 0; i < 6; i++)
    stale.push(await facts(820 + i, { commit_sha: shaA, files: ["a.go", `solo${i}.go`] }));
  await Promise.all([pass(), pass(), pass()]);
  for (const k of stale) {
    assert.deepEqual(
      (await auditOf(k)).map((a) => a.action),
      ["created", "archived"],
      k,
    );
    assert.equal((await itemOf(k))!.enabled, false);
  }
});

test("a decision that no longer fits is refused: a person's pin or a new version wins over the pass", async () => {
  const key = await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  const pinned = await facts(runs[1], { commit_sha: shaA, files: ["a.go"] });
  await q(
    pool,
    "INSERT INTO knowledge_aging (item_id, state, pinned, checked_at) SELECT id, 'restored', true, now() - interval '1 day' FROM knowledge_items WHERE key = $1",
    [pinned],
  );
  await pass();
  assert.equal((await itemOf(key))!.enabled, false);
  assert.equal((await itemOf(pinned))!.enabled, true);
});

test("only task memory is ever aged: curated knowledge and other keys are never touched", async () => {
  await knowledge.create({
    key: "rule.refund",
    category: "business_rule",
    scope_type: "GLOBAL",
    title: "r",
    content: "c",
    ownerId: null,
  });
  await q(pool, "UPDATE knowledge_items SET created_at = $1 WHERE key = 'rule.refund'", [
    ago(5000),
  ]);
  await make("memory.something-else", { trust: "verified", repo: REPO }, { repo: REPO });
  await q(pool, "UPDATE knowledge_items SET created_at = $1 WHERE key = 'memory.something-else'", [
    ago(5000),
  ]);
  await pass();
  assert.equal((await itemOf("rule.refund"))!.enabled, true);
  assert.equal((await itemOf("memory.something-else"))!.enabled, true);
  assert.equal((await agingOf("rule.refund")) ?? null, null);
  await q(pool, "DELETE FROM knowledge_items WHERE key = 'rule.refund'");
});

test("ownership never changes: aging leaves owner and scope exactly as they were", async () => {
  const mine = await facts(runs[0], { commit_sha: shaA, files: ["a.go"] });
  const theirs = await make(
    `memory.run-777.${REPO}.facts`,
    {
      run_id: 777,
      repo: REPO,
      commit_sha: shaA,
      base_branch: "release/prod",
      files: ["a.go"],
      trust: "verified",
      extracted_at: new Date().toISOString(),
    },
    { ownerId: other },
  );
  const before = await q(
    pool,
    "SELECT key, owner_id, scope_type, scope_ref FROM knowledge_items WHERE key = ANY($1) ORDER BY key",
    [[mine, theirs]],
  );
  await pass({ ownerId: owner });
  assert.equal((await itemOf(mine))!.enabled, false);
  assert.equal(
    (await itemOf(theirs))!.enabled,
    true,
    "an owner filter leaves other owners' items alone",
  );
  await pass();
  assert.deepEqual(
    await q(
      pool,
      "SELECT key, owner_id, scope_type, scope_ref FROM knowledge_items WHERE key = ANY($1) ORDER BY key",
      [[mine, theirs]],
    ),
    before,
  );
});
