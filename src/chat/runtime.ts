import { config } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { background } from "../workflow/background.ts";
import { completeForRun, completionAgent, type CompletionRunner } from "../agent/complete.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import type { AgentProvider } from "../agent/provider.ts";
import { rememberProviderQuota } from "../agent/health.ts";
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
  compactIfNeeded,
  publicMention,
  resolveMentions,
  type ResolvedMention,
} from "./context.ts";
import { executeChatTool, readableRepositories, toolCatalog, type ChatBinding } from "./tools.ts";
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
  background(`chat turn ${turnId}`, () => runTurn(turnId));
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
  return { completions: 0, tool_calls: 0, provider_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
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

async function phase(
  turn: TurnRow,
  name: ExecutionPhase,
  data: Record<string, unknown> = {},
) {
  await chatRepository.setPhase(turn.id, name, data);
  await emitChatEvent({
    conversationId: turn.conversation_id,
    ownerId: turn.owner_id,
    turnId: turn.id,
    kind: "phase.updated",
    data: { phase: name, ...data },
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
  try {
    await executeTurn(turn, signal, providers);
  } catch (e) {
    if (ac.signal.aborted || e instanceof TurnCanceled) await finishCanceled(turn);
    else {
      const failure =
        deadline.aborted
          ? chatFailure("TURN_TIMEOUT", `Turn exceeded ${LIMITS.turnTimeoutMs / 1000}s`)
          : asChatFailure(e);
      await finishFailed(turn, failure);
    }
  } finally {
    clearInterval(poll);
    active.delete(turnId);
  }
}

async function executeTurn(turn: TurnRow, signal: AbortSignal, providers: Providers | undefined) {
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

  const prior = await chatRepository.latestTurnWithUser(conversation.id);
  const routing = routeTurnIntelligent(
    turn.mode,
    userMessage.content,
    mentions,
    prior && prior.id !== turn.id ? prior.route : null,
  );
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
  let admission = await admitProvider({
    strategy,
    preferred,
    model: turn.model ?? conversation.model,
    effort: turn.reasoning_effort ?? conversation.reasoning_effort,
    fallbackEnabled,
    avoid,
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
    routing: { ...routing },
    provider: admission.provider,
    model: admission.model,
    effort: admission.effort,
    providerStrategy: strategy,
    phase: "preparing_context",
  });

  const cfg = await loadAgentConfiguration();
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

  const binding: ChatBinding = {
    userId: turn.owner_id,
    conversationId: conversation.id,
    turnId: turn.id,
    mode: effectiveMode,
    repositories,
  };
  const usage = emptyUsage();
  const citations: Citation[] = [];
  const toolResults: Array<{ seq: number; tool: string; status: string; body: string }> = [];
  const seen = new Set<string>();
  let catalog = routing.path === "tools" ? toolCatalog(effectiveMode) : null;
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
        streaming: false,
        mentions: mentions.map(publicMention),
        routing_reason: routing.reason,
        attempt,
      },
    });

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
          toolResults,
          repositories,
        });
        if (step === 0 && attempt === 0)
          await emitChatEvent({
            ...ids,
            kind: "context.updated",
            data: { ...stats, compacted, history_messages: window.length },
          });

        await phase(turn, "calling_provider", { provider: admission.provider, step });
        const completion = await completeForRun(run, prompt, signal, providers, agent);
        signal.throwIfAborted();
        addUsage(usage, completion.metrics);
        await emitChatEvent({ ...ids, kind: "usage.updated", data: { ...usage } });
        await phase(turn, "receiving_response");

        const calls = catalog ? parseToolCalls(completion.text) : null;
        if (!calls) {
          final = stripToolBlocks(completion.text);
          break;
        }
        await phase(turn, "executing_tools");
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
      const failure = asChatFailure(e, admission.provider);
      if (failure.code === "QUOTA_EXHAUSTED") rememberProviderQuota(admission.provider);
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
    path: routing.path,
    routing_reason: routing.reason,
    stop_reason: stopReason,
    compacted,
    attempts: attempts.length,
    provider: admission.provider,
    model: attempts.find((a) => a.ok)?.model ?? admission.model,
  };
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
}

export function abortLocal(turnId: number) {
  active.get(turnId)?.abort(new TurnCanceled("canceled"));
}

export async function recoverInstanceTurns() {
  for (const t of await chatRepository.runningTurnsOf(config.instanceId)) {
    if (active.has(t.id)) continue;
    await finishFailed(
      t,
      chatFailure("INTERRUPTED", "interrupted: the platform restarted"),
    );
  }
}

export async function recoverStaleTurns(conversationId: number) {
  for (const t of await chatRepository.staleTurns(conversationId)) {
    if (active.has(t.id)) continue;
    await finishFailed(
      t,
      chatFailure("INTERRUPTED", "interrupted: the worker instance stopped"),
    );
  }
}

// Re-export routeTurn for tests that import from runtime historically — they use policy.
export { routeTurn } from "./policy.ts";
