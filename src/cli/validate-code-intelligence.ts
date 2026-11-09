/** Explicit development-only verification. Never runs an AI provider or modifies business source. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool, one, q } from "../db/pool.ts";
import { migrate, loadMigrations } from "../db/migrate.ts";
import { startInstanceHeartbeat } from "../instances.ts";
import { repositories, rankRepositories } from "../repos/service.ts";
import { validateCheckout } from "../repos/paths.ts";
import {
  enqueue,
  runIndexOnce,
  indexRepository,
  status,
} from "../codeIntelligence/indexer.ts";
import {
  searchSymbols,
  findDependencies,
  hybridRank,
  buildCodeContext,
} from "../codeIntelligence/search.ts";
import { git, baseCommit } from "../codeIntelligence/git.ts";
import { effectiveSql } from "../codeIntelligence/store.ts";
import { definitions } from "../workflow/definitions.ts";
import { startRun, cancelRun } from "../workflow/engine.ts";
import { recordWorkspace } from "../git/provider.ts";

// Writes to a remote database require an explicit database name in the command, checked against server identity.
const expected = process.argv[2];
if (!expected)
  throw new Error(
    "Usage: validate-code-intelligence.ts <authorized-development-database-name>",
  );
const selected = ["oms-api", "oms-frontend", "oms-background"];
const report: any = {
  generated_at: new Date().toISOString(),
  repositories: [],
  overlays: {},
  live_ai_tokens: "NOT VERIFIED: no paid provider invoked",
};
const created: Array<{ root: string; path: string; run: number }> = [];
let heartbeat: Awaited<ReturnType<typeof startInstanceHeartbeat>> | undefined;
const timed = async <T>(f: () => Promise<T>) => {
  const at = performance.now();
  const result = await f();
  return { ms: performance.now() - at, result };
};
try {
  const identity = await one(
    pool,
    "SELECT current_database() AS database,inet_server_addr()::text AS server",
  );
  assert.equal(
    identity!.database,
    expected,
    "Development database identity mismatch",
  );
  assert.equal(config.codeIntelligence.enabled, true);
  report.database = identity;
  const applied = await one(
    pool,
    "SELECT checksum FROM schema_migrations WHERE version=26",
  );
  assert.ok(
    !applied ||
    applied.checksum ===
    loadMigrations().find((m) => m.version === 26)!.checksum,
    "Migration checksum mismatch",
  );
  report.migrations = await migrate();
  heartbeat = await startInstanceHeartbeat();
  report.instance_lease = "normal registration acquired";
  for (const name of selected) {
    const repo = await repositories.get(name);
    assert.ok(repo?.enabled && repo.allowed_actions.includes("read"));
    const root = await validateCheckout(repo);
    const before = await git(root, ["status", "--porcelain=v1", "-z"]);
    const queued = await enqueue(name);
    assert.ok(queued);
    const at = performance.now();
    let n = 0;
    while (
      (await one(
        pool,
        "SELECT status FROM code_intelligence.runs WHERE id=$1",
        [queued.id],
      ))!.status === "queued" &&
      n++ < 50
    )
      await runIndexOnce();
    const job = await one(
      pool,
      "SELECT status,metrics,error,snapshot_id FROM code_intelligence.runs WHERE id=$1",
      [queued.id],
    );
    assert.equal(job!.status, "done", JSON.stringify(job));
    const samples = await q(
      pool,
      `WITH f AS (${effectiveSql}) SELECT f.file_path,s.symbol_name,s.qualified_name,s.symbol_kind FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id WHERE s.symbol_kind IN ('function','method','interface','struct','class','rpc','table') AND length(s.symbol_name)>5 ORDER BY s.symbol_kind,f.file_path,s.start_byte LIMIT 15`,
      [job!.snapshot_id],
    );
    assert.ok(samples.length);
    const sample =
      samples.find(
        (s) => s.symbol_kind === "function" || s.symbol_kind === "method",
      ) ?? samples[0];
    const scope = { repositories: [name], allowed: [name] };
    const lookup = await timed(() =>
      searchSymbols(sample.qualified_name, scope),
    );
    assert.ok(
      lookup.result.hits.some(
        (h) => h.qualified_name === sample.qualified_name,
      ),
    );
    const relations = await findDependencies(sample.qualified_name, scope, 1);
    const metadata = await timed(async () =>
      rankRepositories([repo], { text: sample.symbol_name }),
    );
    const hybrid = await timed(() =>
      hybridRank([repo], { text: sample.symbol_name }),
    );
    const context = await timed(() =>
      buildCodeContext(sample.qualified_name, scope),
    );
    assert.ok(context.result.body.length);
    assert.ok(
      context.result.body.length <= config.codeIntelligence.contextTokens * 4,
    );
    const languages = await q(
      pool,
      `WITH f AS (${effectiveSql}) SELECT e.language,count(*)::int AS files FROM f JOIN code_intelligence.extractions e ON e.id=f.extraction_id GROUP BY e.language ORDER BY e.language`,
      [job!.snapshot_id],
    );
    const warm = await timed(() => indexRepository(name));
    assert.equal(
      await git(root, ["status", "--porcelain=v1", "-z"]),
      before,
      "Business checkout changed",
    );
    report.repositories.push({
      name,
      index_wall_ms: performance.now() - at,
      job,
      languages,
      sample: { ...sample },
      search_ms: lookup.ms,
      relations: relations.length,
      metadata_ms: metadata.ms,
      hybrid_ms: hybrid.ms,
      metadata_score: metadata.result[0].score,
      hybrid_score: hybrid.result[0].score,
      context_chars: context.result.body.length,
      context_ms: context.ms,
      warm_reindex_ms: warm.ms,
    });
  }
  const candidates = (await repositories.list()).filter((r) =>
    selected.includes(r.name),
  );
  report.scenarios = [];
  for (const indexed of report.repositories) {
    const query = indexed.sample.qualified_name;
    const text = `Investigate ${query}`;
    const scope = { repositories: selected, allowed: selected };
    const definitions = await searchSymbols(query, scope, 50);
    const exactRepositories = [
      ...new Set(
        definitions.hits
          .filter((h) => h.qualified_name === query)
          .map((h) => h.repository),
      ),
    ];
    const metadata = await timed(async () =>
      rankRepositories(candidates, { text }),
    );
    const hybrid = await timed(() => hybridRank(candidates, { text }));
    report.scenarios.push({
      query,
      expected_source_repository: indexed.name,
      exact_definition_repositories: exactRepositories,
      metadata_ms: metadata.ms,
      hybrid_ms: hybrid.ms,
      metadata_top: metadata.result[0].repo,
      hybrid_top: hybrid.result[0].repo,
      correct_selection:
        exactRepositories.length === 1
          ? hybrid.result[0].repo === indexed.name
          : "AMBIGUOUS: syntax name exists in multiple repositories",
      ranked: hybrid.result,
    });
  }
  const repo = (await repositories.get(selected[0]))!;
  const root = await validateCheckout(repo);
  const base = await baseCommit(root);
  const before = await git(root, ["status", "--porcelain=v1", "-z"]);
  const owner = await one(
    pool,
    "SELECT id FROM users WHERE active ORDER BY (role='admin') DESC,id LIMIT 1",
  );
  assert.ok(owner, "An existing development user is required");
  const key = `p1-validate-${Date.now()}`;
  await definitions.create({
    key,
    ownerId: owner.id,
    spec: {
      name: "Disposable P1 validation",
      steps: [
        {
          key: "hold",
          type: "human_input",
          config: { question: "Disposable source-index validation" },
        },
      ],
    },
  });
  for (let i = 0; i < 2; i++) {
    const run = await startRun({
      definitionKey: key,
      ownerId: owner.id,
      title: `P1 disposable overlay ${i}`,
      repositories: [repo.name],
      start: false,
    });
    const path = join(config.dataDir, `p1-validation-${run.id}`);
    await git(root, ["worktree", "add", "--detach", path, base]);
    created.push({ root, path, run: run.id });
    await recordWorkspace(run.id, {
      repo: repo.name,
      path,
      branch: "HEAD",
      created_from: base,
    });
    await writeFile(
      join(path, "p1_validation_probe.go"),
      `package p1validation\nfunc P1ValidationOnly${i}() {}\n`,
    );
  }
  const overlays = await Promise.all(
    created.map((w) => indexRepository(repo.name, w.run)),
  );
  for (let i = 0; i < created.length; i++) {
    const scope = {
      repositories: [repo.name],
      allowed: [repo.name],
      runId: created[i].run,
    };
    assert.ok(
      (await searchSymbols(`P1ValidationOnly${i}`, scope)).hits.some(
        (h) => h.symbol_name === `P1ValidationOnly${i}`,
      ),
    );
    assert.equal(
      (await searchSymbols(`P1ValidationOnly${1 - i}`, scope)).hits.length,
      0,
      "Concurrent worktrees contaminated",
    );
  }
  const a = created[0];
  const scope = {
    repositories: [repo.name],
    allowed: [repo.name],
    runId: a.run,
  };
  await writeFile(
    join(a.path, "p1_validation_probe.go"),
    "package p1validation\nfunc P1ValidationUpdated() {}\n",
  );
  const stale = await searchSymbols("P1ValidationOnly0", scope);
  assert.equal(stale.hits.length, 0);
  assert.ok(stale.fallback_count);
  await indexRepository(repo.name, a.run);
  assert.ok(
    (await searchSymbols("P1ValidationUpdated", scope)).hits.some(
      (h) => h.symbol_name === "P1ValidationUpdated",
    ),
  );
  await rename(
    join(a.path, "p1_validation_probe.go"),
    join(a.path, "p1_validation_renamed.go"),
  );
  await indexRepository(repo.name, a.run);
  assert.ok(
    (await searchSymbols("P1ValidationUpdated", scope)).hits.every(
      (h) => h.file_path === "p1_validation_renamed.go",
    ),
  );
  await unlink(join(a.path, "p1_validation_renamed.go"));
  await indexRepository(repo.name, a.run);
  assert.equal(
    (await searchSymbols("P1ValidationUpdated", scope)).hits.length,
    0,
  );
  assert.equal(
    (
      await searchSymbols("P1ValidationOnly0", {
        repositories: [repo.name],
        allowed: [repo.name],
      })
    ).hits.length,
    0,
  );
  assert.equal(await git(root, ["status", "--porcelain=v1", "-z"]), before);
  report.overlays = {
    concurrent_worktrees: 2,
    modified: "PASS",
    renamed: "PASS",
    deleted: "PASS",
    stale_fallback: "PASS",
    base_unaffected: "PASS",
    primary_checkout_unchanged: "PASS",
    snapshot_ids: overlays.map((x) => x.snapshot.id),
  };
  config.codeIntelligence.enabled = false;
  assert.equal(
    (await searchSymbols("P1ValidationUpdated", scope)).hits.length,
    0,
  );
  config.codeIntelligence.enabled = true;
  report.disable = "PASS";
  report.status = (await status()).filter((r) => selected.includes(r.name));
} finally {
  if (created.length)
    await q(
      pool,
      "UPDATE code_intelligence.runs SET status='canceled',fencing_token=fencing_token+1,updated_at=now() WHERE instance_id=$1 AND run_id=ANY($2::bigint[]) AND status IN ('queued','running')",
      [config.instanceId, created.map((w) => w.run)],
    ).catch(() => { });
  for (const w of created) {
    await git(w.root, ["worktree", "remove", "--force", w.path]).catch(
      () => { },
    );
    await cancelRun(w.run).catch(() => { });
  }
  await heartbeat?.stop();
  await pool.end();
}
await mkdir("docs/validation", { recursive: true });
await writeFile(
  "docs/validation/p1-real-repositories.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    report: "docs/validation/p1-real-repositories.json",
    repositories: report.repositories.map((r: any) => ({
      name: r.name,
      status: r.job.status,
      files: r.job.metrics.indexed_files,
      languages: r.languages,
    })),
    overlays: report.overlays,
  }),
);
