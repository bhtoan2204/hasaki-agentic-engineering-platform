/**
 * Workflow-to-workflow delegation. A step that is ALLOWED to (step config `child_workflows`) may ask, in its submitted
 * output, for other workflows to run (`child_workflows: [{ workflow, title, request, reason, mode?, repositories? }]`).
 * The platform does the rest deterministically; no agent can start a run itself.
 *
 *   propose   the child run is created PENDING — a human starts it (existing "start" action) or not;
 *   blocking  the parent step waits (WAITING_INPUT, no question) and completes with the children's results; a child that
 *             does not complete fails the step (re-execute or skip it, as any failed step);
 *   parallel  the parent continues; the parent RUN does not complete before the child is finished;
 *   detached  nobody waits; the link is kept for visibility.
 *
 * Children are ordinary runs: same owner, repositories within the parent's allowed set, their own approval gates,
 * independent review and run budget (`budget_usd` set before they start). Rows in workflow_delegations are the durable
 * state; `dispatchDelegations` (scheduler reconcile tick, and right after a commit) spawns, tracks, resumes and cascades
 * cancellation. Every step is idempotent: a child is found again by inputs.delegation.id, so a crash between creating it
 * and recording it never creates a second one.
 */
import { createHash } from "node:crypto";
import { pool, q, one, json, type Db } from "../db/pool.ts";
import { definitions } from "./definitions.ts";
import { runEvents } from "./events.ts";
import { setStepStatus, type AfterCommit } from "./mutations.ts";
import { background } from "./background.ts";
import type { AttemptRow, RunRow, StepRow } from "./types.ts";

export const MODES = ["propose", "blocking", "parallel", "detached"] as const;
export type DelegationMode = (typeof MODES)[number];
/** Hard bounds (a step config can only lower them). */
export const LIMITS = {
  depth: 2,
  childrenPerStep: 5,
  activePerTree: 3,
  spawnAttempts: 3,
  defaultBudgetUsd: 5,
} as const;

/** Step config that enables delegation. Absent → a `child_workflows` request in the output is ignored (and logged). */
export interface ChildWorkflowsConfig {
  /** Workflows this step may delegate to (definition keys). Required. */
  workflows: string[];
  modes?: DelegationMode[];
  default_mode?: DelegationMode;
  max_children?: number;
  /** Budget of each child run (USD); default: the platform run budget, else 5. */
  budget_usd?: number;
}

interface Request {
  workflow: string;
  title: string;
  request: string;
  reason: string;
  mode: DelegationMode;
  repositories: string[];
}
export type DelegationRow = {
  id: number;
  parent_run_id: number;
  parent_step_id: number;
  root_run_id: number;
  depth: number;
  workflow_key: string;
  mode: DelegationMode;
  request: Request;
  status: string;
  child_run_id: number | null;
  spawn_attempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
};

const text = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const dedupeKey = (r: Pick<Request, "workflow" | "request" | "repositories">) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        r.workflow,
        r.request.toLowerCase().replace(/\s+/g, " ").trim(),
        [...r.repositories].sort(),
      ]),
    )
    .digest("hex");

/** Where this run sits in a delegation tree: its root, its depth and the workflow keys above it (cycle check). */
async function lineage(c: Db, run: RunRow) {
  const chain: string[] = [run.definition_key];
  let root = run.id;
  let depth = 0;
  let cur: number | null = run.id;
  for (let i = 0; i <= LIMITS.depth + 1 && cur != null; i++) {
    const up: { parent_run_id: number; root_run_id: number; definition_key: string } | null | undefined =
      await one(
        c,
        `SELECT d.parent_run_id, d.root_run_id, r.definition_key FROM workflow_delegations d
           JOIN workflow_runs r ON r.id = d.parent_run_id WHERE d.child_run_id = $1 LIMIT 1`,
        [cur],
      );
    if (!up) break;
    depth++;
    root = Number(up.root_run_id);
    chain.push(up.definition_key);
    cur = Number(up.parent_run_id);
  }
  return { root, depth, chain };
}

/**
 * Called inside the transaction that completes an agent step. Validates the step's `child_workflows` requests and records
 * them. Returns the rows the step must wait for (blocking), or null when the step completes now, plus the output
 * annotated with what was accepted and what was refused (and why).
 */
export async function planChildWorkflows(
  c: Db,
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  output: unknown,
): Promise<{ output: unknown; waitFor: number[] | null }> {
  const asked = (output as { child_workflows?: unknown } | null)?.child_workflows;
  if (!Array.isArray(asked) || !asked.length) return { output, waitFor: null };
  const cfg = step.config?.child_workflows as ChildWorkflowsConfig | undefined;
  const refused: Array<{ workflow: string; reason: string }> = [];
  const accepted: Array<{ id: number; workflow: string; mode: DelegationMode; reused: boolean }> =
    [];
  const note = (content: string, data?: unknown) =>
    runEvents.add(c, run.id, "system", content, step.id, attempt.id, data ?? null);
  if (!cfg || !Array.isArray(cfg.workflows) || !cfg.workflows.length) {
    await note("child_workflows ignored: this step is not configured to delegate");
    return {
      output: { ...(output as object), child_workflows: { accepted: [], refused: [{ workflow: "*", reason: "delegation not enabled for this step" }] } },
      waitFor: null,
    };
  }
  const modes = (cfg.modes?.length ? cfg.modes : MODES).filter((m) => MODES.includes(m));
  const maxChildren = Math.min(LIMITS.childrenPerStep, Math.max(1, cfg.max_children ?? 3));
  const { root, depth, chain } = await lineage(c, run);
  const parentMode = (run.graph as { execution_mode?: string } | null)?.execution_mode;
  const waitFor: number[] = [];
  for (const raw of asked.slice(0, 20)) {
    const r = raw as Record<string, unknown>;
    const req: Request = {
      workflow: text(r.workflow, 100),
      title: text(r.title, 140),
      request: text(r.request, 8000),
      reason: text(r.reason, 1000),
      mode: (MODES as readonly string[]).includes(String(r.mode))
        ? (r.mode as DelegationMode)
        : (cfg.default_mode ?? "blocking"),
      repositories: Array.isArray(r.repositories) ? [...new Set(r.repositories.map(String))].slice(0, 5) : [],
    };
    const refuse = (reason: string) => refused.push({ workflow: req.workflow || "?", reason });
    if (accepted.length >= maxChildren) {
      refuse(`at most ${maxChildren} child workflow(s) per step`);
      continue;
    }
    if (!req.workflow || !req.request || !req.title) {
      refuse("workflow, title and request are required");
      continue;
    }
    // Delegation is the exception: the agent must say why the work cannot be done in this workflow.
    if (req.reason.length < 20) {
      refuse("a reason (why this cannot be done in the current workflow) is required");
      continue;
    }
    if (!cfg.workflows.includes(req.workflow)) {
      refuse(`workflow "${req.workflow}" is not allowed for this step (allowed: ${cfg.workflows.join(", ")})`);
      continue;
    }
    if (!modes.includes(req.mode)) {
      refuse(`mode ${req.mode} is not allowed for this step`);
      continue;
    }
    if (depth + 1 > LIMITS.depth) {
      refuse(`delegation depth limit ${LIMITS.depth} reached`);
      continue;
    }
    if (chain.includes(req.workflow)) {
      refuse(`cycle: ${req.workflow} is already in this delegation chain (${chain.join(" ← ")})`);
      continue;
    }
    const spec = (await definitions.version(req.workflow, undefined, c, run.owner_id))?.spec;
    if (!spec) {
      refuse(`workflow "${req.workflow}" has no published version`);
      continue;
    }
    // A read-only workflow may only PROPOSE a workflow that changes code; self-development is never started by delegation.
    const childMode = spec.execution_mode ?? "standard";
    if (req.mode !== "propose" && childMode === "self_development") {
      refuse("self-development can only be proposed");
      continue;
    }
    if (req.mode !== "propose" && parentMode === "read_only" && childMode !== "read_only") {
      refuse(`a read-only workflow can only propose ${req.workflow} (it may change code)`);
      continue;
    }
    // Repositories never widen: the child sees at most what the parent was allowed.
    const allowed = run.allowed_repositories ?? [];
    if (!req.repositories.length) req.repositories = (run.selected_repositories ?? []).filter((x) => allowed.includes(x));
    const outside = req.repositories.filter((x) => !allowed.includes(x));
    if (outside.length) {
      refuse(`repositories outside this run's scope: ${outside.join(", ")}`);
      continue;
    }
    const key = dedupeKey(req);
    const inserted = await one<{ id: number }>(
      c,
      `INSERT INTO workflow_delegations (parent_run_id,parent_step_id,parent_attempt_id,root_run_id,depth,dedupe_key,workflow_key,mode,request,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued') ON CONFLICT (root_run_id, dedupe_key) DO NOTHING RETURNING id`,
      [run.id, step.id, attempt.id, root, depth + 1, key, req.workflow, req.mode, json(req)],
    );
    // The same work already requested anywhere in this tree (a re-executed step, a sibling): reuse it, never duplicate.
    const id = inserted
      ? Number(inserted.id)
      : Number((await one<{ id: number }>(c, "SELECT id FROM workflow_delegations WHERE root_run_id=$1 AND dedupe_key=$2", [root, key]))!.id);
    accepted.push({ id, workflow: req.workflow, mode: req.mode, reused: !inserted });
    if (req.mode === "blocking") waitFor.push(id);
  }
  await note(
    `child workflows: ${accepted.length} accepted${refused.length ? `, ${refused.length} refused` : ""}${waitFor.length ? `; waiting for ${waitFor.length}` : ""}`,
    { accepted, refused },
  );
  return {
    output: { ...(output as object), child_workflows: { accepted, refused } },
    waitFor: waitFor.length ? waitFor : null,
  };
}

/** Put the completing step on hold until its blocking children finish (same transaction as the completion). */
export async function holdForChildren(c: Db, step: StepRow, ids: number[], afterCommit: AfterCommit) {
  await setStepStatus(
    c,
    step,
    "WAITING_INPUT",
    { pending_input: { ...(step.pending_input ?? {}), child_workflows: ids } },
    `waiting for ${ids.length} child workflow(s)`,
  );
  afterCommit(() => kickDelegations());
}

// ---------------------------------------------------------------- dispatch hook

/** Set by workflow/delegationDispatch.ts (which uses the engine; the engine only imports this module). */
let dispatcher: (() => Promise<unknown>) | null = null;
export function setDelegationDispatcher(fn: () => Promise<unknown>) {
  dispatcher = fn;
}
/** Run the dispatcher right after a commit that created delegation work (tracked like other post-commit work). */
export function kickDelegations() {
  const fn = dispatcher;
  if (fn) background("delegation dispatch", () => fn());
}

/** Children and parent of a run, for run detail, chat and Telegram (one query each, bounded). */
export async function delegationsOf(runId: number, db: Db = pool) {
  // One query: each child with its steps in order (the parent page draws them as a mini DAG) and how many children it
  // has itself.
  const children = await q(
    db,
    `SELECT d.id, d.workflow_key AS workflow, d.mode, d.status AS delegation_status, d.child_run_id,
            r.status AS run_status, r.title, d.request->>'title' AS requested_title, d.request->>'reason' AS reason, d.error,
            d.result, s.key AS step_key, d.depth, d.created_at, r.updated_at AS run_updated_at,
            COALESCE((SELECT json_agg(json_build_object('key', cs.key, 'name', cs.name, 'type', cs.type, 'status', cs.status) ORDER BY cs.position)
                        FROM workflow_steps cs WHERE cs.run_id = d.child_run_id), '[]') AS steps,
            (SELECT count(*)::int FROM workflow_delegations g WHERE g.parent_run_id = d.child_run_id) AS grandchildren
       FROM workflow_delegations d JOIN workflow_steps s ON s.id = d.parent_step_id
       LEFT JOIN workflow_runs r ON r.id = d.child_run_id WHERE d.parent_run_id=$1 ORDER BY d.id LIMIT 50`,
    [runId],
  );
  const parent = await one(
    db,
    `SELECT d.parent_run_id AS run_id, r.title, r.status, d.mode, d.depth FROM workflow_delegations d
       JOIN workflow_runs r ON r.id = d.parent_run_id WHERE d.child_run_id=$1 LIMIT 1`,
    [runId],
  );
  return { parent, children };
}
