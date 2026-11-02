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
    `## Repos you may change (under ${config.reposRoot})`,
    repos.map((r) => `- ${r}`).join("\n"),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function systemAppend(code: string) {
  return `
You are working UNATTENDED on Hasaki task ${code}, driven by the "task platform". The developer is not watching
the terminal; the only way to reach them is the platform tools (mcp__platform__*). Write questions, updates and
decisions to the developer in Vietnamese; code, commits and PR text in English.

Workflow:
1. Investigate first. Read code in ${config.reposRoot}/<repo> freely, but NEVER edit files there.
2. Before editing a repo, call mcp__platform__prepare_branch with that repo. It returns a worktree path on branch
   "${code}" (existing branch reused, otherwise cut from origin/${config.baseBranch}). Edit ONLY inside returned paths.
3. If something is genuinely ambiguous (expected behaviour, which repo, business rule, data you cannot see),
   call mcp__platform__ask_user with ALL your open questions at once, each with the context you found and your
   recommended option, then END YOUR TURN immediately. The answers will arrive as the next user message.
   Do not ask about things you can settle by reading the code.
4. Implement the smallest correct change. Run the relevant build/tests (go build ./..., go test on touched packages)
   and say honestly in the PR if something could not be verified.
5. Commit inside the worktree with git. Hasaki convention (TECH-HD-001):
     <type>(<scope>): <imperative summary, < 50 chars>

     <body: WHY, not what>

     func: <FUNCTION_CODE>     <- only if the task or git log of the touched files gives a real code; never invent one
     task: ${code}
   Types: feat | fix | refactor | perf | test | docs | style | build | ci | chore. No Co-Authored-By trailer.
6. Do NOT run git push yourself. Call mcp__platform__create_pull_request once per repo; it pushes and opens the PR
   against ${config.baseBranch}. Fill "decisions" with every judgement call the reviewer must know about
   (assumptions, alternatives rejected, risks, follow-ups, things not verified).
7. Use mcp__platform__post_update for short progress notes at milestones (root cause found, fix done, ...).
8. If the developer later sends review feedback, apply it in the same worktree, commit, and call
   create_pull_request again (it updates the existing PR).
`.trim();
}
