import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import { indexRepository } from "../../../codeIntelligence/indexer.ts";
import { config } from "../../../config.ts";
import { one, pool, q } from "../../../db/pool.ts";
import { workspaceBase } from "../../../git/provider.ts";
import { repositoryBaseBranch, workspaceBaseBranch } from "../../../repos/service.ts";
import { resolveSlopSettings, blocking as slopBlocking } from "../../../slop/policy.ts";
import { scanWorkspace } from "../../../slop/scan.ts";
import { goBaseline, knownBaseFailures } from "../../../workflow/executors/baseline.ts";
import { runVerificationCommand as runCommand } from "../../../workflow/executors/builtin.ts";
import { collectMicroEvidence } from "../../../workflow/microEvidence.ts";
import { TEST_COMMAND } from "../../../workflow/templates.ts";
import { SINCE_HUMAN_REEXECUTE, worktreeState } from "../../claude.ts";
import {
  attemptArtifacts,
  compactionDecision,
  sessionStateBlock,
} from "../../../context/compaction.ts";
import { blocksRebuild, failedTurn } from "../failure.ts";
import { executionWorkspaces } from "../../implementationEvidence.ts";
import {
  REVIEW_POLICY_VERSION,
  enforceScopeReview,
  enforceVerdict,
  evidenceDrift,
  independentSubmissionGap,
  normalizeVerdict,
  repairTargetFor,
  unresolvedScope,
} from "../../independentReview.ts";
import { outputLocale } from "../../language.ts";
import { changedFiles, collectScopeState } from "../../scopeGuard.ts";
import { selectVerificationScope } from "../../verificationScope.ts";
import {
  type VerifyDeps,
  beforeAfterProof,
  diffAgainstBase,
  diffTestsAgainstBase,
  repairPrompt,
  restoreConflictSkips,
  sourceUnchangedSince,
  verificationLoop,
  verificationSummary,
  verifyConfig,
  verifyWorkspaces,
} from "../../verify.ts";
import { EvidenceCache, pgEvidenceStore } from "../../verifyEvidence.ts";
import { budgetStop } from "./budget.ts";
import { noteDecision } from "../../../workflow/decisions.ts";
import {
  type SymptomSignal,
  enforceRootCauseReview,
  normalizeRemediation,
  rootCauseDepth,
  symptomFixSignals,
} from "../../rootCause.ts";

/** Deterministic verification: the independent verdict gates, or the bounded verify-and-repair loop for implementation steps. */
export async function verifyStage(s: LifecycleState): Promise<ExecResult | void> {
  const {
    ctx,
    mode,
    provider,
    independent,
    result,
    metrics,
    ws,
    evidence,
    reviewKey,
    baseTips,
    incremental,
    rounds,
    run,
    freshPrompt,
    openQuestions,
    pause,
    terminalCodingFailure,
    restoreWorkspaces,
  } = s;
  let output = s.output;
  if (independent) {
    const gap = independentSubmissionGap(s.submitted, {
      toolNames: Object.keys(metrics.tool_calls),
      note: result.text,
    });
    if (gap)
      return {
        kind: "failed",
        error: gap,
        retryable: true,
        details: s.submitted ? { submitted: s.submitted } : undefined,
      };
    let v = normalizeVerdict(s.submitted ?? {});
    if (ctx.step.config.scope_review === true)
      v = enforceScopeReview(v, s.submitted?.scope_check, ctx.input.upstream);
    v = enforceRootCauseReview(
      v,
      s.submitted?.root_cause_check,
      ctx.input.upstream,
      rootCauseDepth(ctx.run, ctx.step),
    );
    // Deterministic scope violations without a renewed approval: a reviewer PASS never overrides them.
    const unresolved = unresolvedScope(
      await q<{ key: string; sc: unknown }>(
        pool,
        "SELECT key, output->'scope_check' AS sc FROM workflow_steps WHERE run_id = $1 AND output ? 'scope_check'",
        [ctx.run.id],
      ),
    );
    if (unresolved.length && v.verdict === "PASS")
      v = {
        ...v,
        verdict: "BLOCKED",
        blocked_reason: `deterministic scope violation without renewed approval: ${unresolved.join(" | ")}`,
      };
    const drift = await evidenceDrift(
      ws.map((w) => ({ repo: w.repo, path: w.path })),
      evidence?.heads ?? {},
    );
    if (drift.length && v.verdict === "PASS")
      v = {
        ...v,
        verdict: "BLOCKED",
        blocked_reason: `the verdict no longer matches the code: ${drift.join("; ")}`,
      };
    const repairsUsed = (await one<{ n: number }>(
      pool,
      // Repair budget restarts when a human re-executes (re-run / instructions / rejection): automatic repair rounds
      // since then are what is bounded, not FAIL verdicts from before the developer intervened.
      `SELECT count(*)::int AS n FROM workflow_step_attempts a
        WHERE a.step_id = $1 AND a.output->>'verdict' = 'FAIL' AND ${SINCE_HUMAN_REEXECUTE}`,
      [ctx.step.id, ctx.run.id],
    ))!.n;
    const maxRepairs = Math.max(0, Math.min(10, Number(ctx.step.config.max_repairs ?? 2)));
    metrics.independent_verification = {
      verdict: v.verdict,
      findings: v.findings.length,
      high: v.findings.filter((f) => f.severity === "high").length,
      repairs_used: repairsUsed,
      max_repairs: maxRepairs,
    };
    await ctx.recordMetrics(metrics as unknown as Record<string, unknown>).catch(() => {});
    await ctx.log(
      "system",
      `independent verification: ${v.verdict}${v.findings.length ? ` (${v.findings.length} finding(s))` : ""}`,
      { verdict: v.verdict },
    );
    const decided = enforceVerdict(v, {
      repairsUsed,
      maxRepairs,
      repairTarget: repairTargetFor(ctx.run.graph, ctx.step.key),
      heads: evidence?.heads ?? {},
      baseTips,
      incrementalFrom: incremental?.attemptId,
    });
    if (decided.kind === "completed" && reviewKey)
      decided.output = {
        ...(decided.output && typeof decided.output === "object" ? decided.output : {}),
        verification_key: reviewKey,
        review_policy_version: REVIEW_POLICY_VERSION,
      };
    return decided;
  }

  // ---- verification-and-repair loop (coding steps): success only when the mandatory checks pass
  const vcfg =
    mode === "coding"
      ? ctx.input.execution_contract?.verification
        ? {
            ...(ctx.input.execution_contract
              .verification as import("../../verify.ts").VerifyConfig),
          }
        : verifyConfig(ctx.step.config, TEST_COMMAND)
      : null;
  if (vcfg && !independent) {
    const contract = ctx.input.execution_contract!;
    vcfg.requiredTests = [...new Set([...(vcfg.requiredTests ?? []), ...contract.required_tests])];
    vcfg.contractRevision = contract.provenance?.revision;
  }
  if (mode === "coding" && !independent && !vcfg)
    return {
      kind: "failed",
      retryable: false,
      error: "Mandatory implementation verification is disabled",
    };

  if (mode === "coding" && !vcfg) {
    // Only the versioned workflow definition can turn the gate off; record it so evaluation never counts it as passed.
    await ctx.log(
      "system",
      "verification disabled by the workflow definition (config.verify = false)",
    );
    metrics.verification = {
      outcome: "disabled",
      status: "disabled",
      passed: null,
    };
    await ctx.recordMetrics(metrics as unknown as Record<string, unknown>).catch(() => {});
    output = {
      ...output,
      verification: { outcome: "disabled", status: "disabled", passed: null },
    };
  }
  const restoreBlocked = vcfg ? await restoreWorkspaces() : null;
  if (restoreBlocked && restoreBlocked.kind !== "waiting_input") return restoreBlocked;
  // The agent already submitted: a question now would re-run it from scratch on resume, so conflicted repos are skipped.
  const unrestored = restoreConflictSkips(restoreBlocked);
  if (vcfg) {
    const trees = (await executionWorkspaces(ctx)).filter(
      (w) =>
        !ctx.run.selected_repositories.length || ctx.run.selected_repositories.includes(w.repo),
    );
    const assessMicroScope = async (): Promise<
      { escalate: false } | { escalate: true; result: ExecResult }
    > => {
      const state = await collectScopeState(
        await Promise.all(
          trees.map(async (w) => ({
            repo: w.repo,
            path: w.path,
            base: (await workspaceBase(ctx.run, w)).ref,
          })),
        ),
      );
      const files = Object.values(state.files).flat();
      const approved = Array.isArray(ctx.step.config.micro_scope)
        ? (ctx.step.config.micro_scope as string[])
        : [];
      let impactKnown = false;
      if (trees.length === 1 && files.every((file) => approved.includes(file))) {
        await indexRepository(trees[0].repo, ctx.run.id).catch(() => null);
        impactKnown =
          (await collectMicroEvidence(trees[0].repo, files, 0, ctx.run.id))?.impactKnown === true;
      }
      const scope = selectVerificationScope({
        files,
        approvedFiles: approved,
        impactKnown,
        risk: "low",
        mandatory: vcfg.command,
        targeted: vcfg.command,
        broad: vcfg.broadCommand,
      });
      await ctx.recordMetrics({ verification_scope: scope });
      if (scope.escalate)
        return {
          escalate: true,
          result: {
            kind: "profile_escalation",
            request: {
              target: "STANDARD",
              risk: "unknown",
              reason: scope.reasons.join("; "),
              expectedRevision:
                (
                  ctx.run.graph as import("../../../workflow/types.ts").WorkflowSpec & {
                    profile_revision?: number;
                  }
                ).profile_revision ?? 0,
            },
          },
        };
      vcfg.command = scope.commands.map((command) => `{\n${command}\n}`).join("\n");
      return { escalate: false };
    };
    if (ctx.run.profile === "MICRO") {
      const check = await assessMicroScope();
      if (check.escalate) return check.result;
    } else if (ctx.input.pending?.profile_transition && vcfg.broadCommand) {
      vcfg.command = `set -e\n{\n${vcfg.command}\n}\n{\n${vcfg.broadCommand}\n}`;
    }
    if (!trees.length) {
      await ctx.log(
        "system",
        "verification skipped: the agent prepared no worktree (no code was changed)",
      );
      metrics.verification = {
        outcome: "skipped",
        status: "skipped",
        passed: null,
      };
      await ctx.recordMetrics(metrics as unknown as Record<string, unknown>).catch(() => {});
      return {
        kind: "failed",
        retryable: false,
        error: "Mandatory verification cannot run: no worktree was prepared",
        details: {
          submitted: output,
          verification: {
            outcome: "skipped",
            status: "skipped",
            passed: null,
            reason: "no worktree: no code was changed",
          },
        },
      };
    }
    const env = {
      BASE_BRANCH: config.baseBranch,
      RUN_ID: String(ctx.run.id),
    };
    const deps: VerifyDeps = {
      run: async (cmd, cwd, vars, ...args) =>
        runCommand(cmd, cwd, { ...vars, BASE_BRANCH: await workspaceBaseBranch(cwd) }, ...args),
      replayEnvironment: async (cwd, vars) => ({
        ...vars,
        BASE_BRANCH: await workspaceBaseBranch(cwd),
      }),
      knownFailures: (p) => knownBaseFailures(p),
      baseline: async (repo, failing) =>
        (
          await goBaseline(repo.path, failing, async (cmd, dir) =>
            runCommand(
              cmd,
              dir,
              {
                ...env,
                REPO: repo.repo,
                BASE_BRANCH: await repositoryBaseBranch(repo.repo),
              },
              vcfg.timeoutMs,
              ctx.signal,
              (c) => void ctx.log("log", c, { repo: repo.repo, baseline: true }),
            ),
          )
        ).report,
      diffTests: async (p) => diffTestsAgainstBase(p, await workspaceBaseBranch(p)),
      changedFiles: async (p) =>
        (await changedFiles(p, `origin/${await workspaceBaseBranch(p)}`)).all,
      // Deterministic slop scan of the changed files only; no model call. Settings: config ← global ← repository.
      slop: async (repo) => {
        const settings = await resolveSlopSettings(repo.repo);
        if (settings.mode === "disabled") return null;
        const report = await scanWorkspace({
          path: repo.path,
          baseRef: `origin/${await workspaceBaseBranch(repo.path)}`,
          settings,
          profile: ctx.run.profile,
          signal: ctx.signal,
        });
        return { ...report, mode: settings.mode, blocking: slopBlocking(report, settings) };
      },
      artifact: (name, content, data) =>
        ctx.artifact("log", name, content, { ...data, verification: true }),
      log: (text, data) => void ctx.log(data?.stream ? "log" : "system", text, data ?? null),
      // Rebuilt from the live worktree on every verification, so resume, retry and handoff trust no in-memory state.
      ...(ctx.step.replay_forced
        ? {}
        : {
            evidence: new EvidenceCache(pgEvidenceStore(pool), {
              runId: ctx.run.id,
              stepKey: ctx.step.key,
              attemptId: ctx.attempt?.id ?? null,
            }),
          }),
    };
    let accepted = output;
    const loop = await verificationLoop<ExecResult>({
      cfg: vcfg,
      prior: [...rounds], // rounds keeps the full history (prior + new) for the pause checkpoint
      signal: ctx.signal,
      verify: async (n) => {
        const r = await verifyWorkspaces(
          trees.map((w) => ({
            repo: w.repo,
            path: w.path,
            branch: w.branch,
            skip: unrestored.get(w.repo),
          })),
          trees.map((w) => w.path),
          vcfg,
          n,
          ctx.signal,
          deps,
          env,
        );
        rounds.push(r);
        return r;
      },
      // A repair that changed nothing cannot change the result: stop instead of re-running the whole verification.
      unchanged: async (failed) => {
        const same = await sourceUnchangedSince(
          trees.map((w) => ({ repo: w.repo, path: w.path })),
          failed,
        );
        if (same)
          await noteDecision({
            runId: ctx.run.id,
            stepId: ctx.step.id,
            attemptId: ctx.attempt.id,
            generation: ctx.attempt.generation,
            kind: "recovery",
            action: "STOP",
            outcome: "applied",
            reason: `repair ${failed.round} changed no source (HEAD and uncommitted content identical to the failed verification): not re-run, no progress`,
            savedMs: failed.duration_ms ?? null,
            details: { round: failed.round, signature: failed.signature },
          });
        return same;
      },
      repair: async (failed, n) => {
        await ctx.log(
          "system",
          `verification failed — repair ${n}/${vcfg.maxRepairs} in the same ${provider} session`,
          { verification: failed.round, provider },
        );
        const sid = (
          await one(
            pool,
            "SELECT session_id FROM agent_sessions WHERE attempt_id = $1 AND provider = $2 AND resumable ORDER BY id DESC LIMIT 1",
            [ctx.attempt.id, provider],
          )
        )?.session_id;
        const msg = repairPrompt(failed, n, vcfg, outputLocale(ctx.run));
        s.submitted = undefined;
        // Every repair round re-reads the whole session; under context pressure, continue in a fresh session
        // reconstructed from platform state (pack + workspace + this verification) instead of growing it further.
        const pressure = compactionDecision({
          provider,
          model: s.routed.model,
          occupancy: metrics.context_window?.last_tokens,
        });
        let compacted: Awaited<ReturnType<typeof run>> | null = null;
        if (sid && pressure.compact) {
          await q(
            pool,
            "UPDATE agent_sessions SET resumable = false WHERE session_id = $1 AND provider = $2",
            [sid, provider],
          );
          await ctx.log(
            "system",
            `repair ${n}: compacting the ${provider} session (${pressure.reason}); continuing in a fresh session reconstructed from platform state`,
            { provider, compaction: pressure },
          );
          metrics.compactions = [
            ...(metrics.compactions ?? []),
            {
              boundary: "repair",
              round: n,
              pressure: pressure.pressure,
              occupancy: pressure.occupancy,
              window: pressure.window,
            },
          ];
          const state = sessionStateBlock({
            reason: pressure.reason,
            worktree: await worktreeState(ws),
            verification: failed.repos.map((x) => ({
              repo: x.repo,
              status: x.status,
              note: x.note,
              regressions: x.regressions,
              excerpt: x.excerpt,
            })),
            artifacts: await attemptArtifacts(ctx.attempt.id).catch(() => []),
            previousAttemptId: ctx.attempt.id,
          });
          compacted = await run(`${freshPrompt()}\n\n${state}\n\n${msg}`);
        }
        let r: Awaited<ReturnType<typeof run>> | null = compacted
          ? compacted
          : sid
            ? await run(msg, sid).catch((e) => {
                if (ctx.signal.aborted) throw e;
                return {
                  isError: true,
                  text: (e as Error).message,
                  assistantTurns: 0,
                };
              })
            : null;
        // Session gone: rebuild the context from durable inputs (same prompt as a fresh attempt) plus the diagnostics.
        if (!r || (r.isError && r.assistantTurns === 0 && !blocksRebuild(r.failure))) {
          if (sid)
            await ctx.log(
              "system",
              `repair could not continue ${provider} session ${sid}; rebuilding context from persisted step history`,
              { provider, recovery: "rebuild_from_checkpoint" },
            );
          r = await run(`${freshPrompt()}\n\n${msg}`);
        }
        const budgetStopped = budgetStop(s, r);
        if (budgetStopped) return budgetStopped;
        if (r.isError) return failedTurn(r, `repair ${n} failed: ${r.text || "agent run failed"}`);
        if (await openQuestions()) return pause(r.text);
        const terminalRepair = terminalCodingFailure(s.submitted);
        if (terminalRepair) return terminalRepair;
        if (s.submitted) accepted = s.submitted;
        if (ctx.run.profile === "MICRO") {
          const check = await assessMicroScope();
          if (check.escalate) return check.result;
        }
        return undefined;
      },
    });
    const summary = verificationSummary(vcfg, loop);
    metrics.verification = summary;
    const reused = (summary as { evidence?: { reused?: number; hits?: number; saved_ms?: number } })
      .evidence;
    if (reused?.reused || reused?.hits)
      await noteDecision({
        runId: ctx.run.id,
        stepId: ctx.step.id,
        attemptId: ctx.attempt.id,
        generation: ctx.attempt.generation,
        kind: "verification_reuse",
        action: "REUSE",
        outcome: "applied",
        reason: `verification evidence reused ${reused.reused ?? reused.hits} time(s)`,
        savedMs: reused.saved_ms ?? null,
        details: { evidence: reused },
      });
    await ctx.recordMetrics(metrics as unknown as Record<string, unknown>).catch(() => {});
    if (loop.outcome === "canceled") throw new Error("verification canceled");
    if (loop.stop) return loop.stop;
    if (loop.outcome === "error")
      return {
        kind: "failed",
        error: `verification could not complete (not a code failure, the agent was not asked to repair): ${summary.errors.join(" | ")}`,
        retryable: false,
        details: { verification: summary },
      };
    const skipped = summary.last
      .filter((x) => x.status === "skipped")
      .map((x) => `${x.repo} (${x.note})`);
    if (loop.outcome === "skipped")
      await ctx.log(
        "system",
        `verification skipped: the tests could not run in ${skipped.join(", ")}, so they were not verified (${loop.repairs ? `${loop.repairs} repair(s) ran for other failures` : "no repair was attempted"}) — needs human review: ${summary.review_reasons.join("; ")}`,
        { verification: "skipped" },
      );
    else if (!summary.passed) {
      const failing = summary.last
        .filter((x) => !x.passed && x.status !== "skipped")
        .map(
          (x) =>
            `${x.repo}: ${
              x.slop?.blocking.length
                ? `slop: ${x.slop.blocking
                    .slice(0, 8)
                    .map((f) => `${f.rule} ${f.path}:${f.line}${f.symbol ? ` ${f.symbol}` : ""}`)
                    .join(
                      ", ",
                    )}${x.slop.blocking.length > 8 ? ` (+${x.slop.blocking.length - 8} more)` : ""}; `
                : ""
            }${x.weakened.length ? `tests weakened (${x.weakened.join(", ")})` : x.regressions.map((g) => [g.package.split("/").slice(-2).join("/"), ...g.tests, ...g.build_errors].slice(0, 4).join(" ")).join("; ") || (x.timed_out ? "timeout" : `exit ${x.exit_code}`)}`,
        );
      const why =
        loop.outcome === "no_progress"
          ? loop.reason === "unchanged_source"
            ? "made no progress (the repair changed no source; verification was not re-run)"
            : "made no progress (same failures twice)"
          : `still failing after ${loop.repairs} repair(s)`;
      return {
        kind: "failed",
        error: `verification ${why} — ${failing.join(" | ")}${skipped.length ? ` — tests did not run in ${skipped.join(", ")}` : ""}`,
        retryable: false,
        details: { verification: summary },
      };
    }
    if (
      summary.passed &&
      summary.slop &&
      summary.slop.mode !== "enforcement" &&
      summary.slop.counts.new + summary.slop.counts.worsened > 0
    )
      await ctx.log(
        "system",
        `slop detection (${summary.slop.mode}): ${summary.slop.counts.new} new, ${summary.slop.counts.worsened} worsened finding(s) reported, not blocking`,
        { slop: summary.slop.counts },
      );
    if (summary.passed && summary.needs_review)
      await ctx.log(
        "system",
        `verification passed but needs human review: ${summary.review_reasons.join("; ")}`,
        { verification: "needs_review" },
      );
    output = { ...accepted, verification: summary, ...(await rootCauseEvidence(s, accepted)) };
    const terminalVerifiedSubmission = terminalCodingFailure(output);
    if (terminalVerifiedSubmission) return terminalVerifiedSubmission;
    if (ctx.run.profile === "MICRO") {
      const check = await assessMicroScope();
      if (check.escalate) return check.result;
    }
  }
  Object.assign(s, { output, unrestored });
}

/**
 * Root Cause First evidence of a verified implementation: symptom-fix signals in each worktree's diff (platform-computed)
 * and the implementer's remediation, normalized. Both are recorded on the step output for the independent review gate.
 */
async function rootCauseEvidence(s: LifecycleState, accepted: unknown) {
  const depth = rootCauseDepth(s.ctx.run, s.ctx.step);
  const signals: Record<string, SymptomSignal[]> = {};
  for (const w of s.ws) {
    const diff = await diffAgainstBase(w.path, await workspaceBaseBranch(w.path)).catch(() => "");
    const found = symptomFixSignals(diff);
    if (found.length) signals[w.repo] = found;
  }
  const remediation = normalizeRemediation(
    (accepted as { remediation?: unknown } | null)?.remediation,
    depth,
  );
  // Platform-run before/after proof for a claimed fix (standard/strict); one targeted test, bounded by the verify timeout.
  let regression_proof: Awaited<ReturnType<typeof beforeAfterProof>> | undefined;
  const testName = remediation?.regression_test?.name;
  if (
    depth !== "light" &&
    testName &&
    (remediation?.kind === "ROOT_CAUSE_FIX" || remediation?.kind === "PARTIAL_FIX")
  ) {
    const scoped = testName.includes("::") ? testName.slice(0, testName.indexOf("::")) : null;
    for (const w of s.ws.filter((x) => !scoped || x.repo === scoped)) {
      regression_proof = await beforeAfterProof(
        { repo: w.repo, path: w.path, baseBranch: await workspaceBaseBranch(w.path) },
        testName,
        async (cmd, cwd) =>
          runCommand(
            cmd,
            cwd,
            { BASE_BRANCH: await workspaceBaseBranch(w.path), RUN_ID: String(s.ctx.run.id) },
            verifyConfig(s.ctx.step.config, TEST_COMMAND)?.timeoutMs ?? 600_000,
            s.ctx.signal,
          ),
      );
      if (regression_proof.status !== "unmeasured" || scoped) break;
    }
    await s.ctx.log(
      "system",
      `regression proof (${testName}): ${regression_proof?.status ?? "unmeasured"} — ${regression_proof?.reason ?? "no worktree"}`,
      { regression_proof },
    );
  }
  const count = Object.values(signals).flat().length;
  if (count || remediation?.problems.length)
    await s.ctx.log(
      "system",
      `root cause first (${depth}): ${count} symptom-fix signal(s)${remediation ? `, remediation ${remediation.kind ?? "unclassified"}${remediation.problems.length ? ` (${remediation.problems.join("; ")})` : ""}` : ""} — judged by the independent review`,
      { symptom_signals: signals, remediation },
    );
  return {
    ...(count ? { symptom_signals: signals } : {}),
    ...(remediation ? { remediation } : {}),
    ...(regression_proof ? { regression_proof } : {}),
  };
}
