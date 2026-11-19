/**
 * Token benchmark efficiency metrics per successful task.
 *
 * Aggregates measured telemetry from `execution_attempt_telemetry`, `workflow_step_attempts`,
 * and `workflow_runs`:
 *   - Total input, output and cache tokens per successful task
 *   - First-pass success rate (tasks that completed without retries)
 *   - Retry overhead (token consumption and attempts from retried executions)
 *   - Wasted tokens from failed attempts
 *   - Grouped by provider, model and execution profile
 *   - Distinguishes missing usage (null / unavailable) from zero usage (0 reported).
 *
 * Reuse existing telemetry and aggregation logic. No LLM calls or external dashboard frameworks.
 */
import { pool, q, type Db } from "../db/pool.ts";

export type UsageAvailability = "complete" | "partial" | "unavailable" | "none";

export interface TokenTotals {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  cache: number | null;
  total: number | null;
}

export interface AttemptTelemetryRow {
  run_id: number;
  run_profile?: string | null;
  run_status?: string | null;
  execution_profile?: string | null;
  provider: string | null;
  model: string | null;
  attempt_id?: number | null;
  step_id?: number | null;
  number?: number | null;
  retries?: number | null;
  status: string;
  terminal_status?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  reasoning_tokens?: number | null;
  wall_duration_ms?: number | null;
  delta?: boolean | null;
  peak_occupancy?: number | null;
  compactions?: number | null;
  tool_calls?: number | null;
  start_time?: Date | string | null;
}

export interface TaskEfficiencySummary {
  provider: string;
  model: string;
  execution_profile: string;

  // Task-level counts
  total_tasks: number;
  successful_tasks: number;
  failed_tasks: number;
  first_pass_successes: number;

  // Rates (0 to 1 ratio; null when denominator is 0)
  success_rate: number | null;
  first_pass_success_rate: number | null;

  // Attempt counts
  attempts: number;
  attempts_with_usage: number;
  attempts_missing_usage: number;
  attempts_zero_usage: number;
  usage_availability: UsageAvailability;

  // Efficiency metrics per successful task
  successful_tasks_with_usage: number;
  successful_tasks_missing_usage: number;
  total_input_tokens_per_successful_task: number | null;
  total_output_tokens_per_successful_task: number | null;
  total_cache_tokens_per_successful_task: number | null;
  total_tokens_per_successful_task: number | null;

  // Medians per successful task
  median_input_tokens_per_successful_task: number | null;
  median_output_tokens_per_successful_task: number | null;
  median_cache_tokens_per_successful_task: number | null;
  median_total_tokens_per_successful_task: number | null;

  // Sums across successful tasks with reported usage
  successful_task_tokens: TokenTotals;

  // Retry overhead
  retry_overhead: {
    retry_attempts: number;
    retried_tasks: number;
    tokens: TokenTotals;
    tokens_per_task: number | null;
    tokens_per_successful_task: number | null;
    retry_overhead_ratio: number | null;
  };
  retry_overhead_tokens: number | null;
  retry_overhead_ratio: number | null;
  retry_attempts: number;

  // Wasted tokens from failed attempts
  wasted_tokens_from_failed_attempts: {
    failed_attempts: number;
    failed_attempts_with_usage: number;
    failed_attempts_missing_usage: number;
    tokens: TokenTotals;
    wasted_ratio: number | null;
  };
  wasted_input_tokens: number | null;
  wasted_output_tokens: number | null;
  wasted_cache_tokens: number | null;
  wasted_tokens: number | null;
  failed_attempts: number;
}

export const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

export const round = (n: number, d = 4): number => {
  const factor = 10 ** d;
  return Math.round(n * factor) / factor;
};

/**
 * Computes cache tokens for an attempt or aggregated bucket.
 * Distinguishes missing usage (null) from zero usage (0).
 * If both cache_read and cache_creation are null, returns null.
 * If one or both are numbers, returns their sum (treating the null one as 0).
 */
export function combineCacheTokens(
  read: number | null | undefined,
  creation: number | null | undefined,
): number | null {
  if (read == null && creation == null) return null;
  return Number(read ?? 0) + Number(creation ?? 0);
}

/**
 * Computes total tokens (input + output + cache).
 * Returns null if all are null.
 */
export function combineTotalTokens(
  input: number | null | undefined,
  output: number | null | undefined,
  cache: number | null | undefined,
): number | null {
  if (input == null && output == null && cache == null) return null;
  return Number(input ?? 0) + Number(output ?? 0) + Number(cache ?? 0);
}

interface TaskAccumulator {
  runId: number;
  runStatus: string;
  attempts: AttemptTelemetryRow[];
  hasRetry: boolean;
  hasFailedAttempt: boolean;
  isSuccessful: boolean;
  isFirstPass: boolean;
  tokens: {
    input: number | null;
    output: number | null;
    cache_read: number | null;
    cache_creation: number | null;
    cache: number | null;
    total: number | null;
    hasReportedUsage: boolean;
    hasMissingUsage: boolean;
  };
}

/** Pure aggregation: computes efficiency metrics per successful task, grouped by provider, model, execution_profile. */
export function aggregateTokenEfficiency(rows: AttemptTelemetryRow[]): TaskEfficiencySummary[] {
  // 1. Group rows by provider | model | execution_profile
  const groups = new Map<string, AttemptTelemetryRow[]>();
  for (const r of rows) {
    const provider = r.provider ?? "unknown";
    const model = r.model ?? "unknown";
    const profile = r.execution_profile ?? r.run_profile ?? "unknown";
    const key = `${provider}|${model}|${profile}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const results: TaskEfficiencySummary[] = [];

  for (const [key, groupRows] of groups.entries()) {
    const [provider, model, execution_profile] = key.split("|");

    // Attempt-level counters
    let attemptsWithUsage = 0;
    let attemptsMissingUsage = 0;
    let attemptsZeroUsage = 0;

    for (const r of groupRows) {
      if (r.input_tokens != null || r.output_tokens != null) {
        attemptsWithUsage++;
        const total = combineTotalTokens(
          r.input_tokens,
          r.output_tokens,
          combineCacheTokens(r.cache_read_tokens, r.cache_creation_tokens),
        );
        if (total === 0) attemptsZeroUsage++;
      } else {
        attemptsMissingUsage++;
      }
    }

    const usageAvailability: UsageAvailability =
      groupRows.length === 0
        ? "none"
        : attemptsWithUsage === 0
          ? "unavailable"
          : attemptsMissingUsage > 0
            ? "partial"
            : "complete";

    // 2. Group into distinct tasks (runs) within this provider/model/profile slice
    const taskMap = new Map<number, TaskAccumulator>();
    for (const r of groupRows) {
      let acc = taskMap.get(r.run_id);
      if (!acc) {
        acc = {
          runId: r.run_id,
          runStatus: r.run_status ?? "UNKNOWN",
          attempts: [],
          hasRetry: false,
          hasFailedAttempt: false,
          isSuccessful: false,
          isFirstPass: false,
          tokens: {
            input: null,
            output: null,
            cache_read: null,
            cache_creation: null,
            cache: null,
            total: null,
            hasReportedUsage: false,
            hasMissingUsage: false,
          },
        };
        taskMap.set(r.run_id, acc);
      }
      acc.attempts.push(r);
      if ((r.number != null && r.number > 1) || (r.retries != null && r.retries > 0)) {
        acc.hasRetry = true;
      }
      if (r.status === "FAILED" || r.terminal_status === "FAILED") {
        acc.hasFailedAttempt = true;
      }
    }

    // Evaluate each task
    for (const task of taskMap.values()) {
      // Success condition: run_status === 'COMPLETED' or (if run_status absent, attempts completed without failure)
      task.isSuccessful =
        task.runStatus === "COMPLETED" ||
        (task.runStatus === "UNKNOWN" &&
          task.attempts.some((a) => a.status === "COMPLETED") &&
          !task.hasFailedAttempt);

      // First-pass success: succeeded on pass 1 with no retries and no failed attempts
      task.isFirstPass = task.isSuccessful && !task.hasRetry && !task.hasFailedAttempt;

      // Sum tokens across attempts for this task, strictly distinguishing missing from zero usage
      let taskInput: number | null = null;
      let taskOutput: number | null = null;
      let taskCacheRead: number | null = null;
      let taskCacheCreation: number | null = null;
      let hasReported = false;
      let hasMissing = false;

      for (const a of task.attempts) {
        if (a.input_tokens != null) {
          taskInput = (taskInput ?? 0) + Number(a.input_tokens);
          hasReported = true;
        } else {
          hasMissing = true;
        }
        if (a.output_tokens != null) {
          taskOutput = (taskOutput ?? 0) + Number(a.output_tokens);
          hasReported = true;
        }
        if (a.cache_read_tokens != null) {
          taskCacheRead = (taskCacheRead ?? 0) + Number(a.cache_read_tokens);
          hasReported = true;
        }
        if (a.cache_creation_tokens != null) {
          taskCacheCreation = (taskCacheCreation ?? 0) + Number(a.cache_creation_tokens);
          hasReported = true;
        }
      }

      const taskCache = combineCacheTokens(taskCacheRead, taskCacheCreation);
      const taskTotal = combineTotalTokens(taskInput, taskOutput, taskCache);

      task.tokens = {
        input: taskInput,
        output: taskOutput,
        cache_read: taskCacheRead,
        cache_creation: taskCacheCreation,
        cache: taskCache,
        total: taskTotal,
        hasReportedUsage: hasReported,
        hasMissingUsage: hasMissing,
      };
    }

    const tasks = [...taskMap.values()];
    const totalTasks = tasks.length;
    const successfulTasks = tasks.filter((t) => t.isSuccessful);
    const failedTasks = tasks.filter((t) => !t.isSuccessful);
    const firstPassTasks = tasks.filter((t) => t.isFirstPass);

    const successRate = totalTasks ? round(successfulTasks.length / totalTasks) : null;
    const firstPassSuccessRate = totalTasks ? round(firstPassTasks.length / totalTasks) : null;

    // Tokens per successful task
    const successfulWithUsage = successfulTasks.filter((t) => t.tokens.hasReportedUsage);
    const successfulMissingUsage = successfulTasks.filter((t) => !t.tokens.hasReportedUsage);

    let sumSuccInput: number | null = null;
    let sumSuccOutput: number | null = null;
    let sumSuccCacheRead: number | null = null;
    let sumSuccCacheCreation: number | null = null;
    let sumSuccCache: number | null = null;
    let sumSuccTotal: number | null = null;

    if (successfulWithUsage.length > 0) {
      sumSuccInput = 0;
      sumSuccOutput = 0;
      sumSuccCacheRead = 0;
      sumSuccCacheCreation = 0;
      sumSuccCache = 0;
      sumSuccTotal = 0;

      for (const t of successfulWithUsage) {
        if (t.tokens.input != null) sumSuccInput += t.tokens.input;
        if (t.tokens.output != null) sumSuccOutput += t.tokens.output;
        if (t.tokens.cache_read != null) sumSuccCacheRead += t.tokens.cache_read;
        if (t.tokens.cache_creation != null) sumSuccCacheCreation += t.tokens.cache_creation;
        if (t.tokens.cache != null) sumSuccCache += t.tokens.cache;
        if (t.tokens.total != null) sumSuccTotal += t.tokens.total;
      }
    }

    const nSuccWithUsage = successfulWithUsage.length;
    const avgInputPerSucc =
      nSuccWithUsage > 0 && sumSuccInput != null ? round(sumSuccInput / nSuccWithUsage, 2) : null;
    const avgOutputPerSucc =
      nSuccWithUsage > 0 && sumSuccOutput != null ? round(sumSuccOutput / nSuccWithUsage, 2) : null;
    const avgCachePerSucc =
      nSuccWithUsage > 0 && sumSuccCache != null ? round(sumSuccCache / nSuccWithUsage, 2) : null;
    const avgTotalPerSucc =
      nSuccWithUsage > 0 && sumSuccTotal != null ? round(sumSuccTotal / nSuccWithUsage, 2) : null;

    // Medians per successful task
    const medInputPerSucc = median(
      successfulWithUsage.map((t) => t.tokens.input).filter((x): x is number => x != null),
    );
    const medOutputPerSucc = median(
      successfulWithUsage.map((t) => t.tokens.output).filter((x): x is number => x != null),
    );
    const medCachePerSucc = median(
      successfulWithUsage.map((t) => t.tokens.cache).filter((x): x is number => x != null),
    );
    const medTotalPerSucc = median(
      successfulWithUsage.map((t) => t.tokens.total).filter((x): x is number => x != null),
    );

    // 3. Retry overhead: attempts where number > 1 or retries > 0
    const retryAttemptsList = groupRows.filter(
      (a) => (a.number != null && a.number > 1) || (a.retries != null && a.retries > 0),
    );
    const retriedTasksCount = new Set(retryAttemptsList.map((a) => a.run_id)).size;

    let retryInput: number | null = null;
    let retryOutput: number | null = null;
    let retryCacheRead: number | null = null;
    let retryCacheCreation: number | null = null;
    let retryHasUsage = false;

    if (retryAttemptsList.length === 0) {
      // Exactly 0 retries occurred -> 0 retry tokens overhead
      retryInput = 0;
      retryOutput = 0;
      retryCacheRead = 0;
      retryCacheCreation = 0;
      retryHasUsage = true;
    } else {
      for (const a of retryAttemptsList) {
        if (a.input_tokens != null) {
          retryInput = (retryInput ?? 0) + Number(a.input_tokens);
          retryHasUsage = true;
        }
        if (a.output_tokens != null) {
          retryOutput = (retryOutput ?? 0) + Number(a.output_tokens);
          retryHasUsage = true;
        }
        if (a.cache_read_tokens != null) {
          retryCacheRead = (retryCacheRead ?? 0) + Number(a.cache_read_tokens);
          retryHasUsage = true;
        }
        if (a.cache_creation_tokens != null) {
          retryCacheCreation = (retryCacheCreation ?? 0) + Number(a.cache_creation_tokens);
          retryHasUsage = true;
        }
      }
    }

    const retryCache = retryHasUsage
      ? combineCacheTokens(retryCacheRead, retryCacheCreation)
      : null;
    const retryTotal = retryHasUsage
      ? combineTotalTokens(retryInput, retryOutput, retryCache)
      : null;

    // Total tokens across all attempts in this group (for ratio calculation)
    let allTokensSum: number | null = null;
    for (const a of groupRows) {
      const tot = combineTotalTokens(
        a.input_tokens,
        a.output_tokens,
        combineCacheTokens(a.cache_read_tokens, a.cache_creation_tokens),
      );
      if (tot != null) allTokensSum = (allTokensSum ?? 0) + tot;
    }

    const retryOverheadRatio =
      retryTotal != null && allTokensSum != null && allTokensSum > 0
        ? round(retryTotal / allTokensSum, 4)
        : retryAttemptsList.length === 0
          ? 0
          : null;

    const retryTokensPerTask =
      retryTotal != null && totalTasks > 0 ? round(retryTotal / totalTasks, 2) : null;
    const retryTokensPerSucc =
      retryTotal != null && successfulTasks.length > 0
        ? round(retryTotal / successfulTasks.length, 2)
        : null;

    // 4. Wasted tokens from failed attempts: status === 'FAILED' or terminal_status === 'FAILED'
    const failedAttemptsList = groupRows.filter(
      (a) => a.status === "FAILED" || a.terminal_status === "FAILED",
    );
    let wastedInput: number | null = null;
    let wastedOutput: number | null = null;
    let wastedCacheRead: number | null = null;
    let wastedCacheCreation: number | null = null;
    let failedHasUsage = false;
    let failedAttemptsWithUsage = 0;
    let failedAttemptsMissingUsage = 0;

    if (failedAttemptsList.length === 0) {
      // 0 failed attempts -> 0 wasted tokens
      wastedInput = 0;
      wastedOutput = 0;
      wastedCacheRead = 0;
      wastedCacheCreation = 0;
      failedHasUsage = true;
    } else {
      for (const a of failedAttemptsList) {
        if (a.input_tokens != null || a.output_tokens != null) {
          failedAttemptsWithUsage++;
          failedHasUsage = true;
          if (a.input_tokens != null) wastedInput = (wastedInput ?? 0) + Number(a.input_tokens);
          if (a.output_tokens != null) wastedOutput = (wastedOutput ?? 0) + Number(a.output_tokens);
          if (a.cache_read_tokens != null)
            wastedCacheRead = (wastedCacheRead ?? 0) + Number(a.cache_read_tokens);
          if (a.cache_creation_tokens != null)
            wastedCacheCreation = (wastedCacheCreation ?? 0) + Number(a.cache_creation_tokens);
        } else {
          failedAttemptsMissingUsage++;
        }
      }
    }

    const wastedCache = failedHasUsage
      ? combineCacheTokens(wastedCacheRead, wastedCacheCreation)
      : null;
    const wastedTotal = failedHasUsage
      ? combineTotalTokens(wastedInput, wastedOutput, wastedCache)
      : null;

    const wastedRatio =
      wastedTotal != null && allTokensSum != null && allTokensSum > 0
        ? round(wastedTotal / allTokensSum, 4)
        : failedAttemptsList.length === 0
          ? 0
          : null;

    results.push({
      provider,
      model,
      execution_profile,

      total_tasks: totalTasks,
      successful_tasks: successfulTasks.length,
      failed_tasks: failedTasks.length,
      first_pass_successes: firstPassTasks.length,

      success_rate: successRate,
      first_pass_success_rate: firstPassSuccessRate,

      attempts: groupRows.length,
      attempts_with_usage: attemptsWithUsage,
      attempts_missing_usage: attemptsMissingUsage,
      attempts_zero_usage: attemptsZeroUsage,
      usage_availability: usageAvailability,

      successful_tasks_with_usage: nSuccWithUsage,
      successful_tasks_missing_usage: successfulMissingUsage.length,
      total_input_tokens_per_successful_task: avgInputPerSucc,
      total_output_tokens_per_successful_task: avgOutputPerSucc,
      total_cache_tokens_per_successful_task: avgCachePerSucc,
      total_tokens_per_successful_task: avgTotalPerSucc,

      median_input_tokens_per_successful_task: medInputPerSucc,
      median_output_tokens_per_successful_task: medOutputPerSucc,
      median_cache_tokens_per_successful_task: medCachePerSucc,
      median_total_tokens_per_successful_task: medTotalPerSucc,

      successful_task_tokens: {
        input: sumSuccInput,
        output: sumSuccOutput,
        cache_read: sumSuccCacheRead,
        cache_creation: sumSuccCacheCreation,
        cache: sumSuccCache,
        total: sumSuccTotal,
      },

      retry_overhead: {
        retry_attempts: retryAttemptsList.length,
        retried_tasks: retriedTasksCount,
        tokens: {
          input: retryInput,
          output: retryOutput,
          cache_read: retryCacheRead,
          cache_creation: retryCacheCreation,
          cache: retryCache,
          total: retryTotal,
        },
        tokens_per_task: retryTokensPerTask,
        tokens_per_successful_task: retryTokensPerSucc,
        retry_overhead_ratio: retryOverheadRatio,
      },
      retry_overhead_tokens: retryTotal,
      retry_overhead_ratio: retryOverheadRatio,
      retry_attempts: retryAttemptsList.length,

      wasted_tokens_from_failed_attempts: {
        failed_attempts: failedAttemptsList.length,
        failed_attempts_with_usage: failedAttemptsWithUsage,
        failed_attempts_missing_usage: failedAttemptsMissingUsage,
        tokens: {
          input: wastedInput,
          output: wastedOutput,
          cache_read: wastedCacheRead,
          cache_creation: wastedCacheCreation,
          cache: wastedCache,
          total: wastedTotal,
        },
        wasted_ratio: wastedRatio,
      },
      wasted_input_tokens: wastedInput,
      wasted_output_tokens: wastedOutput,
      wasted_cache_tokens: wastedCache,
      wasted_tokens: wastedTotal,
      failed_attempts: failedAttemptsList.length,
    });
  }

  // Stable sort by provider, model, execution_profile
  return results.sort((a, b) =>
    a.provider !== b.provider
      ? a.provider.localeCompare(b.provider)
      : a.model !== b.model
        ? a.model.localeCompare(b.model)
        : a.execution_profile.localeCompare(b.execution_profile),
  );
}

/**
 * Loads measured telemetry from PostgreSQL execution_attempt_telemetry view
 * joined with workflow_step_attempts and workflow_runs, and aggregates
 * efficiency metrics grouped by provider, model, execution_profile.
 */
export async function loadTokenEfficiency(days = 14, db: Db = pool) {
  const attempts = await q<AttemptTelemetryRow>(
    db,
    `SELECT r.id AS run_id,
            r.profile AS run_profile,
            r.status AS run_status,
            COALESCE(t.execution_profile, r.profile, 'unknown') AS execution_profile,
            COALESCE(t.provider, 'unknown') AS provider,
            COALESCE(t.model, 'unknown') AS model,
            a.id AS attempt_id,
            a.step_id,
            COALESCE(a.number, 1) AS number,
            t.retries,
            t.status AS status,
            t.terminal_status,
            t.input_tokens,
            t.output_tokens,
            t.cache_read_tokens,
            t.cache_creation_tokens,
            t.reasoning_tokens,
            t.wall_duration_ms,
            (a.metrics ? 'context_delivery') AS delta,
            (a.metrics->'context_window'->>'peak_tokens')::bigint AS peak_occupancy,
            COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(a.metrics->'compactions') = 'array' THEN a.metrics->'compactions' END), 0) AS compactions,
            (SELECT sum(v::numeric) FROM jsonb_each_text(CASE WHEN jsonb_typeof(t.tool_calls) = 'object' THEN t.tool_calls ELSE '{}'::jsonb END) x(k, v))::int AS tool_calls
       FROM execution_attempt_telemetry t
       JOIN workflow_step_attempts a ON a.id = t.attempt_id
       JOIN workflow_runs r ON r.id = a.run_id
      WHERE t.start_time > now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id = r.id)
      ORDER BY t.start_time ASC, t.attempt_id ASC`,
    [days],
  );

  return aggregateTokenEfficiency(attempts);
}
