import { pool } from "../db/pool.ts";
import { fresh } from "../codeIntelligence/search.ts";
import { effectiveSql } from "../codeIntelligence/store.ts";

export interface MapSymbol {
  repository: string;
  file_path: string;
  symbol_name: string;
  signature: string;
  parent_symbol: string | null;
  exported?: boolean;
}
export const isCodebaseMap = (k: { key: string; title: string }) =>
  /codebase[ ._-]?map/i.test(k.key + " " + k.title);
export function renderCodebaseMap(symbols: MapSymbol[], maxChars = 2000): string {
  const budget = Math.max(0, Math.min(2000, Math.floor(maxChars)));
  let text = "";
  for (const s of symbols) {
    if (
      s.parent_symbol ||
      !(s.exported || (s.file_path.endsWith(".go") && /^[A-Z]/.test(s.symbol_name)))
    )
      continue;
    const line = `${s.repository}:${s.file_path} ${s.signature || s.symbol_name}\n`;
    if (text.length + line.length > budget) continue;
    text += line;
  }
  return text.trimEnd();
}
export async function indexedCodebaseMap(
  repositories: string[],
  runId: number,
  maxChars: number,
): Promise<string> {
  const started = performance.now();
  const work = async () => {
    const found: Array<{ id: number; name: string }> = [];
    try {
      for (const name of repositories) {
        if (performance.now() - started >= 45) return "";
        const indexed = await fresh(name, runId, false);
        if (indexed.index) found.push({ id: indexed.index.id, name });
      }
    } catch {
      return "";
    }
    if (!found.length || performance.now() - started >= 45) return "";
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout='35ms'");
      const symbols: MapSymbol[] = [];
      for (const index of found) {
        if (performance.now() - started >= 45) return "";
        const result = await client.query(
          `WITH f AS (${effectiveSql}) SELECT $2::text AS repository,f.file_path,s.symbol_name,s.signature,s.parent_symbol,EXISTS (SELECT 1 FROM code_intelligence.relations rel WHERE rel.extraction_id=s.extraction_id AND rel.source_name='export' AND rel.target_name=s.qualified_name AND rel.relation_type='REFERENCES') AS exported FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id WHERE s.parent_symbol IS NULL ORDER BY f.file_path,s.start_line LIMIT 100`,
          [index.id, index.name],
        );
        symbols.push(...result.rows);
      }
      return performance.now() - started < 50 ? renderCodebaseMap(symbols, maxChars) : "";
    } catch {
      return "";
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work().catch(() => ""),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), 50);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
