import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import { one, pool } from "../../../db/pool.ts";
import { workspaceBase } from "../../../git/provider.ts";
import { validateOutputContract } from "../../contract.ts";
import { SCOPE_REAPPROVAL_QUESTION, approvedScopeIn, scopeCheck } from "../../evidence.ts";
import { validateExecutionAuthorization } from "../../executionContract.ts";
import {
  executionWorkspaces,
  implementationChanged,
  loadImplementationBaseline,
  observeImplementation,
} from "../../implementationEvidence.ts";
import { firstUsefulLocationMs } from "../../metrics.ts";
import {
  SCOPE_REVISION_TAG,
  collectScopeState,
  renewedApprovalFor,
  scopeRevision,
  worktreeFingerprint,
} from "../../scopeGuard.ts";

/** Approved-scope integrity, implementation evidence, final contract validation and the step result. */
export async function finalizeStage(s: LifecycleState): Promise<ExecResult | void> {
  const { ctx, mode, independent, metrics, unrestored, terminalCodingFailure } = s;
  let output = s.output;
  let implementationStart = s.implementationStart;
  // Approved scope integrity, deterministic: what git says changed (committed, staged, unstaged, untracked — after the
  // final verification round) vs the human-approved scope. Any violation needs a renewed approval bound to the exact
  // revision; the PR step re-validates it. The agent's own deviation report is recorded but never relied on.
  if (mode === "coding" && !independent) {
    const all = (await executionWorkspaces(ctx)).filter((w) => !unrestored.has(w.repo));
    const state = await collectScopeState(
      await Promise.all(
        all.map(async (w) => ({
          repo: w.repo,
          path: w.path,
          base: (await workspaceBase(ctx.run, w)).ref,
        })),
      ),
    );
    if (state.unreadable.length)
      return { kind: "failed", retryable: false, error: state.unreadable.join("; ") };
    if (output.outcome === "NO_CHANGE_REQUIRED" || output.no_change_required === true)
      return {
        kind: "failed",
        retryable: false,
        error:
          "NO_CHANGE_REQUIRED needs independent requirement-satisfaction evidence; this executor cannot establish it",
        details: { failure_code: "INVALID_EVIDENCE" },
      };
    const authorizationProblems = await validateExecutionAuthorization(ctx);
    if (authorizationProblems.length)
      return { kind: "failed", retryable: false, error: authorizationProblems.join("; ") };
    const implementationEnd = await observeImplementation(ctx);
    implementationStart = await loadImplementationBaseline(ctx.step.id, ctx.step.generation);
    const branchChanged = Object.values(state.files).some((files) => files.length);
    const attemptChanged =
      !!implementationStart && implementationChanged(implementationStart, implementationEnd);
    // A repair round sent back with feedback may find nothing to change; the branch keeps the earlier observed implementation.
    // Retries of a failed repair round count too: any attempt since the last completed one carried feedback.
    const repairRound =
      !!ctx.input.pending?.feedback ||
      !!(
        await one<{ hit: boolean }>(
          pool,
          `SELECT EXISTS (SELECT 1 FROM workflow_step_attempts
             WHERE step_id = $1 AND input->'pending' ? 'feedback'
               AND id > COALESCE((SELECT max(id) FROM workflow_step_attempts WHERE step_id = $1 AND status = 'COMPLETED'), 0)) AS hit`,
          [ctx.step.id],
        )
      )?.hit;
    if (!branchChanged || (!attemptChanged && !repairRound))
      return {
        kind: "failed",
        retryable: false,
        error: "IMPLEMENTED requires worker-observed implementation changes",
        details: { failure_code: "INVALID_EVIDENCE" },
      };
    if (!attemptChanged) {
      output.no_new_changes = true;
      await ctx.log(
        "system",
        "repair round made no new changes; the branch keeps the earlier implementation",
      );
    }
    const verified = output.verification as
      | {
          passed?: boolean;
          last?: Array<{ repo: string; tested_state?: { head: string; fingerprint: string } }>;
        }
      | undefined;
    for (const workspace of all) {
      const tested = verified?.last?.find((repo) => repo.repo === workspace.repo)?.tested_state;
      const current = await worktreeFingerprint(workspace.path).catch(() => null);
      if (
        !verified?.passed ||
        !tested ||
        !current ||
        JSON.stringify(tested) !== JSON.stringify(current)
      )
        return {
          kind: "failed",
          retryable: false,
          error: `Verification is missing or stale for ${workspace.repo}`,
          details: { failure_code: "INVALID_EVIDENCE" },
        };
    }
    output.implementation_evidence = {
      baseline: implementationStart,
      observed: implementationEnd,
      generation: ctx.step.generation,
      attempt_id: ctx.attempt.id,
    };
    output.execution_contract = ctx.input.execution_contract;
    output.outcome = "IMPLEMENTED";
    // Time to the first useful code location: first read/edit of a file the step finally changed (measured events).
    const changed = Object.values(state.files).flat();
    if (changed.length) {
      metrics.first_useful_location_ms = firstUsefulLocationMs(metrics, changed);
      await ctx
        .recordMetrics({ first_useful_location_ms: metrics.first_useful_location_ms })
        .catch(() => {});
    }
    if (Object.keys(state.heads).length) {
      output = { ...output, commits: state.heads };
      // The harness tested exactly this state (nothing changes after the last verification round).
      if ((output as any).verification?.passed === true)
        output = { ...output, tested_heads: state.heads };
    }
    const scope = approvedScopeIn(ctx.input.upstream);
    if (scope) {
      const revision = scopeRevision(scope.proposal_hash, state.files, state.states);
      const check = scopeCheck(scope, state.files, (output as any).scope_deviations, revision);
      if (state.unreadable.length) {
        check.requires_reapproval = true;
        check.reasons.unshift(...state.unreadable);
      }
      const reapproved = check.requires_reapproval
        ? renewedApprovalFor(ctx.input.answers, SCOPE_REAPPROVAL_QUESTION, revision)
        : null;
      const unchecked = [...unrestored].map(([repo, note]) => `${repo}: ${note}`);
      output = {
        ...output,
        scope_check: {
          ...check,
          reapproved,
          ...(unchecked.length ? { needs_review: true, review_reasons: unchecked } : {}),
        },
      };
      await ctx.log(
        "system",
        `scope check vs approved proposal ${check.approved_proposal_hash} (revision ${revision}): ${check.out_of_scope_files.length} out-of-scope file(s), ${check.invalid_paths.length} invalid path(s), ${check.unauthorized_repos.length} unauthorized repo(s), ${check.deviations.length} declared deviation(s)${check.requires_reapproval ? (reapproved ? " — renewed approval on record for this revision" : " — renewed approval required") : ""}`,
        { scope_check: check },
      );
      if (check.requires_reapproval && !reapproved)
        return {
          kind: "waiting_input",
          output,
          questions: [
            {
              question:
                `${SCOPE_REAPPROVAL_QUESTION} ${SCOPE_REVISION_TAG(revision)}: ${check.reasons.join("; ")}`.slice(
                  0,
                  4000,
                ),
              context: `Approved (${check.approved_risk}): ${scope.summary}`.slice(0, 1500),
              options: [
                "Approve this exact change set (recorded as a renewed approval for this revision only)",
                "Reject: revert the out-of-scope changes and stay inside the approved scope",
              ],
            },
          ],
        } as any;
    }
  }
  if (!independent && (ctx.step.config.output_schema || ctx.step.config.output_contract)) {
    const validation = validateOutputContract(
      ctx.step.config.output_schema ?? ctx.step.config.output_contract,
      output,
    );
    if (!validation.valid)
      return {
        kind: "failed",
        retryable: false,
        error: `Final output contract validation failed: ${validation.errors.join("; ")}`,
        details: { failure_code: "CONTRACT_INVALID" },
      };
  }
  const terminalOutput = terminalCodingFailure(output);
  if (terminalOutput) return terminalOutput;
  return { kind: "completed", output };
}
