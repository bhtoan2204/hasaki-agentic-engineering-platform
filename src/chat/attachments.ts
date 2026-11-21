import { createHash } from "node:crypto";
import { HttpError } from "../http/error.ts";
import { one, pool, q, type Db } from "../db/pool.ts";
import type { CompletionImage } from "../agent/complete.ts";

/**
 * Chat image attachments. An upload is bound to its owner and conversation and stays unreferenced until the message
 * that carries it is posted; unreferenced uploads expire after UNREFERENCED_TTL_HOURS (swept on the next upload, no
 * background job). The type is read from the bytes (PNG, JPEG, WebP signatures), never from the client's claim; sizes
 * are checked before decoding. Bytes are served only through the authenticated route that re-checks conversation
 * ownership, never as a file path or public URL, and are never logged.
 */
export const ATTACHMENT_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  imagesPerMessage: 4,
  messageBytes: 12 * 1024 * 1024,
  /** Unattached uploads one conversation may hold at once (a composer has at most imagesPerMessage). */
  pendingPerConversation: 12,
  unreferencedTtlHours: 24,
  /** Images sent to the model per turn: this message's, else the latest earlier message's within the window. */
  imagesPerTurn: 4,
};

export type ImageType = CompletionImage["media_type"];

/** The image type the bytes actually are, or null. */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP")
    return "image/webp";
  return null;
}

export interface AttachmentMeta {
  id: number;
  message_id: number | null;
  media_type: ImageType;
  bytes: number;
}

export async function uploadAttachment(ownerId: number, conversationId: number, body: unknown) {
  const data = (body as { data?: unknown } | null)?.data;
  if (typeof data !== "string" || !data) throw new HttpError(400, "data (base64 image bytes) is required");
  // Reject before decoding: base64 is 4/3 of the bytes.
  if (data.length > Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4 + 4)
    throw new HttpError(413, `image larger than ${ATTACHMENT_LIMITS.imageBytes / 1048576} MB`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, "data is not base64");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new HttpError(400, "empty image");
  if (bytes.length > ATTACHMENT_LIMITS.imageBytes)
    throw new HttpError(413, `image larger than ${ATTACHMENT_LIMITS.imageBytes / 1048576} MB`);
  const mediaType = sniffImage(bytes);
  if (!mediaType) throw new HttpError(415, "only PNG, JPEG and WebP images are accepted");
  const conversation = await one(
    pool,
    "SELECT id FROM chat_conversations WHERE id = $1 AND owner_id = $2",
    [conversationId, ownerId],
  );
  if (!conversation) throw new HttpError(404, "not found");
  await q(
    pool,
    `DELETE FROM chat_attachments WHERE id IN (
       SELECT id FROM chat_attachments WHERE message_id IS NULL
          AND created_at < now() - make_interval(hours => $1) LIMIT 200)`,
    [ATTACHMENT_LIMITS.unreferencedTtlHours],
  );
  const pending = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM chat_attachments WHERE conversation_id = $1 AND message_id IS NULL",
    [conversationId],
  );
  if ((pending?.n ?? 0) >= ATTACHMENT_LIMITS.pendingPerConversation)
    throw new HttpError(429, "too many unsent images in this conversation; send or remove some first");
  const row = await one<AttachmentMeta>(
    pool,
    `INSERT INTO chat_attachments (owner_id, conversation_id, media_type, bytes, sha256, content)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, message_id, media_type, bytes`,
    [ownerId, conversationId, mediaType, bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes],
  );
  return row!;
}

/** Bind uploads to the message that carries them (same transaction as the message insert). */
export async function attachToMessage(
  db: Db,
  ownerId: number,
  conversationId: number,
  messageId: number,
  ids: number[],
) {
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  if (unique.length > ATTACHMENT_LIMITS.imagesPerMessage)
    throw new HttpError(400, `at most ${ATTACHMENT_LIMITS.imagesPerMessage} images per message`);
  const rows = await q<AttachmentMeta>(
    db,
    `UPDATE chat_attachments SET message_id = $4
      WHERE id = ANY($1::bigint[]) AND owner_id = $2 AND conversation_id = $3 AND message_id IS NULL
      RETURNING id, message_id, media_type, bytes`,
    [unique, ownerId, conversationId, messageId],
  );
  // Unknown, foreign, already sent or expired ids: the whole message is refused (same answer for each).
  if (rows.length !== unique.length) throw new HttpError(400, "attachment not found or already used");
  if (rows.reduce((n, r) => n + r.bytes, 0) > ATTACHMENT_LIMITS.messageBytes)
    throw new HttpError(413, `images larger than ${ATTACHMENT_LIMITS.messageBytes / 1048576} MB in one message`);
  return rows;
}

/** Bytes of one attachment for its owner, through a conversation the owner still has. */
export async function readAttachment(ownerId: number, id: number) {
  return one<{ media_type: ImageType; content: Buffer }>(
    pool,
    `SELECT a.media_type, a.content FROM chat_attachments a
       JOIN chat_conversations c ON c.id = a.conversation_id AND c.owner_id = a.owner_id
      WHERE a.id = $1 AND a.owner_id = $2`,
    [id, ownerId],
  );
}

export function attachmentsOf(messageIds: number[], db: Db = pool) {
  if (!messageIds.length) return Promise.resolve([] as AttachmentMeta[]);
  return q<AttachmentMeta>(
    db,
    "SELECT id, message_id, media_type, bytes FROM chat_attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id",
    [messageIds],
  );
}

/**
 * Images for the model in this turn: the current message's; when it has none, those of the latest of the previous user
 * messages (RECENT_USER_MESSAGES) that carried images (a follow-up about the same screenshot), at most imagesPerTurn.
 */
const RECENT_USER_MESSAGES = 4;
export async function imagesForTurn(
  ownerId: number,
  conversationId: number,
  currentMessageId: number,
): Promise<CompletionImage[]> {
  const latest = await one<{ message_id: number | null }>(
    pool,
    `SELECT max(a.message_id) AS message_id FROM chat_attachments a
      WHERE a.owner_id = $2 AND a.conversation_id = $1 AND a.message_id IN (
        SELECT id FROM chat_messages WHERE conversation_id = $1 AND role = 'user' AND id <= $3
         ORDER BY id DESC LIMIT $4)`,
    [conversationId, ownerId, currentMessageId, RECENT_USER_MESSAGES],
  );
  if (!latest?.message_id) return [];
  const rows = await q<{ media_type: ImageType; content: Buffer }>(
    pool,
    "SELECT media_type, content FROM chat_attachments WHERE message_id = $1 AND owner_id = $2 ORDER BY id LIMIT $3",
    [latest.message_id, ownerId, ATTACHMENT_LIMITS.imagesPerTurn],
  );
  return rows.map((r) => ({ media_type: r.media_type, data: r.content.toString("base64") }));
}
