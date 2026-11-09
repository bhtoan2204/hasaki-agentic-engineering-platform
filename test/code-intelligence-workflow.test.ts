import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.ts";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { repositories, rankRepositories } from "../src/repos/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun, answerQuestions, getRun } from "../src/workflow/engine.ts";
import { runOnce, drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { integrationExecutor } from "../src/workflow/executors/builtin.ts";
import { claudeExecutor } from "../src/agent/claude.ts";
import { recordWorkspace } from "../src/git/provider.ts";
import {
  indexRepository,
  runIndexOnce,
  enqueue,
} from "../src/codeIntelligence/indexer.ts";

const a = "ci-proof-a",
  z = "ci-proof-z";
const bin = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const log = join(process.env.TEST_ROOT!, "p1-prompt-log.jsonl");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" }).trim();
const logs = () =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s))
    .filter((r) => r.argv);
const block = (prompt: string) =>
  /<untrusted_input source="code_intelligence">([\s\S]*?)<\/untrusted_input>/.exec(
    prompt,
  )?.[1] ?? "";
before(async () => {
  await migrate();
  config.codeIntelligence.enabled = true;
  config.codeIntelligence.contextTokens = 200;
  config.learning.detectChanges = false;
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_MODE = "ok";
  for (const name of [a, z]) {
    const root = join(config.reposRoot, name);
    mkdirSync(root);
    git(root, "init", "-q", "-b", config.baseBranch);
    writeFileSync(
      join(root, "refund.go"),
      `package payment\nfunc ${name === z ? "FulfillRefund" : "UnrelatedOperation"}() int { return 1 }\n`,
    );
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    await repositories.upsert(name, { projects: ["Proof"] });
    await indexRepository(name);
  }
  registerExecutor("agent", claudeExecutor);
  registerExecutor("coding_agent", claudeExecutor);
  registerExecutor("integration", integrationExecutor);
  await definitions.create({
    key: "p1-provider-proof",
    spec: {
      name: "P1 provider proof",
      steps: [
        { key: "analyze", type: "agent" },
        {
          key: "discover",
          type: "integration",
          depends_on: ["analyze"],
          config: { action: "repository_discovery", use_ai: false },
        },
        {
          key: "implement",
          type: "coding_agent",
          depends_on: ["discover"],
          config: { verify: false, output_contract: "{ goal, requirements }" },
        },
      ],
    },
  });
});
after(async () => {
  for (const key of ["CODEX_BIN", "FAKE_CODEX_LOG", "FAKE_CODEX_MODE"])
    delete process.env[key];
  await pool.end();
});
test("Actual analysis → discovery → ranking → shared executor → Codex process receives indexed source; resume refreshes changed worktree", async () => {
  const rows = (await repositories.list()).filter((r) =>
    [a, z].includes(r.name),
  );
  assert.equal(
    rankRepositories(rows, { text: "FulfillRefund", project: "Proof" })[0].repo,
    a,
    "metadata ties prefer a",
  );
  const run = await startRun({
    definitionKey: "p1-provider-proof",
    title: "FulfillRefund",
    inputs: { project: "Proof" },
    agentProvider: "codex",
  });
  const root = join(config.reposRoot, z),
    path = join(config.dataDir, `proof-${run.id}`);
  git(root, "worktree", "add", "--detach", path, "HEAD");
  await recordWorkspace(run.id, {
    repo: z,
    path,
    branch: "HEAD",
    created_from: "base",
  });
  await indexRepository(z, run.id);
  assert.ok(await runOnce());
  assert.ok(await runOnce());
  const discovery = await one(
    pool,
    "SELECT output FROM workflow_steps WHERE run_id=$1 AND key='discover'",
    [run.id],
  );
  assert.equal(discovery!.output.candidates[0].repo, z);
  assert.ok(
    discovery!.output.candidates[0].reasons.some((r: string) =>
      r.includes("code evidence"),
    ),
  );
  assert.deepEqual((await getRun(run.id)).selected_repositories, [z]);
  process.env.FAKE_CODEX_MODE = "ask";
  assert.ok(await runOnce());
  const prompt = logs().at(-1).prompt;
  const code = block(prompt);
  assert.match(code, /ci-proof-z\/refund.go:2-2/);
  assert.match(code, /return 1/);
  assert.match(code, /worktree_run=/);
  assert.match(code, /commit=[a-f0-9]{40}/);
  assert.equal(
    (code.match(/ci-proof-z\/refund.go:/g) ?? []).length,
    1,
    "deduplicated snippet provenance",
  );
  assert.ok(code.length <= config.codeIntelligence.contextTokens * 4 + 4);
  const step = await one(
    pool,
    "SELECT status,current_attempt_id FROM workflow_steps WHERE run_id=$1 AND key='implement'",
    [run.id],
  );
  assert.equal(step!.status, "WAITING_INPUT");
  const metrics = await one(
    pool,
    "SELECT metrics FROM workflow_step_attempts WHERE id=$1",
    [step!.current_attempt_id],
  );
  assert.ok(metrics!.metrics.code_intelligence.retrieved_context_size > 0);
  writeFileSync(
    join(path, "refund.go"),
    "package payment\nfunc FulfillRefund() int { return 2 }\n",
  );
  const question = await one(
    pool,
    "SELECT id FROM workflow_questions WHERE run_id=$1 AND status='open'",
    [run.id],
  );
  process.env.FAKE_CODEX_MODE = "ok";
  await answerQuestions({ [question!.id]: "Không" }, "test");
  assert.ok(await runOnce());
  const resumed = logs().at(-1);
  assert.equal(resumed.resumeId, "th-1");
  assert.match(block(resumed.prompt), /return 2/);
  assert.doesNotMatch(block(resumed.prompt), /return 1/);
  assert.equal((await getRun(run.id)).status, "COMPLETED");
});
test("Disabling P1 keeps actual agent workflow functional and removes the code context block", async () => {
  config.codeIntelligence.enabled = false;
  const run = await startRun({
    definitionKey: "p1-provider-proof",
    title: "FulfillRefund",
    inputs: { project: "Proof" },
    agentProvider: "codex",
  });
  await drain();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  assert.equal(block(logs().at(-1).prompt), "");
  config.codeIntelligence.enabled = true;
});
test("Concurrent idle callers respect the configured indexing concurrency before awaiting ownership", async () => {
  await q(pool, "DELETE FROM code_intelligence.runs");
  config.codeIntelligence.concurrency = 1;
  await enqueue(a);
  await enqueue(z);
  const results = await Promise.all([
    runIndexOnce(),
    runIndexOnce(),
    runIndexOnce(),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    (await one(
      pool,
      "SELECT count(*)::int AS n FROM code_intelligence.runs WHERE status='queued'",
    ))!.n,
    1,
  );
});

test("Early path matches cannot starve an exact definition in a later registered repository", async () => {
  const { searchSymbols } = await import("../src/codeIntelligence/search.ts");
  const root = join(config.reposRoot, a);
  for (let i = 0; i < 8; i++)
    writeFileSync(
      join(root, `FulfillRefund-${i}.go`),
      `package other\nfunc Other${i}() {}\n`,
    );
  git(root, "add", ".");
  git(root, "commit", "-qm", "path distractors");
  await indexRepository(a);
  const found = await searchSymbols(
    "FulfillRefund",
    { repositories: [a, z], allowed: [a, z] },
    3,
  );
  assert.equal(found.hits[0].repository, z);
  assert.equal(found.hits[0].symbol_name, "FulfillRefund");
});

test("A fresh index without a definition still falls back to exact source search", async () => {
  const { searchSymbols } = await import("../src/codeIntelligence/search.ts");
  const root = join(config.reposRoot, a);
  writeFileSync(
    join(root, "literal.go"),
    'package other\nfunc Example() string { return "SourceLiteralNeedle" }\n',
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "literal fixture");
  await indexRepository(a);
  const found = await searchSymbols("Investigate SourceLiteralNeedle", {
    repositories: [a],
    allowed: [a],
  });
  assert.ok(found.fallback_count > 0);
  assert.ok(
    found.hits.some(
      (h) => h.match_type === "text" && h.file_path === "literal.go",
    ),
  );
});

test("Missing ripgrep is visible to exact search and does not abort hybrid discovery", async () => {
  const { mkdtempSync, symlinkSync } = await import("node:fs");
  const { searchCodeExact, searchSymbols } =
    await import("../src/codeIntelligence/search.ts");
  const directory = mkdtempSync(join(process.env.TEST_ROOT!, "git-only-"));
  symlinkSync(
    execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
    join(directory, "git"),
  );
  const path = process.env.PATH;
  try {
    process.env.PATH = directory;
    const scope = { repositories: [a], allowed: [a] };
    await assert.rejects(
      searchCodeExact("NoSuchNeedle", scope),
      /ripgrep unavailable/,
    );
    const result = await searchSymbols("NoSuchNeedle", scope);
    assert.equal(result.hits.length, 0);
    assert.ok(result.fallback_count > 0);
  } finally {
    process.env.PATH = path;
  }
});
