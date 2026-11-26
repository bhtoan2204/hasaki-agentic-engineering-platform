/**
 * Step 7: the read API of shared results (contract and access) for the UI. The start routes keep their shapes; their
 * `shared` field is the same view.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { handle } from "../src/http/app.ts";
import { createUser } from "../src/auth/users.ts";
import { putUserSecret } from "../src/auth/secrets.ts";
import { repositories } from "../src/repos/service.ts";
import { setRepositoryAccess } from "../src/repos/access.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { settleBackground } from "../src/workflow/background.ts";
import {
  codeAssessmentKey,
  rubricHash,
  runtimeRcaKey,
  type SharedKey,
} from "../src/sharing/key.ts";
import { lookupOrStart, type LookupRequest } from "../src/sharing/service.ts";
import { settleSharedAnalyses } from "../src/sharing/settle.ts";
import { installationId } from "../src/sharing/scope.ts";

type Call = <T = Record<string, unknown>>(path: string) => Promise<{ status: number; body: T }>;
let server: Server;
let base = "";
let ids: Record<string, number> = {};
let alice: Call, bob: Call, admin: Call;
let scope = "";
let seq = 0;

async function login(username: string): Promise<Call> {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: `${username}-password` }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return async (path) => {
    const res = await fetch(base + path, { headers: { cookie } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

before(async () => {
  await migrate();
  await seedTemplates();
  ids = {};
  for (const [u, role] of [
    ["api-admin", "admin"],
    ["api-alice", "member"],
    ["api-bob", "member"],
  ] as const)
    ids[u] = Number((await createUser({ username: u, password: `${u}-password`, role })).id);
  scope = await installationId();
  await definitions.create({
    key: "shared-api-fixture",
    spec: {
      name: "api fixture",
      steps: [
        { key: "assess", type: "command", config: { command: "true" } },
        { key: "report", type: "command", config: { command: "true" } },
      ],
    },
  });
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = await login("api-admin");
  alice = await login("api-alice");
  bob = await login("api-bob");
});
after(async () => {
  await settleBackground();
  await new Promise((r) => server.close(r));
  await pool.end();
});
beforeEach(() => {
  config.sharedResults.prodErrors = true;
  config.sharedResults.codeAssessment = true;
});

async function repo(readers: string[]) {
  const name = `api-repo-${++seq}`;
  const row = (await repositories.upsert(name, {}))!;
  for (const u of readers) await setRepositoryAccess(row, ids[u], "read", ids["api-admin"]);
  return name;
}
const assessKey = (
  name: string | string[],
  focus = "",
  o: { project?: string; outputLocale?: string; profile?: string } = {},
): SharedKey =>
  codeAssessmentKey({
    scope,
    repos: (Array.isArray(name) ? name : [name]).map((repo) => ({ repo, commit: "a".repeat(40) })),
    focus,
    project: o.project,
    outputLocale: o.outputLocale,
    profile: o.profile,
    workflow: { key: "codebase-assessment", version: 1 },
    rubricHash: rubricHash({ instructions: "assess" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
const request = (key: SharedKey, user: string): LookupRequest => ({
  key,
  actor: { id: ids[user], username: user },
  scopeRepos: ((key.parts.repos as string[] | undefined) ?? []).map((r) => r.split("@")[0]),
  errorKey: (key.parts.error as string | undefined) ?? null,
  start: async (tx) =>
    Number(
      (
        await startRun(
          { definitionKey: "shared-api-fixture", ownerId: ids[user], start: false, title: "api" },
          tx,
        )
      ).id,
    ),
});
async function publish(
  key: SharedKey,
  user: string,
  output: unknown = { findings: [{ title: "x" }] },
) {
  const r = await lookupOrStart(request(key, user));
  assert.equal(r.outcome, "miss");
  const runId = r.outcome === "miss" ? r.runId : 0;
  await q(pool, "UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = $1", [runId]);
  await q(pool, "UPDATE workflow_steps SET status = 'COMPLETED', output = $2 WHERE run_id = $1", [
    runId,
    JSON.stringify(output),
  ]);
  await settleSharedAnalyses();
  await settleBackground();
  return r.analysis!.id;
}

const VIEW_KEYS = [
  "analysis_id",
  "freshness",
  "focus",
  "kind",
  "outcome",
  "provenance",
  "repositories",
  "reuse",
  "run_by",
  "status",
  "version",
];

test("GET /api/shared-analyses/:id: the view (who, when, age, state, reuses, result) for a reader; 404 for anyone else", async () => {
  const name = await repo(["api-alice", "api-bob"]);
  const id = await publish(assessKey(name), "api-alice");
  const own = await alice(`/api/shared-analyses/${id}`);
  assert.equal(own.status, 200);
  for (const k of VIEW_KEYS) assert.ok(k in own.body, `view has ${k}`);
  assert.equal(own.body.status, "valid");
  assert.deepEqual(own.body.run_by, { id: ids["api-alice"], name: "api-alice", is_you: true });
  assert.ok(own.body.run_id, "the creator gets the source run");
  assert.ok(own.body.result, "a read returns the result");
  const other = await bob(`/api/shared-analyses/${id}`);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.run_by, { id: ids["api-alice"], name: "api-alice", is_you: false });
  assert.equal(other.body.run_id, undefined, "runs stay owner-only");
  assert.deepEqual(other.body.repositories, [name]);
  assert.equal(typeof (other.body.freshness as { age_seconds: number }).age_seconds, "number");
  assert.equal((await bob(`/api/shared-analyses/999999`)).status, 404);
});

test("access: a member without the repository gets 404 and no runner name; admin support access reads it, audited", async () => {
  const name = await repo(["api-alice"]);
  const id = await publish(assessKey(name), "api-alice");
  const denied = await bob(`/api/shared-analyses/${id}`);
  assert.equal(denied.status, 404);
  assert.ok(!JSON.stringify(denied.body).includes("api-alice"));
  assert.equal(
    (await admin(`/api/shared-analyses/${id}`)).status,
    404,
    "an admin is a member without support",
  );
  const support = await admin(`/api/shared-analyses/${id}?scope=all`);
  assert.equal(support.status, 200);
  assert.ok(
    await one(pool, "SELECT 1 FROM audit_log WHERE action = 'support.read' AND resource_id = $1", [
      String(id),
    ]),
  );
  const subject = await bob(`/api/code-scans/shared?repositories=${name}`);
  assert.deepEqual(subject.body, { shared: null });
});

test("GET /api/code-scans/shared: the latest assessment of these repositories and focus; stale is returned and labelled", async () => {
  const name = await repo(["api-alice", "api-bob"]);
  assert.deepEqual((await bob(`/api/code-scans/shared?repositories=${name}`)).body, {
    shared: null,
  });
  const id = await publish(assessKey(name, "Payment  Flow"), "api-alice");
  const none = await bob(`/api/code-scans/shared?repositories=${name}`);
  assert.deepEqual(none.body, { shared: null }, "another focus is another subject");
  const r = await bob<{ shared: Record<string, unknown> }>(
    `/api/code-scans/shared?repositories=${name}&focus=${encodeURIComponent("payment flow")}`,
  );
  assert.equal(r.body.shared.analysis_id, id, "focus is matched as the key normalizes it");
  await q(pool, "UPDATE shared_analyses SET status = 'stale', stale_reason = $2 WHERE id = $1", [
    id,
    `commit_changed:${name}`,
  ]);
  const stale = await bob<{
    shared: { status: string; freshness: { stale_reason: string }; result: unknown };
  }>(`/api/code-scans/shared?repositories=${name}&focus=payment%20flow`);
  assert.equal(stale.body.shared.status, "stale");
  assert.equal(stale.body.shared.freshness.stale_reason, `commit_changed:${name}`);
  assert.ok(stale.body.shared.result, "a stale result is shown, not hidden");
});

test("single-flight: while another member runs it, the reader sees it running with the runner, without a result", async () => {
  const name = await repo(["api-alice", "api-bob"]);
  await lookupOrStart(request(assessKey(name), "api-alice"));
  const r = await bob<{
    shared: { status: string; run_by: { name: string; is_you: boolean }; result?: unknown };
  }>(`/api/code-scans/shared?repositories=${name}`);
  assert.equal(r.body.shared.status, "running");
  assert.deepEqual([r.body.shared.run_by.name, r.body.shared.run_by.is_you], ["api-alice", false]);
  assert.equal(r.body.shared.result, undefined);
});

test("GET /api/prod-errors/:fp/shared: the RCA with occurrences, only for a member with log access", async () => {
  const fp = (++seq).toString(16).padStart(20, "0");
  const key = runtimeRcaKey({
    scope,
    errorKey: fp,
    contract: "v1",
    workflow: { key: "production-incident-investigation", version: 1 },
    rubricHash: rubricHash({ instructions: "rca" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
  await putUserSecret(ids["api-alice"], "splunk_token", JSON.stringify({ token: "t" }));
  await publish(key, "api-alice", { summary: "pool exhausted" });
  const mine = await alice<{ runtime_rca: Record<string, unknown> | null; bug_hunt: unknown }>(
    `/api/prod-errors/${fp}/shared`,
  );
  assert.equal(mine.status, 200);
  assert.equal(mine.body.bug_hunt, null);
  assert.equal(mine.body.runtime_rca!.kind, "prod_error.runtime_rca");
  assert.ok("occurrences" in mine.body.runtime_rca!, "occurrences now vs when analysed");
  const noLogs = await bob(`/api/prod-errors/${fp}/shared`);
  assert.deepEqual(noLogs.body, { runtime_rca: null, bug_hunt: null });
});

test("flags off: the read API answers as if nothing were shared", async () => {
  const name = await repo(["api-alice"]);
  const id = await publish(assessKey(name), "api-alice");
  config.sharedResults.codeAssessment = false;
  config.sharedResults.prodErrors = false;
  assert.equal((await alice(`/api/shared-analyses/${id}`)).status, 404);
  assert.deepEqual((await alice(`/api/code-scans/shared?repositories=${name}`)).body, {
    shared: null,
  });
  assert.deepEqual((await alice(`/api/prod-errors/${"0".repeat(20)}/shared`)).body, {
    runtime_rca: null,
    bug_hunt: null,
  });
});

test("C3: while a re-run runs or after it failed, the read API still returns the last valid result with a note", async () => {
  const name = await repo(["api-alice", "api-bob"]);
  const key = assessKey(name);
  const id = await publish(key, "api-alice");
  const forced = await lookupOrStart({ ...request(key, "api-alice"), force: true });
  assert.equal(forced.outcome, "forced");
  const url = `/api/code-scans/shared?repositories=${name}`;
  const running = await bob<{
    shared: {
      analysis_id: number;
      status: string;
      version: number;
      newer_version: unknown;
      result: unknown;
    };
  }>(url);
  assert.equal(running.body.shared.analysis_id, id, "v1, not the running v2");
  assert.equal(running.body.shared.status, "valid");
  assert.deepEqual(running.body.shared.newer_version, { version: 2, status: "running" });
  assert.ok(running.body.shared.result);
  await q(pool, "UPDATE workflow_runs SET status = 'FAILED' WHERE id = $1", [
    forced.outcome === "forced" ? forced.runId : 0,
  ]);
  await settleSharedAnalyses();
  const failed = await bob<{ shared: { analysis_id: number; newer_version: unknown } }>(url);
  assert.equal(failed.body.shared.analysis_id, id);
  assert.deepEqual(failed.body.shared.newer_version, { version: 2, status: "failed" });
  const noAccess = await admin(url);
  assert.deepEqual(noAccess.body, { shared: null }, "a reader without access gets neither version");
});

test("C3: the same for a production error's RCA", async () => {
  const fp = (++seq).toString(16).padStart(20, "0");
  const key = runtimeRcaKey({
    scope,
    errorKey: fp,
    contract: "v1",
    workflow: { key: "production-incident-investigation", version: 1 },
    rubricHash: rubricHash({ instructions: "rca" }),
    model: "claude/claude-opus-5-5#cfg:test",
  });
  await putUserSecret(ids["api-alice"], "splunk_token", JSON.stringify({ token: "t" }));
  const id = await publish(key, "api-alice", { summary: "pool exhausted" });
  const forced = await lookupOrStart({ ...request(key, "api-alice"), force: true });
  assert.equal(forced.outcome, "forced");
  const r = await alice<{
    runtime_rca: { analysis_id: number; status: string; newer_version: unknown };
  }>(`/api/prod-errors/${fp}/shared`);
  assert.equal(r.body.runtime_rca.analysis_id, id);
  assert.equal(r.body.runtime_rca.status, "valid");
  assert.deepEqual(r.body.runtime_rca.newer_version, { version: 2, status: "running" });
});

test("N1: GET /api/code-scans/shared isolates assessments by project and output_locale", async () => {
  const name = await repo(["api-alice", "api-bob"]);
  const enOmsId = await publish(
    assessKey(name, "", { project: "OMS", outputLocale: "en" }),
    "api-alice",
  );
  assert.deepEqual(
    (await bob(`/api/code-scans/shared?repositories=${name}`)).body,
    { shared: null },
    "default vi without project does not match en/OMS",
  );
  assert.deepEqual(
    (await bob(`/api/code-scans/shared?repositories=${name}&project=OMS&output_locale=vi`)).body,
    { shared: null },
  );
  assert.deepEqual(
    (await bob(`/api/code-scans/shared?repositories=${name}&project=Payment&output_locale=en`)).body,
    { shared: null },
  );
  const hit = await bob<{ shared: { analysis_id: number } }>(
    `/api/code-scans/shared?repositories=${name}&project=oms&output_locale=en`,
  );
  assert.equal(hit.body.shared.analysis_id, enOmsId);
});

test("N2: GET /api/code-scans/shared matches profile by multi-repo, title, or explicit profile", async () => {
  const r1 = await repo(["api-alice", "api-bob"]);
  const r2 = await repo(["api-alice", "api-bob"]);
  const stdId = await publish(assessKey(r1, "", { profile: "STANDARD" }), "api-alice");
  const deepSingleId = await publish(
    assessKey(r1, "refactor auth", { profile: "DEEP" }),
    "api-alice",
  );
  const deepMultiId = await publish(assessKey([r1, r2], "", { profile: "DEEP" }), "api-alice");

  assert.equal(
    (await bob<{ shared: { analysis_id: number } }>(`/api/code-scans/shared?repositories=${r1}`)).body
      .shared.analysis_id,
    stdId,
  );
  assert.equal(
    (
      await bob<{ shared: { analysis_id: number } }>(
        `/api/code-scans/shared?repositories=${r1}&focus=${encodeURIComponent("refactor auth")}&title=${encodeURIComponent("Code scan — refactor auth")}`,
      )
    ).body.shared.analysis_id,
    deepSingleId,
  );
  assert.equal(
    (await bob<{ shared: { analysis_id: number } }>(`/api/code-scans/shared?repositories=${r1},${r2}`))
      .body.shared.analysis_id,
    deepMultiId,
  );
  assert.equal(
    (
      await bob<{ shared: { analysis_id: number } }>(
        `/api/code-scans/shared?repositories=${r1}&focus=${encodeURIComponent("refactor auth")}&profile=DEEP`,
      )
    ).body.shared.analysis_id,
    deepSingleId,
  );
  assert.equal(
    (await bob(`/api/code-scans/shared?repositories=${r1}&profile=INVALID`)).status,
    400,
  );
});
