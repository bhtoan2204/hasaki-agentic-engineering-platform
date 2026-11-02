import { config } from "./config.ts";
import { inbox } from "./db.ts";
import { authStatus, workApi } from "./hasakiAuth.ts";
import { normalizeTask } from "./prompt.ts";
import { notify } from "./notify.ts";
import { applyAutomationPolicy, workItems, type WorkItemRow } from "./workitems/service.ts";

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time

/** Find the task array in a list response without depending on its exact envelope. */
function findTaskArray(json: any): any[] {
  const seen = new Set<any>();
  const walk = (v: any): any[] | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.length && v.every((x) => x && typeof x === "object" && "code" in x && "name" in x) ? v : null;
    for (const k of Object.keys(v)) {
      const r = walk(v[k]);
      if (r) return r;
    }
    return null;
  };
  return walk(json) ?? [];
}

/** Pull the task list (same filter as the /tasks page) into the inbox. */
export async function fetchTaskList() {
  const params = { ...config.hasakiWork.listQuery, to_date: today() };
  const json = await workApi("GET", config.hasakiWork.listPath, params);
  const list = findTaskArray(json);
  for (const t of list) {
    await inbox.upsert({ workId: Number(t.id), code: String(t.code), name: String(t.name), project: String(t.project?.name ?? t.project_name ?? ""), raw: t });
  }
  return list;
}

/**
 * Import a Hasaki task payload ({data:{...}} or bare data) as a work item. Importing NEVER executes:
 * a run starts only on an explicit user action or when `automationPolicy` names a workflow.
 */
export async function importHasakiTask(raw: unknown, automationPolicy: WorkItemRow["automation_policy"] = null) {
  const t = normalizeTask(raw);
  const { item, created } = await workItems.upsertImported({
    source: "hasaki_work",
    code: t.code,
    externalId: t.workId != null ? String(t.workId) : null,
    title: t.name,
    description: String(t.data.note ?? ""),
    project: t.project,
    payload: t.data,
    automationPolicy,
  });
  return { item, created };
}

/** Fetch full detail of one task from Hasaki Work and import it (no execution). */
export async function pickTask(workId: number, automationPolicy: WorkItemRow["automation_policy"] = null) {
  const json = await workApi("GET", config.hasakiWork.detailPath.replace("{id}", String(workId)));
  const { item, created } = await importHasakiTask(json, automationPolicy);
  await inbox.markPicked(workId);
  return { code: item.code, work_item_id: item.id, created, started: false };
}

let timer: NodeJS.Timeout | null = null;

/** Optional background poll: refresh the inbox; with autoPick, import new tasks (and run autoWorkflow if set). */
export function startPolling() {
  const minutes = config.hasakiWork.pollMinutes;
  if (!minutes || timer) return;
  const tick = async () => {
    if (!authStatus().loggedIn) return;
    try {
      await fetchTaskList();
      if (!config.hasakiWork.autoPick) return;
      const policy = config.hasakiWork.autoWorkflow ? { workflow: config.hasakiWork.autoWorkflow } : null;
      for (const row of await inbox.unpicked()) {
        if (await workItems.byCode(row.code)) continue;
        const picked = await pickTask(Number(row.work_id), policy);
        const item = (await workItems.get(picked.work_item_id))!;
        const run = await applyAutomationPolicy(item);
        await notify(`📥 Đã nhận task ${row.code}${run ? ` – chạy workflow ${policy!.workflow} (run #${run.id})` : ""}`, `/work-items/${item.id}`);
      }
    } catch (e) {
      console.error("poll failed:", (e as Error).message);
      await notify(`⚠️ Lấy task Hasaki Work lỗi: ${(e as Error).message}`);
    }
  };
  timer = setInterval(tick, minutes * 60_000);
  void tick();
}
