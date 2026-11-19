import { tokens as wordTokens } from "../repos/service.ts";
import { termsOf } from "../context/plan.ts";
import type { RoutingDecision } from "./routing.ts";
import type { Continuation } from "./types.ts";
export type { Continuation } from "./types.ts";

/**
 * Continuation of an unfinished request. The platform — never the model — records after each tool-enabled turn what
 * the user asked (goal), what already ran (completed, with evidence refs), what stopped it (blockers) and which
 * operations are pending or unresolved. A follow-up ("làm lại", "connected now", "continue") resumes it with that
 * context instead of starting from scratch. Pure functions here; persistence is chat_conversations.continuation.
 */

export interface TurnFacts {
  turnId: number;
  message: string;
  route: string | null;
  effectiveMode: string | null;
  path: "direct" | "tools";
  status: "completed" | "failed" | "canceled";
  failure: { code?: string; message?: string } | null;
  stopReason: string | null;
  toolCalls: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    status: string;
    label?: string | null;
    error?: string | null;
    evidence_ref: string | null;
  }>;
  operations: Array<{
    id: number;
    tool: string;
    status: string;
    verification: { verified: boolean } | null;
  }>;
}

const MAX_ITEMS = 20;
const STALE_MS = 24 * 3600_000;
const UNFINISHED_OPS = new Set(["pending", "executing", "unknown", "failed"]);

const toolName = (c: TurnFacts["toolCalls"][number]) =>
  c.tool === "tools.call" && typeof c.arguments.name === "string" ? c.arguments.name : c.tool;

/**
 * The state after a turn. A tool-enabled turn that left blockers, an unfinished/unverified operation or an exhausted
 * budget keeps (or opens) the continuation; one that finished cleanly closes it. A direct answer changes nothing.
 */
export function nextContinuation(
  prev: Continuation | null,
  facts: TurnFacts,
  continued: boolean,
): Continuation | null {
  if (facts.path === "direct" && !continued) return prev;
  if (facts.status === "canceled") return prev;
  const base: Continuation =
    continued && prev
      ? { ...prev, blockers: [], turns: [...prev.turns, facts.turnId].slice(-10) }
      : {
          goal: facts.message.slice(0, 2000),
          goal_turn_id: facts.turnId,
          route: facts.route ?? "PLATFORM_QUERY",
          effective_mode: facts.effectiveMode ?? "ASK",
          status: "incomplete",
          completed: [],
          blockers: [],
          operations: [],
          turns: [facts.turnId],
          updated_at: "",
        };
  const completed = [...base.completed];
  for (const c of facts.toolCalls)
    if (
      c.status === "ok" &&
      !completed.some((x) => x.evidence_ref && x.evidence_ref === c.evidence_ref)
    )
      completed.push({
        tool: toolName(c),
        label: c.label ?? toolName(c),
        evidence_ref: c.evidence_ref,
        turn_id: facts.turnId,
      });
  const blockers: Continuation["blockers"] = [];
  for (const c of facts.toolCalls)
    if (c.status !== "ok")
      blockers.push({
        kind: "tool",
        tool: toolName(c),
        reason: (c.error ?? c.status).slice(0, 300),
        turn_id: facts.turnId,
      });
  if (facts.status === "failed")
    blockers.push({
      kind: "turn",
      reason: `${facts.failure?.code ?? "FAILED"}: ${facts.failure?.message ?? ""}`.slice(0, 300),
      turn_id: facts.turnId,
    });
  if (facts.stopReason)
    blockers.push({ kind: "budget", reason: facts.stopReason, turn_id: facts.turnId });
  const operations = new Map(base.operations.map((o) => [o.id, o]));
  for (const o of facts.operations)
    operations.set(o.id, {
      id: o.id,
      tool: o.tool,
      status: o.status,
      verified: o.verification?.verified ?? null,
    });
  for (const o of operations.values())
    if (UNFINISHED_OPS.has(o.status) || (o.status === "succeeded" && o.verified !== true))
      blockers.push({
        kind: "operation",
        tool: o.tool,
        reason:
          o.status === "succeeded"
            ? `operation #${o.id} ran but its outcome is not verified`
            : `operation #${o.id} is ${o.status}`,
        turn_id: facts.turnId,
      });
  // A resumed request that now finished cleanly closes it; a clean new topic leaves an older unfinished one alone.
  if (!blockers.length && facts.status === "completed") return continued ? null : prev;
  return {
    ...base,
    status: blockers.length ? "blocked" : "incomplete",
    completed: completed.slice(-MAX_ITEMS),
    blockers: blockers.slice(0, MAX_ITEMS),
    operations: [...operations.values()].slice(-MAX_ITEMS),
    updated_at: new Date().toISOString(),
  };
}

const meaningful = (s: string) => termsOf(s).filter((t) => t.length > 2);

/**
 * Does this message continue the unfinished request? Decided from context, not from a phrase list:
 *  - it shares a substantial part of its vocabulary with the goal (the user restates or narrows it), or
 *  - it is short and carries no routing signal of its own (a confirmation, "retry", "connected now", "làm lại đi").
 * A message with its own clear intent and little in common with the goal is a topic change. An ambiguous short
 * message still resumes with the goal in view; the model is told to answer an unrelated one (thanks, a quick question)
 * without running tools, so no extra model call is needed to classify it.
 */
export function continuesGoal(
  message: string,
  cont: Continuation | null,
  decision: Pick<RoutingDecision, "route" | "source">,
  now = Date.now(),
): { continues: boolean; reason: string } {
  if (!cont) return { continues: false, reason: "nothing unfinished" };
  if (now - new Date(cont.updated_at).getTime() > STALE_MS)
    return { continues: false, reason: "unfinished request is stale" };
  if (decision.source === "explicit" || decision.source === "mention")
    return { continues: false, reason: "explicit mode or mention sets a new context" };
  const words = [...new Set(meaningful(message))];
  const goal = new Set(meaningful(cont.goal));
  const shared = words.filter((w) => goal.has(w)).length;
  if (words.length && shared / words.length >= 0.3)
    return { continues: true, reason: "refers to the unfinished request" };
  const short = wordTokens(message).length <= 6;
  if (
    short &&
    (decision.route === "DIRECT_ANSWER" ||
      decision.source === "default" ||
      decision.source === "context")
  )
    return { continues: true, reason: "short follow-up while a request is unfinished" };
  return { continues: false, reason: "a new request with its own intent" };
}

/** The prompt section for a resumed request: goal, evidence already gathered, blockers (refreshed), operations. */
export function continuationBrief(
  cont: Continuation,
  refreshed: Array<{ tool: string; available: true | string }>,
  evidence: Array<{ ref: string; tool: string; body: string }>,
) {
  const lines = [
    `Unfinished request from earlier in this conversation (turn #${cont.goal_turn_id}): ${cont.goal}`,
    "If the current message continues it (retry, continue, a blocker was resolved, a correction), resume from where it stopped:",
    "reuse the evidence below instead of re-reading it, do not repeat operations that already ran or are pending (the platform refuses duplicates),",
    "and if a tool is still unavailable, try another authorized tool that can give the same evidence before giving up.",
    "If the current message is unrelated (thanks, a different quick question), just answer it and do not run tools for the old request.",
  ];
  if (cont.completed.length)
    lines.push(
      `Done so far: ${cont.completed.map((c) => `${c.label}${c.evidence_ref ? ` [${c.evidence_ref}]` : ""}`).join("; ")}`,
    );
  if (cont.blockers.length) {
    lines.push("What stopped it:");
    for (const b of cont.blockers) {
      const now = b.tool ? refreshed.find((r) => r.tool === b.tool)?.available : undefined;
      lines.push(
        `- ${b.tool ? `${b.tool}: ` : ""}${b.reason}${now === undefined ? "" : now === true ? " — NOW AVAILABLE (sessions refreshed)" : ` — still unavailable: ${now}`}`,
      );
    }
  }
  if (cont.operations.length)
    lines.push(
      `Operations: ${cont.operations.map((o) => `#${o.id} ${o.tool} ${o.status}${o.verified === true ? " (verified)" : o.verified === false ? " (verification failed)" : ""}`).join("; ")}`,
    );
  for (const e of evidence) lines.push(`Earlier evidence ${e.ref} (${e.tool}):\n${e.body}`);
  return lines.join("\n");
}
