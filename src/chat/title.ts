import { completeForRun } from "../agent/complete.ts";
import { parseAgentProvider } from "../agent/provider.ts";
import { background } from "../workflow/background.ts";
import { admitProvider } from "./admission.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";
import { LIMITS } from "./policy.ts";
import { whenNoTurnRuns, whenTurnSettles } from "./turnActivity.ts";
import type { ConversationRow, TitleSource } from "./types.ts";
import { log } from "../logging.ts";

const TITLE_TIMEOUT_MS = 20_000;

class NoTitleInTests extends Error {
  constructor() {
    super("no real title completion in tests (setChatTitleComplete)");
  }
}

/**
 * A generated title is a nicety; the conversation already shows its deterministic fallback title. It must never
 * compete with the answers people are waiting for: each title is one more provider process (the Claude CLI alone is
 * ~0.3 s of CPU to start), and eight new conversations used to start eight of them next to their eight first turns.
 */
export const TITLE_SCHEDULING = {
  /**
   * Titles generated at once on this instance (CHAT_TITLE_CONCURRENCY). A real title takes 3–4 s, mostly waiting on
   * the model: one at a time left the 8th of eight new conversations untitled for ~30 s; two bound the extra CLI
   * processes while halving that.
   */
  concurrency: Math.max(1, Math.floor(Number(process.env.CHAT_TITLE_CONCURRENCY ?? 2)) || 1),
  /** Titles waiting at most; beyond that a new conversation keeps its fallback title (it can be regenerated). */
  maxQueued: 200,
  /** A title waits for its conversation's first turn at most as long as a turn may run. */
  firstTurnWaitMs: LIMITS.turnTimeoutMs,
  /** Then it yields to other running turns for at most this long, so a busy instance still titles eventually. */
  yieldMs: 30_000,
};

/** Test seam — inject a tools-free completion runner without calling real providers. */
let completeSeam:
  | ((
      prompt: string,
      opts: { provider: string; model: string | null; effort: string | null },
    ) => Promise<string>)
  | undefined;

export function setChatTitleComplete(
  fn:
    | ((
        prompt: string,
        opts: { provider: string; model: string | null; effort: string | null },
      ) => Promise<string>)
    | undefined,
) {
  completeSeam = fn;
}

/** Short deterministic title from the first user message (never blocks on a model). */
export function fallbackTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length <= 7) return cleaned.slice(0, 72);
  return words.slice(0, 6).join(" ").slice(0, 72);
}

/** Normalize model output into a safe single-line title. */
export function sanitizeGeneratedTitle(raw: string, fallback: string): string {
  let t = raw
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。!?…]+$/g, "")
    .trim();
  // Drop common boilerplate prefixes the model sometimes adds.
  t = t.replace(/^(title|tiêu đề)\s*[:：-]\s*/i, "").trim();
  if (!t) return fallback.slice(0, 80);
  const words = t.split(" ").filter(Boolean);
  if (words.length > 12) t = words.slice(0, 8).join(" ");
  return t.slice(0, 80);
}

function titlePrompt(userMessage: string): string {
  return [
    "Generate a short conversation title that summarizes the user's request.",
    "Rules:",
    "- 3 to 7 words when the language uses spaces; otherwise keep it brief",
    "- Use the same language as the user message",
    "- No quotation marks, no trailing punctuation",
    '- Do not start with "Chat", "Conversation", "Hội thoại", or "Title"',
    "- Output ONLY the title text",
    "",
    "User message:",
    userMessage.slice(0, 1200),
  ].join("\n");
}

async function runTitleCompletion(
  prompt: string,
  opts: { provider: string; model: string | null; effort: string | null },
): Promise<string> {
  if (completeSeam) return completeSeam(prompt, opts);
  // Tests keep the developer's HOME, where the provider CLIs are logged in: a title would be a real model call on
  // their account. Suites must inject a completion (setChatTitleComplete); the fallback title stays otherwise.
  if (process.env.PLATFORM_TEST === "1" && process.env.CHAT_TITLE_REAL_IN_TESTS !== "1")
    throw new NoTitleInTests();
  const signal = AbortSignal.timeout(TITLE_TIMEOUT_MS);
  const completion = await completeForRun(null, prompt, signal, null, {
    provider: opts.provider as never,
    model: opts.model,
    reasoning_effort: opts.effort ?? "low",
  });
  return completion.text;
}

/**
 * Apply a generated title only when the conversation has not been manually renamed
 * and has not already received a generated title (unless force).
 */
export async function applyGeneratedTitle(
  conversationId: number,
  ownerId: number,
  title: string,
  force = false,
) {
  const allowed: TitleSource[] = force ? ["none", "fallback", "generated"] : ["none", "fallback"];
  const row = await chatRepository.updateTitleIfSource(
    conversationId,
    ownerId,
    title,
    "generated",
    allowed,
  );
  if (!row) return null;
  await emitChatEvent({
    conversationId,
    ownerId,
    turnId: null,
    kind: "conversation.updated",
    data: { fields: ["title"], title_source: "generated" },
  });
  return row;
}

export async function generateConversationTitle(
  conversationId: number,
  ownerId: number,
  opts: { force?: boolean; afterTurn?: number | null } = {},
): Promise<ConversationRow | null> {
  const conversation = await chatRepository.getConversation(conversationId, ownerId);
  if (!conversation) return null;
  if (conversation.title_source === "manual") return conversation;
  if (!opts.force && conversation.title_source === "generated") return conversation;

  const first = await chatRepository.firstUserMessage(conversationId);
  const seed = first?.content?.trim() || conversation.title.trim();
  if (!seed) return conversation;
  const fallback = fallbackTitle(seed) || conversation.title || "Chat";

  try {
    const target = await titleProvider(conversation, opts.afterTurn ?? null);
    const raw = await runTitleCompletion(titlePrompt(seed), {
      provider: target.provider,
      model: target.model,
      effort: "low",
    });
    const cleaned = sanitizeGeneratedTitle(raw, fallback);
    return (
      (await applyGeneratedTitle(conversationId, ownerId, cleaned, !!opts.force)) ?? conversation
    );
  } catch (e) {
    if (!(e instanceof NoTitleInTests))
      log.error(`chat title ${conversationId}: ${(e as Error)?.message ?? e}`);
    // Keep/ensure fallback — never leave the conversation untitled after a failed generate.
    if (conversation.title_source === "none" || !conversation.title.trim()) {
      const row = await chatRepository.updateTitleIfSource(
        conversationId,
        ownerId,
        fallback,
        "fallback",
        ["none", "fallback"],
      );
      return row ?? conversation;
    }
    return conversation;
  }
}

/**
 * The provider that just answered the conversation's first turn is known to work: reuse it (no readiness probe).
 * Otherwise — the turn failed, or this is an explicit regeneration — admit one like a turn does.
 */
async function titleProvider(conversation: ConversationRow, afterTurn: number | null) {
  const turn = afterTurn ? await chatRepository.getTurn(afterTurn) : null;
  const answered =
    turn?.status === "completed" ? parseAgentProvider(turn.effective_provider) : null;
  if (answered)
    return {
      provider: answered,
      // The conversation's model only applies to its own provider (as in admission).
      model: answered === conversation.provider ? conversation.model : null,
    };
  return admitProvider({
    strategy: conversation.provider_strategy === "auto" ? "auto" : "manual",
    preferred: conversation.provider,
    model: conversation.model,
    effort: "low",
    fallbackEnabled: conversation.fallback_enabled || conversation.provider_strategy === "auto",
  });
}

// ---------------------------------------------------------------- scheduling
type TitleJob = { ownerId: number; force: boolean; afterTurn: number | null; started: boolean };
/** Scheduled and not yet finished, per conversation (at most one; a forced request upgrades a waiting one). */
const jobs = new Map<number, TitleJob>();
let active = 0;
const slotWaiters: Array<() => void> = [];
/** Wakes a job that is still waiting for its first turn (an explicit regeneration skips the wait). */
const skipWait = new Map<number, () => void>();

async function slot() {
  if (active < TITLE_SCHEDULING.concurrency) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
}
function freeSlot() {
  const next = slotWaiters.shift();
  if (next)
    next(); // the slot passes on
  else active--;
}

/**
 * Generates the title in the background, never in front of a turn: after the conversation's first turn
 * (`afterTurn`) settles, in one of TITLE_SCHEDULING.concurrency slots, and once no other turn runs on this instance
 * (bounded by yieldMs). An explicit regeneration (`force`) skips both waits but still takes a slot. Concurrent
 * schedules of one conversation are deduplicated; a manual rename always wins (applyGeneratedTitle).
 */
export function scheduleTitleGeneration(
  conversationId: number,
  ownerId: number,
  opts: { force?: boolean; afterTurn?: number } = {},
) {
  const existing = jobs.get(conversationId);
  if (existing && !existing.started) {
    if (opts.force) {
      existing.force = true;
      skipWait.get(conversationId)?.();
    }
    return;
  }
  if (existing && !opts.force) return;
  if (jobs.size >= TITLE_SCHEDULING.maxQueued) {
    log.error(
      `chat title ${conversationId}: ${jobs.size} titles waiting; keeping the fallback title`,
    );
    return;
  }
  const job: TitleJob = {
    ownerId,
    force: !!opts.force,
    afterTurn: opts.afterTurn ?? null,
    started: false,
  };
  jobs.set(conversationId, job);
  // A wait that an explicit regeneration of the same conversation cuts short.
  const unlessForced = (wait: Promise<void>) =>
    job.force
      ? Promise.resolve()
      : Promise.race([wait, new Promise<void>((resolve) => skipWait.set(conversationId, resolve))]);
  background(`chat title ${conversationId}`, async () => {
    try {
      if (job.afterTurn)
        await unlessForced(whenTurnSettles(job.afterTurn, TITLE_SCHEDULING.firstTurnWaitMs));
      await slot();
      try {
        await unlessForced(whenNoTurnRuns(TITLE_SCHEDULING.yieldMs));
        job.started = true;
        await generateConversationTitle(conversationId, job.ownerId, {
          force: job.force,
          afterTurn: job.afterTurn,
        });
      } finally {
        freeSlot();
      }
    } finally {
      skipWait.delete(conversationId);
      if (jobs.get(conversationId) === job) jobs.delete(conversationId);
    }
  });
}

/** Titles scheduled and not finished yet (waiting or generating). */
export function titleBacklog() {
  return jobs.size;
}
