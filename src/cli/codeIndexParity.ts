/**
 * Reference output of the TypeScript extractor for the Go parity test (go/internal/codeintelligence/parity_test.go).
 *   repo:     node src/cli/codeIndexParity.ts repo <checkout> <commit> <out.jsonl>
 *   fixtures: node src/cli/codeIndexParity.ts files <dir> <out.jsonl>   (records carry the source)
 * The first line holds the extraction limits; every other line is one file. Read-only: no database access.
 */
import { createWriteStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { config } from "../config.ts";
import { extract } from "../codeIntelligence/parser.ts";
import { git, readBlobs, treeFiles } from "../codeIntelligence/git.ts";

const [mode, target, a, b] = process.argv.slice(2);
const out = createWriteStream(mode === "repo" ? b : a);
const ci = config.codeIntelligence;
out.write(
  JSON.stringify({
    limits: {
      max_file_bytes: ci.maxFileBytes,
      max_symbols: ci.maxSymbols,
      max_files: ci.maxFiles,
      max_scan_bytes: ci.maxScanBytes,
      timeout_ms: ci.timeoutMs,
      excludes: ci.excludes,
      include_generated: ci.includeGenerated,
      include_dependencies: ci.includeDependencies,
    },
    commit: mode === "repo" ? (await git(target, ["rev-parse", a])).trim() : null,
  }) + "\n",
);

async function record(path: string, source: string, extra: Record<string, unknown>) {
  try {
    const e = await extract(path, source);
    const extraction = e && {
      language: e.language,
      content_hash: e.content_hash,
      symbols: e.symbols,
      relations: e.relations,
      parse_errors: e.parse_errors,
    };
    out.write(JSON.stringify({ path, ...extra, extraction }) + "\n");
  } catch (error) {
    out.write(JSON.stringify({ path, ...extra, error: (error as Error).message }) + "\n");
  }
}

if (mode === "repo") {
  const files = await treeFiles(target, (await git(target, ["rev-parse", a])).trim());
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    const sources = await readBlobs(
      target,
      batch.map((f) => f.blob),
    );
    for (const [j, f] of batch.entries()) await record(f.path, sources[j], { blob: f.blob });
  }
} else if (mode === "files") {
  const walk = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { withFileTypes: true })).flatMap((d) =>
      d.isDirectory() ? [] : [join(dir, d.name)],
    );
  for (const file of (await walk(target)).sort()) {
    const bytes = await readFile(file);
    await record(relative(target, file), bytes.toString("utf8"), {
      source_base64: bytes.toString("base64"),
    });
  }
} else
  throw new Error("usage: codeIndexParity.ts repo <checkout> <commit> <out> | files <dir> <out>");
await new Promise<void>((done) => out.end(done));
