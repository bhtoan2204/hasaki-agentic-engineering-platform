/**
 * Unified Incident Investigation, end to end and offline (PostgreSQL + the real Workflow Engine and scheduler).
 *
 * Real: the Bug Hunt (production-bug-hunt through the Agent Harness, Codex provider path driven by the fake `codex`
 * CLI — same fixture as production-bug-hunter.integration.ts), run lifecycle, linking, evidence validity/freshness
 * (git on the fixture checkout), deterministic reconciliation, RCA versions, fix-task routing to the existing flows,
 * authorization, telemetry aggregation.
 * Stubbed: the runtime RCA's agent and Splunk/SigNoz-backed integration steps (canned per-step outputs; the report step
 * returns a scripted RoundState) — no VPN, no production observability, no paid LLM.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { deleteUserSecret, putUserSecret } from "../src/auth/secrets.ts";
import { getRun, cancelRun, reexecuteStep, startRun } from "../src/workflow/engine.ts";
import { runOnce } from "../src/workflow/scheduler.ts";
import {
  getExecutor,
  registerExecutor,
  type ExecutionContext,
} from "../src/workflow/executors/registry.ts";
import { caseFingerprint } from "../src/eval/bugHuntFixtures.ts";
import { createFixTask, startBugHunt, startBugHuntShared } from "../src/bugHunt/service.ts";
import { config } from "../src/config.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { resetSharingHooks, setSharingHooks, type SharedEvent } from "../src/sharing/hooks.ts";
import {
  getWorkbench,
  rcaVersion,
  startRuntime,
  startRuntimeShared,
  startHunt,
  startHuntShared,
  startBoth,
  createFix,
  RUNTIME_WORKFLOW,
} from "../src/incidents/unified.ts";
import type { ExecResult } from "../src/workflow/types.ts";
import { setupBugHuntFixture } from "./fixtures/bugHuntRepo.ts";
import { bwrapAvailable } from "../src/platform/selfDevelopment.ts";

const root = process.env.TEST_ROOT!;
let owner: PublicUser;
let other: PublicUser;
let admin: PublicUser;
let fx: Awaited<ReturnType<typeof setupBugHuntFixture>>;
let repo = "";
let sandbox = false;

async function drive(runId: number, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) return r.status;
    if (!(await runOnce())) await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`run ${runId} did not finish`);
}

// ---------------------------------------------------------------- scripted runtime RCA (per incident fingerprint)

interface RuntimeScript {
  outcome: "CONFIRMED" | "PROBABLE" | "UNKNOWN" | "BLOCKED";
  hypotheses: Array<{
    id: string;
    statement: string;
    kind: string;
    status: string;
    code_location: string | null;
  }>;
}
const runtimeScripts = new Map<string, RuntimeScript>();
const runtimeRequests: string[] = [];
const round = (s: RuntimeScript) => ({
  round: 1,
  max_rounds: 3,
  step_id: 0,
  generation: 0,
  time: {
    earliest: "2026-11-20T00:00:00+07:00",
    latest: "2026-11-20T06:00:00+07:00",
    timezone: "Asia/Ho_Chi_Minh",
    anchor: null,
  },
  services: ["shop"],
  outcome: s.outcome,
  outcome_reasons: [`scripted ${s.outcome}`],
  hypotheses: s.hypotheses.map((h) => ({
    ...h,
    claimed_status: h.status,
    supporting_refs: h.status === "DISPROVED" ? [] : ["splunk:1:1"],
    contradicting_refs: h.status === "DISPROVED" ? ["splunk:1:2"] : [],
    predicted_observations: [],
    service: "shop",
    notes: [],
  })),
  deployed: [],
  impact: {
    objects: [{ field: "order_code", distinct: 3, failure_events: 5, lower_bound: false }],
    failure_events: 5,
    repeats: 2,
    state_money: "UNKNOWN",
  },
  coverage: [],
  gaps: [],
  missing: [{ objective: "state impact", needed: "order DB state for the affected orders" }],
  actions: [],
  refs: ["splunk:1:1", "splunk:1:2"],
  new_evidence: 2,
  queries_used: 2,
  query_budget: 12,
  signature: "x",
  stop_reason: "scripted",
});
function installRuntimeStubs() {
  const realAgent = getExecutor("agent");
  const realIntegration = getExecutor("integration");
  const isRuntime = (ctx: ExecutionContext) => ctx.run.definition_key === RUNTIME_WORKFLOW;
  registerExecutor("agent", {
    async execute(ctx): Promise<ExecResult> {
      if (!isRuntime(ctx)) return realAgent.execute(ctx);
      // Telemetry as a provider would report it, so per-incident cost/turn aggregation is exercised.
      await ctx.recordMetrics({ tokens: { input: 1000, output: 200 }, cost_usd: 0.01, turns: 2 });
      return {
        kind: "completed",
        output: { findings: [], answers: [], missing_evidence: [], next_steps: [] },
      };
    },
  });
  registerExecutor("integration", {
    async execute(ctx): Promise<ExecResult> {
      if (!isRuntime(ctx)) return realIntegration.execute(ctx);
      const action = String(ctx.step.config.action ?? "");
      if (action === "investigation_parse") {
        runtimeRequests.push(String(ctx.run.inputs?.request ?? ""));
        return { kind: "completed", output: { request: ctx.run.inputs?.request } };
      }
      if (action === "investigation_correlate")
        return { kind: "completed", output: { complete: true, timeline: [] } };
      if (action === "investigation_report") {
        const s = runtimeScripts.get(String(ctx.run.inputs?.fingerprint)) ?? {
          outcome: "UNKNOWN",
          hypotheses: [],
        };
        return {
          kind: "completed",
          output: {
            status: s.outcome,
            summary: `scripted runtime RCA: ${s.outcome}`,
            findings: [
              {
                statement: "checkout errors started 06:00 after deploy",
                classification: "confirmed",
                evidence_refs: ["splunk:1:1"],
              },
            ],
            hypotheses: [],
            round: round(s),
          },
        };
      }
      return { kind: "completed", output: {} };
    },
  });
}

before(async () => {
  await migrate();
  const n = Date.now();
  owner = await createUser({ username: `ui-owner-${n}`, password: "unified-pass", role: "member" });
  other = await createUser({ username: `ui-other-${n}`, password: "unified-pass", role: "member" });
  admin = await createUser({ username: `ui-admin-${n}`, password: "unified-pass", role: "admin" });
  fx = await setupBugHuntFixture(root);
  repo = fx.repo;
  installRuntimeStubs();
  sandbox = !!(await bwrapAvailable());
});
after(() => pool.end());

const FP_A = () => caseFingerprint("real-bug");
const DEFECT = () => `${repo}:pricing/discount.go:9`;
const attempts = async () =>
  Number(
    (await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM workflow_step_attempts"))!.n,
  );
let huntRunA = 0;
let runtimeRunA = 0;

test("bug hunt first: the hunt is linked to the incident workspace, the verified defect reported apart from causality", async () => {
  const fp = FP_A();
  const empty = await getWorkbench(fp, owner);
  assert.equal(empty.rca.status, "UNKNOWN");
  assert.equal(empty.rca.version, null, "nothing finished → no RCA version yet");
  assert.ok(empty.rca.next_actions.some((a) => a.kind === "start"));
  assert.equal(empty.runtime, null, "nothing is started automatically");
  assert.equal(empty.bug_hunt, null);

  const h = await startHunt(fp, owner, { repositories: [repo], provider: "codex" });
  huntRunA = h.run_id;
  assert.equal(await drive(h.run_id), "COMPLETED");
  const before = await attempts();
  const wb = await getWorkbench(fp, owner);
  assert.equal(await attempts(), before, "reading/reconciling makes no agent call");
  assert.equal(wb.metrics.reconciliation_llm_calls, 0);
  assert.equal(wb.bug_hunt?.run_id, h.run_id);
  assert.equal(
    wb.runs.find((r) => r.run_id === h.run_id)?.link_source,
    "workbench",
    "started here → linked at start",
  );
  assert.equal(wb.rca.version, 1);
  const f = wb.evidence.find((e) => e.source === "bug_hunt")!;
  assert.ok(
    f.ref.startsWith(`bug_hunt:${h.hunt_id}:finding:`),
    "evidence by reference, with its source run",
  );
  assert.equal(f.commit, fx.revision, "provenance: the commit the defect was verified on");
  assert.equal(f.stale, false);
  if (sandbox) {
    assert.equal(f.bug_verification, "CONFIRMED");
    assert.equal(wb.rca.verified_defects.length, 1);
    assert.equal(
      wb.rca.status,
      f.causality === "CONFIRMED"
        ? "CONFIRMED"
        : f.causality === "PROBABLE"
          ? "PROBABLE"
          : "UNKNOWN",
    );
  } else {
    assert.equal(f.bug_verification, "BLOCKED");
    assert.equal(
      wb.rca.verified_defects.length,
      0,
      "a blocked verification is never reported as a verified defect",
    );
  }
  // Same inputs → same version (no duplicate RCA on refresh).
  assert.equal((await getWorkbench(fp, owner)).rca.version, 1);
});

test("then runtime: started on request with the hunt's validated findings as a bounded unverified hint; reconciled into a new version", async () => {
  const fp = FP_A();
  runtimeScripts.set(fp, {
    outcome: "CONFIRMED",
    hypotheses: [
      {
        id: "H1",
        statement: "discount applied twice in Apply for stacked coupons",
        kind: "causal_origin",
        status: "SUPPORTED",
        code_location: DEFECT(),
      },
    ],
  });
  const [a, b] = await Promise.all([startRuntime(fp, owner), startRuntime(fp, owner)]);
  assert.equal(a.run_id, b.run_id, "concurrent clicks → one runtime run");
  runtimeRunA = a.run_id;
  assert.equal(await drive(a.run_id), "COMPLETED");
  const run = await getRun(a.run_id);
  assert.equal(run.inputs.fingerprint, fp);
  const request = runtimeRequests.at(-1)!;
  if (sandbox) {
    assert.match(request, /UNVERIFIED hints/);
    assert.ok((run.inputs.prior_evidence as string[]).every((r) => r.startsWith("bug_hunt:")));
  }
  assert.ok(
    request.split("\n").filter((l) => l.startsWith("- [bug_hunt:")).length <= 8,
    "digest is bounded",
  );
  const wb = await getWorkbench(fp, owner);
  assert.equal(wb.rca.version, 2, "new evidence → new immutable version");
  const cause = wb.rca.causes.find((c) => c.location?.file === "pricing/discount.go")!;
  assert.deepEqual(
    [...cause.sources].sort(),
    sandbox ? ["bug_hunt", "runtime"] : ["bug_hunt", "runtime"],
  );
  assert.equal(wb.rca.status, "CONFIRMED");
  assert.equal(
    wb.rca.causes.filter((c) => c.location?.file === "pricing/discount.go").length,
    1,
    "deduplicated across workflows",
  );
  assert.ok(wb.rca.impact.some((i) => /order_code: 3/.test(i)));
  assert.ok(wb.rca.missing_evidence.some((m) => /order DB state/.test(m)));
  // Per-incident telemetry from the existing attempt telemetry.
  assert.ok(wb.metrics.llm_attempts >= 3);
  assert.ok(wb.runtime?.metrics && wb.runtime.metrics.turns >= 6);
  assert.ok(wb.metrics.cost_usd != null && wb.metrics.cost_usd >= 0.03);
  assert.ok(wb.metrics.cost_per_verified_rca != null);
  // A completed RCA version is immutable.
  await assert.rejects(
    q(pool, "UPDATE incident_rca_versions SET status='UNKNOWN' WHERE investigation_id=$1", [
      wb.investigation_id,
    ]),
    /immutable/,
  );
  const v1 = await rcaVersion(fp, owner, 1);
  assert.ok(v1, "history kept");
});

test("never re-run a completed workflow implicitly; replaying the report step changes nothing", async () => {
  const fp = FP_A();
  await assert.rejects(startRuntime(fp, owner), /already completed/);
  await assert.rejects(
    startHunt(fp, owner, { repositories: [repo], provider: "codex" }),
    /already completed/,
  );
  const before = await attempts();
  await reexecuteStep(runtimeRunA, "report");
  assert.equal(await drive(runtimeRunA), "COMPLETED");
  const wb = await getWorkbench(fp, owner);
  assert.equal(wb.rca.version, 2, "replay with the same evidence → same RCA version");
  assert.equal(await attempts(), before + 1, "only the replayed deterministic step ran");
});

test("duplicate fix prevention: one fix task per reconciled cause, whichever path asks; explicit confirmation required", async () => {
  const fp = FP_A();
  const wb = await getWorkbench(fp, owner);
  const cause = wb.rca.causes.find((c) => c.location?.file === "pricing/discount.go")!;
  await assert.rejects(createFix(fp, owner, { cause_key: cause.key }), /confirmation/);
  await assert.rejects(
    createFix(fp, other, { cause_key: cause.key, confirm: true }),
    /cause not found/,
  );
  const [x, y] = await Promise.all([
    createFix(fp, owner, { cause_key: cause.key, confirm: true }),
    createFix(fp, owner, { cause_key: cause.key, confirm: true }),
  ]);
  assert.equal([x, y].filter((r) => r.created).length, 1);
  const runId = (x.created ? x : y).run_id!;
  await cancelRun(runId);
  const rows = await q(pool, "SELECT * FROM incident_fix_tasks WHERE investigation_id=$1", [
    wb.investigation_id,
  ]);
  assert.equal(rows.length, 1);
  const fixRun = await getRun(runId);
  assert.equal(fixRun.definition_key, "bug-investigation");
  if (sandbox) {
    // The fix went through the verified finding (existing createFixTask), so the Bug Hunter path converges on it.
    assert.ok(fixRun.inputs.bug_hunt_finding_id);
    const again = await createFixTask(
      Number(fixRun.inputs.bug_hunt_id),
      Number(fixRun.inputs.bug_hunt_finding_id),
      owner,
    );
    assert.equal(again.created, true, "the canceled fix may be restarted from the hunt…");
    await cancelRun(again.run_id);
  }
  const after = await getWorkbench(fp, owner);
  assert.ok(after.fix_tasks.length === 1);
  assert.ok(
    !after.rca.next_actions.some((a) => a.kind === "create_fix" && a.cause === cause.key) ||
      sandbox,
  );
});

test("stale evidence: a change to the cited file marks the defect stale (cannot confirm) and asks for a refresh", async () => {
  const fp = FP_A();
  const head = fx.git("rev-parse", "HEAD");
  fx.git(
    "-c",
    "user.name=F",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "unrelated",
  );
  const versionBefore = (await getWorkbench(fp, owner)).rca.version!;
  const unchanged = await getWorkbench(fp, owner);
  assert.equal(
    unchanged.evidence.find((e) => e.source === "bug_hunt")!.stale,
    false,
    "commit without touching the file → fresh",
  );
  assert.equal(
    unchanged.rca.version,
    versionBefore,
    "an unrelated commit does not mint an RCA version",
  );
  const path = `${fx.primary}/pricing/discount.go`;
  const { appendFileSync } = await import("node:fs");
  appendFileSync(path, "\n// changed\n");
  fx.git(
    "-c",
    "user.name=F",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qam",
    "touch discount",
  );
  try {
    const wb = await getWorkbench(fp, owner);
    const f = wb.evidence.find((e) => e.source === "bug_hunt")!;
    assert.equal(f.stale, true);
    assert.ok(wb.rca.next_actions.some((a) => a.kind === "refresh"));
    assert.equal(wb.rca.version, versionBefore + 1, "freshness change → exactly one new version");
  } finally {
    fx.git("reset", "-q", "--hard", head);
  }
});

test("authorization: workspaces are per owner; another user's run linked by mistake is excluded; support read is audited", async () => {
  const fp = FP_A();
  const theirs = await getWorkbench(fp, other);
  assert.equal(theirs.runs.length, 0, "the other user sees none of the owner's runs");
  await assert.rejects(rcaVersion(fp, other, 1), /not found/);
  await assert.rejects(getWorkbench(fp, other, { ownerId: owner.id }), /not found/);
  await assert.rejects(
    getWorkbench(fp, other, { ownerId: owner.id, support: true }),
    /not found/,
    "members cannot use support mode",
  );
  const asAdmin = await getWorkbench(fp, admin, { ownerId: owner.id, support: true });
  assert.equal(asAdmin.owner_id, owner.id);
  const a = await one(
    pool,
    "SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='support.access' AND resource_type='incident_investigation'",
    [admin.id],
  );
  assert.ok(a);
  // Forge a link from the OTHER user's workspace to the owner's runtime run: never read as evidence.
  await q(
    pool,
    "INSERT INTO incident_investigation_runs (investigation_id, run_id, kind, link_source) VALUES ($1,$2,'runtime','forged')",
    [theirs.investigation_id, runtimeRunA],
  );
  const forged = await getWorkbench(fp, other);
  assert.ok(forged.rca.excluded.some((x) => x.reason === "run owned by another user"));
  assert.equal(forged.rca.causes.length, 0);
  assert.notEqual(forged.rca.status, "CONFIRMED");
  await q(pool, "DELETE FROM incident_investigation_runs WHERE investigation_id=$1", [
    theirs.investigation_id,
  ]);
});

test("runtime first, then a contradicting hunt → CONFLICTED with both sides' evidence (other user's own workspace)", async () => {
  const fp = FP_A();
  runtimeScripts.set(fp, {
    outcome: "UNKNOWN",
    hypotheses: [
      {
        id: "H9",
        statement: "discount logic in Apply is not involved",
        kind: "causal_origin",
        status: "DISPROVED",
        code_location: DEFECT(),
      },
    ],
  });
  const r = await startRuntime(fp, other);
  assert.equal(await drive(r.run_id), "COMPLETED");
  const first = await getWorkbench(fp, other);
  assert.equal(first.rca.status, "UNKNOWN");
  assert.ok(
    first.rca.next_actions.some((a) => a.kind === "run_bug_hunt"),
    "suggests (does not start) the other workflow",
  );
  const h = await startHunt(fp, other, { repositories: [repo], provider: "codex" });
  assert.equal(await drive(h.run_id), "COMPLETED");
  const wb = await getWorkbench(fp, other);
  const finding = wb.evidence.find((e) => e.source === "bug_hunt")!;
  if (sandbox && ["CONFIRMED", "PROBABLE"].includes(finding.causality ?? "")) {
    assert.equal(wb.rca.status, "CONFLICTED");
    assert.ok(wb.rca.conflicts[0].refs.some((x) => x.startsWith("run:")));
    assert.ok(wb.rca.conflicts[0].refs.some((x) => x.startsWith("bug_hunt:")));
  } else
    assert.notEqual(
      wb.rca.status,
      "CONFIRMED",
      "a disproved runtime hypothesis never yields CONFIRMED",
    );
  // Owner's workspace is unaffected by the other user's runs.
  assert.equal((await getWorkbench(fp, owner)).rca.status, "CONFIRMED");
});

test("parallel runs and partial failure: both started on request, a canceled hunt leaves the runtime RCA standing", async () => {
  const fp = caseFingerprint("nil-edge-case");
  runtimeScripts.set(fp, {
    outcome: "PROBABLE",
    hypotheses: [
      {
        id: "P1",
        statement: "partner timeout in the payment provider",
        kind: "causal_origin",
        status: "SUPPORTED",
        code_location: null,
      },
    ],
  });
  const both = await startBoth(fp, owner, { repositories: [repo], provider: "codex" });
  const rt = both.runtime as { run_id: number };
  const bh = both.bug_hunt as { run_id: number; hunt_id: number };
  assert.ok(rt.run_id && bh.run_id);
  const again = await startBoth(fp, owner, { repositories: [repo], provider: "codex" });
  assert.equal(
    (again.runtime as { run_id: number }).run_id,
    rt.run_id,
    "no duplicate runtime while one is active",
  );
  assert.equal(
    (again.bug_hunt as { run_id: number }).run_id,
    bh.run_id,
    "no duplicate hunt while one is active",
  );
  const progress = await getWorkbench(fp, owner);
  assert.equal(progress.runtime?.active, true);
  assert.equal(progress.bug_hunt?.active, true);
  assert.equal(progress.rca.version, null, "no conclusion while nothing has finished");
  await cancelRun(bh.run_id);
  assert.equal(await drive(rt.run_id), "COMPLETED");
  const wb = await getWorkbench(fp, owner);
  assert.equal(wb.bug_hunt?.status, "CANCELED");
  assert.equal(wb.rca.status, "PROBABLE");
  const provider = wb.rca.causes.find((c) => c.location == null)!;
  assert.equal(provider.code_fixable, false, "a provider/config cause never becomes a code task");
  await assert.rejects(
    createFix(fp, owner, { cause_key: provider.key, confirm: true }),
    /not an eligible code defect/,
  );
  assert.ok(!wb.rca.next_actions.some((a) => a.kind === "create_fix"));
});

test("efficiency: a runtime RCA started from the workbench makes exactly the agent calls of a standalone run", async () => {
  const fp = caseFingerprint("idempotency");
  runtimeScripts.set(fp, { outcome: "UNKNOWN", hypotheses: [] });
  const standalone = await startRun({
    definitionKey: RUNTIME_WORKFLOW,
    inputs: { request: "standalone", environment: "production", fingerprint: `standalone-${fp}` },
    ownerId: owner.id,
  });
  assert.equal(await drive(standalone.id), "COMPLETED");
  const unified = await startRuntime(fp, owner);
  assert.equal(await drive(unified.run_id), "COMPLETED");
  await getWorkbench(fp, owner);
  await getWorkbench(fp, owner);
  const calls = async (id: number) =>
    Number(
      (await one<{ n: number }>(
        pool,
        "SELECT count(*)::int AS n FROM execution_attempt_telemetry WHERE run_id=$1 AND provider IS NOT NULL",
        [id],
      ))!.n,
    );
  assert.equal(
    await calls(unified.run_id),
    await calls(standalone.id),
    "no extra LLM calls from unification",
  );
  // Benchmark lines for docs/validation/unified-incident-investigation.md (offline: stubbed runtime agents).
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) await getWorkbench(FP_A(), owner);
  const reconcileMs = (performance.now() - t0) / 5;
  const reqA = await one<{ n: number }>(
    pool,
    "SELECT length(inputs->>'request') AS n FROM workflow_runs WHERE id=$1",
    [runtimeRunA],
  );
  const reqBase = await one<{ n: number }>(
    pool,
    "SELECT length(inputs->>'request') AS n FROM workflow_runs WHERE id=$1",
    [unified.run_id],
  );
  const tel = async (id: number) =>
    one<{ calls: number; tin: number; tout: number }>(
      pool,
      "SELECT count(*) FILTER (WHERE provider IS NOT NULL)::int AS calls, COALESCE(sum(input_tokens),0)::int AS tin, COALESCE(sum(output_tokens),0)::int AS tout FROM execution_attempt_telemetry WHERE run_id=$1",
      [id],
    );
  console.log(`BENCH standalone runtime: ${JSON.stringify(await tel(standalone.id))}`);
  console.log(
    `BENCH unified runtime (no prior evidence): ${JSON.stringify(await tel(unified.run_id))}`,
  );
  console.log(
    `BENCH unified runtime (with bug-hunt digest): ${JSON.stringify(await tel(runtimeRunA))} request_chars=${reqA!.n} vs ${reqBase!.n} without digest`,
  );
  console.log(
    `BENCH workbench read+reconcile: ${reconcileMs.toFixed(1)} ms avg, 0 LLM calls; RCA versions for incident A: ${(await getWorkbench(FP_A(), owner)).versions.length}`,
  );
  void huntRunA;
});

test("discovery: a hunt started from the existing Bug Hunter UI (not the workbench) is linked to the same workspace", async () => {
  const fp = caseFingerprint("idempotency");
  const h = await startBugHunt(fp, owner, { repositories: [repo], provider: "codex" });
  await cancelRun(h.run_id);
  const wb = await getWorkbench(fp, owner);
  assert.equal(wb.runs.find((r) => r.run_id === h.run_id)?.link_source, "bug_hunts");
  assert.equal(wb.bug_hunt?.run_id, h.run_id);
  assert.equal(
    (await getWorkbench(fp, other)).runs.some((r) => r.run_id === h.run_id),
    false,
  );
});

// ---- shared results (flag SHARED_RESULTS_PROD_ERRORS): a run started with prior evidence is never shared (REVIEW.md C1)
// Its prompt carries the starter's own evidence of the other workflow (file locations, statements, log hypotheses) and the
// key does not, so sharing it would leak that evidence across permissions and merge different analyses.
const sharedRowsOf = (fp: string) =>
  q<{ kind: string; status: string }>(
    pool,
    "SELECT kind, status FROM shared_analyses WHERE error_key = $1 ORDER BY id",
    [fp],
  );
async function withSharing<T>(fn: (events: SharedEvent[]) => Promise<T>) {
  const events: SharedEvent[] = [];
  resetSharingHooks();
  setSharingHooks({ observe: (e) => void events.push(e) });
  // A hunt's key needs the repository's base commit (refs/remotes/origin/<branch>), which a remote-less fixture lacks.
  fx.git("update-ref", "refs/remotes/origin/main", fx.revision);
  config.sharedResults.prodErrors = true;
  try {
    return await fn(events);
  } finally {
    config.sharedResults.prodErrors = false;
    await settleBackground();
    resetSharingHooks();
  }
}

test("C1 hunt: a hunt started with prior evidence neither reads nor publishes a shared result; one without it still does", async () => {
  const fp = caseFingerprint("race-condition");
  await withSharing(async (events) => {
    const hinted = await startHuntShared(fp, owner, {
      repositories: [repo],
      provider: "codex",
    });
    assert.ok(hinted.run_id, "the hunt itself runs as before");
    await cancelRun(hinted.run_id);
    const clean = events.length;
    assert.ok(clean > 0, "control: a hunt without evidence is looked up and claimed");
    assert.deepEqual(
      (await sharedRowsOf(fp)).map((r) => r.kind),
      ["prod_error.bug_hunt"],
    );

    events.length = 0;
    const withEvidence = await startBugHuntShared(caseFingerprint("race-condition"), other, {
      repositories: [repo],
      provider: "codex",
      context:
        "\nPrior evidence from the Runtime RCA of this incident (UNVERIFIED hints):\n- [run:1] x",
      prior_evidence: ["run:1:finding:1"],
    });
    assert.ok(withEvidence.run_id, "a hunt with evidence runs as before");
    assert.equal(withEvidence.shared, undefined, "and is not answered from a shared result");
    assert.deepEqual(events, [], "no lookup, no claim, no wait, nothing published");
    assert.equal((await sharedRowsOf(fp)).length, 1, "only the evidence-free claim exists");
    await cancelRun(withEvidence.run_id);
  });
});

test("C1 RCA: a runtime RCA started with the hunt's evidence neither reads nor publishes a shared result; without evidence it does (when log access is present)", async () => {
  const withEvidenceFp = caseFingerprint("transaction-consistency");
  await withSharing(async (events) => {
    // N8: without Splunk/SigNoz, the owner bypasses sharing and never claims a shared RCA.
    const noLogs = await startRuntimeShared(caseFingerprint("correct-code-suspected"), owner, {});
    assert.ok("run_id" in noLogs && noLogs.run_id, "runs unshared as before");
    assert.ok(
      events.some((e) => e.outcome === "bypass" && e.reason === "access"),
      "N8: owner without log access is bypassed",
    );
    assert.deepEqual(await sharedRowsOf(caseFingerprint("correct-code-suspected")), []);
    await cancelRun((noLogs as { run_id: number }).run_id);

    // Control: with log access and no evidence of the other workflow, the RCA is shared (looked up and claimed).
    events.length = 0;
    await putUserSecret(
      owner.id,
      "splunk_token",
      JSON.stringify({ token: "t", user: owner.username }),
    );
    try {
      const plain = await startRuntimeShared(caseFingerprint("correct-code-suspected"), owner, {});
      assert.ok("run_id" in plain && plain.run_id, "runs as before");
      assert.ok(
        events.some((e) => e.outcome === "miss"),
        "control: an evidence-free RCA with log access is shared",
      );
      await cancelRun((plain as { run_id: number }).run_id);

      // The owner's own hunt of this incident gives the workbench evidence for the RCA's prompt.
      const h = await startHunt(withEvidenceFp, owner, { repositories: [repo], provider: "codex" });
      assert.equal(await drive(h.run_id), "COMPLETED");
      const evidence = (await getWorkbench(withEvidenceFp, owner)).evidence.filter(
        (e) => e.source === "bug_hunt" && e.valid && !e.stale,
      );
      events.length = 0;
      const r = await startRuntimeShared(withEvidenceFp, owner, {});
      assert.ok("run_id" in r && r.run_id, "runs as before");
      const used =
        ((await getRun((r as { run_id: number }).run_id)).inputs.prior_evidence as string[]) ?? [];
      if (sandbox)
        assert.ok(used.length > 0 && evidence.length > 0, "the run did carry the hunt's evidence");
      if (used.length) {
        assert.deepEqual(events, [], "so: no lookup, no claim, nothing published");
        assert.deepEqual(await sharedRowsOf(withEvidenceFp), []);
      } else assert.ok(events.length > 0, "no evidence reached the prompt: it is shared as usual");
      await cancelRun((r as { run_id: number }).run_id);
    } finally {
      await deleteUserSecret(owner.id, "splunk_token").catch(() => {});
    }
  });
});
