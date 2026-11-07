import { config } from "./config.ts";

/** Pull the fields that matter out of the raw task API payload. Accepts {data:{...}} or the bare data object. */
export function normalizeTask(raw: any) {
  const d = raw?.data && raw.data.code ? raw.data : raw;
  if (!d?.code || !d?.name) throw new Error("payload must contain data.code and data.name");
  return {
    workId: d.id ? Number(d.id) : null,
    code: String(d.code),
    name: String(d.name),
    project: String(d.project?.name ?? ""),
    data: d,
  };
}

export function buildTaskPrompt(d: any, repos: string[], files: string[]) {
  const ai = d.task_ai?.ai_suggest;
  const lines = [
    `# Task ${d.code}: ${d.name}`,
    "",
    `- Project: ${d.project?.name ?? "?"}`,
    d.parent ? `- Parent: ${d.parent.code} ${d.parent.name}` : "",
    d.milestone ? `- Milestone: ${d.milestone.name}` : "",
    `- Created by: ${d.created_by_user?.staff_name ?? "?"} (${d.created_by_user?.staff_title ?? ""})`,
    `- Assignee: ${(d.assign_to_user ?? []).map((u: any) => u.staff_name).join(", ") || "?"}`,
    `- Deadline: ${d.date_end ?? "?"}`,
    "",
    "## Description",
    d.note?.trim() ? d.note : "(empty — the task has only a title" + (files.length ? " and attachments)" : ")"),
    "",
    files.length ? "## Attachments (read them with the Read tool — screenshots often hold the actual error)\n" + files.map((f) => `- ${f}`).join("\n") : "",
    ai
      ? [
          "## Task-system AI hints (may be wrong; reporting guidance — never a reason to change what you implement)",
          ai.object ? `- Object: ${ai.object} = ${ai.object_value}` : "",
          ai.readiness_reasoning ? `- ${ai.readiness_reasoning}` : "",
        ].join("\n")
      : "",
    "",
    `## Repositories you may change (resolve paths through platform tools)`,
    repos.map((r) => `- ${r}`).join("\n"),
  ];
  return lines.filter((l) => l !== "").join("\n");
}
