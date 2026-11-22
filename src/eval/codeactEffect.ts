/**
 * CodeAct effectiveness evaluation (M2): Direct Tools (A) vs CodeAct (B), paired per task and repetition, through the
 * platform's real Chat harness (prompt building, routing, tool dispatch, authorization, CodeAct surface, usage
 * accounting). The ONLY variable is `codeAct.enabled`, which decides whether `code.execute` is disclosed and callable;
 * provider, model, mode (INVESTIGATE), tools, data, budgets and prompts are otherwise identical. A/B order alternates
 * per repetition. Metrics come from what the platform persisted (chat usage, tool calls, code executions) plus the
 * prompts the provider actually received; unknown provider values stay null.
 *
 * Two providers:
 * - `simulated`: a deterministic policy that only uses what its prompt shows (tool results as the platform delivers
 *   them, truncation included) and runs each task's reference plan — directly one round at a time, or as one
 *   CodeAct program when `code.execute` is offered and the task is eligible. It measures the harness, not a model:
 *   its tokens are unknown (only estimated from prompt size), and its adoption is by construction.
 * - a real provider (`claude`, `codex`, …): the platform's own runner, wrapped only to measure prompt sizes.
 */
import { config } from "../config.ts";
import { pool, q, one } from "../db/pool.ts";
import { chat } from "../chat/service.ts";
import { setChatProviders } from "../chat/runtime.ts";
import { LIMITS } from "../chat/policy.ts";
import type { Actor } from "../authz/access.ts";
import type { AgentProvider } from "../agent/provider.ts";
import type { CompletionRunner } from "../agent/complete.ts";
import { wilson } from "./scoring.ts";
import { classifyRecovery, type RecoverySummary, type ToolEvent } from "./codeactRecovery.ts";
import {
  gradeAnswer,
  parseAnswer,
  referenceAnswer,
  registerEvaluationTools,
  TASKS,
  type EffectTask,
} from "./codeactTasks.ts";

export type Variant = "direct" | "codeact";
export const VARIANTS: Variant[] = ["direct", "codeact"];
const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];

export interface Sample {
  task_id: string;
  category: string;
  eligible: boolean;
  variant: Variant;
  repetition: number;
  provider: string;
  /** Deprecated alias of `requested_model` (kept for older readers). */
  model: string | null;
  /** What the evaluation asked for (null = the provider account's default) and the reasoning effort used. */
  requested_model: string | null;
  effort: string | null;
  /** What the provider reported using (API message models, else its session model); empty when it reported none. */
  provider_models: string[];
  model_resolution: "provider_reported" | "unresolved";
  /** Whether code.execute was offered to the model in this sample (catalog text or native tool definition). */
  codeact_offered: boolean;
  turn_status: string;
  correct: boolean;
  answered: boolean;
  unsupported: number;
  fields: Record<string, boolean>;
  /**
   * SDK calls (provider completions the chat harness made) and the model turns inside them — one SDK call can hold a
   * whole native tool loop. `model_turns` is null when the provider did not report it. Then the top-level chat tool
   * calls and the provider's own tool-use events.
   */
  sdk_calls: number;
  model_turns: number | null;
  provider_tool_uses: number | null;
  tool_calls: number;
  integration_calls: number;
  codeact_executions: number;
  codeact_failed: number;
  nested_calls: number;
  /** Nested calls that did not succeed (inside failed and successful executions alike). */
  nested_failures: number;
  /** Sanitized diagnosis of each failed execution (category, phase, the nested tool involved). */
  codeact_failures: Array<{
    execution_id: number;
    category: string;
    phase: string;
    nested_tool?: string | null;
    nested_category?: string;
  }>;
  /** What followed each failure, from the observed sequence (see codeactRecovery.ts). */
  recovery: RecoverySummary;
  composed_tools: string[];
  /** Prompt text the provider received (all completions) and the largest single prompt (context occupancy). */
  prompt_chars_total: number;
  prompt_chars_max: number;
  /** ESTIMATE (chars / 4), never a provider count. */
  estimated_prompt_tokens: number;
  /** Tool-result text delivered back to the model, and how many results were cut at the chat limit. */
  tool_result_chars: number;
  truncated_results: number;
  /** Provider-reported; null = unknown (never replaced by zero). */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  /** Uncached input + cache reads + cache writes (what the provider processed as input); null if any part unknown. */
  input_tokens_total: number | null;
  cost_usd: number | null;
  provider_ms: number;
  sandbox_ms: number;
  latency_ms: number;
  /** For CodeAct executions: whether every successful nested call is cited (M1). */
  evidence_complete: boolean | null;
}

// ------------------------------------------------------------------------------------------- simulated provider

const RESULT = /<untrusted source="tool #(\d+) ([\w.]+) \((\w+)\)">\n([\s\S]*?)\n<\/untrusted>/g;
type Seen = { tool: string; status: string; value?: unknown; unreadable?: boolean };
const block = (calls: Array<{ tool: string; arguments: unknown }>) =>
  "```chat-tool\n" + JSON.stringify({ calls }) + "\n```";
const final = (value: unknown, note: string) =>
  `${note}\n\n\`\`\`answer\n${JSON.stringify(value)}\n\`\`\``;

/**
 * The deterministic stand-in for a model. It keeps what it has seen across completions (like a session), never reads
 * fixture data except through its prompt, and cannot use a result the platform truncated.
 */
export function simulatedPolicy(
  task: EffectTask,
  /**
   * Regression fixtures only: the first program sent (e.g. a buggy one), and what the policy does when a program fails:
   * send the reference program once more (`retry`) or continue with direct calls (`direct`, the default).
   */
  fault: { firstProgram?: string; onFailure?: "retry" | "direct" } = {},
): CompletionRunner {
  const seen = new Map<number, Seen>();
  let programs = 0;
  return async (prompt, options) => {
    for (const m of prompt.matchAll(RESULT)) {
      const seq = Number(m[1]);
      if (seen.get(seq)?.value !== undefined) continue; // an earlier full view beats a compacted one
      let value: unknown;
      let unreadable = false;
      try {
        value = JSON.parse(m[4]);
      } catch {
        unreadable = true; // truncated or compacted: the model cannot rely on it
      }
      seen.set(seq, { tool: m[2], status: m[3], value, unreadable });
    }
    const ordered = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const codeact = ordered.filter((s) => s.tool === "code.execute").at(-1);
    if (codeact) {
      const answer = codeact.value as { ok?: boolean; value?: unknown } | undefined;
      if (answer?.ok)
        return { text: final(answer.value, "Computed with one CodeAct program."), tokens: null };
    }
    // Offered the way a model would see it: in the prompt's tool catalog or as a native tool definition.
    const offered =
      /\bcode\.execute\b/.test(prompt) ||
      !!options.nativeTools?.tools.some((t) => t.name === "code.execute");
    const plan = `return await (${task.plan.toString()})((name, args) => platform.callTool(name, args));`;
    if (task.eligible && offered && programs === 0) {
      programs++;
      const code = fault.firstProgram ?? plan;
      return { text: block([{ tool: "code.execute", arguments: { code } }]), tokens: null };
    }
    if (task.eligible && offered && programs === 1 && codeact && fault.onFailure === "retry") {
      programs++;
      return { text: block([{ tool: "code.execute", arguments: { code: plan } }]), tokens: null };
    }
    // Direct: replay the plan; the k-th tool call maps to the k-th tools.call result seen.
    const direct = ordered.filter((s) => s.tool === "tools.call");
    const need: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let k = 0;
    const outcome = task
      .plan((name, args) => {
        const i = k++;
        const r = direct[i];
        if (!r) {
          need.push({ name, arguments: args });
          return new Promise(() => {});
        }
        if (r.status !== "ok")
          return Promise.reject(
            new Error(String((r.value as { error?: string })?.error ?? "tool failed")),
          );
        if (r.unreadable) return Promise.resolve({}); // the payload was cut: nothing usable
        return Promise.resolve(r.value);
      })
      .then(
        (value) => ({ value }),
        (e: Error) => ({ error: e.message }),
      );
    const settled = await Promise.race([
      outcome,
      new Promise<null>((r) => setTimeout(() => r(null), 20)),
    ]);
    if (need.length)
      return {
        text: block(
          need
            .slice(0, LIMITS.maxToolCallsPerStep)
            .map((c) => ({ tool: "tools.call", arguments: c })),
        ),
        tokens: null,
      };
    if (settled && "value" in settled)
      return { text: final(settled.value, "Computed from direct tool results."), tokens: null };
    return {
      text: final(
        {},
        `Could not determine the answer from the visible results (${settled?.error ?? "incomplete"}).`,
      ),
      tokens: null,
    };
  };
}

// ------------------------------------------------------------------------------------------------- harness

/** Wraps a runner to record the prompts the provider received. */
/** Wraps a runner to record the prompts the provider received and whether code.execute was offered in them. */
function measured(runner: CompletionRunner) {
  const prompts: number[] = [];
  let codeactOffered = false;
  const wrapped: CompletionRunner = (prompt, options) => {
    prompts.push(prompt.length);
    if (
      /\bcode\.execute\b/.test(prompt) ||
      options.nativeTools?.tools.some((t) => t.name === "code.execute")
    )
      codeactOffered = true;
    return runner(prompt, options);
  };
  return { wrapped, prompts, offered: () => codeactOffered };
}

async function waitForTurn(actor: Actor, conversationId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await chat.get(actor, conversationId);
    if (!d.active_turn && d.turns.every((t) => !["queued", "running"].includes(t.status)))
      return d.turns.at(-1)?.status ?? "unknown";
    await new Promise((r) => setTimeout(r, 25));
  }
  return "timeout";
}

export interface RunOptions {
  actor: Actor;
  provider: AgentProvider;
  model?: string | null;
  /** Per sample: the runner (simulated policy or a real provider runner). */
  runnerFor: (task: EffectTask, variant: Variant) => CompletionRunner;
  turnTimeoutMs?: number;
}

/** One sample: one task, one variant, one fresh conversation. */
export async function runSample(
  task: EffectTask,
  variant: Variant,
  repetition: number,
  o: RunOptions,
): Promise<Sample> {
  registerEvaluationTools();
  const expected = await referenceAnswer(task);
  config.codeAct.enabled = variant === "codeact";
  const { wrapped, prompts, offered } = measured(o.runnerFor(task, variant));
  setChatProviders(
    Object.fromEntries(PROVIDERS.map((p) => [p, wrapped])) as Record<
      AgentProvider,
      CompletionRunner
    >,
  );
  const conv = await chat.create(o.actor, {
    mode: "INVESTIGATE",
    provider: o.provider,
    ...(o.model ? { model: o.model } : {}),
  });
  const t0 = Date.now();
  await chat.postMessage(o.actor, conv.id, {
    content: task.question,
    client_message_id: `codeact-eval-${task.id}-${variant}-${repetition}-${t0}`,
  });
  const status = await waitForTurn(o.actor, conv.id, o.turnTimeoutMs ?? 600_000);
  const latency = Date.now() - t0;

  const reply = await one<{ content: string }>(
    pool,
    "SELECT content FROM chat_messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 1",
    [conv.id],
  );
  // The turn's own record: usage, what the provider reported using, and what was requested (the attempt).
  const turnRow = await one<{
    metrics: Record<string, unknown> | null;
    attempts: Array<{ model?: string | null; effort?: string | null; ok?: boolean }> | null;
  }>(
    pool,
    "SELECT metrics, attempts FROM chat_turns WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1",
    [conv.id],
  );
  const usage = (turnRow?.metrics ?? {}) as Record<string, unknown>;
  const attempt = turnRow?.attempts?.find((a) => a.ok) ?? turnRow?.attempts?.at(-1);
  const providerModels = Array.isArray(usage.provider_models)
    ? (usage.provider_models as unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  const calls = await q<{
    tool: string;
    status: string;
    chars: number;
    created_at: Date;
    duration_ms: number | null;
    execution_id: string | null;
  }>(
    pool,
    `SELECT tool, status, length(coalesce(result::text, '')) AS chars, created_at, duration_ms,
            result->>'execution_id' AS execution_id
     FROM chat_tool_calls WHERE conversation_id = $1 ORDER BY id`,
    [conv.id],
  );
  const execs = await q<{
    id: number;
    status: string;
    duration_ms: number | null;
    diagnostics: {
      failure?: {
        category: string;
        phase: string;
        last_nested_failure?: { tool: string | null; category: string };
      };
      nested_failures?: unknown[];
    } | null;
  }>(
    pool,
    "SELECT id, status, duration_ms, diagnostics FROM code_executions WHERE conversation_id = $1 ORDER BY id",
    [conv.id],
  );
  const nested = execs.length
    ? await q<{ tool: string; status: string }>(
        pool,
        "SELECT tool, status FROM code_execution_calls WHERE execution_id = ANY($1::bigint[])",
        [execs.map((e) => e.id)],
      )
    : [];
  const execById = new Map(execs.map((e) => [Number(e.id), e]));
  const events: ToolEvent[] = calls.map((c) => {
    const started = new Date(c.created_at).getTime();
    const e = c.execution_id ? execById.get(Number(c.execution_id)) : undefined;
    return {
      tool: c.tool,
      status: c.status,
      started_at: started,
      finished_at: started + Number(c.duration_ms ?? 0),
      ...(e
        ? {
            execution: {
              id: Number(e.id),
              ok: e.status === "ok",
              failure:
                e.diagnostics?.failure ??
                (e.status === "ok" ? null : { category: "unknown", phase: "unknown" }),
              nested_failures: e.diagnostics?.nested_failures?.length ?? 0,
            },
          }
        : {}),
    };
  });
  const codeCalls = await q<{ result: { evidence_status?: string } | null }>(
    pool,
    "SELECT result FROM chat_tool_calls WHERE conversation_id = $1 AND tool = 'code.execute' AND status = 'ok'",
    [conv.id],
  );
  const answer = parseAnswer(reply?.content ?? "");
  const grade = gradeAnswer(expected, answer);
  const n = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));
  return {
    task_id: task.id,
    category: task.category,
    eligible: task.eligible,
    variant,
    repetition,
    provider: o.provider,
    model: o.model ?? null,
    requested_model: attempt?.model ?? o.model ?? null,
    effort: attempt?.effort ?? null,
    provider_models: providerModels,
    model_resolution:
      usage.model_resolution === "provider_reported" && providerModels.length
        ? "provider_reported"
        : "unresolved",
    codeact_offered: offered(),
    turn_status: status,
    correct: grade.correct,
    answered: grade.answered,
    unsupported: grade.unsupported,
    fields: grade.fields,
    sdk_calls: Number(usage.completions ?? prompts.length),
    model_turns: n(usage.model_turns),
    provider_tool_uses: n(usage.provider_tool_uses),
    tool_calls: calls.length,
    integration_calls: calls.filter((c) => c.tool === "tools.call").length,
    codeact_executions: execs.length,
    codeact_failed: execs.filter((e) => e.status !== "ok").length,
    nested_calls: nested.length,
    nested_failures: nested.filter((c) => c.status !== "ok").length,
    codeact_failures: execs
      .filter((e) => e.status !== "ok")
      .map((e) => {
        const f = e.diagnostics?.failure;
        return {
          execution_id: Number(e.id),
          // Rows without a diagnosis (e.g. recorded before diagnostics existed) stay explicitly unknown.
          category: f?.category ?? "unknown",
          phase: f?.phase ?? "unknown",
          ...(f?.last_nested_failure
            ? {
                nested_tool: f.last_nested_failure.tool,
                nested_category: f.last_nested_failure.category,
              }
            : {}),
        };
      }),
    recovery: classifyRecovery(events),
    composed_tools: [...new Set(nested.map((c) => c.tool))].sort(),
    prompt_chars_total: prompts.reduce((a, b) => a + b, 0),
    prompt_chars_max: Math.max(0, ...prompts),
    estimated_prompt_tokens: prompts.reduce((a, b) => a + Math.ceil(b / 4), 0), // same rule as estimateTokens
    tool_result_chars: calls.reduce(
      (a, c) => a + Math.min(Number(c.chars), LIMITS.toolResultChars),
      0,
    ),
    truncated_results: calls.filter((c) => Number(c.chars) > LIMITS.toolResultChars).length,
    input_tokens: n(usage.input_tokens),
    output_tokens: n(usage.output_tokens),
    cache_read_tokens: n(usage.cache_read_tokens),
    cache_creation_tokens: n(usage.cache_creation_tokens),
    input_tokens_total: [
      usage.input_tokens,
      usage.cache_read_tokens,
      usage.cache_creation_tokens,
    ].some((v) => v == null)
      ? null
      : [usage.input_tokens, usage.cache_read_tokens, usage.cache_creation_tokens].reduce<number>(
          (a, v) => a + Number(v),
          0,
        ),
    cost_usd: n(usage.cost_usd),
    provider_ms: Number(usage.provider_ms ?? 0),
    sandbox_ms: execs.reduce((a, e) => a + Number(e.duration_ms ?? 0), 0),
    latency_ms: latency,
    evidence_complete: codeCalls.length
      ? codeCalls.every((c) => c.result?.evidence_status === "complete")
      : null,
  };
}

export interface EvaluationPlan {
  tasks?: string[];
  repetitions: number;
  /** Stop (before the next sample) once known spend reaches this; unknown spend counts against `maxSamples` only. */
  budgetUsd?: number;
  maxSamples?: number;
}

/** Paired A/B over tasks × repetitions; the variant order alternates per repetition. */
export async function runEvaluation(plan: EvaluationPlan, o: RunOptions) {
  const tasks = TASKS.filter((t) => !plan.tasks?.length || plan.tasks.includes(t.id));
  const samples: Sample[] = [];
  let spent = 0;
  let stopped: string | null = null;
  const enabled = config.codeAct.enabled;
  try {
    outer: for (let rep = 0; rep < plan.repetitions; rep++)
      for (const task of tasks) {
        for (const variant of rep % 2 ? [...VARIANTS].reverse() : VARIANTS) {
          if (plan.maxSamples != null && samples.length >= plan.maxSamples) {
            stopped = `sample limit ${plan.maxSamples} reached`;
            break outer;
          }
          if (plan.budgetUsd != null && spent >= plan.budgetUsd) {
            stopped = `budget ${plan.budgetUsd} USD reached (known spend ${spent.toFixed(4)})`;
            break outer;
          }
          const s = await runSample(task, variant, rep, o);
          samples.push(s);
          spent += s.cost_usd ?? 0;
        }
      }
  } finally {
    config.codeAct.enabled = enabled;
    setChatProviders(undefined);
  }
  return { samples, stopped, known_spend_usd: spent };
}

// ------------------------------------------------------------------------------------------------ reporting

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** Mean of paired differences with a deterministic percentile-bootstrap 95% CI (null below 5 pairs). */
function pairedDiff(diffs: number[]) {
  if (!diffs.length) return { n: 0, mean: null, ci95: null };
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const means: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rand() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return {
    n: diffs.length,
    mean: mean(diffs),
    ci95: diffs.length >= 5 ? [means[49], means[1949]] : null,
  };
}
type Metric =
  | "correct"
  | keyof Pick<
      Sample,
      | "sdk_calls"
      | "model_turns"
      | "provider_tool_uses"
      | "tool_calls"
      | "prompt_chars_total"
      | "prompt_chars_max"
      | "tool_result_chars"
      | "latency_ms"
      | "input_tokens"
      | "output_tokens"
      | "cache_read_tokens"
      | "cache_creation_tokens"
      | "input_tokens_total"
      | "cost_usd"
    >;
const METRICS: Metric[] = [
  "correct",
  "sdk_calls",
  "model_turns",
  "provider_tool_uses",
  "tool_calls",
  "prompt_chars_total",
  "prompt_chars_max",
  "tool_result_chars",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "input_tokens_total",
  "cost_usd",
];
/** A metric's value; null = unknown. Verified correctness counts as 1/0 so it can be compared per pair. */
const valueOf = (s: Sample, k: Metric): number | null =>
  k === "correct" ? (s.correct ? 1 : 0) : typeof s[k] === "number" ? (s[k] as number) : null;

/**
 * Whether the A/B comparison is model-matched: every complete pair ran on the same provider-reported model(s) and
 * effort. Unresolved identity is `unverified` (never assumed matched); any difference is `mismatched`.
 */
function modelCheck(samples: Sample[], complete: Array<Record<Variant, Sample>>) {
  const key = (s: Sample) =>
    `${s.provider_models.join("+")}|${s.effort ?? ""}|${s.requested_model ?? ""}`;
  const mismatched = complete
    .filter((p) => key(p.direct) !== key(p.codeact))
    .map((p) => `${p.direct.task_id}#${p.direct.repetition}`);
  const unresolved = samples.filter((s) => s.model_resolution !== "provider_reported").length;
  return {
    status: mismatched.length ? "mismatched" : unresolved ? "unverified" : "matched",
    models: [...new Set(samples.flatMap((s) => s.provider_models))].sort(),
    requested: [...new Set(samples.map((s) => s.requested_model ?? "(account default)"))].sort(),
    efforts: [...new Set(samples.map((s) => s.effort ?? "(default)"))].sort(),
    unresolved_samples: unresolved,
    mismatched_pairs: mismatched,
  } as const;
}

export function summarize(
  samples: Sample[],
  meta: {
    level: "fixture-simulated-provider" | "live-provider";
    sandbox: "os-sandbox" | "plain-process";
    provider: string;
    model: string | null;
  },
) {
  const by = (v: Variant) => samples.filter((s) => s.variant === v);
  const variant = (v: Variant) => {
    const xs = by(v);
    const known = (k: Metric) =>
      xs.map((s) => valueOf(s, k)).filter((x): x is number => typeof x === "number");
    return {
      n: xs.length,
      completed: xs.filter((s) => s.turn_status === "completed").length,
      correct: xs.filter((s) => s.correct).length,
      success_ci95: wilson(xs.filter((s) => s.correct).length, xs.length),
      unsupported_conclusions: xs.reduce((a, s) => a + s.unsupported, 0),
      metrics: Object.fromEntries(
        METRICS.map((k) => {
          const vals = known(k);
          return [k, { known: vals.length, of: xs.length, mean: mean(vals), median: median(vals) }];
        }),
      ),
    };
  };
  const pairs = new Map<string, Partial<Record<Variant, Sample>>>();
  for (const s of samples) {
    const key = `${s.task_id}#${s.repetition}`;
    pairs.set(key, { ...pairs.get(key), [s.variant]: s });
  }
  const complete = [...pairs.values()].filter((p) => p.direct && p.codeact) as Array<
    Record<Variant, Sample>
  >;
  const paired = Object.fromEntries(
    METRICS.map((k) => {
      const diffs = complete
        .filter((p) => valueOf(p.codeact, k) != null && valueOf(p.direct, k) != null)
        .map((p) => valueOf(p.codeact, k)! - valueOf(p.direct, k)!);
      return [k, pairedDiff(diffs)];
    }),
  );
  const perTask = Object.fromEntries(
    [...new Set(samples.map((s) => s.task_id))].map((id) => {
      const xs = samples.filter((s) => s.task_id === id);
      const v = (x: Variant) => xs.filter((s) => s.variant === x);
      return [
        id,
        {
          eligible: xs[0].eligible,
          correct: {
            direct: v("direct").filter((s) => s.correct).length,
            codeact: v("codeact").filter((s) => s.correct).length,
            of: v("direct").length,
          },
          sdk_calls: {
            direct: mean(v("direct").map((s) => s.sdk_calls)),
            codeact: mean(v("codeact").map((s) => s.sdk_calls)),
          },
          model_turns: {
            direct: mean(
              v("direct").flatMap((s) => (s.model_turns == null ? [] : [s.model_turns])),
            ),
            codeact: mean(
              v("codeact").flatMap((s) => (s.model_turns == null ? [] : [s.model_turns])),
            ),
          },
          cost_usd: {
            direct: mean(v("direct").flatMap((s) => (s.cost_usd == null ? [] : [s.cost_usd]))),
            codeact: mean(v("codeact").flatMap((s) => (s.cost_usd == null ? [] : [s.cost_usd]))),
          },
          codeact_used: v("codeact").filter((s) => s.codeact_executions > 0).length,
          prompt_chars_total: {
            direct: mean(v("direct").map((s) => s.prompt_chars_total)),
            codeact: mean(v("codeact").map((s) => s.prompt_chars_total)),
          },
          truncated_results: {
            direct: mean(v("direct").map((s) => s.truncated_results)),
            codeact: mean(v("codeact").map((s) => s.truncated_results)),
          },
        },
      ];
    }),
  );
  const cb = by("codeact");
  const eligible = cb.filter((s) => s.eligible);
  const composed: Record<string, number> = {};
  for (const s of cb) for (const t of s.composed_tools) composed[t] = (composed[t] ?? 0) + 1;
  return {
    meta: {
      ...meta,
      generated_at: new Date().toISOString(),
      variable: "codeAct.enabled (code.execute disclosed and callable) — everything else identical",
      dataset: "src/eval/codeactTasks.ts (10 tasks, deterministic fake incident window)",
      eligibility:
        "two or more deterministic read-only lookups whose results must be combined, or one large result whose useful content is an aggregate",
      notes:
        meta.level === "fixture-simulated-provider"
          ? [
              "SIMULATED PROVIDER: tokens and cost are unknown (null); estimated_prompt_tokens is chars/4, not a provider count.",
              "Adoption is by construction (the policy uses CodeAct for every eligible task when offered).",
              "The policy replays the same reference plan in both variants and never reformulates a query to avoid truncation; truncation effects are an upper bound for a naive direct strategy.",
              "This is NOT a live-model or production result (verification level ≤ 3).",
            ]
          : [
              "LIVE PROVIDER: tokens/cost as reported by the provider; null where it did not report.",
            ],
    },
    samples: samples.length,
    pairs: complete.length,
    model_check: modelCheck(samples, complete),
    variants: { direct: variant("direct"), codeact: variant("codeact") },
    paired_codeact_minus_direct: paired,
    per_task: perTask,
    adoption: {
      eligible_turns: eligible.length,
      eligible_turns_using_codeact: eligible.filter((s) => s.codeact_executions > 0).length,
      eligible_turns_direct_only: eligible.filter(
        (s) => s.codeact_executions === 0 && s.integration_calls > 0,
      ).length,
      ineligible_turns_using_codeact: cb.filter((s) => !s.eligible && s.codeact_executions > 0)
        .length,
      executions: cb.reduce((a, s) => a + s.codeact_executions, 0),
      failed_executions: cb.reduce((a, s) => a + s.codeact_failed, 0),
      failure_categories: cb
        .flatMap((s) => s.codeact_failures)
        .reduce<Record<string, number>>((acc, f) => {
          const k = f.nested_category ? `${f.category}<-${f.nested_category}` : f.category;
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      nested_failures: cb.reduce((a, s) => a + s.nested_failures, 0),
      recovery: (
        [
          "recovery_attempts",
          "recovered",
          "recovery_failed",
          "fallback_direct",
          "abandoned",
          "unknown",
          "nested_failures_in_ok_executions",
        ] as const
      ).reduce<Record<string, number>>((acc, k) => {
        acc[k] = cb.reduce((a, s) => a + s.recovery[k], 0);
        return acc;
      }, {}),
      /** Turns with a failed execution that still ended with a verified-correct answer. */
      failed_but_correct_turns: cb.filter((s) => s.codeact_failed > 0 && s.correct).length,
      composed_tools: composed,
      evidence_complete_turns: cb.filter((s) => s.evidence_complete === true).length,
      evidence_incomplete_turns: cb.filter((s) => s.evidence_complete === false).length,
    },
  };
}
export type EffectReport = ReturnType<typeof summarize>;

const fmt = (v: number | null | undefined, d = 0) => (v == null ? "unknown" : v.toFixed(d));
export function renderMarkdown(r: EffectReport) {
  const row = (k: Metric, d = 0) => {
    const a = r.variants.direct.metrics[k];
    const b = r.variants.codeact.metrics[k];
    const p = r.paired_codeact_minus_direct[k];
    return `| ${k} | ${fmt(a.mean, d)} (${a.known}/${a.of}) | ${fmt(b.mean, d)} (${b.known}/${b.of}) | ${fmt(p.mean, d)} | ${p.ci95 ? `[${fmt(p.ci95[0], d)}, ${fmt(p.ci95[1], d)}]` : "n<5"} |`;
  };
  const ci = (c: ReturnType<typeof wilson>) =>
    c ? `[${c.low.toFixed(2)}, ${c.high.toFixed(2)}]` : "–";
  return [
    `Level: **${r.meta.level}**, ${r.meta.sandbox}, provider ${r.meta.provider}${r.meta.model ? ` / ${r.meta.model}` : ""}; ${r.samples} samples, ${r.pairs} pairs.`,
    "",
    "| | Direct | CodeAct |",
    "|---|---|---|",
    `| completed turns | ${r.variants.direct.completed}/${r.variants.direct.n} | ${r.variants.codeact.completed}/${r.variants.codeact.n} |`,
    `| verified correct | ${r.variants.direct.correct}/${r.variants.direct.n} ${ci(r.variants.direct.success_ci95)} | ${r.variants.codeact.correct}/${r.variants.codeact.n} ${ci(r.variants.codeact.success_ci95)} |`,
    `| unsupported conclusions | ${r.variants.direct.unsupported_conclusions} | ${r.variants.codeact.unsupported_conclusions} |`,
    "",
    "| metric (mean, known/of) | Direct | CodeAct | paired Δ (B−A) | 95% CI |",
    "|---|---|---|---|---|",
    row("correct", 2),
    row("sdk_calls", 2),
    row("model_turns", 2),
    row("provider_tool_uses", 2),
    row("tool_calls", 2),
    row("prompt_chars_total"),
    row("prompt_chars_max"),
    row("tool_result_chars"),
    row("latency_ms"),
    row("input_tokens"),
    row("output_tokens"),
    row("cache_read_tokens"),
    row("cache_creation_tokens"),
    row("input_tokens_total"),
    row("cost_usd", 4),
    "",
    `Model check: **${r.model_check.status === "matched" ? "model-matched" : r.model_check.status === "mismatched" ? "NOT model-matched" : "model identity unverified"}** — provider-reported ${r.model_check.models.join(", ") || "none"}; requested ${r.model_check.requested.join(", ")}; effort ${r.model_check.efforts.join(", ")}; ${r.model_check.unresolved_samples} samples unresolved${r.model_check.mismatched_pairs.length ? `; mismatched pairs ${r.model_check.mismatched_pairs.join(", ")}` : ""}.`,
    "",
    "| task | eligible | correct A | correct B | SDK calls A→B | model turns A→B | cost A→B | CodeAct used (B) | truncated results A→B |",
    "|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(r.per_task).map(
      ([id, t]) =>
        `| ${id} | ${t.eligible ? "yes" : "no"} | ${t.correct.direct}/${t.correct.of} | ${t.correct.codeact}/${t.correct.of} | ${fmt(t.sdk_calls.direct, 1)}→${fmt(t.sdk_calls.codeact, 1)} | ${fmt(t.model_turns.direct, 1)}→${fmt(t.model_turns.codeact, 1)} | ${fmt(t.cost_usd.direct, 4)}→${fmt(t.cost_usd.codeact, 4)} | ${t.codeact_used} | ${fmt(t.truncated_results.direct, 1)}→${fmt(t.truncated_results.codeact, 1)} |`,
    ),
    "",
    `Adoption (CodeAct variant): ${r.adoption.eligible_turns_using_codeact}/${r.adoption.eligible_turns} eligible turns used CodeAct, ${r.adoption.eligible_turns_direct_only} used direct calls only, ${r.adoption.ineligible_turns_using_codeact} ineligible turns used it; ${r.adoption.executions} executions, ${r.adoption.failed_executions} failed (${
      Object.entries(r.adoption.failure_categories)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "none"
    }); after failures: ${r.adoption.recovery.recovery_attempts} recovery attempts, ${r.adoption.recovery.recovered} recovered, ${r.adoption.recovery.fallback_direct} fell back to direct tools, ${r.adoption.recovery.abandoned + r.adoption.recovery.recovery_failed} abandoned, ${r.adoption.recovery.unknown} unknown; ${r.adoption.failed_but_correct_turns} turns with a failed execution still answered correctly; evidence complete in ${r.adoption.evidence_complete_turns} turns, incomplete in ${r.adoption.evidence_incomplete_turns}.`,
    "",
    ...r.meta.notes.map((n) => `- ${n}`),
  ].join("\n");
}
