import { createHash } from "node:crypto";
import { pool, q, one } from "../db/pool.ts";
import { config } from "../config.ts";
import { execution } from "../auth/execution.ts";
import { audit } from "../authz/access.ts";
import { HttpError } from "../http/error.ts";
import { callTool, integrationTools } from "../agent/toolRegistry.ts";
import { redactContextValue } from "../context/redact.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";
import { classifyArguments, type Classification } from "../agent/taint.ts";
import { qcPreauthorized } from "../integrations/qcHttp.ts";
import { kafkaPreauthorized } from "../integrations/kafka.ts";

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
  auto: boolean;
  provenance: Pick<Classification, "decision" | "fields" | "reasons"> | null;
  verification: {
    verified: boolean;
    tool_call_id: number;
    tool: string;
    match: string;
    at: string;
  } | null;
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

const SOURCE_ROWS = 200;
const SOURCE_CHARS = 200_000;
/**
 * Where an operation's argument values come from (ADR 0010): the owner's own messages in this conversation (control
 * authority) against everything observed in it — tool results (CodeAct included) and attached documents. Only this
 * owner's records of this conversation are read; a target inside the operator's pre-authorized scope is trusted.
 */
export async function operationProvenance(
  binding: { userId: number; conversationId: number },
  tool: string,
  args: Record<string, unknown>,
): Promise<Classification> {
  const [messages, observed, documents] = await Promise.all([
    q<{ id: number; content: string }>(
      pool,
      `SELECT m.id, m.content FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = $1 AND c.owner_id = $2 AND m.role = 'user' AND NOT m.superseded
       ORDER BY m.id DESC LIMIT $3`,
      [binding.conversationId, binding.userId, SOURCE_ROWS],
    ),
    q<{ id: number; text: string }>(
      pool,
      `SELECT id, left(result::text, $3) AS text FROM chat_tool_calls
       WHERE conversation_id = $1 AND owner_id = $2 AND result IS NOT NULL ORDER BY id DESC LIMIT $4`,
      [binding.conversationId, binding.userId, SOURCE_CHARS, SOURCE_ROWS],
    ),
    q<{ id: number; text: string }>(
      pool,
      `SELECT id, left(extraction::text, $3) AS text FROM chat_attachments
       WHERE conversation_id = $1 AND owner_id = $2 AND extraction IS NOT NULL ORDER BY id DESC LIMIT $4`,
      [binding.conversationId, binding.userId, SOURCE_CHARS, SOURCE_ROWS],
    ),
  ]);
  return classifyArguments(tool, args, {
    trusted: messages.map((m) => ({ ref: `message:${m.id}`, text: m.content })),
    untrusted: [
      ...observed.map((o) => ({
        ref: `chat:${binding.conversationId}:tool:${o.id}`,
        text: o.text,
      })),
      ...documents.map((d) => ({ ref: `document:${d.id}`, text: d.text })),
    ],
    // The operator's pre-authorized scope (the same rules that allow running without confirmation).
    configured: (field) =>
      tool === "kafka.publish"
        ? (field === "topic" || field === "cluster") &&
          kafkaPreauthorized(
            String(args.topic ?? ""),
            args.cluster ? String(args.cluster) : undefined,
          )
        : tool === "qc_http.request" &&
          field === "url" &&
          qcPreauthorized(String(args.method ?? "").toUpperCase(), String(args.url ?? "")),
  });
}

/**
 * Called by the chat `tools.call` tool for a mutating integration tool. A pre-authorized low-risk QC call runs now
 * through the same confirmation path (idempotency, re-validation, audit); anything else waits for the owner.
 */
export async function proposeOperation(
  binding: { userId: number; conversationId: number; turnId: number },
  tool: string,
  rawArgs: unknown,
) {
  const { args, target } = await validate(binding.userId, tool, rawArgs);
  // Runtime provenance (ADR 0010): an observation can never choose the target, nor skip the owner's confirmation.
  const provenance = await operationProvenance(binding, tool, args);
  await audit(
    binding.userId,
    "chat.operation.taint",
    "chat_conversation",
    String(binding.conversationId),
    {
      turn_id: binding.turnId,
      tool,
      decision: provenance.decision,
      fields: provenance.fields,
    },
  );
  if (provenance.decision === "deny")
    throw new Error(`operation refused: ${provenance.reasons.join("; ")}`);
  const used = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM chat_operations WHERE turn_id = $1 AND status NOT IN ('rejected', 'expired', 'duplicate')",
    [binding.turnId],
  );
  if ((used?.n ?? 0) >= config.qcHttp.maxOperationsPerTurn)
    throw new Error(
      `operation budget reached: at most ${config.qcHttp.maxOperationsPerTurn} operations per turn — report what was done and stop`,
    );
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
    `INSERT INTO chat_operations (conversation_id, owner_id, turn_id, tool, arguments, target, idempotency_key, expires_at,
       provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8), $9)
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
      JSON.stringify({
        decision: provenance.decision,
        fields: provenance.fields,
        reasons: provenance.reasons,
      }),
    ],
  );
  if (row!.inserted)
    await audit(binding.userId, "chat.operation.propose", "chat_operation", String(row!.id), {
      conversation_id: binding.conversationId,
      tool,
      target,
      idempotency_key: key,
    });
  const preauthorized =
    row!.inserted &&
    provenance.decision === "allow" &&
    !!mutatingTool(tool)?.preauthorized?.(args as never);
  if (preauthorized) {
    await q(pool, "UPDATE chat_operations SET auto = true WHERE id = $1", [row!.id]);
    await audit(binding.userId, "chat.operation.preauthorized", "chat_operation", String(row!.id), {
      tool,
      target,
    });
    const done = await decideOperation({ id: binding.userId }, row!.id, "confirm");
    return {
      status: done.status,
      operation_id: done.id,
      tool,
      target,
      preauthorized: true,
      ...(done.result != null ? { result: done.result } : {}),
      ...(done.error ? { error: done.error } : {}),
      message:
        done.status === "succeeded"
          ? "Executed once as a pre-authorized QC operation. The business outcome is NOT verified: read it back and call operations.verify before claiming success."
          : `Not completed (${done.status}). Do not retry blindly: ${done.status === "unknown" ? "check whether it happened first" : "fix the cause first"}.`,
    };
  }
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
    ...(provenance.reasons.length ? { needs_confirmation_because: provenance.reasons } : {}),
    message:
      "Not executed. The user must confirm this operation in the chat UI; tell them what it will do" +
      (provenance.reasons.length ? " and that some of its values come from untrusted data." : "."),
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
      return `Operation #${op.id} (${op.tool} → ${target}) was accepted by the target (${op.tool === "kafka.publish" ? "the event was published" : "the service answered with success"}). The business outcome is NOT verified yet.`;
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

/**
 * Outcome verification, checked by the platform: a successful read-only tool call of this turn, made after the
 * operation finished, whose result contains an identifier that also appears in the operation's payload or response
 * (an order code, an event id). The model cannot mark an operation verified by saying so.
 */
export async function verifyOperation(
  binding: { userId: number; conversationId: number; turnId: number },
  input: { operation_id: number; evidence_seq: number; match: string },
  onVerified?: (op: OperationRow) => void,
) {
  const op = await one<OperationRow>(
    pool,
    "SELECT * FROM chat_operations WHERE id = $1 AND owner_id = $2 AND conversation_id = $3",
    [input.operation_id, binding.userId, binding.conversationId],
  );
  if (!op) throw new Error(`operation ${input.operation_id} not found in this conversation`);
  if (!["succeeded", "unknown"].includes(op.status) || !op.finished_at)
    throw new Error(`operation ${op.id} is ${op.status}: nothing to verify`);
  const match = input.match.trim();
  if (match.length < 3) throw new Error("match must be an identifier of at least 3 characters");
  if (!JSON.stringify([op.arguments, op.result]).includes(match))
    throw new Error(
      `"${match}" does not appear in operation ${op.id}'s payload or response: pick its identifier`,
    );
  const evidence = await one<{
    id: number;
    tool: string;
    arguments: Record<string, unknown>;
    result: unknown;
    created_at: string;
  }>(
    pool,
    `SELECT id, tool, arguments, result, created_at FROM chat_tool_calls
      WHERE conversation_id = $1 AND owner_id = $2 AND turn_id = $3 AND seq = $4 AND status = 'ok'`,
    [binding.conversationId, binding.userId, binding.turnId, input.evidence_seq],
  );
  if (!evidence) throw new Error(`no successful tool call #${input.evidence_seq} in this turn`);
  const integration = evidence.tool === "tools.call" ? String(evidence.arguments.name ?? "") : null;
  const readOnly =
    evidence.tool !== "operations.verify" &&
    (integration == null || integrationTools().some((t) => t.name === integration && t.readOnly));
  if (!readOnly)
    throw new Error(`tool call #${input.evidence_seq} changed state; verification needs a read`);
  if (new Date(evidence.created_at).getTime() < new Date(op.finished_at).getTime())
    throw new Error(`tool call #${input.evidence_seq} ran before the operation finished`);
  const verified = JSON.stringify(evidence.result).includes(match);
  const verification = {
    verified,
    tool_call_id: evidence.id,
    tool: integration ?? evidence.tool,
    match,
    at: new Date().toISOString(),
  };
  const row = (await one<OperationRow>(
    pool,
    "UPDATE chat_operations SET verification = $2 WHERE id = $1 RETURNING *",
    [op.id, JSON.stringify(verification)],
  ))!;
  await audit(
    binding.userId,
    `chat.operation.${verified ? "verified" : "unverified"}`,
    "chat_operation",
    String(op.id),
    verification,
  );
  await chatRepository.insertMessage({
    conversationId: op.conversation_id,
    turnId: null,
    role: "assistant",
    content: verified
      ? `Operation #${op.id} verified: "${match}" was read back by ${verification.tool} (tool call #${input.evidence_seq}).`
      : `Operation #${op.id} NOT verified: "${match}" was not found in the result of ${verification.tool} (tool call #${input.evidence_seq}).`,
  });
  await emitChatEvent({
    conversationId: op.conversation_id,
    ownerId: op.owner_id,
    turnId: binding.turnId,
    kind: "operation.updated",
    data: { operation_id: op.id, status: op.status, verified },
  });
  if (verified) onVerified?.(row);
  return { operation_id: op.id, ...verification };
}
