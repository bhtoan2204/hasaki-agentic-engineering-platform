import { pool, withTx, type Db } from "../db/pool.ts";
import { ensureTestOwner } from "../auth/testOwner.ts";
import { listRuns, startRun } from "../workflow/engine.ts";
import { workItemsRepository, type WorkItemRow, type WorkItemListFilter } from "./repository.ts";

export { type WorkItemRow } from "./repository.ts";

export interface ImportInput {
  source: WorkItemRow["source"];
  code: string;
  externalId?: string | null;
  title: string;
  description?: string;
  project?: string;
  payload?: unknown;
  automationPolicy?: WorkItemRow["automation_policy"];
  ownerId?: number;
}

export const workItems = {
  list(filter: WorkItemListFilter = {}, db: Db = pool, repo = workItemsRepository) {
    return repo.listWorkItems(filter, db);
  },

  get(id: number, db: Db = pool, repo = workItemsRepository) {
    return repo.getWorkItemById(id, db);
  },

  byCode(code: string, ownerId: number, db: Db = pool, repo = workItemsRepository) {
    return repo.getWorkItemByCode(code, ownerId, db);
  },

  async detail(id: number, repo = workItemsRepository) {
    const wi = await repo.getWorkItemById(id);
    if (!wi) return undefined;
    const [runs, prs] = await Promise.all([
      listRuns({ workItemId: id }),
      repo.listPullRequests(id),
    ]);
    const legacy = wi.legacy_task_code
      ? {
          questions: await repo.listLegacyQuestions(wi.legacy_task_code),
          events: await repo.listLegacyEvents(wi.legacy_task_code),
        }
      : null;
    return { ...wi, runs, pull_requests: prs, legacy };
  },

  /** Manual engineering request. Code REQ-<id> doubles as the branch name. */
  async createManual(
    x: {
      title: string;
      description?: string;
      project?: string;
      code?: string;
      ownerId?: number;
    },
    repo = workItemsRepository,
  ) {
    if (!x.title?.trim()) throw new Error("title is required");
    const ownerId =
      x.ownerId ?? (process.env.PLATFORM_TEST === "1" ? await ensureTestOwner() : undefined);
    if (!ownerId) throw new Error("owner is required");
    return withTx(async (c) => {
      const id = await repo.getNextWorkItemId(c);
      const code = x.code?.trim() || `REQ-${id}`;
      if (!/^[A-Za-z0-9._-]+$/.test(code))
        throw new Error("code may contain only letters, digits, . _ -");
      await repo.insertManualWorkItem(
        id,
        code,
        x.title.trim(),
        x.description ?? "",
        x.project ?? "",
        ownerId,
        c,
      );
      return (await repo.getWorkItemById(id, c))!;
    });
  },

  /**
   * Import or refresh an external work item. NEVER starts a run by itself; the caller decides
   * (explicit user action, or the item's automation policy via `applyAutomationPolicy`).
   */
  async upsertImported(
    x: ImportInput,
    repo = workItemsRepository,
  ): Promise<{ item: WorkItemRow; created: boolean }> {
    const ownerId =
      x.ownerId ?? (process.env.PLATFORM_TEST === "1" ? await ensureTestOwner() : undefined);
    if (!ownerId) throw new Error("owner is required");
    return withTx(async (c) => {
      const existing = await repo.findWorkItemForUpdate(x.code, ownerId, c);
      if (existing) {
        await repo.updateImportedWorkItem(
          existing.id,
          {
            title: x.title,
            description:
              (existing as any).description_source === "manual" || !x.description
                ? existing.description
                : x.description,
            project: x.project ?? existing.project,
            payload: x.payload ?? existing.payload,
            externalId: x.externalId,
          },
          c,
        );
        return { item: (await repo.getWorkItemById(existing.id, c))!, created: false };
      }
      const row = await repo.insertImportedWorkItem(
        {
          code: x.code,
          source: x.source,
          externalId: x.externalId,
          title: x.title,
          description: x.description,
          project: x.project,
          payload: x.payload,
          automationPolicy: x.automationPolicy,
          ownerId,
        },
        c,
      );
      return { item: row, created: true };
    });
  },

  async update(
    id: number,
    patch: {
      title?: string;
      description?: string;
      project?: string;
      status?: string;
      automation_policy?: unknown;
    },
    repo = workItemsRepository,
  ) {
    await repo.updateWorkItem(id, patch);
    return repo.getWorkItemById(id);
  },
};

/** The only automatic execution path: an explicit, stored automation policy naming a workflow. */
export async function applyAutomationPolicy(item: WorkItemRow, repo = workItemsRepository) {
  const wf = item.automation_policy?.workflow;
  if (!wf) return null;
  const active = await repo.findActiveRunForWorkItem(item.id);
  if (active) return null;
  return startRun({
    definitionKey: wf,
    workItemId: item.id,
    inputs: item.automation_policy?.inputs,
  });
}
