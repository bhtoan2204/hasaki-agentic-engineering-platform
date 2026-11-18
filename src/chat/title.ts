import { completeForRun } from "../agent/complete.ts";
import { background } from "../workflow/background.ts";
import { admitProvider } from "./admission.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";
import type { ConversationRow, TitleSource } from "./types.ts";

const TITLE_TIMEOUT_MS = 20_000;
const titling = new Set<number>();

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
  opts: { force?: boolean } = {},
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
    const admitted = await admitProvider({
      strategy: conversation.provider_strategy === "auto" ? "auto" : "manual",
      preferred: conversation.provider,
      model: conversation.model,
      effort: "low",
      fallbackEnabled: conversation.fallback_enabled || conversation.provider_strategy === "auto",
    });
    const raw = await runTitleCompletion(titlePrompt(seed), {
      provider: admitted.provider,
      model: admitted.model,
      effort: "low",
    });
    const cleaned = sanitizeGeneratedTitle(raw, fallback);
    return (
      (await applyGeneratedTitle(conversationId, ownerId, cleaned, !!opts.force)) ?? conversation
    );
  } catch (e) {
    console.error(`chat title ${conversationId}: ${(e as Error)?.message ?? e}`);
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

/** Fire-and-forget; does not create workflow runs. Dedupes concurrent schedules per conversation. */
export function scheduleTitleGeneration(
  conversationId: number,
  ownerId: number,
  opts: { force?: boolean } = {},
) {
  if (titling.has(conversationId) && !opts.force) return;
  titling.add(conversationId);
  background(`chat title ${conversationId}`, async () => {
    try {
      await generateConversationTitle(conversationId, ownerId, opts);
    } finally {
      titling.delete(conversationId);
    }
  });
}

/** Exported for unit tests. */
export function _titlingBusy() {
  return titling.size;
}
