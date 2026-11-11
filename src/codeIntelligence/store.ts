import { ownsInstance } from "../instances.ts";
import { pool, one, q, withTx, insertDeferred, type Db } from "../db/pool.ts";
import { extract, parserVersion, type Extraction } from "./parser.ts";
import { config } from "../config.ts";
import { hash, languageOf } from "./git.ts";

export interface FileRecord {
  file_path: string;
  blob_hash: string;
  extraction_id: number | null;
  deleted: boolean;
}
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
export const filesOf = (id: number, db: Db = pool) =>
  q<FileRecord>(
    db,
    "SELECT file_path,blob_hash,extraction_id,deleted FROM code_intelligence.files WHERE snapshot_id=$1",
    [id],
  );
export const effectiveSql = `SELECT f.* FROM code_intelligence.files f WHERE f.snapshot_id=$1 AND NOT f.deleted
 UNION ALL SELECT b.* FROM code_intelligence.files b JOIN code_intelligence.snapshots s ON s.base_snapshot_id=b.snapshot_id
 WHERE s.id=$1 AND NOT b.deleted AND NOT EXISTS (SELECT 1 FROM code_intelligence.files o WHERE o.snapshot_id=s.id AND o.file_path=b.file_path)`;

export async function publish(
  input: {
    repository_id: number;
    commit_sha: string;
    identity: string;
    base_snapshot_id?: number;
    instance_id?: string;
    run_id?: number;
    generation?: string;
  },
  files: FileRecord[],
  fence?: { id: number; token: number },
  validate?: () => Promise<void>,
) {
  return withTx(async (c) => {
    // Serializes same-repository publication only, without holding a lock while parsing.
    await q(c, "SELECT id FROM repositories WHERE id=$1 FOR UPDATE", [input.repository_id]);
    if (
      fence &&
      !(await one(
        c,
        "SELECT id FROM code_intelligence.runs WHERE id=$1 AND fencing_token=$2 AND status='running' AND lease_expires_at>now() FOR UPDATE",
        [fence.id, fence.token],
      ))
    )
      throw new Error("Index lease lost");
    if (fence) {
      await q(c, "SELECT instance_id FROM platform_instances WHERE instance_id=$1 FOR SHARE", [
        config.instanceId,
      ]);
      if (!(await ownsInstance(c))) throw new Error("Index lease lost");
    }
    await validate?.();
    const existing = await snapshot(input.repository_id, input.identity, c);
    if (existing) return existing;
    const row = await one<Snapshot>(
      c,
      `INSERT INTO code_intelligence.snapshots(repository_id,commit_sha,index_version,identity,base_snapshot_id,instance_id,run_id,generation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.repository_id,
        input.commit_sha,
        parserVersion(),
        input.identity,
        input.base_snapshot_id ?? null,
        input.instance_id ?? "",
        input.run_id ?? null,
        input.generation ?? "",
      ],
    );
    // Bulk write via json_to_recordset is transport only: storage is relational.
    await q(
      c,
      `INSERT INTO code_intelligence.files(snapshot_id,file_path,blob_hash,extraction_id,deleted)
      SELECT $1,x.file_path,x.blob_hash,x.extraction_id,x.deleted FROM json_to_recordset($2::json) AS x(file_path text,blob_hash text,extraction_id bigint,deleted boolean)`,
      [row!.id, JSON.stringify(files)],
    );
    await q(
      c,
      `WITH f AS (${effectiveSql}) UPDATE code_intelligence.snapshots SET
      indexed_files=(SELECT count(*) FROM f WHERE extraction_id IS NOT NULL),
      symbol_count=(SELECT count(*) FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id),
      relation_count=(SELECT count(*) FROM f JOIN code_intelligence.relations r ON r.extraction_id=f.extraction_id) WHERE id=$1`,
      [row!.id],
    );
    return row!;
  });
}

/** One cache lookup and one transaction per batch, independent of the number of files/symbols. */
export async function extractionBatch(
  inputs: Array<{ path: string; source: string }>,
  metrics: Record<string, number>,
  signal?: AbortSignal,
  deadline = Date.now() + 120000,
) {
  const unique = new Map(
    inputs.map((i) => {
      const key = `${languageOf(i.path)}:${hash(i.source)}`;
      return [key, { ...i, language: languageOf(i.path)!, content_hash: hash(i.source) }];
    }),
  );
  const requests = [...unique.values()];
  const result = new Map<string, number | null>();
  if (!requests.length) return result;
  const lookup = async (db: Db) =>
    q(
      db,
      `SELECT e.id,e.language,e.content_hash FROM code_intelligence.extractions e
    JOIN json_to_recordset($1::json) x(language text,content_hash text) ON x.language=e.language AND x.content_hash=e.content_hash WHERE e.parser_version=$2`,
      [
        JSON.stringify(
          requests.map((r) => ({
            language: r.language,
            content_hash: r.content_hash,
          })),
        ),
        parserVersion(),
      ],
    );
  const cached = await lookup(pool);
  for (const r of cached) result.set(`${r.language}:${r.content_hash}`, r.id);
  metrics.index_cache_hits += cached.length;
  const parsed: Extraction[] = [];
  for (const [key, r] of unique) {
    if (result.has(key)) continue;
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error("Index timeout");
    if (
      !config.codeIntelligence.includeGenerated &&
      /Code generated .*DO NOT EDIT|@generated/.test(r.source.slice(0, 1024))
    ) {
      metrics.skipped_files++;
      result.set(key, null);
      continue;
    }
    const e = await extract(r.path, r.source, signal);
    if (!e) {
      metrics.skipped_files++;
      result.set(key, null);
      continue;
    }
    metrics.parse_failures += e.parse_errors;
    parsed.push(e);
  }
  if (parsed.length)
    await withTx(async (c) => {
      const inserted = await q(
        c,
        `INSERT INTO code_intelligence.extractions(language,parser_version,content_hash,parse_errors)
      SELECT language,parser_version,content_hash,parse_errors FROM json_to_recordset($1::json) x(language text,parser_version text,content_hash text,parse_errors int)
      ON CONFLICT DO NOTHING RETURNING id,language,content_hash`,
        [
          JSON.stringify(
            parsed.map(({ language, parser_version, content_hash, parse_errors }) => ({
              language,
              parser_version,
              content_hash,
              parse_errors,
            })),
          ),
        ],
      );
      const fresh = new Map(inserted.map((r) => [`${r.language}:${r.content_hash}`, r.id]));
      for (const e of parsed) {
        const id = fresh.get(`${e.language}:${e.content_hash}`);
        if (!id) continue;
        for (const s of e.symbols)
          await insertDeferred(
            c,
            "code_intelligence.symbols",
            ["extraction_id", ...Object.keys(s)],
            [id, ...Object.values(s)],
          );
        for (const r of e.relations)
          await insertDeferred(
            c,
            "code_intelligence.relations",
            ["extraction_id", ...Object.keys(r)],
            [id, ...Object.values(r)],
          );
      }
      for (const r of await lookup(c)) result.set(`${r.language}:${r.content_hash}`, r.id);
    });
  return result;
}
