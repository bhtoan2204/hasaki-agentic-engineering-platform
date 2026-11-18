import { config } from "../config.ts";
import { withTx } from "../db/pool.ts";
import { background } from "../workflow/background.ts";
import { completeForRun, completionAgent, type CompletionRunner } from "../agent/complete.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import { parseAgentProvider, type AgentProvider } from "../agent/provider.ts";
import { boundedContextJson } from "../agent/contextTools.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";
import { LIMITS, routeTurn } from "./policy.ts";
import { buildPrompt, compactIfNeeded, publicMention, resolveMentions, type ResolvedMention } from "./context.ts";
import { executeChatTool, readableRepositories, toolCatalog, type ChatBinding } from "./tools.ts";
import type { ChatUsage, Citation, ConversationRow, MessageRow, TurnRow } from "./types.ts";

type Providers = Record<AgentProvider, CompletionRunner>;
let providerSeam: Providers | undefined;
/** Tests replace the provider runners (no paid model quota in CI). Production uses the configured CLIs/SDKs. */
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

/** Extract a tool request; anything else is a final answer. */
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

/** Unknown stays unknown: one provider without a figure makes the total null, never a fake zero. */
export function addUsage(
  u: ChatUsage,
  m: { provider_execution_ms: number; cost_usd: number | null; tokens: Record<string, number | null | undefined> | null },
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
  const sum = (a: number | null | undefined, b: number | null) => (a == null || b == null ? null : a + b);
  return {
    completions: (t.completions ?? 0) + turn.completions,
    tool_calls: (t.tool_calls ?? 0) + turn.tool_calls,
    provider_ms: (t.provider_ms ?? 0) + turn.provider_ms,
    input_tokens: sum(t.input_tokens, turn.input_tokens),
    output_tokens: sum(t.output_tokens, turn.output_tokens),
    cost_usd: sum(t.cost_usd, turn.cost_usd),
  };
}

/** Assistant answers built on repositories the owner can no longer read are withheld (content and context). */
export function withholdRevoked<T extends Pick<MessageRow, "role" | "content" | "citations">>(
  messages: T[],
  readable: string[],
): Array<T & { withheld?: boolean }> {
  return messages.map((m) => {
    const lost = (m.citations ?? []).some((c) => c.repository && !readable.includes(c.repository));
    return lost ? { ...m, content: "[withheld: repository access was revoked]", withheld: true } : m;
  });
}

async function finishCanceled(turn: TurnRow) {
  // The cancel endpoint already recorded the terminal state; this is only for an internal abort.
  const done = await chatRepository.finishTurn(turn.id, "canceled", { error: "canceled" });
  if (done)
    await emitChatEvent({ conversationId: turn.conversation_id, ownerId: turn.owner_id, turnId: turn.id, kind: "turn.canceled" });
}

export async function runTurn(turnId: number, providers: Providers | undefined = providerSeam) {
  const claimed = await chatRepository.claimTurn(turnId, config.instanceId);
  if (!claimed) return;
  const turn = claimed;
  const ac = new AbortController();
  active.set(turnId, ac);
  // Cancellation from any instance lands in the turn row; the owning instance aborts the provider within ~1 s.
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
  const ids = { conversationId: turn.conversation_id, ownerId: turn.owner_id, turnId };
  try {
    await executeTurn(turn, signal, providers);
  } catch (e) {
    if (ac.signal.aborted) await finishCanceled(turn);
    else {
      const timeout = deadline.aborted;
      const error = timeout
        ? `turn exceeded ${LIMITS.turnTimeoutMs / 1000} s`
        : String((e as Error)?.message ?? e).slice(0, 500);
      const done = await chatRepository.finishTurn(turnId, "failed", { error });
      if (done) await emitChatEvent({ ...ids, kind: "turn.failed", data: { error, timeout } });
    }
  } finally {
    clearInterval(poll);
    active.delete(turnId);
  }
}

async function executeTurn(turn: TurnRow, signal: AbortSignal, providers: Providers | undefined) {
  const ids = { conversationId: turn.conversation_id, ownerId: turn.owner_id, turnId: turn.id };
  const started = Date.now();
  const conversation = (await chatRepository.getConversation(turn.conversation_id, turn.owner_id)) as ConversationRow;
  const userMessage = await chatRepository.messageOfTurn(turn.id, "user");
  if (!conversation || !userMessage) throw new Error("turn has no conversation or message");
  const owner = await chatRepository.userActive(turn.owner_id);
  if (!owner?.active) throw new Error("user is not active");

  const cfg = await loadAgentConfiguration();
  const provider = parseAgentProvider(turn.provider) ?? cfg.default_provider;
  // No silent fallback: a disabled or unknown provider fails the turn; the user picks another one explicitly.
  if (!cfg.providers[provider]?.enabled) throw new Error(`provider ${provider} is disabled in Settings`);
  const agent = { provider, model: turn.model, reasoning_effort: turn.reasoning_effort };

  const mentions: ResolvedMention[] = await resolveMentions(turn.owner_id, userMessage.content);
  if (mentions.length) await chatRepository.setMentions(userMessage.id, mentions.map(publicMention));
  const readable = await readableRepositories(turn.owner_id);
  const repositories = [
    ...new Set([
      ...conversation.repositories.filter((r) => readable.includes(r)),
      ...mentions.filter((m) => m.resolved && m.repository).map((m) => m.repository!),
    ]),
  ];
  const route = routeTurn(turn.mode, userMessage.content, mentions);
  const profile = route === "direct" ? "FAST" : "STANDARD";
  const run = { agent_configuration: cfg, profile, agent_provider: provider };
  const resolved = completionAgent(run, agent);
  await chatRepository.setRoute(turn.id, route, resolved.provider, resolved.model ?? null, resolved.reasoning_effort ?? null);
  await emitChatEvent({
    ...ids,
    kind: "turn.started",
    data: {
      route,
      mode: turn.mode,
      provider: resolved.provider,
      model: resolved.model ?? null,
      reasoning_effort: resolved.reasoning_effort ?? null,
      streaming: false,
      mentions: mentions.map(publicMention),
    },
  });

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
    mode: turn.mode,
    repositories,
  };
  const usage = emptyUsage();
  const citations: Citation[] = [];
  const toolResults: Array<{ seq: number; tool: string; status: string; body: string }> = [];
  const seen = new Set<string>();
  let catalog = route === "tools" ? toolCatalog(turn.mode) : null;
  let seq = 0;
  let final: string | null = null;
  let stopReason: string | null = null;

  for (let step = 0; step < LIMITS.maxSteps && final == null; step++) {
    signal.throwIfAborted();
    const lastStep = step === LIMITS.maxSteps - 1 || seq >= LIMITS.maxToolCalls;
    if (lastStep && catalog) {
      catalog = null;
      stopReason ??= "tool budget reached";
      toolResults.push({ seq: 0, tool: "platform", status: "note", body: `Tool budget reached (${stopReason}). Answer now with the evidence you have and list what is missing.` });
    }
    const { prompt, stats } = buildPrompt({
      conversation,
      mode: turn.mode,
      locale: VIETNAMESE.test(userMessage.content) || !/[a-z]{3}/i.test(userMessage.content) ? "vi" : "en",
      user: { id: turn.owner_id, name: `user ${turn.owner_id}` },
      summary,
      history: window,
      mentions,
      catalog,
      message: userMessage.content,
      toolResults,
      repositories,
    });
    if (step === 0)
      await emitChatEvent({ ...ids, kind: "context.updated", data: { ...stats, compacted, history_messages: window.length } });
    const completion = await completeForRun(run, prompt, signal, providers, agent);
    signal.throwIfAborted();
    addUsage(usage, completion.metrics);
    await emitChatEvent({ ...ids, kind: "usage.updated", data: { ...usage } });
    const calls = catalog ? parseToolCalls(completion.text) : null;
    if (!calls) {
      final = stripToolBlocks(completion.text);
      break;
    }
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
      await emitChatEvent({ ...ids, kind: "tool.started", data: { tool_call_id: row.id, seq, tool: call.tool } });
      const t0 = Date.now();
      const outcome = seen.has(key)
        ? { status: "denied" as const, result: { error: "duplicate call: same tool and arguments already ran in this turn" }, repositories: [], label: call.tool }
        : await executeChatTool(binding, call.tool, call.arguments, signal);
      seen.add(key);
      if (outcome.status === "ok") progressed = true;
      const evidenceRef = outcome.status === "ok" ? `chat:${conversation.id}:tool:${row.id}` : null;
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
        data: { tool_call_id: row.id, seq, tool: call.tool, status: outcome.status, label: outcome.label, duration_ms: durationMs },
      });
      if (evidenceRef) {
        const citation: Citation = {
          tool_call_id: row.id,
          tool: call.tool,
          ref: evidenceRef,
          label: outcome.label,
          ...(outcome.repositories.length === 1 ? { repository: outcome.repositories[0] } : {}),
        };
        citations.push(citation);
        for (const r of outcome.repositories.slice(1)) citations.push({ ...citation, repository: r });
        await emitChatEvent({ ...ids, kind: "evidence.added", data: { ...citation } });
      }
      const body = boundedContextJson(outcome.result);
      toolResults.push({
        seq,
        tool: call.tool,
        status: outcome.status,
        body: body.length > LIMITS.toolResultChars ? `${body.slice(0, LIMITS.toolResultChars)}… [truncated]` : body,
      });
    }
    // No progress: every call failed or repeated. One more round is allowed only if something new came back.
    if (!progressed && step > 0) {
      stopReason = "no progress";
      catalog = null;
    }
  }
  if (final == null) throw new Error("no answer within the step budget");
  if (!final.trim()) throw new Error("provider returned an empty answer");
  for (const m of mentions)
    if (m.resolved && m.repository)
      citations.push({ ref: `@${m.kind}:${m.ref}`, label: m.label ?? m.ref, repository: m.repository });

  const metrics = { ...usage, latency_ms: Date.now() - started, route, stop_reason: stopReason, compacted };
  const outcome = await withTx(async (c) => {
    const done = await chatRepository.finishTurn(turn.id, "completed", { metrics }, c);
    if (!done) return null;
    const message = await chatRepository.insertMessage(
      { conversationId: conversation.id, turnId: turn.id, role: "assistant", content: final!, citations },
      c,
    );
    const fresh = await chatRepository.lockConversation(conversation.id, turn.owner_id, c);
    await chatRepository.addUsage(conversation.id, mergeUsage(fresh?.usage ?? {}, usage), c);
    return message;
  });
  // Canceled while finishing: the late answer is discarded, never shown as a completed turn.
  if (!outcome) return;
  await emitChatEvent({ ...ids, kind: "turn.completed", data: { message_id: outcome.id, metrics } });
}

/** Abort a turn running on this instance (other instances notice the row within a second). */
export function abortLocal(turnId: number) {
  active.get(turnId)?.abort(new TurnCanceled("canceled"));
}

/** Startup: this instance's running turns lost their process. */
export async function recoverInstanceTurns() {
  for (const t of await chatRepository.runningTurnsOf(config.instanceId)) {
    if (active.has(t.id)) continue;
    const done = await chatRepository.finishTurn(t.id, "failed", { error: "interrupted: the platform restarted" });
    if (done)
      await emitChatEvent({ conversationId: t.conversation_id, ownerId: t.owner_id, turnId: t.id, kind: "turn.failed", data: { error: done.error, interrupted: true } });
  }
}

/** Turns whose instance died (other instance or crash) are failed so the conversation is usable again. */
export async function recoverStaleTurns(conversationId: number) {
  for (const t of await chatRepository.staleTurns(conversationId)) {
    if (active.has(t.id)) continue;
    const done = await chatRepository.finishTurn(t.id, "failed", { error: "interrupted: the worker instance stopped" });
    if (done)
      await emitChatEvent({ conversationId: t.conversation_id, ownerId: t.owner_id, turnId: t.id, kind: "turn.failed", data: { error: done.error, interrupted: true } });
  }
}
