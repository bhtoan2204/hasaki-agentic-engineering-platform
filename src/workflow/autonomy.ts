import { pool, q, type Db } from "../db/pool.ts";
import { detectRisk } from "../agent/evidence.ts";
import { changedFiles, diffLineCount } from "../agent/scopeGuard.ts";
import { STRICT_DOMAIN } from "../agent/rootCause.ts";
import { checkpointHash } from "./checkpoints.ts";
import { recordDecision } from "./decisions.ts";
import { EngineError } from "./mutations.ts";
import { ancestors } from "./graph.ts";
import {
  AUTONOMY_MODES,
  type AutonomyMode,
  type EffectiveAutonomy,
  type RunRow,
  type StepRow,
} from "./types.ts";

/**
 * Risk-aware autonomy. Autonomy (who may decide a gate) is separate from the execution profile (how a run executes).
 * The platform decides deterministically from recorded evidence; task text, run inputs and model output never
 * authorize anything. Absent policy = MANUAL, the legacy behaviour; a new policy starts in shadow mode.
 */

export const AUTONOMY_POLICY_VERSION = "2026-11-19.1";
export { AUTONOMY_MODES, type AutonomyMode, type EffectiveAutonomy };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- step outputs and approval requests are untyped JSON
type Json = Record<string, any>;
/** Gates a policy may allowlist. Every other gate (optional steps, reports, releases, DEEP) always waits for a human. */
export const AUTO_GATES = ["repository_selection", "plan", "diff"] as const;
export type GateKind = (typeof AUTO_GATES)[number] | "step_gate" | "report" | "other";
export const DECISION_RESULTS = [
  "ALLOW",
  "DENY",
  "REQUIRE_HUMAN",
  "COLLECT_EVIDENCE",
  "REPLAN",
] as const;
export type DecisionResult = (typeof DECISION_RESULTS)[number];
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export interface AutonomyPolicy {
  id: number;
  scope_kind: "global" | "owner" | "repository";
  scope_ref: string;
  mode: AutonomyMode;
  shadow: boolean;
  gates: string[];
  max_diff_lines: number;
  revision: number;
  revoked_at: string | Date | null;
}

const rank = (m: AutonomyMode) => AUTONOMY_MODES.indexOf(m);
const minMode = (a: AutonomyMode, b: AutonomyMode) => (rank(a) <= rank(b) ? a : b);
const isMode = (v: unknown): v is AutonomyMode =>
  typeof v === "string" && (AUTONOMY_MODES as readonly string[]).includes(v);

/**
 * Most-restrictive resolution: the effective mode is the minimum of the request and every applicable active policy
 * (global, the run owner, each target repository; a repository without its own row follows global). Shadow if any
 * applicable policy is in shadow; gates are the intersection. The request can only lower the result.
 */
export function resolveAutonomy(
  requested: unknown,
  policies: AutonomyPolicy[],
  ctx: { ownerId: number | null; repositories: string[] },
): EffectiveAutonomy {
  const active = policies.filter((p) => !p.revoked_at);
  const global = active.find((p) => p.scope_kind === "global");
  const downgraded: string[] = [];
  const req: AutonomyMode =
    requested == null || requested === ""
      ? (global?.mode ?? "MANUAL")
      : isMode(requested)
        ? requested
        : "MANUAL";
  if (requested != null && requested !== "" && !isMode(requested))
    downgraded.push(`unknown autonomy request "${String(requested).slice(0, 40)}": MANUAL`);
  if (!global)
    return {
      version: AUTONOMY_POLICY_VERSION,
      requested: req,
      mode: "MANUAL",
      shadow: true,
      gates: [],
      max_diff_lines: 0,
      sources: [],
      downgraded: [...downgraded, ...(req !== "MANUAL" ? ["no active autonomy policy"] : [])],
    };
  const applicable = [
    global,
    ...active.filter(
      (p) => p.scope_kind === "owner" && ctx.ownerId != null && p.scope_ref === String(ctx.ownerId),
    ),
    ...active.filter(
      (p) => p.scope_kind === "repository" && ctx.repositories.includes(p.scope_ref),
    ),
  ];
  let mode = req;
  for (const p of applicable)
    if (rank(p.mode) < rank(mode)) {
      downgraded.push(
        `${p.scope_kind}${p.scope_ref ? ` ${p.scope_ref}` : ""} policy allows at most ${p.mode}`,
      );
      mode = p.mode;
    }
  return {
    version: AUTONOMY_POLICY_VERSION,
    requested: req,
    mode,
    shadow: applicable.some((p) => p.shadow),
    gates: applicable.reduce<string[]>(
      (acc, p) => acc.filter((g) => p.gates.includes(g)),
      [...AUTO_GATES],
    ),
    max_diff_lines: Math.min(...applicable.map((p) => p.max_diff_lines)),
    sources: applicable.map((p) => ({
      id: p.id,
      scope: p.scope_kind === "global" ? "global" : `${p.scope_kind}:${p.scope_ref}`,
      mode: p.mode,
      revision: p.revision,
    })),
    downgraded,
  };
}

/** Never more than the frozen run policy, never more than the live one: revocation wins, a snapshot cannot outlive it. */
export function narrow(frozen: EffectiveAutonomy, live: EffectiveAutonomy): EffectiveAutonomy {
  const mode = minMode(frozen.mode, live.mode);
  return {
    ...live,
    requested: frozen.requested,
    mode,
    shadow: frozen.shadow || live.shadow,
    gates: live.gates.filter((g) => frozen.gates.includes(g)),
    max_diff_lines: Math.min(frozen.max_diff_lines, live.max_diff_lines),
    downgraded: [
      ...new Set([
        ...frozen.downgraded,
        ...live.downgraded,
        ...(rank(live.mode) < rank(frozen.mode)
          ? [`policy narrowed to ${live.mode} after the run started`]
          : []),
      ]),
    ],
    paused: frozen.paused,
  };
}

// ---------------------------------------------------------------- risk

// Order/shipment state transitions are business-critical even when no payment term appears.
const STATE_TRANSITION =
  /\b(order|shipment|shipping|delivery|fulfil\w*)\b[^\n]{0,60}\b(status|state|transition)\b|trạng thái (đơn|vận đơn|giao hàng)/i;
const RISKY_PATH =
  /(^|\/)(migrations?|db\/migrate|auth\w*|security|payments?|refunds?|settlements?|inventory|wallets?)(\/|$)|\.sql$/i;
const EFFECTS: Array<[RegExp, string]> = [
  [/(^|\/)(migrations?|db\/migrate)\/|\.sql$/i, "migration"],
  [
    /(^|\/)(k8s|helm|terraform|deploy\w*|\.github\/workflows)\/|(^|\/)(Jenkinsfile|bitbucket-pipelines\.yml|Dockerfile)$/i,
    "deployment_config",
  ],
];
const EFFECT_TEXT: Array<[RegExp, string]> = [
  [/\b(drop table|truncate|delete from|xoá dữ liệu|xóa dữ liệu)\b/i, "destructive_change"],
  [/\b(prod(uction)? (data|database|write|db)|dữ liệu (thật|production))\b/i, "production_write"],
];

/**
 * Business risk from the task, plan and changed paths. HIGH wins over every other signal (no size, name or confidence
 * lowers it); a missing task text or a low-confidence classification is UNKNOWN, never LOW.
 */
export function assessRisk(input: {
  texts: string[];
  paths?: string[];
  complexityClass?: string | null;
  classificationConfidence?: string | null;
  declared?: string | null;
}): { level: RiskLevel; reasons: string[]; effects: string[] } {
  const texts = input.texts.filter((t) => t && t.trim());
  const paths = input.paths ?? [];
  const reasons: string[] = [];
  const effects = new Set<string>();
  for (const p of paths) for (const [re, e] of EFFECTS) if (re.test(p)) effects.add(e);
  for (const t of texts) for (const [re, e] of EFFECT_TEXT) if (re.test(t)) effects.add(e);
  if (input.complexityClass === "HIGH_RISK") reasons.push("classified HIGH_RISK");
  if (String(input.declared ?? "").toUpperCase() === "HIGH") reasons.push("risk declared HIGH");
  if (texts.some((t) => STRICT_DOMAIN.test(t)))
    reasons.push("payment / inventory / security / data-integrity subject");
  if (texts.some((t) => STATE_TRANSITION.test(t)))
    reasons.push("order or shipment state transition");
  const risky = paths.filter((p) => RISKY_PATH.test(p));
  if (risky.length) reasons.push(`changes risky paths: ${risky.slice(0, 3).join(", ")}`);
  const detected = detectRisk([...texts, ...paths]);
  if (detected.risk === "HIGH") reasons.push(...detected.reasons);
  if (reasons.length) return { level: "HIGH", reasons, effects: [...effects] };
  if (!texts.length)
    return { level: "UNKNOWN", reasons: ["no task description to assess"], effects: [...effects] };
  if (input.classificationConfidence === "low")
    return {
      level: "UNKNOWN",
      reasons: ["low-confidence task classification"],
      effects: [...effects],
    };
  if (detected.risk === "MEDIUM" || String(input.declared ?? "").toUpperCase() === "MEDIUM")
    return { level: "MEDIUM", reasons: detected.reasons, effects: [...effects] };
  return { level: "LOW", reasons: [], effects: [...effects] };
}

// ---------------------------------------------------------------- decision

export interface GateEvidence {
  gate: GateKind;
  profile: string;
  targets: string[];
  allowed: string[];
  ambiguous: boolean;
  rediscovered: boolean;
  risk: { level: RiskLevel; reasons: string[]; effects: string[] };
  requiresRiskAck: boolean;
  /** A human (not the platform) approved the plan or scope this gate builds on. */
  humanApprovedPlan: boolean;
  /** Plan contract fields that are missing (plan gate). */
  planMissing?: string[];
  review?: { verdict: string | null; independent: boolean };
  testsPassed?: boolean | null;
  scopeReapproval?: boolean;
  remediation?: string | null;
  /** Actual diff, read from git at publication; undefined = not checked at this point. */
  diff?: { lines: number; files: string[] } | null;
  /** A recheck before publication already failed for this approval: only a human may continue. */
  requireHuman?: boolean;
}

export interface GateOutcome {
  result: DecisionResult;
  reasons: string[];
  required_evidence: string[];
}

const out = (
  result: DecisionResult,
  reasons: string[],
  required_evidence: string[] = [],
): GateOutcome => ({
  result,
  reasons,
  required_evidence,
});

/** The deterministic gate. Anything not positively established falls to a human; nothing defaults to ALLOW. */
export function decideGate(policy: EffectiveAutonomy, e: GateEvidence): GateOutcome {
  if (policy.mode === "MANUAL") return out("REQUIRE_HUMAN", ["AUTONOMY_OFF"]);
  if (policy.paused) return out("REQUIRE_HUMAN", ["AUTONOMY_PAUSED"]);
  if (e.requireHuman) return out("REQUIRE_HUMAN", ["RECHECK_FAILED"]);
  if (e.profile === "DEEP") return out("REQUIRE_HUMAN", ["DEEP_MANDATORY_APPROVAL"]);
  if (!(AUTO_GATES as readonly string[]).includes(e.gate))
    return out("REQUIRE_HUMAN", ["GATE_NOT_ELIGIBLE"]);
  if (!policy.gates.includes(e.gate)) return out("REQUIRE_HUMAN", ["GATE_NOT_ALLOWLISTED"]);
  if (policy.mode === "SUPERVISED" && !(e.gate === "diff" && e.humanApprovedPlan))
    return out("REQUIRE_HUMAN", ["SUPERVISED_NEEDS_HUMAN_APPROVED_PLAN"]);
  const outside = e.targets.filter((r) => !e.allowed.includes(r));
  if (outside.length) return out("DENY", [`REPOSITORY_OUT_OF_SCOPE: ${outside.join(", ")}`]);
  if (e.rediscovered) return out("REQUIRE_HUMAN", ["SCOPE_REDISCOVERED"]);
  if (e.ambiguous || e.targets.length !== 1)
    return out("REQUIRE_HUMAN", [
      e.targets.length > 1 ? "MULTIPLE_REPOSITORIES" : "AMBIGUOUS_REPOSITORY",
    ]);
  if (e.risk.level === "HIGH") return out("REQUIRE_HUMAN", ["HIGH_RISK", ...e.risk.reasons]);
  if (e.risk.level !== "LOW")
    return out("REQUIRE_HUMAN", [`RISK_${e.risk.level}`, ...e.risk.reasons]);
  if (e.risk.effects.length)
    return out(
      "REQUIRE_HUMAN",
      e.risk.effects.map((x) => `EXTERNAL_EFFECT: ${x}`),
    );
  if (e.requiresRiskAck) return out("REQUIRE_HUMAN", ["RISK_ACKNOWLEDGEMENT_REQUIRED"]);
  if (e.gate === "plan" && e.planMissing?.length)
    return out("COLLECT_EVIDENCE", ["PLAN_CONTRACT_INCOMPLETE"], e.planMissing);
  if (e.gate === "diff") {
    const missing: string[] = [];
    if (!e.review?.verdict) missing.push("independent review verdict");
    if (e.testsPassed !== true) missing.push("passing tests bound to the commit");
    if (e.diff === null) missing.push("actual diff");
    if (missing.length) return out("COLLECT_EVIDENCE", ["DIFF_EVIDENCE_MISSING"], missing);
    if (e.review!.verdict === "FAIL") return out("DENY", ["REVIEW_FAILED"]);
    if (e.review!.verdict !== "PASS") return out("REQUIRE_HUMAN", [`REVIEW_${e.review!.verdict}`]);
    if (!e.review!.independent) return out("REQUIRE_HUMAN", ["REVIEW_NOT_INDEPENDENT"]);
    if (e.scopeReapproval) return out("REQUIRE_HUMAN", ["SCOPE_GROWTH"]);
    if (
      e.remediation &&
      e.remediation !== "ROOT_CAUSE_FIX" &&
      e.remediation !== "OBSERVABILITY_CORRECTION"
    )
      return out("REQUIRE_HUMAN", [`REMEDIATION_${e.remediation}`]);
    if (e.diff && e.diff.lines > policy.max_diff_lines)
      return out("REQUIRE_HUMAN", [
        `DIFF_TOO_LARGE: ${e.diff.lines} > ${policy.max_diff_lines} lines`,
      ]);
  }
  return out("ALLOW", [`${e.gate.toUpperCase()}_WITHIN_POLICY`]);
}

// ---------------------------------------------------------------- gate classification and evidence

const PLAN_FIELDS: Array<[string, string[]]> = [
  ["acceptance criteria", ["acceptance_criteria"]],
  ["affected scope", ["changes", "files", "affected_scope"]],
  ["non-goals", ["non_goals", "out_of_scope"]],
  ["test plan", ["tests", "test_plan", "regression_tests", "required_tests"]],
  ["rollback / side effects", ["rollback", "side_effects"]],
];
const present = (v: unknown) =>
  Array.isArray(v)
    ? v.length > 0
    : typeof v === "string"
      ? v.trim().length > 0
      : v != null && typeof v === "object";

export function planMissing(outputs: unknown[]): string[] {
  const objs = outputs
    .filter((o): o is Json => !!o && typeof o === "object")
    .flatMap((o) => [o, o.fix_assessment].filter((x) => x && typeof x === "object"));
  return PLAN_FIELDS.filter(([, keys]) => !objs.some((o) => keys.some((k) => present(o[k])))).map(
    ([n]) => n,
  );
}

export function gateKind(
  step: Pick<StepRow, "type" | "config" | "key">,
  graph: RunRow["graph"],
): GateKind {
  if (step.type === "git_pull_request") return "diff";
  if (step.type === "task_result_report") return "report";
  if (step.type !== "human_approval") return "step_gate";
  const cfg = step.config ?? {};
  if (cfg.select_repositories) return "repository_selection";
  const shown: string[] = Array.isArray(cfg.show_outputs) ? cfg.show_outputs : [];
  if (!shown.length && !cfg.approve_scope_from) return "other";
  const coding = graph.steps.filter((s) => s.type === "coding_agent").map((s) => s.key);
  const before = ancestors(graph.steps, step.key);
  return coding.some((k) => before.has(k)) ? "diff" : "plan";
}

const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** Evidence for one gate, read only from platform-recorded state (step outputs, run row), never from run inputs or task text. */
export function gateEvidence(
  run: RunRow,
  step: StepRow,
  steps: StepRow[],
  request: Json | null,
  workItem: { title?: string; description?: string } | null,
  diff?: { lines: number; files: string[] } | null,
): GateEvidence {
  const gate = gateKind(step, run.graph);
  const before = ancestors(run.graph.steps, step.key);
  const prior = steps.filter((s) => before.has(s.key) && s.status === "COMPLETED");
  const outputs = prior.map((s) => s.output).filter(Boolean) as Array<Json>;
  const pd = (run.profile_decision ?? {}) as Json;
  const discovery = outputs.find((o) => Array.isArray(o.candidates));
  const shown: string[] = Array.isArray(step.config?.show_outputs) ? step.config.show_outputs : [];
  const shownOutputs = steps.filter((s) => shown.includes(s.key)).map((s) => s.output);
  const scope =
    request?.scope ??
    outputs
      .map((o) => o.approved_scope)
      .filter(Boolean)
      .at(-1) ??
    null;
  const targets =
    gate === "repository_selection"
      ? Array.isArray(request?.recommended) && request.recommended.length
        ? request.recommended.map(String)
        : run.selected_repositories
      : run.selected_repositories;
  const verdictStep = [...prior].reverse().find((s) => typeof s.output?.verdict === "string");
  const risk = assessRisk({
    texts: [
      workItem?.title ?? "",
      workItem?.description ?? "",
      run.title,
      ...(gate === "plan" ? shownOutputs.map(text) : []),
      ...(scope ? [text(scope)] : []),
    ],
    paths: diff?.files ?? [],
    complexityClass: pd.complexity?.class ?? null,
    classificationConfidence: pd.confidence ?? null,
    declared: scope?.risk ?? null,
  });
  return {
    gate,
    profile: String(run.profile ?? ""),
    targets,
    allowed: run.allowed_repositories,
    ambiguous: gate === "repository_selection" ? request?.ambiguous !== false : false,
    rediscovered: !!discovery?.rediscovered,
    risk,
    requiresRiskAck: !!request?.requires_risk_acknowledgement,
    humanApprovedPlan: prior.some(
      (s) =>
        s.type === "human_approval" &&
        !s.config?.select_repositories &&
        s.approval?.granted &&
        s.approval?.actor_type !== "machine",
    ),
    planMissing: gate === "plan" ? planMissing([...shownOutputs, scope]) : undefined,
    review: verdictStep
      ? {
          verdict: verdictStep.output.verdict,
          independent: verdictStep.config?.independent === true,
        }
      : { verdict: null, independent: false },
    testsPassed: prior.some(
      (s) => s.output?.tested_heads && typeof s.output.tested_heads === "object",
    )
      ? !prior.some((s) => s.output?.passed === false)
      : null,
    scopeReapproval:
      outputs.some(
        (o) => o.scope_check?.requires_reapproval === true && !o.scope_check?.reapproved,
      ) || outputs.some((o) => o.scope_check?.in_scope === false),
    remediation:
      verdictStep?.output?.remediation_kind ??
      outputs
        .map((o) => o.remediation?.kind)
        .filter(Boolean)
        .at(-1) ??
      null,
    requireHuman: request?.autonomy_recheck_failed === true,
    ...(diff !== undefined ? { diff } : {}),
  };
}

/** What a decision is bound to: approving A never covers B. */
export function gateSubject(gate: GateKind, step: StepRow, steps: StepRow[], request: Json | null) {
  if (gate === "diff") {
    const heads: Record<string, string> = {};
    for (const s of steps)
      for (const h of [s.output?.tested_heads, s.output?.verified_heads])
        if (h && typeof h === "object") Object.assign(heads, h);
    return { kind: gate, heads, hash: checkpointHash({ heads, generation: step.generation }) };
  }
  return {
    kind: gate,
    hash: checkpointHash({
      request: request ?? null,
      shown: steps
        .filter((s) => (step.config?.show_outputs ?? []).includes(s.key))
        .map((s) => [s.key, s.generation, s.output]),
      generation: step.generation,
    }),
  };
}

// ---------------------------------------------------------------- persistence

export async function loadPolicies(db: Db = pool, lock = false) {
  return q<AutonomyPolicy>(
    db,
    `SELECT id, scope_kind, scope_ref, mode, shadow, gates, max_diff_lines, revision, revoked_at
       FROM autonomy_policies ORDER BY id${lock ? " FOR SHARE" : ""}`,
  );
}

/** Run-level ceiling frozen at creation (global + owner + request); repositories are checked live at each gate. */
export async function freezeAutonomy(db: Db, requested: unknown, ownerId: number) {
  return resolveAutonomy(requested, await loadPolicies(db), { ownerId, repositories: [] });
}

export interface GateDecision extends GateOutcome {
  gate: GateKind;
  mode: AutonomyMode;
  shadow: boolean;
  /** ALLOW that the platform carries out (not shadow). */
  enforced: boolean;
  policy: { version: string; sources: EffectiveAutonomy["sources"]; downgraded: string[] };
  subject: ReturnType<typeof gateSubject>;
  targets: string[];
  generation: number;
  decided_at: string;
}

/**
 * Decide one gate inside the caller's transaction (run row locked; policy rows read FOR SHARE so a concurrent revocation
 * either commits first and is seen, or waits). Records the decision; returns null for legacy runs without autonomy.
 */
export async function evaluateGate(
  c: Db,
  run: RunRow,
  step: StepRow,
  steps: StepRow[],
  request: Json | null,
  diff?: { lines: number; files: string[] } | null,
): Promise<GateDecision | null> {
  const frozen = run.autonomy;
  if (!frozen) return null;
  const wi = run.work_item_id
    ? ((
        await q<{ title: string; description: string }>(
          c,
          "SELECT title, description FROM work_items WHERE id = $1",
          [run.work_item_id],
        )
      )[0] ?? null)
    : null;
  const evidence = gateEvidence(run, step, steps, request, wi, diff);
  const live = resolveAutonomy(frozen.requested, await loadPolicies(c, true), {
    ownerId: run.owner_id ?? null,
    repositories: evidence.targets,
  });
  const policy = narrow(frozen, live);
  const outcome = decideGate(policy, evidence);
  const enforced = outcome.result === "ALLOW" && !policy.shadow;
  const decision: GateDecision = {
    ...outcome,
    gate: evidence.gate,
    mode: policy.mode,
    shadow: policy.shadow,
    enforced,
    policy: { version: policy.version, sources: policy.sources, downgraded: policy.downgraded },
    subject: gateSubject(evidence.gate, step, steps, request),
    targets: evidence.targets,
    generation: step.generation,
    decided_at: new Date().toISOString(),
  };
  await recordDecision(c, {
    runId: run.id,
    stepId: step.id,
    generation: step.generation,
    kind: "autonomy",
    action: outcome.result,
    outcome: enforced ? "applied" : outcome.result === "ALLOW" ? "planned" : "rejected",
    reason: outcome.reasons.join("; "),
    details: {
      actor_type: "machine",
      gate: evidence.gate,
      mode: policy.mode,
      shadow: policy.shadow,
      required_evidence: outcome.required_evidence,
      subject: decision.subject.hash,
      policy: decision.policy,
      risk: evidence.risk.level,
    },
  });
  return decision;
}

/** A human approval: same log, its own actor type; bound to the subject the approver saw when they sent it. */
export async function recordHumanApproval(
  c: Db,
  run: RunRow,
  step: StepRow,
  by: string,
  subject: string | null,
) {
  if (!run.autonomy) return;
  await recordDecision(c, {
    runId: run.id,
    stepId: step.id,
    generation: step.generation,
    kind: "autonomy",
    action: "ALLOW",
    outcome: "applied",
    reason: "approved by a human",
    details: { actor_type: "human", by, subject },
  });
}

export function machineApproval(d: GateDecision) {
  return {
    granted: true,
    generation: d.generation,
    actor_type: "machine" as const,
    by: "",
    comment: d.reasons.join("; "),
    at: d.decided_at,
    subject: d.subject,
    policy: d.policy,
  };
}

/**
 * Before the side effect: a machine approval of a PR gate is re-decided on the actual diff read from git now, with the
 * live policy (revocation, pause). It must still be the subject it approved (same heads, or the same patch rebased).
 * Returns the request that hands the gate to a human, or null when the approval still holds.
 */
export async function recheckBeforePublish(
  runId: number,
  step: StepRow,
  steps: StepRow[],
  repos: Array<{ repo: string; path: string; base: string; head: string; equivalent: string[] }>,
): Promise<Record<string, unknown> | null> {
  if (step.approval?.actor_type === "human") return null;
  const machine = [
    step.approval,
    ...steps
      .filter((s) => s.type === "human_approval" && s.status === "COMPLETED")
      .map((s) => s.approval),
  ].filter((a) => a?.actor_type === "machine" && a.subject?.kind === "diff");
  if (!machine.length) return null;
  const stale = repos.filter((r) =>
    machine.some(
      (a) =>
        a.subject.heads?.[r.repo] !== r.head && !r.equivalent.includes(a.subject.heads?.[r.repo]),
    ),
  );
  let reasons: string[];
  if (stale.length)
    reasons = [
      `STALE_SUBJECT: ${stale.map((r) => r.repo).join(", ")} changed after the machine approval`,
    ];
  else {
    let diff: { lines: number; files: string[] } | null = null;
    try {
      let lines = 0;
      const files: string[] = [];
      for (const r of repos) {
        lines += await diffLineCount(r.path, r.base);
        files.push(...(await changedFiles(r.path, r.base)).all);
      }
      diff = { lines, files };
    } catch {
      diff = null;
    }
    const [run] = await q<RunRow>(pool, "SELECT * FROM workflow_runs WHERE id = $1", [runId]);
    const d = await evaluateGate(pool, run, step, steps, null, diff);
    if (d?.enforced) return null;
    reasons = d ? [d.result, ...d.reasons, ...d.required_evidence] : ["autonomy no longer applies"];
  }
  return {
    message: `Machine approval no longer holds: ${reasons.join("; ")}`,
    autonomy_recheck_failed: true,
    recheck_reasons: reasons,
  };
}

/** Step output of a machine-approved human_approval step: same shape as a human approval, distinct actor. */
export function machineApprovalOutput(d: GateDecision, request: Json | null) {
  const comment = d.reasons.join("; ");
  return {
    approved: true,
    auto: true,
    actor_type: "machine" as const,
    comment,
    by: "",
    autonomy: { mode: d.mode, subject: d.subject.hash, policy: d.policy },
    ...(d.gate === "repository_selection"
      ? { repositories: d.targets, selected_repositories: d.targets }
      : {}),
    ...(request?.scope
      ? {
          approved_scope: {
            ...request.scope,
            approved_by: "",
            approved_at: d.decided_at,
            actor_type: "machine",
            comment,
            risk_acknowledged: false,
          },
        }
      : {}),
  };
}

const APPROVAL_QUESTION =
  /\b(approve|approval|permission|allowed to|go ahead|proceed|ok to)\b|duyệt|cho phép|đồng ý|xác nhận/i;

/** ask_user triage: an approval is never answered by the platform; a choice with options may later get a policy default. */
export function classifyQuestion(x: { question: string; options?: unknown }) {
  if (APPROVAL_QUESTION.test(x.question)) return "approval" as const;
  if (Array.isArray(x.options) && x.options.length >= 2) return "implementation_choice" as const;
  return "missing_fact" as const;
}

/**
 * Questions stay with the developer (no auto-answer yet: ask_user carries no reversibility signal to rely on); the
 * triage is recorded so the policy can be calibrated in shadow before any default is applied.
 */
export async function recordClarification(
  c: Db,
  run: RunRow,
  step: StepRow,
  questions: Array<{ question: string; options?: unknown }>,
) {
  if (!run.autonomy || !questions.length) return;
  await recordDecision(c, {
    runId: run.id,
    stepId: step.id,
    generation: step.generation,
    kind: "autonomy",
    action: "REQUIRE_HUMAN",
    outcome: "planned",
    reason: "clarification stays with the developer",
    details: {
      actor_type: "machine",
      gate: "clarification",
      classes: questions.map(classifyQuestion),
    },
  });
}

export async function setAutonomyPaused(runId: number, paused: boolean, db: Db = pool) {
  const [row] = await q<{ autonomy: EffectiveAutonomy | null }>(
    db,
    "UPDATE workflow_runs SET autonomy = autonomy || jsonb_build_object('paused', $2::boolean), updated_at = now() WHERE id = $1 AND autonomy IS NOT NULL RETURNING autonomy",
    [runId, paused],
  );
  return row?.autonomy ?? null;
}

// ---------------------------------------------------------------- admin policy store

export interface PolicyInput {
  scope_kind: AutonomyPolicy["scope_kind"];
  scope_ref?: string;
  mode: AutonomyMode;
  shadow?: boolean;
  gates?: string[];
  max_diff_lines?: number;
}

export async function savePolicy(input: PolicyInput, by: string, db: Db = pool) {
  const bad = (m: string) => new EngineError(m, 400);
  if (!["global", "owner", "repository"].includes(input.scope_kind))
    throw bad("invalid scope_kind");
  if (!isMode(input.mode)) throw bad("invalid mode");
  const ref = input.scope_kind === "global" ? "" : String(input.scope_ref ?? "").trim();
  if (input.scope_kind !== "global" && !ref) throw bad("scope_ref is required");
  if (input.gates != null && !Array.isArray(input.gates)) throw bad("gates must be a list");
  const gates = [...new Set((input.gates ?? []).map(String))];
  if (gates.some((g) => !(AUTO_GATES as readonly string[]).includes(g)))
    throw bad(`gates must be among ${AUTO_GATES.join(", ")}`);
  const max = input.max_diff_lines ?? 400;
  if (!Number.isInteger(max) || max <= 0) throw bad("max_diff_lines must be a positive integer");
  const [row] = await q<AutonomyPolicy>(
    db,
    `INSERT INTO autonomy_policies (scope_kind, scope_ref, mode, shadow, gates, max_diff_lines, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scope_kind, scope_ref) DO UPDATE SET mode = EXCLUDED.mode, shadow = EXCLUDED.shadow,
       gates = EXCLUDED.gates, max_diff_lines = EXCLUDED.max_diff_lines, updated_by = EXCLUDED.updated_by,
       revoked_at = NULL, revision = autonomy_policies.revision + 1, updated_at = now()
     RETURNING *`,
    [input.scope_kind, ref, input.mode, input.shadow !== false, gates, max, by],
  );
  return row;
}

export async function revokePolicy(id: number, by: string, db: Db = pool) {
  const [row] = await q<AutonomyPolicy>(
    db,
    "UPDATE autonomy_policies SET revoked_at = now(), revision = revision + 1, updated_by = $2, updated_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *",
    [id, by],
  );
  return row ?? null;
}
