import { config } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { background } from "../workflow/background.ts";
import { completeForRun, completionAgent, type CompletionRunner } from "../agent/complete.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import type { AgentProvider } from "../agent/provider.ts";
import { invalidateSharedAgentHealth, rememberProviderQuota } from "../agent/health.ts";
import { boundedContextJson } from "../agent/contextTools.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";
import { LIMITS } from "./policy.ts";
import { routeTurnIntelligent } from "./routing.ts";
import {
  admitProvider,
  ADMISSION,
  asChatFailure,
  mayFallback,
  type ProviderAttempt,
  type ProviderStrategy,
} from "./admission.ts";
import { ChatTurnError, chatFailure, type ChatFailure, type ExecutionPhase } from "./failures.ts";
import {
  buildPrompt,
  compactToolResults,
  deltaPrompt,
  compactIfNeeded,
  publicMention,
  resolveMentions,
  type ResolvedMention,
} from "./context.ts";
import { executeChatTool, readableRepositories, toolCatalog, type ChatBinding } from "./tools.ts";
import { stallGuard, TurnStream } from "./streaming.ts";
import { turnScheduled, turnSettled } from "./turnActivity.ts";
import { estimateTokens } from "../context/plan.ts";
import { learnFromTurn, recallMemories } from "./memory.ts";
import { knowledgeForTurn, refOf } from "./knowledge.ts";
import {
  continuationBrief,
  continuesGoal,
  nextContinuation,
  type Continuation,
} from "./continuation.ts";
import { operationsOf } from "./operations.ts";
import { integrationTools } from "../agent/toolRegistry.ts";
import { execution } from "../auth/execution.ts";
import { loadPersonalIntegrations } from "../integrations/loadPersonal.ts";
import type {
  ChatUsage,
  Citation,
  ConversationRow,
  ManualChatMode,
  MessageRow,
  TurnRow,
} from "./types.ts";

type Providers = Record<AgentProvider, CompletionRunner>;
let providerSeam: Providers | undefined;
export function setChatProviders(p: Providers | undefined) {
  providerSeam = p;
}

const active = new Map<number, AbortController>();
export const activeTurnCount = () => active.size;

export class TurnCanceled extends Error {}

const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

export function scheduleTurn(turnId: number) {
  turnScheduled(turnId);
  background(`chat turn ${turnId}`, () => runTurn(turnId).finally(() => turnSettled(turnId)));
}

export function parseToolCalls(text: string): Array<{ tool: string; arguments: unknown }> | null {
  const fenced = /```chat-tool\s*\n?([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : /^\s*\{\s*"calls"\s*:/.test(text) ? text : null;
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    const calls: unknown[] = Array.isArray(parsed?.calls)
      ? parsed.calls
      : Array.isArray(parsed)
        ? parsed
        : [parsed];
    const out: Array<{ tool: string; arguments: unknown }> = [];
    for (const c of calls) {
      if (!c || typeof c !== "object") continue;
      const row = c as { tool?: unknown; arguments?: unknown };
      if (typeof row.tool !== "string") continue;
      out.push({ tool: row.tool, arguments: row.arguments ?? {} });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export function stripToolBlocks(text: string) {
  return text.replace(/```chat-tool[\s\S]*?```/g, "").trim();
}

function emptyUsage(): ChatUsage {
  return {
    completions: 0,
    tool_calls: 0,
    provider_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
  };
}

export function addUsage(
  u: ChatUsage,
  m: {
    provider_execution_ms: number;
    cost_usd: number | null;
    tokens: Record<string, number | null | undefined> | null;
  },
) {
  u.completions++;
  u.provider_ms += m.provider_execution_ms;
  const input = m.tokens?.input ?? m.tokens?.input_tokens;
  const output = m.tokens?.output ?? m.tokens?.output_tokens;
  u.input_tokens = u.input_tokens == null || input == null ? null : u.input_tokens + input;
  u.output_tokens = u.output_tokens == null || output == null ? null : u.output_tokens + output;
  const cacheRead = m.tokens?.cache_read ?? m.tokens?.cache_read_input_tokens;
  const cacheWrite = m.tokens?.cache_creation ?? m.tokens?.cache_creation_input_tokens;
  u.cache_read_tokens = u.cache_read_tokens == null || cacheRead == null ? null : u.cache_read_tokens + cacheRead;
  u.cache_creation_tokens =
    u.cache_creation_tokens == null || cacheWrite == null ? null : u.cache_creation_tokens + cacheWrite;
  u.cost_usd = u.cost_usd == null || m.cost_usd == null ? null : u.cost_usd + m.cost_usd;
  return u;
}

export function mergeUsage(total: Record<string, unknown>, turn: ChatUsage) {
  const t = { ...emptyUsage(), ...(total as Partial<ChatUsage>) };
  const sum = (a: number | null | undefined, b: number | null) =>
    a == null || b == null ? null : a + b;
  return {
    completions: (t.completions ?? 0) + turn.completions,
    tool_calls: (t.tool_calls ?? 0) + turn.tool_calls,
    provider_ms: (t.provider_ms ?? 0) + turn.provider_ms,
    input_tokens: sum(t.input_tokens, turn.input_tokens),
    output_tokens: sum(t.output_tokens, turn.output_tokens),
    cache_read_tokens: sum(t.cache_read_tokens, turn.cache_read_tokens ?? null),
    cache_creation_tokens: sum(t.cache_creation_tokens, turn.cache_creation_tokens ?? null),
    cost_usd: sum(t.cost_usd, turn.cost_usd),
  };
}

export function withholdRevoked<T extends Pick<MessageRow, "role" | "content" | "citations">>(
  messages: T[],
  readable: string[],
): Array<T & { withheld?: boolean }> {
  return messages.map((m) => {
    const lost = (m.citations ?? []).some((c) => c.repository && !readable.includes(c.repository));
    return lost
      ? { ...m, content: "[withheld: repository access was revoked]", withheld: true }
      : m;
  });
}

/** The turn's phase and its phase.updated event, written by one statement. */
async function phase(
  turn: TurnRow,
  name: ExecutionPhase,
  data: Record<string, unknown> = {},
) {
  await chatRepository.setPhaseWithEvent(turn.id, name, data, {
    conversationId: turn.conversation_id,
    ownerId: turn.owner_id,
  });
}

async function finishCanceled(turn: TurnRow) {
  const failure = chatFailure("CANCELED", "Turn canceled by user");
  const done = await chatRepository.finishTurn(turn.id, "canceled", {
    error: "canceled",
    failure: { ...failure },
    phase: "canceled",
  });
  if (done)
    await emitChatEvent({
      conversationId: turn.conversation_id,
      ownerId: turn.owner_id,
      turnId: turn.id,
      kind: "turn.canceled",
      data: { failure: done.failure },
    });
}

async function finishFailed(turn: TurnRow, failure: ChatFailure, metrics?: Record<string, unknown>, attempts?: ProviderAttempt[]) {
  const done = await chatRepository.finishTurn(turn.id, "failed", {
    error: failure.message,
    failure: { ...failure },
    metrics,
    phase: "failed",
    attempts,
  });
  if (done)
    await emitChatEvent({
      conversationId: turn.conversation_id,
      ownerId: turn.owner_id,
      turnId: turn.id,
      kind: "turn.failed",
      data: { failure, metrics },
    });
}

export async function runTurn(turnId: number, providers: Providers | undefined = providerSeam) {
  const claimed = await chatRepository.claimTurn(turnId, config.instanceId);
  if (!claimed) return;
  const turn = claimed;
  const ac = new AbortController();
  active.set(turnId, ac);
  const poll = setInterval(() => {
    chatRepository
      .turnStatus(turnId)
      .then((s) => {
        if (s?.status !== "running") ac.abort(new TurnCanceled("canceled"));
      })
      .catch(() => {});
  }, 1000);
  poll.unref?.();
  const deadline = AbortSignal.timeout(LIMITS.turnTimeoutMs);
  const signal = AbortSignal.any([ac.signal, deadline]);
  const stream = new TurnStream({
    conversationId: turn.conversation_id,
    ownerId: turn.owner_id,
    turnId: turn.id,
  });
  try {
    await executeTurn(turn, signal, providers, stream);
  } catch (e) {
    await savePartial(turn, stream).catch((err) => console.error("chat partial answer:", (err as Error).message));
    await closeStream(stream);
    if (ac.signal.aborted || e instanceof TurnCanceled) await finishCanceled(turn);
    else {
      const failure =
        deadline.aborted
          ? chatFailure("TURN_TIMEOUT", `Turn exceeded ${LIMITS.turnTimeoutMs / 1000}s`)
          : asChatFailure(e);
      await recordContinuation(turn.id, { status: "failed", failure });
      await finishFailed(turn, failure);
    }
  } finally {
    clearInterval(poll);
    active.delete(turnId);
  }
}

const ESCALATION = /```chat-escalate/;
const deltaContext = () => config.agent.deltaContext !== false;

/**
 * Resuming an unfinished request: refresh the owner's integration sessions, re-check the tools that blocked it and
 * hand the model the evidence already gathered (bounded, still-readable repositories only).
 */
async function resumeBrief(ownerId: number, cont: Continuation, readable: string[]) {
  const refreshed = await execution.run({ userId: ownerId, kind: "user" }, async () => {
    await loadPersonalIntegrations(true).catch(() => {});
    const tools = integrationTools();
    return [...new Set(cont.blockers.map((b) => b.tool).filter((t): t is string => !!t))]
      .map((tool) => ({ tool, def: tools.find((t) => t.name === tool) }))
      .filter((x) => x.def)
      .map((x) => ({ tool: x.tool, available: x.def!.available() }));
  });
  const refs = cont.completed.map((c) => c.evidence_ref).filter((r): r is string => !!r);
  const rows = refs.length
    ? (await chatRepository.toolCallsOf(cont.conversation_id ?? 0)).filter((r) => r.evidence_ref && refs.includes(r.evidence_ref))
    : [];
  const evidence = rows
    .filter((r) => r.repositories.every((repo) => readable.includes(repo)))
    .slice(-6)
    .map((r) => ({ ref: r.evidence_ref!, tool: r.tool, body: boundedContextJson(r.result).slice(0, 1500) }));
  return continuationBrief(cont, refreshed, evidence);
}

/**
 * At the end of every turn (before it becomes terminal): derive the unfinished-request state from what the platform
 * recorded — tool calls, operations, failure, budget — never from the model.
 */
async function recordContinuation(
  turnId: number,
  outcome: {
    status: "completed" | "failed";
    failure?: ChatFailure;
    stopReason?: string | null;
    escalated?: boolean;
  },
) {
  try {
    const turn = await chatRepository.getTurn(turnId);
    if (!turn) return;
    const conversation = await chatRepository.getConversation(turn.conversation_id, turn.owner_id);
    const message = await chatRepository.messageOfTurn(turn.id, "user");
    if (!conversation || !message) return;
    const prev = conversation.continuation ?? null;
    const calls = (await chatRepository.toolCallsOf(turn.conversation_id)).filter((c) => c.turn_id === turn.id);
    const ops = await operationsOf(turn.conversation_id, turn.owner_id);
    const tracked = new Set(prev?.operations.map((o) => o.id) ?? []);
    const routing = turn.routing as { path?: string; continued?: boolean };
    const next = nextContinuation(
      prev,
      {
        turnId: turn.id,
        message: message.content,
        route: turn.route,
        effectiveMode: turn.effective_mode,
        path: routing.path === "tools" || outcome.escalated ? "tools" : "direct",
        status: outcome.status,
        failure: outcome.failure ?? null,
        stopReason: outcome.stopReason ?? null,
        toolCalls: calls.map((c) => ({
          tool: c.tool,
          arguments: c.arguments,
          status: c.status,
          label: c.tool,
          error: (c.result as { error?: string } | null)?.error ?? null,
          evidence_ref: c.evidence_ref,
        })),
        operations: ops.filter((o) => o.turn_id === turn.id || tracked.has(o.id)),
      },
      routing.continued === true,
    );
    await chatRepository.setContinuation(turn.conversation_id, next ? { ...next, conversation_id: turn.conversation_id } : null);
  } catch (e) {
    console.error("chat continuation:", (e as Error).message);
  }
}

const closeStream = (stream: TurnStream) =>
  stream.close().catch((err) => console.error("chat stream close:", (err as Error).message));

/** A stopped or failed turn keeps the answer text it had streamed; the turn status marks it as partial. */
async function savePartial(turn: TurnRow, stream: TurnStream) {
  await stream.flush();
  const text = stripToolBlocks(stream.draft);
  if (!text) return;
  const saved = await chatRepository.insertPartialAnswer(turn.id, turn.conversation_id, text);
  if (saved)
    await emitChatEvent({
      conversationId: turn.conversation_id,
      ownerId: turn.owner_id,
      turnId: turn.id,
      kind: "response.partial",
      data: { message_id: saved.id, chars: text.length },
    });
}

async function executeTurn(
  turn: TurnRow,
  signal: AbortSignal,
  providers: Providers | undefined,
  stream: TurnStream,
) {
  const ids = { conversationId: turn.conversation_id, ownerId: turn.owner_id, turnId: turn.id };
  const started = Date.now();
  const conversation = (await chatRepository.getConversation(
    turn.conversation_id,
    turn.owner_id,
  )) as ConversationRow;
  const userMessage = await chatRepository.messageOfTurn(turn.id, "user");
  if (!conversation || !userMessage) throw new Error("turn has no conversation or message");
  const owner = await chatRepository.userActive(turn.owner_id);
  if (!owner?.active) throw new Error("user is not active");

  await phase(turn, "routing");
  await emitChatEvent({ ...ids, kind: "routing.started", data: { mode: turn.mode } });

  const mentions: ResolvedMention[] = await resolveMentions(turn.owner_id, userMessage.content);
  if (mentions.length) await chatRepository.setMentions(userMessage.id, mentions.map(publicMention));

  const prior = await chatRepository.latestTurnWithUser(conversation.id, turn.id);
  let routing = routeTurnIntelligent(turn.mode, userMessage.content, mentions, prior?.route ?? null);
  // An unfinished request (blocked tool, pending operation…) is resumed by a follow-up instead of starting over.
  const unfinished = conversation.continuation ?? null;
  const follow = continuesGoal(userMessage.content, unfinished, routing);
  if (follow.continues && unfinished)
    routing = {
      ...routing,
      route: unfinished.route as typeof routing.route,
      effective_mode:
        turn.mode === "AUTO" ? (unfinished.effective_mode as typeof routing.effective_mode) : routing.effective_mode,
      path: "tools",
      reason: `continues the unfinished request of turn #${unfinished.goal_turn_id} (${follow.reason})`,
      source: "context",
    };
  const effectiveMode = routing.effective_mode as ManualChatMode;

  await emitChatEvent({
    ...ids,
    kind: "routing.completed",
    data: { ...routing, effective_mode: effectiveMode },
  });

  const strategy: ProviderStrategy =
    (conversation.provider_strategy as ProviderStrategy) ||
    (turn.provider === "auto" || turn.provider == null ? "auto" : "manual");
  const preferred =
    strategy === "auto"
      ? conversation.provider && conversation.provider !== "auto"
        ? conversation.provider
        : turn.requested_provider ?? turn.provider
      : turn.provider ?? conversation.provider;
  const fallbackEnabled = conversation.fallback_enabled === true || strategy === "auto";

  await phase(turn, "validating_provider");
  const attempts: ProviderAttempt[] = [];
  const avoid = new Set<string>();
  // One configuration document for the whole turn: admission, agent resolution and every completion use it.
  const cfg = await loadAgentConfiguration();
  let admission = await admitProvider({
    strategy,
    preferred,
    model: turn.model ?? conversation.model,
    effort: turn.reasoning_effort ?? conversation.reasoning_effort,
    fallbackEnabled,
    avoid,
    configuration: cfg,
  });
  await emitChatEvent({
    ...ids,
    kind: "provider.health",
    data: {
      health: admission.health.map((h) => ({
        provider: h.provider,
        connected: h.connected,
        quota: h.quota,
        reason: h.reason,
      })),
    },
  });
  for (const s of admission.skipped) {
    await emitChatEvent({ ...ids, kind: "provider.skipped", data: s });
  }
  await emitChatEvent({
    ...ids,
    kind: "provider.selected",
    data: {
      provider: admission.provider,
      model: admission.model,
      reason: admission.reason,
      strategy: admission.strategy,
    },
  });

  await chatRepository.setTurnPlan(turn.id, {
    effectiveMode,
    route: routing.route,
    routing: { ...routing, continued: follow.continues },
    provider: admission.provider,
    model: admission.model,
    effort: admission.effort,
    providerStrategy: strategy,
    phase: "preparing_context",
  });

  const readable = await readableRepositories(turn.owner_id);
  const repositories = [
    ...new Set([
      ...conversation.repositories.filter((r) => readable.includes(r)),
      ...mentions.filter((m) => m.resolved && m.repository).map((m) => m.repository!),
    ]),
  ];

  const history = withholdRevoked(
    (await chatRepository.historyFor(conversation.id, conversation.summary_through)).filter(
      (m) => m.id < userMessage.id && m.role !== "system",
    ),
    readable,
  ).filter((m) => !m.withheld);
  const { summary, window, compacted } = await compactIfNeeded(conversation, history);
  const memories = await recallMemories(turn.owner_id, userMessage.content);
  const selected = await knowledgeForTurn({
    ownerId: turn.owner_id,
    repositories,
    text: userMessage.content,
  });
  const knowledgeRefs = selected.map((x) => refOf(x.item, x.disclosure));
  if (knowledgeRefs.length) {
    for (const r of knowledgeRefs) stream.knowledge(r);
    await emitChatEvent({ ...ids, kind: "knowledge.applied", data: { items: knowledgeRefs } });
  }
  const promptKnowledge = selected.map(({ item, disclosure }) => ({
    key: item.key,
    version: item.version,
    title: item.title,
    category: item.category,
    reason: item.reason,
    disclosure: disclosure as "inline" | "index",
    ...(disclosure === "inline"
      ? { content: item.content }
      : { description: String(item.metadata?.description ?? "").slice(0, 200) }),
  }));

  const binding: ChatBinding = {
    userId: turn.owner_id,
    conversationId: conversation.id,
    turnId: turn.id,
    mode: effectiveMode,
    repositories,
  };
  const usage = emptyUsage();
  const steps: Array<Record<string, unknown>> = [];
  const citations: Citation[] = [];
  const toolResults: Array<{ seq: number; tool: string; status: string; body: string }> = [];
  const seen = new Set<string>();
  // Intent-focused catalog for the first step; a resumed or escalated request gets the mode's full catalog.
  let catalog =
    routing.path === "tools"
      ? toolCatalog(effectiveMode, follow.continues || !deltaContext() ? null : routing.route)
      : null;
  let escalated = false;
  const resume =
    follow.continues && unfinished ? await resumeBrief(turn.owner_id, unfinished, readable) : null;
  let seq = 0;
  let final: string | null = null;
  let stopReason: string | null = null;
  let lastFailure: ChatFailure | null = null;

  // Bounded provider attempts with health admission before each inference.
  for (let attempt = 0; attempt < ADMISSION.maxProviderAttempts && final == null; attempt++) {
    signal.throwIfAborted();
    if (attempt > 0) {
      await phase(turn, "switching_provider", { from: attempts.at(-1)?.provider });
      await emitChatEvent({
        ...ids,
        kind: "provider.fallback",
        data: { attempt, previous: attempts.at(-1), next_reason: "previous attempt failed" },
      });
      admission = await admitProvider({
        strategy: "auto",
        preferred: null,
        model: null,
        effort: null,
        fallbackEnabled: true,
        avoid,
        configuration: cfg,
      });
      await emitChatEvent({
        ...ids,
        kind: "provider.selected",
        data: { provider: admission.provider, reason: admission.reason, fallback: true },
      });
      await chatRepository.setRoute(
        turn.id,
        routing.route,
        admission.provider,
        admission.model,
        admission.effort,
      );
    }

    const agent = {
      provider: admission.provider,
      model: admission.model,
      reasoning_effort: admission.effort,
    };
    const profile = routing.path === "direct" ? "FAST" : "STANDARD";
    const run = { agent_configuration: cfg, profile, agent_provider: admission.provider };
    const resolved = completionAgent(run, agent);
    const attemptRec: ProviderAttempt = {
      provider: admission.provider,
      model: resolved.model ?? null,
      effort: resolved.reasoning_effort ?? null,
      started_at: new Date().toISOString(),
      ok: false,
    };
    attempts.push(attemptRec);
    await chatRepository.setAttempts(turn.id, attempts);
    await emitChatEvent({
      ...ids,
      kind: "provider.attempt_started",
      data: { provider: admission.provider, model: resolved.model, attempt },
    });
    await emitChatEvent({
      ...ids,
      kind: "turn.started",
      data: {
        route: routing.route,
        path: routing.path,
        mode: turn.mode,
        effective_mode: effectiveMode,
        provider: admission.provider,
        model: resolved.model ?? null,
        reasoning_effort: resolved.reasoning_effort ?? null,
        streaming: true,
        mentions: mentions.map(publicMention),
        routing_reason: routing.reason,
        attempt,
      },
    });

    // Assigned inside the send closure; a holder keeps the type visible to the catch below.
    const stallRef: { current: ReturnType<typeof stallGuard> | null } = { current: null };
    // Provider session of this attempt: it already holds everything sent so far, so later steps send only what is new.
    let session: string | null = null;
    let delivered = 0;
    let catalogDelivered = false;
    // Tool results of earlier steps are compacted for stateless providers; this marks where the latest batch starts.
    let latestFrom = Number.MAX_SAFE_INTEGER;
    try {
      await phase(turn, "preparing_context");
      for (let step = 0; step < LIMITS.maxSteps && final == null; step++) {
        signal.throwIfAborted();
        const lastStep = step === LIMITS.maxSteps - 1 || seq >= LIMITS.maxToolCalls;
        if (lastStep && catalog) {
          catalog = null;
          stopReason ??= "tool budget reached";
          toolResults.push({
            seq: 0,
            tool: "platform",
            status: "note",
            body: `Tool budget reached (${stopReason}). Answer now with the evidence you have and list what is missing.`,
          });
        }
        const { prompt, stats } = buildPrompt({
          conversation,
          mode: effectiveMode,
          locale:
            VIETNAMESE.test(userMessage.content) || !/[a-z]{3}/i.test(userMessage.content)
              ? "vi"
              : "en",
          user: { id: turn.owner_id, name: `user ${turn.owner_id}` },
          summary,
          history: window,
          mentions,
          catalog,
          message: userMessage.content,
          toolResults: deltaContext() ? compactToolResults(toolResults, latestFrom) : toolResults,
          repositories,
          memories,
          knowledge: promptKnowledge,
          continuation: resume,
          canEscalate: routing.path === "direct" && !escalated && step < LIMITS.maxSteps - 1,
        });
        if (step === 0 && attempt === 0)
          await emitChatEvent({
            ...ids,
            kind: "context.updated",
            data: { ...stats, compacted, history_messages: window.length },
          });

        await phase(turn, "calling_provider", { provider: admission.provider, step });
        await stream.begin(attempt, step, catalog != null);
        const send = async (text: string, resume: string | null) => {
          const guard = stallGuard(LIMITS.firstActivityMs, LIMITS.streamIdleMs);
          stallRef.current = guard;
          return completeForRun(
            run,
            text,
            AbortSignal.any([signal, guard.signal]),
            providers,
            agent,
            (ev) => {
              guard.touch();
              stream.onEvent(ev);
            },
            { keep: deltaContext(), resume },
          ).finally(() => guard.dispose());
        };
        const delta = session
          ? deltaPrompt({
              results: toolResults.slice(delivered),
              catalog,
              catalogNewlyOpened: !!catalog && !catalogDelivered,
              toolsWithdrawn: !catalog && catalogDelivered,
            })
          : null;
        let completion: Awaited<ReturnType<typeof send>>;
        let sent: "delta" | "full" = delta ? "delta" : "full";
        try {
          completion = await send(delta ?? prompt, delta ? session : null);
        } catch (e) {
          if (!delta || signal.aborted || stallRef.current?.failure) throw e;
          // The provider lost the session: rebuild statelessly instead of failing the turn.
          session = null;
          sent = "full";
          completion = await send(prompt, null);
        }
        session = completion.session_id ?? null;
        delivered = toolResults.length;
        catalogDelivered = !!catalog;
        signal.throwIfAborted();
        await stream.flush();
        addUsage(usage, completion.metrics);
        steps.push({
          attempt,
          step,
          sent,
          estimated_tokens: estimateTokens(sent === "delta" ? delta! : prompt),
          full_estimated_tokens: stats.estimated_tokens,
          input: completion.metrics.tokens?.input ?? null,
          output: completion.metrics.tokens?.output ?? null,
          cache_read: completion.metrics.tokens?.cache_read ?? null,
          cache_creation: completion.metrics.tokens?.cache_creation ?? null,
        });
        await emitChatEvent({ ...ids, kind: "usage.updated", data: { ...usage } });
        await phase(turn, "receiving_response");

        if (routing.path === "direct" && !escalated && ESCALATION.test(completion.text)) {
          // The direct path asked for tools: open the catalog for the rest of this turn (one extra call, only when needed).
          escalated = true;
          catalog = toolCatalog(effectiveMode);
          await emitChatEvent({
            ...ids,
            kind: "routing.completed",
            data: { ...routing, path: "tools", escalated: true, reason: "the direct answer needed platform tools" },
          });
          continue;
        }
        const calls = catalog ? parseToolCalls(completion.text) : null;
        if (!calls) {
          final = stripToolBlocks(completion.text);
          break;
        }
        await phase(turn, "executing_tools");
        latestFrom = seq + 1;
        let progressed = false;
        for (const call of calls.slice(0, LIMITS.maxToolCallsPerStep)) {
          if (seq >= LIMITS.maxToolCalls) break;
          signal.throwIfAborted();
          const key = JSON.stringify([call.tool, call.arguments]);
          seq++;
          const row = await chatRepository.insertToolCall({
            turnId: turn.id,
            conversationId: conversation.id,
            ownerId: turn.owner_id,
            seq,
            tool: call.tool,
            arguments: (call.arguments ?? {}) as Record<string, unknown>,
          });
          stream.tool(row.id, call.tool, "running");
          await emitChatEvent({
            ...ids,
            kind: "tool.started",
            data: { tool_call_id: row.id, seq, tool: call.tool },
          });
          const t0 = Date.now();
          const outcome = seen.has(key)
            ? {
                status: "denied" as const,
                result: { error: "duplicate call: same tool and arguments already ran in this turn" },
                repositories: [] as string[],
                label: call.tool,
              }
            : await executeChatTool(binding, call.tool, call.arguments, signal);
          seen.add(key);
          if (outcome.status === "ok") progressed = true;
          const evidenceRef =
            outcome.status === "ok" ? `chat:${conversation.id}:tool:${row.id}` : null;
          const durationMs = Date.now() - t0;
          await chatRepository.finishToolCall(row.id, {
            status: outcome.status,
            result: outcome.result,
            repositories: outcome.repositories,
            evidenceRef,
            durationMs,
          });
          usage.tool_calls++;
          stream.tool(row.id, call.tool, outcome.status, durationMs);
          const read = outcome.result as { key?: string; version?: number; title?: string; owner?: string } | null;
          if (call.tool === "knowledge.get" && outcome.status === "ok" && read?.key && read.version != null)
            stream.knowledge({ key: read.key, version: read.version, title: read.title ?? read.key, owner: read.owner ?? "shared" });
          await emitChatEvent({
            ...ids,
            kind: outcome.status === "ok" ? "tool.completed" : "tool.failed",
            data: {
              tool_call_id: row.id,
              seq,
              tool: call.tool,
              status: outcome.status,
              label: outcome.label,
              duration_ms: durationMs,
            },
          });
          if (evidenceRef) {
            const citation: Citation = {
              tool_call_id: row.id,
              tool: call.tool,
              ref: evidenceRef,
              label: outcome.label,
              ...(outcome.repositories.length === 1
                ? { repository: outcome.repositories[0] }
                : {}),
            };
            citations.push(citation);
            for (const r of outcome.repositories.slice(1))
              citations.push({ ...citation, repository: r });
            await emitChatEvent({ ...ids, kind: "evidence.added", data: { ...citation } });
          }
          const body = boundedContextJson(outcome.result);
          toolResults.push({
            seq,
            tool: call.tool,
            status: outcome.status,
            body:
              body.length > LIMITS.toolResultChars
                ? `${body.slice(0, LIMITS.toolResultChars)}… [truncated]`
                : body,
          });
        }
        if (!progressed && step > 0) {
          stopReason = "no progress";
          catalog = null;
        }
      }

      if (final == null) throw new ChatTurnError(chatFailure("INCOMPLETE_OUTPUT", "no answer within the step budget"));
      if (!final.trim())
        throw new ChatTurnError(chatFailure("INCOMPLETE_OUTPUT", "provider returned an empty answer"));

      attemptRec.ok = true;
      attemptRec.finished_at = new Date().toISOString();
      attemptRec.duration_ms = Date.now() - started;
      await chatRepository.setAttempts(turn.id, attempts);
      break;
    } catch (e) {
      if (e instanceof TurnCanceled || signal.aborted) throw e;
      const failure = stallRef.current?.failure
        ? { ...stallRef.current.failure, provider: admission.provider }
        : asChatFailure(e, admission.provider);
      if (failure.code === "QUOTA_EXHAUSTED") rememberProviderQuota(admission.provider);
      // Readiness reused across admissions must not outlive evidence that it is wrong.
      if (
        ["AUTHENTICATION_REQUIRED", "PROVIDER_UNAVAILABLE", "PROVIDER_STARTUP_TIMEOUT"].includes(
          failure.code,
        )
      )
        invalidateSharedAgentHealth();
      attemptRec.ok = false;
      attemptRec.failure = failure;
      attemptRec.finished_at = new Date().toISOString();
      await chatRepository.setAttempts(turn.id, attempts);
      await emitChatEvent({
        ...ids,
        kind: "provider.attempt_failed",
        data: { provider: admission.provider, failure, attempt },
      });
      lastFailure = failure;
      avoid.add(admission.provider);
      if (!mayFallback(failure, strategy, fallbackEnabled) || attempt + 1 >= ADMISSION.maxProviderAttempts)
        throw new ChatTurnError({ ...failure, fallback_attempted: attempts.length > 1 });
      // Reuse toolResults already collected — do not clear authorized evidence.
      continue;
    }
  }

  if (final == null) {
    throw new ChatTurnError(
      lastFailure
        ? { ...lastFailure, fallback_attempted: attempts.length > 1 }
        : chatFailure("NO_ELIGIBLE_PROVIDER", "No provider produced an answer"),
    );
  }

  for (const r of knowledgeRefs)
    if (r.disclosure === "inline")
      citations.push({ ref: `knowledge:${r.key}@v${r.version}`, label: `${r.title} v${r.version}` });
  for (const m of mentions)
    if (m.resolved && m.repository)
      citations.push({
        ref: `@${m.kind}:${m.ref}`,
        label: m.label ?? m.ref,
        repository: m.repository,
      });

  const metrics = {
    ...usage,
    latency_ms: Date.now() - started,
    route: routing.route,
    path: escalated ? "tools" : routing.path,
    escalated,
    continued: follow.continues,
    routing_reason: routing.reason,
    stop_reason: stopReason,
    // Per provider call: what was sent (full prompt or delta to a kept session), its estimate and the provider's usage.
    steps,
    compacted,
    attempts: attempts.length,
    provider: admission.provider,
    model: attempts.find((a) => a.ok)?.model ?? admission.model,
  };
  // Recorded before the turn becomes terminal, so an immediate follow-up already sees it.
  await recordContinuation(turn.id, { status: "completed", stopReason, escalated });
  await closeStream(stream);
  const outcome = await withTx(async (c) => {
    const done = await chatRepository.finishTurn(
      turn.id,
      "completed",
      { metrics, phase: "completed", attempts },
      c,
    );
    if (!done) return null;
    const message = await chatRepository.insertMessage(
      {
        conversationId: conversation.id,
        turnId: turn.id,
        role: "assistant",
        content: final!,
        citations,
      },
      c,
    );
    const fresh = await chatRepository.lockConversation(conversation.id, turn.owner_id, c);
    await chatRepository.addUsage(conversation.id, mergeUsage(fresh?.usage ?? {}, usage), c);
    return message;
  });
  if (!outcome) return;
  await emitChatEvent({
    ...ids,
    kind: "turn.completed",
    data: { message_id: outcome.id, metrics, attempts },
  });
  background(`chat learning ${turn.id}`, () => learnFromTurn(turn.id));
}

export function abortLocal(turnId: number) {
  active.get(turnId)?.abort(new TurnCanceled("canceled"));
}

export async function recoverInstanceTurns() {
  for (const t of await chatRepository.runningTurnsOf(config.instanceId)) {
    if (active.has(t.id)) continue;
    if (t.draft) await chatRepository.insertPartialAnswer(t.id, t.conversation_id, stripToolBlocks(t.draft));
    await finishFailed(
      t,
      chatFailure("INTERRUPTED", "interrupted: the platform restarted"),
    );
  }
}

export async function recoverStaleTurns(conversationId: number) {
  for (const t of await chatRepository.staleTurns(conversationId)) {
    if (active.has(t.id)) continue;
    if (t.draft) await chatRepository.insertPartialAnswer(t.id, t.conversation_id, stripToolBlocks(t.draft));
    await finishFailed(
      t,
      chatFailure("INTERRUPTED", "interrupted: the worker instance stopped"),
    );
  }
}

// Re-export routeTurn for tests that import from runtime historically — they use policy.
export { routeTurn } from "./policy.ts";
