export interface SnapshotContent {
  upstream?: unknown;
  [key: string]: unknown;
}

import { pool, q, one, json, type Db } from "../db/pool.ts";

export const agentRepository = {
  findContextSnapshotById(id: number, db: Db = pool) {
    return one(db, "SELECT * FROM context_snapshots WHERE id = $1", [id]);
  },

  findContextSnapshotContent(id: number, db: Db = pool) {
    return one<{ content: SnapshotContent }>(
      db,
      "SELECT content FROM context_snapshots WHERE id = $1",
      [id],
    );
  },

  findContextPackByAttemptId(
    params: { attemptId: number; runId: number; stepId: number; ownerId?: number | null },
    db: Db = pool,
  ) {
    return one(
      db,
      "SELECT id,snapshot_id,content_hash,content,created_at FROM agent_context_packs WHERE attempt_id=$1 AND run_id=$2 AND step_id=$3 AND owner_id=$4",
      [params.attemptId, params.runId, params.stepId, params.ownerId ?? null],
    );
  },

  findContextPackContent(
    params: { attemptId: number; runId: number; stepId: number; ownerId?: number | null },
    db: Db = pool,
  ) {
    return one<{ content: SnapshotContent }>(
      db,
      "SELECT content FROM agent_context_packs WHERE attempt_id=$1 AND run_id=$2 AND step_id=$3 AND owner_id=$4",
      [params.attemptId, params.runId, params.stepId, params.ownerId ?? null],
    );
  },

  insertContextPack(
    data: {
      attempt_id: number;
      run_id: number;
      step_id: number;
      owner_id?: number | null;
      snapshot_id: number;
      content_hash: string;
      content: unknown;
    },
    db: Db = pool,
  ) {
    return one<{ id: number }>(
      db,
      "INSERT INTO agent_context_packs (attempt_id, run_id, step_id, owner_id, snapshot_id, content_hash, content) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [
        data.attempt_id,
        data.run_id,
        data.step_id,
        data.owner_id ?? null,
        data.snapshot_id,
        data.content_hash,
        json(data.content),
      ],
    );
  },

  findCandidateSessions(
    stepId: number,
    cwd: string,
    provider: string,
    effectiveAgent: unknown,
    db: Db = pool,
  ) {
    return q<{
      session_id: string;
      attempt_id: number;
      snapshot: SnapshotContent;
    }>(
      db,
      `SELECT s.session_id, s.attempt_id, cs.content AS snapshot
         FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id LEFT JOIN context_snapshots cs ON cs.id = a.context_snapshot_id
        WHERE a.step_id = $1 AND s.resumable AND s.cwd = $2 AND s.provider = $3 AND (a.effective_agent IS NOT DISTINCT FROM $4::jsonb) ORDER BY s.id DESC LIMIT 5`,
      [stepId, cwd, provider, effectiveAgent ? JSON.stringify(effectiveAgent) : null],
    );
  },

  findLastSession(attemptId: number, db: Db = pool) {
    return one<{ session_id: string }>(
      db,
      "SELECT session_id FROM agent_sessions WHERE attempt_id = $1 ORDER BY id DESC LIMIT 1",
      [attemptId],
    );
  },

  findResumableSession(attemptId: number, provider: string, db: Db = pool) {
    return one<{ session_id: string }>(
      db,
      "SELECT session_id FROM agent_sessions WHERE attempt_id = $1 AND provider = $2 AND resumable ORDER BY id DESC LIMIT 1",
      [attemptId, provider],
    );
  },

  markSessionNotResumable(sessionId: string, provider: string, db: Db = pool) {
    return q(
      db,
      "UPDATE agent_sessions SET resumable = false WHERE session_id = $1 AND provider = $2",
      [sessionId, provider],
    );
  },

  upsertAgentSession(
    data: {
      attemptId: number;
      sessionId: string;
      provider: string;
      cwd: string;
      resumable?: boolean;
    },
    db: Db = pool,
  ) {
    return q(
      db,
      "INSERT INTO agent_sessions (attempt_id, session_id, provider, cwd, resumable) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id) DO UPDATE SET updated_at = now()",
      [data.attemptId, data.sessionId, data.provider, data.cwd, data.resumable ?? true],
    );
  },

  findAgentRecommendationById(id: number, db: Db = pool) {
    return one(db, "SELECT * FROM agent_recommendations WHERE id=$1", [id]);
  },

  listAgentRecommendations(ownerId: number, limit = 50, db: Db = pool) {
    return q(
      db,
      "SELECT * FROM agent_recommendations WHERE owner_id=$1 ORDER BY id DESC LIMIT $2",
      [ownerId, limit],
    );
  },

  recordHandoffState(handoffId: number, state: unknown, db: Db = pool) {
    return q(db, "UPDATE provider_handoffs SET package = $2, updated_at = now() WHERE id = $1", [
      handoffId,
      json(state),
    ]);
  },

  findProviderHandoffForTarget(
    targetAttemptId: number,
    runId: number,
    stepId: number,
    db: Db = pool,
  ) {
    return one(
      db,
      "SELECT id,source_attempt_id,package FROM provider_handoffs WHERE target_attempt_id=$1 AND run_id=$2 AND step_id=$3 AND status='RESUMED'",
      [targetAttemptId, runId, stepId],
    );
  },
};
