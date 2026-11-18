import { config } from "../../config.ts";
import { one, pool } from "../../db/pool.ts";
import { workspacesOf } from "../../git/provider.ts";
import type { HarnessFailureCode } from "./failure.ts";

export type StopReason = "canceled" | "timeout" | "idle";

const MICRO_IDLE_CAP_MS = 3 * 60_000;

/** Wall-clock and idle limits of one provider turn: step settings, then provider config, then platform defaults. */
export function turnLimits(
  agent:
    | { timeout_ms?: number; idle_timeout_ms?: number; execution_profile?: string }
    | null
    | undefined,
  providerTimeoutMs?: number,
): { timeoutMs: number; idleMs: number } {
  const timeoutMs =
    agent?.timeout_ms ?? providerTimeoutMs ?? config.agent.turnTimeoutMs ?? 45 * 60_000;
  let idleMs = agent?.idle_timeout_ms ?? config.agent.idleTimeoutMs ?? 10 * 60_000;
  if (agent?.execution_profile === "MICRO") idleMs = Math.min(idleMs, MICRO_IDLE_CAP_MS);
  return { timeoutMs, idleMs: Math.min(idleMs, timeoutMs) };
}

export interface Watchdog {
  /** Why the turn was stopped, or null while it may continue. */
  readonly reason: StopReason | null;
  /** Records provider activity (a stream event, a hook call); resets the idle timer. */
  touch(): void;
  dispose(): void;
}

/**
 * One supervisor for every provider turn: cancellation, the wall-clock limit and idle detection all end the turn
 * through `stop` exactly once, and `reason` tells the caller which one fired.
 */
export function superviseTurn(opts: {
  signal: AbortSignal;
  timeoutMs: number;
  idleMs: number;
  stop: (reason: StopReason) => void;
}): Watchdog {
  let reason: StopReason | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const end = (why: StopReason) => {
    if (reason) return;
    reason = why;
    opts.stop(why);
  };
  const onAbort = () => end("canceled");
  const wallTimer = setTimeout(() => end("timeout"), opts.timeoutMs);
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => end("idle"), opts.idleMs);
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  armIdle();
  if (opts.signal.aborted) onAbort();
  return {
    get reason() {
      return reason;
    },
    touch() {
      if (!reason) armIdle();
    },
    dispose() {
      clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal.removeEventListener("abort", onAbort);
    },
  };
}

/** The failure a stopped turn reports, identical for every provider. */
export function stopFailure(
  reason: StopReason,
  label: string,
  limits: { timeoutMs: number; idleMs: number },
): { text: string; failure: HarnessFailureCode } {
  switch (reason) {
    case "canceled":
      return { text: "canceled", failure: "CANCELED" };
    case "timeout":
      return {
        text: `${label} execution timeout: turn exceeded the ${Math.round(limits.timeoutMs / 60000)} minute limit and was stopped`,
        failure: "EXECUTION_TIMEOUT",
      };
    case "idle":
      return {
        text: `${label} made no progress for ${Math.round(limits.idleMs / 60000)} minute(s) (no output and no tool call) and was stopped`,
        failure: "IDLE_TIMEOUT",
      };
  }
}

/** The last result the agent recorded with submit_result in this attempt. */
export async function readSubmitted(
  attemptId: number,
): Promise<Record<string, unknown> | undefined> {
  const row = await one<{ data: { output?: Record<string, unknown> } }>(
    pool,
    "SELECT data FROM workflow_checkpoints WHERE attempt_id = $1 AND reason = 'submit_result' ORDER BY id DESC LIMIT 1",
    [attemptId],
  ).catch(() => null);
  return row?.data?.output;
}

/** Worktrees prepared during the turn become writable for the rest of the attempt. */
export async function adoptRunWorkspaces(runId: number, policy: { workspaces: string[] }) {
  for (const w of await workspacesOf(runId))
    if (!policy.workspaces.includes(w.path)) policy.workspaces.push(w.path);
}
