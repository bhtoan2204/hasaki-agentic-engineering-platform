import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http/error.ts";
import { withTx } from "../db/pool.ts";
import { audit, type Actor } from "../authz/access.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import { parseAgentProvider, AGENT_PROVIDERS } from "../agent/provider.ts";
import { chatRepository } from "./repository.ts";
import { isModelBlocked } from "../agent/modelPolicy.ts";
import {
  CHAT_MODES,
  type ChatMode,
  type ConversationRow,
  type ProviderStrategy,
} from "./types.ts";
import { LIMITS } from "./policy.ts";
import { emitChatEvent } from "./events.ts";
import { abortLocal, recoverStaleTurns, scheduleTurn, withholdRevoked } from "./runtime.ts";
import { readableRepositories } from "./tools.ts";
import { buildDelegationPreview, DelegationRequest, executeDelegation } from "./delegation.ts";
import { chatFailure } from "./failures.ts";
import { fallbackTitle, scheduleTitleGeneration } from "./title.ts";
import { decideOperation, operationsOf } from "./operations.ts";
import { chatMemories } from "./memory.ts";

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw new HttpError(
      400,
      r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  return r.data;
}

const ConversationCreate = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    mode: z.enum(CHAT_MODES).optional(),
    /** `"auto"` or a real provider id. Independent from conversation mode. */
    provider: z.string().max(40).nullable().optional(),
    provider_strategy: z.enum(["auto", "manual"]).optional(),
    fallback_enabled: z.boolean().optional(),
    model: z
      .string()
      .max(120)
      .refine((m) => !isModelBlocked(m), "model is blocked by platform policy")
      .nullable()
      .optional(),
    model_strategy: z.enum(["auto", "provider_default", "manual"]).optional(),
    reasoning_effort: z.string().max(40).nullable().optional(),
    effort_strategy: z.enum(["auto", "provider_default", "manual"]).optional(),
    repositories: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();

const ConversationPatch = ConversationCreate.extend({
  archived: z.boolean().optional(),
}).strict();

const MessagePost = z
  .object({
    content: z.string().min(1).max(LIMITS.messageChars),
    client_message_id: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    mode: z.enum(CHAT_MODES).optional(),
    provider: z.string().max(40).nullable().optional(),
    provider_strategy: z.enum(["auto", "manual"]).optional(),
    fallback_enabled: z.boolean().optional(),
    model: z
      .string()
      .max(120)
      .refine((m) => !isModelBlocked(m), "model is blocked by platform policy")
      .nullable()
      .optional(),
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

/** Resolve provider field: "auto" → strategy auto + null preferred; else validate enabled provider. */
async function resolveProviderSelection(
  provider: string | null | undefined,
  strategyHint?: ProviderStrategy,
): Promise<{ provider: string | null; strategy: ProviderStrategy }> {
  if (provider === "auto" || strategyHint === "auto" || (provider == null && strategyHint !== "manual")) {
    if (provider && provider !== "auto") {
      const p = parseAgentProvider(provider);
      if (!p) throw new HttpError(400, `provider must be one of ${AGENT_PROVIDERS.join(", ")} or auto`);
      const cfg = await loadAgentConfiguration();
      if (!cfg.providers[p]?.enabled)
        throw new HttpError(400, `provider ${p} is disabled in Settings`);
      return { provider: p, strategy: "auto" };
    }
    return { provider: null, strategy: "auto" };
  }
  if (provider == null || provider === "") return { provider: null, strategy: strategyHint ?? "manual" };
  const p = parseAgentProvider(provider);
  if (!p) throw new HttpError(400, `provider must be one of ${AGENT_PROVIDERS.join(", ")} or auto`);
  const cfg = await loadAgentConfiguration();
  if (!cfg.providers[p]?.enabled) throw new HttpError(400, `provider ${p} is disabled in Settings`);
  return { provider: p, strategy: "manual" };
}

async function requireConversation(id: number, actor: Actor): Promise<ConversationRow> {
  const row = await chatRepository.getConversation(id, actor.id);
  if (!row) throw new HttpError(404, "not found");
  return row;
}

function publicTurn(t: Awaited<ReturnType<typeof chatRepository.listTurns>>[number]) {
  return {
    id: t.id,
    status: t.status,
    mode: t.mode,
    requested_mode: t.requested_mode,
    effective_mode: t.effective_mode,
    route: t.route,
    provider: t.effective_provider ?? t.provider,
    model: t.effective_model ?? t.model,
    reasoning_effort: t.effective_effort ?? t.reasoning_effort,
    provider_strategy: t.provider_strategy,
    routing: t.routing,
    phase: t.phase,
    failure: t.failure,
    attempts: t.attempts,
    progress: t.progress,
    error: t.error,
    metrics: t.metrics,
    started_at: t.started_at,
    finished_at: t.finished_at,
    created_at: t.created_at,
    regenerates: t.regenerates,
    client_message_id: t.client_message_id,
    draft: t.draft,
    trace: t.trace,
  };
}

function publicConversation(
  c: ConversationRow & { last_message?: string | null; active_turn?: number | null },
) {
  return {
    id: c.id,
    title: c.title,
    title_source: c.title_source ?? "none",
    description: c.description,
    mode: c.mode,
    provider: c.provider_strategy === "auto" ? "auto" : c.provider,
    preferred_provider: c.provider,
    provider_strategy: c.provider_strategy ?? "manual",
    fallback_enabled: c.fallback_enabled === true,
    model: c.model,
    model_strategy: c.model_strategy ?? "manual",
    reasoning_effort: c.reasoning_effort,
    effort_strategy: c.effort_strategy ?? "manual",
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
    const sel = await resolveProviderSelection(
      input.provider,
      input.provider_strategy ?? (input.provider == null || input.provider === "auto" ? "auto" : "manual"),
    );
    const repositories = await assertRepos(actor.id, input.repositories);
    const title = (input.title ?? "").trim();
    const row = await chatRepository.createConversation({
      ownerId: actor.id,
      title,
      titleSource: title ? "manual" : "none",
      description: (input.description ?? "").trim(),
      mode: input.mode ?? "AUTO",
      provider: sel.provider,
      model: input.model ?? null,
      reasoningEffort: input.reasoning_effort ?? null,
      providerStrategy: sel.strategy,
      fallbackEnabled: input.fallback_enabled ?? sel.strategy === "auto",
      modelStrategy: input.model_strategy ?? (input.model ? "manual" : "auto"),
      effortStrategy: input.effort_strategy ?? (input.reasoning_effort ? "manual" : "auto"),
      repositories,
      workItemId: null,
      runId: null,
    });
    await audit(actor.id, "chat.create", "chat_conversation", String(row.id), {
      mode: row.mode,
      provider_strategy: row.provider_strategy,
    });
    return publicConversation(row);
  },

  async get(actor: Actor, id: number) {
    await recoverStaleTurns(id);
    const c = await requireConversation(id, actor);
    const [readable, messageRows, toolRows, turnRows, active, delegations, operationRows] =
      await Promise.all([
        readableRepositories(actor.id),
        chatRepository.listMessages(id, { limit: 200 }),
        chatRepository.toolCallsOf(id),
        chatRepository.listTurns(id, 50),
        chatRepository.activeTurn(id),
        chatRepository.delegationsOf(id),
        operationsOf(id, actor.id),
      ]);
    const messages = withholdRevoked(messageRows, readable);
    const tools = toolRows.map((t) => ({
      id: t.id,
      turn_id: t.turn_id,
      seq: t.seq,
      tool: t.tool,
      arguments: t.arguments,
      status: t.status,
      result: t.repositories.some((r) => !readable.includes(r))
        ? { withheld: true, error: "repository access was revoked" }
        : t.result,
      repositories: t.repositories,
      evidence_ref: t.evidence_ref,
      duration_ms: t.duration_ms,
      created_at: t.created_at,
    }));
    const turns = turnRows.map(publicTurn);
    const operations = operationRows.map((o) => ({
      id: o.id,
      turn_id: o.turn_id,
      tool: o.tool,
      arguments: o.arguments,
      target: o.target,
      status: o.status,
      auto: o.auto,
      verification: o.verification,
      result: o.result,
      error: o.error,
      expires_at: o.expires_at,
      created_at: o.created_at,
    }));
    return {
      conversation: publicConversation(c),
      messages,
      tool_calls: tools,
      turns,
      active_turn: active ? publicTurn(active) : null,
      delegations,
      operations,
    };
  },

  decideOperation(actor: Actor, id: number, decision: "confirm" | "reject") {
    return decideOperation(actor, id, decision);
  },

  memories(actor: Actor) {
    return chatMemories(actor.id);
  },

  async update(actor: Actor, id: number, body: unknown) {
    await requireConversation(id, actor);
    const input = parse(ConversationPatch, body);
    const patch: Parameters<typeof chatRepository.updateConversation>[2] = {
      title: input.title?.trim(),
      description: input.description?.trim(),
      mode: input.mode,
      model: input.model,
      reasoning_effort: input.reasoning_effort,
      repositories: input.repositories
        ? await assertRepos(actor.id, input.repositories)
        : undefined,
      archived: input.archived,
      fallback_enabled: input.fallback_enabled,
      model_strategy: input.model_strategy,
      effort_strategy: input.effort_strategy,
    };
    // A client-supplied title is always a manual rename — never regenerate over it.
    if (input.title !== undefined) patch.title_source = "manual";
    if (input.provider !== undefined || input.provider_strategy !== undefined) {
      const sel = await resolveProviderSelection(input.provider, input.provider_strategy);
      patch.provider = sel.provider;
      patch.provider_strategy = sel.strategy;
      if (input.fallback_enabled === undefined && sel.strategy === "auto")
        patch.fallback_enabled = true;
    }
    const row = await chatRepository.updateConversation(id, actor.id, patch);
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

    const prior = await chatRepository.turnByClientId(conversationId, clientMessageId);
    if (prior) {
      if (prior.owner_id !== actor.id) throw new HttpError(404, "not found");
      const message = await chatRepository.messageOfTurn(prior.id, "user");
      return {
        turn: { id: prior.id, status: prior.status, client_message_id: prior.client_message_id },
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
      let provider = conversation.provider;
      let providerStrategy = (conversation.provider_strategy ?? "manual") as ProviderStrategy;
      if (input.provider !== undefined || input.provider_strategy !== undefined) {
        const sel = await resolveProviderSelection(input.provider, input.provider_strategy);
        provider = sel.provider;
        providerStrategy = sel.strategy;
      }
      const model = input.model !== undefined ? input.model : conversation.model;
      const effort =
        input.reasoning_effort !== undefined
          ? input.reasoning_effort
          : conversation.reasoning_effort;
      const repositories =
        input.repositories !== undefined
          ? await assertRepos(actor.id, input.repositories)
          : conversation.repositories;
      const fallback =
        input.fallback_enabled !== undefined
          ? input.fallback_enabled
          : conversation.fallback_enabled;

      if (
        input.mode ||
        input.provider !== undefined ||
        input.provider_strategy !== undefined ||
        input.model !== undefined ||
        input.reasoning_effort !== undefined ||
        input.repositories ||
        input.fallback_enabled !== undefined
      ) {
        await chatRepository.updateConversation(
          conversationId,
          actor.id,
          {
            mode,
            provider,
            provider_strategy: providerStrategy,
            model,
            reasoning_effort: effort,
            repositories,
            fallback_enabled: fallback,
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
          providerStrategy,
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
      let shouldGenerateTitle = false;
      if (
        conversation.title_source === "none" ||
        (!conversation.title.trim() && conversation.title_source !== "manual")
      ) {
        const fb = fallbackTitle(input.content);
        await chatRepository.updateConversation(
          conversationId,
          actor.id,
          { title: fb, title_source: "fallback" },
          c,
        );
        shouldGenerateTitle = true;
      }
      return { turn, message, shouldGenerateTitle };
    });

    scheduleTurn(created.turn.id);
    // The fallback title is already stored; the generated one waits until this first turn has answered.
    if (created.shouldGenerateTitle)
      scheduleTitleGeneration(conversationId, actor.id, { afterTurn: created.turn.id });
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
    const failure = chatFailure("CANCELED", "canceled by user");
    const done = await chatRepository.finishTurn(turnId, "canceled", {
      error: "canceled by user",
      failure: { ...failure },
      phase: "canceled",
    });
    abortLocal(turnId);
    if (done)
      await emitChatEvent({
        conversationId: turn.conversation_id,
        ownerId: actor.id,
        turnId,
        kind: "turn.canceled",
        data: { failure: done.failure },
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
          providerStrategy: previous.provider_strategy,
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

  /** Explicit title refresh (context menu). Never overwrites a manual rename. */
  async regenerateTitle(actor: Actor, conversationId: number) {
    const conversation = await requireConversation(conversationId, actor);
    if (conversation.title_source === "manual")
      throw new HttpError(409, "conversation title was renamed manually");
    scheduleTitleGeneration(conversationId, actor.id, { force: true });
    return { ok: true, scheduled: true };
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
