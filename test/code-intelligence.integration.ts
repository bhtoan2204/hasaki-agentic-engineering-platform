import { indexedCodebaseMap } from "../src/knowledge/codebaseMap.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, unlinkSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.ts";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { repositories, rankRepositories } from "../src/repos/service.ts";
import { indexRepository, enqueue, runIndexOnce } from "../src/codeIntelligence/indexer.ts";
import {
  searchSymbols,
  findReferences,
  findDependencies,
  searchCodeExact,
  findDefinitions,
  hybridRank,
  applyEvidence,
  buildCodeContext,
  fresh,
} from "../src/codeIntelligence/search.ts";
import { changes, readSource, safePath } from "../src/codeIntelligence/git.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { recordWorkspace } from "../src/git/provider.ts";
import { publish } from "../src/codeIntelligence/store.ts";
import { parserVersion } from "../src/codeIntelligence/parser.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
const name = "ci-pay";
let root: string;
let runA: number, runB: number;
let wtA: string, wtB: string;
const source = (fn: string) => `package pay\nfunc ${fn}() {}\n`;
const scope = (runId?: number) => ({
  repositories: [name],
  allowed: [name],
  runId,
});
const names = async (run?: number) =>
  (
    await searchSymbols("Original Modified Added Branch Committed Renamed", scope(run), 100)
  ).hits.map((h) => h.symbol_name);
before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  config.codeIntelligence.enabled = true;
  root = join(config.reposRoot, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", config.baseBranch);
  writeFileSync(join(root, "pay.go"), source("Original"));
  writeFileSync(join(root, "delete.go"), source("Deleted"));
  writeFileSync(
    join(root, "pay.proto"),
    'syntax="proto3"; package pay; message Req {} message Res {} service Payment { rpc Charge(Req) returns(Res); }',
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  await repositories.upsert(name, { projects: ["CI"] });
  await definitions.create({
    key: "ci-fixture",
    spec: {
      name: "CI fixture",
      steps: [{ key: "hold", type: "human_input", config: { question: "hold" } }],
    },
  });
  for (const n of ["A", "B"]) {
    const r = await startRun({
      definitionKey: "ci-fixture",
      title: `CI ${n}`,
      repositories: [name],
      inputs: { project: "CI" },
      start: false,
    });
    const path = join(config.dataDir, `ci-${n}`);
    git(root, "worktree", "add", "-qb", `ci-${n}`, path);
    await recordWorkspace(r.id, {
      repo: name,
      path,
      branch: `ci-${n}`,
      created_from: "base",
    });
    if (n === "A") {
      runA = r.id;
      wtA = path;
    } else {
      runB = r.id;
      wtB = path;
    }
  }
});
after(() => pool.end());
test("Initial base snapshot, exact and qualified definitions; immutable publication deduplication", async () => {
  const [a, b] = await Promise.all([indexRepository(name), indexRepository(name)]);
  assert.equal(a.snapshot.id, b.snapshot.id);
  const exact = await searchSymbols("Original", scope());
  assert.equal(exact.hits[0].qualified_name, "pay.Original");
  assert.equal((await searchSymbols("pay.Original", scope())).hits[0].match_type, "qualified");
  assert.equal(
    (await one(
      pool,
      "SELECT count(*)::int AS n FROM code_intelligence.snapshots WHERE repository_id=$1",
      [a.snapshot.repository_id],
    ))!.n,
    1,
  );
});
test("Concurrent worktrees: modified tracked, untracked, deleted, renamed and unchanged base mappings", async () => {
  writeFileSync(join(wtA, "pay.go"), source("Modified"));
  writeFileSync(join(wtA, "new.go"), source("Added"));
  unlinkSync(join(wtA, "delete.go"));
  renameSync(join(wtB, "pay.go"), join(wtB, "renamed.go"));
  await Promise.all([indexRepository(name, runA), indexRepository(name, runB)]);
  const a = await names(runA);
  assert.ok(a.includes("Modified") && a.includes("Added"));
  assert.ok(!a.includes("Original"));
  assert.equal((await searchSymbols("Deleted", scope(runA))).hits.length, 0);
  const b = await searchSymbols("Original", scope(runB));
  assert.deepEqual(
    b.hits.map((h) => h.file_path),
    ["renamed.go"],
  );
  assert.ok((await names()).includes("Original"));
});
test("Stale overlay returns bounded live fallback, never old indexed symbols; context is bounded", async () => {
  writeFileSync(join(wtA, "pay.go"), source("Committed"));
  assert.equal((await fresh(name, runA)).index, null);
  assert.equal(await indexedCodebaseMap([name], runA, 2000), "");
  const stale = await searchSymbols("Modified", scope(runA));
  assert.equal(stale.hits.length, 0);
  assert.equal(stale.fallback_count, 1);
  assert.ok(
    (await searchSymbols("Committed", scope(runA))).hits.every((h) => h.snapshot.id === null),
  );
  // A stale index never yields "no definition" silently: text matches are surfaced as unresolved candidates.
  const defs = await findDefinitions("Committed", scope(runA));
  assert.equal(defs.fallback_count, 1);
  assert.equal(defs.hits.length, 0, "text matches are not definitions");
  assert.ok(
    defs.text_candidates.length >= 1 && defs.text_candidates.every((h) => h.match_type === "text"),
  );
  const report = { unavailable: [] as string[] };
  await findDependencies("Committed", scope(runA), 1, "out", report);
  assert.deepEqual(
    report.unavailable,
    [name],
    "a repository without a fresh index is reported, not skipped silently",
  );
  // Exact text search reaches config files outside the indexed languages, never secret files.
  writeFileSync(join(wtA, "app.yaml"), "payment_timeout: 30s\n");
  writeFileSync(join(wtA, ".env"), "payment_timeout=leaked\n");
  const cfgHits = await searchCodeExact("payment_timeout", scope(runA), 10, { anyFile: true });
  assert.deepEqual(
    cfgHits.map((h) => h.file_path),
    ["app.yaml"],
  );
  assert.deepEqual(
    await searchCodeExact("payment_timeout", scope(runA), 10),
    [],
    "code fallback stays on indexed languages",
  );
  rmSync(join(wtA, "app.yaml"));
  rmSync(join(wtA, ".env"));
  await indexRepository(name, runA);
  const code = await buildCodeContext("Committed Added", scope(runA));
  assert.match(code.body, /commit=/);
  assert.ok(code.body.length <= config.codeIntelligence.contextTokens * 4);
});
test("Commit, branch checkout and main advancement create new identities and reuse extraction results", async () => {
  git(wtA, "add", "-A");
  git(wtA, "commit", "-qm", "worktree commit");
  const a = await indexRepository(name, runA);
  assert.equal(a.snapshot.commit_sha, git(wtA, "rev-parse", "HEAD"));
  git(wtA, "checkout", "-qb", "ci-other");
  writeFileSync(join(wtA, "branch.go"), source("Branch"));
  git(wtA, "add", ".");
  git(wtA, "commit", "-qm", "branch");
  assert.equal((await fresh(name, runA)).index, null);
  await indexRepository(name, runA);
  assert.ok((await names(runA)).includes("Branch"));
  writeFileSync(join(root, "newbase.go"), source("Advanced"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "advance");
  const base = await indexRepository(name);
  assert.ok(base.metrics.index_cache_hits >= 3);
  assert.equal((await fresh(name, runA)).index, null);
  await indexRepository(name, runA);
  assert.equal(
    (await searchSymbols("Advanced", scope(runA))).hits.length,
    0,
    "new base file absent in old branch is masked",
  );
});
test("Proto dependency candidates and references retain evidence, cross-repo definitions discoverable", async () => {
  const deps = await findDependencies("pay.Payment.Charge", scope(), 2);
  assert.ok(deps.some((r) => r.target_name === "Req" && r.resolution === "candidate"));
  const refs = await findReferences("Req", scope());
  assert.ok(refs.some((r) => r.relation_type === "RPC_REQUEST"));
  const other = "ci-proto";
  const dir = join(config.reposRoot, other);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", config.baseBranch);
  writeFileSync(join(dir, "common.proto"), 'syntax="proto3"; package shared; message Req {}');
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "proto");
  await repositories.upsert(other, { projects: ["CI"] });
  await indexRepository(other);
  const hits = await searchSymbols("Req", {
    repositories: [name, other],
    allowed: [name, other],
  });
  assert.equal(new Set(hits.hits.map((h) => h.repository)).size, 2);
});
test("ripgrep exact fallback, unauthorized repositories, traversal and symlink access rejection", async () => {
  assert.ok(
    (await searchCodeExact("Committed", scope(runA))).some((h) => h.file_path === "pay.go"),
  );
  await assert.rejects(
    searchSymbols("Original", { repositories: [name], allowed: [] }),
    /Unauthorized/,
  );
  assert.throws(() => safePath(root, "../secret.go"), /Unsafe/);
  const outside = join(config.dataDir, "outside.go");
  writeFileSync(outside, source("Secret"));
  symlinkSync(outside, join(wtA, "escape.go"));
  await assert.rejects(readSource(wtA, "escape.go"), /symlink/);
  assert.equal((await searchCodeExact("Secret", scope(runA))).length, 0);
});
test("Deterministic ranking cap and tie handling; disabled feature preserves metadata ranking", async () => {
  const rows = await repositories.list();
  config.codeIntelligence.enabled = false;
  assert.deepEqual(
    await hybridRank(rows, { text: "pay", project: "CI" }),
    rankRepositories(rows, { text: "pay", project: "CI" }),
  );
  config.codeIntelligence.enabled = true;
  assert.deepEqual(
    applyEvidence(
      [
        { repo: "b", score: 3, reasons: [] },
        { repo: "a", score: 3, reasons: [] },
      ],
      [],
    ).map((r) => r.repo),
    ["a", "b"],
  );
  const hit = (await searchSymbols("Original", scope())).hits[0];
  assert.ok(
    applyEvidence([{ repo: name, score: 0, reasons: [] }], Array(20).fill(hit))[0].score <=
      config.codeIntelligence.weights.cap,
  );
});
test("Durable queue deduplication, expired lease restart recovery and cancellation fence", async () => {
  await q(pool, "DELETE FROM code_intelligence.runs");
  const [a, b] = await Promise.all([enqueue(name), enqueue(name)]);
  assert.equal(a!.id, b!.id);
  await q(
    pool,
    "UPDATE code_intelligence.runs SET status='running',attempts=1,fencing_token=1,lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [a!.id],
  );
  assert.equal(await runIndexOnce(), true);
  assert.equal(
    (await one(pool, "SELECT status FROM code_intelligence.runs WHERE id=$1", [a!.id]))!.status,
    "done",
  );
  const c = await enqueue(name);
  await q(pool, "UPDATE code_intelligence.runs SET status='canceled',fencing_token=3 WHERE id=$1", [
    c!.id,
  ]);
  await assert.rejects(
    publish(
      {
        repository_id: (await repositories.get(name))!.id,
        commit_sha: "never",
        identity: "never",
      },
      [],
      { id: c!.id, token: 2 },
    ),
    /lease lost/,
  );
  await q(
    pool,
    "UPDATE code_intelligence.runs SET status='running',attempts=3,lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [c!.id],
  );
  await runIndexOnce();
  assert.equal(
    (await one(pool, "SELECT status FROM code_intelligence.runs WHERE id=$1", [c!.id]))!.status,
    "failed",
  );
});
test("Index failure preserves last good snapshot; worktree recreation changes generation; parser upgrades change index identity", async () => {
  const before = (await changes(wtB, git(root, "rev-parse", "HEAD"))).generation;
  const marker = join(wtB, ".git");
  const fs = await import("node:fs");
  const text = fs.readFileSync(marker, "utf8");
  unlinkSync(marker);
  writeFileSync(marker, text);
  assert.notEqual((await changes(wtB, git(root, "rev-parse", "HEAD"))).generation, before);
  const old = config.codeIntelligence.maxScanBytes;
  config.codeIntelligence.maxScanBytes = 1;
  try {
    writeFileSync(join(root, "extra.go"), source("Extra"));
    git(root, "add", ".");
    git(root, "commit", "-qm", "extra");
    await assert.rejects(indexRepository(name), /limit/);
  } finally {
    config.codeIntelligence.maxScanBytes = old;
  }
  assert.ok((await one(pool, "SELECT count(*)::int AS n FROM code_intelligence.snapshots"))!.n > 0);
  const version = parserVersion();
  config.codeIntelligence.maxSymbols++;
  assert.notEqual(parserVersion(), version);
  config.codeIntelligence.maxSymbols--;
});

test("DAG coding step completes with an empty index using live source context", async () => {
  const { registerExecutor } = await import("../src/workflow/executors/registry.ts");
  const { integrationExecutor } = await import("../src/workflow/executors/builtin.ts");
  const { drain } = await import("../src/workflow/scheduler.ts");
  const repo = "ci-unindexed";
  const path = join(config.reposRoot, repo);
  mkdirSync(path);
  git(path, "init", "-q", "-b", config.baseBranch);
  writeFileSync(join(path, "live.go"), source("LiveFallback"));
  git(path, "add", ".");
  git(path, "commit", "-qm", "live");
  await repositories.upsert(repo, { projects: ["CI"] });
  let invoked = false;
  registerExecutor("integration", integrationExecutor);
  registerExecutor("coding_agent", {
    execute: async (ctx) => {
      const result = await buildCodeContext("LiveFallback", {
        repositories: [repo],
        allowed: ctx.run.allowed_repositories,
        runId: ctx.run.id,
      });
      assert.ok(result.metrics.fallback_count > 0);
      assert.match(result.body, /LiveFallback/);
      invoked = true;
      return {
        kind: "completed",
        output: { summary: "completed without populated index" },
      };
    },
  });
  await definitions.create({
    key: "ci-fallback-workflow",
    spec: { name: "Fallback", steps: [{ key: "code", type: "coding_agent" }] },
  });
  const run = await startRun({
    definitionKey: "ci-fallback-workflow",
    repositories: [repo],
    inputs: { project: "CI" },
  });
  await drain();
  assert.ok(invoked);
  assert.equal(
    (await one(pool, "SELECT status FROM workflow_runs WHERE id=$1", [run.id]))!.status,
    "COMPLETED",
  );
});
