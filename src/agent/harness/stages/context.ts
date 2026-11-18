import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import { config } from "../../../config.ts";
import { ContextBudgetError, ensureContextPack } from "../../../context/pack.ts";
import { protectedRootsFor } from "../../../platform/selfDevelopment.ts";
import { runWorkingDirectory } from "../../../repos/workspaces.ts";
import { SUBAGENTS } from "../../claude.ts";
import { isIndependent } from "../../independentReview.ts";
import { languagePolicy, outputLocale } from "../../language.ts";
import { newMetrics } from "../../metrics.ts";
import { selectedSkills } from "../../skillTracing.ts";
import {
  type PolicyContext,
  SUBAGENT_PLATFORM_TOOLS,
  ToolLoopDetector,
  toolsFor,
  CI_PATHS,
  verifyPathTokens,
} from "../../toolPolicy.ts";
import { integrationTools } from "../../toolRegistry.ts";
import { verifyConfig } from "../../verify.ts";
import { TEST_COMMAND } from "../../../workflow/templates.ts";

/** Tool policy, routing, metrics and the context pack (reused when its inputs are unchanged). */
export async function contextStage(s: LifecycleState): Promise<ExecResult | void> {
  const { ctx, live, mode, effective, provider, ws } = s;
  const delegationCfg = ctx.step.config.delegation as
    { enabled?: boolean; agents?: string[] } | undefined;
  const delegation = ctx.run.profile !== "MICRO" && delegationCfg?.enabled === true;
  const policy: PolicyContext = {
    ...(ctx.run.profile === "MICRO"
      ? {
          micro: {
            files: Array.isArray(ctx.step.config.micro_scope)
              ? (ctx.step.config.micro_scope as string[])
              : [],
            calls: 0,
            limit: 20,
            exhausted: false,
          },
        }
      : {}),
    mode,
    workspaces: ws.map((w) => w.path),
    baseBranch: config.baseBranch,
    protectedRoots: protectedRootsFor([
      config.reposRoot,
      ...(ctx.context.repoPaths ?? []).map((r) => r.path),
    ]),
    delegation,
    isReadOnlyIntegration: (name) =>
      integrationTools().find((t) => t.name === name)?.readOnly === true,
    loopDetector: new ToolLoopDetector(),
    network: mode !== "coding" || ctx.step.config.network === true,
    protectedPaths:
      ctx.step.config.allow_ci_edits === true
        ? []
        : [
            ...CI_PATHS,
            ...verifyPathTokens(
              (ctx.input.execution_contract?.verification as { command?: string } | undefined)
                ?.command ?? verifyConfig(ctx.step.config, TEST_COMMAND)?.command,
            ),
          ],
  };
  const settingSources = live ? [] : config.agent.settingSources;
  policy.allowedTools = effective.allowed_tools;
  const nativeTools = toolsFor(mode, {
    delegation,
    claudeSkills: settingSources.length > 0,
  }).filter((t) => effective.allowed_tools == null || effective.allowed_tools.includes(t));
  const agents = delegation
    ? Object.fromEntries(
        (delegationCfg?.agents ?? Object.keys(SUBAGENTS))
          .filter((n) => SUBAGENTS[n])
          .map((n) => [
            n,
            {
              ...SUBAGENTS[n],
              prompt: `${SUBAGENTS[n].prompt}\n\n${languagePolicy(outputLocale(ctx.run))}`,
              tools: ["Read", "Grep", "Glob", "Bash", ...SUBAGENT_PLATFORM_TOOLS],
            },
          ]),
      )
    : undefined;
  // Each provider resolves its own model: a Claude model id is never sent to Cursor, Codex or Antigravity.
  const routed: { model: string; source: string; effort?: string } = {
    model: effective.model ?? "",
    source: effective.source,
    effort: effective.reasoning_effort ?? undefined,
  };
  const metrics = newMetrics(routed.model || (provider === "claude" ? "default" : ""));
  metrics.skills = selectedSkills(ctx.context);
  metrics.model_source = routed.source;
  metrics.provider = provider;
  if (routed.effort) metrics.reasoning_effort = routed.effort;
  if (provider !== "claude") {
    metrics.cost_usd = null;
    metrics.tokens = null;
  }
  for (const d of ctx.context.disclosure) metrics.disclosure[d.disclosure]++;
  for (const u of Object.values(ctx.context.upstream.plan)) metrics.upstream[u.mode]++;
  const cwd = live?.cwd ?? (await runWorkingDirectory(ctx.run.id, ctx.step.id));
  const independent = isIndependent(ctx.step.config);
  Object.assign(s, {
    policy,
    delegation,
    settingSources,
    nativeTools,
    agents,
    routed,
    metrics,
    cwd,
    independent,
  });
  try {
    ctx.context.contextPack = await ensureContextPack(ctx, metrics, policy);
  } catch (error) {
    if (error instanceof ContextBudgetError)
      return { kind: "failed", error: error.message, retryable: false };
    throw error;
  }
}
