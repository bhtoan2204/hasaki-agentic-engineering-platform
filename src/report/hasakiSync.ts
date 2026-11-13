import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool, q } from "../db/pool.ts";
import { workApi } from "../hasakiAuth.ts";
import { repositoryBaseBranch } from "../repos/service.ts";
import { workspaceRef, workspacesOf } from "../git/provider.ts";

/**
 * After a reviewer APPROVES the Task Result Report, write the outcome back to the Hasaki Work task with the three
 * `mass-update-field-task-input` calls the web app makes, in this order:
 *   1. unit_amount_of_work = the task's own amount_of_work (default 1)
 *   2. unit_value          = function code(s) from the run's commit footers (`func:`), else the task code
 *   3. data (multipart)    = value[configs][virtual_text] = report summary (+ PR links), and the same unit fields
 * The calls use the run OWNER's Hasaki Work token (never a shared or pasted one), stop at the first failure, and never
 * fail the report step: the result is recorded on the step output and in its log.
 */

const exec = promisify(execFile);
const PATH = "hr/projects/mass-update-field-task-input";

export interface HasakiSyncValues {
  taskId: number;
  amount: number;
  unitValue: string;
  virtualText: string;
}
export interface HasakiSyncResult {
  ok: boolean;
  skipped?: string;
  values?: HasakiSyncValues;
  calls: Array<{ field: string; ok: boolean; error?: string }>;
}

/** Distinct `func:` footer codes of commit messages (order of first appearance). */
export function functionCodes(messages: string[]): string[] {
  const out: string[] = [];
  for (const m of messages)
    for (const line of m.split(/\r?\n/)) {
      const f = line.match(/^\s*func:\s*(.+?)\s*$/i);
      if (!f) continue;
      for (const code of f[1]
        .split(/[,\s]+/)
        .map((c) => c.trim())
        .filter((c) => /^[A-Za-z0-9_.-]{2,64}$/.test(c)))
        if (!out.includes(code)) out.push(code);
    }
  return out;
}

/** Full commit messages ahead of each workspace's base branch (read-only). */
async function commitMessages(runId: number): Promise<string[]> {
  const out: string[] = [];
  for (const w of await workspacesOf(runId)) {
    const at = await workspaceRef(runId, w);
    if (!at) continue;
    try {
      const base = `origin/${await repositoryBaseBranch(w.repo)}`;
      const { stdout } = await exec(
        "git",
        ["-C", at.cwd, "log", "--format=%B%x1e", `${base}..${at.head}`],
        {
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      out.push(
        ...stdout
          .split("\x1e")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } catch {
      /* a missing base or repository only means no function code from it */
    }
  }
  return out;
}

async function pullRequestUrls(runId: number): Promise<string[]> {
  const rows = await q<{ prs: any }>(
    pool,
    "SELECT output->'pull_requests' AS prs FROM workflow_steps WHERE run_id = $1 AND output ? 'pull_requests'",
    [runId],
  );
  return rows
    .flatMap((r) => (Array.isArray(r.prs) ? r.prs : []))
    .map((p: any) => String(p?.url ?? ""))
    .filter(Boolean);
}

/** The values to send, from the work item, the run's commits and the approved report. */
export function syncValues(input: {
  workItem: { code?: string | null; payload?: any } | null | undefined;
  summary: string;
  commitMessages: string[];
  prUrls: string[];
}): HasakiSyncValues | { skipped: string } {
  const payload = input.workItem?.payload ?? {};
  const taskId = Number(payload.id);
  if (!Number.isInteger(taskId) || taskId <= 0)
    return { skipped: "work item is not a Hasaki Work task" };
  const codes = functionCodes(input.commitMessages);
  const unitValue = codes.length
    ? codes.join(", ")
    : String(input.workItem?.code ?? payload.code ?? "");
  if (!unitValue) return { skipped: "no function code and no task code" };
  const amount = Number(payload.amount_of_work ?? payload.unit_amount_of_work);
  const summary = input.summary.trim();
  const virtualText = [summary, ...input.prUrls.map((u) => `PR: ${u}`)].filter(Boolean).join("\n");
  if (!virtualText) return { skipped: "the approved report has no summary" };
  return {
    taskId,
    amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
    unitValue,
    virtualText,
  };
}

/** The three calls, in the web app's order. Stops at the first failure (later calls would overwrite with partial data). */
export async function sendTaskResult(
  ownerId: number,
  v: HasakiSyncValues,
): Promise<HasakiSyncResult> {
  const calls: HasakiSyncResult["calls"] = [];
  const steps: Array<[string, () => Promise<unknown>]> = [
    [
      "unit_amount_of_work",
      () =>
        workApi(ownerId, "POST", PATH, undefined, {
          id: v.taskId,
          field: "unit_amount_of_work",
          value: v.amount,
        }),
    ],
    [
      "unit_value",
      () =>
        workApi(ownerId, "POST", PATH, undefined, {
          id: v.taskId,
          field: "unit_value",
          value: v.unitValue,
        }),
    ],
    [
      "data",
      () => {
        const form = new FormData();
        form.set("id", String(v.taskId));
        form.set("field", "data");
        form.set("value[configs][virtual_text]", v.virtualText);
        form.set("extra_fields[efficiency]", "");
        form.set("extra_fields[efficiency_metrics]", "");
        form.set("extra_fields[unit_value]", v.unitValue);
        form.set("extra_fields[amount_of_work]", String(v.amount));
        return workApi(ownerId, "POST", PATH, undefined, form);
      },
    ],
  ];
  for (const [field, call] of steps) {
    try {
      await call();
      calls.push({ field, ok: true });
    } catch (e) {
      calls.push({ field, ok: false, error: String((e as Error).message).slice(0, 300) });
      return { ok: false, values: v, calls };
    }
  }
  return { ok: true, values: v, calls };
}

/** Compute and send for one run. Never throws: the report is already approved. */
export async function syncApprovedReport(input: {
  runId: number;
  ownerId: number | null | undefined;
  workItem: { code?: string | null; payload?: any } | null | undefined;
  summary: string;
}): Promise<HasakiSyncResult> {
  try {
    if (!input.ownerId) return { ok: false, skipped: "run has no owner", calls: [] };
    const values = syncValues({
      workItem: input.workItem,
      summary: input.summary,
      commitMessages: await commitMessages(input.runId),
      prUrls: await pullRequestUrls(input.runId),
    });
    if ("skipped" in values) return { ok: false, skipped: values.skipped, calls: [] };
    return await sendTaskResult(input.ownerId, values);
  } catch (e) {
    return {
      ok: false,
      calls: [],
      skipped: `could not prepare the update: ${(e as Error).message}`,
    };
  }
}
