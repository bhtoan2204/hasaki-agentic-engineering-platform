import { createHash } from "node:crypto";
import { pool, q, one } from "../db/pool.ts";
import { execution } from "../auth/execution.ts";
import { audit } from "../authz/access.ts";
import { HttpError } from "../http/error.ts";
import { callTool, integrationTools } from "../agent/toolRegistry.ts";
import { redactContextValue } from "../context/redact.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";

/**
 * Mutating integration calls from chat. The model can only *propose* one: the platform validates the schema and the
 * tool's deterministic preflight (QC allowlist, never production), stores it as `pending` and the owner confirms or
 * rejects it in the UI. Confirmation re-checks everything and runs the call once per idempotency key (a unique index,
 * not a read-then-write). The platform — not the model — writes the outcome into the conversation.
 */
export const OPERATION_TTL_MS = 15 * 60_000;

export interface OperationRow {
  id: number;
  conversation_id: number;
  owner_id: number;
  turn_id: number | null;
  tool: string;
  arguments: Record<string, unknown>;
  target: Record<string, unknown>;
  idempotency_key: string;
  status: string;
  result: unknown;
  error: string | null;
  expires_at: string;
  decided_at: string | null;
  finished_at: string | null;
  created_at: string;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

export const operationKey = (ownerId: number, tool: string, args: unknown) =>
  createHash("sha256")
    .update(`${ownerId}|${tool}|${JSON.stringify(canonical(args))}`)
    .digest("hex");

const mutatingTool = (name: string) =>
  integrationTools().find((t) => t.name === name && !t.readOnly);

async function validate(ownerId: number, tool: string, rawArgs: unknown) {
  const t = mutatingTool(tool);
  if (!t?.confirm) throw new Error(`${tool} is not an operation chat can run`);
  const parsed = t.input.safeParse(rawArgs ?? {});
  if (!parsed.success)
    throw new Error(
      `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const avail = await execution.run({ userId: ownerId, kind: "user" }, async () => {
    await loadPersonalIntegrations();
    return t.available();
  });
  if (avail !== true) throw new Error(`${tool} is unavailable: ${avail}`);
  const target = t.preflight
    ? await execution.run({ userId: ownerId, kind: "user" }, async () => t.preflight!(parsed.data))
    : {};
  return {
    args: parsed.data as Record<string, unknown>,
    target: (target ?? {}) as Record<string, unknown>,
  };
}

/** Called by the chat `tools.call` tool for a mutating integration tool: never executes, only proposes. */
export async function proposeOperation(
  binding: { userId: number; conversationId: number; turnId: number },
  tool: string,
  rawArgs: unknown,
) {
  const { args, target } = await validate(binding.userId, tool, rawArgs);
  const key = operationKey(binding.userId, tool, args);
  const done = await one<OperationRow>(
    pool,
    "SELECT * FROM chat_operations WHERE owner_id = $1 AND idempotency_key = $2 AND status IN ('executing', 'succeeded', 'unknown') LIMIT 1",
    [binding.userId, key],
  );
  if (done)
    return {
      status: "duplicate",
      operation_id: done.id,
      previous_status: done.status,
      message: `This exact call already ran as operation #${done.id} (${done.status}); it will not run again. Change the payload (e.g. a new id) for a new event.`,
    };
  const row = await one<OperationRow & { inserted: boolean }>(
    pool,
    `INSERT INTO chat_operations (conversation_id, owner_id, turn_id, tool, arguments, target, idempotency_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
     ON CONFLICT (conversation_id, idempotency_key) WHERE status = 'pending'
       DO UPDATE SET expires_at = EXCLUDED.expires_at
     RETURNING *, (xmax = 0) AS inserted`,
    [
      binding.conversationId,
      binding.userId,
      binding.turnId,
      tool,
      JSON.stringify(args),
      JSON.stringify(target),
      key,
      OPERATION_TTL_MS / 1000,
    ],
  );
  if (row!.inserted)
    await audit(binding.userId, "chat.operation.propose", "chat_operation", String(row!.id), {
      conversation_id: binding.conversationId,
      tool,
      target,
      idempotency_key: key,
    });
  await emitChatEvent({
    conversationId: binding.conversationId,
    ownerId: binding.userId,
    turnId: binding.turnId,
    kind: "operation.updated",
    data: { operation_id: row!.id, status: "pending" },
  });
  return {
    status: "confirmation_required",
    operation_id: row!.id,
    tool,
    target,
    message:
      "Not executed. The user must confirm this operation in the chat UI; tell them what it will do.",
  };
}

export const operationsOf = (conversationId: number, ownerId: number) =>
  q<OperationRow>(
    pool,
    "SELECT * FROM chat_operations WHERE conversation_id = $1 AND owner_id = $2 ORDER BY id",
    [conversationId, ownerId],
  );

const AMBIGUOUS = /timeout|timed out|aborted|fetch failed|network|ECONN|socket|EAI_AGAIN/i;

async function finish(
  op: OperationRow,
  status: string,
  fields: { result?: unknown; error?: string | null },
) {
  const row = await one<OperationRow>(
    pool,
    "UPDATE chat_operations SET status = $2, result = $3, error = $4, finished_at = now() WHERE id = $1 RETURNING *",
    [
      op.id,
      status,
      fields.result == null ? null : JSON.stringify(fields.result),
      fields.error ?? null,
    ],
  );
  return row!;
}

function outcomeText(op: OperationRow) {
  const target = Object.values(op.target).filter(Boolean).join("/");
  switch (op.status) {
    case "succeeded":
      return `Operation #${op.id} (${op.tool} → ${target}) succeeded: the event was published. Downstream processing is NOT verified yet.`;
    case "unknown":
      return `Operation #${op.id} (${op.tool} → ${target}): outcome unknown (${op.error}). It may or may not have been published; it will not be repeated automatically — check the topic before retrying.`;
    case "failed":
      return `Operation #${op.id} (${op.tool} → ${target}) failed: ${op.error}`;
    case "duplicate":
      return `Operation #${op.id} was not executed: ${op.error}`;
    case "rejected":
      return `Operation #${op.id} (${op.tool} → ${target}) was rejected by the user; nothing was executed.`;
    default:
      return `Operation #${op.id} (${op.tool} → ${target}): ${op.status}${op.error ? ` — ${op.error}` : ""}`;
  }
}

async function announce(op: OperationRow) {
  // A platform-written note, so later turns (and the user) see the real outcome rather than the model's claim.
  await chatRepository.insertMessage({
    conversationId: op.conversation_id,
    turnId: null,
    role: "assistant",
    content: outcomeText(op),
  });
  await emitChatEvent({
    conversationId: op.conversation_id,
    ownerId: op.owner_id,
    turnId: op.turn_id,
    kind: "operation.updated",
    data: { operation_id: op.id, status: op.status },
  });
}

/** Owner decision. Repeated or concurrent clicks return the current state and never run the call twice. */
export async function decideOperation(
  actor: { id: number },
  id: number,
  decision: "confirm" | "reject",
  onSucceeded?: (op: OperationRow) => void,
) {
  const op = await one<OperationRow>(
    pool,
    "SELECT * FROM chat_operations WHERE id = $1 AND owner_id = $2",
    [id, actor.id],
  );
  if (!op) throw new HttpError(404, "not found");
  if (op.status !== "pending") return op;
  if (new Date(op.expires_at).getTime() < Date.now()) {
    const expired = await one<OperationRow>(
      pool,
      "UPDATE chat_operations SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
      [id],
    );
    return expired ?? op;
  }
  if (decision === "reject") {
    const rejected = await one<OperationRow>(
      pool,
      "UPDATE chat_operations SET status = 'rejected', decided_at = now(), finished_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
      [id],
    );
    if (!rejected)
      return (await one<OperationRow>(pool, "SELECT * FROM chat_operations WHERE id = $1", [id]))!;
    await audit(actor.id, "chat.operation.reject", "chat_operation", String(id), { tool: op.tool });
    await announce(rejected);
    return rejected;
  }
  const user = await chatRepository.userActive(actor.id);
  if (!user?.active) throw new HttpError(403, "user is not active");
  let checked: Awaited<ReturnType<typeof validate>>;
  try {
    checked = await validate(actor.id, op.tool, op.arguments);
  } catch (e) {
    const failed = await finish(op, "failed", { error: (e as Error).message.slice(0, 500) });
    await audit(actor.id, "chat.operation.denied", "chat_operation", String(id), {
      tool: op.tool,
      error: failed.error,
    });
    await announce(failed);
    return failed;
  }
  let claimed: OperationRow | null | undefined = null;
  try {
    claimed = await one<OperationRow>(
      pool,
      "UPDATE chat_operations SET status = 'executing', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
      [id],
    );
  } catch (e) {
    if ((e as { code?: string }).code !== "23505") throw e;
  }
  if (!claimed) {
    const now = (await one<OperationRow>(pool, "SELECT * FROM chat_operations WHERE id = $1", [
      id,
    ]))!;
    if (now.status !== "pending") return now;
    const dup = await finish(now, "duplicate", {
      error: "this exact call already ran; it is not repeated",
    });
    await announce(dup);
    return dup;
  }
  await audit(actor.id, "chat.operation.execute", "chat_operation", String(id), {
    tool: op.tool,
    target: checked.target,
    idempotency_key: op.idempotency_key,
  });
  const r = await execution.run({ userId: actor.id, kind: "user" }, () =>
    callTool(op.tool, checked.args, {
      runId: null,
      allowedRepositories: [],
      mode: "coding",
      stepKey: `chat:${op.conversation_id}`,
      confirmedOperation: { id: op.id, idempotencyKey: op.idempotency_key },
    }),
  );
  const done = r.ok
    ? await finish(claimed, "succeeded", { result: redactContextValue(r.result) })
    : await finish(claimed, AMBIGUOUS.test(r.error ?? "") ? "unknown" : "failed", {
        error: (r.error ?? "").slice(0, 500),
      });
  await audit(actor.id, `chat.operation.${done.status}`, "chat_operation", String(id), {
    tool: op.tool,
    ms: r.ms,
  });
  await announce(done);
  if (done.status === "succeeded") onSucceeded?.(done);
  return done;
}
