import { pool, q, one } from "../db/pool.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectHandoffWorkspace } from "../git/workspaceCheckpoint.ts";
export {
  inspectHandoffWorkspace,
  classifyHandoffUntracked,
  isHandoffScratch,
} from "../git/workspaceCheckpoint.ts";
import { safeDiagnostics, normalizeProviderFailure, type FailureCategory } from "./telemetry.ts";
import { redactContextValue } from "../context/redact.ts";
import { summarizeValue } from "../context/plan.ts";
import { evidenceSummary, type ApprovedScope } from "./evidence.ts";
import { config } from "../config.ts";
import { codexCapabilities } from "./codex/run.ts";
import { cursorCapabilities } from "./cursor/run.ts";
import { antigravityCapabilities } from "./antigravity/capabilities.ts";
import { copilotCapabilities } from "./copilot/capabilities.ts";
import { agentEnvironment } from "./environment.ts";
import type { EffectiveAgent } from "./stepAgent.ts";
import type { RunRow, StepRow, AttemptRow, ExecResult } from "../workflow/types.ts";

const exec = promisify(execFile);
export const AUTOMATIC_FAILURES: FailureCategory[] = [
  "RATE_LIMIT",
  "QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
];
export const PAUSABLE_FAILURES: FailureCategory[] = [
  ...AUTOMATIC_FAILURES,
  "AUTHENTICATION",
  "CONTEXT_LIMIT",
  "EXECUTION_TIMEOUT",
  "UNKNOWN",
];
export async function providerFailure(
  attemptId: number,
  result: ExecResult,
): Promise<FailureCategory | null> {
  if (result.kind !== "failed") return null;
  const metrics = (
    await one<{
      metrics: {
        provider_sessions?: Record<
          string,
          { start_time?: unknown; normalized_failure_category?: FailureCategory | null }
        > | null;
      } | null;
    }>(pool, "SELECT metrics FROM workflow_step_attempts WHERE id=$1", [attemptId])
  )?.metrics;
  // Prefer structured executor/provider diagnostics, then the latest reported session category.
  const detail = result.details;
  const providerError =
    detail && typeof detail === "object" && "provider_error" in detail
      ? detail.provider_error
      : undefined;
  const normalized = normalizeProviderFailure(providerError ?? { message: result.error });
  const sessions = Object.values(metrics?.provider_sessions ?? {});
  const reported = sessions
    .sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)))
    .find(
      (s) => s.normalized_failure_category && s.normalized_failure_category !== "UNKNOWN",
    )?.normalized_failure_category;
  return normalized !== "UNKNOWN" ? normalized : (reported ?? normalized);
}
export function handoffBlockReason(error: unknown) {
  const message = error instanceof Error ? error.message : safeDiagnostics(error);
  return message.startsWith("Workspace inspection failed:")
    ? message
    : `Workspace inspection failed: ${message}`;
}

export async function buildHandoffPackage(
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  reason: string,
) {
  const workspace = await inspectHandoffWorkspace(run.id);
  const [continuity, packs, notes, events, checkpoints, artifacts, item, observation] =
    await Promise.all([
      one(pool, "SELECT content FROM agent_context_continuity WHERE attempt_id=$1", [attempt.id]),
      q(pool, "SELECT id,snapshot_id FROM agent_context_packs WHERE attempt_id=$1", [attempt.id]),
      q(
        pool,
        "SELECT id,data FROM workflow_checkpoints WHERE step_id=$1 ORDER BY id DESC LIMIT 10",
        [step.id],
      ),
      q(
        pool,
        "SELECT id,kind,left(content,2000) AS text,data FROM workflow_events WHERE attempt_id=$1 AND kind IN ('command','tool','tool_result','log') ORDER BY id DESC LIMIT 30",
        [attempt.id],
      ),
      q(
        pool,
        "SELECT id,reason FROM workflow_checkpoints WHERE attempt_id=$1 ORDER BY id DESC LIMIT 20",
        [attempt.id],
      ),
      q(
        pool,
        "SELECT id,kind,name FROM workflow_artifacts WHERE attempt_id=$1 ORDER BY id DESC LIMIT 30",
        [attempt.id],
      ),
      run.work_item_id
        ? one(pool, "SELECT id,title,description FROM work_items WHERE id=$1 AND owner_id=$2", [
            run.work_item_id,
            run.owner_id,
          ])
        : null,
      one(pool, "SELECT output,metrics FROM workflow_step_attempts WHERE id=$1", [attempt.id]),
    ]);
  const detailed = JSON.stringify(redactContextValue(workspace.workspaces));
  if (detailed.length > 4 * 1024 * 1024)
    throw new Error("Detailed workspace evidence exceeds bounded handoff storage");
  const artifact = await one(
    pool,
    `INSERT INTO workflow_artifacts(run_id,step_id,attempt_id,kind,name,content,data) VALUES($1,$2,$3,'provider_handoff',$4,$5,$6)
 ON CONFLICT(attempt_id,name) WHERE kind='provider_handoff' DO UPDATE SET content=excluded.content RETURNING id`,
    [
      run.id,
      step.id,
      attempt.id,
      `handoff-workspace-${workspace.fingerprint}`,
      detailed,
      JSON.stringify({ fingerprint: workspace.fingerprint }),
    ],
  );
  // Verified context the next provider reuses instead of re-investigating: approved scope, evidence summary (high-risk
  // items first), tests already executed and whether they still match the workspace, and what is still unverified.
  const runSteps = await q<{
    key: string;
    type: string;
    status: string;
    output: {
      approved_scope?: ApprovedScope | null;
      tested_heads?: Record<string, string> | null;
      results?: unknown;
      verification?: { passed?: boolean | null } | null;
      passed?: boolean | null;
      verdict?: string;
      verified_heads?: Record<string, string> | null;
    } | null;
    independent: boolean;
  }>(
    pool,
    "SELECT key, type, status, output, config->>'independent' = 'true' AS independent FROM workflow_steps WHERE run_id = $1 ORDER BY position",
    [run.id],
  );
  const heads = Object.fromEntries(workspace.workspaces.map((w) => [w.repository, w.head]));
  const approvedScope =
    [...runSteps].reverse().find((x) => x.status === "COMPLETED" && x.output?.approved_scope)
      ?.output?.approved_scope ?? null;
  const testsExecuted = runSteps.flatMap((x) => {
    const o = x.output;
    const tested = o?.tested_heads;
    if (!tested || !(Array.isArray(o.results) || o.verification)) return [];
    return [
      {
        step: x.key,
        passed: o.passed ?? o.verification?.passed ?? null,
        tested_heads: tested,
        matches_current_workspace: Object.entries(heads).every(([r, h]) => tested[r] === h),
      },
    ];
  });
  const missing: string[] = [];
  if (!testsExecuted.some((t) => t.passed === true && t.matches_current_workspace))
    missing.push("no passing test run on the current workspace commits");
  for (const v of runSteps.filter((x) => x.independent))
    if (!(
      v.status === "COMPLETED" &&
      v.output?.verdict === "PASS" &&
      Object.entries(heads).every(([r, h]) => v.output?.verified_heads?.[r] === h)
    ))
      missing.push(`independent verification "${v.key}" has no PASS on the current commits`);
  if (workspace.workspaces.some((w) => w.status.trim()))
    missing.push(
      "uncommitted changes in the workspace (not tested or reviewed as committed state)",
    );
  const evidence = evidenceSummary(
    Object.fromEntries(runSteps.map((x) => [x.key, { output: x.output, status: x.status }])),
  );
  const content = redactContextValue({
    version: 1,
    approved_scope: approvedScope
      ? {
          proposal_hash: approvedScope.proposal_hash,
          summary: approvedScope.summary,
          changes: approvedScope.changes,
          risk: approvedScope.risk,
        }
      : null,
    evidence_summary: evidence ? summarizeValue(evidence, 6000) : null,
    tests_already_executed: testsExecuted,
    missing_verification: missing,
    workspace_artifact_id: artifact.id,
    workflow_definition_key: run.definition_key,
    definition_version_id: run.definition_version_id,
    run_id: run.id,
    step_id: step.id,
    step_key: step.key,
    source_attempt_id: attempt.id,
    original_task: summarizeValue(
      { item, inputs: run.inputs, instructions: step.config.instructions },
      6000,
    ),
    context_references: {
      transcript_attempt_id: attempt.id,
      snapshot_id: attempt.context_snapshot_id,
      packs,
      artifacts,
      checkpoints,
    },
    business_rules_and_acceptance_criteria:
      "Requirements, enforced rules and remaining criteria are retained in the referenced immutable context pack. Retrieve with platform.get_run_context/get_step_output/search_knowledge; do not discard constraints.",
    repository_state: workspace.workspaces.map((w) => ({
      repository: w.repository,
      branch: w.branch,
      path: w.path,
      head: w.head,
      status: w.status.slice(0, 1000),
      diff_summary: w.diff_summary.slice(0, 1000),
      diff_hash: w.diff_hash,
      index_hash: w.index_hash,
      untracked_count: w.untracked.length,
      details_artifact_id: artifact.id,
    })),
    scratch_omitted: workspace.scratchOmitted
      ? {
          count: workspace.scratchOmitted,
          note: "Untracked .repair-tmp build cache was left on disk and excluded from the checkpoint hash. The next agent still sees those files. They are not the change to preserve.",
        }
      : null,
    progress: summarizeValue(
      continuity?.content ?? {
        available: false,
        reason: "No structured progress reported",
        source_output_unverified: observation?.output ?? null,
        verification: observation?.metrics?.verification ?? null,
      },
      10000,
    ),
    previous_decisions_and_pending_work: summarizeValue(notes, 5000),
    commands_tests_and_verification: summarizeValue(events, 6000),
    known_failure: safeDiagnostics(reason),
    safety:
      "Provider-neutral handoff. Inspect current Git state first. Preserve uncommitted changes. Session identifiers are not transferable. Agent claims are not verified completion.",
  });
  if (JSON.stringify(content).length > 128000)
    throw new Error("Handoff metadata exceeds bounded package budget");
  return { content, fingerprint: workspace.fingerprint };
}

/** Readiness checks do not invoke a model or change credentials. Unknown quota/billing is never called available. */
let testReadiness:
  | ((a: EffectiveAgent) => Promise<{ ok: boolean; error?: string; quota: string; cost: string }>)
  | undefined;
let readinessSeam = 0;
export function setHandoffReadinessForTests(value: typeof testReadiness) {
  if (config.test.platformTest !== "1") throw new Error("Test readiness override disabled");
  testReadiness = value;
  readinessSeam++;
}
/** Changes when tests replace readiness: a shared health reading taken before the change is not reused after it. */
export const readinessSeamVersion = () => readinessSeam;
export async function handoffReadiness(a: EffectiveAgent) {
  if (testReadiness) return testReadiness(a);
  try {
    if (a.provider === "codex") {
      const c = await codexCapabilities(false, {
        model: a.model ?? "",
        effort: a.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    }
    if (a.provider === "cursor") {
      const c = await cursorCapabilities();
      return {
        ok: c.ok && (!a.model || !!c.supportsModel),
        error: c.error ?? (a.model && !c.supportsModel ? "Cursor --model unsupported" : undefined),
        quota: "unknown",
        cost: "unknown",
      };
    }
    if (a.provider === "copilot") {
      const c = await copilotCapabilities(false, {
        model: a.model ?? "",
        effort: a.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    }
    if (a.provider === "antigravity") {
      const c = await antigravityCapabilities(false, {
        model: a.model ?? "",
        effort: a.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    }
    const configured = config.agent.claudeBin;
    const bin = configured || "claude";
    const { stdout } = await exec(
      process.execPath === bin ? bin : bin.endsWith(".js") ? process.execPath : bin,
      bin.endsWith(".js") ? [bin, "auth", "status", "--json"] : ["auth", "status", "--json"],
      {
        timeout: 15000,
        maxBuffer: 64000,
        env: agentEnvironment(process.env, "claude"),
      },
    );
    const status = JSON.parse(stdout);
    return {
      ok: status.loggedIn === true,
      error: status.loggedIn === true ? undefined : "Claude authentication readiness not confirmed",
      quota: "unknown",
      cost: "unknown",
    };
  } catch (error) {
    return {
      ok: false,
      error: safeDiagnostics(error),
      quota: "unknown",
      cost: "unknown",
    };
  }
}
