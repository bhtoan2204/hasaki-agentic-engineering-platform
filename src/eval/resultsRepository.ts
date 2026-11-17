import { pool, q, type Db } from "../db/pool.ts";

export interface EvalRow {
  candidate: string;
  profile: string | null;
  status: string;
  correct: boolean | null;
  regression: boolean | null;
  verdict: string | null;
  repairs: number;
  human_gates: number;
  wall_s: number | null;
  cost_usd: number | string | null;
  tokens: number | string | null;
}

export function listEvalResults(ownerId: number, suite: string | null, db: Db = pool) {
  return q<EvalRow>(
    db,
    `SELECT * FROM eval_results WHERE ($1::text IS NULL OR suite = $1)
       AND (owner_id IS NULL OR owner_id=$2) ORDER BY id DESC LIMIT 500`,
    [suite, ownerId],
  );
}
