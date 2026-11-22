/**
 * Offline Production Bug Hunter benchmark (fixtures in bugHuntFixtures.ts), two arms on the same incidents, repository
 * and revision, through the real Workflow Engine, scheduler and Agent Harness:
 *   A  the existing `incident-investigation` workflow (discover → investigate → evidence report);
 *   B  the `production-bug-hunt` workflow (the same investigation + scope + hunter + triage + independent verifier +
 *      isolated reproduction + report), started from the incident like the UI does.
 * Grading: a "reported bug" is A's named root-cause location, or a CONFIRMED finding of B. Attribution is the code the
 * arm names as the incident's cause (B: a CONFIRMED bug whose causality is CONFIRMED or PROBABLE).
 */
import { pool, q, one } from "../db/pool.ts";
import { startRun, getRun, cancelRun } from "../workflow/engine.ts";
import { runOnce } from "../workflow/scheduler.ts";
import { describeGroup, type GroupRow } from "../prodErrors/scan.ts";
import { startBugHunt } from "../bugHunt/service.ts";
import { bareName } from "../bugHunt/logic.ts";
import type { PublicUser } from "../auth/users.ts";
import type { AgentProvider } from "../agent/provider.ts";
import { BUG_HUNT_CASES, caseFingerprint, type BugHuntCase } from "./bugHuntFixtures.ts";

export interface BugHuntGrade {
  case: string;
  arm: "A" | "B";
  run_id: number;
  run_status: string;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  reported: string[];
  attribution: string | null;
  attribution_correct: boolean;
  reproductions: { attempted: number; reproduced: number };
  statuses?: Record<string, number>;
  verifier_saw_hunter_output?: boolean | null;
  reused?: number;
  tool_calls: number;
  latency_ms: number;
  tokens: { input: number | null; output: number | null };
  cost_usd: number | null;
}

const loc = (x: { file_path: string; function: string }) =>
  `${x.file_path}#${bareName(x.function)}`;

/** The incident as the scanner would have persisted it (no live log/trace access needed). */
export async function seedIncident(c: BugHuntCase, repo: string, commit: string) {
  const fp = caseFingerprint(c.id);
  await q(
    pool,
    `INSERT INTO prod_error_groups (fingerprint, namespace, service, level, caller, signature, sample, detail, day, today_count, yesterday_count, severity)
     VALUES ($1,'shop-prod',$2,'ERROR',$3,$4,$5,$6,current_date,12,0,'high')
     ON CONFLICT (fingerprint) DO UPDATE SET detail=EXCLUDED.detail, caller=EXCLUDED.caller`,
    [
      fp,
      c.service,
      c.caller,
      c.signature,
      `level=error msg="${c.error}"`,
      JSON.stringify({
        err: c.error,
        ...(c.stack ? { stack: c.stack } : {}),
        image: `registry.example.invalid/shop/${repo}:prod.2611220000.${commit.slice(0, 12)}`,
        request_id: `req-${c.id}`,
        sources: ["splunk"],
      }),
    ],
  );
  return fp;
}

async function drive(runId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) return r.status;
    if (!(await runOnce())) await new Promise((res) => setTimeout(res, 50));
  }
  await cancelRun(runId).catch(() => {});
  return "timeout";
}

async function telemetry(runId: number) {
  const calls = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM agent_context_tool_calls WHERE run_id = $1",
    [runId],
  );
  const t = await one<{ i: number | null; o: number | null; c: number | null }>(
    pool,
    "SELECT sum(input_tokens)::bigint AS i, sum(output_tokens)::bigint AS o, sum(reported_cost_usd) AS c FROM execution_attempt_telemetry WHERE run_id = $1",
    [runId],
  ).catch(() => null);
  return {
    tool_calls: calls?.n ?? 0,
    tokens: { input: t?.i == null ? null : Number(t.i), output: t?.o == null ? null : Number(t.o) },
    cost_usd: t?.c == null ? null : Number(t.c),
  };
}

function score(c: BugHuntCase, reported: string[]) {
  const truth = new Set(c.truth.bugs.map(loc));
  return {
    true_positives: reported.filter((r) => truth.has(r)).length,
    false_positives: reported.filter((r) => !truth.has(r)).length,
    false_negatives: [...truth].filter((t) => !reported.includes(t)).length,
  };
}

const causeOf = (c: BugHuntCase) => (c.truth.cause ? loc(c.truth.cause) : null);

export async function runArmA(
  c: BugHuntCase,
  o: { owner: PublicUser; repo: string; provider: AgentProvider; timeoutMs?: number },
): Promise<BugHuntGrade> {
  const fp = caseFingerprint(c.id);
  const g = await one<GroupRow>(
    pool,
    "SELECT *, day::text AS day FROM prod_error_groups WHERE fingerprint=$1",
    [fp],
  );
  const t0 = Date.now();
  const run = await startRun({
    definitionKey: "incident-investigation",
    title: `Bug hunt benchmark A ${c.id}`,
    inputs: { request: `${describeGroup(g!)}\nfingerprint: ${fp}` },
    repositories: [o.repo],
    agentProvider: o.provider,
    ownerId: o.owner.id,
  });
  const status = await drive(run.id, o.timeoutMs ?? 300_000);
  const inv = await one<{ output: Record<string, unknown> | null }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id=$1 AND key='investigate'",
    [run.id],
  );
  const answer = inv?.output?.rca_answer as
    { file_path: string; function: string } | null | undefined;
  const reported = answer ? [loc(answer)] : [];
  return {
    case: c.id,
    arm: "A",
    run_id: run.id,
    run_status: status,
    ...score(c, reported),
    reported,
    attribution: reported[0] ?? null,
    attribution_correct: (reported[0] ?? null) === causeOf(c),
    reproductions: { attempted: 0, reproduced: 0 },
    latency_ms: Date.now() - t0,
    ...(await telemetry(run.id)),
  };
}

export async function runArmB(
  c: BugHuntCase,
  o: { owner: PublicUser; repo: string; provider: AgentProvider; timeoutMs?: number },
): Promise<BugHuntGrade> {
  const fp = caseFingerprint(c.replays ?? c.id);
  const t0 = Date.now();
  const started = await startBugHunt(fp, o.owner, { repositories: [o.repo], provider: o.provider });
  const status = await drive(started.run_id, o.timeoutMs ?? 300_000);
  const hunt = await one<{ id: number; report: Record<string, unknown> | null }>(
    pool,
    "SELECT id, report FROM bug_hunts WHERE run_id=$1",
    [started.run_id],
  );
  const findings = await q<{ finding: Record<string, unknown> }>(
    pool,
    "SELECT finding FROM bug_hunt_findings WHERE hunt_id=$1 ORDER BY id",
    [hunt!.id],
  );
  const f = findings.map(
    (x) => x.finding as Record<string, unknown> & { file_path: string; function: string },
  );
  const confirmed = f.filter((x) => x.bug_verification_status === "CONFIRMED");
  const reported = confirmed.map(loc);
  const cause = confirmed.find((x) =>
    ["CONFIRMED", "PROBABLE"].includes(String(x.incident_causality_status)),
  );
  const runs =
    (hunt?.report?.execution as { reproductions?: Array<{ outcome: string }> })?.reproductions ??
    [];
  const verifySummary = await one<{ output: Record<string, unknown> | null }>(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id=$1 AND key='verify' AND status='COMPLETED'",
    [started.run_id],
  );
  const statuses: Record<string, number> = {};
  for (const x of f)
    statuses[String(x.bug_verification_status)] =
      (statuses[String(x.bug_verification_status)] ?? 0) + 1;
  return {
    case: c.id,
    arm: "B",
    run_id: started.run_id,
    run_status: status,
    ...score(c, reported),
    reported,
    attribution: cause ? loc(cause) : null,
    attribution_correct: (cause ? loc(cause) : null) === causeOf(c),
    reproductions: {
      attempted: runs.filter((r) => r.outcome !== "not_run").length,
      reproduced: runs.filter((r) => r.outcome === "reproduced").length,
    },
    statuses,
    verifier_saw_hunter_output: verifySummary?.output
      ? String(verifySummary.output.summary ?? "").includes("VISIBLE")
      : null,
    reused: f.filter((x) => x.reused_from).length,
    latency_ms: Date.now() - t0,
    ...(await telemetry(started.run_id)),
  };
}

export function summarizeBugHunt(grades: BugHuntGrade[]) {
  const arm = (a: "A" | "B") => {
    const g = grades.filter((x) => x.arm === a);
    const sum = (k: "true_positives" | "false_positives" | "false_negatives") =>
      g.reduce((n, x) => n + x[k], 0);
    const tp = sum("true_positives"),
      fp = sum("false_positives"),
      fn = sum("false_negatives");
    const att = g.reduce((n, x) => n + x.reproductions.attempted, 0);
    const rep = g.reduce((n, x) => n + x.reproductions.reproduced, 0);
    return {
      cases: g.length,
      completed: g.filter((x) => x.run_status === "COMPLETED").length,
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
      reproduction_success: att ? rep / att : null,
      attribution_accuracy: g.length
        ? g.filter((x) => x.attribution_correct).length / g.length
        : null,
      mean_tool_calls: g.length ? g.reduce((n, x) => n + x.tool_calls, 0) / g.length : null,
      mean_latency_ms: g.length
        ? Math.round(g.reduce((n, x) => n + x.latency_ms, 0) / g.length)
        : null,
      tokens_reported: g.some((x) => x.tokens.input != null),
      cost_usd: g.some((x) => x.cost_usd != null)
        ? g.reduce((n, x) => n + (x.cost_usd ?? 0), 0)
        : null,
    };
  };
  return { A: arm("A"), B: arm("B") };
}

export { BUG_HUNT_CASES };
