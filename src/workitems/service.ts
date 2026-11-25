import { one, pool, withTx } from "../db/pool.ts";
import { ensureTestOwner } from "../auth/testOwner.ts";
import { startRun, type StartRunInput } from "../workflow/engine.ts";
import { EngineError } from "../workflow/mutations.ts";
import { runEvents } from "../workflow/events.ts";
import { activeRunForWorkItem, listRuns } from "../workflow/runRepository.ts";
import { workItemRepository, type ImportInput, type WorkItemRow } from "./repository.ts";
import { config } from "../config.ts";

export type { ImportInput, WorkItemRow } from "./repository.ts";

async function requireWorkItemOwner(ownerId?: number) {
  const owner = ownerId ?? (config.test.platformTest === "1" ? await ensureTestOwner() : undefined);
  if (!owner) throw new Error("owner is required");
  return owner;
}

export type FollowUpKind = "bug" | "refactor";
const FOLLOW_UPS = {
  bug: {
    workflow: "bug-from-task",
    code: "BUG",
    label: "[Bug]",
    event: "QC bug",
    empty: "describe the bug found on QC",
  },
  refactor: {
    workflow: "refactor-from-task",
    code: "REF",
    label: "[Refactor]",
    event: "Refactor",
    empty: "describe what to refactor or finish",
  },
} as const;

export const workItems = {
  list: workItemRepository.list,
  get: workItemRepository.get,
  byCode: workItemRepository.byCode,
  update: workItemRepository.update,

  async detail(id: number, authorize?: (item: WorkItemRow) => Promise<void>) {
    const wi = await workItemRepository.get(id);
    if (!wi) return undefined;
    await authorize?.(wi);
    const [runs, prs] = await Promise.all([
      listRuns({ workItemId: id }),
      workItemRepository.pullRequests(id),
    ]);
    return { ...wi, runs, pull_requests: prs };
  },

  /** Manual engineering request. Code REQ-<id> doubles as the branch name. */
  async createManual(x: {
    title: string;
    description?: string;
    project?: string;
    code?: string;
    ownerId?: number;
    payload?: Record<string, unknown>;
  }) {
    if (!x.title?.trim()) throw new Error("title is required");
    const ownerId = await requireWorkItemOwner(x.ownerId);
    return withTx(async (c) => {
      const id = await workItemRepository.nextId(c);
      const code = x.code?.trim() || `REQ-${id}`;
      if (!/^[A-Za-z0-9._-]+$/.test(code))
        throw new Error("code may contain only letters, digits, . _ -");
      return workItemRepository.insertManual(c, id, {
        code,
        title: x.title.trim(),
        description: x.description ?? "",
        project: x.project ?? "",
        ownerId,
        payload: x.payload,
      });
    });
  },

  /**
   * Follow-up work on an earlier task (the parent): a bug found on QC, or a refactor that finishes or improves it.
   * Creates a work item linked to the parent and starts the matching run on it. The run continues the parent's own
   * branch in each repository the parent changed, so the change lands on the parent's pull request instead of a new
   * branch.
   */
  async followUp(
    x: {
      kind: FollowUpKind;
      parentId: number;
      title?: string;
      description: string;
      ownerId: number;
    } & Pick<
      StartRunInput,
      "version" | "start" | "profile" | "outputLocale" | "agentProvider" | "autonomy"
    >,
  ) {
    const spec = FOLLOW_UPS[x.kind];
    if (!spec) throw new EngineError("kind must be bug or refactor", 400);
    const description = x.description?.trim();
    if (!description) throw new EngineError(spec.empty, 400);
    const parent = await workItemRepository.get(x.parentId);
    if (!parent) throw new EngineError("parent work item not found", 404);
    const { branches, pull_requests } = await workItemRepository.branches(parent.id);
    const repositories = Object.keys(branches);
    if (!repositories.length)
      throw new EngineError(
        `${parent.code} has no branch yet: there is nothing to continue. Start a normal workflow instead`,
        409,
      );
    const title = (x.title?.trim() || description.split("\n")[0]).slice(0, 200);
    const item = await withTx(async (c) => {
      const n = await one<{ n: number }>(
        c,
        "SELECT count(*)::int AS n FROM work_items WHERE payload->>'parent_code' = $1 AND payload->>'kind' = $2",
        [parent.code, x.kind],
      );
      return workItemRepository.insertManual(c, await workItemRepository.nextId(c), {
        code: `${parent.code}-${spec.code}-${(n?.n ?? 0) + 1}`,
        title: `${spec.label} ${title}`,
        description,
        project: parent.project,
        ownerId: x.ownerId,
        payload: { kind: x.kind, parent_code: parent.code, parent_id: parent.id, branches },
      });
    });
    const run = await startRun({
      definitionKey: spec.workflow,
      version: x.version,
      workItemId: item.id,
      ownerId: x.ownerId,
      inputs: {
        parent_task: parent.code,
        parent_pull_requests: pull_requests,
        branches,
        repositories,
        ...(x.kind === "refactor" ? { goal: description } : {}),
      },
      start: x.start,
      profile: x.profile,
      outputLocale: x.outputLocale,
      agentProvider: x.agentProvider,
      autonomy: x.autonomy,
    });
    const parentRun = await one<{ id: number }>(
      pool,
      "SELECT id FROM workflow_runs WHERE work_item_id = $1 ORDER BY id DESC LIMIT 1",
      [parent.id],
    );
    if (parentRun)
      await runEvents.add(
        pool,
        parentRun.id,
        "system",
        `${spec.event} ${item.code} (run #${run.id}) continues the branch of this task`,
      );
    return { item, run };
  },

  /** Import or refresh only. Starting a run requires an explicit action or stored automation policy. */
  async upsertImported(x: ImportInput): Promise<{ item: WorkItemRow; created: boolean }> {
    const ownerId = await requireWorkItemOwner(x.ownerId);
    return withTx(async (c) => {
      const existing = await workItemRepository.lockByCode(c, x.code, ownerId);
      if (!existing)
        return { item: await workItemRepository.insertImport(c, x, ownerId), created: true };

      const item = await workItemRepository.refreshImport(c, existing.id, {
        title: x.title,
        description:
          existing.description_source === "manual" || !x.description
            ? existing.description
            : x.description,
        project: x.project ?? existing.project,
        payload: x.payload ?? existing.payload,
        externalId: x.externalId ?? null,
      });
      return { item, created: false };
    });
  },
};

export async function applyAutomationPolicy(item: WorkItemRow) {
  const policy = item.automation_policy;
  if (!policy?.workflow || (await activeRunForWorkItem(item.id))) return null;
  return startRun({ definitionKey: policy.workflow, workItemId: item.id, inputs: policy.inputs });
}
