import { json, one, pool, q, withTx, type Db } from "../db/pool.ts";
import type {
  ChatEventKind,
  ChatMode,
  ConversationRow,
  EventRow,
  MessageRow,
  TitleSource,
  ToolCallRow,
  TurnRow,
} from "./types.ts";

/** Persistence for chat. Every read that a user can reach is owner-scoped in SQL. */
export const chatRepository = {
  createConversation(
    input: {
      ownerId: number;
      title: string;
      titleSource?: TitleSource;
      description: string;
      mode: ChatMode;
      provider: string | null;
      model: string | null;
      reasoningEffort: string | null;
      providerStrategy: "auto" | "manual";
      fallbackEnabled: boolean;
      modelStrategy: "auto" | "provider_default" | "manual";
      effortStrategy: "auto" | "provider_default" | "manual";
      repositories: string[];
      workItemId: number | null;
      runId: number | null;
    },
    db: Db = pool,
  ) {
    const titleSource: TitleSource =
      input.titleSource ?? (input.title.trim() ? "manual" : "none");
    return one<ConversationRow>(
      db,
      `INSERT INTO chat_conversations (
         owner_id, title, title_source, description, mode, provider, model, reasoning_effort,
         provider_strategy, fallback_enabled, model_strategy, effort_strategy,
         repositories, work_item_id, run_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        input.ownerId,
        input.title,
        titleSource,
        input.description,
        input.mode,
        input.provider,
        input.model,
        input.reasoningEffort,
        input.providerStrategy,
        input.fallbackEnabled,
        input.modelStrategy,
        input.effortStrategy,
        input.repositories,
        input.workItemId,
        input.runId,
      ],
    ) as Promise<ConversationRow>;
  },

  getConversation(id: number, ownerId: number, db: Db = pool) {
    return one<ConversationRow>(
      db,
      "SELECT * FROM chat_conversations WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
  },

  lockConversation(id: number, ownerId: number, db: Db) {
    return one<ConversationRow>(
      db,
      "SELECT * FROM chat_conversations WHERE id = $1 AND owner_id = $2 FOR UPDATE",
      [id, ownerId],
    );
  },

  listConversations(
    ownerId: number,
    filter: { search?: string; archived?: boolean; limit?: number },
    db: Db = pool,
  ) {
    const search = filter.search?.trim()
      ? `%${filter.search.trim().replace(/[\\%_]/g, "\\$&")}%`
      : null;
    return q<ConversationRow & { last_message: string | null; active_turn: number | null }>(
      db,
      `SELECT c.*,
              (SELECT left(m.content, 160) FROM chat_messages m
                WHERE m.conversation_id = c.id AND NOT m.superseded ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT t.id FROM chat_turns t
                WHERE t.conversation_id = c.id AND t.status IN ('queued', 'running') LIMIT 1) AS active_turn
         FROM chat_conversations c
        WHERE c.owner_id = $1 AND c.archived = $2
          AND ($3::text IS NULL OR c.title ILIKE $3 OR c.description ILIKE $3 OR c.summary ILIKE $3
               OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.content ILIKE $3))
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $4`,
      [ownerId, filter.archived === true, search, Math.min(Math.max(filter.limit ?? 100, 1), 200)],
    );
  },

  updateConversation(
    id: number,
    ownerId: number,
    patch: Partial<
      Pick<
        ConversationRow,
        | "title"
        | "title_source"
        | "description"
        | "mode"
        | "provider"
        | "model"
        | "reasoning_effort"
        | "provider_strategy"
        | "fallback_enabled"
        | "model_strategy"
        | "effort_strategy"
        | "repositories"
        | "archived"
        | "work_item_id"
        | "run_id"
      >
    >,
    db: Db = pool,
  ) {
    const keys = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    ) as Array<keyof typeof patch>;
    if (!keys.length) return chatRepository.getConversation(id, ownerId, db);
    const set = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
    return one<ConversationRow>(
      db,
      `UPDATE chat_conversations SET ${set}, updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, ownerId, ...keys.map((k) => patch[k])],
    );
  },

  /** Conditional title write — never clobber a manual rename (or a finished generated title unless allowed). */
  updateTitleIfSource(
    id: number,
    ownerId: number,
    title: string,
    nextSource: TitleSource,
    allowed: TitleSource[],
    db: Db = pool,
  ) {
    return one<ConversationRow>(
      db,
      `UPDATE chat_conversations
          SET title = $3, title_source = $4, updated_at = now()
        WHERE id = $1 AND owner_id = $2 AND title_source = ANY($5::text[])
        RETURNING *`,
      [id, ownerId, title, nextSource, allowed],
    );
  },

  firstUserMessage(conversationId: number, db: Db = pool) {
    return one<MessageRow>(
      db,
      `SELECT * FROM chat_messages
        WHERE conversation_id = $1 AND role = 'user' AND NOT superseded
        ORDER BY id ASC LIMIT 1`,
      [conversationId],
    );
  },

  saveSummary(id: number, summary: string, through: number, db: Db = pool) {
    return q(
      db,
      "UPDATE chat_conversations SET summary = $2, summary_through = $3 WHERE id = $1 AND summary_through <= $3",
      [id, summary, through],
    );
  },

  addUsage(id: number, usage: Record<string, unknown>, db: Db = pool) {
    return q(db, "UPDATE chat_conversations SET usage = $2, updated_at = now() WHERE id = $1", [
      id,
      json(usage),
    ]);
  },

  touch(id: number, db: Db = pool) {
    return q(db, "UPDATE chat_conversations SET updated_at = now() WHERE id = $1", [id]);
  },

  deleteConversation(id: number, ownerId: number, db: Db = pool) {
    return one<{ id: number }>(
      db,
      "DELETE FROM chat_conversations WHERE id = $1 AND owner_id = $2 RETURNING id",
      [id, ownerId],
    );
  },

  // ------------------------------------------------------------------ turns

  turnByClientId(conversationId: number, clientMessageId: string, db: Db = pool) {
    return one<TurnRow>(
      db,
      "SELECT * FROM chat_turns WHERE conversation_id = $1 AND client_message_id = $2",
      [conversationId, clientMessageId],
    );
  },

  activeTurn(conversationId: number, db: Db = pool) {
    return one<TurnRow>(
      db,
      "SELECT * FROM chat_turns WHERE conversation_id = $1 AND status IN ('queued', 'running')",
      [conversationId],
    );
  },

  insertTurn(
    input: {
      conversationId: number;
      ownerId: number;
      clientMessageId: string;
      mode: ChatMode;
      provider: string | null;
      model: string | null;
      reasoningEffort: string | null;
      providerStrategy: string | null;
      regenerates: number | null;
    },
    db: Db,
  ) {
    return one<TurnRow>(
      db,
      `INSERT INTO chat_turns (
         conversation_id, owner_id, client_message_id, mode, requested_mode, provider, model, reasoning_effort,
         provider_strategy, requested_provider, requested_model, requested_effort, regenerates, phase
       ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $5, $6, $7, $9, 'queued') RETURNING *`,
      [
        input.conversationId,
        input.ownerId,
        input.clientMessageId,
        input.mode,
        input.provider,
        input.model,
        input.reasoningEffort,
        input.providerStrategy,
        input.regenerates,
      ],
    ) as Promise<TurnRow>;
  },

  listTurns(conversationId: number, limit = 50, db: Db = pool) {
    return q<TurnRow>(
      db,
      `SELECT id, conversation_id, owner_id, client_message_id, status, mode, requested_mode, effective_mode, route,
              provider, model, reasoning_effort, provider_strategy, requested_provider, effective_provider,
              requested_model, effective_model, requested_effort, effective_effort, routing, phase, failure,
              attempts, progress, worker_instance, regenerates, error, metrics, started_at, finished_at, created_at,
              draft, trace
         FROM chat_turns WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`,
      [conversationId, Math.min(Math.max(limit, 1), 100)],
    );
  },

  getTurn(id: number, db: Db = pool) {
    return one<TurnRow>(db, "SELECT * FROM chat_turns WHERE id = $1", [id]);
  },

  getOwnedTurn(id: number, ownerId: number, db: Db = pool) {
    return one<TurnRow>(db, "SELECT * FROM chat_turns WHERE id = $1 AND owner_id = $2", [
      id,
      ownerId,
    ]);
  },

  /** queued → running, claimed by this instance. Returns null when the turn was canceled first. */
  claimTurn(id: number, instance: string, db: Db = pool) {
    return one<TurnRow>(
      db,
      `UPDATE chat_turns SET status = 'running', worker_instance = $2, started_at = now()
        WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id, instance],
    );
  },

  setRoute(
    id: number,
    route: string,
    provider: string,
    model: string | null,
    effort: string | null,
    db: Db = pool,
  ) {
    return q(
      db,
      `UPDATE chat_turns SET route = $2, provider = $3, model = $4, reasoning_effort = $5,
        effective_provider = $3, effective_model = $4, effective_effort = $5 WHERE id = $1`,
      [id, route, provider, model, effort],
    );
  },

  setTurnPlan(
    id: number,
    fields: {
      effectiveMode: string;
      route: string;
      routing: Record<string, unknown>;
      provider: string;
      model: string | null;
      effort: string | null;
      providerStrategy: string;
      phase: string;
    },
    db: Db = pool,
  ) {
    return q(
      db,
      `UPDATE chat_turns SET
         effective_mode = $2, route = $3, routing = $4, provider = $5, model = $6, reasoning_effort = $7,
         effective_provider = $5, effective_model = $6, effective_effort = $7, provider_strategy = $8, phase = $9
       WHERE id = $1`,
      [
        id,
        fields.effectiveMode,
        fields.route,
        json(fields.routing),
        fields.provider,
        fields.model,
        fields.effort,
        fields.providerStrategy,
        fields.phase,
      ],
    );
  },

  setPhase(id: number, phase: string, progress: Record<string, unknown> = {}, db: Db = pool) {
    return q(db, "UPDATE chat_turns SET phase = $2, progress = $3 WHERE id = $1", [
      id,
      phase,
      json(progress),
    ]);
  },

  /** setPhase and its phase.updated event (NOTIFY by the insert trigger) in one statement. */
  setPhaseWithEvent(
    id: number,
    phase: string,
    progress: Record<string, unknown>,
    ids: { conversationId: number; ownerId: number },
    db: Db = pool,
  ) {
    return one<EventRow>(
      db,
      `WITH turn AS (UPDATE chat_turns SET phase = $2, progress = $3 WHERE id = $1)
       INSERT INTO chat_events (conversation_id, owner_id, turn_id, kind, data)
       VALUES ($4, $5, $1, 'phase.updated', $6) RETURNING *`,
      [id, phase, json(progress), ids.conversationId, ids.ownerId, json({ phase, ...progress })],
    );
  },

  setStream(id: number, draft: string, trace: unknown[], db: Db = pool) {
    return q(db, "UPDATE chat_turns SET draft = $2, trace = $3 WHERE id = $1", [
      id,
      draft,
      json(trace),
    ]);
  },

  /** Live deltas are superseded by the stored answer and trace once a turn ends. */
  dropStreamEvents(turnId: number, db: Db = pool) {
    return q(
      db,
      "DELETE FROM chat_events WHERE turn_id = $1 AND kind IN ('response.delta', 'reasoning.delta', 'provider.activity')",
      [turnId],
    );
  },

  /** The text streamed before a turn stopped or failed; never replaces an answer the turn already has. */
  insertPartialAnswer(turnId: number, conversationId: number, content: string, db: Db = pool) {
    return one<{ id: number }>(
      db,
      `INSERT INTO chat_messages (conversation_id, turn_id, role, content)
       SELECT $2, $1, 'assistant', $3
        WHERE NOT EXISTS (SELECT 1 FROM chat_messages WHERE turn_id = $1 AND role = 'assistant')
       ON CONFLICT DO NOTHING RETURNING id`,
      [turnId, conversationId, content],
    );
  },

  setAttempts(id: number, attempts: unknown[], db: Db = pool) {
    return q(db, "UPDATE chat_turns SET attempts = $2 WHERE id = $1", [id, json(attempts)]);
  },

  /** Terminal transition only from an active state: a canceled turn never becomes completed afterwards. */
  finishTurn(
    id: number,
    status: "completed" | "failed" | "canceled",
    fields: {
      error?: string | null;
      metrics?: Record<string, unknown>;
      failure?: Record<string, unknown> | null;
      phase?: string;
      attempts?: unknown[];
    },
    db: Db = pool,
  ) {
    return one<TurnRow>(
      db,
      `UPDATE chat_turns SET status = $2, error = $3, metrics = COALESCE($4::jsonb, metrics),
        failure = COALESCE($5::jsonb, failure), phase = COALESCE($6, phase),
        attempts = COALESCE($7::jsonb, attempts), finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`,
      [
        id,
        status,
        fields.error ?? null,
        json(fields.metrics),
        json(fields.failure ?? null),
        fields.phase ?? (status === "completed" ? "completed" : status === "canceled" ? "canceled" : "failed"),
        fields.attempts != null ? json(fields.attempts) : null,
      ],
    );
  },

  turnStatus(id: number, db: Db = pool) {
    return one<{ status: TurnRow["status"] }>(db, "SELECT status FROM chat_turns WHERE id = $1", [
      id,
    ]);
  },

  /** Active turns whose instance stopped or stopped heart-beating: their process is gone. */
  staleTurns(conversationId: number, db: Db = pool) {
    return q<TurnRow>(
      db,
      `SELECT t.* FROM chat_turns t LEFT JOIN platform_instances i ON i.instance_id = t.worker_instance
        WHERE t.conversation_id = $1 AND t.status IN ('queued', 'running')
          AND ((t.status = 'running' AND (i.instance_id IS NULL OR i.stopped_at IS NOT NULL OR i.last_seen_at < now() - interval '2 minutes'))
               OR (t.status = 'queued' AND t.created_at < now() - interval '2 minutes'))`,
      [conversationId],
    );
  },

  runningTurnsOf(instance: string, db: Db = pool) {
    return q<TurnRow>(
      db,
      "SELECT * FROM chat_turns WHERE worker_instance = $1 AND status = 'running'",
      [instance],
    );
  },

  // ------------------------------------------------------------------ messages

  insertMessage(
    input: {
      conversationId: number;
      turnId: number | null;
      role: MessageRow["role"];
      content: string;
      mentions?: unknown[];
      citations?: unknown[];
    },
    db: Db = pool,
  ) {
    return one<MessageRow>(
      db,
      `INSERT INTO chat_messages (conversation_id, turn_id, role, content, mentions, citations)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.conversationId,
        input.turnId,
        input.role,
        input.content,
        json(input.mentions ?? []),
        json(input.citations ?? []),
      ],
    ) as Promise<MessageRow>;
  },

  listMessages(
    conversationId: number,
    opts: { before?: number; limit?: number } = {},
    db: Db = pool,
  ) {
    return q<MessageRow>(
      db,
      `SELECT * FROM (
         SELECT * FROM chat_messages WHERE conversation_id = $1 AND ($2::bigint IS NULL OR id < $2)
          ORDER BY id DESC LIMIT $3) m ORDER BY id`,
      [conversationId, opts.before ?? null, Math.min(Math.max(opts.limit ?? 200, 1), 500)],
    );
  },

  /** The history a new turn builds on: live messages only, oldest first. */
  historyFor(conversationId: number, afterId: number, db: Db = pool) {
    return q<MessageRow>(
      db,
      `SELECT * FROM chat_messages WHERE conversation_id = $1 AND id > $2 AND NOT superseded ORDER BY id`,
      [conversationId, afterId],
    );
  },

  getMessage(id: number, conversationId: number, db: Db = pool) {
    return one<MessageRow>(
      db,
      "SELECT * FROM chat_messages WHERE id = $1 AND conversation_id = $2",
      [id, conversationId],
    );
  },

  messageOfTurn(turnId: number, role: MessageRow["role"], db: Db = pool) {
    return one<MessageRow>(db, "SELECT * FROM chat_messages WHERE turn_id = $1 AND role = $2", [
      turnId,
      role,
    ]);
  },

  setMentions(messageId: number, mentions: unknown[], db: Db = pool) {
    return q(db, "UPDATE chat_messages SET mentions = $2 WHERE id = $1", [
      messageId,
      json(mentions),
    ]);
  },

  supersedeTurn(turnId: number, db: Db) {
    return q(db, "UPDATE chat_messages SET superseded = true WHERE turn_id = $1", [turnId]);
  },

  setContinuation(conversationId: number, continuation: unknown, db: Db = pool) {
    return q(db, "UPDATE chat_conversations SET continuation = $2 WHERE id = $1", [
      conversationId,
      continuation == null ? null : json(continuation),
    ]);
  },

  /**
   * The latest turn with a live user message strictly before `beforeTurnId` — the routing context of a follow-up.
   * (Without the bound the current turn, which already has its user message, was returned.)
   */
  latestTurnWithUser(conversationId: number, beforeTurnId: number, db: Db = pool) {
    return one<TurnRow>(
      db,
      `SELECT t.* FROM chat_turns t JOIN chat_messages m ON m.turn_id = t.id AND m.role = 'user' AND NOT m.superseded
        WHERE t.conversation_id = $1 AND t.id < $2 ORDER BY t.id DESC LIMIT 1`,
      [conversationId, beforeTurnId],
    );
  },

  // ------------------------------------------------------------------ tool calls

  insertToolCall(
    input: {
      turnId: number;
      conversationId: number;
      ownerId: number;
      seq: number;
      tool: string;
      arguments: Record<string, unknown>;
    },
    db: Db = pool,
  ) {
    return one<ToolCallRow>(
      db,
      `INSERT INTO chat_tool_calls (turn_id, conversation_id, owner_id, seq, tool, arguments, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING *`,
      [
        input.turnId,
        input.conversationId,
        input.ownerId,
        input.seq,
        input.tool,
        json(input.arguments),
      ],
    ) as Promise<ToolCallRow>;
  },

  finishToolCall(
    id: number,
    fields: {
      status: ToolCallRow["status"];
      result: unknown;
      repositories: string[];
      evidenceRef: string | null;
      durationMs: number;
    },
    db: Db = pool,
  ) {
    return one<ToolCallRow>(
      db,
      `UPDATE chat_tool_calls SET status = $2, result = $3, repositories = $4, evidence_ref = $5, duration_ms = $6
        WHERE id = $1 RETURNING *`,
      [
        id,
        fields.status,
        json(fields.result),
        fields.repositories,
        fields.evidenceRef,
        fields.durationMs,
      ],
    ) as Promise<ToolCallRow>;
  },

  toolCallsOf(conversationId: number, db: Db = pool) {
    return q<ToolCallRow>(
      db,
      "SELECT * FROM chat_tool_calls WHERE conversation_id = $1 ORDER BY id",
      [conversationId],
    );
  },

  // ------------------------------------------------------------------ events

  insertEvent(
    input: {
      conversationId: number;
      ownerId: number;
      turnId: number | null;
      kind: ChatEventKind;
      data: Record<string, unknown>;
    },
    db: Db = pool,
  ) {
    return one<EventRow>(
      db,
      `INSERT INTO chat_events (conversation_id, owner_id, turn_id, kind, data)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.conversationId, input.ownerId, input.turnId, input.kind, json(input.data)],
    ) as Promise<EventRow>;
  },

  eventsAfter(
    conversationId: number,
    ownerId: number,
    afterId: number,
    limit: number,
    db: Db = pool,
  ) {
    return q<EventRow>(
      db,
      `SELECT * FROM chat_events WHERE conversation_id = $1 AND owner_id = $2 AND id > $3 ORDER BY id LIMIT $4`,
      [conversationId, ownerId, afterId, limit],
    );
  },

  getEvent(id: number, db: Db = pool) {
    return one<EventRow>(db, "SELECT * FROM chat_events WHERE id = $1", [id]);
  },

  latestEventId(conversationId: number, db: Db = pool) {
    return one<{ id: number }>(
      db,
      "SELECT COALESCE(max(id), 0)::bigint AS id FROM chat_events WHERE conversation_id = $1",
      [conversationId],
    );
  },

  // ------------------------------------------------------------------ delegation

  delegationByHash(conversationId: number, hash: string, db: Db = pool) {
    return one(
      db,
      "SELECT * FROM chat_delegations WHERE conversation_id = $1 AND preview_hash = $2",
      [conversationId, hash],
    );
  },

  insertDelegation(
    input: {
      conversationId: number;
      ownerId: number;
      hash: string;
      workItemId: number;
      runId: number | null;
      package: unknown;
    },
    db: Db,
  ) {
    return one(
      db,
      `INSERT INTO chat_delegations (conversation_id, owner_id, preview_hash, work_item_id, run_id, package)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.conversationId,
        input.ownerId,
        input.hash,
        input.workItemId,
        input.runId,
        json(input.package),
      ],
    );
  },

  setWorkItemChatPayload(
    workItemId: number,
    ownerId: number,
    payload: Record<string, unknown>,
    db: Db = pool,
  ) {
    return q(
      db,
      "UPDATE work_items SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb WHERE id = $1 AND owner_id = $2",
      [workItemId, ownerId, json(payload)],
    );
  },

  /** Link the conversation to what it created and leave a system message, atomically. */
  recordDelegation(input: {
    conversationId: number;
    ownerId: number;
    hash: string;
    workItemId: number;
    runId: number | null;
    package: unknown;
  }) {
    return withTx(async (c) => {
      const row = await chatRepository.insertDelegation(input, c);
      await q(
        c,
        "UPDATE chat_conversations SET work_item_id = $3, run_id = COALESCE($4, run_id), updated_at = now() WHERE id = $1 AND owner_id = $2",
        [input.conversationId, input.ownerId, input.workItemId, input.runId],
      );
      await chatRepository.insertMessage(
        {
          conversationId: input.conversationId,
          turnId: null,
          role: "system",
          content: JSON.stringify({
            type: "delegation",
            work_item_id: input.workItemId,
            run_id: input.runId,
          }),
        },
        c,
      );
      return row;
    });
  },

  delegationsOf(conversationId: number, db: Db = pool) {
    return q(
      db,
      `SELECT d.id, d.work_item_id, d.run_id, d.created_at, w.code AS work_item_code, r.status AS run_status,
              r.definition_key
         FROM chat_delegations d LEFT JOIN work_items w ON w.id = d.work_item_id LEFT JOIN workflow_runs r ON r.id = d.run_id
        WHERE d.conversation_id = $1 ORDER BY d.id`,
      [conversationId],
    );
  },

  // ------------------------------------------------------------------ authorization reads

  userActive(userId: number, db: Db = pool) {
    return one<{ active: boolean }>(db, "SELECT active FROM users WHERE id = $1", [userId]);
  },

  ownedWorkItem(ref: string, ownerId: number, db: Db = pool) {
    const id = /^\d+$/.test(ref) ? Number(ref) : null;
    return one<{
      id: number;
      code: string;
      title: string;
      description: string;
      status: string;
      project: string;
    }>(
      db,
      `SELECT id, code, title, left(description, 4000) AS description, status, project FROM work_items
        WHERE owner_id = $1 AND (($2::bigint IS NOT NULL AND id = $2) OR lower(code) = lower($3)) LIMIT 1`,
      [ownerId, id, ref],
    );
  },

  ownedRun(runId: number, ownerId: number, db: Db = pool) {
    return one<{
      id: number;
      definition_key: string;
      title: string;
      status: string;
      selected_repositories: string[];
      work_item_id: number | null;
      created_at: string;
    }>(
      db,
      `SELECT id, definition_key, title, status, selected_repositories, work_item_id, created_at
         FROM workflow_runs WHERE id = $1 AND owner_id = $2`,
      [runId, ownerId],
    );
  },

  runSteps(runId: number, db: Db = pool) {
    return q<{ key: string; type: string; status: string; error: string | null }>(
      db,
      "SELECT key, type, status, left(coalesce(error, ''), 400) AS error FROM workflow_steps WHERE run_id = $1 ORDER BY id",
      [runId],
    );
  },

  searchWorkItems(ownerId: number, text: string, limit: number, db: Db = pool) {
    return q<{ id: number; code: string; title: string; status: string; updated_at: string }>(
      db,
      `SELECT id, code, title, status, updated_at FROM work_items
        WHERE owner_id = $1 AND ($2 = '' OR title ILIKE $3 OR code ILIKE $3 OR description ILIKE $3)
        ORDER BY updated_at DESC LIMIT $4`,
      [ownerId, text, `%${text.replace(/[\\%_]/g, "\\$&")}%`, limit],
    );
  },

  /** The owner's work items, filtered by text, status and an updated-at day range (inclusive, in `tz`). */
  listWorkItems(
    ownerId: number,
    f: { text?: string; status?: string; from?: string; to?: string; tz: string; limit: number },
    db: Db = pool,
  ) {
    const text = f.text ?? "";
    return q<{
      id: number;
      code: string;
      title: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>(
      db,
      `SELECT id, code, title, status, created_at, updated_at FROM work_items
        WHERE owner_id = $1
          AND ($2 = '' OR title ILIKE $3 OR code ILIKE $3 OR description ILIKE $3)
          AND ($4::text IS NULL OR status = $4)
          AND ($5::date IS NULL OR updated_at >= $5::date::timestamp AT TIME ZONE $7)
          AND ($6::date IS NULL OR updated_at < ($6::date + 1)::timestamp AT TIME ZONE $7)
        ORDER BY updated_at DESC LIMIT $8`,
      [
        ownerId,
        text,
        `%${text.replace(/[\\%_]/g, "\\$&")}%`,
        f.status ?? null,
        f.from ?? null,
        f.to ?? null,
        f.tz,
        f.limit,
      ],
    );
  },

  /** The owner's workflow runs, filtered by status, work item and a created-at day range (inclusive, in `tz`). */
  listRuns(
    ownerId: number,
    f: { status?: string; workItemId?: number; from?: string; to?: string; tz: string; limit: number },
    db: Db = pool,
  ) {
    return q<{
      id: number;
      definition_key: string;
      title: string;
      status: string;
      work_item_id: number | null;
      created_at: string;
      finished_at: string | null;
    }>(
      db,
      `SELECT id, definition_key, title, status, work_item_id, created_at, finished_at FROM workflow_runs
        WHERE owner_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::bigint IS NULL OR work_item_id = $3)
          AND ($4::date IS NULL OR created_at >= $4::date::timestamp AT TIME ZONE $6)
          AND ($5::date IS NULL OR created_at < ($5::date + 1)::timestamp AT TIME ZONE $6)
        ORDER BY id DESC LIMIT $7`,
      [ownerId, f.status ?? null, f.workItemId ?? null, f.from ?? null, f.to ?? null, f.tz, f.limit],
    );
  },

  /** What the owner touched in a day range: work items updated and runs created or finished, oldest first. */
  activityTimeline(
    ownerId: number,
    f: { from: string; to: string; tz: string; limit: number },
    db: Db = pool,
  ) {
    return q<{ at: string; kind: string; ref: string; title: string; status: string }>(
      db,
      `WITH b AS (SELECT $2::date::timestamp AT TIME ZONE $4 AS lo, ($3::date + 1)::timestamp AT TIME ZONE $4 AS hi)
       SELECT * FROM (
         SELECT w.updated_at AS at, 'work_item_updated' AS kind, w.code AS ref, w.title, w.status
           FROM work_items w, b WHERE w.owner_id = $1 AND w.updated_at >= b.lo AND w.updated_at < b.hi
         UNION ALL
         SELECT r.created_at, 'run_created', '#' || r.id, r.title, r.status
           FROM workflow_runs r, b WHERE r.owner_id = $1 AND r.created_at >= b.lo AND r.created_at < b.hi
         UNION ALL
         SELECT r.finished_at, 'run_finished', '#' || r.id, r.title, r.status
           FROM workflow_runs r, b WHERE r.owner_id = $1 AND r.finished_at >= b.lo AND r.finished_at < b.hi
       ) t ORDER BY at LIMIT $5`,
      [ownerId, f.from, f.to, f.tz, f.limit],
    );
  },

  searchIncidents(text: string, limit: number, db: Db = pool) {
    return q<{
      fingerprint: string;
      namespace: string;
      service: string;
      level: string;
      signature: string;
      severity: string;
      today_count: number;
      last_at: string;
      status: string;
    }>(
      db,
      `SELECT fingerprint, namespace, service, level, left(signature, 300) AS signature, severity, today_count, last_at, status
         FROM prod_error_groups
        WHERE ($1 = '' OR signature ILIKE $2 OR service ILIKE $2 OR namespace ILIKE $2 OR fingerprint = $1)
        ORDER BY last_at DESC NULLS LAST LIMIT $3`,
      [text, `%${text.replace(/[\\%_]/g, "\\$&")}%`, limit],
    );
  },
};
