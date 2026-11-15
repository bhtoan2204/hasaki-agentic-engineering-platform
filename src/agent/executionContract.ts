import { TEST_COMMAND } from "../workflow/templates.ts";
import { requiredTestTargets, verifyConfig } from "./verify.ts";
import { allWorkspacesOf } from "../git/provider.ts";
import { repositories, repoPath } from "../repos/service.ts";
import { pool, one, q } from "../db/pool.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import { hashOf } from "../workflow/definitions.ts";
import { ancestors, topoOrder } from "../workflow/graph.ts";
import type { StepSpec, WorkflowSpec } from "../workflow/types.ts";

type Upstream = Record<string, { status: string; attempt_id: number | null; output: unknown }>;
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
export interface MandatoryExecutionContract {
  approved_plan: string | Record<string, unknown> | null;
  acceptance_criteria: string[];
  business_constraints: string[];
  selected_repositories: string[];
  required_tests: string[];
  verification_strategy?: string[];
  verification?: unknown;
  task?: unknown;
  authorization?: {
    mode: "approval" | "workflow";
    definition_version_id?: number;
    step: string;
    profile?: string;
    repository_scope?: string[];
  };
  provenance?: {
    plan_step: string;
    plan_attempt_id: number | null;
    approval_step: string;
    approval_attempt_id: number | null;
    approval: Record<string, unknown> | null;
    revision: string;
    source_attempts: Record<string, number | null>;
  };
}
export interface ContractBinding {
  graph: WorkflowSpec;
  step: Pick<StepSpec, "key" | "config" | "depends_on">;
  definition_version_id: number;
  profile?: string;
  allowed_repositories?: string[];
  request: { title: string; description?: string; inputs?: Record<string, unknown> };
}

/** Bind only actual ancestors. Gate configuration identifies the approved material; names have no semantics. */
export function buildExecutionContract(
  upstream: Upstream,
  selected: string[],
  workItem?: { payload?: unknown } | null,
  binding?: ContractBinding,
): MandatoryExecutionContract {
  const steps = binding?.graph.steps ?? [];
  const reachable = binding
    ? ancestors(
        [...steps.filter((s) => s.key !== binding.step.key), { ...binding.step }],
        binding.step.key,
      )
    : new Set(Object.keys(upstream));
  const sources = Object.fromEntries(
    Object.entries(upstream).filter(([key, u]) => reachable.has(key) && u.status === "COMPLETED"),
  );
  const order = binding
    ? topoOrder(steps).filter((key) => reachable.has(key))
    : Object.keys(sources);
  const gates = order
    .map((key) => steps.find((s) => s.key === key))
    .filter((s) => s?.type === "human_approval" && !s.config.select_repositories);
  const gate = gates.at(-1);
  const explicit = object(binding?.step.config.execution_contract);
  const approvalStep = String(
    explicit?.approval_from ??
      gate?.key ??
      (!binding
        ? (Object.keys(sources).find((k) => object(sources[k].output)?.approved === true) ?? "")
        : ""),
  );
  const gateConfig = gate?.config;
  const candidates = strings(gateConfig?.show_outputs);
  const planStep = String(
    explicit?.plan_from ??
      gateConfig?.approve_scope_from ??
      candidates.at(-1) ??
      gate?.depends_on.filter((key) => steps.find((s) => s.key === key)?.type === "agent").at(-1) ??
      (!binding
        ? (Object.keys(sources).findLast((k) => {
            const o = object(sources[k].output);
            return o && !o.approved && (o.changes || o.subtasks || o.tests || o.required_tests);
          }) ?? "")
        : ""),
  );
  const plan = sources[planStep];
  const content = object(plan?.output);
  const approval = sources[approvalStep];
  const outputs = [
    ...Object.values(sources).map((u) => object(u.output)),
    object(workItem?.payload),
  ].filter((v) => v !== null);
  const subtasks = Array.isArray(content?.subtasks)
    ? content.subtasks.map(object).filter((v) => v !== null)
    : [];
  const collect = (...keys: string[]) => [
    ...new Set(outputs.flatMap((o) => keys.flatMap((k) => strings(o[k])))),
  ];
  // A published workflow without a plan gate authorizes its configured coding task (including folded profiles).
  const workflowAuthorized = !!binding && !approvalStep;
  const planContent =
    content ??
    (typeof plan?.output === "string" && plan.output.trim() ? plan.output : null) ??
    (workflowAuthorized
      ? {
          request: binding.request,
          task: binding.step.config.subtask ?? null,
          instructions: binding.step.config.instructions ?? "",
        }
      : null);
  const supporting = Object.fromEntries(
    Object.entries(sources)
      .filter(
        ([key, u]) =>
          key !== planStep &&
          key !== approvalStep &&
          (binding ? candidates.includes(key) : object(u.output)?.decisions),
      )
      .map(([key, u]) => [key, u.output]),
  );
  const authorizationAncestors =
    binding && approvalStep ? ancestors(steps, approvalStep) : reachable;
  const identity = {
    source_attempts: Object.fromEntries(
      Object.entries(sources)
        .filter(([key]) => authorizationAncestors.has(key) || key === approvalStep)
        .map(([key, u]) => [key, u.attempt_id]),
    ),
    plan_step: planStep,
    plan_attempt_id: plan?.attempt_id ?? null,
    approval_step: approvalStep,
    approval_attempt_id: approval?.attempt_id ?? null,
    approval: object(approval?.output),
  };
  const payload = {
    approved_plan: Object.keys(supporting).length
      ? { plan: planContent, ...supporting }
      : planContent,
    acceptance_criteria: [
      ...new Set([
        ...collect("acceptance_criteria"),
        ...subtasks.flatMap((t) => strings(t.acceptance_criteria)),
        ...strings(object(binding?.step.config.subtask)?.acceptance_criteria),
        ...(binding ? [binding.request.description || binding.request.title] : []),
      ]),
    ],
    business_constraints: collect("business_constraints", "constraints"),
    selected_repositories: [...selected].sort(),
    // Legacy callers retain their data representation. Runtime bindings accept only executable specifications.
    required_tests: [
      ...new Set([
        ...strings(content?.required_tests),
        ...(binding?.step.config.subtask
          ? strings(object(binding.step.config.subtask)?.required_tests)
          : subtasks.flatMap((t) => strings(t.required_tests))),
        ...strings(object(binding?.step.config.verify)?.required_tests),
        ...(!binding
          ? [
              ...strings(content?.tests),
              ...strings(content?.regression_tests),
              ...subtasks.flatMap((t) => strings(t.verification)),
            ]
          : []),
      ]),
    ],
    verification_strategy: [
      ...new Set([
        ...strings(content?.tests),
        ...strings(content?.verification_strategy),
        ...strings(content?.regression_tests),
        ...subtasks.flatMap((t) => strings(t.verification)),
      ]),
    ],
    ...(binding
      ? {
          task: binding.step.config.subtask ?? null,
          verification:
            binding.step.config.verify === false
              ? false
              : verifyConfig(binding.step.config, TEST_COMMAND),
          authorization: {
            mode: workflowAuthorized ? ("workflow" as const) : ("approval" as const),
            definition_version_id: binding.definition_version_id,
            step: binding.step.key,
            profile: binding.profile,
            repository_scope: workflowAuthorized
              ? (binding.allowed_repositories ?? selected)
              : selected,
          },
        }
      : {}),
  };
  return { ...payload, provenance: { ...identity, revision: hashOf({ ...payload, ...identity }) } };
}

export function executionContractProblems(
  contract: MandatoryExecutionContract,
  allowed: string[],
): string[] {
  const problems: string[] = [];
  if (!contract.approved_plan || !Object.keys(contract.approved_plan).length)
    problems.push("Actual approved plan is missing");
  if (
    contract.authorization?.mode !== "workflow" &&
    (!contract.provenance?.plan_attempt_id ||
      !contract.provenance.approval_attempt_id ||
      contract.provenance.approval?.approved !== true)
  )
    problems.push("Approval provenance is missing or incomplete");
  if (!contract.acceptance_criteria.length) problems.push("Acceptance criteria are missing");
  if (!contract.required_tests.length && !contract.verification)
    problems.push("Required tests are missing");
  if (contract.verification === false) problems.push("Mandatory verification is disabled");
  if (
    !contract.selected_repositories.length ||
    contract.selected_repositories.some((r) => !allowed.includes(r))
  )
    problems.push("Repository scope is missing or unauthorized");
  return problems;
}

/** Revalidate persisted authorization without constructing a replacement contract. */
export async function validateExecutionAuthorization(ctx: ExecutionContext): Promise<string[]> {
  const contract = ctx.input.execution_contract;
  if (!contract) return ["Execution contract was not pinned before the attempt"];
  const problems = executionContractProblems(contract, ctx.run.allowed_repositories);
  if (contract.authorization?.mode === "workflow" && contract.required_tests.length) {
    const workspaces = await allWorkspacesOf(ctx.run.id);
    const targets = await Promise.all(
      contract.selected_repositories.map(async (repo) => {
        const workspace = workspaces.find(
          (w) =>
            w.repo === repo &&
            (ctx.step.config.isolated_workspace
              ? w.subtask_id === ctx.step.subtask_id
              : !w.subtask_id),
        );
        const registered = await repositories.get(repo);
        return { repo, path: workspace?.path ?? (registered ? repoPath(registered) : "") };
      }),
    );
    const resolved = await requiredTestTargets(targets, contract.required_tests, true);
    problems.push(...resolved.problems);
  }
  const current = await one<{ selected_repositories: string[]; allowed_repositories: string[] }>(
    pool,
    "SELECT selected_repositories,allowed_repositories FROM workflow_runs WHERE id=$1",
    [ctx.run.id],
  );
  if (!current) return ["Run is unavailable"];
  const selected = current.selected_repositories.length
    ? current.selected_repositories
    : current.allowed_repositories;
  const scope = contract.authorization?.repository_scope ?? contract.selected_repositories;
  if (
    contract.authorization?.mode === "workflow"
      ? selected.some((repo) => !scope.includes(repo))
      : JSON.stringify([...selected].sort()) !== JSON.stringify(contract.selected_repositories)
  )
    problems.push("Repository selection changed; renewed authorization or approval is required");
  const sources = await q<{ key: string; current_attempt_id: number | null; status: string }>(
    pool,
    "SELECT key,current_attempt_id,status FROM workflow_steps WHERE run_id=$1",
    [ctx.run.id],
  );
  for (const [key, attempt] of Object.entries(contract.provenance?.source_attempts ?? {})) {
    const step = sources.find((s) => s.key === key);
    if (!step || step.current_attempt_id !== attempt || step.status !== "COMPLETED")
      problems.push(`Authorization source ${key} changed; renewed approval is required`);
  }
  const provenance = contract.provenance;
  if (provenance && contract.authorization?.mode !== "workflow") {
    const approval = await one<{
      input: {
        upstream?: Upstream;
        run?: { selected_repositories?: string[]; allowed_repositories?: string[] };
      };
    }>(
      pool,
      "SELECT a.input FROM workflow_step_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE a.id=$1 AND a.run_id=$2 AND a.status='COMPLETED' AND s.type='human_approval' AND s.current_attempt_id=a.id AND s.status='COMPLETED'",
      [provenance.approval_attempt_id, ctx.run.id],
    );
    if (
      Object.entries(provenance.source_attempts)
        .filter(([key]) => key !== provenance.approval_step)
        .some(([key, attempt]) => approval?.input?.upstream?.[key]?.attempt_id !== attempt)
    )
      problems.push(
        "Approval does not reference the current plan attempt; renewed approval is required",
      );
    const approvedRepos = approval?.input?.run?.selected_repositories?.length
      ? approval.input.run.selected_repositories
      : approval?.input?.run?.allowed_repositories;
    if (
      !approvedRepos ||
      JSON.stringify([...approvedRepos].sort()) !== JSON.stringify(contract.selected_repositories)
    )
      problems.push(
        "Approval does not cover this repository selection; renewed approval is required",
      );
  }
  return problems;
}
