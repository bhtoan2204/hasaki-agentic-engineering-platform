import { requireRunRepositoryAccess } from "../../repos/access.ts";
import { createHash } from "node:crypto";
import {
  investigationCorrelate,
  investigationLatency,
  investigationParse,
  investigationReport,
} from "../../investigation/steps.ts";
import { approvedScopeFrom } from "../../agent/evidence.ts";
import { executeBenchmarkCase } from "../../eval/runner.ts";
import { hybridRank } from "../../codeIntelligence/search.ts";
import { spawn } from "node:child_process";
import { config, codeIntelligenceEnabled } from "../../config.ts";
import { pool, q } from "../../db/pool.ts";
import { prepareWorkspace, gitProviderFor, subtaskWorkspacesOf, workspaceBase, workspacesOf } from "../../git/provider.ts";
import { mergeBranchInto, worktreePorcelain } from "../../git.ts";
import { bwrapArguments, commandProcessEnv } from "../../platform/selfDevelopment.ts";
import {
  repositoryReference,
  repositoryBaseBranch,
  isAmbiguous,
  repositories,
  type RankedRepository,
  type RepositoryRow,
} from "../../repos/service.ts";
import { getPath } from "../graph.ts";
import { classify, goBaseline, knownBaseFailures, parseGoTest } from "./baseline.ts";
import { childGroups } from "../local.ts";
import { askAboutFailure, handleDecision, type Diagnosis } from "./testFailure.ts";
import {
  dirtyOf,
  headOf,
  verificationGate,
  type PublishState,
} from "../../agent/independentReview.ts";
import { collectScopeState, prePublishProblems, samePatch } from "../../agent/scopeGuard.ts";
import { feedbackSignals } from "../replan.ts";
import type { ExecResult } from "../types.ts";
import type { ExecutionContext, StepExecutor } from "./registry.ts";

// ---------------------------------------------------------------- human_input

/** Asks the configured questions; answering them completes the step with the answers as output. */
export const humanInputExecutor: StepExecutor = {
  async execute(ctx) {
    const qs =
      (ctx.step.config.questions as Array<{
        question: string;
        context?: string;
        options?: string[];
      }>) ?? [];
    if (!qs.length)
      return {
        kind: "failed",
        error: "human_input step has no config.questions",
        retryable: false,
      };
    return { kind: "waiting_input", questions: qs };
  },
};

// ---------------------------------------------------------------- human_approval

export const humanApprovalExecutor: StepExecutor = {
  async execute(ctx) {
    const cfg = ctx.step.config;
    const shown = Object.fromEntries(
      ((cfg.show_outputs as string[]) ?? []).map((k) => [k, ctx.input.upstream[k]?.output ?? null]),
    );
    const request: Record<string, unknown> = {
      message: cfg.message ?? `Approve "${ctx.step.name}"?`,
      outputs: shown,
    };
    // Evidence-gated approval: freeze the exact proposal being approved (hash + changes + risk + assumptions) in the
    // request, so the decision records what was approved even if the proposal is re-executed later.
    if (typeof cfg.approve_scope_from === "string") {
      const scope = approvedScopeFrom(
        cfg.approve_scope_from,
        ctx.input.upstream[cfg.approve_scope_from]?.output,
      );
      if (scope)
        Object.assign(request, {
          scope,
          requires_risk_acknowledgement: scope.gate ? !scope.gate.satisfied : scope.risk === "HIGH",
        });
    }
    if (cfg.select_repositories) {
      const discovery = Object.values(ctx.input.upstream).find((u) =>
        Array.isArray(u.output?.candidates),
      )?.output;
      // Repositories already chosen for the run: selected at creation, or passed as the `repositories` run input
      // (an array, or a comma-separated string from the API); only ones the run is allowed to touch.
      const raw = ctx.input.run.inputs?.repositories;
      const fromInput = (
        Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : []
      )
        .map((r) => r.trim())
        .filter(Boolean);
      const preselected = (
        ctx.run.selected_repositories.length ? ctx.run.selected_repositories : fromInput
      ).filter((r) => ctx.run.allowed_repositories.includes(r));
      // After feedback-driven rediscovery the scope is the developer's call again: never auto-approve.
      const rediscovered = !!discovery?.rediscovered;
      if (cfg.auto_approve_preselected && preselected.length && !rediscovered)
        return {
          kind: "completed",
          output: {
            approved: true,
            auto: true,
            repositories: preselected,
            selected_repositories: preselected,
          },
        };
      const recommended: string[] = discovery?.recommended ?? preselected;
      if (cfg.ask_branch) {
        const inputs = ctx.input.run.inputs ?? {};
        Object.assign(request, {
          ask_branch: true,
          branch: typeof inputs.branch === "string" ? inputs.branch : "",
          branches: inputs.branches && typeof inputs.branches === "object" ? inputs.branches : {},
        });
      }
      Object.assign(request, {
        select_repositories: true,
        candidates:
          discovery?.candidates ??
          ctx.run.allowed_repositories.map((r) => ({ repo: r, score: 0, reasons: [] })),
        recommended,
        ambiguous: discovery?.ambiguous ?? true,
        allowed: ctx.run.allowed_repositories,
      });
      if (
        cfg.auto_approve_unambiguous &&
        discovery &&
        !discovery.ambiguous &&
        !rediscovered &&
        recommended.length
      )
        return {
          kind: "completed",
          output: {
            approved: true,
            auto: true,
            repositories: recommended,
            selected_repositories: recommended,
          },
        };
    }
    return { kind: "waiting_approval", request };
  },
};

// ---------------------------------------------------------------- condition

const OPS: Record<string, (a: unknown, b: unknown) => boolean> = {
  eq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  ne: (a, b) => JSON.stringify(a) !== JSON.stringify(b),
  gt: (a, b) => Number(a) > Number(b),
  lt: (a, b) => Number(a) < Number(b),
  exists: (a) => a !== undefined && a !== null,
  truthy: (a) => Boolean(a) && !(Array.isArray(a) && a.length === 0),
  contains: (a, b) => (Array.isArray(a) ? a.includes(b) : String(a ?? "").includes(String(b))),
};

/** Pure evaluation over {upstream, inputs, run}: `config = { path: "upstream.review.output.approved", op: "eq", value: true }`. */
export function evaluateCondition(cfg: Record<string, any>, scope: Record<string, unknown>) {
  const op = OPS[cfg.op ?? "truthy"];
  if (!op) throw new Error(`unknown condition op "${cfg.op}"`);
  const value = getPath(scope, cfg.path);
  return { result: op(value, cfg.value), value };
}

export const conditionExecutor: StepExecutor = {
  async execute(ctx) {
    const scope = {
      upstream: ctx.input.upstream,
      inputs: ctx.input.run.inputs,
      run: ctx.input.run,
      work_item: ctx.input.work_item,
    };
    return { kind: "completed", output: evaluateCondition(ctx.step.config, scope) };
  },
};

// ---------------------------------------------------------------- command

export async function runCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
) {
  const proc = await commandProcessEnv(cwd, env);
  const useBwrap = proc.isolation?.mode === "bwrap";
  return new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolve) => {
    const child = spawn(
      useBwrap ? "bwrap" : "bash",
      useBwrap
        ? [...bwrapArguments(cwd, proc.isolation?.liveRoot ?? null), "bash", "-lc", command]
        : ["-lc", command],
      {
        cwd,
        env: proc.isolation?.replaceEnv ? proc.env : { ...process.env, ...proc.env },
        signal,
        detached: true,
      },
    );
    // Kill the whole process group (bash + go test + test binaries) on abort/timeout, not only bash.
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // ignore errors when child process group is already terminated
      }
    };
    signal.addEventListener("abort", killTree, { once: true });
    if (child.pid) childGroups.add(child.pid);
    let output = "";
    const cap = 512 * 1024;
    let pending = "";
    const flush = () => {
      if (pending && onChunk) onChunk(pending);
      pending = "";
    };
    const ticker = setInterval(flush, 1500);
    const add = (b: Buffer) => {
      const s = b.toString("utf8");
      if (output.length < cap) output += s;
      if (pending.length < 64 * 1024) pending += s;
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.on("error", (e) => {
      output += `\n[spawn error] ${e.message}`;
    });
    child.on("close", (code) => {
      if (child.pid) childGroups.remove(child.pid);
      clearTimeout(t);
      clearInterval(ticker);
      flush();
      resolve({
        code,
        output: output.length >= cap ? output + "\n[output truncated]" : output,
        timedOut,
      });
    });
  });
}

/**
 * Runs `config.command` in every workspace of the run (or `config.cwd`). Definitions are platform-authored
 * (trusted); commands never run in the primary checkouts because workspaces are always worktrees.
 */
export const commandExecutor: StepExecutor = {
  async execute(ctx) {
    // Per-attempt overrides (e.g. "retry with baseline comparison") arrive through pending input.
    const cfg = { ...ctx.step.config, ...(ctx.input.pending?.config_overrides ?? {}) };
    // Interactive failure handling (default for test steps with baseline comparison): ask the developer instead of failing.
    const interactive = String(cfg.on_failure ?? (cfg.baseline_compare ? "ask" : "fail")) === "ask";
    let decision: any = null;
    const resumed = ctx.input.pending?.resume;
    const priorDiagnosis = resumed?.checkpoint?.test_failure as Diagnosis | undefined;
    if (interactive && priorDiagnosis && resumed?.from_attempt_id) {
      const r = await handleDecision(ctx, priorDiagnosis, resumed.from_attempt_id);
      if (r.result) return r.result;
      decision = r.decision; // rerun: execute the tests again below, in this new attempt
    }
    const timeoutMs = Number(cfg.timeout_seconds ?? 600) * 1000;
    const targets = cfg.cwd
      ? [{ repo: "(cwd)", path: String(cfg.cwd), branch: ctx.run.branch }]
      : await workspacesOf(ctx.run.id);
    if (!targets.length) {
      // Nothing was changed (e.g. the coding step concluded the fix already exists): nothing to test.
      if (cfg.require_workspace)
        return {
          kind: "failed",
          error: "no workspace to run in: no coding step prepared a worktree for this run",
          retryable: false,
        };
      await ctx.log(
        "system",
        "skipped: this run has no worktree (no code was changed), so there is nothing to run the command in",
      );
      return {
        kind: "completed",
        output: {
          skipped: true,
          passed: true,
          reason: "no code changes in this run (no worktree)",
          results: [],
        },
      };
    }
    // Reusable test evidence: the exact same command + config on exactly the same, clean commits already PASSED in an
    // earlier attempt of this step → do not rerun the suite. Never reused: dirty worktrees (tests saw uncommitted content),
    // any failure or human-accepted exception (baseline handling cannot hide a regression), a resume/decision flow, or
    // an explicit human re-run.
    const commandHash = createHash("sha256")
      .update(
        JSON.stringify([
          cfg.command,
          cfg.cwd ?? null,
          cfg.baseline_compare ?? null,
          cfg.timeout_seconds ?? null,
          cfg.env ?? null,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
    const nowHeads: Record<string, string> = {};
    let clean = !cfg.cwd;
    for (const t of targets)
      if (t.repo !== "(cwd)") {
        nowHeads[t.repo] = await headOf(t.path).catch(() => "");
        if (!nowHeads[t.repo] || (await dirtyOf(t.path))) clean = false;
      }
    const humanRerun = !!(
      ctx.input.pending?.reexecute ||
      ctx.input.pending?.feedback ||
      resumed ||
      decision
    );
    if (clean && !humanRerun && cfg.reuse_test_evidence !== false) {
      const prior = await q<{ id: number; output: any }>(
        pool,
        "SELECT id, output FROM workflow_step_attempts WHERE step_id = $1 AND status = 'COMPLETED' AND output->>'command_hash' = $2 ORDER BY id DESC LIMIT 5",
        [ctx.step.id, commandHash],
      );
      const same = prior.find(
        (p) =>
          p.output?.passed === true &&
          !p.output?.decision &&
          p.output?.tested_clean === true &&
          JSON.stringify(Object.entries(p.output?.tested_heads ?? {}).sort()) ===
            JSON.stringify(Object.entries(nowHeads).sort()),
      );
      if (same) {
        await ctx.log(
          "system",
          `tests not re-run: attempt #${same.id} already passed "${String(cfg.command).slice(0, 120)}" on exactly these clean commits (${Object.entries(
            nowHeads,
          )
            .map(([r, h]) => `${r}@${h.slice(0, 12)}`)
            .join(", ")})`,
        );
        return {
          kind: "completed",
          output: {
            ...same.output,
            reused_from_attempt: same.id,
            reused_at: new Date().toISOString(),
          },
        };
      }
    }
    const results: Array<{
      repo: string;
      exit_code: number | null;
      timed_out: boolean;
      artifact_id: number;
      baseline?: any;
      passed?: boolean;
    }> = [];
    const outputs: Record<string, string> = {};
    for (const t of targets) {
      const baseBranch = await repositoryBaseBranch(t.repo);
      await ctx.log("system", `▶ ${t.repo}: running command in ${t.path}`);
      const started = Date.now();
      // Skipping known base failures continues past them without confirmation: opt-in in interactive mode.
      const skipKnown = cfg.skip_known_base_failures ?? !interactive;
      const known =
        cfg.baseline_compare === "go" && skipKnown ? await knownBaseFailures(t.path) : null;
      if (known?.skipRegex)
        await ctx.log(
          "system",
          `skipping ${known.tests.length} test(s) known to fail on ${baseBranch}@${known.sha.slice(0, 9)}: ${known.tests.join(", ")}`,
          { skipped_known_failures: known.tests },
        );
      let r: { code: number | null; output: string; timedOut: boolean };
      try {
        const plan = await commandProcessEnv(t.path, {});
        if (plan.isolation?.mode === "bwrap")
          await ctx.log(
            "system",
            `${t.repo}: self-development command is sandboxed; the running checkout is read-only and the application database is not in the environment`,
          );
        else if (plan.isolation?.mode === "trusted")
          await ctx.log(
            "system",
            `${t.repo}: self-development command is policy-isolated on a trusted workstation (no bubblewrap). Secrets and the application database are removed from the environment. The process still runs as the worker user.`,
          );
        r = await runCommand(
          String(cfg.command),
          t.path,
          {
            BASE_BRANCH: baseBranch,
            REPO: t.repo,
            BRANCH: t.branch,
            RUN_ID: String(ctx.run.id),
            ...(known?.skipRegex ? { GO_TEST_SKIP: known.skipRegex } : {}),
            ...((cfg.env as Record<string, string>) ?? {}),
          },
          timeoutMs,
          ctx.signal,
          (chunk) => void ctx.log("log", chunk, { repo: t.repo }),
        );
      } catch (e) {
        return {
          kind: "failed",
          error: `${t.repo}: ${(e as Error).message}`,
          retryable: false,
        };
      }
      await ctx.log(
        "system",
        `■ ${t.repo}: exit ${r.timedOut ? "timeout" : r.code} after ${Math.round((Date.now() - started) / 1000)}s`,
        { repo: t.repo, exit_code: r.code, timed_out: r.timedOut },
      );
      const artifactId = await ctx.artifact("log", `${ctx.step.key}-${t.repo}.log`, r.output, {
        exit_code: r.code,
        timed_out: r.timedOut,
      });
      const entry: (typeof results)[number] & { skipped_known_failures?: string[] } = {
        repo: t.repo,
        exit_code: r.code,
        timed_out: r.timedOut,
        artifact_id: artifactId,
        passed: r.code === 0,
        ...(known?.tests.length ? { skipped_known_failures: known.tests } : {}),
      };
      if (r.code !== 0 && !r.timedOut && cfg.baseline_compare === "go")
        entry.baseline = await compareWithBaseline(ctx, t, r.output, timeoutMs);
      // Auto-accepting failures that also fail on the base branch: opt-in when interactive (the developer confirms instead).
      if (
        entry.baseline?.regressions &&
        !entry.baseline.regressions.length &&
        (cfg.baseline_auto_accept ?? !interactive)
      )
        entry.passed = true;
      outputs[t.repo] = r.output;
      results.push(entry);
    }
    const failed = results.filter((r) => !r.passed);
    // The exact commits the tests ran on: the PR gate refuses to publish anything else.
    const tested_heads: Record<string, string> = {};
    for (const t of targets)
      if (t.repo !== "(cwd)") tested_heads[t.repo] = await headOf(t.path).catch(() => "");
    const output = {
      results,
      passed: failed.length === 0,
      command_hash: commandHash,
      tested_clean: clean,
      ...(Object.keys(tested_heads).length ? { tested_heads } : {}),
      ...(decision ? { decision } : {}),
    };
    if (failed.length && !cfg.allow_failure && interactive) {
      // Automatic retries first (max_attempts); when they are exhausted, diagnose and ask the developer.
      if (ctx.step.attempt_count < ctx.step.max_attempts)
        return {
          kind: "failed",
          error: `tests failed (attempt ${ctx.step.attempt_count}/${ctx.step.max_attempts}); retrying`,
          retryable: true,
          details: output,
        };
      return askAboutFailure(ctx, { command: String(cfg.command), outputs, results }, decision);
    }
    if (failed.length && !cfg.allow_failure) {
      const why = (f: (typeof results)[number]) => {
        const reg = f.baseline?.regressions;
        if (reg?.length)
          return `${f.repo}: ${reg.length} regression(s) vs ${config.baseBranch} — ${reg.map((x: any) => [x.package.split("/").slice(-2).join("/"), ...x.tests, ...x.build_errors].slice(0, 4).join(" ")).join("; ")}`;
        return `${f.repo} (exit ${f.timed_out ? "timeout" : f.exit_code}${f.baseline?.note ? `, ${f.baseline.note}` : ""})`;
      };
      return {
        kind: "failed",
        error: `command failed in ${failed.map(why).join(" | ")}`,
        retryable: false,
        details: output,
      };
    }
    return { kind: "completed", output };
  },
};

/** Re-run the failing Go packages on origin/<base>; failures present there too are pre-existing, not regressions. */
async function compareWithBaseline(
  ctx: ExecutionContext,
  t: { repo: string; path: string },
  output: string,
  timeoutMs: number,
) {
  const baseBranch = await repositoryBaseBranch(t.repo);
  const branch = parseGoTest(output);
  const failing = Object.entries(branch)
    .filter(([, p]) => p.status === "fail")
    .map(([k]) => k);
  if (!failing.length) {
    await ctx.log(
      "system",
      `baseline: no parseable go test failure in ${t.repo} (e.g. go build failed); not comparing`,
    );
    return { note: "no go test failure to compare (build or script error)" };
  }
  await ctx.log(
    "system",
    `◆ ${t.repo}: comparing ${failing.length} failing package(s) with origin/${baseBranch}…`,
  );
  try {
    const base = await goBaseline(t.path, failing, (command, cwd) =>
      runCommand(
        command,
        cwd,
        { BASE_BRANCH: baseBranch, REPO: t.repo },
        timeoutMs,
        ctx.signal,
        (chunk) => void ctx.log("log", chunk, { repo: t.repo, baseline: true }),
      ),
    );
    const c = classify(branch, base.report);
    await ctx.log(
      "system",
      `◆ ${t.repo}: baseline ${base.sha.slice(0, 9)} → ${c.regressions.length} regression(s), ${c.pre_existing.length} package(s) with pre-existing failures` +
        (base.cached.length ? ` (cached: ${base.cached.length})` : ""),
      { repo: t.repo, ...c },
    );
    return { base_sha: base.sha, ...c };
  } catch (e) {
    await ctx.log("system", `baseline comparison failed for ${t.repo}: ${(e as Error).message}`);
    return { note: `baseline comparison failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

// ---------------------------------------------------------------- integration

/** Optional AI re-ranking hook (set by the Claude executor module); must only reorder/annotate given repos. */
export let aiRepositoryRanker:
  | ((
      ctx: ExecutionContext,
      candidates: RankedRepository[],
      repos: RepositoryRow[],
    ) => Promise<RankedRepository[]>)
  | null = null;
export function setAiRepositoryRanker(fn: typeof aiRepositoryRanker) {
  aiRepositoryRanker = fn;
}

async function repositoryDiscovery(ctx: ExecutionContext): Promise<ExecResult> {
  const cfg = ctx.step.config;
  const allowed = new Set(ctx.run.allowed_repositories);
  const rows = (await repositories.list()).filter((r) => allowed.has(r.name));
  if (!rows.length) {
    // Investigations can proceed on logs alone; code context is a bonus there.
    if (cfg.optional === true)
      return {
        kind: "completed",
        output: {
          candidates: [],
          recommended: [],
          ambiguous: false,
          method: "none",
          note: "no repositories are allowed for this run; continuing without code context",
        },
      };
    // Since migration 045 the run scope is the owner's own accessible repositories (grant or shared access ∩ Bitbucket
    // ∩ repository policy), narrowed by the project mapping. It is fixed when the run is created.
    return {
      kind: "failed",
      error:
        "no repositories are allowed for this run: the run owner has no access to any repository of this project. " +
        "An admin grants access in Repositories → Access management (or sets a repository's Shared level); " +
        "for Bitbucket repositories the owner also needs a personal Bitbucket token. Then retry this step: " +
        "until repositories are selected, the run scope follows the owner's current access.",
      retryable: false,
    };
  }
  const keywords = Object.values(ctx.input.upstream).flatMap((u) =>
    Array.isArray(u.output?.keywords) ? u.output.keywords : [],
  );
  // Feedback-driven rediscovery: rank again with the feedback, never reuse the earlier selection silently.
  const rediscover = ctx.input.pending?.rediscover as { id: string; feedback: string } | undefined;
  const text = [
    ctx.input.work_item?.title,
    ctx.input.work_item?.description,
    ctx.input.run.title,
    rediscover?.feedback,
    JSON.stringify(ctx.input.run.inputs ?? {}),
  ]
    .filter(Boolean)
    .join("\n");
  const rankingStarted = Date.now();
  let ranked = await hybridRank(rows, { text, keywords, project: ctx.context.project });
  if (codeIntelligenceEnabled())
    await ctx
      .recordMetrics({
        code_intelligence: { repository_ranking_latency: Date.now() - rankingStarted },
      })
      .catch(() => {});
  let method = "deterministic";
  // Repositories already chosen (explicitly or reused from an earlier run of this work item): nothing to rediscover.
  if (ctx.run.selected_repositories.length && cfg.reuse_selected !== false && !rediscover) {
    await ctx.log(
      "system",
      `repository discovery: reusing ${ctx.run.selected_repositories.join(", ")} (no re-ranking)`,
    );
    return {
      kind: "completed",
      output: {
        candidates: ranked.slice(0, Number(cfg.max_candidates ?? 5)),
        recommended: ctx.run.selected_repositories,
        ambiguous: false,
        method: "reused",
        reused: true,
      },
    };
  }
  // Claude is only consulted when the deterministic ranking cannot decide.
  if (
    cfg.use_ai &&
    aiRepositoryRanker &&
    isAmbiguous(ranked.slice(0, Number(cfg.max_candidates ?? 5)))
  ) {
    try {
      const ai = await aiRepositoryRanker(ctx, ranked, rows);
      // Never let the model introduce repositories outside the allowed set.
      const safe = ai.filter((r) => allowed.has(r.repo));
      if (safe.length) {
        ranked = safe;
        method = "ai-assisted";
      }
    } catch (e) {
      await ctx.log(
        "system",
        `AI repository ranking unavailable, using deterministic ranking: ${(e as Error).message}`,
      );
    }
  }
  const max = Number(cfg.max_candidates ?? 5);
  const candidates = ranked.slice(0, max);
  const ambiguous = isAmbiguous(candidates);
  const recommended = candidates
    .filter((c) => c.score > 0 && c.score >= (candidates[0]?.score ?? 0) * 0.75)
    .map((c) => c.repo);
  const output: Record<string, unknown> = { candidates, recommended, ambiguous, method };
  if (rediscover) {
    // Keep what was selected before (code may exist there) and add what the feedback now points at; the confirm
    // step always asks, so the developer settles the final scope.
    const previous = ctx.run.selected_repositories;
    const named = feedbackSignals(
      rediscover.feedback,
      [...allowed],
      previous,
    ).unselected_repositories;
    const merged = [...new Set([...previous, ...recommended, ...named])].filter((r) =>
      allowed.has(r),
    );
    for (const r of merged)
      if (!candidates.some((c) => c.repo === r))
        candidates.push({
          repo: r,
          score: 0,
          reasons: [
            previous.includes(r) ? "selected before the feedback" : "named in the feedback",
          ],
        } as (typeof candidates)[number]);
    Object.assign(output, {
      recommended: merged,
      rediscovered: {
        id: rediscover.id,
        previous,
        added: merged.filter((r) => !previous.includes(r)),
      },
      ambiguous: true,
    });
    await ctx.log(
      "system",
      `repository rediscovery after feedback: previously ${previous.join(", ") || "none"}, recommended now ${merged.join(", ")}`,
    );
    return { kind: "completed", output };
  }
  // Provisional selection unless the user already chose; the confirm step finalises it.
  if (!ctx.run.selected_repositories.length && recommended.length)
    output.selected_repositories = recommended;
  return { kind: "completed", output };
}

async function selectRepositories(ctx: ExecutionContext): Promise<ExecResult> {
  const repos = ctx.run.selected_repositories.length
    ? ctx.run.selected_repositories
    : ((ctx.input.run.inputs?.repositories as string[]) ?? []);
  if (!repos.length)
    return {
      kind: "failed",
      error: "select at least one repository for this run",
      retryable: false,
    };
  return {
    kind: "completed",
    output: {
      repositories: repos,
      selected_repositories: repos,
      branch: ctx.input.run.inputs?.branch ?? null,
    },
  };
}

function renderFindings(key: string, out: any): string {
  if (!out) return `## ${key}\n\n(no output)\n`;
  const lines = [`## ${key}`, "", out.summary ? String(out.summary) : ""];
  const list = out.findings ?? out.violations ?? [];
  if (Array.isArray(list) && list.length) {
    lines.push("", "| Severity | Location | Issue | Suggestion |", "|---|---|---|---|");
    for (const f of list)
      lines.push(
        `| ${f.severity ?? "-"} | ${[f.repo, f.file, f.line].filter(Boolean).join(":") || f.guideline || "-"} | ${String(f.issue ?? f.detail ?? "").replace(/\|/g, "\\|")} | ${String(f.suggestion ?? "").replace(/\|/g, "\\|")} |`,
      );
  }
  return lines.join("\n") + "\n";
}

async function publishReport(ctx: ExecutionContext): Promise<ExecResult> {
  const from = (ctx.step.config.from as string[]) ?? Object.keys(ctx.input.upstream);
  const title = String(ctx.step.config.title ?? "Report");
  const sections = from.map((k) => renderFindings(k, ctx.input.upstream[k]?.output));
  const md = [
    `# ${title}`,
    "",
    `Run #${ctx.run.id} · ${ctx.run.selected_repositories.join(", ")}`,
    "",
    ...sections,
  ].join("\n");
  const findings = from.flatMap((k) => {
    const o = ctx.input.upstream[k]?.output;
    return (o?.findings ?? o?.violations ?? []).map((f: any) => ({ ...f, source: k }));
  });
  const artifactId = await ctx.artifact("report", `${title}.md`, md, { findings });
  return {
    kind: "completed",
    output: { report_artifact_id: artifactId, findings_count: findings.length, findings },
  };
}

/** Fold each subtask branch into the run worktree. Declared file conflicts are handled by the caller first. */
async function mergeIsolatedSubtasks(ctx: ExecutionContext): Promise<ExecResult | null> {
  if (!ctx.run?.id) return null;
  const subs = await subtaskWorkspacesOf(ctx.run.id);
  if (!subs.length) return null;
  for (const sub of subs) {
    if (await worktreePorcelain(sub.path))
      return {
        kind: "failed",
        error: `Subtask ${sub.subtask_id} in ${sub.repo} has uncommitted changes; commit them before integration`,
        retryable: false,
      };
  }
  const gitConflicts: Array<{ repo: string; branch: string; error: string }> = [];
  const repos = [...new Set(subs.map((s) => s.repo))];
  for (const repo of repos) {
    let parent;
    try {
      parent = await prepareWorkspace(ctx.run, repo, async () => {
        if (ctx.signal?.aborted) throw new Error("aborted");
      });
    } catch (e) {
      return {
        kind: "failed",
        error: `cannot prepare integration worktree for ${repo}: ${(e as Error).message}`,
        retryable: true,
      };
    }
    for (const sub of subs.filter((s) => s.repo === repo)) {
      try {
        await mergeBranchInto(parent.path, sub.branch);
        await ctx.log("system", `merged ${sub.branch} into ${parent.branch} (${repo})`);
      } catch (e) {
        gitConflicts.push({ repo, branch: sub.branch, error: (e as Error).message });
        break;
      }
    }
  }
  if (gitConflicts.length) {
    await ctx.log("system", `git merge failed for ${gitConflicts.length} subtask branch(es)`, {
      conflicts: gitConflicts,
    });
    return {
      kind: "failed",
      error: `Subtask merge conflict: ${gitConflicts.map((c) => `${c.repo} ${c.branch}`).join(", ")}`,
      retryable: false,
      details: { conflicts: gitConflicts },
    };
  }
  return null;
}

export async function integrateSubtasks(ctx: ExecutionContext): Promise<ExecResult> {
  const upstream = ctx.input.upstream ?? {};
  const subtaskOutputs = Object.entries(upstream)
    .filter(([k]) => k.startsWith("subtask-"))
    .map(([k, v]) => ({ key: k, ...(v as any) }));

  await ctx.log("system", `integrating ${subtaskOutputs.length} completed subtask(s)...`);

  // Detect conflicts across subtask outputs and owned files
  const modifiedFiles: Record<string, string[]> = {};
  const conflicts: Array<{ file: string; subtasks: string[] }> = [];

  for (const s of subtaskOutputs) {
    const files: string[] =
      s.output?.files ?? s.output?.owned_files ?? s.output?.modified_files ?? [];
    for (const f of files) {
      if (!modifiedFiles[f]) modifiedFiles[f] = [];
      modifiedFiles[f].push(s.key);
      if (modifiedFiles[f].length > 1 && !conflicts.some((c) => c.file === f)) {
        conflicts.push({ file: f, subtasks: modifiedFiles[f] });
      }
    }
  }

  if (conflicts.length > 0) {
    await ctx.log(
      "system",
      `conflict detected during subtask integration in ${conflicts.length} file(s)`,
      { conflicts },
    );
    return {
      kind: "failed",
      error: `Subtask merge conflict: files modified by multiple subtasks: ${conflicts.map((c) => c.file).join(", ")}`,
      retryable: false,
      details: { conflicts },
    };
  }

  const merged = await mergeIsolatedSubtasks(ctx);
  if (merged) return merged;

  return {
    kind: "completed",
    output: {
      status: "integrated",
      subtasks_integrated: subtaskOutputs.map((s) => s.key),
      count: subtaskOutputs.length,
      modified_files: Object.keys(modifiedFiles),
    },
  };
}

export const integrationExecutor: StepExecutor = {
  async execute(ctx) {
    switch (ctx.step.config.action) {
      case "integrate_subtasks":
      case "subtask_integration":
        return integrateSubtasks(ctx);
      case "benchmark_case":
        return executeBenchmarkCase(ctx);
      case "repository_discovery":
        return repositoryDiscovery(ctx);
      case "select_repositories":
        return selectRepositories(ctx);
      case "publish_report":
        return publishReport(ctx);
      case "investigation_parse":
        return investigationParse(ctx);
      case "investigation_correlate":
        return investigationCorrelate(ctx);
      case "investigation_latency":
        return investigationLatency(ctx);
      case "investigation_report":
        return investigationReport(ctx);
      case "noop":
        return { kind: "completed", output: { ok: true } };
      default:
        return {
          kind: "failed",
          error: `unknown integration action "${ctx.step.config.action}"`,
          retryable: false,
        };
    }
  },
};

// ---------------------------------------------------------------- git_pull_request

/** PR title/summary/decisions for one repo, from the content step's output (shared with the PR preview). */
export function prFields(source: any, repo: string, code: string | undefined, runTitle: string) {
  const content = source?.pull_requests?.[repo] ?? {};
  return {
    title: String(content.title ?? source?.title ?? `${code ? code + ": " : ""}${runTitle}`).slice(
      0,
      250,
    ),
    summary: String(content.summary ?? source?.summary ?? ""),
    decisions: (content.decisions ?? source?.decisions ?? []) as Array<{
      title: string;
      detail: string;
    }>,
  };
}

export function prDescription(x: {
  code?: string;
  runId: number;
  summary: string;
  decisions: Array<{ title: string; detail: string }>;
  commits: string;
  testExceptions?: Array<{ step: string; exception: any }>;
  verificationNotes?: Array<{ step: string; status: string; lines: string[] }>;
}) {
  const exc = x.testExceptions ?? [];
  const vn = (x.verificationNotes ?? []).filter((n) => n.lines.length);
  return [
    x.code ? `Task: **${x.code}**` : `Workflow run #${x.runId}`,
    "",
    x.summary,
    "",
    x.decisions.length
      ? "## Decisions\n" + x.decisions.map((d) => `- **${d.title}**: ${d.detail}`).join("\n")
      : "",
    "",
    "## Commits\n```\n" + x.commits + "\n```",
    "",
    ...(exc.length
      ? [
          "## Test exceptions (accepted by the developer — test result remains FAILED)",
          ...exc.flatMap((e) => [
            `- ${e.step}: failures that also fail on the base branch${e.exception.base_sha ? ` (${String(e.exception.base_sha).slice(0, 9)})` : ""}:`,
            ...e.exception.failures.map((f: any) =>
              `  - ${f.repo} ${f.package ?? ""} ${f.test ?? f.build_error ?? ""}`.trimEnd(),
            ),
          ]),
          "",
        ]
      : []),
    ...(vn.length
      ? [
          "## Verification notes (automated checks were not conclusive — please review)",
          ...vn.flatMap((n) => [`- ${n.step} (${n.status}):`, ...n.lines.map((l) => `  - ${l}`)]),
          "",
        ]
      : []),
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
}

/** Accepted baseline test exceptions recorded by upstream command steps of a run (for PR text and reports). */
export async function testExceptionsOf(runId: number) {
  const rows = await q(
    pool,
    "SELECT key, output FROM workflow_steps WHERE run_id = $1 AND type = 'command' AND output ? 'accepted_exception' ORDER BY position",
    [runId],
  );
  return rows.map((r: any) => ({ step: r.key, exception: r.output.accepted_exception }));
}

/** Harness verification results a reviewer must see: accepted pre-existing failures and needs-review signals. */
export async function verificationNotesOf(runId: number) {
  const rows = await q(
    pool,
    "SELECT key, output->'verification' AS v FROM workflow_steps WHERE run_id = $1 AND type = 'coding_agent' AND output ? 'verification' ORDER BY position",
    [runId],
  );
  return rows
    .filter(
      (r: any) =>
        r.v &&
        (r.v.status === "accepted_with_preexisting" ||
          r.v.needs_review ||
          r.v.status === "disabled"),
    )
    .map((r: any) => ({
      step: r.key,
      status: String(r.v.status),
      lines: [
        ...(r.v.status === "disabled" ? ["verification disabled by the workflow definition"] : []),
        ...((r.v.last ?? []) as any[])
          .filter((x) => x.status === "accepted_preexisting")
          .map((x) => `${x.repo}: ${x.note ?? "pre-existing failures accepted"}`),
        ...((r.v.review_reasons ?? []) as string[]),
      ],
    }));
}

const revParse = (path: string, ref: string) =>
  new Promise<string>((resolve) => {
    const p = spawn("git", ["-C", path, "rev-parse", "--verify", "--quiet", ref]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(""));
    p.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
  });

/**
 * Opens (or updates) one PR per workspace with commits. Idempotent across retries: the provider updates the
 * open PR for source→target and `pull_requests` is unique per (provider, repo, source, target).
 * Modes: auto | approval (gate before the step, set up at run start) | draft | none.
 */
export const pullRequestExecutor: StepExecutor = {
  async execute(ctx) {
    const cfg = ctx.step.config;
    const mode = String(cfg.mode ?? "auto");
    if (mode === "none")
      return {
        kind: "completed",
        output: { skipped: true, reason: "PR creation disabled (mode: none)" },
      };
    const workspaces = await workspacesOf(ctx.run.id);
    if (!workspaces.length)
      return {
        kind: "completed",
        output: { pull_requests: [], note: "no workspace was changed in this run" },
      };
    const source =
      ctx.input.upstream[String(cfg.content_from ?? "")]?.output ??
      Object.values(ctx.input.upstream).find((u) => u.output?.pull_requests)?.output ??
      {};
    const code = ctx.input.work_item?.code;
    const out: any[] = [];
    // Pre-publish gate, always on (deterministic, re-read from git right now — after any approval of this step):
    //  - every published repo is clean and its HEAD is the tip of the pushed branch;
    //  - every test record bound to commits (coding verification, test steps) ran on exactly the commit to publish;
    //  - the actual diff still fits the approved scope, or a renewed approval names this exact revision.
    // Then the independent verification gate: steps marked `independent: true` make verification REQUIRED — every one
    // must hold a valid PASS covering every published repo at exactly that commit. A BLOCKED verdict stays blocking.
    const bases = Object.fromEntries(
      await Promise.all(
        workspaces.map(async (w) => [w.repo, await workspaceBase(ctx.run, w)] as const),
      ),
    );
    const steps = await q<{ key: string; status: string; output: any; independent: boolean }>(
      pool,
      "SELECT key, status, output, config->>'independent' = 'true' AS independent FROM workflow_steps WHERE run_id = $1 ORDER BY position",
      [ctx.run.id],
    );
    const publish: Record<string, PublishState> = {};
    for (const w of workspaces.filter((x) => ctx.run.selected_repositories.includes(x.repo))) {
      const branchTip = await revParse(w.path, `refs/heads/${w.branch}`);
      // Commits tested / verified before a rebase or a base merge still count when the branch's own change is unchanged.
      const recorded = [
        ...new Set(
          steps
            .flatMap((x) => [x.output?.tested_heads?.[w.repo], x.output?.verified_heads?.[w.repo]])
            .filter((h): h is string => typeof h === "string" && !!h && h !== branchTip),
        ),
      ];
      const equivalent: string[] = [];
      for (const h of recorded)
        if (branchTip && (await samePatch(w.path, bases[w.repo].ref, h, branchTip)))
          equivalent.push(h);
      if (equivalent.length)
        await ctx.log(
          "system",
          `${w.repo}: ${equivalent.map((h) => h.slice(0, 12)).join(", ")} carries the same change as ${branchTip.slice(0, 12)} relative to ${bases[w.repo].ref} (rebased or base merged in): its tests and verification still count`,
        );
      publish[w.repo] = {
        head: await headOf(w.path).catch(() => ""),
        branchTip,
        dirty: await dirtyOf(w.path),
        equivalent,
      };
    }
    const scope =
      [...steps]
        .reverse()
        .find((x) => x.status === "COMPLETED" && x.output?.approved_scope?.proposal_hash)?.output
        .approved_scope ?? null;
    const state = scope
      ? await collectScopeState(
          workspaces.map((w) => ({ repo: w.repo, path: w.path, base: bases[w.repo].ref })),
        )
      : null;
    const renewedRevision =
      steps
        .map((x) => x.output?.scope_check?.reapproved?.revision)
        .filter(Boolean)
        .at(-1) ?? null;
    const tested = steps
      .filter(
        (x) =>
          x.status === "COMPLETED" &&
          x.output?.tested_heads &&
          typeof x.output.tested_heads === "object",
      )
      .map((x) => ({ step: x.key, heads: x.output.tested_heads }));
    const verifiers = steps.filter((x) => x.independent);
    const problems = [
      ...new Set([
        ...prePublishProblems({ publish, scope, state, renewedRevision, tested }),
        ...(verifiers.length ? verificationGate(verifiers, publish) : []),
      ]),
    ];
    if (problems.length) {
      await ctx.log("system", `PR blocked by the pre-publish gate:\n- ${problems.join("\n- ")}`);
      return {
        kind: "failed",
        error: `pre-publish gate: ${problems.join("; ")} — fix the cause (re-run the coding / test / verification step, or renew the scope approval) before opening the PR`,
        retryable: false,
      };
    }
    for (const w of workspaces) {
      if (!ctx.run.selected_repositories.includes(w.repo)) {
        await ctx.log("system", `skip PR for ${w.repo}: not in the run's selected repositories`);
        continue;
      }
      // A fenced-out / canceled attempt must not start another external action.
      if (ctx.signal.aborted)
        return {
          kind: "failed",
          error: `PR step interrupted before publishing ${w.repo}: ${String(ctx.signal.reason ?? "aborted")}`,
          retryable: false,
        };
      // The owner must still hold pull-request permission right now (revocation, Bitbucket check, repository policy).
      try {
        await requireRunRepositoryAccess(ctx.run.id, w.repo, "pull_request");
      } catch (e) {
        await ctx.log("system", `${w.repo}: publication refused: ${(e as Error).message}`);
        return { kind: "failed", error: `${w.repo}: ${(e as Error).message}`, retryable: false };
      }
      const registry = await repositories.get(w.repo);
      const provider = gitProviderFor(registry?.provider);
      const { title, summary, decisions } = prFields(source, w.repo, code, ctx.run.title);
      let commits: string;
      try {
        const pushed = await provider.push(w.path, w.branch, bases[w.repo]?.target);
        commits = pushed.commits;
        if (pushed.note) await ctx.log("system", `${w.repo}: ${pushed.note}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (/no commits ahead/.test(msg)) {
          await ctx.log("system", `${w.repo}: ${msg}; no PR`);
          continue;
        }
        return { kind: "failed", error: `${w.repo}: push failed: ${msg}`, retryable: true };
      }
      const description = prDescription({
        code,
        runId: ctx.run.id,
        summary,
        decisions,
        commits,
        testExceptions: await testExceptionsOf(ctx.run.id),
        verificationNotes: await verificationNotesOf(ctx.run.id),
      });
      const slug = registry ? repositoryReference(registry) : w.repo;
      const destination = bases[w.repo]?.target || registry?.default_branch || config.baseBranch;
      if (ctx.signal.aborted)
        return {
          kind: "failed",
          error: `PR step interrupted after pushing ${w.repo} (no PR call made; a retry reconciles by looking up the open PR)`,
          retryable: false,
        };
      const pr = await provider.openOrUpdatePullRequest({
        repo: slug,
        source: w.branch,
        target: destination,
        title,
        description,
        draft: mode === "draft",
      });
      await q(
        pool,
        `INSERT INTO pull_requests (provider, repo, source_branch, target_branch, url, title, summary, decisions, draft, created, work_item_id, run_id, step_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (provider, repo, source_branch, target_branch) DO UPDATE SET url = excluded.url, title = excluded.title, summary = excluded.summary,
           decisions = excluded.decisions, draft = excluded.draft, created = pull_requests.created OR excluded.created,
           run_id = excluded.run_id, step_id = excluded.step_id, work_item_id = COALESCE(excluded.work_item_id, pull_requests.work_item_id), updated_at = now()`,
        [
          provider.name,
          w.repo,
          w.branch,
          destination,
          pr.url,
          title,
          summary,
          JSON.stringify(decisions),
          mode === "draft",
          pr.created,
          ctx.run.work_item_id,
          ctx.run.id,
          ctx.step.id,
        ],
      );
      await ctx.log("system", `PR ${w.repo}: ${pr.url} (${pr.note})`);
      out.push({
        repo: w.repo,
        url: pr.url,
        created: pr.created,
        note: pr.note,
        draft: mode === "draft",
      });
    }
    return { kind: "completed", output: { pull_requests: out } };
  },
};
