import type { CompletionStreamEvent } from "../agent/completionStream.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";
import { ChatTurnError, chatFailure, type ChatFailure } from "./failures.ts";
import type { TraceItem } from "./types.ts";

const FENCE = "```chat-tool";
const ESCALATE = "```chat-escalate";
const CALLS = '{"calls"';
const MAX_DRAFT = 100_000;
const MAX_REASONING = 32_000;
const MAX_TRACE = 200;

/**
 * The part of a partial answer that may be shown: a tool-call block (fenced or bare `{"calls"` JSON) is a request to the
 * platform, not answer text, and a trailing prefix of the fence is held back until it is known not to open one.
 */
export function visibleAnswer(text: string, toolsEnabled: boolean) {
  // A direct answer may ask to escalate to tools instead of answering: that marker is never answer text.
  const esc = text.indexOf(ESCALATE);
  if (esc >= 0) return text.slice(0, esc).trimEnd();
  if (!toolsEnabled) {
    for (let k = Math.min(ESCALATE.length - 1, text.length); k > 0; k--)
      if (ESCALATE.startsWith(text.slice(-k))) return text.slice(0, -k);
    return text;
  }
  const head = text.trimStart().replace(/\s+/g, "");
  if (head && (head.startsWith(CALLS) || CALLS.startsWith(head))) return "";
  const at = text.indexOf(FENCE);
  if (at >= 0) return text.slice(0, at).trimEnd();
  for (let k = Math.min(FENCE.length - 1, text.length); k > 0; k--)
    if (FENCE.startsWith(text.slice(-k))) return text.slice(0, -k);
  return text;
}

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

/**
 * Coalesces one turn's provider stream into bounded `chat_events` (at most one batch per `flushMs`, the first one at
 * once, never one row per token) and checkpoints the draft and trace on the turn row, so a reconnecting client and a stopped turn see the same
 * text. Emission failures are logged and never fail the provider call.
 */
export class TurnStream {
  private sent = "";
  private visible = "";
  private reasoning: string[] = [];
  private activities: string[] = [];
  private reasoningChars = 0;
  private key = { attempt: 0, step: 0 };
  private tools = false;
  private timer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastCheckpoint = 0;
  private lastEmit = 0;
  readonly trace: TraceItem[] = [];
  private ids: { conversationId: number; ownerId: number; turnId: number };
  private opts: { flushMs?: number; checkpointMs?: number };

  constructor(
    ids: { conversationId: number; ownerId: number; turnId: number },
    opts: { flushMs?: number; checkpointMs?: number } = {},
  ) {
    this.ids = ids;
    this.opts = opts;
  }

  /** A new provider call: its text replaces the previous call's draft. */
  async begin(attempt: number, step: number, toolsEnabled: boolean) {
    await this.flush();
    this.key = { attempt, step };
    this.tools = toolsEnabled;
    this.sent = "";
    this.visible = "";
  }

  /** The text streamed for the current call so far (what a stop or failure keeps). */
  get draft() {
    return this.visible;
  }

  readonly onEvent = (e: CompletionStreamEvent) => {
    if (e.type === "text") this.visible = visibleAnswer(e.text, this.tools).slice(0, MAX_DRAFT);
    else if (e.type === "reasoning") {
      const room = MAX_REASONING - this.reasoningChars;
      if (room <= 0 || !e.delta) return;
      const text = e.delta.slice(0, room);
      this.reasoningChars += text.length;
      this.reasoning.push(text);
      const last = this.trace.at(-1);
      if (last?.k === "reasoning") last.text += text;
      else this.push({ k: "reasoning", text });
    } else if (e.type === "activity") {
      const last = this.trace.at(-1);
      if (last?.k === "activity" && last.label === e.label) return;
      this.activities.push(e.label);
      this.push({ k: "activity", label: e.label });
    } else return;
    // Throttled on the leading edge: the first update after a quiet period goes out on the next tick (time to first
    // visible text is the provider's, not the flush interval), later ones at most once per flushMs.
    this.timer ??= setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(0, this.lastEmit + (this.opts.flushMs ?? 200) - Date.now()),
    );
  };

  tool(id: number, tool: string, status: string, ms?: number) {
    const found = this.trace.find((t) => t.k === "tool" && t.id === id);
    if (found && found.k === "tool")
      Object.assign(found, { status, ...(ms != null ? { ms } : {}) });
    else this.push({ k: "tool", id, tool, status });
  }

  knowledge(ref: {
    key: string;
    version: number;
    title: string;
    disclosure?: string;
    owner: string;
  }) {
    if (
      this.trace.some((t) => t.k === "knowledge" && t.key === ref.key && t.version === ref.version)
    )
      return;
    this.push({
      k: "knowledge",
      key: ref.key,
      version: ref.version,
      title: ref.title,
      disclosure: ref.disclosure ?? "read",
      owner: ref.owner,
    });
  }

  private push(item: TraceItem) {
    if (this.trace.length < MAX_TRACE) this.trace.push(item);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.enqueue(() => this.emit());
  }

  private enqueue(fn: () => Promise<void>) {
    this.chain = this.chain
      .then(fn)
      .catch((e) => console.error("chat stream:", (e as Error).message));
    return this.chain;
  }

  private async emit() {
    const reasoning = this.reasoning.splice(0).join("");
    const activities = this.activities.splice(0);
    // Only an actual emission starts the throttle window (begin() flushes an empty batch).
    if (reasoning || activities.length || this.visible !== this.sent) this.lastEmit = Date.now();
    if (reasoning)
      await emitChatEvent({
        ...this.ids,
        kind: "reasoning.delta",
        data: { ...this.key, text: reasoning },
      });
    for (const label of activities)
      await emitChatEvent({ ...this.ids, kind: "provider.activity", data: { ...this.key, label } });
    if (this.visible !== this.sent) {
      const offset = commonPrefix(this.sent, this.visible);
      const text = this.visible.slice(offset);
      this.sent = this.visible;
      await emitChatEvent({
        ...this.ids,
        kind: "response.delta",
        data: { ...this.key, offset, text },
      });
    }
    const wait = (this.opts.checkpointMs ?? 1000) - (Date.now() - this.lastCheckpoint);
    if (wait <= 0) await this.checkpoint();
    else
      this.checkpointTimer ??= setTimeout(() => {
        this.checkpointTimer = null;
        void this.enqueue(() => this.checkpoint());
      }, wait);
  }

  private async checkpoint(draft = this.visible) {
    this.lastCheckpoint = Date.now();
    await chatRepository.setStream(this.ids.turnId, draft, this.trace);
  }

  /** Terminal: the stored answer (or partial) supersedes the draft and the live delta events. */
  async close() {
    await this.flush();
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    await this.enqueue(() => this.checkpoint(""));
    await chatRepository.dropStreamEvents(this.ids.turnId);
  }
}

/**
 * Stops a provider call that shows no sign of life: nothing within `firstMs`, or silence longer than `idleMs` after
 * that. The failure is fallback-eligible like an unavailable provider, so AUTO moves on instead of waiting.
 */
export function stallGuard(firstMs: number, idleMs: number) {
  const ac = new AbortController();
  let failure: ChatFailure | null = null;
  let timer: NodeJS.Timeout | null = null;
  const arm = (ms: number, code: "FIRST_RESPONSE_TIMEOUT" | "IDLE_TIMEOUT", message: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      failure = chatFailure(code, message);
      ac.abort(new ChatTurnError(failure));
    }, ms);
    timer.unref?.();
  };
  arm(firstMs, "FIRST_RESPONSE_TIMEOUT", `the provider did not respond within ${firstMs / 1000}s`);
  return {
    signal: ac.signal,
    touch: () =>
      !ac.signal.aborted &&
      arm(idleMs, "IDLE_TIMEOUT", `the provider went silent for ${idleMs / 1000}s`),
    get failure() {
      return failure;
    },
    dispose: () => timer && clearTimeout(timer),
  };
}
