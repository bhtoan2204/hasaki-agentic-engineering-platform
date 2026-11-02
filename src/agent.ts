import { query, tool, createSdkMcpServer, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { config } from "./config.ts";
import { events, prs, questions, tasks } from "./db.ts";
import { allowedRepos, prepareBranch, pushBranch, taskDir, type PreparedBranch } from "./git.ts";
import { openPullRequest } from "./bitbucket.ts";
import { buildTaskPrompt, systemAppend } from "./prompt.ts";
import { notify } from "./notify.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Tools the agent uses to talk to the platform. One server per run so handlers close over the task code. */
function platformServer(code: string, project: string, branches: Map<string, PreparedBranch>) {
  const repos = allowedRepos(project);
  return createSdkMcpServer({
    name: "platform",
    version: "1.0.0",
    tools: [
      tool(
        "prepare_branch",
        `Create or reuse the task branch "${code}" for a repo in an isolated git worktree and return its path. Allowed repos: ${repos.join(", ")}`,
        { repo: z.string().describe("repo directory name, e.g. oms-api") },
        async ({ repo }) => {
          if (!repos.includes(repo)) return text(`Repo "${repo}" is not allowed for this task. Allowed: ${repos.join(", ")}`);
          const b = await prepareBranch(code, repo, code);
          branches.set(repo, b);
          await events.add(code, "system", `branch ${b.branch} in ${repo} (${b.createdFrom}) -> ${b.path}`);
          return text(`Ready. Work ONLY in: ${b.path}\nBranch: ${b.branch} (from ${b.createdFrom})`);
        },
      ),
      tool(
        "ask_user",
        "Post questions to the developer on the platform. After calling this, END YOUR TURN; answers come back as the next message.",
        {
          questions: z
            .array(
              z.object({
                question: z.string().describe("the question, in Vietnamese"),
                context: z.string().optional().describe("what you found in the code that makes this unclear (file:line)"),
                options: z.array(z.string()).optional().describe("candidate answers; put your recommendation first"),
              }),
            )
            .min(1),
        },
        async (args) => {
          for (const q of args.questions) await questions.add(code, q);
          await tasks.setStatus(code, "waiting_answer");
          await notify(`❓ ${code} có ${args.questions.length} câu hỏi cần trả lời`, code);
          return text("Questions posted. Stop now and end your turn without further tool calls.");
        },
      ),
      tool(
        "post_update",
        "Post a short progress note (Vietnamese) to the platform timeline.",
        { message: z.string() },
        async ({ message }) => {
          await events.add(code, "agent", message);
          return text("ok");
        },
      ),
      tool(
        "create_pull_request",
        `Push the task branch of a repo and open/update its PR into ${config.baseBranch}. Commit everything first.`,
        {
          repo: z.string(),
          title: z.string().describe("PR title, e.g. 'fix(stock): retry WMS check-stock on timeout'"),
          summary: z.string().describe("markdown: root cause, what changed, how it was verified"),
          decisions: z
            .array(z.object({ title: z.string(), detail: z.string() }))
            .describe("judgement calls / assumptions / risks / follow-ups the reviewer must know (Vietnamese)"),
        },
        async ({ repo, title, summary, decisions }) => {
          const b = branches.get(repo) ?? (await prepareBranch(code, repo, code));
          const { commits } = await pushBranch(b.path, b.branch);
          const description = [
            `Task: **${code}**`,
            "",
            summary,
            "",
            decisions.length ? "## Decisions\n" + decisions.map((d) => `- **${d.title}**: ${d.detail}`).join("\n") : "",
            "",
            "## Commits\n```\n" + commits + "\n```",
            "",
            "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
          ].join("\n");
          const pr = await openPullRequest(repo, b.branch, title, description);
          await prs.upsert({ code, repo, branch: b.branch, url: pr.url, title, summary, decisions });
          await events.add(code, "system", `PR ${repo}: ${pr.url} (${pr.note})`);
          await notify(`🔀 ${code} – PR ${repo} chờ review: ${pr.url}`, code);
          return text(`${pr.note}\n${pr.url}`);
        },
      ),
    ],
  });
}

async function downloadAttachments(code: string, d: any): Promise<string[]> {
  const files: string[] = d.note_files ?? [];
  if (!files.length || !config.fileBaseUrl) return files.map((f) => `${f} (not downloaded: fileBaseUrl not configured)`);
  const dir = join(taskDir(code), "_attachments");
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const f of files) {
    try {
      const res = await fetch(config.fileBaseUrl.replace(/\/$/, "") + "/" + f);
      if (!res.ok) throw new Error(String(res.status));
      const p = join(dir, basename(f));
      writeFileSync(p, Buffer.from(await res.arrayBuffer()));
      out.push(p);
    } catch (e) {
      out.push(`${f} (download failed: ${(e as Error).message})`);
    }
  }
  return out;
}

// ---- run queue -------------------------------------------------------------

type Job = { code: string; message?: string };
const queue: Job[] = [];
const running = new Map<string, AbortController>();

/** Start the task (no message) or resume its session with a message (answers / review feedback). */
export async function enqueue(code: string, message?: string) {
  const pending = queue.find((j) => j.code === code);
  if (pending) {
    // merge messages so one resume carries everything the developer said
    if (message) pending.message = pending.message ? `${pending.message}\n\n${message}` : message;
  } else {
    queue.push({ code, message });
  }
  if (!running.has(code)) await tasks.setStatus(code, "queued");
  pump();
}

export function cancel(code: string) {
  running.get(code)?.abort();
  const i = queue.findIndex((j) => j.code === code);
  if (i >= 0) queue.splice(i, 1);
}

export const isRunning = (code: string) => running.has(code);

function pump() {
  while (running.size < config.maxConcurrent) {
    const i = queue.findIndex((j) => !running.has(j.code));
    if (i < 0) return;
    const [job] = queue.splice(i, 1);
    const ac = new AbortController();
    running.set(job.code, ac);
    run(job, ac)
      .catch(async (e) => {
        await tasks.setStatus(job.code, "failed", String(e?.message ?? e)).catch(console.error);
        return notify(`❌ ${job.code} lỗi: ${e?.message ?? e}`, job.code);
      })
      .finally(() => {
        running.delete(job.code);
        pump();
      });
  }
}

async function run(job: Job, ac: AbortController) {
  const task = await tasks.get(job.code);
  if (!task) throw new Error("task not found");
  const d = task.payload;
  const repos = allowedRepos(task.project);
  const branches = new Map<string, PreparedBranch>();
  await tasks.setStatus(job.code, "running");

  let prompt: string;
  if (!task.session_id) {
    const files = await downloadAttachments(job.code, d);
    prompt = buildTaskPrompt(d, repos, files);
  } else {
    prompt = job.message ?? "Continue the task.";
  }
  if (job.message) await events.add(job.code, "user", job.message);

  // Custom (in-process) MCP tools require streaming input, so the prompt is an async iterable.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
  }

  const cwd = taskDir(job.code);
  const resultInfo = { isError: false, text: "" };
  for await (const msg of query({
    prompt: input(),
    options: {
      cwd,
      additionalDirectories: [config.reposRoot],
      resume: task.session_id ?? undefined,
      abortController: ac,
      model: config.model || undefined,
      maxTurns: config.maxTurns,
      systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend(job.code) },
      settingSources: ["user"], // load ~/.claude skills (oms-*, commit, ...) and user CLAUDE.md
      mcpServers: { platform: platformServer(job.code, task.project, branches) },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Unattended run: pushing and destructive git go through the platform only.
      disallowedTools: [
        "Bash(git push:*)",
        "Bash(git reset --hard:*)",
        "Bash(git clean:*)",
        "Bash(git checkout release/prod:*)",
        "Bash(rm -rf:*)",
        "AskUserQuestion",
      ],
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") {
      await tasks.setSession(job.code, msg.session_id);
    } else if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) await events.add(job.code, "agent", block.text);
        else if (block.type === "tool_use") await events.add(job.code, "tool", `${block.name} ${summarizeInput(block.input)}`);
      }
    } else if (msg.type === "result") {
      resultInfo.isError = msg.is_error;
      resultInfo.text = msg.subtype === "success" ? msg.result : msg.subtype;
    }
  }

  // Decide where the task landed.
  if (resultInfo.isError) throw new Error(resultInfo.text || "agent run failed");
  if ((await questions.open(job.code)).length) await tasks.setStatus(job.code, "waiting_answer");
  else if ((await prs.list(job.code)).length) await tasks.setStatus(job.code, "review");
  else await tasks.setStatus(job.code, "idle");
}

function summarizeInput(input: unknown) {
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
