import { pool, q, one, json, retryTransient } from "../../db/pool.ts";
import { runEvents } from "../events.ts";
import type { ResolvedContext, StepInput } from "../context.ts";
import type { AgentProvider } from "../../agent/provider.ts";
import type { AttemptRow, ExecResult, RunRow, StepRow, StepType } from "../types.ts";

/** What an executor gets. Side-effect helpers are bound to the current run/step/attempt. */
export interface ExecutionContext {
  run: RunRow;
  step: StepRow;
  attempt: AttemptRow;
  input: StepInput;
  context: ResolvedContext;
  signal: AbortSignal;
  /** Timeline / transcript entry for this attempt. `data` holds structured details (tool input, cost...). */
  log(kind: "agent" | "tool" | "system" | "system_prompt" | "prompt" | "thinking" | "tool_result" | "result" | "log", content: string, data?: unknown): Promise<void>;
  artifact(kind: string, name: string, content: string, data?: unknown): Promise<number>;
  /** Persist questions against this attempt immediately (used by the ask_user MCP tool). */
  ask(questions: Array<{ question: string; context?: string; options?: string[] }>): Promise<number>;
  recordSession(sessionId: string, cwd: string, model?: string, provider?: AgentProvider): Promise<void>;
  /** Observability: tokens, cost, tool usage, skills loaded, integration calls, subagents (merged into attempt.metrics). */
  recordMetrics(metrics: Record<string, unknown>): Promise<void>;
}

export interface StepExecutor {
  execute(ctx: ExecutionContext): Promise<ExecResult>;
}

const registry = new Map<StepType, StepExecutor>();

export function registerExecutor(type: StepType, executor: StepExecutor) {
  registry.set(type, executor);
}

export function getExecutor(type: StepType): StepExecutor {
  const e = registry.get(type);
  if (!e) throw new Error(`no executor registered for step type "${type}"`);
  return e;
}

export function makeContext(base: Omit<ExecutionContext, "log" | "artifact" | "ask" | "recordSession" | "recordMetrics">): ExecutionContext {
  const { run, step, attempt } = base;
  let hasProviderSessions = false;
  return {
    ...base,
    // A transcript line is never worth failing the step: retry over a dropped connection, then give up quietly.
    log: (kind, content, data) =>
      retryTransient(() => runEvents.add(pool, run.id, kind, content, step.id, attempt.id, data ?? null), `log ${kind} (run ${run.id})`).catch((e) => {
        console.error(`run ${run.id} ${step.key}: could not record a ${kind} event: ${(e as Error).message}`);
      }),
    async artifact(kind, name, content, data) {
      const r = await retryTransient(() => one(pool, "INSERT INTO workflow_artifacts (run_id, step_id, attempt_id, kind, name, content, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", [
        run.id,
        step.id,
        attempt.id,
        kind,
        name,
        content,
        json(data ?? null),
      ]), `artifact ${name}`);
      return r.id;
    },
    async ask(questions) {
      for (const x of questions)
        await q(pool, "INSERT INTO workflow_questions (run_id, step_id, attempt_id, question, context, options, suggested_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
          run.id,
          step.id,
          attempt.id,
          x.question,
          x.context ?? "",
          json(x.options ?? []),
          x.options?.[0] ?? null,
        ]);
      return questions.length;
    },
    async recordMetrics(m) {
      if (m.provider_sessions) hasProviderSessions = true;
      const auxiliary: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(m)) {
        const v = value as any;
        if (v && typeof v === "object" && typeof v.provider === "string" && ("tokens" in v || "cost_usd" in v)) {
          auxiliary[`aux:${key}:${v.telemetry_id ?? "snapshot"}`] = {
            provider: v.provider, model: v.model ?? null, tokens: v.tokens ?? null,
            reported_cost_usd: v.cost_usd ?? null, provider_execution_ms: v.provider_execution_ms ?? null, complete: true
          };
        }
      }
      if (!hasProviderSessions && typeof m.provider === "string" && ("tokens" in m || "cost_usd" in m)) {
        auxiliary[`executor:${m.telemetry_id ?? "snapshot"}`] = {
          provider: m.provider, model: m.model ?? null, tokens: m.tokens ?? null,
          reported_cost_usd: m.cost_usd ?? null, provider_execution_ms: m.provider_execution_ms ?? null, complete: true
        };
      }
      if (Object.keys(auxiliary).length) m = { ...m, provider_sessions: { ...(m.provider_sessions as object ?? {}), ...auxiliary } };
      await retryTransient(() => q(pool, `UPDATE workflow_step_attempts a SET metrics = COALESCE(a.metrics, '{}'::jsonb) || $2::jsonb ||
          CASE WHEN $2::jsonb ? 'provider_sessions' THEN jsonb_build_object('provider_sessions',
            COALESCE(a.metrics->'provider_sessions', '{}'::jsonb) || ($2::jsonb->'provider_sessions')) ELSE '{}'::jsonb END
        WHERE a.id = $1 AND a.status = 'RUNNING' AND a.fencing_token = $3
          AND EXISTS (SELECT 1 FROM workflow_jobs j WHERE j.id = a.job_id AND j.fencing_token = $3 AND j.status = 'running' AND j.lease_expires_at > now())`,
        [attempt.id, json(m), attempt.fencing_token]), `metrics ${attempt.id}`);
    },
    async recordSession(sessionId, cwd, model = "", provider = "claude") {
      await q(pool, "UPDATE workflow_step_attempts SET agent_session_id = $2 WHERE id = $1", [attempt.id, sessionId]);
      await q(pool, "INSERT INTO agent_sessions (attempt_id, session_id, cwd, model, provider) VALUES ($1, $2, $3, $4, $5)", [attempt.id, sessionId, cwd, model, provider]);
    },
  };
}
