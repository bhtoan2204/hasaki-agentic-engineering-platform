/**
 * A second platform process for test/knowledge-import-concurrency.integration.ts: inherits the test's environment
 * (same configuration and database) and either imports (`import`) or takes the publication lock, writes one item
 * and then hangs inside it until killed (`hold`), as a process that crashes mid-publication.
 */
import { importFromRepositories, serializedImport } from "../../src/knowledge/importer.ts";
import { knowledge } from "../../src/knowledge/service.ts";
import { pool } from "../../src/db/pool.ts";

const mode = process.argv[2];
if (mode === "import") {
  const r = await importFromRepositories();
  process.stdout.write(JSON.stringify({ created: r.created, updated: r.updated }) + "\n");
  await pool.end();
} else if (mode === "hold") {
  await serializedImport(false, async () => {
    await knowledge.createWithoutReload({
      key: "crash.half-published",
      category: "domain_knowledge",
      scope_type: "GLOBAL",
      title: "written before the crash",
      content: "one complete item",
      created_by: "crashing import",
    });
    process.stdout.write("locked\n");
    await new Promise(() => {}); // killed here, lock held
  });
}
