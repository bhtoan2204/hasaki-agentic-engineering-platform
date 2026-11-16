import { config } from "../config.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { StepRow } from "../workflow/types.ts";
import { verifyConfig, verifyWorkspaces, type VerifyDeps, type VerifyConfig } from "./verify.ts";
import { executionContractProblems, type MandatoryExecutionContract } from "./executionContract.ts";
import { diffTestsAgainstBase } from "./verify.ts";
import { changedFiles } from "./scopeGuard.ts";
import { workspaceBase } from "../git/provider.ts";
import { goBaseline, knownBaseFailures } from "../workflow/executors/baseline.ts";

/** Historical step evidence proves that step. Publication separately tests the integrated workspace. */
export async function verifyPublication(
  ctx: ExecutionContext,
  steps: Array<
    Pick<StepRow, "key" | "type" | "config" | "status" | "output" | "current_attempt_id">
  >,
  workspaces: Array<{ repo: string; path: string; branch: string }>,
  run: VerifyDeps["run"],
) {
  const problems: string[] = [];
  const tested: Array<{ step: string; heads: Record<string, string> }> = [];
  const verify = async (
    key: string,
    cfg: VerifyConfig,
    trees: typeof workspaces,
    extraEnv: Record<string, string> = {},
  ) => {
    const bases = new Map(
      await Promise.all(
        trees.map(
          async (w) =>
            [w.path, (await workspaceBase(ctx.run, w)).ref.replace(/^origin\//, "")] as const,
        ),
      ),
    );
    const execute: VerifyDeps["run"] = (command, path, env, ...args) =>
      run(
        command,
        path,
        {
          ...extraEnv,
          ...env,
          BASE_BRANCH: bases.get(path) ?? env.BASE_BRANCH ?? config.baseBranch,
          RUN_ID: String(ctx.run.id),
        },
        ...args,
      );
    const round = await verifyWorkspaces(
      trees,
      trees.map((w) => w.path),
      cfg,
      0,
      ctx.signal,
      {
        run: execute,
        knownFailures: knownBaseFailures,
        baseline: async (repo, failing) =>
          (
            await goBaseline(repo.path, failing, (command, path) =>
              execute(
                command,
                path,
                { REPO: repo.repo, BASE_BRANCH: bases.get(repo.path)! },
                cfg.timeoutMs,
                ctx.signal,
              ),
            )
          ).report,
        diffTests: (path) => diffTestsAgainstBase(path, bases.get(path)!),
        changedFiles: async (path) => (await changedFiles(path, `origin/${bases.get(path)!}`)).all,
        artifact: (name, content, data) =>
          ctx.artifact("publication_verification", name, content, data),
        log: (text, data) => ctx.log("system", text, data),
      },
    );
    await ctx.artifact(
      "publication_verification",
      `final regression: ${key}`,
      JSON.stringify(round),
      round,
    );
    if (!round.passed) problems.push(`${key}: final integrated regression failed`);
    else
      tested.push({
        step: `publication:${key}`,
        heads: Object.fromEntries(round.repos.map((r) => [r.repo, r.tested_state!.head])),
      });
  };
  for (const step of steps.filter((s) => s.type === "coding_agent" && s.status === "COMPLETED")) {
    const contract = step.output?.execution_contract as MandatoryExecutionContract | undefined;
    // Pre-contract runs keep the existing commit/patch gate; new executions must carry worker evidence.
    if (!step.output?.verification?.contract_revision) continue;
    if (!contract || contract.provenance?.revision !== step.output.verification.contract_revision) {
      problems.push(`${step.key}: missing immutable execution contract`);
      continue;
    }
    problems.push(
      ...executionContractProblems(contract, ctx.run.allowed_repositories).map(
        (p) => `${step.key}: ${p}`,
      ),
    );
    if (
      contract.selected_repositories.some((repo) => !ctx.run.selected_repositories.includes(repo))
    )
      problems.push(`${step.key}: repository authorization changed`);
    for (const [key, attempt] of Object.entries(contract.provenance!.source_attempts))
      if (steps.find((s) => s.key === key)?.current_attempt_id !== attempt)
        problems.push(
          `${step.key}: authorization source ${key} changed; renewed approval is required`,
        );
    const cfg =
      contract.verification && typeof contract.verification === "object"
        ? { ...(contract.verification as VerifyConfig) }
        : null;
    if (!cfg) {
      problems.push(`${step.key}: mandatory verification disabled`);
      continue;
    }
    cfg.requiredTests = contract.required_tests;
    cfg.contractRevision = contract.provenance!.revision;
    const scope = contract.authorization?.repository_scope ?? contract.selected_repositories;
    if (ctx.run.selected_repositories.some((repo) => !scope.includes(repo))) {
      problems.push(`${step.key}: repository selection requires renewed authorization`);
      continue;
    }
    const trees = workspaces.filter((w) => ctx.run.selected_repositories.includes(w.repo));
    if (trees.length !== ctx.run.selected_repositories.length) {
      problems.push(`${step.key}: missing integration workspace`);
      continue;
    }
    if (problems.length) continue;
    await verify(step.key, cfg, trees);
  }
  // Workflow command steps may carry broader mandatory regressions than the coding contract.
  // Re-run them on the integrated revision; patch equivalence does not prove compatibility with a new base.
  if (tested.length && !problems.length)
    for (const step of steps.filter(
      (s) =>
        s.type === "command" &&
        s.status === "COMPLETED" &&
        s.output?.tested_heads &&
        s.config.allow_failure !== true,
    )) {
      const trees = workspaces.filter(
        (w) => ctx.run.selected_repositories.includes(w.repo) && w.repo in step.output.tested_heads,
      );
      if (!trees.length) continue;
      const cfg = verifyConfig(
        {
          verify: {
            command: step.config.command,
            timeout_seconds: step.config.timeout_seconds,
            baseline: step.config.baseline_compare === "go" ? "go" : null,
            max_repairs: 0,
          },
        },
        String(step.config.command),
      );
      if (!cfg?.command) {
        problems.push(`${step.key}: missing workflow regression command`);
        continue;
      }
      await verify(step.key, cfg, trees, step.config.env as Record<string, string> | undefined);
    }

  return { problems, tested };
}
