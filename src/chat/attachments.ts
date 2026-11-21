import { createHash } from "node:crypto";
import { HttpError } from "../http/error.ts";
import { one, pool, q, type Db } from "../db/pool.ts";
import type { CompletionImage } from "../agent/complete.ts";
import { redactSecrets } from "../integrations/redact.ts";
import { extractDocument, sniffDocument, type DocumentType, type Extraction } from "./documents.ts";

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
  /** Images of one message together. */
  messageBytes: 12 * 1024 * 1024,
  documentBytes: Number(process.env.CHAT_DOCUMENT_MAX_BYTES ?? 10 * 1024 * 1024),
  documentsPerMessage: Number(process.env.CHAT_DOCUMENTS_PER_MESSAGE ?? 10),
  /** Everything one message carries (images and documents). */
  totalMessageBytes: 40 * 1024 * 1024,
  /** Unattached uploads one conversation may hold at once (one composer's worth, plus room for a retry). */
  pendingPerConversation: 20,
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
  media_type: ImageType | DocumentType;
  kind: "image" | "document";
  filename: string;
  bytes: number;
}
const META = "id, message_id, media_type, kind, filename, bytes";

/** A display name only (never a path): no directories, control characters or leading dots, at most 120 characters. */
export const safeFilename = (name: unknown) =>
  String(name ?? "")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex -- control characters are removed from a display name on purpose
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);

export async function uploadAttachment(ownerId: number, conversationId: number, body: unknown) {
  const data = (body as { data?: unknown } | null)?.data;
  const filename = safeFilename((body as { filename?: unknown } | null)?.filename);
  if (typeof data !== "string" || !data) throw new HttpError(400, "data (base64 file bytes) is required");
  const max = Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.documentBytes);
  // Reject before decoding: base64 is 4/3 of the bytes.
  if (data.length > Math.ceil(max / 3) * 4 + 4)
    throw new HttpError(413, `file larger than ${max / 1048576} MB`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, "data is not base64");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new HttpError(400, "empty file");
  const image = sniffImage(bytes);
  const document = image ? null : sniffDocument(bytes, filename);
  const mediaType = image ?? document;
  if (!mediaType)
    throw new HttpError(
      415,
      "only PNG, JPEG and WebP images and PDF, DOCX, XLSX, Markdown, text, JSON and CSV documents are accepted",
    );
  if (image && bytes.length > ATTACHMENT_LIMITS.imageBytes)
    throw new HttpError(413, `image larger than ${ATTACHMENT_LIMITS.imageBytes / 1048576} MB`);
  if (document && bytes.length > ATTACHMENT_LIMITS.documentBytes)
    throw new HttpError(413, `document larger than ${ATTACHMENT_LIMITS.documentBytes / 1048576} MB`);
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
    `INSERT INTO chat_attachments (owner_id, conversation_id, media_type, kind, filename, bytes, sha256, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${META}`,
    [
      ownerId,
      conversationId,
      mediaType,
      image ? "image" : "document",
      filename,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
      bytes,
    ],
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
  if (unique.length > ATTACHMENT_LIMITS.imagesPerMessage + ATTACHMENT_LIMITS.documentsPerMessage)
    throw new HttpError(400, "too many attachments in one message");
  const rows = await q<AttachmentMeta>(
    db,
    `UPDATE chat_attachments SET message_id = $4
      WHERE id = ANY($1::bigint[]) AND owner_id = $2 AND conversation_id = $3 AND message_id IS NULL
      RETURNING ${META}`,
    [unique, ownerId, conversationId, messageId],
  );
  // Unknown, foreign, already sent or expired ids: the whole message is refused (same answer for each).
  if (rows.length !== unique.length) throw new HttpError(400, "attachment not found or already used");
  const images = rows.filter((r) => r.kind === "image");
  const documents = rows.filter((r) => r.kind === "document");
  if (images.length > ATTACHMENT_LIMITS.imagesPerMessage)
    throw new HttpError(400, `at most ${ATTACHMENT_LIMITS.imagesPerMessage} images per message`);
  if (documents.length > ATTACHMENT_LIMITS.documentsPerMessage)
    throw new HttpError(400, `at most ${ATTACHMENT_LIMITS.documentsPerMessage} documents per message`);
  if (images.reduce((n, r) => n + r.bytes, 0) > ATTACHMENT_LIMITS.messageBytes)
    throw new HttpError(413, `images larger than ${ATTACHMENT_LIMITS.messageBytes / 1048576} MB in one message`);
  if (rows.reduce((n, r) => n + r.bytes, 0) > ATTACHMENT_LIMITS.totalMessageBytes)
    throw new HttpError(413, `attachments larger than ${ATTACHMENT_LIMITS.totalMessageBytes / 1048576} MB in one message`);
  return rows;
}

/** Bytes of one attachment for its owner, through a conversation the owner still has. */
export async function readAttachment(ownerId: number, id: number) {
  return one<{ media_type: ImageType | DocumentType; kind: string; filename: string; content: Buffer }>(
    pool,
    `SELECT a.media_type, a.kind, a.filename, a.content FROM chat_attachments a
       JOIN chat_conversations c ON c.id = a.conversation_id AND c.owner_id = a.owner_id
      WHERE a.id = $1 AND a.owner_id = $2`,
    [id, ownerId],
  );
}

export function attachmentsOf(messageIds: number[], db: Db = pool) {
  if (!messageIds.length) return Promise.resolve([] as AttachmentMeta[]);
  return q<AttachmentMeta>(
    db,
    `SELECT ${META} FROM chat_attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id`,
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
      WHERE a.owner_id = $2 AND a.conversation_id = $1 AND a.kind = 'image' AND a.message_id IN (
        SELECT id FROM chat_messages WHERE conversation_id = $1 AND role = 'user' AND id <= $3
         ORDER BY id DESC LIMIT $4)`,
    [conversationId, ownerId, currentMessageId, RECENT_USER_MESSAGES],
  );
  if (!latest?.message_id) return [];
  const rows = await q<{ media_type: ImageType; content: Buffer }>(
    pool,
    "SELECT media_type, content FROM chat_attachments WHERE message_id = $1 AND owner_id = $2 AND kind = 'image' ORDER BY id LIMIT $3",
    [latest.message_id, ownerId, ATTACHMENT_LIMITS.imagesPerTurn],
  );
  return rows.map((r) => ({ media_type: r.media_type, data: r.content.toString("base64") }));
}

/**
 * Documents of the recent user messages of a conversation (the current one included), newest first: what "these files"
 * refers to in a request. Metadata only; the text comes from documentText().
 */
export function documentsForTurn(ownerId: number, conversationId: number, currentMessageId: number) {
  return q<AttachmentMeta & { sha256: string }>(
    pool,
    `SELECT ${META}, sha256 FROM chat_attachments
      WHERE owner_id = $2 AND conversation_id = $1 AND kind = 'document' AND message_id IN (
        SELECT id FROM chat_messages WHERE conversation_id = $1 AND role = 'user' AND id <= $3
         ORDER BY id DESC LIMIT $4)
      ORDER BY message_id DESC, id`,
    [conversationId, ownerId, currentMessageId, RECENT_USER_MESSAGES],
  );
}

/**
 * The located text of a document the owner can read (extracted once, cached). Secret-like values are redacted before
 * the text is stored, shown to a model or proposed as knowledge.
 */
export async function documentText(ownerId: number, id: number, signal?: AbortSignal) {
  const row = await one<{
    id: number;
    filename: string;
    media_type: DocumentType;
    sha256: string;
    extraction: Extraction | null;
  }>(
    pool,
    `SELECT a.id, a.filename, a.media_type, a.sha256, a.extraction FROM chat_attachments a
       JOIN chat_conversations c ON c.id = a.conversation_id AND c.owner_id = a.owner_id
      WHERE a.id = $1 AND a.owner_id = $2 AND a.kind = 'document'`,
    [id, ownerId],
  );
  if (!row) return null;
  if (row.extraction) return { ...row, extraction: row.extraction };
  const content = await one<{ content: Buffer }>(pool, "SELECT content FROM chat_attachments WHERE id = $1", [id]);
  const ex = extractDocument(content!.content, row.media_type, signal);
  let redacted = 0;
  const sections = ex.sections.map((s) => {
    const text = redactSecrets(s.text);
    if (text !== s.text) redacted++;
    return { ...s, text };
  });
  const extraction: Extraction = {
    ...ex,
    sections,
    warnings: redacted ? [...ex.warnings, `secret-like values redacted in ${redacted} section(s)`] : ex.warnings,
  };
  await q(pool, "UPDATE chat_attachments SET extraction = $2 WHERE id = $1", [id, JSON.stringify(extraction)]);
  return { ...row, extraction };
}
