/**
 * Reliable paired A/B evaluation (Milestone C) through the real Chat harness: variants are isolated per sample (no
 * process-global flag or provider seam is mutated, so concurrent Direct and CodeAct samples — and an ordinary
 * conversation running at the same time — cannot see each other's capability), pairs are admitted only when the sample
 * allowance and the estimated remaining budget cover both variants, and incomplete pairs are kept and reported.
 * Fixture tools; simulated / scripted providers (no paid call).
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser, type PublicUser } from "../src/auth/users.ts";
import { setCodeActLauncherForTests } from "../src/codeact/execute.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { setChatProviders } from "../src/chat/runtime.ts";
import { chat } from "../src/chat/service.ts";
import { settleBackground } from "../src/workflow/background.ts";
import type { AgentProvider } from "../src/agent/provider.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";
import { TASKS } from "../src/eval/codeactTasks.ts";
import { runEvaluation, runSample, simulatedPolicy, summarize } from "../src/eval/codeactEffect.ts";

const PROVIDERS: AgentProvider[] = ["claude", "cursor", "codex", "antigravity", "copilot"];
let user: PublicUser;
const actor = () => ({ ...user, active: true });

before(async () => {
  await migrate();
  user = await createUser({
    username: `pair-${Date.now()}`,
    password: "pairing-pass",
    role: "member",
  });
  setCodeActLauncherForTests(async (node, args) => ({
    command: node,
    args,
    env: { PATH: process.env.PATH ?? "" },
  }));
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
});
after(async () => {
  setCodeActLauncherForTests(undefined);
  setChatHealthProbe(undefined);
  setChatProviders(undefined);
  await settleBackground();
  await pool.end();
});

/** A simulated sample that also reports a fixed provider cost (budget tests). */
const costing =
  (usd: number) =>
  (task: (typeof TASKS)[number]): CompletionRunner => {
    const policy = simulatedPolicy(task);
    // The whole sample's cost is reported on its final completion (the one carrying the answer).
    return async (prompt, options) => {
      const r = await policy(prompt, options);
      return { ...r, cost_usd: /```answer/.test(r.text) ? usd : 0 };
    };
  };

test("concurrent Direct and CodeAct samples and an ordinary conversation cannot leak the capability", async () => {
  assert.equal(config.codeAct.enabled, false);
  // An ordinary (non-evaluation) conversation at the same time, through the global provider seam.
  let ordinaryOffered: boolean | null = null;
  const ordinary: CompletionRunner = async (prompt, options) => {
    ordinaryOffered =
      /\bcode\.execute\b/.test(prompt) ||
      !!options.nativeTools?.tools.some((t) => t.name === "code.execute");
    return { text: "ok", tokens: null };
  };
  setChatProviders(
    Object.fromEntries(PROVIDERS.map((p) => [p, ordinary])) as Record<
      AgentProvider,
      CompletionRunner
    >,
  );
  const task = TASKS.find((t) => t.id === "T03-trace-log-correlation")!;
  const o = {
    actor: actor(),
    provider: "claude" as const,
    runnerFor: (t: (typeof TASKS)[number]) => simulatedPolicy(t),
    turnTimeoutMs: 60_000,
  };
  const conv = await chat.create(actor(), { mode: "INVESTIGATE", provider: "claude" });
  const [direct, codeact, codeact2, direct2] = await Promise.all([
    runSample(task, "direct", 0, o),
    runSample(task, "codeact", 0, o),
    runSample(task, "codeact", 1, o),
    runSample(task, "direct", 1, o),
    chat.postMessage(actor(), conv.id, {
      content: "hello",
      client_message_id: `ord-${Date.now()}`,
    }),
    (async () => {
      // The process-wide flag never flips while samples run.
      for (let i = 0; i < 20; i++) {
        assert.equal(config.codeAct.enabled, false);
        await new Promise((r) => setTimeout(r, 10));
      }
    })(),
  ]);
  for (let i = 0; i < 200 && ordinaryOffered === null; i++)
    await new Promise((r) => setTimeout(r, 25));
  setChatProviders(undefined);
  for (const d of [direct, direct2]) {
    assert.equal(d.codeact_offered, false, "Direct never sees code.execute");
    assert.equal(d.codeact_executions, 0);
  }
  for (const c of [codeact, codeact2]) {
    assert.equal(c.codeact_offered, true);
    assert.equal(c.codeact_executions, 1);
    assert.equal(c.correct, true);
  }
  assert.equal(
    ordinaryOffered,
    false,
    "an ordinary conversation never sees an evaluation's capability",
  );
  assert.equal(config.codeAct.enabled, false);
});

test("pair-aware budget: a pair whose estimated cost exceeds the remaining budget is not started", async () => {
  const run = await runEvaluation(
    { repetitions: 1, tasks: ["T01-single-lookup", "T10-codeact-unnecessary"], budgetUsd: 1 },
    { actor: actor(), provider: "claude", runnerFor: costing(0.4), turnTimeoutMs: 60_000 },
  );
  // Pair 1 costs 0.8; the next pair is estimated at 0.8 > 0.2 remaining, so it never starts (no incomplete pair).
  assert.equal(run.samples.length, 2);
  assert.match(
    run.stopped ?? "",
    /estimated pair cost 0\.8000 USD exceeds the remaining 0\.2000 USD/,
  );
  assert.equal(run.known_spend_usd, 0.8);
  assert.deepEqual(run.budget, {
    limit_usd: 1,
    known_spend_usd: 0.8,
    overshoot_usd: 0,
    unknown_cost_samples: 0,
    enforcement: "best-effort (estimate from observed cost before each pair; no provider hard cap)",
  });
  assert.deepEqual(
    run.pairs.map((p) => [p.task_id, p.complete]),
    [["T01-single-lookup", true]],
  );
});

test("the first pair runs on an unknown estimate; overshoot is reported, never hidden", async () => {
  const run = await runEvaluation(
    { repetitions: 1, tasks: ["T01-single-lookup", "T10-codeact-unnecessary"], budgetUsd: 0.5 },
    { actor: actor(), provider: "claude", runnerFor: costing(0.4), turnTimeoutMs: 60_000 },
  );
  assert.equal(run.samples.length, 2, "an admitted pair is completed even if it overshoots");
  assert.equal(run.budget.overshoot_usd, 0.3);
  assert.match(run.stopped ?? "", /budget/);
});

test("sample allowance: a pair starts only when both of its samples fit", async () => {
  const run = await runEvaluation(
    { repetitions: 1, tasks: ["T01-single-lookup", "T10-codeact-unnecessary"], maxSamples: 3 },
    {
      actor: actor(),
      provider: "claude",
      runnerFor: (t) => simulatedPolicy(t),
      turnTimeoutMs: 60_000,
    },
  );
  assert.equal(run.samples.length, 2);
  assert.match(run.stopped ?? "", /sample limit 3: 1 left, a pair needs 2/);
});

test("a sample that cannot run leaves an incomplete pair: kept, costed, excluded from paired statistics", async () => {
  let n = 0;
  const run = await runEvaluation(
    { repetitions: 1, tasks: ["T01-single-lookup"] },
    {
      actor: actor(),
      provider: "claude",
      runnerFor: (task) => {
        if (++n === 2) throw new Error("provider runner could not be created");
        return costing(0.25)(task);
      },
      turnTimeoutMs: 60_000,
    },
  );
  assert.equal(run.samples.length, 1);
  assert.deepEqual(run.pairs, [
    {
      task_id: "T01-single-lookup",
      repetition: 0,
      variants: ["direct"],
      complete: false,
      reason: "codeact sample failed to run: provider runner could not be created",
    },
  ]);
  assert.match(run.stopped ?? "", /provider runner could not be created/);
  const r = summarize(run.samples, {
    level: "fixture-simulated-provider",
    sandbox: "plain-process",
    provider: "simulated",
    model: null,
  });
  assert.equal(r.pairs, 0);
  assert.deepEqual(r.incomplete_pairs, [
    { task_id: "T01-single-lookup", repetition: 0, have: ["direct"], known_cost_usd: 0.25 },
  ]);
  assert.equal(r.spend.known_usd, 0.25, "an incomplete pair's cost is not dropped");
});
