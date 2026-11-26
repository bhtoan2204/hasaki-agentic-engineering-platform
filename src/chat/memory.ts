import { createHash } from "node:crypto";
import { pool, q } from "../db/pool.ts";
import { knowledge } from "../knowledge/service.ts";
import { createProposal } from "../knowledge/proposals.ts";
import { looksSecret } from "../knowledge/importer.ts";
import { fusedSearchOrder, scoreKnowledge } from "../context/plan.ts";
import { semanticRanksByKey } from "../retrieval/semantic.ts";
import { redactPii } from "../integrations/redact.ts";
import { chatRepository } from "./repository.ts";
import { noteKnowledgeUsage } from "../knowledge/agingUsage.ts";
import { restoreProcedureIfArchived } from "../knowledge/aging.ts";
import { ignoreError } from "../ignoreError.ts";
import { emitChatEvent } from "./events.ts";

/**
 * Chat memory on the knowledge registry (category `task_memory`, owner-private, key `memory.chat.<hash>`): no second
 * store, no model call. Only what the platform can stand behind is learned:
 *  - preference / correction: an explicit statement the user typed ("remember …", "from now on …", "không phải … mà …");
 *  - procedure: an integration operation the platform executed successfully (tool, target, payload field names — never
 *    values);
 *  - business rule ("rule: …"): becomes a knowledge proposal for the existing review flow, never memory directly.
 * Model output is never learned. Text that looks like a credential or carries personal data is dropped.
 * Workflow context ignores these items (no repository provenance), so they only reach chat prompts.
 */
export const CHAT_MEMORY_PREFIX = "memory.chat.";
const MAX_RECALL = 5;

export type ChatMemoryKind = "preference" | "correction" | "procedure";
export interface MemoryCandidate {
  kind: ChatMemoryKind | "business_rule";
  claim: string;
}

const PREFERENCE =
  /^(?:please\s+)?(?:remember(?:\s+that)?|note that|from now on|always|never|do not|don't)\b[\s,:]*|^(?:hãy\s+)?nhớ(?:\s+(?:là|rằng))?[\s,:]+|^từ\s+(?:giờ|nay|bây giờ)(?:\s+trở đi)?[\s,:]+|^(?:luôn luôn|luôn|đừng bao giờ|không bao giờ|đừng)\s+/i;
const CORRECTION =
  /^(?:no|actually|correction)[,:]\s*|^(?:không phải|sai rồi|nhầm rồi|thực ra)[,:]?\s*/i;
const RULE = /^(?:business rule|rule|quy tắc|quy định nghiệp vụ|nghiệp vụ)\s*[:：]\s*/i;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[.!\s]+$/, "")
    .trim();
export const memoryKey = (claim: string) =>
  CHAT_MEMORY_PREFIX + createHash("sha256").update(norm(claim)).digest("hex").slice(0, 24);

/** Sensitive or unverifiable text is never stored: credentials, personal data, long identifiers. */
export function unsafeToStore(text: string) {
  return (
    looksSecret(text) ||
    redactPii(text) !== text ||
    /\b\d{9,}\b/.test(text) ||
    // Conservative: anything about credentials, or a long token-like string, is not memory.
    /\b(password|passwd|token|secret|api[\s_-]?key|cookie|bearer|mật khẩu)\b/i.test(text) ||
    /(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}/.test(text)
  );
}

/** Deterministic candidates from one user message (pure). */
export function memoryCandidates(message: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  for (const raw of message.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < 12 || s.length > 500 || s.endsWith("?")) continue;
    if (RULE.test(s)) out.push({ kind: "business_rule", claim: s.replace(RULE, "").trim() });
    else if (CORRECTION.test(s) && s.replace(CORRECTION, "").length >= 12)
      out.push({ kind: "correction", claim: s });
    else if (PREFERENCE.test(s)) out.push({ kind: "preference", claim: s });
  }
  return out.filter((c) => c.claim.length >= 8 && !unsafeToStore(c.claim));
}

async function remember(
  ownerId: number,
  kind: ChatMemoryKind,
  claim: string,
  source: Record<string, unknown>,
): Promise<"stored" | "reinforced" | "skipped"> {
  if (unsafeToStore(claim)) return "skipped";
  const key = memoryKey(claim);
  const existing = await knowledge.get(key, undefined, ownerId);
  if (existing) {
    const meta = (existing.versions?.[0]?.metadata ?? {}) as { memory?: Record<string, unknown> };
    const m = meta.memory ?? {};
    await knowledge.update(
      key,
      {
        metadata: {
          ...meta,
          memory: { ...m, count: Number(m.count ?? 1) + 1, last_seen_at: new Date().toISOString() },
        },
        change_note: "seen again",
      },
      ownerId,
    );
    // A procedure that worked again after it was archived for failing comes back by itself, unpinned.
    if (kind === "procedure")
      await restoreProcedureIfArchived(ownerId, key).catch(ignoreError("chat.procedure_restore"));
    return "reinforced";
  }
  await knowledge.create({
    key,
    category: "task_memory",
    scope_type: "GLOBAL",
    title: `${kind === "procedure" ? "Verified procedure" : kind === "correction" ? "Correction" : "Preference"}: ${claim.slice(0, 80)}`,
    content: claim,
    enabled: true,
    metadata: {
      load: "on_demand",
      description: claim.slice(0, 200),
      memory: {
        source: "chat",
        kind,
        trust: kind === "procedure" ? "verified" : "human",
        count: 1,
        extracted_at: new Date().toISOString(),
        ...source,
      },
    },
    created_by: "chat learning",
    change_note: kind === "procedure" ? "verified chat operation" : "stated by the user in chat",
    ownerId,
  });
  return "stored";
}

/** After a completed turn (background, never on the response path): learn from the user's own message. */
export async function learnFromTurn(turnId: number) {
  const turn = await chatRepository.getTurn(turnId);
  if (!turn || turn.status !== "completed") return { stored: 0, proposals: 0 };
  const user = await chatRepository.messageOfTurn(turnId, "user");
  if (!user) return { stored: 0, proposals: 0 };
  let stored = 0;
  let proposals = 0;
  for (const c of memoryCandidates(user.content)) {
    const source = { conversation_id: turn.conversation_id, message_id: user.id };
    if (c.kind === "business_rule") {
      const r = await createProposal({
        ownerId: null,
        changeType: "CREATE",
        proposed: {
          title: c.claim.slice(0, 80),
          category: "business_rule",
          scope_type: "GLOBAL",
          content: c.claim,
        },
        confidence: 0.5,
        uncertainty: "stated in chat by one user; needs review",
        evidence: [
          {
            source: "chat",
            ref: source,
            author: `user:${turn.owner_id}`,
            trust: "human",
            quote: c.claim,
          },
        ],
        sourceKind: "chat",
        createdBy: "chat learning",
      });
      if (r.created) proposals++;
      continue;
    }
    if ((await remember(turn.owner_id, c.kind, c.claim, source)) !== "skipped") stored++;
  }
  if (stored || proposals)
    await emitChatEvent({
      conversationId: turn.conversation_id,
      ownerId: turn.owner_id,
      turnId,
      kind: "memory.learned",
      data: { stored, proposals },
    });
  return { stored, proposals };
}

/**
 * A verified operation teaches its procedure: tool, target (service host/path or topic), the auth profile name, the
 * payload field names and how the outcome was read back. Never values, tokens or credentials.
 */
export async function learnProcedure(op: {
  owner_id: number;
  conversation_id: number;
  id: number;
  tool: string;
  target: Record<string, unknown>;
  arguments: Record<string, unknown>;
  verification?: { verified: boolean; tool: string } | null;
}) {
  const value = op.arguments.value ?? op.arguments.body;
  let fields: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) fields = Object.keys(value);
  else if (typeof value === "string")
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        fields = Object.keys(parsed);
    } catch {
      /* not JSON: no shape to learn */
    }
  const target = Object.entries(op.target)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const auth = typeof op.arguments.auth === "string" ? `; auth profile ${op.arguments.auth}` : "";
  const check = op.verification?.verified
    ? `; outcome verified by reading back with ${op.verification.tool}`
    : "";
  const claim = `${op.tool} to ${target} works from chat${auth}${fields.length ? `; payload fields: ${fields.slice(0, 40).join(", ")}` : ""}${check}.`;
  return remember(op.owner_id, "procedure", claim, {
    conversation_id: op.conversation_id,
    operation_id: op.id,
  });
}

export const chatMemories = (ownerId: number) =>
  q<{
    id: number;
    key: string;
    title: string;
    enabled: boolean;
    version: number;
    content: string;
    metadata: Record<string, unknown>;
    updated_at: string;
  }>(
    pool,
    `SELECT i.id, i.key, i.title, i.enabled, v.version, v.content, v.metadata, i.updated_at
       FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
      WHERE i.owner_id = $1 AND i.category = 'task_memory' AND i.key LIKE $2
      ORDER BY i.updated_at DESC LIMIT 200`,
    [ownerId, `${CHAT_MEMORY_PREFIX}%`],
  );

/** Relevant enabled memories of this owner for a message (lexical relevance; no model call). */
export async function recallMemories(ownerId: number, message: string) {
  const rows = (await chatMemories(ownerId)).filter((r) => r.enabled);
  const scored = rows.map((r) => ({
    k: r,
    s: scoreKnowledge({ ...r, category: "task_memory" }, message, "agent").score,
  }));
  let ranked = scored
    .filter(
      (x) =>
        x.s > 0 || (x.k.metadata as { memory?: { kind?: string } }).memory?.kind === "preference",
    )
    .sort((a, b) => b.s - a.s);
  const semantic = await semanticRanksByKey(ownerId, message, rows, ["chat_memory"]);
  if (semantic) ranked = fusedSearchOrder(scored, ranked, semantic);
  const recalled = ranked.slice(0, MAX_RECALL);
  noteKnowledgeUsage(recalled.map(({ k }) => k.id));
  return recalled.map(({ k: r }) => ({
    key: r.key,
    kind: String((r.metadata as { memory?: { kind?: string } }).memory?.kind ?? ""),
    text: r.content,
  }));
}
