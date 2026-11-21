import { pool, one, type Db } from "../db/pool.ts";
import { parserVersion } from "./parser.ts";

/** Reads of the code-intelligence snapshots that platform-go publishes (go/internal/codeintelligence). */
export interface Snapshot {
  id: number;
  repository_id: number;
  commit_sha: string;
  identity: string;
  base_snapshot_id: number | null;
  generation: string;
  run_id: number | null;
}
export const snapshot = (repoId: number, identity: string, db: Db = pool) =>
  one<Snapshot>(
    db,
    "SELECT * FROM code_intelligence.snapshots WHERE repository_id=$1 AND identity=$2 AND index_version=$3",
    [repoId, identity, parserVersion()],
  );
export const effectiveSql = `SELECT f.* FROM code_intelligence.files f WHERE f.snapshot_id=$1 AND NOT f.deleted
 UNION ALL SELECT b.* FROM code_intelligence.files b JOIN code_intelligence.snapshots s ON s.base_snapshot_id=b.snapshot_id
 WHERE s.id=$1 AND NOT b.deleted AND NOT EXISTS (SELECT 1 FROM code_intelligence.files o WHERE o.snapshot_id=s.id AND o.file_path=b.file_path)`;
