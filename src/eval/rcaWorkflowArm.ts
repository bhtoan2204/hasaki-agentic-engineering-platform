/**
 * Third arm of the RCA evaluation (C): the `incident-investigation` workflow through the real Workflow Engine, the
 * Agent Harness (provider CLI + MCP bridge + broker), CodeAct in the OS sandbox, provenance and the evidence report.
 * Same incidents, symptom text, ground truth, read-only rca.* tools and grader as the chat arms (A Direct, B CodeAct).
 *
 * The definition is the template's, with two evaluation settings: the report's objectives are the sources these
 * fixture incidents have (trace and log — they carry no repositories, so a code objective could never be met), and
 * the investigation step may be pinned to a model and effort. The answer is the agent's `rca_answer`; its status is
 * the PLATFORM's: a confirmation the evidence report did not verify is graded as PROBABLE, a failed verification as
 * UNCONFIRMED — the arm is credited only for what the workflow itself establishes.
 */
import { createHash } from "node:crypto";
import { pool, q, one } from "../db/pool.ts";
import { definitions } from "../workflow/definitions.ts";
import { TEMPLATES } from "../workflow/templates.ts";
import { startRun, getRun, cancelRun } from "../workflow/engine.ts";
import { runOnce } from "../workflow/scheduler.ts";
import { withCodeActScope } from "../codeact/scope.ts";
import type { AgentProvider } from "../agent/provider.ts";
import type { EffectTask } from "./codeactTasks.ts";
import { gradeRca, incidentProgram, type GroundTruth, type RcaGrade } from "./rcaIncidents.ts";
import { ignoreError } from "../ignoreError.ts";

export interface WorkflowSample {
  task_id: string;
  arm: "workflow";
  repetition: number;
  run_id: number;
  run_status: string;
  correct: boolean;
  rca: RcaGrade["rca"];
  grading: RcaGrade["diagnostics"];
  answer: Record<string, unknown> | null;
  /** The platform's evidence verdict and what it found sufficient / missing. */
  verification: {
    status: string;
    missing_sources: string[];
    root_cause_supported: boolean;
    failures: number;
  } | null;
  platform_root_cause_status: string | null;
  tool_calls: number;
  codeact_executions: number;
  codeact_failed: number;
  evidence_refs: string[];
  latency_ms: number;
  provider_models: string[];
  cost_usd: number | null;
}

/** The evaluation definition: the template's steps, fixture objectives, optional pinned model/effort. */
export async function ensureRcaWorkflow(
  agent: { model?: string | null; effort?: string | null } = {},
) {
  const template = TEMPLATES.find((t) => t.key === "incident-investigation")!;
  const spec = JSON.parse(JSON.stringify(template.spec)) as {
    name: string;
    steps: Array<{ key: string; config: Record<string, unknown> }>;
  };
  for (const step of spec.steps) {
    if (step.key === "report")
      step.config.objectives = { required_sources: ["trace", "log"], require_root_cause: true };
    if (step.key === "investigate" && (agent.model || agent.effort))
      step.config.agent = {
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { reasoning_effort: agent.effort } : {}),
      };
  }
  spec.name = `${spec.name} — RCA evaluation`;
  const key = `rca-eval-${createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 12)}`;
  if (!(await definitions.get(key).catch(() => null))) await definitions.create({ key, spec });
  return key;
}

/** What the investigation is asked: the incident's question plus where to put the structured answer. */
export const workflowRequest = (task: EffectTask) =>
  `${task.question}\nIn your output, besides claims and root_cause_assessment, include "rca_answer" with exactly that JSON object.`;

async function drive(runId: number, deadline: number) {
  while (Date.now() < deadline) {
    const r = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(r.status)) return r.status;
    if (!(await runOnce())) await new Promise((res) => setTimeout(res, 50));
  }
  await cancelRun(runId).catch(ignoreError("eval.cancel_run"));
  return "timeout";
}

const statusOf = (report: Record<string, unknown> | null) => {
  const v = (report?.verification ?? null) as { status?: string } | null;
  const rc = ((report?.root_cause ?? null) as { status?: string } | null)?.status ?? null;
  if (!v || !rc) return "UNCONFIRMED";
  if (v.status === "failed") return "UNCONFIRMED";
  if (rc === "CONFIRMED" && v.status !== "passed") return "PROBABLE";
  return rc;
};

/** One workflow-arm sample: one incident, one run, through the real engine with CodeAct enabled for its agent. */
export async function runWorkflowSample(
  task: EffectTask,
  repetition: number,
  o: {
    ownerId: number;
    provider: AgentProvider;
    definitionKey: string;
    timeoutMs?: number;
  },
): Promise<WorkflowSample> {
  const truth = task.reference!() as unknown as GroundTruth;
  const t0 = Date.now();
  const { runId, status } = await withCodeActScope(true, async () => {
    const run = await startRun({
      definitionKey: o.definitionKey,
      title: `RCA evaluation ${task.id}`,
      inputs: { request: workflowRequest(task) },
      agentProvider: o.provider,
      ownerId: o.ownerId,
    });
    return { runId: run.id, status: await drive(run.id, t0 + (o.timeoutMs ?? 600_000)) };
  });
  const latency = Date.now() - t0;
  const step = (key: string) =>
    one<{ output: Record<string, unknown> | null }>(
      pool,
      "SELECT output FROM workflow_steps WHERE run_id = $1 AND key = $2",
      [runId, key],
    ).then((r) => r?.output ?? null);
  const inv = await step("investigate");
  const report = await step("report");
  const raw = (inv?.rca_answer ?? null) as Record<string, unknown> | null;
  const platformStatus = statusOf(report);
  const answer = raw ? { ...raw, status: platformStatus } : null;
  const grade = gradeRca(truth, answer);
  const calls = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM agent_context_tool_calls WHERE run_id = $1",
    [runId],
  );
  const execs = await q<{ status: string }>(
    pool,
    "SELECT status FROM code_executions WHERE run_id = $1",
    [runId],
  );
  const metrics = await q<{ metrics: Record<string, unknown> | null }>(
    pool,
    "SELECT a.metrics FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id WHERE s.run_id = $1 AND s.key = 'investigate'",
    [runId],
  );
  const costs = metrics
    .map((m) => m.metrics?.cost_usd)
    .filter((c): c is number => typeof c === "number");
  const v = (report?.verification ?? null) as {
    status: string;
    failures?: unknown[];
    sufficiency?: { missing_sources?: string[]; root_cause_supported?: boolean };
  } | null;
  return {
    task_id: task.id,
    arm: "workflow",
    repetition,
    run_id: runId,
    run_status: status,
    correct: grade.correct,
    rca: grade.rca,
    grading: grade.diagnostics,
    answer,
    verification: v
      ? {
          status: v.status,
          missing_sources: v.sufficiency?.missing_sources ?? [],
          root_cause_supported: !!v.sufficiency?.root_cause_supported,
          failures: v.failures?.length ?? 0,
        }
      : null,
    platform_root_cause_status:
      ((report?.root_cause ?? null) as { status?: string } | null)?.status ?? null,
    tool_calls: calls?.n ?? 0,
    codeact_executions: execs.length,
    codeact_failed: execs.filter((e) => e.status !== "ok").length,
    evidence_refs: Array.isArray(report?.evidence_refs) ? (report!.evidence_refs as string[]) : [],
    latency_ms: latency,
    provider_models: [
      ...new Set(metrics.map((m) => String(m.metrics?.model ?? "")).filter(Boolean)),
    ],
    cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

/**
 * The deterministic scripted agent for CI (the fake `codex` provider's script mode): it runs the incident's reference
 * program through platform.execute_code — the same plan the simulated chat arms run — and reports one checkable
 * fact per successful nested call (`observed` count on the recorded result), a root-cause claim resting on them, and
 * the structured answer. It never sees the ground truth; whatever it cannot run is reported missing.
 */
export function scriptedRcaAgent(task: EffectTask): string {
  const program = incidentProgram(task.id);
  return `export default async ({ call }) => {
  const r = JSON.parse(await call("execute_code", { code: ${JSON.stringify(program)} }));
  if (!r.ok) return { summary: "CodeAct failed: " + (r.error ?? ""), claims: [], hypotheses: [], missing_evidence: ["CodeAct: " + (r.failure?.category ?? "failed")], next_steps: [] };
  const { answer, sizes } = r.value;
  const ok = r.calls.filter((c) => c.status === "ok");
  const claims = ok.map((c, i) => ({
    id: "F" + (i + 1),
    claim: sizes[i].count + " " + (sizes[i].key ?? "records") + " from " + c.tool,
    classification: "OBSERVED_FACT",
    source_type: /traces/.test(c.tool) ? "trace" : "production_log",
    source_ref: c.ref ?? null,
    ...(sizes[i].key ? { observed: { pointer: "/" + sizes[i].key, count: sizes[i].count } } : {}),
    verification_status: "verified",
    confidence: "high",
  }));
  const ids = claims.map((c) => c.id);
  claims.push({ id: "R1", claim: answer.root_cause_service + " " + answer.root_cause_operation + ": " + answer.cause,
    classification: answer.status === "CONFIRMED" ? "CONFIRMED_ROOT_CAUSE" : "HYPOTHESIS", supports: ids,
    verification_status: "verified", confidence: "high" });
  return {
    summary: "Root cause candidate: " + answer.cause + " at " + answer.root_cause_service,
    claims,
    hypotheses: [],
    root_cause_assessment: { status: answer.status, confidence: "high",
      explanation: "Derived from the correlated nested results cited in the claims.", supporting_claims: ["R1", ...ids] },
    missing_evidence: (answer.missing_sources ?? []).map((t) => t + ": unavailable"),
    next_steps: answer.next_actions ?? [],
    rca_answer: answer,
  };
};
`;
}

/** Per-arm summary of RCA dimensions, verdicts and cost (complements summarize() for the chat arms). */
export function summarizeWorkflowArm(xs: WorkflowSample[]) {
  const count = (f: (s: WorkflowSample) => boolean) => xs.filter(f).length;
  const dims = xs.reduce<Record<string, number>>((acc, s) => {
    for (const [k, v] of Object.entries(s.rca)) acc[k] = (acc[k] ?? 0) + (v ? 1 : 0);
    return acc;
  }, {});
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  return {
    n: xs.length,
    completed_runs: count((s) => s.run_status === "COMPLETED"),
    correct: count((s) => s.correct),
    rca_dimensions: dims,
    verdicts: xs.reduce<Record<string, number>>((acc, s) => {
      const k = s.verification?.status ?? "none";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    mean_latency_ms: mean(xs.map((s) => s.latency_ms)),
    mean_tool_calls: mean(xs.map((s) => s.tool_calls)),
    codeact_executions: xs.reduce((a, s) => a + s.codeact_executions, 0),
    codeact_failed: xs.reduce((a, s) => a + s.codeact_failed, 0),
    known_cost_usd: xs.some((s) => s.cost_usd != null)
      ? xs.reduce((a, s) => a + (s.cost_usd ?? 0), 0)
      : null,
  };
}
