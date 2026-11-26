import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import { guaranteeCheck, providerCapabilities } from "../../providerCapabilities.ts";
import { probePreflightCapability } from "../../providerProbes.ts";
import { probeIsolation } from "../../isolation.ts";
import { one, pool } from "../../../db/pool.ts";
import { config } from "../../../config.ts";
import {
  type WorkspaceConflict,
  installNodeDependencies,
  restoreMissingWorkspaces,
  runWorkspaceConflict,
  workspaceConflictQuestion,
} from "../../../git/provider.ts";
import { assertSelfCodingIsolation, isSelfRepository } from "../../../platform/selfDevelopment.ts";
import { repositories } from "../../../repos/service.ts";
import { checkoutForRun, prepareRepository } from "../../../repos/workspaces.ts";
import { resolveSourceRevisions } from "../../../workflow/sourceRevision.ts";
import { validateMicroWorkspace } from "../../../workflow/microEvidence.ts";
import { executionWorkspaces } from "../../implementationEvidence.ts";
import { outputLocale } from "../../language.ts";
import { attemptIsLive } from "../../platformTools.ts";
import { selectedSkills } from "../../skillTracing.ts";
import { resolveStepAgent } from "../../stepAgent.ts";
import { normalizeProviderFailure } from "../../telemetry.ts";
import { noteDecision } from "../../../workflow/decisions.ts";

/** Readiness before any agent turn: configuration, repositories, provider capability, workspaces, MICRO admission. */
export async function preflightStage(s: LifecycleState): Promise<ExecResult | void> {
  const { ctx, live, mode } = s;
  if (ctx.run.agent_configuration === null && !ctx.attempt?.effective_agent)
    return {
      kind: "waiting_input",
      questions: [
        {
          question: "Recover configuration for this historical run?",
          context:
            "This run has no run-start configuration snapshot and this step has no durable effective settings. Original inherited defaults are unknown. Continuing explicitly freezes current settings for remaining steps; existing attempts stay unchanged.",
          options: ["Use current configuration for remaining steps"],
        },
      ],
      checkpoint: { agent_configuration_recovery: true },
    };
  const effective = ctx.attempt?.effective_agent ?? resolveStepAgent(ctx.run, ctx.step)!;
  const provider = effective.provider;
  const unavailable = ctx.context?.unavailableSkills ?? [];
  if (unavailable.length) {
    await ctx.recordMetrics({ skills: selectedSkills(ctx.context) });
    return {
      kind: "failed",
      error: `Assigned skill cannot run with provider ${provider} on this platform: ${unavailable
        .map((u) => `${u.key} (${u.reason})`)
        .join(
          "; ",
        )}. Remove the assignment or run the step with a provider/runtime that supports it.`,
      retryable: false,
    };
  }
  {
    const checkouts: Record<string, string> = {};
    const branches: Record<string, string> = {};
    for (const name of live ? [] : ctx.run.selected_repositories) {
      const repo = await repositories.get(name);
      if (repo) branches[name] = repo.default_branch || config.baseBranch;
      try {
        if (!repo?.enabled || !repo.allowed_actions.includes(mode === "coding" ? "write" : "read"))
          throw new Error(`Repository ${name} is unavailable or unauthorized`);
        checkouts[name] = await prepareRepository(
          repo,
          false,
          await checkoutForRun(repo, ctx.run.id),
        );
      } catch (e) {
        const en = outputLocale(ctx.run) === "en";
        return {
          kind: "waiting_input",
          questions: [
            {
              question: en
                ? `Local checkout setup required: ${(e as Error).message}`
                : `Cần cấu hình checkout cục bộ: ${(e as Error).message}`,
              context: en
                ? "Fix this installation's repositories mapping/checkout, then continue on the assigned worker. Shared authorization is unchanged."
                : "Sửa cấu hình repositories/checkout trên máy được giao, sau đó tiếp tục. Quyền repository dùng chung không thay đổi.",
              options: en ? ["Local checkout fixed — continue"] : ["Đã sửa checkout — tiếp tục"],
            },
          ],
          checkpoint: { local_setup: { repository: name } },
        };
      }
    }
    // One source revision per run: the first source step pins the (fresh) base; later steps compare with it.
    if (Object.keys(checkouts).length) {
      s.revisions = await resolveSourceRevisions({
        runId: ctx.run.id,
        stepId: ctx.step.id,
        stepKey: ctx.step.key,
        attemptId: ctx.attempt.id,
        generation: ctx.attempt.generation,
        mode,
        checkouts: Object.fromEntries(
          Object.entries(checkouts).map(([n, path]) => [n, { path, branch: branches[n] }]),
        ),
      });
      await ctx.recordMetrics({
        source_revision: Object.fromEntries(
          s.revisions.map((v) => [
            v.repo,
            {
              pinned: v.pinned.commit,
              read: mode === "coding" ? v.pinned.commit : v.head,
              drift: v.drift,
            },
          ]),
        ),
      });
    }
    // A worktree another run left on this run's branch: decide before the agent starts, so no attempt is spent on it.
    if (mode === "coding" && ctx.step.config?.isolated_workspace !== true) {
      const approved = (ctx.input.pending?.workspace_release?.holders ?? []) as string[];
      const blocking: WorkspaceConflict[] = [];
      for (const [name, checkout] of Object.entries(checkouts)) {
        const conflict = await runWorkspaceConflict(ctx.run, name, checkout);
        if (
          conflict &&
          conflict.release !== "auto" &&
          !(conflict.release === "approval" && approved.includes(conflict.holder_path))
        )
          blocking.push(conflict);
      }
      if (blocking.length)
        return workspaceConflictQuestion(blocking, outputLocale(ctx.run) === "en");
    }
  }
  // Enforced isolation: effective guarantees from the runtime probe, checked for every provider (Claude included).
  const enforce = config.isolation.mode === "enforce";
  const runtime = enforce ? await probeIsolation() : null;
  const guarantees = guaranteeCheck(provider, mode, effective.options, {
    enforce,
    runtimeAvailable: !!runtime?.available,
  });
  s.guarantees = guarantees;
  if (enforce && guarantees.unmet.length)
    return {
      kind: "failed",
      retryable: false,
      error: !runtime?.available
        ? `Agent isolation is enforced but this host cannot provide it: ${runtime?.problems.join("; ")}. Fix the host (docs/architecture/agent-isolation.md); the platform does not run agents unsandboxed in this mode.`
        : `Agent isolation is enforced and ${provider} cannot run inside the sandbox yet (missing ${guarantees.unmet.join(", ")}). Use Claude for this step, or switch isolation.mode to "off" only on a trusted single-operator host (unattended work then stays disabled).`,
      details: { failure_code: "GUARANTEE_UNMET", guarantees, isolation: runtime },
    };
  if (enforce && provider === "claude" && !config.agentEnv.claudeOauthToken)
    return {
      kind: "failed",
      retryable: false,
      error:
        "Agent isolation is enforced: the sandboxed Claude CLI cannot read the host login (~/.claude is hidden). Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for the worker (subscription; API keys are never passed).",
      details: { failure_code: "GUARANTEE_UNMET", isolation: runtime },
    };
  const caps = providerCapabilities(provider);
  // Checked BEFORE anything runs: subagent delegation cannot be held to a provider's missing delegation sandbox.
  if (
    !caps.guarantees.delegation &&
    ctx.run.profile !== "MICRO" &&
    (ctx.step.config.delegation as { enabled?: boolean } | undefined)?.enabled === true
  )
    return {
      kind: "failed",
      error: `${caps.cliLabel} cannot enforce the platform's read-only subagent policy (delegation is unsupported for this provider). Disable delegation on the step, or create the run with Claude. The platform does not fall back to another provider.`,
      retryable: false,
    };
  if (ctx.run.profile === "MICRO" && !caps.guarantees.microProfile)
    return {
      kind: "profile_escalation",
      request: {
        target: "STANDARD",
        risk: "unknown",
        reason: `${caps.shortLabel} cannot enforce pre-execution tool boundaries required by MICRO profile`,
        expectedRevision:
          (
            ctx.run.graph as
              | (import("../../../workflow/types.ts").WorkflowSpec & {
                  profile_revision?: number;
                })
              | undefined
          )?.profile_revision ?? 0,
      },
    };
  if (guarantees.unmet.length)
    return {
      kind: "failed",
      retryable: false,
      error: `Provider ${provider} cannot enforce ${guarantees.unmet.join(", ")}, which ${mode === "coding" ? "implementation" : "this"} step requires. Run the step with a provider that enforces them; the platform does not fall back to another provider.`,
      details: { failure_code: "GUARANTEE_UNMET", guarantees },
    };
  if (guarantees.degraded.length)
    await ctx.log(
      "system",
      `${provider} runs this read-only step without ${guarantees.degraded.join(", ")}`,
      { guarantees },
    );
  if (caps.runtime.preflightProbe) {
    const cap = await probePreflightCapability(provider, {
      model: effective.model ?? "",
      effort: effective.reasoning_effort ?? "",
    });
    if (!cap.ok)
      return {
        kind: "failed",
        error: cap.error || `${caps.cliLabel} is not usable`,
        retryable: false,
        details: {
          provider_error: {
            code:
              normalizeProviderFailure(cap.error) === "AUTHENTICATION"
                ? "authentication"
                : "agent_error",
            message: cap.error,
          },
        },
      };
  }
  if (mode === "coding") {
    for (const name of ctx.run.selected_repositories ?? []) {
      const row = await repositories.get(name);
      if (!row || !(await isSelfRepository(row))) continue;
      try {
        assertSelfCodingIsolation(provider);
      } catch (e) {
        return { kind: "failed", error: (e as Error).message, retryable: false };
      }
      break;
    }
  }
  const restoreWorkspaces = async () => {
    // A provider bridge can select another allowed repository during its turn. Verification must include it.
    const current = await one<{ selected_repositories: string[] }>(
      pool,
      "SELECT selected_repositories FROM workflow_runs WHERE id=$1",
      [ctx.run.id],
    );
    if (!current) throw new Error("Run not found while refreshing verification repositories");
    ctx.run.selected_repositories.splice(
      0,
      ctx.run.selected_repositories.length,
      ...current.selected_repositories,
    );
    return restoreMissingWorkspaces(ctx.run, ctx.run.selected_repositories, {
      log: (m) => ctx.log("system", m),
      onRestored: (w, ms) =>
        noteDecision({
          runId: ctx.run.id,
          stepId: ctx.step.id,
          attemptId: ctx.attempt.id,
          generation: ctx.attempt.generation,
          kind: "restore",
          action: "RESTORE",
          outcome: "applied",
          reason: `restored missing worktree ${w.repo} on ${w.branch}; committed work kept`,
          latencyMs: ms,
          details: { repo: w.repo, branch: w.branch },
        }),
      en: outputLocale(ctx.run) === "en",
      approvedReleases: (ctx.input.pending?.workspace_release?.holders ?? []) as string[],
      checkLive: async () => {
        const live = await attemptIsLive(ctx.attempt.id, ctx.attempt.fencing_token);
        if (!live.ok) throw new Error(live.reason);
      },
    });
  };
  if (mode === "coding") {
    const blocked = await restoreWorkspaces();
    if (blocked) return blocked;
  }
  const ws = (await executionWorkspaces(ctx)).filter(
    (w) => !ctx.run.selected_repositories.length || ctx.run.selected_repositories.includes(w.repo),
  );
  if (mode === "coding" && !live) {
    for (const w of ws) {
      if (await installNodeDependencies(w.path))
        await ctx.log("system", `installed Node dependencies in ${w.repo}`);
    }
  }
  if (ctx.run.profile === "MICRO") {
    for (const workspace of ws)
      if (
        !(await validateMicroWorkspace(
          workspace.path,
          ctx.step.config.micro_source_revision,
          ctx.step.config.micro_hashes,
        ))
      )
        return {
          kind: "profile_escalation",
          request: {
            target: "STANDARD",
            risk: "unknown",
            reason: "prepared workspace no longer matches verified admission evidence",
            expectedRevision:
              (
                ctx.run.graph as
                  | (import("../../../workflow/types.ts").WorkflowSpec & {
                      profile_revision?: number;
                    })
                  | undefined
              )?.profile_revision ?? 0,
          },
        };
  }
  Object.assign(s, { effective, provider, ws, restoreWorkspaces });
}
