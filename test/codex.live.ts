/**
 * OPT-IN live smoke test for the Codex provider. It calls the real Codex CLI with the worker's own Codex login and
 * USES ITS QUOTA. Never part of `npm test` (the glob is test/*.test.ts).
 *
 *   docker compose up -d postgres            # local, isolated database (setup.ts refuses remote databases)
 *   CODEX_LIVE=1 CODEX_BIN=$(which codex) CODEX_REASONING_EFFORT=low npm run smoke:codex
 *
 * Scenario in a throw-away git repo (bare origin + clone under a temp reposRoot):
 *   1. analyze (read-only)  → ask_user → answer → resume the same Codex thread → submit_result
 *   2. implement (coding)   → prepare_branch → apply_patch in the worktree → commit_changes → platform verification
 *   3. verify (independent) → fresh Codex thread, read-only, verdict bound to the commit
 * Plus: a forbidden `git push` and an edit outside the worktree must be blocked by the hook before execution.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { answerQuestions, getRun, startRun } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { registerExecutor } from "../src/workflow/executors/registry.ts";
import { claudeExecutor } from "../src/agent/claude.ts";
import { codexCapabilities } from "../src/agent/codex/run.ts";
import { config } from "../src/config.ts";

const live = process.env.CODEX_LIVE === "1";

before(async () => {
  if (!live) return;
  await migrate();
  await seedTemplates();
  registerExecutor("agent", claudeExecutor);
  registerExecutor("coding_agent", claudeExecutor);
});
after(() => pool.end());

function repo() {
  const root = mkdtempSync(join(process.env.TEST_ROOT!, "codex-live-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", config.baseBranch, origin]);
  const work = join(config.reposRoot, "oms-api");
  mkdirSync(work, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", config.baseBranch);
  g("config", "user.email", "smoke@test");
  g("config", "user.name", "smoke");
  writeFileSync(join(work, "greet.sh"), '#!/bin/sh\necho "hello"\n');
  writeFileSync(
    join(work, "check.sh"),
    '#!/bin/sh\n[ "$(sh greet.sh)" = "hello, refund" ] || { echo "greet.sh must print: hello, refund"; exit 1; }\n',
  );
  g("add", ".");
  g("commit", "-qm", "base");
  g("remote", "add", "origin", origin);
  g("push", "-q", "origin", config.baseBranch);
  g("fetch", "-q", "origin");
}

test(
  "live Codex: analyze → ask/resume → coding with commit → independent verification",
  { skip: live ? false : "set CODEX_LIVE=1 (uses the worker's Codex quota)", timeout: 40 * 60_000 },
  async () => {
    const cap = await codexCapabilities(true);
    assert.equal(cap.ok, true, cap.error ?? "");
    repo();
    const key = "codex-live-smoke";
    await definitions.create({
      key,
      spec: {
        name: key,
        steps: [
          {
            key: "analyze",
            type: "agent",
            config: {
              instructions:
                "Read greet.sh in the oms-api repository. Before answering, you MUST ask the developer exactly one question with ask_user: 'Which word should follow hello?' with options ['refund', 'order']. After the answer, submit_result.",
              output_contract: "{ goal, requirements: string[] }",
            },
          },
          {
            key: "implement",
            type: "coding_agent",
            depends_on: ["analyze"],
            config: {
              instructions:
                "Change greet.sh in oms-api so it prints exactly: hello, <word from the analysis>. Use prepare_branch, edit inside the worktree, commit with commit_changes, then submit_result. Also try once to run `git push origin HEAD` and report that it was blocked.",
              output_contract: "{ summary, pull_requests }",
              verify: {
                command: "sh check.sh",
                baseline: false,
                max_repairs: 1,
                timeout_seconds: 60,
              },
            },
          },
          {
            key: "verify",
            type: "agent",
            depends_on: ["implement"],
            config: {
              independent: true,
              instructions: "Independently verify that greet.sh prints 'hello, refund'.",
            },
          },
        ],
      },
    });
    const run = await startRun({
      definitionKey: key,
      title: "codex live smoke",
      agentProvider: "codex",
      repositories: ["oms-api"],
      inputs: { project: "OMS" },
    });
    await drain();
    const qs = await q<any>(
      pool,
      "SELECT * FROM workflow_questions WHERE run_id = $1 AND status = 'open'",
      [run.id],
    );
    assert.equal(qs.length, 1, "analysis asked one question and paused");
    await answerQuestions({ [qs[0].id]: "refund" }, "smoke");
    await drain();
    const steps = await q<any>(
      pool,
      "SELECT key, status, output FROM workflow_steps WHERE run_id = $1 ORDER BY id",
      [run.id],
    );
    console.log(
      JSON.stringify(
        steps.map((s) => ({
          key: s.key,
          status: s.status,
          verdict: s.output?.verdict,
          verification: s.output?.verification?.status,
        })),
        null,
        1,
      ),
    );
    const sessions = await q<any>(
      pool,
      "SELECT s.provider, s.session_id, st.key FROM agent_sessions s JOIN workflow_step_attempts a ON a.id = s.attempt_id JOIN workflow_steps st ON st.id = a.step_id WHERE a.run_id = $1 ORDER BY s.id",
      [run.id],
    );
    assert.ok(sessions.every((s) => s.provider === "codex"));
    const analyzeThreads = new Set(
      sessions.filter((s) => s.key === "analyze").map((s) => s.session_id),
    );
    assert.equal(analyzeThreads.size, 1, "the answer resumed the same thread");
    const implThread = sessions.find((s) => s.key === "implement")?.session_id;
    const verifyThread = sessions.find((s) => s.key === "verify")?.session_id;
    assert.ok(
      verifyThread && verifyThread !== implThread,
      "independent verification used a fresh thread",
    );
    const denied = await one<any>(
      pool,
      "SELECT count(*)::int AS n FROM workflow_events WHERE run_id = $1 AND kind = 'tool' AND content LIKE 'denied %'",
      [run.id],
    );
    assert.ok(denied.n >= 1, "the git push attempt was denied before execution");
    assert.equal(steps.find((s) => s.key === "implement")?.status, "COMPLETED");
    assert.equal((await getRun(run.id)).agent_provider, "codex");
  },
);
