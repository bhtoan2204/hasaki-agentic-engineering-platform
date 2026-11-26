import { q, pool } from "../db/pool.ts";
import { fresh } from "../codeIntelligence/search.ts";
import { effectiveSql } from "../codeIntelligence/store.ts";
import { readSource, hash, git } from "../codeIntelligence/git.ts";
import { normalizeScopePath } from "../agent/scopeGuard.ts";
import { isSecretPath } from "../agent/toolPolicy.ts";
import type { ProfileSignals } from "./profiles.ts";
/** Bounded reads of canonical hints against a revision-matched Tree-sitter snapshot. No provisioning or repository scan. */
export async function collectMicroEvidence(
  repository: string,
  hints: unknown,
  priorFailureRuns: number,
  runId?: number,
): Promise<ProfileSignals["evidence"]> {
  if (
    !Array.isArray(hints) ||
    !hints.length ||
    hints.length > 3 ||
    hints.some((p) => typeof p !== "string")
  )
    return undefined;
  const files = hints as string[];
  if (
    files.some((p) => {
      const n = normalizeScopePath(p, repository, false);
      return "invalid" in n || n.dir || isSecretPath(p);
    })
  )
    return undefined;
  try {
    const state = await fresh(repository, runId, false);
    if (!state.index) return undefined;
    const rows = await q<{
      file_path: string;
      blob_hash: string;
      extraction_id: number | null;
      parse_errors: number | null;
      content_hash: string;
    }>(
      pool,
      `WITH f AS (${effectiveSql}) SELECT f.file_path,f.blob_hash,f.extraction_id,e.parse_errors,e.content_hash FROM f LEFT JOIN code_intelligence.extractions e ON e.id=f.extraction_id WHERE f.file_path=ANY($2)`,
      [state.index.id, files],
    );
    if (rows.length !== files.length || rows.some((r) => !r.extraction_id || r.parse_errors !== 0))
      return undefined;
    for (const row of rows) {
      const source = await readSource(state.root, row.file_path);
      if (source === null || hash(source) !== row.content_hash) return undefined;
    }
    const symbols = await q<{ qualified_name: string }>(
      pool,
      `WITH f AS (${effectiveSql}) SELECT s.qualified_name FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id WHERE f.file_path=ANY($2) LIMIT 101`,
      [state.index.id, files],
    );
    if (symbols.length > 100) return undefined;
    const scopeTerms = symbols
      .map((s) => s.qualified_name.replace(/([a-z])([A-Z])/g, "$1 $2"))
      .join(" ");
    // Check for candidate or unresolved calls inside the file, external callers to symbols,
    // external module imports, and unindexed or unsupported consumers across the repository:
    const stems = files.map((f) =>
      f
        .split("/")
        .pop()!
        .replace(/\.[^/.]+$/, ""),
    );
    const noExts = files.map((f) => f.replace(/\.[^/.]+$/, ""));
    const moduleCandidates = [
      ...files,
      ...files.map((f) => `./${f}`),
      ...noExts,
      ...noExts.map((f) => `./${f}`),
      ...stems,
      ...stems.map((s) => `./${s}`),
    ];
    const uncertain = await q(
      pool,
      `WITH f AS (${effectiveSql}), affected AS (
      SELECT s.symbol_name,s.qualified_name FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id WHERE f.file_path=ANY($2))
      SELECT r.id FROM f JOIN code_intelligence.relations r ON r.extraction_id=f.extraction_id
      WHERE (f.file_path=ANY($2) AND r.resolution<>'resolved' AND r.relation_type IN ('CALLS','IMPORTS'))
        OR (NOT f.file_path=ANY($2) AND (
          r.target_name IN (SELECT symbol_name FROM affected UNION SELECT qualified_name FROM affected)
          OR (r.relation_type = 'IMPORTS' AND (
            r.target_name = ANY($3)
            OR EXISTS (
              SELECT 1 FROM unnest($4::text[]) s
              WHERE r.target_name LIKE '%/' || s
                 OR r.target_name LIKE '%/' || s || '.%'
            )
          ))
        )) LIMIT 1`,
      [state.index.id, files, moduleCandidates, stems],
    );
    const incomplete = await q(
      pool,
      `WITH f AS (${effectiveSql}) SELECT f.file_path FROM f LEFT JOIN code_intelligence.extractions e ON e.id=f.extraction_id
       WHERE NOT f.file_path=ANY($2) AND (f.extraction_id IS NULL OR e.parse_errors > 0) LIMIT 1`,
      [state.index.id, files],
    );
    let externalConsumers = false;
    for (const file of files) {
      const stem = file
        .split("/")
        .pop()!
        .replace(/\.[^/.]+$/, "");
      try {
        const grep = await git(state.root, [
          "grep",
          "-I",
          "-l",
          "-E",
          `(from|require\\(|import\\s+)['"].*\\b${stem}\\b`,
        ]);
        const matched = grep
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (matched.some((m) => !files.includes(m))) {
          externalConsumers = true;
          break;
        }
      } catch {
        // git grep returns exit 1 when no matches are found
      }
    }
    if ((await fresh(repository, runId, false)).index?.id !== state.index.id) return undefined;
    return {
      revision: state.index.commit_sha,
      indexRevision: state.index.commit_sha,
      files,
      hashes: Object.fromEntries(rows.map((row) => [row.file_path, row.content_hash])),
      scopeTerms,
      impactKnown: uncertain.length === 0 && incomplete.length === 0 && !externalConsumers,
      priorFailureRuns,
    };
  } catch {
    return undefined;
  }
}

/** Before the first edit, bind the prepared checkout to the admission revision and canonical source hashes. */
export async function validateMicroWorkspace(
  root: string,
  revision: unknown,
  hashes: unknown,
): Promise<boolean> {
  if (
    typeof revision !== "string" ||
    !hashes ||
    typeof hashes !== "object" ||
    Array.isArray(hashes)
  )
    return false;
  const entries = Object.entries(hashes);
  if (!entries.length || entries.length > 3) return false;
  try {
    if (
      (await git(root, ["rev-parse", "HEAD"])).trim() !== revision ||
      (await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim()
    )
      return false;
    for (const [file, expected] of entries) {
      const source = await readSource(root, file);
      if (source === null || hash(source) !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}
