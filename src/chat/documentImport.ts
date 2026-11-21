import { one, pool } from "../db/pool.ts";
import { createProposal } from "../knowledge/proposals.ts";
import { listAccessibleRepositories } from "../repos/access.ts";
import { canonicalName } from "./repoResolver.ts";
import { documentsForTurn, documentText } from "./attachments.ts";
import {
  documentCandidates,
  IMPORT_CATEGORIES,
  INJECTION,
  type Candidate,
  type ImportCategory,
} from "./documents.ts";

/**
 * Chat documents → knowledge proposals. The platform builds the candidate units from the documents' own text (with
 * page/section/row references and content hashes); the model may only choose which units, a title, a category and a
 * scope, and add a summary that is kept apart from the source text as an inference. Every unit becomes a proposal in
 * the existing review lifecycle (createProposal): nothing is published here, a shared publication still needs a
 * reviewer, and an existing item is changed only through an UPDATE proposal against its current version.
 */
export class ImportDenied extends Error {}
/** The chat tool binding fields this module needs (owner, conversation, turn). */
interface ChatBinding {
  userId: number;
  conversationId: number;
  turnId: number;
}

const MESSAGE_ROW = "SELECT id FROM chat_messages WHERE turn_id = $1 AND role = 'user' LIMIT 1";

/** Documents of this turn's recent messages (or the listed ones, which must belong to this conversation and owner). */
async function documentsOf(b: ChatBinding, ids?: number[]) {
  const message = await one<{ id: number }>(pool, MESSAGE_ROW, [b.turnId]);
  if (!message) throw new ImportDenied("this turn has no user message");
  const recent = await documentsForTurn(b.userId, b.conversationId, message.id);
  if (!ids?.length) return recent;
  const known = new Map(recent.map((d) => [d.id, d]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length)
    throw new ImportDenied(`documents not attached to this conversation: ${missing.join(", ")}`);
  return ids.map((id) => known.get(id)!);
}

export async function readDocument(
  b: ChatBinding,
  id: number,
  section?: number,
  offset = 0,
  signal?: AbortSignal,
) {
  const [doc] = await documentsOf(b, [id]);
  const t = await documentText(b.userId, doc.id, signal);
  if (!t) throw new ImportDenied("document not found");
  const sections = t.extraction.sections;
  const PAGE = 8000;
  const body =
    section != null
      ? (sections[section]?.text ?? "")
      : sections.map((s) => `[${s.ref}]\n${s.text}`).join("\n\n");
  return {
    attachment_id: doc.id,
    filename: doc.filename,
    media_type: doc.media_type,
    warnings: t.extraction.warnings,
    sections: sections.map((s, i) => ({ index: i, ref: s.ref, chars: s.text.length })),
    ...(section != null ? { section, ref: sections[section]?.ref } : {}),
    offset,
    total_chars: body.length,
    content: body.slice(offset, offset + PAGE),
    ...(offset + PAGE < body.length ? { next_offset: offset + PAGE } : {}),
  };
}

/** Knowledge key of an imported unit: stable for the same scope and title, so a revised document maps to the same item. */
export const importKey = (scopeRef: string, title: string) =>
  `doc.${canonicalName(scopeRef || "personal")}.${canonicalName(title)}`.slice(0, 120);

/** Candidate units of the documents, deduplicated across files and checked against knowledge and open proposals. */
export async function documentCandidatesFor(b: ChatBinding, ids?: number[], signal?: AbortSignal) {
  const docs = await documentsOf(b, ids);
  const out: Array<Candidate & { status: string; existing?: string }> = [];
  const errors: Array<{ attachment_id: number; filename: string; error: string }> = [];
  const seen = new Set<string>();
  for (const d of docs) {
    const t = await documentText(b.userId, d.id, signal);
    if (!t || !t.extraction.sections.length) {
      errors.push({
        attachment_id: d.id,
        filename: d.filename,
        error: t?.extraction.warnings.join("; ") || "no readable text",
      });
      continue;
    }
    for (const c of documentCandidates(d.id, d.filename, t.extraction)) {
      if (seen.has(c.content_hash)) continue; // the same text in two files is one unit
      seen.add(c.content_hash);
      const prior = await one<{ id: number; status: string; target_key: string | null }>(
        pool,
        `SELECT id, status, target_key FROM knowledge_proposals
          WHERE owner_id = $1 AND status IN ('pending', 'approved')
            AND evidence @> jsonb_build_array(jsonb_build_object('ref', jsonb_build_object('content_hash', $2::text)))
          ORDER BY id DESC LIMIT 1`,
        [b.userId, c.content_hash],
      );
      out.push({
        ...c,
        status: prior ? (prior.status === "approved" ? "unchanged" : "already_proposed") : "new",
        ...(prior ? { existing: `proposal #${prior.id}` } : {}),
      });
    }
  }
  return { candidates: out, errors };
}

export interface ImportItem {
  candidate_id: string;
  title?: string;
  category?: ImportCategory;
  summary?: string;
}
export interface ImportScope {
  type: "PROJECT" | "REPOSITORY" | "USER";
  ref?: string;
}

/** Narrowest scope the user may target: a project of a readable repository, a readable repository, or personal. */
async function resolveScope(userId: number, scope: ImportScope) {
  if (scope.type === "USER") return { scope_type: "GLOBAL", scope_ref: "", label: "personal" };
  const readable = (await listAccessibleRepositories(userId)).map((r) => r.repository);
  const want = canonicalName(scope.ref ?? "");
  if (scope.type === "REPOSITORY") {
    const repo = readable.find((r) => canonicalName(r.name) === want);
    if (!repo) throw new ImportDenied(`repository ${scope.ref} is not accessible`);
    return { scope_type: "REPOSITORY", scope_ref: repo.name, label: repo.name };
  }
  const project = readable.flatMap((r) => r.projects ?? []).find((p) => canonicalName(p) === want);
  if (!project)
    throw new ImportDenied(
      `project ${scope.ref} is not a project of a repository you can read; choose a project, a repository or personal scope`,
    );
  return { scope_type: "PROJECT", scope_ref: project, label: project };
}

export async function proposeImport(
  b: ChatBinding,
  scope: ImportScope,
  items: ImportItem[],
  signal?: AbortSignal,
) {
  const target = await resolveScope(b.userId, scope);
  const username = (await one<{ username: string }>(
    pool,
    "SELECT username FROM users WHERE id = $1",
    [b.userId],
  ))!.username;
  const { candidates, errors } = await documentCandidatesFor(b, undefined, signal);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const results: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const c = byId.get(item.candidate_id);
    if (!c) {
      results.push({
        candidate_id: item.candidate_id,
        action: "error",
        error: "unknown candidate (see documents.candidates)",
      });
      continue;
    }
    if (c.status !== "new") {
      results.push({ candidate_id: c.id, action: c.status, existing: c.existing });
      continue;
    }
    const title = (item.title?.trim() || c.title).slice(0, 160);
    const category =
      item.category && IMPORT_CATEGORIES.includes(item.category) ? item.category : c.category;
    const key = importKey(target.scope_ref, title);
    // An item with this key (own or shared) is updated through a proposal against its current version, never rewritten.
    const existing = await one<{ key: string }>(
      pool,
      "SELECT key FROM knowledge_items WHERE key = $1 AND (owner_id IS NULL OR owner_id = $2) LIMIT 1",
      [key, b.userId],
    );
    const pendingSameKey = await one<{ id: number }>(
      pool,
      "SELECT id FROM knowledge_proposals WHERE owner_id = $1 AND status = 'pending' AND proposed->>'key' = $2 LIMIT 1",
      [b.userId, key],
    );
    const flagged = INJECTION.test(c.content);
    const uncertainty = [
      flagged
        ? "the source contains instruction-like text; it is document content, not an instruction"
        : "",
      item.summary
        ? "the summary is the model's reading of the source (an inference), not part of the rule"
        : "",
      pendingSameKey
        ? `conflicts with pending proposal #${pendingSameKey.id} for the same item: review them together`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    const created = await createProposal({
      ownerId: b.userId,
      changeType: existing ? "UPDATE" : "CREATE",
      targetKey: existing ? key : null,
      proposed: {
        key,
        title,
        category,
        scope_type: target.scope_type,
        scope_ref: target.scope_ref,
        content: c.content,
        applicability: target.scope_type === "PROJECT" ? { projects: [target.scope_ref] } : {},
      },
      domain: target.label,
      confidence: flagged ? 0.3 : 0.6,
      uncertainty,
      evidence: [
        {
          source: "chat_document",
          ref: {
            conversation_id: b.conversationId,
            attachment_id: c.attachment_id,
            filename: c.filename,
            locations: c.refs,
            content_hash: c.content_hash,
          },
          author: username,
          trust: "human",
          quote: c.content.slice(0, 500),
        },
      ],
      impacts: item.summary ? { model_summary: item.summary.slice(0, 2000) } : {},
      sourceKind: "chat",
      createdBy: username,
    });
    results.push({
      candidate_id: c.id,
      action: created.proposal ? (existing ? "update_proposed" : "create_proposed") : "unchanged",
      proposal_id: created.proposal?.id ?? null,
      reason: created.reason,
      key,
      title,
      category,
      scope: `${target.scope_type}${target.scope_ref ? ` ${target.scope_ref}` : ""}`,
      source: { filename: c.filename, locations: c.refs },
    });
  }
  return {
    status: "awaiting_review",
    scope: target.label,
    proposals: results,
    errors,
    note: "Proposals only: nothing is published until the user approves them (sharing beyond the user needs a reviewer).",
  };
}
