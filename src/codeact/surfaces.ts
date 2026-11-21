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
import { audit } from "../authz/access.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { redactContextValue } from "../context/redact.ts";
import {
  canonicalJson,
  codeActAvailability,
  executeCode,
  type CallRecord,
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
  evidence: string[];
  calls: Array<{ seq: number; tool: string; status: CallRecord["status"]; ref?: string }>;
  stats?: CodeActResult["stats"];
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
const catalogOf = (p: CodeActPlatform) => () =>
  p.integrationTools().map((t) => ({ name: t.name, summary: t.summary, readOnly: t.readOnly }));

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

async function finishExecution(executionId: number, r: CodeActResult): Promise<CodeActAnswer> {
  await terminate(
    executionId,
    r.ok ? "ok" : "error",
    r.ok ? null : (r.category ?? "internal"),
    r.stats,
  );
  const ref = (c: CallRecord) =>
    c.status === "ok" ? `codeact:${executionId}:${c.seq}` : undefined;
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
    evidence: r.calls.map(ref).filter((x): x is string => !!x),
    calls: r.calls.map((c) => ({ seq: c.seq, tool: c.tool, status: c.status, ref: ref(c) })),
    stats: r.stats,
  };
}

const unsupported = (error: string): CodeActAnswer => ({
  ok: false,
  untrusted: true,
  error,
  category: "unsupported",
  evidence: [],
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
    call,
    signal: env.signal,
    record: recorder(executionId),
  });
  return finishExecution(executionId, r);
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
    call,
    signal: chat.signal,
    record: recorder(executionId),
  });
  return finishExecution(executionId, r);
}
