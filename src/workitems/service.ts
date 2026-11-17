import { withTx } from "../db/pool.ts";
import { ensureTestOwner } from "../auth/testOwner.ts";
import { startRun } from "../workflow/engine.ts";
import { activeRunForWorkItem, listRuns } from "../workflow/runRepository.ts";
import { workItemRepository, type ImportInput, type WorkItemRow } from "./repository.ts";

export type { ImportInput, WorkItemRow } from "./repository.ts";

async function requireWorkItemOwner(ownerId?: number) {
  const owner =
    ownerId ?? (process.env.PLATFORM_TEST === "1" ? await ensureTestOwner() : undefined);
  if (!owner) throw new Error("owner is required");
  return owner;
}

export const workItems = {
  list: workItemRepository.list,
  get: workItemRepository.get,
  byCode: workItemRepository.byCode,
  update: workItemRepository.update,

  async detail(id: number) {
    const wi = await workItemRepository.get(id);
    if (!wi) return undefined;
    const [runs, prs] = await Promise.all([
      listRuns({ workItemId: id }),
      workItemRepository.pullRequests(id),
    ]);
    const legacy = wi.legacy_task_code
      ? await workItemRepository.legacyHistory(wi.legacy_task_code)
      : null;
    return { ...wi, runs, pull_requests: prs, legacy };
  },

  /** Manual engineering request. Code REQ-<id> doubles as the branch name. */
  async createManual(x: {
    title: string;
    description?: string;
    project?: string;
    code?: string;
    ownerId?: number;
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
      });
    });
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
