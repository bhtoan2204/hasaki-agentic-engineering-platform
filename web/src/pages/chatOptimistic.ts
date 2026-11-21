/**
 * Optimistic chat messages: shown the moment the user sends, keyed by the same client_message_id the server stores on
 * the turn. A pending message disappears exactly when a persisted turn carries its id, so SSE events, polling and
 * reconnects can never show it twice; a failed send keeps its text for a retry with the same id (idempotent server-side).
 */
export interface PendingMessage {
  cid: string;
  conversationId: number;
  content: string;
  /** Images chosen in the composer: object URLs for the bubble, files until uploaded, ids once uploaded (a retry reuses them). */
  images?: Array<{ url: string; file: File }>;
  documents?: File[];
  attachmentIds?: number[];
  status: "sending" | "failed";
  error?: string;
  at: string;
}

export function reconcilePending(
  pending: PendingMessage[],
  conversationId: number | null,
  turns: Array<{ client_message_id?: string | null }> | undefined,
): PendingMessage[] {
  const persisted = new Set((turns ?? []).map((t) => t.client_message_id).filter(Boolean));
  return pending.filter((p) => p.conversationId === conversationId && !persisted.has(p.cid));
}

export const markPending = (
  pending: PendingMessage[],
  cid: string,
  patch: Partial<PendingMessage>,
): PendingMessage[] => pending.map((p) => (p.cid === cid ? { ...p, ...patch } : p));
