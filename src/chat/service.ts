import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http/error.ts";

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw new HttpError(
      400,
      r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  return r.data;
}
import { withTx } from "../db/pool.ts";
import { audit, type Actor } from "../authz/access.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import { parseAgentProvider, AGENT_PROVIDERS } from "../agent/provider.ts";
import { chatRepository } from "./repository.ts";
import { CHAT_MODES, type ChatMode, type ConversationRow } from "./types.ts";
import { LIMITS } from "./policy.ts";
import { emitChatEvent } from "./events.ts";
import {
  abortLocal,
  recoverStaleTurns,
  scheduleTurn,
  withholdRevoked,
} from "./runtime.ts";
import { readableRepositories } from "./tools.ts";
import {
  buildDelegationPreview,
  DelegationRequest,
  executeDelegation,
} from "./delegation.ts";

const ConversationCreate = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    mode: z.enum(CHAT_MODES).optional(),
    provider: z.string().max(40).nullable().optional(),
    model: z.string().max(120).nullable().optional(),
    reasoning_effort: z.string().max(40).nullable().optional(),
    repositories: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();

const ConversationPatch = ConversationCreate.extend({
  archived: z.boolean().optional(),
}).strict();

const MessagePost = z
  .object({
    content: z.string().min(1).max(LIMITS.messageChars),
    client_message_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    mode: z.enum(CHAT_MODES).optional(),
    provider: z.string().max(40).nullable().optional(),
    model: z.string().max(120).nullable().optional(),
    reasoning_effort: z.string().max(40).nullable().optional(),
    repositories: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();

async function assertRepos(userId: number, names: string[] | undefined) {
  if (!names?.length) return [] as string[];
  const readable = await readableRepositories(userId);
  const outside = names.filter((r) => !readable.includes(r));
  if (outside.length)
    throw new HttpError(403, `repositories not found or not accessible: ${outside.join(", ")}`);
  return names;
}

async function assertProvider(provider: string | null | undefined) {
  if (provider == null || provider === "") return null;
  const p = parseAgentProvider(provider);
  if (!p) throw new HttpError(400, `provider must be one of ${AGENT_PROVIDERS.join(", ")}`);
  const cfg = await loadAgentConfiguration();
  if (!cfg.providers[p]?.enabled) throw new HttpError(400, `provider ${p} is disabled in Settings`);
  return p;
}

async function requireConversation(id: number, actor: Actor): Promise<ConversationRow> {
  const row = await chatRepository.getConversation(id, actor.id);
  if (!row) throw new HttpError(404, "not found");
  return row;
}

function publicConversation(
  c: ConversationRow & { last_message?: string | null; active_turn?: number | null },
) {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    mode: c.mode,
    provider: c.provider,
    model: c.model,
    reasoning_effort: c.reasoning_effort,
    repositories: c.repositories,
    work_item_id: c.work_item_id,
    run_id: c.run_id,
    summary: c.summary,
    usage: c.usage,
    archived: c.archived,
    created_at: c.created_at,
    updated_at: c.updated_at,
    last_message: c.last_message ?? undefined,
    active_turn: c.active_turn ?? null,
  };
}

export const chat = {
  async list(actor: Actor, opts: { search?: string; archived?: boolean; limit?: number } = {}) {
    return (await chatRepository.listConversations(actor.id, opts)).map(publicConversation);
  },

  async create(actor: Actor, body: unknown) {
    const input = parse(ConversationCreate, body);
    const provider = await assertProvider(input.provider);
    const repositories = await assertRepos(actor.id, input.repositories);
    const cfg = await loadAgentConfiguration();
    const row = await chatRepository.createConversation({
      ownerId: actor.id,
      title: (input.title ?? "").trim(),
      description: (input.description ?? "").trim(),
      mode: input.mode ?? "ASK",
      provider: provider ?? cfg.default_provider,
      model: input.model ?? null,
      reasoningEffort: input.reasoning_effort ?? null,
      repositories,
      workItemId: null,
      runId: null,
    });
    await audit(actor.id, "chat.create", "chat_conversation", String(row.id), {
      mode: row.mode,
      provider: row.provider,
    });
    return publicConversation(row);
  },

  async get(actor: Actor, id: number) {
    await recoverStaleTurns(id);
    const c = await requireConversation(id, actor);
    const readable = await readableRepositories(actor.id);
    const messages = withholdRevoked(await chatRepository.listMessages(id, { limit: 200 }), readable);
    const tools = (await chatRepository.toolCallsOf(id)).map((t) => ({
      id: t.id,
      turn_id: t.turn_id,
      seq: t.seq,
      tool: t.tool,
      arguments: t.arguments,
      status: t.status,
      // Revoked repositories: do not re-distribute the tool result content.
      result:
        t.repositories.some((r) => !readable.includes(r))
          ? { withheld: true, error: "repository access was revoked" }
          : t.result,
      repositories: t.repositories,
      evidence_ref: t.evidence_ref,
      duration_ms: t.duration_ms,
      created_at: t.created_at,
    }));
    const active = await chatRepository.activeTurn(id);
    const delegations = await chatRepository.delegationsOf(id);
    return {
      conversation: publicConversation(c),
      messages,
      tool_calls: tools,
      active_turn: active
        ? {
            id: active.id,
            status: active.status,
            mode: active.mode,
            route: active.route,
            provider: active.provider,
            model: active.model,
            reasoning_effort: active.reasoning_effort,
            error: active.error,
            metrics: active.metrics,
            started_at: active.started_at,
            created_at: active.created_at,
          }
        : null,
      delegations,
    };
  },

  async update(actor: Actor, id: number, body: unknown) {
    await requireConversation(id, actor);
    const input = parse(ConversationPatch, body);
    if (input.provider !== undefined) await assertProvider(input.provider);
    if (input.repositories) await assertRepos(actor.id, input.repositories);
    const row = await chatRepository.updateConversation(id, actor.id, {
      title: input.title?.trim(),
      description: input.description?.trim(),
      mode: input.mode,
      provider: input.provider === undefined ? undefined : await assertProvider(input.provider),
      model: input.model,
      reasoning_effort: input.reasoning_effort,
      repositories: input.repositories,
      archived: input.archived,
    });
    if (!row) throw new HttpError(404, "not found");
    await emitChatEvent({
      conversationId: id,
      ownerId: actor.id,
      turnId: null,
      kind: "conversation.updated",
      data: { fields: Object.keys(input) },
    });
    return publicConversation(row);
  },

  async remove(actor: Actor, id: number) {
    const deleted = await chatRepository.deleteConversation(id, actor.id);
    if (!deleted) throw new HttpError(404, "not found");
    await audit(actor.id, "chat.delete", "chat_conversation", String(id));
    return { ok: true };
  },

  async postMessage(actor: Actor, conversationId: number, body: unknown) {
    const input = parse(MessagePost, body);
    await recoverStaleTurns(conversationId);
    const clientMessageId = input.client_message_id ?? randomUUID();

    // Idempotent replay: the same client_message_id returns the existing turn without starting another.
    const prior = await chatRepository.turnByClientId(conversationId, clientMessageId);
    if (prior) {
      if (prior.owner_id !== actor.id) throw new HttpError(404, "not found");
      const message = await chatRepository.messageOfTurn(prior.id, "user");
      return {
        turn: {
          id: prior.id,
          status: prior.status,
          client_message_id: prior.client_message_id,
        },
        message,
        replayed: true,
      };
    }

    const created = await withTx(async (c) => {
      const conversation = await chatRepository.lockConversation(conversationId, actor.id, c);
      if (!conversation) throw new HttpError(404, "not found");
      const active = await chatRepository.activeTurn(conversationId, c);
      if (active) throw new HttpError(409, "a turn is already in progress");

      const mode = (input.mode ?? conversation.mode) as ChatMode;
      const provider =
        input.provider !== undefined
          ? await assertProvider(input.provider)
          : conversation.provider;
      const model = input.model !== undefined ? input.model : conversation.model;
      const effort =
        input.reasoning_effort !== undefined
          ? input.reasoning_effort
          : conversation.reasoning_effort;
      const repositories =
        input.repositories !== undefined
          ? await assertRepos(actor.id, input.repositories)
          : conversation.repositories;

      // Persist any selector change with the message so the conversation continues with them.
      if (
        input.mode ||
        input.provider !== undefined ||
        input.model !== undefined ||
        input.reasoning_effort !== undefined ||
        input.repositories
      ) {
        await chatRepository.updateConversation(
          conversationId,
          actor.id,
          {
            mode,
            provider,
            model,
            reasoning_effort: effort,
            repositories,
          },
          c,
        );
      }

      const turn = await chatRepository.insertTurn(
        {
          conversationId,
          ownerId: actor.id,
          clientMessageId,
          mode,
          provider,
          model,
          reasoningEffort: effort,
          regenerates: null,
        },
        c,
      );
      const message = await chatRepository.insertMessage(
        {
          conversationId,
          turnId: turn.id,
          role: "user",
          content: input.content.trim(),
        },
        c,
      );
      await chatRepository.touch(conversationId, c);
      // Auto-title from the first user message when the conversation still has the default empty title.
      if (!conversation.title.trim()) {
        await chatRepository.updateConversation(
          conversationId,
          actor.id,
          { title: input.content.trim().replace(/\s+/g, " ").slice(0, 80) },
          c,
        );
      }
      return { turn, message };
    });

    scheduleTurn(created.turn.id);
    return {
      turn: {
        id: created.turn.id,
        status: created.turn.status,
        client_message_id: created.turn.client_message_id,
      },
      message: created.message,
      replayed: false,
    };
  },

  async cancelTurn(actor: Actor, turnId: number) {
    const turn = await chatRepository.getOwnedTurn(turnId, actor.id);
    if (!turn) throw new HttpError(404, "not found");
    if (!["queued", "running"].includes(turn.status))
      return { ok: true, status: turn.status, already: true };
    const done = await chatRepository.finishTurn(turnId, "canceled", { error: "canceled by user" });
    abortLocal(turnId);
    if (done)
      await emitChatEvent({
        conversationId: turn.conversation_id,
        ownerId: actor.id,
        turnId,
        kind: "turn.canceled",
      });
    await audit(actor.id, "chat.cancel", "chat_turn", String(turnId));
    return { ok: true, status: "canceled", already: false };
  },

  async regenerate(actor: Actor, turnId: number) {
    const previous = await chatRepository.getOwnedTurn(turnId, actor.id);
    if (!previous) throw new HttpError(404, "not found");
    if (["queued", "running"].includes(previous.status))
      throw new HttpError(409, "cannot regenerate an active turn");
    const userMessage = await chatRepository.messageOfTurn(turnId, "user");
    if (!userMessage) throw new HttpError(400, "turn has no user message");

    const created = await withTx(async (c) => {
      await chatRepository.lockConversation(previous.conversation_id, actor.id, c);
      const active = await chatRepository.activeTurn(previous.conversation_id, c);
      if (active) throw new HttpError(409, "a turn is already in progress");
      await chatRepository.supersedeTurn(turnId, c);
      const turn = await chatRepository.insertTurn(
        {
          conversationId: previous.conversation_id,
          ownerId: actor.id,
          clientMessageId: `regen:${turnId}:${randomUUID()}`,
          mode: previous.mode,
          provider: previous.provider,
          model: previous.model,
          reasoningEffort: previous.reasoning_effort,
          regenerates: turnId,
        },
        c,
      );
      const message = await chatRepository.insertMessage(
        {
          conversationId: previous.conversation_id,
          turnId: turn.id,
          role: "user",
          content: userMessage.content,
          mentions: userMessage.mentions,
        },
        c,
      );
      await chatRepository.touch(previous.conversation_id, c);
      return { turn, message };
    });
    scheduleTurn(created.turn.id);
    return {
      turn: {
        id: created.turn.id,
        status: created.turn.status,
        client_message_id: created.turn.client_message_id,
        regenerates: turnId,
      },
      message: created.message,
    };
  },

  async events(actor: Actor, conversationId: number, after: number) {
    await requireConversation(conversationId, actor);
    const { chatEventsSince } = await import("./events.ts");
    return chatEventsSince(conversationId, actor.id, after);
  },

  async delegationPreview(actor: Actor, conversationId: number, body: unknown) {
    const conversation = await requireConversation(conversationId, actor);
    const request = parse(DelegationRequest, body);
    return buildDelegationPreview(conversation, request);
  },

  async delegationExecute(actor: Actor, conversationId: number, body: unknown) {
    const conversation = await requireConversation(conversationId, actor);
    const parsed = parse(
      z
        .object({
          request: DelegationRequest,
          hash: z.string().min(16).max(128),
          confirmed: z.literal(true),
        })
        .strict(),
      body,
    );
    return executeDelegation(conversation, parsed.request, {
      hash: parsed.hash,
      confirmed: parsed.confirmed,
    });
  },
};
