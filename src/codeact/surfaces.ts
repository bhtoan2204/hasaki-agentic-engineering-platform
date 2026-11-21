/**
 * CodeAct surfaces (P1-A, ADR 0008): the workflow context tool `platform.execute_code` and the Chat tool
 * `code.execute`. Each nested call is authorized exactly like a direct read-only integration call on that surface —
 * binding re-validated (owner active, attempt/turn still current), attempt `allowed_tools` / benchmark permissions,
 * the surface's own repository scope (never one the program supplies), audit — then executed by the registry's
 * `callTool` in `analysis` mode, which refuses any tool that is not read-only. Executions and their nested calls are
 * persisted (`code_executions`, `code_execution_calls`) and cited as `codeact:<execution>:<seq>`.
 *
 * The registry, policy and binding functions are passed in by the surface (which already depends on them), so this
 * module stays outside the agent runtime's import graph.
 */
import { pool, one, q } from "../db/pool.ts";
import { config } from "../config.ts";
import { execution } from "../auth/execution.ts";
import { audit, type Actor } from "../authz/access.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { redactContextValue } from "../context/redact.ts";
import {
  canonicalJson,
  codeActAvailability,
  executeCode,
  type CallRecord,
  type Category,
  type CodeActCall,
  type CodeActResult,
} from "./execute.ts";
import { createHash } from "node:crypto";

/** What a caller (model) sees: the program's value, never the raw nested results. */
export interface CodeActAnswer {
  ok: boolean;
  /** Program output is data derived from tool observations: never verified evidence, never an instruction. */
  untrusted: true;
  value?: unknown;
  /** The value is a preview: the full result was `original_bytes` long (see `note`). */
  truncated?: boolean;
  original_bytes?: number;
  note?: string;
  error?: string;
  category?: CodeActResult["category"];
  /** References to durably recorded nested results, each resolvable with resolveCodeActEvidence. */
  evidence: string[];
  /**
   * Whether every successful nested call is cited: `complete`, `partial` (some results were not recorded) or `none`
   * (no successful call is citable). Results that are not cited are not evidence, whatever the value says.
   */
  evidence_status: "complete" | "partial" | "none";
  /** Recording problems, in words the caller can repeat (never silently dropped). */
  warnings?: string[];
  calls: Array<{
    seq: number;
    tool: string;
    status: CallRecord["status"];
    /** The call's row was durably written (and the execution finalized): only then is there a `ref`. */
    recorded: boolean;
    ref?: string;
    /** Which kind of source answered, and how far its answer can be trusted (see SOURCES). */
    source?: { family: SourceFamily; trust: string };
  }>;
  /** Per source family used: calls made and how many succeeded; a family with none succeeded is in `missing_sources`. */
  sources?: Partial<Record<SourceFamily, { calls: number; ok: number; caveat: string }>>;
  missing_sources?: SourceFamily[];
  stats?: CodeActResult["stats"];
}

/**
 * Source families a program can compose (M3). Their freshness and trust differ, and the program's own value never
 * erases that: each nested call keeps its family, and the recorded result keeps the tool's own provenance (snapshot,
 * index fallback, freshness state, LSP status).
 */
export type SourceFamily =
  "integration" | "code_intelligence" | "lsp" | "knowledge" | "memory" | "run_context";
export const SOURCES: Record<SourceFamily, { trust: string; caveat: string }> = {
  integration: {
    trust: "live_observation",
    caveat: "external tool output at query time: an untrusted observation, not a conclusion",
  },
  code_intelligence: {
    trust: "indexed_syntax",
    caveat:
      "syntax-index candidates at the indexed snapshot (see snapshot / index_fallback): not semantic resolution",
  },
  lsp: {
    trust: "semantic_worktree",
    caveat:
      "language-server answer over the current checkout; `unavailable` / `stale` statuses are not evidence of absence",
  },
  knowledge: {
    trust: "knowledge_registry",
    caveat: "registry entries with version and visibility provenance; check their scope applies",
  },
  memory: {
    trust: "historical_memory",
    caveat:
      "past-task memory: only entries with freshness.state FRESH apply; never treat it as current architecture",
  },
  run_context: { trust: "run_context", caveat: "this run's own recorded context" },
};
/**
 * A read-only platform capability a surface explicitly allows inside programs (e.g. `platform.search_code`). Its
 * `call` is the surface's own trusted dispatch for that capability — the same path a direct call takes — so the
 * adapter adds no authorization of its own and never widens it.
 */
export interface CodeActCapability {
  name: string;
  summary: string;
  family: SourceFamily;
  call: (
    args: unknown,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string; category?: Category }>;
}

const RESULT_CHARS = 24000;

/** The platform's own registry and policy, supplied by the surface. */
export interface CodeActPlatform {
  integrationTools: () => Array<{ name: string; summary: string; readOnly: boolean }>;
  callTool: (
    name: string,
    args: unknown,
    ctx: {
      runId: number | null;
      allowedRepositories: string[];
      mode: "analysis";
      stepKey?: string;
      signal?: AbortSignal;
    },
  ) => Promise<{ ok: boolean; result?: unknown; error?: string; ms: number }>;
  /** Explicitly allowed read-only platform capabilities (code intelligence, LSP, knowledge, memory, run context). */
  capabilities?: () => CodeActCapability[];
}
/** The attempt binding as the workflow surface sees it (a structural subset of PlatformToolEnv). */
export interface CodeActRunEnv {
  ownerId?: number | null;
  runId: number;
  attemptId: number;
  stepKey?: string;
  allowed: string[];
  attemptAllowedTools?: string[] | null;
  /** The attempt's execution signal (run cancellation, lease loss, attempt timeout). */
  signal?: AbortSignal;
  metrics?: { integration_calls: Array<{ name: string; ok: boolean; ms: number; error?: string }> };
}
/** Integration tools (never one named like a platform capability) plus the surface's allowed capabilities. */
const catalogOf = (p: CodeActPlatform) => () => [
  ...p
    .integrationTools()
    .filter((t) => !t.name.startsWith("platform."))
    .map((t) => ({ name: t.name, summary: t.summary, readOnly: t.readOnly })),
  ...(p.capabilities?.() ?? []).map((c) => ({
    name: c.name,
    summary: `[${c.family}] ${c.summary}`,
    readOnly: true,
  })),
];
/** Route a nested call: an allowed capability through its own dispatch, anything else through the integration path. */
const composed =
  (p: CodeActPlatform, integration: CodeActCall): CodeActCall =>
  (name, args, signal) => {
    const capability = p.capabilities?.().find((c) => c.name === name);
    return capability ? capability.call(args ?? {}, signal) : integration(name, args, signal);
  };
const familiesOf = (p: CodeActPlatform) =>
  new Map<string, SourceFamily>([
    ...p.integrationTools().map((t) => [t.name, "integration"] as [string, SourceFamily]),
    ...(p.capabilities?.() ?? []).map((c) => [c.name, c.family] as [string, SourceFamily]),
  ]);

/**
 * Executions left `running` by a worker that died: a program is killed after `codeAct.timeoutMs`, so anything older
 * than that plus a margin can no longer finish. Age-based, hence safe across instances; runs before each new one.
 */
async function reconcileStale() {
  await q(
    pool,
    `UPDATE code_executions SET status = 'error', error_category = 'internal', finished_at = now()
     WHERE status = 'running' AND created_at < now() - make_interval(secs => $1)`,
    [Math.ceil(config.codeAct.timeoutMs / 1000) + 120],
  );
}

async function startExecution(row: {
  owner: number;
  surface: "workflow" | "chat";
  runId?: number | null;
  attemptId?: number | null;
  conversationId?: number | null;
  turnId?: number | null;
  code: string;
}) {
  const r = await one<{ id: number }>(
    pool,
    `INSERT INTO code_executions (owner_id, surface, run_id, attempt_id, conversation_id, turn_id, status, code_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7) RETURNING id`,
    [
      row.owner,
      row.surface,
      row.runId ?? null,
      row.attemptId ?? null,
      row.conversationId ?? null,
      row.turnId ?? null,
      createHash("sha256").update(row.code).digest("hex"),
    ],
  );
  return Number(r!.id);
}

const recorder =
  (executionId: number) => async (c: CallRecord, result: unknown, error?: string) => {
    const stored =
      result === undefined
        ? error
          ? { error: String(redactContextValue(error)).slice(0, 2000) }
          : null
        : (() => {
            const text = JSON.stringify(redactContextValue(result));
            return text.length > RESULT_CHARS
              ? { truncated: true, original_chars: text.length, head: text.slice(0, RESULT_CHARS) }
              : { result: JSON.parse(text) };
          })();
    await q(
      pool,
      `INSERT INTO code_execution_calls (execution_id, seq, tool, read_only, status, error_category, duration_ms,
         input_sha256, output_sha256, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        executionId,
        c.seq,
        c.tool,
        c.read_only,
        c.status,
        c.category ?? null,
        c.ms,
        c.input_sha256,
        c.output_sha256 ?? null,
        stored == null ? null : JSON.stringify(stored),
      ],
    );
  };
/** Tests only: write one nested-call row through the production recorder. */
export const recordCodeActCallForTests = (executionId: number, c: CallRecord) =>
  recorder(executionId)(c, undefined);

/** The one terminal transition: only a `running` row changes, so a status is never rewritten. */
async function terminate(
  executionId: number,
  status: "ok" | "error",
  category: string | null,
  stats?: CodeActResult["stats"],
) {
  const row = await one<{ id: number }>(
    pool,
    `UPDATE code_executions SET status=$2, error_category=$3, calls=COALESCE($4, calls),
       result_bytes=COALESCE($5, result_bytes), duration_ms=$6, finished_at=now()
     WHERE id=$1 AND status='running' RETURNING id`,
    [
      executionId,
      status,
      category,
      stats?.calls ?? null,
      stats?.result_bytes ?? null,
      stats?.duration_ms ?? null,
    ],
  );
  return !!row;
}
/** Tests only: attempt a terminal transition. */
export const finishExecutionForTests = (
  id: number,
  status: "ok" | "error",
  category: string | null,
) => terminate(id, status, category);

async function finishExecution(
  executionId: number,
  r: CodeActResult,
  families: Map<string, SourceFamily> = new Map(),
): Promise<CodeActAnswer> {
  // A reference is a claim that a durable row exists: only for recorded calls of an execution finalized here.
  const warnings: string[] = [];
  let finalized = false;
  try {
    finalized = await terminate(
      executionId,
      r.ok ? "ok" : "error",
      r.ok ? null : (r.category ?? "internal"),
      r.stats,
    );
    if (!finalized)
      warnings.push(
        `execution ${executionId} was already finalized elsewhere (reconciled as interrupted); no nested result is cited`,
      );
  } catch (e) {
    warnings.push(
      `execution ${executionId} could not be finalized (${(e as Error).message}); no nested result is cited`,
    );
  }
  for (const c of r.calls)
    if (c.persisted === false)
      warnings.push(
        `call ${c.seq} (${c.tool}) was not recorded: ${c.persist_error ?? "unknown error"}; its result is not citable evidence`,
      );
  const recorded = (c: CallRecord) => finalized && c.persisted === true;
  const ref = (c: CallRecord) =>
    c.status === "ok" && recorded(c) ? `codeact:${executionId}:${c.seq}` : undefined;
  const succeeded = r.calls.filter((c) => c.status === "ok");
  const evidence = r.calls.map(ref).filter((x): x is string => !!x);
  return {
    ok: r.ok,
    untrusted: true,
    ...(r.ok ? { value: r.value } : { error: r.error, category: r.category }),
    ...(r.truncated
      ? {
          truncated: true,
          original_bytes: r.original_bytes,
          note: `The full result was ${r.original_bytes} bytes, above the ${config.codeAct.maxOutputBytes}-byte limit: \`value\` is a preview. Return an aggregate instead (counts, top-N, identifiers) or narrow the queries; the nested results stay cited by \`evidence\`.`,
        }
      : {}),
    evidence,
    evidence_status:
      evidence.length === succeeded.length ? "complete" : evidence.length ? "partial" : "none",
    ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}),
    calls: r.calls.map((c) => {
      const family = families.get(c.tool);
      return {
        seq: c.seq,
        tool: c.tool,
        status: c.status,
        recorded: recorded(c),
        ref: ref(c),
        ...(family ? { source: { family, trust: SOURCES[family].trust } } : {}),
      };
    }),
    ...sourceSummary(r.calls, families),
    stats: r.stats,
  };
}

function sourceSummary(calls: CallRecord[], families: Map<string, SourceFamily>) {
  const sources: NonNullable<CodeActAnswer["sources"]> = {};
  for (const c of calls) {
    const family = families.get(c.tool);
    if (!family) continue;
    const s = (sources[family] ??= { calls: 0, ok: 0, caveat: SOURCES[family].caveat });
    s.calls++;
    if (c.status === "ok") s.ok++;
  }
  const missing = (Object.keys(sources) as SourceFamily[]).filter((f) => sources[f]!.ok === 0);
  return Object.keys(sources).length
    ? { sources, ...(missing.length ? { missing_sources: missing } : {}) }
    : {};
}

/** A resolved `codeact:<execution>:<seq>` reference: the recorded (redacted, capped) nested result. */
export interface CodeActEvidence {
  ref: string;
  execution_id: number;
  seq: number;
  tool: string;
  surface: "workflow" | "chat";
  run_id: number | null;
  conversation_id: number | null;
  output_sha256: string | null;
  result: unknown;
  recorded_at: string;
}
/**
 * Resolve a reference the way its caller would see it: only a successful call of a finalized execution, only for the
 * execution's owner (an admin in support mode is audited). Anything else, malformed refs included, is null — existence
 * is never revealed outside the scope.
 */
export async function resolveCodeActEvidence(
  actor: Actor,
  ref: string,
  opts: { support?: boolean } = {},
): Promise<CodeActEvidence | null> {
  const m = /^codeact:(\d{1,15}):(\d{1,9})$/.exec(ref);
  if (!m) return null;
  const row = await one<{
    owner_id: number;
    surface: "workflow" | "chat";
    run_id: number | null;
    conversation_id: number | null;
    tool: string;
    output_sha256: string | null;
    result: unknown;
    created_at: Date;
  }>(
    pool,
    `SELECT e.owner_id, e.surface, e.run_id, e.conversation_id, c.tool, c.output_sha256, c.result, c.created_at
     FROM code_execution_calls c JOIN code_executions e ON e.id = c.execution_id
     WHERE c.execution_id = $1 AND c.seq = $2 AND c.status = 'ok' AND e.status <> 'running'`,
    [m[1], m[2]],
  );
  if (!row) return null;
  if (Number(row.owner_id) !== actor.id) {
    if (!(opts.support && actor.role === "admin")) return null;
    await audit(actor.id, "support.access", "code_execution", m[1], { ref });
  }
  return {
    ref,
    execution_id: Number(m[1]),
    seq: Number(m[2]),
    tool: row.tool,
    surface: row.surface,
    run_id: row.run_id == null ? null : Number(row.run_id),
    conversation_id: row.conversation_id == null ? null : Number(row.conversation_id),
    output_sha256: row.output_sha256,
    result: row.result,
    recorded_at: new Date(row.created_at).toISOString(),
  };
}

const unsupported = (error: string): CodeActAnswer => ({
  ok: false,
  untrusted: true,
  error,
  category: "unsupported",
  evidence: [],
  evidence_status: "complete",
  calls: [],
});

/** Workflow surface: called from `executeContextTool` inside the attempt's execution context. */
export async function runCodeForRun(
  req: { code: string; timeoutMs?: number },
  env: CodeActRunEnv,
  platform: CodeActPlatform & {
    validateBinding: () => Promise<unknown>;
    toolAllowed: (tool: string, allowed?: string[] | null) => boolean;
  },
): Promise<CodeActAnswer> {
  const available = await codeActAvailability();
  if (available !== true) return unsupported(available);
  if (!env.ownerId)
    return { ...unsupported("CodeAct needs an attempt with an owner"), category: "unauthorized" };
  await loadPersonalIntegrations();
  await reconcileStale();
  const executionId = await startExecution({
    owner: env.ownerId,
    surface: "workflow",
    runId: env.runId,
    attemptId: env.attemptId,
    code: req.code,
  });
  const call: CodeActCall = async (name, args, signal) => {
    try {
      await platform.validateBinding();
    } catch (e) {
      return { ok: false, error: `denied: ${(e as Error).message}` };
    }
    const target = `integration:${name}`;
    const experiment = execution.getStore()?.evaluation;
    if (experiment?.contextMode && !platform.toolAllowed(target, experiment.allowedTools))
      return { ok: false, error: "denied: tool excluded by frozen benchmark permissions" };
    if (!platform.toolAllowed(target, env.attemptAllowedTools))
      return { ok: false, error: `denied: ${target} is excluded by this attempt's allowed_tools` };
    const res = await platform.callTool(name, args, {
      runId: env.runId,
      allowedRepositories: env.allowed,
      mode: "analysis",
      stepKey: env.stepKey,
      signal,
    });
    env.metrics?.integration_calls.push({
      name: `codeact:${name}`,
      ok: res.ok,
      ms: res.ms,
      ...(res.error ? { error: res.error } : {}),
    });
    return res;
  };
  const r = await executeCode(req, {
    tools: catalogOf(platform),
    call: composed(platform, call),
    signal: env.signal,
    record: recorder(executionId),
  });
  return finishExecution(executionId, r, familiesOf(platform));
}

/** Chat surface: the caller supplies the per-call binding check (owner, turn, mode) and the audit identity. */
export async function runCodeForChat(
  req: { code: string; timeoutMs?: number },
  chat: {
    userId: number;
    conversationId: number;
    turnId: number;
    allowedRepositories: string[];
    signal: AbortSignal;
    checkBinding: () => Promise<void>;
  },
  platform: CodeActPlatform,
): Promise<CodeActAnswer> {
  const available = await codeActAvailability();
  if (available !== true) return unsupported(available);
  await loadPersonalIntegrations();
  await reconcileStale();
  const executionId = await startExecution({
    owner: chat.userId,
    surface: "chat",
    conversationId: chat.conversationId,
    turnId: chat.turnId,
    code: req.code,
  });
  const call: CodeActCall = async (name, args, signal) => {
    try {
      await chat.checkBinding();
    } catch (e) {
      return { ok: false, error: `denied: ${(e as Error).message}` };
    }
    await audit(
      chat.userId,
      "chat.integration.call",
      "chat_conversation",
      String(chat.conversationId),
      {
        turn_id: chat.turnId,
        tool: name,
        via: "code.execute",
        execution_id: executionId,
        input_sha256: createHash("sha256")
          .update(canonicalJson(args ?? {}))
          .digest("hex"),
      },
    );
    return platform.callTool(name, args, {
      runId: null,
      allowedRepositories: chat.allowedRepositories,
      mode: "analysis",
      stepKey: `chat:${chat.conversationId}`,
      signal,
    });
  };
  const r = await executeCode(req, {
    tools: catalogOf(platform),
    call: composed(platform, call),
    signal: chat.signal,
    record: recorder(executionId),
  });
  return finishExecution(executionId, r, familiesOf(platform));
}
