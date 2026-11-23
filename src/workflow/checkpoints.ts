import { z } from "zod";
import { runEvents } from "./events.ts";
import { observe } from "../runtimeMetrics.ts";
import { recordDecision, savingsFrom } from "./decisions.ts";
import { HttpError } from "../http/error.ts";
import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { ownsInstance } from "../instances.ts";
import { json, one, q, withTx, type Db } from "../db/pool.ts";
import type { AttemptRow, ExecResult, ExecutionFingerprint, JobRow } from "./types.ts";

export const EXECUTION_WORKSPACE_ARTIFACT = "execution_checkpoint_workspace";
const RESULT_BYTES = 128 * 1024;
const RETURNED_RETENTION = 8;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const checkpointHash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

export type WorkspaceCheckpoint = {
  fingerprint: string;
  encryptedContent?: string;
  unavailable?: true;
};

type CheckpointSource = Pick<
  AttemptRow,
  | "id"
  | "run_id"
  | "step_id"
  | "generation"
  | "job_id"
  | "fencing_token"
  | "context_snapshot_id"
  | "input"
  | "agent_provider"
> & {
  context_hash: string | null;
  verification: unknown;
};

const completedResult = z.object({ kind: z.literal("completed"), output: z.unknown() });
const id = z.number().int().positive();
const executionCheckpoint = z.object({
  version: z.literal(1),
  milestone: z.string(),
  data_digest: z.string(),
  binding: z.strictObject({
    run_id: id,
    step_id: id,
    attempt_id: id,
    generation: z.number().int().nonnegative(),
    job_id: id.nullable(),
    fencing_token: z.number().int().nonnegative().nullable(),
    snapshot_id: id.nullable(),
    context_hash: z.string().nullable(),
    input_hash: z.string(),
    provider: z.string().nullable(),
  }),
  workspace_fingerprint: z.string().nullable(),
  workspace_unavailable: z.boolean(),
  workspace_artifact_id: id.nullable(),
  workspace_artifact_digest: z.string().nullable(),
  artifact_ids: z.array(id),
  completed_actions: z.array(z.string()),
  remaining_actions: z.array(z.string()),
  verification: z.object({ digest: z.string(), artifact_ids: z.array(id) }).nullable(),
  result: completedResult.nullable(),
});

type ExecutionCheckpoint = z.infer<typeof executionCheckpoint>;

function bindingOf(source: CheckpointSource) {
  return {
    run_id: source.run_id,
    step_id: source.step_id,
    attempt_id: source.id,
    generation: source.generation,
    job_id: source.job_id,
    fencing_token: source.fencing_token,
    snapshot_id: source.context_snapshot_id,
    context_hash: source.context_hash,
    input_hash: checkpointHash(source.input),
    provider: source.agent_provider ?? null,
  };
}

async function sourceOf(db: Db, attemptId: number) {
  return one<CheckpointSource>(
    db,
    `SELECT a.id,a.run_id,a.step_id,a.generation,a.job_id,a.fencing_token,a.context_snapshot_id,
            a.input,a.agent_provider,a.metrics->'verification' AS verification,cs.hash AS context_hash
       FROM workflow_step_attempts a LEFT JOIN context_snapshots cs
         ON cs.id=a.context_snapshot_id AND cs.run_id=a.run_id AND cs.step_id=a.step_id
      WHERE a.id=$1`,
    [attemptId],
  );
}

async function insertCheckpoint(
  db: Db,
  source: CheckpointSource,
  milestone: string,
  data: unknown,
  result?: ExecResult,
  workspace?: WorkspaceCheckpoint,
  workspaceArtifactId?: number,
) {
  const normalized =
    result?.kind === "completed"
      ? completedResult.parse(
          JSON.parse(JSON.stringify({ kind: "completed", output: result.output ?? {} })),
        )
      : null;
  const proof =
    normalized?.output &&
    typeof normalized.output === "object" &&
    "verification" in normalized.output
      ? normalized.output.verification
      : source.verification;
  const artifacts = await q<{ id: number; kind: string }>(
    db,
    "SELECT id,kind FROM workflow_artifacts WHERE run_id=$1 AND step_id=$2 AND attempt_id=$3 ORDER BY id DESC LIMIT 64",
    [source.run_id, source.step_id, source.id],
  );
  const storedData = JSON.stringify(data ?? {});
  const execution: ExecutionCheckpoint = {
    version: 1,
    milestone,
    data_digest: checkpointHash(JSON.parse(storedData)),
    binding: bindingOf(source),
    workspace_fingerprint: workspace?.fingerprint || null,
    workspace_unavailable: workspace?.unavailable ?? false,
    workspace_artifact_id: workspaceArtifactId ?? null,
    workspace_artifact_digest: workspace?.encryptedContent
      ? checkpointHash(workspace.encryptedContent)
      : null,
    artifact_ids: artifacts.map(({ id }) => id),
    completed_actions:
      milestone === "executor_returned" ? [`executor_returned:${result?.kind}`] : [milestone],
    remaining_actions:
      milestone === "executor_returned"
        ? ["apply_state_transition"]
        : milestone === "waiting_approval"
          ? ["await_approval"]
          : milestone === "provider_handoff"
            ? ["validate_and_confirm_provider_handoff"]
            : ["await_answers"],
    verification:
      proof == null
        ? null
        : {
            digest: checkpointHash(proof),
            artifact_ids: artifacts
              .filter(({ kind }) => /verif|test|evidence/.test(kind))
              .map(({ id }) => id),
          },
    result:
      normalized && Buffer.byteLength(JSON.stringify(normalized)) <= RESULT_BYTES
        ? normalized
        : null,
  };
  const stored = await one<{ bytes: number | null }>(
    db,
    `INSERT INTO workflow_checkpoints(run_id,step_id,attempt_id,reason,data,execution,execution_digest,workspace_artifact_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING octet_length(execution::text) AS bytes`,
    [
      source.run_id,
      source.step_id,
      source.id,
      milestone,
      storedData,
      json(execution),
      checkpointHash(execution),
      workspaceArtifactId ?? null,
    ],
  );
  // bytes: the envelope as PostgreSQL stores it (jsonb text), returned by the INSERT instead of read back.
  return { execution, bytes: Number(stored?.bytes ?? 0) };
}

/** The caller owns the run lock and the status transition that makes this checkpoint recoverable. */
export async function saveExecutionPause(
  db: Db,
  attemptId: number,
  reason: "waiting_input" | "waiting_approval" | "provider_handoff",
  data: unknown,
  workspace?: WorkspaceCheckpoint,
) {
  const source = await sourceOf(db, attemptId);
  if (!source) throw new Error("Cannot checkpoint an unknown attempt");
  if (!source.context_hash) {
    // Pre-snapshot attempts can still answer legacy questions.
    await q(
      db,
      "INSERT INTO workflow_checkpoints(run_id,step_id,attempt_id,reason,data) VALUES($1,$2,$3,$4,$5)",
      [source.run_id, source.step_id, attemptId, reason, json(data)],
    );
    return;
  }
  return (await insertCheckpoint(db, source, reason, data, undefined, workspace)).execution;
}

/** Lease expiry, invalidation and cancellation serialize with this insert via the run and job locks. */
export async function recordExecutorReturn(
  job: JobRow,
  attemptId: number,
  result: ExecResult,
  workspace?: WorkspaceCheckpoint,
  replay?: { fingerprint: ExecutionFingerprint; reusedFrom?: number; latencyMs?: number },
) {
  return withTx(async (db) => {
    const run = await one(
      db,
      "SELECT id FROM workflow_runs WHERE id=$1 AND worker_instance=$2 AND status NOT IN ('CANCELED','COMPLETED','FAILED') FOR UPDATE",
      [job.run_id, config.instanceId],
    );
    if (!run || !(await ownsInstance(db))) return false;
    const live = await one(
      db,
      `SELECT j.id FROM workflow_jobs j JOIN workflow_step_attempts a ON a.job_id=j.id
         JOIN workflow_steps s ON s.id=a.step_id AND s.run_id=a.run_id
        WHERE j.id=$1 AND j.fencing_token=$2 AND j.status='running' AND j.lease_expires_at>clock_timestamp()
          AND j.run_id=$4 AND j.lease_owner=$5
          AND a.id=$3 AND a.status='RUNNING' AND a.fencing_token=j.fencing_token
          AND a.run_id=j.run_id AND a.step_id=j.step_id AND a.generation=j.generation
          AND s.current_attempt_id=a.id AND s.generation=a.generation AND s.status='RUNNING'
        FOR UPDATE OF j`,
      [job.id, job.fencing_token, attemptId, job.run_id, job.lease_owner],
    );
    if (!live) return false;
    if (
      await one(
        db,
        "SELECT id FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='executor_returned'",
        [attemptId],
      )
    )
      return true;

    const source = await sourceOf(db, attemptId);
    if (!source) return false;
    const artifact = workspace?.encryptedContent
      ? await one<{ id: number }>(
          db,
          `INSERT INTO workflow_artifacts(run_id,step_id,attempt_id,kind,name,content,data)
         VALUES($1,$2,$3,$4,'Execution workspace checkpoint',$5,$6) RETURNING id`,
          [
            source.run_id,
            source.step_id,
            attemptId,
            EXECUTION_WORKSPACE_ARTIFACT,
            workspace.encryptedContent,
            json({ version: 1, encrypted: true, fingerprint: workspace.fingerprint }),
          ],
        )
      : undefined;
    const size = await insertCheckpoint(
      db,
      source,
      "executor_returned",
      {},
      result,
      workspace,
      artifact?.id,
    );
    observe(
      "workflow.checkpoint_bytes",
      Number(size?.bytes ?? 0) + (workspace?.encryptedContent?.length ?? 0),
    );
    await recordDecision(db, {
      runId: source.run_id,
      stepId: source.step_id,
      attemptId,
      generation: source.generation,
      kind: "checkpoint",
      action: "RECORD",
      outcome: "applied",
      reason: workspace?.unavailable
        ? "executor returned; workspace evidence unavailable"
        : "executor returned",
      checkpointBytes: Number(size?.bytes ?? 0) + (workspace?.encryptedContent?.length ?? 0),
      details: {
        milestone: "executor_returned",
        workspace_artifact_id: artifact?.id ?? null,
        workspace_unavailable: !!workspace?.unavailable,
        envelope_bytes: Number(size?.bytes ?? 0),
        workspace_bytes: workspace?.encryptedContent?.length ?? 0,
      },
    });
    await q(
      db,
      `UPDATE workflow_step_attempts SET executor_stopped_at=COALESCE(executor_stopped_at,now()),
         execution_fingerprint=$2, reused_from_attempt_id=$3 WHERE id=$1`,
      [attemptId, json(replay?.fingerprint ?? null), replay?.reusedFrom ?? null],
    );
    if (replay?.reusedFrom != null) {
      await runEvents.add(db, source.run_id, "system", "Reused compatible execution result",
        source.step_id, attemptId, {
          action: "REUSE", source_attempt_id: replay.reusedFrom, fingerprint: replay.fingerprint.digest,
        });
      await recordDecision(db, {
        runId: source.run_id,
        stepId: source.step_id,
        attemptId,
        generation: source.generation,
        kind: "replay",
        action: "REUSE",
        outcome: "applied",
        reason: "compatible execution result reused",
        sourceAttemptId: replay.reusedFrom,
        latencyMs: replay.latencyMs ?? null,
        saved: await savingsFrom(db, replay.reusedFrom),
        details: { fingerprint: replay.fingerprint.digest },
      });
    }
    await q(
      db,
      `WITH retired AS (
      DELETE FROM workflow_checkpoints WHERE id IN (
        SELECT id FROM workflow_checkpoints WHERE step_id=$1 AND reason='executor_returned'
        ORDER BY id DESC OFFSET $2
      ) RETURNING workspace_artifact_id
    ) DELETE FROM workflow_artifacts WHERE kind=$3 AND id IN (SELECT workspace_artifact_id FROM retired)`,
      [source.step_id, RETURNED_RETENTION, EXECUTION_WORKSPACE_ARTIFACT],
    );
    return true;
  });
}

type CheckpointData = Record<string, unknown> & {
  recovery?: { kind: string; question_id: number | null };
  failure?: { class: string };
};
type CheckpointRow = {
  data: CheckpointData;
  execution: unknown;
  execution_digest: string | null;
  workspace_artifact_id: number | null;
};

async function validate(db: Db, row: CheckpointRow, attemptId: number, milestone: string) {
  const parsed = executionCheckpoint.safeParse(row.execution);
  if (!parsed.success) return;
  const execution = parsed.data;
  if (
    execution.milestone !== milestone ||
    checkpointHash(row.execution) !== row.execution_digest ||
    checkpointHash(row.data) !== execution.data_digest ||
    row.workspace_artifact_id !== execution.workspace_artifact_id
  )
    return;
  const source = await sourceOf(db, attemptId);
  if (
    !source?.context_hash ||
    checkpointHash(execution.binding) !== checkpointHash(bindingOf(source))
  )
    return;
  if (row.workspace_artifact_id != null) {
    const artifact = await one<{ content: string }>(
      db,
      "SELECT content FROM workflow_artifacts WHERE id=$1 AND attempt_id=$2 AND run_id=$3 AND step_id=$4 AND kind=$5",
      [
        row.workspace_artifact_id,
        attemptId,
        source.run_id,
        source.step_id,
        EXECUTION_WORKSPACE_ARTIFACT,
      ],
    );
    if (!artifact || checkpointHash(artifact.content) !== execution.workspace_artifact_digest)
      return;
  }
  return execution;
}

export async function readExecutionCheckpoint(db: Db, attemptId: number) {
  const row = await one<CheckpointRow>(
    db,
    "SELECT data,execution,execution_digest,workspace_artifact_id FROM workflow_checkpoints WHERE attempt_id=$1 AND reason='executor_returned'",
    [attemptId],
  );
  if (row) return validate(db, row, attemptId, "executor_returned");
}

export function continuationEvidence(checkpoint: ExecutionCheckpoint) {
  const {
    binding,
    completed_actions,
    artifact_ids,
    workspace_fingerprint,
    workspace_unavailable,
    workspace_artifact_id,
    verification,
  } = checkpoint;
  return {
    source_attempt_id: binding.attempt_id,
    completed_actions,
    remaining_actions: ["inspect_preserved_state", "complete_remaining_requirements"],
    artifact_ids,
    workspace_fingerprint,
    workspace_unavailable,
    workspace_artifact_id,
    verification,
  };
}

type ContinuationInput = {
  run: { id: number };
  work_item: unknown;
  upstream: unknown;
  approval: unknown;
  pending: { resume?: { from_attempt_id?: number } } | null;
};

export async function validateContinuation(
  db: Db,
  input: ContinuationInput,
  stepId: number,
  generation: number,
) {
  const resume = input.pending?.resume;
  if (!resume?.from_attempt_id) return;
  const previous = await one<{ input: ContinuationInput }>(
    db,
    `SELECT input FROM workflow_step_attempts WHERE id=$1 AND run_id=$2 AND step_id=$3 AND generation=$4
      AND invalidated_at IS NULL AND status IN ('WAITING_INPUT','WAITING_APPROVAL','FAILED','STALE')`,
    [resume.from_attempt_id, input.run.id, stepId, generation],
  );
  const dependencies = (i: ContinuationInput) => [i.run, i.work_item, i.upstream, i.approval];
  if (
    !previous ||
    checkpointHash(dependencies(previous.input)) !== checkpointHash(dependencies(input))
  ) {
    const { resume: _resume, ...pending } = input.pending ?? {};
    input.pending = pending;
  }
}

/** Preserve the legacy wait payload. Progress, submissions and execution bookkeeping don't authorize resume. */
export async function latestWaitCheckpoint(db: Db, attemptId: number | null) {
  if (attemptId == null) return;
  const row = await one<CheckpointRow & { reason: string }>(
    db,
    `SELECT reason,data,execution,execution_digest,workspace_artifact_id FROM workflow_checkpoints
      WHERE attempt_id=$1 AND reason IN ('waiting_input','waiting_approval') ORDER BY id DESC LIMIT 1`,
    [attemptId],
  );
  if (row?.execution == null) return row;
  const execution = await validate(db, row, attemptId, row.reason);
  if (!execution) throw new HttpError(409, "Execution checkpoint failed integrity validation");
  if (row.data.recovery && !row.data.execution)
    row.data = { ...row.data, execution: continuationEvidence(execution) };
  return row;
}
