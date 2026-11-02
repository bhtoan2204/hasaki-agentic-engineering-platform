import { pool, q, one, json } from "../../db/pool.ts";
import { runEvents } from "../events.ts";
import type { ResolvedContext, StepInput } from "../context.ts";
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
  log(kind: "agent" | "tool" | "system" | "system_prompt" | "prompt" | "thinking" | "tool_result" | "result", content: string, data?: unknown): Promise<void>;
  artifact(kind: string, name: string, content: string, data?: unknown): Promise<number>;
  /** Persist questions against this attempt immediately (used by the ask_user MCP tool). */
  ask(questions: Array<{ question: string; context?: string; options?: string[] }>): Promise<number>;
  recordSession(sessionId: string, cwd: string, model?: string): Promise<void>;
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

export function makeContext(base: Omit<ExecutionContext, "log" | "artifact" | "ask" | "recordSession">): ExecutionContext {
  const { run, step, attempt } = base;
  return {
    ...base,
    log: (kind, content, data) => runEvents.add(pool, run.id, kind, content, step.id, attempt.id, data ?? null),
    async artifact(kind, name, content, data) {
      const r = await one(pool, "INSERT INTO workflow_artifacts (run_id, step_id, attempt_id, kind, name, content, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", [
        run.id,
        step.id,
        attempt.id,
        kind,
        name,
        content,
        json(data ?? null),
      ]);
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
    async recordSession(sessionId, cwd, model = "") {
      await q(pool, "UPDATE workflow_step_attempts SET agent_session_id = $2 WHERE id = $1", [attempt.id, sessionId]);
      await q(pool, "INSERT INTO agent_sessions (attempt_id, session_id, cwd, model) VALUES ($1, $2, $3, $4)", [attempt.id, sessionId, cwd, model]);
    },
  };
}
