/** `npm run knowledge:import [-- --dry-run] [--only=<key prefix>]` — import repo CLAUDE.md / skills / rules / wiki docs into the registry. */
import { migrate } from "../db/migrate.ts";
import { pool } from "../db/pool.ts";
import { syncRepositoriesFromConfig } from "../repos/service.ts";
import { importFromRepositories } from "../knowledge/importer.ts";

const dryRun = process.argv.includes("--dry-run");
await migrate();
await syncRepositoriesFromConfig();
const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) || undefined;
const r = await importFromRepositories({ dryRun, only });
for (const c of r.candidates) console.log(`${c.action.padEnd(9)} ${c.key.padEnd(58)} ${c.category.padEnd(22)} ${c.scope.padEnd(30)} ${String(c.chars).padStart(6)}c  ${c.repos.join(",")}`);
for (const s of r.skipped) console.log(`skipped   ${s.path}  — ${s.reason}`);
console.log(`\n${dryRun ? "DRY RUN: " : ""}${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.retired} retired, ${r.skipped.length} skipped/notes`);
await pool.end();
