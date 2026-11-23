import { z } from "zod";
import { pool, one } from "../db/pool.ts";
import { currentUserId } from "../auth/execution.ts";
import { registerIntegrationTool } from "../agent/toolRegistry.ts";

/**
 * Run orchestration from chat. Every tool here is `confirm`-only: the model proposes, the owner confirms in the chat
 * UI, and the handler then acts as that owner on that owner's own run (workflow engine functions, same as the REST
 * routes). An agent inside a workflow can never call them (see callTool).
 */
const runId = z.number().int().positive();
const stepKey = z
  .string()
  .regex(/^[a-z0-9_-]+$/)
  .max(100);

async function ownedRun(id: number) {
  const userId = currentUserId();
  if (!userId) throw new Error("no authenticated user");
  const run = await one<{ id: number; title: string; status: string; definition_key: string }>(
    pool,
    "SELECT id, title, status, definition_key FROM workflow_runs WHERE id = $1 AND owner_id = $2",
    [id, userId],
  );
  if (!run) throw new Error(`run ${id} not found`);
  return { userId, run };
}

const target = async (action: string, id: number, step?: string) => {
  const { run } = await ownedRun(id);
  return {
    action,
    run: `#${run.id} ${run.title}`.slice(0, 120),
    ...(step ? { step } : {}),
    status: run.status,
  };
};

const engine = () => import("../workflow/engine.ts");

async function usernameOf(userId: number) {
  const u = await one<{ username: string }>(pool, "SELECT username FROM users WHERE id = $1", [
    userId,
  ]);
  return u?.username ?? `user:${userId}`;
}

export function registerPlatformOps() {
  const def = <S extends z.ZodObject>(
    name: string,
    summary: string,
    input: S,
    preflight: (a: z.infer<S>) => Promise<unknown>,
    handler: (a: z.infer<S>) => Promise<unknown>,
  ) =>
    registerIntegrationTool({
      name,
      summary: `${summary} Needs the user's confirmation in chat.`,
      description: `Mutating. ${summary} Only your own runs. It never runs directly: it becomes an operation the user confirms; the result is the platform's, not yours to claim.`,
      input,
      readOnly: false,
      confirm: true,
      available: () => true,
      preflight,
      handler,
    });

  def(
    "runs.start",
    "Start a pending (proposed) workflow run.",
    z.object({
      run_id: runId,
      repositories: z.array(z.string().min(1).max(200)).max(10).optional(),
      step_mode: z.boolean().optional(),
    }),
    (a) => target("start", a.run_id),
    async (a) => {
      await ownedRun(a.run_id);
      return (await engine()).startPendingRun(a.run_id, a.repositories, !!a.step_mode);
    },
  );
  def(
    "runs.cancel",
    "Cancel a workflow run.",
    z.object({ run_id: runId, reason: z.string().max(300).optional() }),
    (a) => target("cancel", a.run_id),
    async (a) => {
      await ownedRun(a.run_id);
      return (await engine()).cancelRun(a.run_id, a.reason || "canceled from chat");
    },
  );
  def(
    "runs.pause",
    "Pause a running workflow run.",
    z.object({ run_id: runId }),
    (a) => target("pause", a.run_id),
    async (a) => {
      await ownedRun(a.run_id);
      return (await engine()).pauseRun(a.run_id);
    },
  );
  def(
    "runs.resume",
    "Resume a paused workflow run.",
    z.object({ run_id: runId }),
    (a) => target("resume", a.run_id),
    async (a) => {
      await ownedRun(a.run_id);
      return (await engine()).resumeRun(a.run_id);
    },
  );
  def(
    "runs.retry_step",
    "Retry one step of a workflow run.",
    z.object({ run_id: runId, step_key: stepKey }),
    (a) => target("retry step", a.run_id, a.step_key),
    async (a) => {
      await ownedRun(a.run_id);
      return (await engine()).retryStep(a.run_id, a.step_key);
    },
  );
  def(
    "runs.approve_step",
    "Approve a workflow step that waits for approval.",
    z.object({ run_id: runId, step_key: stepKey, comment: z.string().max(1000).optional() }),
    (a) => target("approve step", a.run_id, a.step_key),
    async (a) => {
      const { userId } = await ownedRun(a.run_id);
      return (await engine()).approveStep(a.run_id, a.step_key, {
        comment: a.comment,
        by: await usernameOf(userId),
      });
    },
  );
  def(
    "runs.reject_step",
    "Reject a workflow step that waits for approval.",
    z.object({ run_id: runId, step_key: stepKey, comment: z.string().max(1000).optional() }),
    (a) => target("reject step", a.run_id, a.step_key),
    async (a) => {
      const { userId } = await ownedRun(a.run_id);
      return (await engine()).rejectStep(a.run_id, a.step_key, {
        comment: a.comment,
        by: await usernameOf(userId),
      });
    },
  );
}
