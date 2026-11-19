import { pool, one, q, type Db } from "../db/pool.ts";
import { hashOf } from "../workflow/definitions.ts";
import type { ContextEntry, ContextPack } from "./pack.ts";

/**
 * Context Delivery Manifest. A resumed provider session already holds the context it was sent; resending the whole
 * pack on every resume only burns input tokens. The manifest records, per provider session, the hash of each delivered
 * pack entry plus the system prompt and developer decisions; a resume then sends only entries that are new or changed.
 *
 * Invalidation is conservative: a different system prompt (policy, tools, skills) means a full resend, and an entry
 * that was delivered but is no longer in the pack (permission revoked, scope narrowed) means the session itself must
 * not continue — its history still contains that content — so a fresh session is rebuilt instead.
 */
export interface DeliveryManifest {
  system_hash: string;
  decisions_hash: string;
  entries: Record<string, string>;
}

export type DeliveryPlan =
  | { mode: "full"; reason: string }
  | { mode: "fresh_session"; reason: string; removed: string[] }
  | { mode: "delta"; send: string[]; unchanged: string[]; decisionsChanged: boolean };

/** Sections whose removal means the old session holds content the step may no longer see. */
const SENSITIVE_SECTIONS: ContextEntry["section"][] = [
  "code",
  "knowledge",
  "repositories",
  "production",
];

export const entryHashes = (pack: ContextPack | undefined) =>
  Object.fromEntries(
    (pack?.entries ?? []).map((e) => [
      e.id,
      hashOf({ body: e.body, trust: e.trust, required: e.required }),
    ]),
  );

/** A knowledge entry id carries its version (knowledge:12:v3); a new version is a change, not a removal. */
const baseId = (id: string) => id.replace(/:v\d+$/, "");

/** Pseudo-entry recording the workspace revision the session's code context was taken from. */
export const WORKSPACE_KEY = "$workspace";

export function planContextDelivery(
  manifest: DeliveryManifest | null,
  current: {
    pack: ContextPack | undefined;
    systemHash: string;
    decisionsHash: string;
    workspaceHash?: string;
  },
): DeliveryPlan {
  if (!manifest) return { mode: "full", reason: "no delivery record for this session" };
  if (manifest.system_hash !== current.systemHash)
    return { mode: "full", reason: "system prompt changed (policy, tools or skills)" };
  const now = entryHashes(current.pack);
  const present = new Set(Object.keys(now).map(baseId));
  const removed = Object.keys(manifest.entries).filter(
    (id) => id !== WORKSPACE_KEY && !present.has(baseId(id)),
  );
  const sensitive = removed.filter((id) => SENSITIVE_SECTIONS.includes(sectionOf(id)));
  if (sensitive.length)
    return {
      mode: "fresh_session",
      reason: "delivered context is no longer authorized or in scope",
      removed: sensitive,
    };
  // The workspace moved on since the session saw the code context: code entries are stale and are resent.
  const workspaceMoved =
    !!current.workspaceHash &&
    !!manifest.entries[WORKSPACE_KEY] &&
    manifest.entries[WORKSPACE_KEY] !== current.workspaceHash;
  const send = Object.keys(now).filter(
    (id) => manifest.entries[id] !== now[id] || (workspaceMoved && sectionOf(id) === "code"),
  );
  const unchanged = Object.keys(now).filter((id) => !send.includes(id));
  return {
    mode: "delta",
    send,
    unchanged,
    decisionsChanged: manifest.decisions_hash !== current.decisionsHash,
  };
}

/** Entry ids encode their source (knowledge:…, repositories, search_code…); unknown ids are treated as sensitive. */
function sectionOf(id: string): ContextEntry["section"] {
  if (id.startsWith("knowledge:")) return "knowledge";
  if (id === "search_code" || id === "find_dependencies" || id.startsWith("code")) return "code";
  if (id.startsWith("repositor")) return "repositories";
  if (id.startsWith("production")) return "production";
  if (id === "request" || id === "mandatory_execution_contract" || id === "verification")
    return "requirements";
  if (id === "developer_decisions" || id === "evidence_summary") return "decisions";
  return "code";
}

export async function latestDelivery(provider: string, sessionId: string, db: Db = pool) {
  return one<DeliveryManifest & { id: number }>(
    db,
    "SELECT id, system_hash, decisions_hash, entries FROM agent_context_deliveries WHERE provider = $1 AND session_id = $2 ORDER BY id DESC LIMIT 1",
    [provider, sessionId],
  );
}

/** After a turn: the session now holds the earlier manifest plus what this turn sent (a full send replaces it). */
export async function recordDelivery(
  x: {
    provider: string;
    sessionId: string;
    attemptId: number | null;
    systemHash: string;
    decisionsHash: string;
    pack: ContextPack | undefined;
    mode: "full" | "delta";
    previous: DeliveryManifest | null;
    workspaceHash?: string;
  },
  db: Db = pool,
) {
  const entries = {
    ...(x.mode === "delta" && x.previous ? x.previous.entries : {}),
    ...entryHashes(x.pack),
    ...(x.workspaceHash ? { [WORKSPACE_KEY]: x.workspaceHash } : {}),
  };
  await q(
    db,
    `INSERT INTO agent_context_deliveries (provider, session_id, attempt_id, system_hash, decisions_hash, entries, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      x.provider,
      x.sessionId,
      x.attemptId,
      x.systemHash,
      x.decisionsHash,
      JSON.stringify(entries),
      x.mode,
    ],
  );
}
