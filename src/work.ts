import { config } from "./config.ts";
import { inbox, tasks } from "./db.ts";
import { authStatus, workApi } from "./hasakiAuth.ts";
import { enqueue } from "./agent.ts";
import { normalizeTask } from "./prompt.ts";
import { notify } from "./notify.ts";

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

/** Fetch full detail of one task, import it and start the agent. */
export async function pickTask(workId: number) {
  const json = await workApi("GET", config.hasakiWork.detailPath.replace("{id}", String(workId)));
  const t = normalizeTask(json);
  const existing = await tasks.get(t.code);
  await tasks.upsert(t.code, t.workId ?? workId, t.name, t.project, t.data);
  await inbox.markPicked(workId);
  if (!existing) await enqueue(t.code);
  return { code: t.code, started: !existing };
}

let timer: NodeJS.Timeout | null = null;

/** Optional background poll: refresh the inbox and, with autoPick, execute new tasks. */
export function startPolling() {
  const minutes = config.hasakiWork.pollMinutes;
  if (!minutes || timer) return;
  const tick = async () => {
    if (!authStatus().loggedIn) return;
    try {
      await fetchTaskList();
      if (!config.hasakiWork.autoPick) return;
      for (const row of await inbox.unpicked()) {
        if (await tasks.get(row.code)) continue;
        await pickTask(Number(row.work_id));
        await notify(`📥 Đã nhận task ${row.code}`, row.code);
      }
    } catch (e) {
      console.error("poll failed:", (e as Error).message);
      await notify(`⚠️ Lấy task Hasaki Work lỗi: ${(e as Error).message}`);
    }
  };
  timer = setInterval(tick, minutes * 60_000);
  void tick();
}
