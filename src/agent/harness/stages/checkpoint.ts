import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import { config } from "../../../config.ts";
import { one, pool } from "../../../db/pool.ts";
import { repositoryBaseBranch } from "../../../repos/service.ts";
import { SINCE_HUMAN_REEXECUTE, execP, resumableSession } from "../../claude.ts";
import { approvedScopeIn } from "../../evidence.ts";
import { executionWorkspaces, implementationBaseline } from "../../implementationEvidence.ts";
import {
  collectEvidence,
  enforceVerdict,
  hasTestEvidence,
  incrementalCheckpoint,
  incrementalReviewBrief,
  repairDiff,
  reusablePass,
  testDigestOf,
  verificationKey,
} from "../../independentReview.ts";
import { outputLocale } from "../../language.ts";

/** Checkpoint selection: implementation baseline, resumable session, and for independent review the prior verdict to reuse or re-review incrementally. */
export async function checkpointStage(s: LifecycleState): Promise<ExecResult | void> {
  const { ctx, mode, independent, policy, cwd, provider, ws } = s;
  if (mode === "coding" && !independent) {
    s.implementationStart = await implementationBaseline(ctx);
    policy.workspaces = (await executionWorkspaces(ctx)).map((w) => w.path);
  }
  // Independent verification never continues an earlier conversation: fresh session, platform evidence only.
  const resume = independent ? null : await resumableSession(ctx, cwd, provider);
  let reviewKey: string | null = null;
  const baseTips = s.baseTips;
  let incremental: LifecycleState["incremental"] = null;
  let evidence: LifecycleState["evidence"] = null;
  if (independent) {
    if (ctx.step.config.strict === true && !hasTestEvidence(ctx.input.upstream))
      return enforceVerdict(
        {
          verdict: "BLOCKED",
          findings: [],
          summary: "",
          blocked_reason:
            outputLocale(ctx.run) === "vi"
              ? "Xác minh strict cần kết quả test thật từ bước test phía trước, nhưng chưa có bước nào chạy."
              : "Strict verification requires real test evidence from an upstream test step, and none ran.",
        },
        { repairsUsed: 0, maxRepairs: 0, repairTarget: null, heads: {} },
      );
    evidence = await collectEvidence(
      await Promise.all(
        ws.map(async (w) => ({
          repo: w.repo,
          path: w.path,
          baseBranch: await repositoryBaseBranch(w.repo),
        })),
      ),
      config.baseBranch,
    );
    // A verdict must bind to exact commits: never verify uncommitted or unreadable state (the PR could not match it).
    if (evidence.problems.length)
      return enforceVerdict(
        {
          verdict: "BLOCKED",
          findings: [],
          summary: "",
          blocked_reason: `the code under review is not bound to a commit: ${evidence.problems.join("; ")}`,
        },
        { repairsUsed: 0, maxRepairs: 0, repairTarget: null, heads: {} },
      );
    if (!ws.length) evidence.text = "(no worktree: the coding step changed no code)";
    // Skip a redundant review only when the exact commits, base, diff, test evidence, approved scope and review policy
    // already produced a PASS; any relevant change yields a new key and a fresh review.
    for (const w of ws) {
      const base = await repositoryBaseBranch(w.repo).catch(() => config.baseBranch);
      baseTips[w.repo] = await execP("git", ["-C", w.path, "rev-parse", `origin/${base}`])
        .then((r) => r.stdout.trim())
        .catch(() => "");
    }
    const scopeNow = approvedScopeIn(ctx.input.upstream);
    reviewKey = verificationKey({
      heads: evidence.heads,
      baseTips,
      diffText: evidence.text,
      tests: testDigestOf(ctx.input.upstream),
      scope: scopeNow
        ? [
            scopeNow.proposal_hash,
            Object.values(ctx.input.upstream).map(
              (u: any) => u.output?.scope_check?.reapproved?.revision ?? null,
            ),
          ]
        : null,
      stepConfig: ctx.step.config,
      provider,
    });
    const prior = await one<{ id: number; output: any }>(
      pool,
      "SELECT id, output FROM workflow_step_attempts WHERE step_id = $1 AND status = 'COMPLETED' AND output->>'verification_key' = $2 ORDER BY id DESC LIMIT 1",
      [ctx.step.id, reviewKey],
    );
    // A human asking for a fresh review (feedback / re-execute) always gets one.
    const humanAsked = !!(ctx.input.pending?.feedback || ctx.input.pending?.reexecute);
    if (!humanAsked && reusablePass(prior, reviewKey, evidence.heads)) {
      await ctx.log(
        "system",
        `independent verification: PASS reused from attempt #${prior!.id} — same commits, diff, tests, scope and review policy`,
      );
      return {
        kind: "completed",
        output: {
          ...prior!.output,
          reused_from_attempt: prior!.id,
          reused_at: new Date().toISOString(),
        },
      };
    }
    // After an automatic repair round, re-check only the previous findings and the repair commits.
    const checkpoint = humanAsked
      ? null
      : incrementalCheckpoint(
          await one<{ id: number; output: any }>(
            pool,
            `SELECT a.id, a.output FROM workflow_step_attempts a
              WHERE a.step_id = $1 AND a.output->>'verdict' IS NOT NULL AND ${SINCE_HUMAN_REEXECUTE}
              ORDER BY a.id DESC LIMIT 1`,
            [ctx.step.id, ctx.run.id],
          ),
          evidence.heads,
          baseTips,
        );
    const diff = checkpoint ? await repairDiff(ws, checkpoint.heads).catch(() => null) : null;
    if (checkpoint && diff !== null) {
      incremental = {
        brief: incrementalReviewBrief(checkpoint),
        diff,
        attemptId: checkpoint.attemptId,
      };
      await ctx.log(
        "system",
        `independent verification: incremental re-review of the repair since FAIL attempt #${checkpoint.attemptId}`,
      );
    }
  }
  Object.assign(s, { resume, reviewKey, incremental, evidence });
}
