import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { audit } from "../authz/access.ts";
import { HttpError } from "../http/error.ts";
import { assessRisk } from "../workflow/autonomy.ts";

/**
 * Autonomy for actions the chat proposes (from Telegram or the web): whether the platform may confirm an operation or a
 * delegation on the owner's behalf instead of waiting for a tap. It decides nothing inside a run — approval gates,
 * verification and security gates keep their own policies (workflow/autonomy.ts) and still apply to every run started
 * here. Absent global policy, absent owner opt-in, a pause anywhere, untrusted argument values, a HIGH or unknown risk,
 * a protected action or an exhausted limit all mean: ask the owner. Every decision is recorded and audited.
 */

export const CHAT_AUTONOMY_MODES = ["MANUAL", "SEMI", "AUTONOMOUS"] as const;
export type ChatAutonomyMode = (typeof CHAT_AUTONOMY_MODES)[number];
export type ActionRisk = "LOW" | "MEDIUM" | "HIGH";

/** The only actions a policy can allowlist, with their inherent risk. Anything else is protected. */
export const AUTONOMOUS_ACTIONS: Record<string, "LOW" | "MEDIUM"> = {
  "runs.pause": "LOW",
  "runs.resume": "LOW",
  "runs.retry_step": "MEDIUM",
  "runs.start": "MEDIUM",
  "runs.cancel": "MEDIUM",
  "work.delegate": "MEDIUM",
};
/** Actions that start or continue agent work: concurrency and spend limits apply. */
const CONSUMING = new Set(["runs.start", "runs.resume", "runs.retry_step", "work.delegate"]);
/**
 * Workflows that ship, merge, migrate, deploy or touch secrets are never started autonomously by a chat policy, whatever
 * the allowlist says: they need their own explicitly authorized path (a human in the run).
 */
const PROTECTED_WORKFLOW =
  /deploy|release|merge|migrat|secret|credential|rotate|prod(uction)?[-_]?(write|data|db)/i;

export interface ChatAutonomyPolicy {
  id: number;
  scope_kind: "global" | "owner" | "repository" | "workflow";
  scope_ref: string;
  mode: ChatAutonomyMode;
  paused: boolean;
  actions: string[];
  workflows: string[] | null;
  max_risk: "LOW" | "MEDIUM";
  max_cost_usd_per_day: string | number | null;
  max_tokens_per_day: string | number | null;
  max_concurrent_runs: number;
  run_budget_usd: string | number | null;
  retry_budget: number;
  timeout_minutes: number | null;
  revision: number;
  updated_by: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface EffectiveChatAutonomy {
  mode: ChatAutonomyMode;
  paused: boolean;
  actions: string[];
  /** null: no level named workflows, so no workflow can be started autonomously. */
  workflows: string[] | null;
  max_risk: "LOW" | "MEDIUM";
  max_cost_usd_per_day: number | null;
  max_tokens_per_day: number | null;
  max_concurrent_runs: number;
  run_budget_usd: number | null;
  retry_budget: number;
  timeout_minutes: number | null;
  sources: Array<{ id: number; scope: string; mode: string; revision: number }>;
  reasons: string[];
}

const RANK: Record<ChatAutonomyMode, number> = { MANUAL: 0, SEMI: 1, AUTONOMOUS: 2 };
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const minNullable = (vals: Array<number | null>) => {
  const xs = vals.filter((v): v is number => v != null && Number.isFinite(v));
  return xs.length ? Math.min(...xs) : null;
};

const MANUAL: Omit<EffectiveChatAutonomy, "reasons" | "sources"> = {
  mode: "MANUAL",
  paused: false,
  actions: [],
  workflows: null,
  max_risk: "LOW",
  max_cost_usd_per_day: null,
  max_tokens_per_day: null,
  max_concurrent_runs: 0,
  run_budget_usd: null,
  retry_budget: 0,
  timeout_minutes: null,
};

/**
 * Most-restrictive resolution. Required: an active global policy (the administrator's ceiling) AND the owner's own
 * policy (explicit opt-in). Repository and workflow policies, where they exist, can only narrow. A pause at any level
 * is an emergency stop: MANUAL.
 */
export function resolveChatAutonomy(
  policies: ChatAutonomyPolicy[],
  ctx: { ownerId: number; repositories?: string[]; workflow?: string | null },
): EffectiveChatAutonomy {
  const active = policies.filter((p) => !p.revoked_at);
  const global = active.find((p) => p.scope_kind === "global");
  const owner = active.find((p) => p.scope_kind === "owner" && p.scope_ref === String(ctx.ownerId));
  if (!global) return { ...MANUAL, sources: [], reasons: ["no global chat autonomy policy"] };
  if (!owner)
    return {
      ...MANUAL,
      sources: [],
      reasons: ["the owner has not opted in (no owner policy; /mode in Telegram)"],
    };
  const applicable = [
    global,
    owner,
    ...active.filter(
      (p) => p.scope_kind === "repository" && (ctx.repositories ?? []).includes(p.scope_ref),
    ),
    ...active.filter(
      (p) => p.scope_kind === "workflow" && !!ctx.workflow && p.scope_ref === ctx.workflow,
    ),
  ];
  const sources = applicable.map((p) => ({
    id: Number(p.id),
    scope: p.scope_kind === "global" ? "global" : `${p.scope_kind}:${p.scope_ref}`,
    mode: p.mode,
    revision: p.revision,
  }));
  const reasons: string[] = [];
  const paused = applicable.filter((p) => p.paused);
  if (paused.length)
    return {
      ...MANUAL,
      paused: true,
      sources,
      reasons: paused.map((p) => `emergency stop: ${p.scope_kind} policy is paused`),
    };
  let mode: ChatAutonomyMode = "AUTONOMOUS";
  for (const p of applicable)
    if (RANK[p.mode] < RANK[mode]) {
      mode = p.mode;
      reasons.push(`${p.scope_kind} policy allows at most ${p.mode}`);
    }
  const named = applicable.filter((p) => p.workflows != null);
  return {
    mode,
    paused: false,
    actions: applicable.reduce<string[]>(
      (acc, p) => acc.filter((a) => p.actions.includes(a)),
      Object.keys(AUTONOMOUS_ACTIONS),
    ),
    workflows: named.length
      ? named.reduce<string[]>(
          (acc, p) => acc.filter((w) => p.workflows!.includes(w)),
          [...named[0].workflows!],
        )
      : null,
    max_risk: applicable.every((p) => p.max_risk === "MEDIUM") ? "MEDIUM" : "LOW",
    max_cost_usd_per_day: minNullable(applicable.map((p) => num(p.max_cost_usd_per_day))),
    max_tokens_per_day: minNullable(applicable.map((p) => num(p.max_tokens_per_day))),
    max_concurrent_runs: Math.min(...applicable.map((p) => p.max_concurrent_runs)),
    run_budget_usd: minNullable(applicable.map((p) => num(p.run_budget_usd))),
    retry_budget: Math.min(...applicable.map((p) => p.retry_budget)),
    timeout_minutes: minNullable(applicable.map((p) => num(p.timeout_minutes))),
    sources,
    reasons,
  };
}

/** Inherent action risk, raised (never lowered) by the subject text, the workflow and the run's effects. */
export function actionRisk(input: { action: string; workflow?: string | null; texts?: string[] }): {
  risk: ActionRisk;
  reasons: string[];
} {
  const base = AUTONOMOUS_ACTIONS[input.action];
  if (!base) return { risk: "HIGH", reasons: [`${input.action} is a protected action`] };
  if (input.workflow && PROTECTED_WORKFLOW.test(input.workflow))
    return { risk: "HIGH", reasons: [`workflow ${input.workflow} is protected`] };
  const texts = (input.texts ?? []).filter((t) => t && t.trim());
  if (texts.length) {
    const r = assessRisk({ texts });
    if (r.level === "HIGH" || r.effects.length)
      return {
        risk: "HIGH",
        reasons: [...r.reasons, ...r.effects.map((e) => `effect: ${e}`)].slice(0, 6),
      };
  }
  return { risk: base, reasons: [] };
}

export async function loadChatAutonomyPolicies(db: Db = pool) {
  return q<ChatAutonomyPolicy>(
    db,
    "SELECT * FROM chat_autonomy_policies WHERE revoked_at IS NULL ORDER BY id",
  );
}

async function usage(ownerId: number, db: Db) {
  const row = await one<{ cost: string | null; tokens: string | null; active: number }>(
    db,
    `SELECT
       (SELECT COALESCE(sum(reported_cost_usd), 0) FROM execution_attempt_telemetry
         WHERE owner_id = $1 AND start_time > now() - interval '1 day') +
       (SELECT COALESCE(sum((metrics->>'cost_usd')::numeric), 0) FROM chat_turns
         WHERE owner_id = $1 AND created_at > now() - interval '1 day' AND metrics ? 'cost_usd') AS cost,
       (SELECT COALESCE(sum(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) FROM execution_attempt_telemetry
         WHERE owner_id = $1 AND start_time > now() - interval '1 day') AS tokens,
       (SELECT count(*)::int FROM workflow_runs WHERE owner_id = $1 AND status IN ('RUNNING', 'WAITING')) AS active`,
    [ownerId],
  );
  return {
    cost: Number(row?.cost ?? 0),
    tokens: Number(row?.tokens ?? 0),
    active: Number(row?.active ?? 0),
  };
}

export interface AutonomyRequest {
  ownerId: number;
  action: string;
  repositories?: string[];
  workflow?: string | null;
  texts?: string[];
  runId?: number | null;
  /** The target run is already counted among the owner's active runs. */
  runActive?: boolean;
  conversationId?: number | null;
  operationId?: number | null;
}
export interface AutonomyVerdict {
  allowed: boolean;
  decisionId: number;
  mode: ChatAutonomyMode;
  risk: ActionRisk;
  reasons: string[];
  policy: EffectiveChatAutonomy;
}

/** The decision, recorded (allowed or not) with its reasons and policy sources, and audited. */
export async function decideChatAutonomy(
  req: AutonomyRequest,
  db: Db = pool,
): Promise<AutonomyVerdict> {
  const policy = resolveChatAutonomy(await loadChatAutonomyPolicies(db), {
    ownerId: req.ownerId,
    repositories: req.repositories,
    workflow: req.workflow,
  });
  const { risk, reasons: riskReasons } = actionRisk(req);
  const reasons = [...policy.reasons];
  let allowed = policy.mode !== "MANUAL";
  const deny = (why: string) => {
    allowed = false;
    reasons.push(why);
  };
  if (policy.mode === "MANUAL") reasons.push("mode MANUAL: the owner confirms every action");
  if (allowed && !policy.actions.includes(req.action)) deny(`${req.action} is not allowlisted`);
  if (allowed && risk === "HIGH") deny(`risk HIGH: ${riskReasons.join("; ") || "protected"}`);
  if (allowed && policy.mode === "SEMI" && risk !== "LOW")
    deny(`mode SEMI runs LOW-risk actions only (this is ${risk})`);
  if (allowed && risk === "MEDIUM" && policy.max_risk === "LOW") deny("policy max_risk is LOW");
  if (allowed && ["runs.start", "work.delegate"].includes(req.action)) {
    if (!req.workflow) deny("the workflow is unknown");
    else if (!policy.workflows?.includes(req.workflow))
      deny(`workflow ${req.workflow} is not allowlisted`);
  }
  if (allowed && CONSUMING.has(req.action)) {
    const u = await usage(req.ownerId, db);
    const active = u.active - (req.runActive ? 1 : 0);
    if (active >= policy.max_concurrent_runs)
      deny(`concurrent run limit reached (${active}/${policy.max_concurrent_runs})`);
    if (policy.max_cost_usd_per_day != null && u.cost >= policy.max_cost_usd_per_day)
      deny(`daily cost limit reached ($${u.cost.toFixed(2)}/$${policy.max_cost_usd_per_day})`);
    if (policy.max_tokens_per_day != null && u.tokens >= policy.max_tokens_per_day)
      deny(`daily token limit reached (${u.tokens}/${policy.max_tokens_per_day})`);
  }
  if (allowed && req.action === "runs.retry_step" && req.runId) {
    const used = await one<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM chat_autonomy_decisions WHERE owner_id = $1 AND run_id = $2
         AND action = 'runs.retry_step' AND allowed AND created_at > now() - interval '1 day'`,
      [req.ownerId, req.runId],
    );
    if ((used?.n ?? 0) >= policy.retry_budget)
      deny(`retry budget used (${used?.n ?? 0}/${policy.retry_budget} in 24 h)`);
  }
  const row = await one<{ id: number }>(
    db,
    `INSERT INTO chat_autonomy_decisions (owner_id, action, allowed, risk, mode, reasons, sources, conversation_id,
       operation_id, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      req.ownerId,
      req.action,
      allowed,
      risk,
      policy.mode,
      JSON.stringify(reasons.slice(0, 20)),
      JSON.stringify(policy.sources),
      req.conversationId ?? null,
      req.operationId ?? null,
      req.runId ?? null,
    ],
  );
  await audit(
    req.ownerId,
    allowed ? "chat.autonomy.allow" : "chat.autonomy.require_human",
    "chat_autonomy_decision",
    String(row!.id),
    {
      action: req.action,
      risk,
      mode: policy.mode,
      reasons: reasons.slice(0, 10),
      sources: policy.sources,
    },
  );
  return { allowed, decisionId: Number(row!.id), mode: policy.mode, risk, reasons, policy };
}

/**
 * A run started (or resumed/retried) by an allowed decision: remember it for the timeout and give it the policy's
 * per-run budget when it has none (enforced by the existing budget gates).
 */
export async function attachAutonomousRun(verdict: AutonomyVerdict, runId: number, db: Db = pool) {
  await q(
    db,
    `UPDATE chat_autonomy_decisions SET run_id = $2,
       timeout_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END
     WHERE id = $1`,
    [verdict.decisionId, runId, verdict.policy.timeout_minutes],
  );
  if (verdict.policy.run_budget_usd != null)
    await q(db, "UPDATE workflow_runs SET budget_usd = $2 WHERE id = $1 AND budget_usd IS NULL", [
      runId,
      verdict.policy.run_budget_usd,
    ]);
}

/** Runs an allowed decision started that outlived the policy timeout are paused (the owner resumes them). */
export async function enforceAutonomyTimeouts() {
  const due = await q<{ id: number; run_id: number; owner_id: number }>(
    pool,
    `SELECT d.id, d.run_id, d.owner_id FROM chat_autonomy_decisions d JOIN workflow_runs r ON r.id = d.run_id
      WHERE d.timeout_at < now() AND d.timed_out_at IS NULL AND r.status IN ('RUNNING', 'WAITING')
      ORDER BY d.timeout_at LIMIT 20`,
  );
  if (!due.length) return;
  const { pauseRun } = await import("../workflow/engine.ts");
  for (const d of due) {
    const claimed = await one(
      pool,
      "UPDATE chat_autonomy_decisions SET timed_out_at = now() WHERE id = $1 AND timed_out_at IS NULL RETURNING id",
      [d.id],
    );
    if (!claimed) continue;
    try {
      await pauseRun(d.run_id);
      await audit(d.owner_id, "chat.autonomy.timeout", "workflow_run", String(d.run_id), {
        decision_id: d.id,
      });
    } catch (e) {
      await audit(d.owner_id, "chat.autonomy.timeout_failed", "workflow_run", String(d.run_id), {
        decision_id: d.id,
        error: (e as Error).message.slice(0, 200),
      });
    }
  }
}

// ---------------------------------------------------------------- policy administration

export interface ChatPolicyInput {
  scope_kind: ChatAutonomyPolicy["scope_kind"];
  scope_ref?: string;
  mode: ChatAutonomyMode;
  paused?: boolean;
  actions?: string[];
  workflows?: string[] | null;
  max_risk?: "LOW" | "MEDIUM";
  max_cost_usd_per_day?: number | null;
  max_tokens_per_day?: number | null;
  max_concurrent_runs?: number;
  run_budget_usd?: number | null;
  retry_budget?: number;
  timeout_minutes?: number | null;
}

function validatePolicy(input: ChatPolicyInput) {
  if (!["global", "owner", "repository", "workflow"].includes(input.scope_kind))
    throw new HttpError(400, "scope_kind must be global, owner, repository or workflow");
  if (!CHAT_AUTONOMY_MODES.includes(input.mode))
    throw new HttpError(400, `mode must be one of ${CHAT_AUTONOMY_MODES.join(", ")}`);
  const ref = input.scope_kind === "global" ? "" : String(input.scope_ref ?? "").trim();
  if (input.scope_kind !== "global" && !/^[A-Za-z0-9._/-]{1,200}$/.test(ref))
    throw new HttpError(400, "scope_ref is required");
  const actions = input.actions ?? [];
  const unknown = actions.filter((a) => !(a in AUTONOMOUS_ACTIONS));
  if (unknown.length)
    throw new HttpError(
      400,
      `actions ${unknown.join(", ")} cannot run autonomously (protected); allowed: ${Object.keys(AUTONOMOUS_ACTIONS).join(", ")}`,
    );
  if (input.workflows && input.workflows.some((w) => !/^[a-z0-9_-]{1,80}$/.test(w)))
    throw new HttpError(400, "invalid workflow key");
  const nonNeg = (v: unknown, name: string) => {
    if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0))
      throw new HttpError(400, `${name} must be a non-negative number`);
  };
  for (const k of [
    "max_cost_usd_per_day",
    "max_tokens_per_day",
    "max_concurrent_runs",
    "retry_budget",
  ] as const)
    nonNeg(input[k], k);
  if (input.run_budget_usd != null && !(Number(input.run_budget_usd) > 0))
    throw new HttpError(400, "run_budget_usd must be positive");
  if (input.timeout_minutes != null && !(Number(input.timeout_minutes) > 0))
    throw new HttpError(400, "timeout_minutes must be positive");
  return { ref, actions };
}

/** Replaces the active policy of a scope (revision + 1). Owners may manage only their own owner scope. */
export async function saveChatPolicy(
  input: ChatPolicyInput,
  by: { id: number; username: string; role: string },
) {
  const { ref, actions } = validatePolicy(input);
  if (by.role !== "admin" && !(input.scope_kind === "owner" && ref === String(by.id)))
    throw new HttpError(403, "only administrators manage global, repository and workflow policies");
  // One transaction, scope row locked: concurrent saves serialize instead of tripping the unique active-scope index.
  const { prev, row } = await withTx(async (db) => {
    await q(db, "SELECT pg_advisory_xact_lock(hashtext($1))", [
      `chat_autonomy:${input.scope_kind}:${ref}`,
    ]);
    const prev = await one<ChatAutonomyPolicy>(
      db,
      "SELECT * FROM chat_autonomy_policies WHERE scope_kind = $1 AND scope_ref = $2 AND revoked_at IS NULL",
      [input.scope_kind, ref],
    );
    if (prev)
      await q(db, "UPDATE chat_autonomy_policies SET revoked_at = now() WHERE id = $1", [prev.id]);
    const row = await one<ChatAutonomyPolicy>(
      db,
      `INSERT INTO chat_autonomy_policies (scope_kind, scope_ref, mode, paused, actions, workflows, max_risk,
       max_cost_usd_per_day, max_tokens_per_day, max_concurrent_runs, run_budget_usd, retry_budget, timeout_minutes,
       revision, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        input.scope_kind,
        ref,
        input.mode,
        input.paused ?? false,
        actions,
        input.workflows ?? null,
        input.max_risk ?? "LOW",
        input.max_cost_usd_per_day ?? null,
        input.max_tokens_per_day ?? null,
        input.max_concurrent_runs ?? 1,
        input.run_budget_usd ?? null,
        input.retry_budget ?? 1,
        input.timeout_minutes ?? null,
        (prev?.revision ?? 0) + 1,
        by.username,
      ],
    );
    return { prev, row };
  });
  await audit(by.id, "chat.autonomy.policy.save", "chat_autonomy_policy", String(row!.id), {
    scope: `${input.scope_kind}:${ref}`,
    mode: input.mode,
    paused: input.paused ?? false,
    actions,
    workflows: input.workflows ?? null,
    previous: prev ? { id: prev.id, mode: prev.mode, revision: prev.revision } : null,
  });
  return row!;
}

export async function revokeChatPolicy(id: number, by: { id: number; role: string }) {
  const row = await one<ChatAutonomyPolicy>(
    pool,
    "SELECT * FROM chat_autonomy_policies WHERE id = $1 AND revoked_at IS NULL",
    [id],
  );
  if (!row) throw new HttpError(404, "not found");
  if (by.role !== "admin" && !(row.scope_kind === "owner" && row.scope_ref === String(by.id)))
    throw new HttpError(403, "forbidden");
  await q(pool, "UPDATE chat_autonomy_policies SET revoked_at = now() WHERE id = $1", [id]);
  await audit(by.id, "chat.autonomy.policy.revoke", "chat_autonomy_policy", String(id), {
    scope: `${row.scope_kind}:${row.scope_ref}`,
  });
  return { ok: true };
}

/** Policies a user may see: all for an administrator, otherwise global (read-only ceiling) and their own. */
export async function listChatPolicies(by: { id: number; role: string }) {
  const rows = await loadChatAutonomyPolicies();
  return by.role === "admin"
    ? rows
    : rows.filter(
        (p) =>
          p.scope_kind === "global" || (p.scope_kind === "owner" && p.scope_ref === String(by.id)),
      );
}

/**
 * The owner's quick switch (Telegram /mode): MANUAL/SEMI/AUTONOMOUS keep the rest of their policy (a first opt-in
 * starts with pause/resume only and one concurrent run), "pause" is the owner's emergency stop.
 */
export async function setOwnerAutonomy(
  user: { id: number; username: string; role: string },
  change: { mode?: ChatAutonomyMode; paused?: boolean },
) {
  const current = await one<ChatAutonomyPolicy>(
    pool,
    "SELECT * FROM chat_autonomy_policies WHERE scope_kind = 'owner' AND scope_ref = $1 AND revoked_at IS NULL",
    [String(user.id)],
  );
  const base: ChatPolicyInput = current
    ? {
        scope_kind: "owner",
        scope_ref: String(user.id),
        mode: current.mode,
        paused: current.paused,
        actions: current.actions,
        workflows: current.workflows,
        max_risk: current.max_risk,
        max_cost_usd_per_day: num(current.max_cost_usd_per_day),
        max_tokens_per_day: num(current.max_tokens_per_day),
        max_concurrent_runs: current.max_concurrent_runs,
        run_budget_usd: num(current.run_budget_usd),
        retry_budget: current.retry_budget,
        timeout_minutes: current.timeout_minutes,
      }
    : {
        scope_kind: "owner",
        scope_ref: String(user.id),
        mode: "MANUAL",
        actions: ["runs.pause", "runs.resume"],
        workflows: null,
        max_concurrent_runs: 1,
        retry_budget: 1,
      };
  return saveChatPolicy(
    {
      ...base,
      ...(change.mode ? { mode: change.mode } : {}),
      ...(change.paused !== undefined ? { paused: change.paused } : {}),
    },
    user,
  );
}

/** What /mode and the settings page show: the owner's own policy and the effective result without a target. */
export async function ownerAutonomySummary(userId: number) {
  const policies = await loadChatAutonomyPolicies();
  return {
    own: policies.find((p) => p.scope_kind === "owner" && p.scope_ref === String(userId)) ?? null,
    global: policies.find((p) => p.scope_kind === "global") ?? null,
    effective: resolveChatAutonomy(policies, { ownerId: userId }),
  };
}
