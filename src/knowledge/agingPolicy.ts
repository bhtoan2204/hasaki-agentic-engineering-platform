import type { MemoryAgingAction, MemoryAgingPolicy } from "../runtimeMetrics.ts";

/**
 * Task memory aging policies as pure functions (docs/architecture/memory-aging.md): data in, decision out, no I/O,
 * no clock, no model. knowledge/aging.ts loads the data, calls these, applies the decisions and writes the audit.
 */

const DAY = 86_400_000;
const days = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);

export type MemoryKind = "facts" | "conclusions" | "lesson" | "chat_preference" | "chat_procedure";
export type AgingState = "active" | "dormant" | "archived" | "superseded" | "restored";

export interface AgingThresholds {
  unknownDays: number;
  unapprovedDays: number;
  dormantDays: number;
  disuseDays: number;
  approvedDormantDays: number;
  approvedDisuseDays: number;
  lessonDormantDays: number;
  lessonDisuseDays: number;
  disputedDays: number;
  capPerRepo: number;
  /** 0 = archived items are never deleted. */
  purgeDays: number;
}
export const DEFAULT_THRESHOLDS: AgingThresholds = {
  unknownDays: 14,
  unapprovedDays: 30,
  dormantDays: 60,
  disuseDays: 120,
  approvedDormantDays: 120,
  approvedDisuseDays: 240,
  lessonDormantDays: 90,
  lessonDisuseDays: 180,
  disputedDays: 30,
  capPerRepo: 50,
  purgeDays: 90,
};

/** Raw settings (env strings) to thresholds: a blank or invalid value falls back to the documented default. */
export function thresholdsFrom(raw: Partial<Record<keyof AgingThresholds, string | undefined>>) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(out) as Array<keyof AgingThresholds>) {
    const v = raw[k];
    if (v === undefined || v.trim() === "") continue;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && (n > 0 || k === "purgeDays")) out[k] = n;
  }
  return out;
}

export interface AgingItem {
  id: number;
  key: string;
  ownerId: number | null;
  repo: string;
  kind: MemoryKind;
  enabled: boolean;
  /** The version the decision was made on: applying it is refused when the item changed meanwhile. */
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  /** metadata.memory.trust: verified | unverified | approved | rejected | human */
  trust: string | null;
  /** metadata.memory of the current version. */
  memory: Record<string, unknown>;
  state: AgingState;
  /** A person restored it: automatic aging leaves it alone. */
  pinned: boolean;
  /** When the current state was set (restore and purge windows count from here). */
  stateAt: Date | null;
  policy: string | null;
  unknownSince: Date | null;
  unknownCode: string | null;
  lastLoadedAt: Date | null;
}

export interface Decision {
  action: MemoryAgingAction;
  policy: MemoryAgingPolicy;
  reason: string;
  /** Key of the successor (supersede). */
  replacedBy?: string;
}

/** Which family an item belongs to, from its key and provenance; null = not something aging looks at. */
export function kindOf(key: string, memory: Record<string, unknown> | null): MemoryKind | null {
  if (/^memory\.run-\d+\..+\.facts$/.test(key)) return "facts";
  if (/^memory\.run-\d+\..+\.conclusions$/.test(key)) return "conclusions";
  if (key.startsWith("memory.lesson.")) return "lesson";
  if (key.startsWith("memory.chat."))
    return memory?.kind === "procedure" ? "chat_procedure" : "chat_preference";
  return null;
}

const live = (i: AgingItem) => i.state !== "archived" && i.state !== "superseded";
const eligible = (i: AgingItem) => i.enabled && live(i) && !i.pinned;
const extractedAt = (i: AgingItem) => {
  const t = Date.parse(String(i.memory.extracted_at ?? ""));
  return Number.isFinite(t) ? new Date(t) : i.createdAt;
};
/** The newest of: when it was last loaded, created, or (re)activated. Idle time counts from here. */
const lastUsed = (i: AgingItem) =>
  new Date(
    Math.max(
      i.lastLoadedAt?.getTime() ?? 0,
      i.createdAt.getTime(),
      i.state === "restored" ? (i.stateAt?.getTime() ?? 0) : 0,
    ),
  );

// ------------------------------------------------------------------ 1. replacement

/**
 * A newer, enabled item of the same owner, repository and kind that covers all the files of this one replaces it.
 * Verified facts replace facts; approved conclusions replace approved conclusions; nothing crosses kinds.
 */
export function replacement(item: AgingItem, others: AgingItem[]): Decision | null {
  if (!eligible(item) || (item.kind !== "facts" && item.kind !== "conclusions")) return null;
  const files = item.memory.files;
  if (!Array.isArray(files) || !files.length) return null;
  const trusted = item.kind === "facts" ? "verified" : "approved";
  if (item.trust !== trusted) return null;
  const successors = others
    .filter(
      (o) =>
        o.id !== item.id &&
        o.ownerId === item.ownerId &&
        o.repo === item.repo &&
        o.kind === item.kind &&
        o.trust === trusted &&
        o.enabled &&
        live(o) &&
        Array.isArray(o.memory.files) &&
        files.every((f) => (o.memory.files as unknown[]).includes(f)) &&
        (extractedAt(o).getTime() > extractedAt(item).getTime() ||
          (extractedAt(o).getTime() === extractedAt(item).getTime() && o.id > item.id)),
    )
    .sort((a, b) => extractedAt(b).getTime() - extractedAt(a).getTime() || b.id - a.id);
  const next = successors[0];
  if (!next) return null;
  return {
    action: "supersede",
    policy: "replacement",
    replacedBy: next.key,
    reason: `a newer ${item.kind === "facts" ? "verified" : "approved"} memory of run #${next.memory.run_id ?? "?"} covers all ${files.length} file(s) of this one`,
  };
}

// ------------------------------------------------------------------ 2. confirmed stale

export function stale(
  item: AgingItem,
  freshness: { state: string; reason: string },
): Decision | null {
  if (!eligible(item) || freshness.state !== "STALE") return null;
  return { action: "archive", policy: "stale", reason: freshness.reason };
}

// ------------------------------------------------------------------ 3. permanently unknown

/** Codes the aging job can see: the freshness codes plus the registry fact the freshness check never sees. */
export type UnknownCode =
  | "no_provenance"
  | "no_commit"
  | "no_file_list"
  | "repo_unregistered"
  | "repo_missing"
  | "base_missing"
  | "fetch_old"
  | "commit_missing"
  | "git_error";

/**
 * Can this UNKNOWN ever recover? Missing provenance and an unregistered repository cannot (the data is in the shared
 * database). `commit_missing` cannot only on the instance that ran the task: the task's worktree and branch exist
 * nowhere else, so on any other instance the commit is simply not in that clone. A run without a recorded worker
 * instance is never judged permanent. Everything environmental (repo not cloned here, ref missing or old, git
 * errors) is transient.
 */
export function unknownIsPermanent(code: UnknownCode, onRunsInstance: boolean | null): boolean {
  switch (code) {
    case "no_provenance":
    case "no_commit":
    case "no_file_list":
    case "repo_unregistered":
      return true;
    case "commit_missing":
      return onRunsInstance === true;
    default:
      return false;
  }
}

/** Tracks when a permanent UNKNOWN started; a transient or resolved state clears it. */
export function unknown(
  item: AgingItem,
  seen: { code: UnknownCode; permanent: boolean } | null,
  now: Date,
  th: Pick<AgingThresholds, "unknownDays">,
): { since: Date | null; code: string | null; decision: Decision | null } {
  if (!seen || !seen.permanent) return { since: null, code: null, decision: null };
  const since = item.unknownSince ?? now;
  const decision =
    eligible(item) && days(since, now) >= th.unknownDays
      ? ({
          action: "archive",
          policy: "unknown",
          reason: `freshness cannot be proven (${seen.code}) for ${days(since, now)} days`,
        } satisfies Decision)
      : null;
  return { since, code: seen.code, decision };
}

// ------------------------------------------------------------------ 4. never-approved conclusions

export function unapproved(
  item: AgingItem,
  now: Date,
  th: Pick<AgingThresholds, "unapprovedDays">,
) {
  if (item.kind !== "conclusions" || item.pinned || !live(item)) return null;
  if (item.trust !== "unverified" && item.trust !== "rejected") return null;
  const age = days(extractedAt(item), now);
  if (age < th.unapprovedDays) return null;
  return {
    action: "archive",
    policy: "unapproved",
    reason: `agent conclusions still ${item.trust} after ${age} days`,
  } satisfies Decision;
}

// ------------------------------------------------------------------ 5. disuse

/** Dormant after one idle window, archived after a longer one; human-approved memory gets the longer pair. */
export function disuse(item: AgingItem, now: Date, th: AgingThresholds): Decision | null {
  if (!eligible(item)) return null;
  let windows: [number, number];
  if (item.kind === "facts" && item.trust === "verified") windows = [th.dormantDays, th.disuseDays];
  else if (item.kind === "conclusions" && item.trust === "approved")
    windows = [th.approvedDormantDays, th.approvedDisuseDays];
  else if (item.kind === "facts" && item.trust === "approved")
    windows = [th.approvedDormantDays, th.approvedDisuseDays];
  else if (item.kind === "lesson" || item.kind === "chat_procedure")
    windows = [th.lessonDormantDays, th.lessonDisuseDays];
  else return null; // preferences and corrections never expire by time; unapproved conclusions are policy 4
  const idle = days(lastUsed(item), now);
  if (idle >= windows[1])
    return {
      action: "archive",
      policy: "disuse",
      reason: `not loaded into any prompt for ${idle} days`,
    };
  if (idle >= windows[0] && item.state !== "dormant")
    return {
      action: "dormant",
      policy: "disuse",
      reason: `not loaded into any prompt for ${idle} days`,
    };
  return null;
}

// ------------------------------------------------------------------ 6. lessons

export interface ObservationRef {
  kind: string;
  runId: number | null;
  repo: string | null;
  observedAt: Date;
  /** Files of the run the observation is about (from its run memory), when known. */
  files: string[];
}

const CONTRADICTING = new Set(["regression_reported", "rollback_reported"]);

/**
 * A procedural lesson that a later report contradicts: archived when the report is about the lesson's own evidence
 * run, only made dormant when it is about another run that touched one of the same files.
 */
export function lessonContradicted(
  item: AgingItem,
  observations: ObservationRef[],
): Decision | null {
  if (item.kind !== "lesson" || item.memory.purpose !== "procedural" || !eligible(item))
    return null;
  const evidence = item.memory.evidence as { run_id?: number } | undefined;
  const runId = Number(evidence?.run_id ?? item.memory.run_id);
  const files = Array.isArray(item.memory.files) ? (item.memory.files as string[]) : [];
  const since = extractedAt(item).getTime();
  let dormant: Decision | null = null;
  for (const o of observations) {
    if (!CONTRADICTING.has(o.kind) || o.observedAt.getTime() <= since) continue;
    if (o.repo !== null && o.repo !== item.repo) continue;
    if (o.runId === runId)
      return {
        action: "archive",
        policy: "lesson_contradicted",
        reason: `${o.kind.replace("_reported", "")} reported for run #${runId}, the evidence of this lesson`,
      };
    if (
      item.state !== "dormant" &&
      o.runId !== null &&
      o.repo === item.repo &&
      o.files.some((f) => files.includes(f))
    )
      dormant ??= {
        action: "dormant",
        policy: "lesson_contradicted",
        reason: `${o.kind.replace("_reported", "")} reported for run #${o.runId}, which changed the same file(s)`,
      };
  }
  return dormant;
}

export function lessonDisputed(
  item: AgingItem,
  now: Date,
  th: Pick<AgingThresholds, "disputedDays">,
) {
  if (item.kind !== "lesson" || item.memory.status !== "disputed" || !eligible(item)) return null;
  const age = days(item.updatedAt, now);
  if (age < th.disputedDays) return null;
  return {
    action: "archive",
    policy: "lesson_disputed",
    reason: `still disputed after ${age} days`,
  } satisfies Decision;
}

// ------------------------------------------------------------------ 7. chat memory

// Leading markers only, longest first. A closed list: anything else is never matched (a wrong match loses user text).
const AFFIRM = ["from now on", "luôn luôn", "always", "luôn"];
const NEGATE = ["đừng bao giờ", "không bao giờ", "do not", "don't", "never", "đừng"];
const ANY_MARKER = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[...AFFIRM, ...NEGATE, "không", "not", "no"].join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);
/** Same normalization as chat/memory.ts (case, NFKC, whitespace, trailing punctuation). */
export const normalizeChatClaim = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[.!\s]+$/, "")
    .trim();

/** The polarity and subject of a preference, or null when it is not a clean "marker + subject" sentence. */
export function polarity(claim: string): { polarity: "affirm" | "negate"; subject: string } | null {
  const text = normalizeChatClaim(claim).replace(/^please\s+/, "");
  for (const [list, p] of [
    [NEGATE, "negate"],
    [AFFIRM, "affirm"],
  ] as const)
    for (const marker of list) {
      if (!text.startsWith(marker) || /[\p{L}\p{N}]/u.test(text.charAt(marker.length) || " "))
        continue;
      const subject = text.slice(marker.length).replace(/^[\s,:]+/, "");
      if (subject.length < 3 || ANY_MARKER.test(subject)) return null;
      return { polarity: p, subject };
    }
  return null;
}

/** A newer statement supersedes an older one only when the subjects are identical and the markers are opposite. */
export function chatContradicted(item: AgingItem, others: AgingItem[]): Decision | null {
  if (item.kind !== "chat_preference" || !eligible(item)) return null;
  const mine = polarity(String(item.memory.claim ?? ""));
  if (!mine) return null;
  const successors = others
    .filter(
      (o) =>
        o.id !== item.id &&
        o.ownerId === item.ownerId &&
        o.kind === "chat_preference" &&
        o.enabled &&
        live(o),
    )
    .filter((o) => o.createdAt.getTime() > item.createdAt.getTime())
    .flatMap((o) => {
      const p = polarity(String(o.memory.claim ?? ""));
      return p && p.polarity !== mine.polarity && p.subject === mine.subject ? [o] : [];
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const next = successors[0];
  return next
    ? {
        action: "supersede",
        policy: "chat_contradicted",
        replacedBy: next.key,
        reason: `a newer statement says the opposite about "${mine.subject}"`,
      }
    : null;
}

export interface OperationRef {
  status: string;
  finishedAt: Date | null;
}
/** A learned procedure whose operation most recently failed (after it was last confirmed) is archived. */
export function procedureFailed(item: AgingItem, latest: OperationRef | null): Decision | null {
  if (item.kind !== "chat_procedure" || !eligible(item) || !latest?.finishedAt) return null;
  if (latest.status !== "failed") return null;
  const lastSeen = Date.parse(String(item.memory.last_seen_at ?? item.memory.extracted_at ?? ""));
  if (Number.isFinite(lastSeen) && latest.finishedAt.getTime() <= lastSeen) return null;
  return {
    action: "archive",
    policy: "procedure_failed",
    reason: "the same operation failed after this procedure was last confirmed",
  };
}

/** A procedure that succeeded again comes back by itself, unpinned: only a person's Restore pins. */
export const autoRestorable = (item: Pick<AgingItem, "state" | "policy" | "pinned">) =>
  item.state === "archived" && item.policy === "procedure_failed" && !item.pinned;

// ------------------------------------------------------------------ 8. cap

/** Per owner and repository, the least recently used active run memories beyond `cap`. Pinned ones count, never go. */
export function overCap(items: AgingItem[], cap: number): Map<number, Decision> {
  const groups = new Map<string, AgingItem[]>();
  for (const i of items) {
    const counted =
      (i.kind === "facts" && (i.trust === "verified" || i.trust === "approved")) ||
      (i.kind === "conclusions" && i.trust === "approved");
    if (!counted || !i.enabled || !live(i)) continue;
    const g = `${i.ownerId}|${i.repo}`;
    groups.set(g, [...(groups.get(g) ?? []), i]);
  }
  const out = new Map<number, Decision>();
  for (const group of groups.values()) {
    if (group.length <= cap) continue;
    const byRecency = [...group].sort(
      (a, b) => lastUsed(b).getTime() - lastUsed(a).getTime() || b.id - a.id,
    );
    for (const i of byRecency.slice(cap))
      if (!i.pinned)
        out.set(i.id, {
          action: "archive",
          policy: "cap",
          reason: `more than ${cap} active run memories for this repository; least recently used`,
        });
  }
  return out;
}

// ------------------------------------------------------------------ purge

/** Archived long enough: deleted for good (the audit rows and the snapshots of past runs stay). */
export function purge(
  item: AgingItem,
  now: Date,
  th: Pick<AgingThresholds, "purgeDays">,
): Decision | null {
  if (
    th.purgeDays <= 0 ||
    item.pinned ||
    (item.state !== "archived" && item.state !== "superseded")
  )
    return null;
  if (!item.stateAt || days(item.stateAt, now) < th.purgeDays) return null;
  return {
    action: "purge",
    policy: "purge",
    reason: `${item.state} for ${days(item.stateAt, now)} days (${item.policy ?? "unknown policy"})`,
  };
}

// ------------------------------------------------------------------ one item

export interface ItemContext {
  now: Date;
  thresholds: AgingThresholds;
  /** Every task_memory item of the pass (successors, contradicting statements). */
  all: AgingItem[];
  /** This item's freshness check, when it was made (run memory only). */
  freshness?: { state: string; reason: string } | null;
  unknown?: { code: UnknownCode; permanent: boolean } | null;
  observations?: ObservationRef[];
  latestOperation?: OperationRef | null;
}

/**
 * The decision for one item, in the documented order: replacement, confirmed stale, permanently unknown,
 * never-approved, lesson contradiction / dispute, chat contradiction, failed procedure, disuse. Purge is separate
 * (it only looks at items that are already archived). The cap needs the whole set: see `overCap`.
 */
export function decide(
  item: AgingItem,
  ctx: ItemContext,
): { decision: Decision | null; unknownSince: Date | null; unknownCode: string | null } {
  const track = unknown(item, ctx.unknown ?? null, ctx.now, ctx.thresholds);
  const decision =
    replacement(item, ctx.all) ??
    (ctx.freshness ? stale(item, ctx.freshness) : null) ??
    track.decision ??
    unapproved(item, ctx.now, ctx.thresholds) ??
    lessonContradicted(item, ctx.observations ?? []) ??
    lessonDisputed(item, ctx.now, ctx.thresholds) ??
    chatContradicted(item, ctx.all) ??
    procedureFailed(item, ctx.latestOperation ?? null) ??
    disuse(item, ctx.now, ctx.thresholds);
  return { decision, unknownSince: track.since, unknownCode: track.code };
}
