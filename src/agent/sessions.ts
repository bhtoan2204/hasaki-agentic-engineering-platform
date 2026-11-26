import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { one, pool, q } from "../db/pool.ts";
import { repositoryBaseBranch } from "../repos/service.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { AgentProvider } from "./provider.ts";

/** Optional subagents for independent, parallel, read-only work. Never registered unless the step opts in. */
export const SUBAGENTS: Record<string, { description: string; prompt: string }> = {
  explorer: {
    description:
      "Read-only codebase exploration: locate implementations, trace call paths, gather file:line evidence. Use for independent searches that can run in parallel.",
    prompt:
      "You are a read-only exploration subagent of an engineering workflow step. Investigate exactly what you were asked, " +
      "report concise findings with file:line evidence, and state what you could not verify. Never modify files, never run " +
      "commands that change state. Load platform knowledge with mcp__platform__read_knowledge / search_knowledge when useful.",
  },
  reviewer: {
    description:
      "Read-only review of a diff or set of files against conventions, business rules and security policies. Use for an independent second look.",
    prompt:
      "You are a read-only review subagent. Review what you were asked against the conventions and rules available through " +
      "mcp__platform__search_knowledge / read_knowledge. Report findings as severity, file:line, issue, suggestion. Never modify files.",
  },
};

export const execP = promisify(execFile);

/** Attempts `a` of step $1 in run $2 started after the last human re-execution (automatic repair rounds only). */
export const SINCE_HUMAN_REEXECUTE = `a.started_at > COALESCE((SELECT max(e.created_at) FROM workflow_events e WHERE e.run_id = $2 AND e.kind = 'status'
              AND (e.content LIKE '%(re-executed by user)%' OR e.content LIKE '%(re-executed with %' OR e.content LIKE '%(re-executed after rejection%')), '-infinity'::timestamptz)`;

/** Current state of each worktree (read-only git), so a re-executed coding step continues from it instead of redoing it. */
export async function worktreeState(
  workspaces: Array<{ repo: string; path: string }>,
): Promise<string> {
  const out: string[] = [];
  for (const w of workspaces) {
    const baseBranch = await repositoryBaseBranch(w.repo);
    if (!existsSync(w.path)) continue;
    const g = (...a: string[]) =>
      execP("git", ["-C", w.path, ...a], { maxBuffer: 4 * 1024 * 1024 })
        .then((r) => r.stdout.trim())
        .catch((e) => `(git ${a[0]} failed: ${String(e.message).split("\n")[0]})`);
    const [status, log, stat] = await Promise.all([
      g("status", "--porcelain"),
      g("log", "--oneline", "-n", "15", `origin/${baseBranch}..HEAD`),
      g("diff", "--stat", `origin/${baseBranch}...HEAD`),
    ]);
    out.push(
      `### ${w.repo} (${w.path})`,
      `commits ahead of ${baseBranch}:\n${log || "(none)"}`,
      `uncommitted:\n${status || "(clean)"}`,
      `diff stat vs ${baseBranch}:\n${stat.split("\n").slice(-25).join("\n") || "(none)"}`,
    );
  }
  return out.join("\n");
}

/**
 * One-shot timer that stops an agent session which outlives its submitted result. `arm()` starts it once (later calls
 * are no-ops, so a background wake-up does not extend the deadline); `fired` tells the caller the abort was ours.
 */
export function postSubmitReaper(stop: () => void, graceMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = {
    armed: false,
    fired: false,
    arm() {
      if (state.armed) return;
      state.armed = true;
      timer = setTimeout(() => {
        state.fired = true;
        stop();
      }, graceMs);
      timer.unref?.();
    },
    disarm() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
  return state;
}

type SnapshotContent = { upstream?: unknown; knowledge?: unknown } | null;

/** Find a provider session that can be resumed safely for this attempt (same step, same upstream context). */
export async function resumableSession(
  ctx: ExecutionContext,
  cwd: string,
  provider: AgentProvider,
): Promise<{ sessionId: string; fromAttempt?: number } | null> {
  const resume = ctx.input.pending?.resume;
  if (
    resume?.checkpoint?.execution?.workspace_reconciliation_required &&
    resume.checkpoint.execution.workspace_unavailable
  )
    return null;
  const candidates = await q<{
    session_id: string;
    attempt_id: number;
    generation: number;
    snapshot: SnapshotContent;
  }>(
    pool,
    `SELECT s.session_id, s.attempt_id, a.generation, cs.content AS snapshot
       FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id LEFT JOIN context_snapshots cs ON cs.id = a.context_snapshot_id
      WHERE a.step_id = $1 AND s.resumable AND s.cwd = $2 AND s.provider = $3 AND (a.effective_agent IS NOT DISTINCT FROM $4::jsonb) ORDER BY s.id DESC LIMIT 5`,
    [
      ctx.step.id,
      cwd,
      provider,
      ctx.attempt?.effective_agent ? JSON.stringify(ctx.attempt.effective_agent) : null,
    ],
  );
  if (!candidates.length) return null;
  const current = await one<{ content: SnapshotContent }>(
    pool,
    "SELECT content FROM context_snapshots WHERE id = $1",
    [ctx.context.snapshot_id],
  );
  const sameUpstream = (snap: SnapshotContent) =>
    JSON.stringify(snap?.upstream ?? {}) === JSON.stringify(current?.content?.upstream ?? {});
  // 1. resume after answers: the paused attempt's own session.
  if (resume?.from_attempt_id) {
    const c = candidates.find(
      (x) => x.attempt_id === resume.from_attempt_id && x.generation === ctx.step.generation,
    );
    if (
      c &&
      sameUpstream(c.snapshot) &&
      JSON.stringify(c.snapshot?.knowledge ?? []) ===
        JSON.stringify(current?.content?.knowledge ?? [])
    )
      return { sessionId: c.session_id, fromAttempt: c.attempt_id };
  }
  // 2. reviewer feedback: continue the step's last session if nothing upstream changed since.
  if (ctx.input.pending?.feedback) {
    const c = candidates.find((x) => sameUpstream(x.snapshot));
    if (c) return { sessionId: c.session_id };
  }
  return null;
}

/** Load developer/agent progress checkpoint notes written during an attempt. */
export async function progressNotes(fromAttempt?: number) {
  if (!fromAttempt) return [];
  const rows = await q<{ data: { note?: unknown } | null }>(
    pool,
    "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 AND reason = 'progress' ORDER BY id",
    [fromAttempt],
  );
  return rows.map((r) => String(r.data?.note ?? "")).filter(Boolean);
}
