import { config } from "../config.ts";
import { pool, one, q, type Db } from "../db/pool.ts";
/** Bounded JSON: cut by characters (never by nesting depth, which would drop nested facts), marked when cut. */
const bounded = (v: unknown, max: number) => {
  const s = JSON.stringify(v, null, 1) ?? "null";
  return s.length > max
    ? `${s.slice(0, max)}… [truncated: ${s.length - max} chars; full in the referenced record]`
    : s;
};

/**
 * Provider-neutral adaptive session compaction. A provider session grows with every tool round: each call re-reads the
 * whole conversation (cache reads dominate cost). At safe boundaries — before resuming a session for answers/feedback
 * and before each verification repair round — the platform checks the provider-reported context occupancy of the
 * session's last call; above the pressure threshold the session is not continued but reconstructed from durable,
 * deterministic state (context pack, continuity record, checkpoints, workspace state, verification state). No extra
 * model call summarizes anything. Unknown occupancy (providers that do not report per-call usage) never triggers it:
 * those sessions keep the provider's own compaction.
 */
export type CompactionMode = "reconstruct" | "native" | "off";

export interface CompactionDecision {
  compact: boolean;
  mode: CompactionMode;
  pressure: number | null;
  occupancy: number | null;
  window: number;
  reason: string;
}

/** Context window of the model (tokens). Configurable per provider; Claude 1M variants are recognized by name. */
export function contextWindowFor(provider: string, model: string | null | undefined) {
  const configured = config.agent.contextWindows?.[provider];
  if (configured) return configured;
  if (provider === "claude" && /\b1m\b|\[1m\]/i.test(model ?? "")) return 1_000_000;
  return config.agent.contextWindowTokens ?? 200_000;
}

export function compactionDecision(x: {
  provider: string;
  model?: string | null;
  occupancy: number | null | undefined;
}): CompactionDecision {
  const mode: CompactionMode = config.agent.compaction?.mode ?? "reconstruct";
  const threshold = config.agent.compaction?.pressure ?? 0.6;
  const window = contextWindowFor(x.provider, x.model);
  if (x.occupancy == null)
    return {
      compact: false,
      mode,
      pressure: null,
      occupancy: null,
      window,
      reason: "occupancy not reported by the provider",
    };
  const pressure = x.occupancy / window;
  if (mode === "off")
    return {
      compact: false,
      mode,
      pressure,
      occupancy: x.occupancy,
      window,
      reason: "compaction disabled",
    };
  return pressure >= threshold
    ? {
        compact: true,
        mode,
        pressure,
        occupancy: x.occupancy,
        window,
        reason: `context pressure ${Math.round(pressure * 100)}% (${x.occupancy}/${window} tokens) ≥ ${Math.round(threshold * 100)}%`,
      }
    : {
        compact: false,
        mode,
        pressure,
        occupancy: x.occupancy,
        window,
        reason: "below the pressure threshold",
      };
}

/**
 * Provider-native compaction ("native" mode): the provider's own auto-compaction is moved to the configured pressure,
 * so a long single turn — where no safe boundary is reached — compacts earlier. Returns null outside native mode.
 */
export function nativeCompactionThreshold(provider: string, model?: string | null) {
  if (config.agent.compaction?.mode !== "native") return null;
  const pressure = config.agent.compaction?.pressure ?? 0.6;
  return {
    percent: Math.max(1, Math.min(100, Math.round(pressure * 100))),
    tokens: Math.round(pressure * contextWindowFor(provider, model)),
  };
}

/** Occupancy of the session at the end of an earlier attempt (provider-reported, per call — not cumulative usage). */
export async function attemptOccupancy(attemptId: number | null | undefined, db: Db = pool) {
  if (!attemptId) return null;
  const row = await one<{ last: string | null }>(
    db,
    "SELECT metrics->'context_window'->>'last_tokens' AS last FROM workflow_step_attempts WHERE id = $1",
    [attemptId],
  );
  return row?.last == null ? null : Number(row.last);
}

/**
 * What a reconstructed session must know beyond the context pack (which carries requirements, invariants, decisions,
 * approved scope and rules verbatim): where the work stands. Deterministic, bounded; every large item is a reference.
 */
export function sessionStateBlock(x: {
  reason: string;
  worktree: string;
  verification?: unknown;
  notes?: string[];
  continuity?: Record<string, unknown> | null;
  artifacts: Array<{ id: number; name: string }>;
  previousAttemptId: number | null;
}) {
  const lines = [
    `## Session compacted (${x.reason})`,
    "Your previous conversation was replaced by this reconstruction from platform records; nothing here is a model summary.",
    "Requirements, business invariants, developer decisions, approved scope and rules are in the context pack above, verbatim.",
    "",
    "### Workspace now (code context captured earlier may be stale: re-read the files you change)",
    x.worktree || "(no workspace)",
  ];
  if (x.verification != null)
    lines.push("", "### Verification state", bounded(x.verification, 4000));
  if (x.continuity) {
    const c = x.continuity;
    const unfinished = (c.unfinished ?? {}) as {
      questions?: Array<{ id?: number; question?: string; status?: string }>;
    };
    lines.push(
      "",
      "### Recorded at the end of the previous attempt",
      `Outcome: ${String(c.outcome ?? "unknown")}`,
    );
    for (const q of unfinished.questions ?? [])
      lines.push(`- question ${q.id ?? "?"} (${q.status ?? "open"}): ${q.question ?? ""}`);
    lines.push(
      bounded(
        {
          unfinished: c.unfinished,
          verification: c.verification,
          independent_verification: c.independent_verification,
        },
        3000,
      ),
    );
  }
  if (x.notes?.length) lines.push("", "### Your progress notes", ...x.notes.map((n) => `- ${n}`));
  if (x.artifacts.length)
    lines.push(
      "",
      "### Raw evidence (read with read_artifact)",
      ...x.artifacts.map((a) => `- artifact ${a.id}: ${a.name}`),
    );
  if (x.previousAttemptId)
    lines.push("", `Full earlier tool history: run.step_history (attempt ${x.previousAttemptId}).`);
  return lines.join("\n");
}

/** Log/report artifacts of an attempt: stable references to raw evidence the reconstructed session can re-read. */
export async function attemptArtifacts(attemptId: number, db: Db = pool) {
  return q<{ id: number; name: string }>(
    db,
    "SELECT id, name FROM workflow_artifacts WHERE attempt_id = $1 AND kind IN ('log', 'report') ORDER BY id DESC LIMIT 20",
    [attemptId],
  );
}

export async function attemptContinuity(attemptId: number | null | undefined, db: Db = pool) {
  if (!attemptId) return null;
  return (
    (
      await one<{ content: Record<string, unknown> }>(
        db,
        "SELECT content FROM agent_context_continuity WHERE attempt_id = $1",
        [attemptId],
      )
    )?.content ?? null
  );
}
