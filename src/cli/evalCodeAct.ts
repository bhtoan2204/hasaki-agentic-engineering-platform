/**
 * CodeAct effectiveness evaluation (M2): Direct Tools vs CodeAct, paired, through the real Chat harness on a private
 * database (`npm run eval:codeact` preloads test/setup.ts: its own PostgreSQL cluster, never the shared RDS).
 *
 *   npm run eval:codeact -- [--repetitions 3] [--tasks T03-…,T08-…] [--out report.json] [--unsandboxed]
 *   npm run eval:codeact -- --live --provider claude --model <pinned id> [--effort medium] --budget-usd 1 --max-samples 4 [--out live.json]
 *
 * Default: the SIMULATED provider policy (no model calls, no spend) with programs in the OS sandbox. `--live` calls a
 * real provider with this machine's credentials and needs `--model` (both variants pinned to the same model),
 * `--budget-usd` and `--max-samples` (unknown cost is bounded by the sample count); it never runs without them. Pairs
 * are admitted only when both samples fit the allowance and the estimated remaining budget.
 *
 *   --suite rca [--seeds 1,2]   the synthetic RCA incidents (src/eval/rcaIncidents.ts) instead of the CodeAct tasks
 *   --workflow-arm              (with --suite rca) also run arm C: the incident-investigation workflow through the real
 *                               engine for every incident (live: the same provider/model/effort; simulated: not
 *                               available — the deterministic workflow arm runs in test/rca-three-arm.integration.ts)
 */
import { writeFileSync } from "node:fs";
import { migrate } from "../db/migrate.ts";
import { pool } from "../db/pool.ts";
import { createUser } from "../auth/users.ts";
import { setCodeActLauncherForTests } from "../codeact/execute.ts";
import { probeIsolation } from "../agent/isolation.ts";
import { setChatHealthProbe } from "../chat/admission.ts";
import { settleBackground } from "../workflow/background.ts";
import { completionRunners } from "../agent/complete.ts";
import { AGENT_PROVIDERS, type AgentProvider } from "../agent/provider.ts";
import {
  runEvaluation,
  simulatedPolicy,
  summarize,
  renderMarkdown,
} from "../eval/codeactEffect.ts";
import { rcaTasks } from "../eval/rcaIncidents.ts";
import {
  ensureRcaWorkflow,
  runWorkflowSample,
  summarizeWorkflowArm,
} from "../eval/rcaWorkflowArm.ts";
import { registerDefaultExecutors } from "../workflow/executors/index.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const live = argv.includes("--live");
const provider = (opt("--provider") ?? "claude") as AgentProvider;
const budgetUsd = opt("--budget-usd") ? Number(opt("--budget-usd")) : undefined;
const maxSamples = opt("--max-samples") ? Number(opt("--max-samples")) : undefined;
if (!AGENT_PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`);
if (live && (budgetUsd == null || maxSamples == null || !(budgetUsd > 0) || !(maxSamples >= 2)))
  throw new Error(
    "--live needs --budget-usd and --max-samples ≥ 2 (a bounded pilot of complete pairs)",
  );
if (live && !opt("--model"))
  throw new Error("--live needs --model: both variants must run on the same pinned model");

await migrate();
const sandboxed = !argv.includes("--unsandboxed");
if (sandboxed) {
  const runtime = await probeIsolation();
  if (!runtime.available)
    throw new Error(`OS sandbox unavailable: ${runtime.problems.join("; ")} (use --unsandboxed)`);
} else
  setCodeActLauncherForTests(async (node, args) => ({
    command: node,
    args,
    env: { PATH: process.env.PATH ?? "" },
  }));
if (!live)
  setChatHealthProbe(async () =>
    AGENT_PROVIDERS.map((p) => ({ provider: p, connected: true, quota: "unknown" as const })),
  );

const user = await createUser({
  username: `codeact-eval-${Date.now()}`,
  password: "codeact-eval",
  role: "member",
});
const suite =
  opt("--suite") === "rca" ? rcaTasks((opt("--seeds") ?? "1").split(",").map(Number)) : undefined;
const workflowArm = argv.includes("--workflow-arm");
if (workflowArm && (!suite || !live))
  throw new Error(
    "--workflow-arm needs --suite rca and --live (the simulated workflow arm runs in the test suite)",
  );
const { samples, stopped, known_spend_usd, pairs, budget } = await runEvaluation(
  {
    repetitions: Number(opt("--repetitions") ?? 1),
    tasks: opt("--tasks")?.split(","),
    ...(suite ? { suite } : {}),
    budgetUsd,
    maxSamples,
  },
  {
    actor: { ...user, active: true },
    provider,
    model: opt("--model") ?? null,
    effort: opt("--effort") ?? null,
    runnerFor: (task) => (live ? completionRunners[provider] : simulatedPolicy(task)),
  },
);
// Arm C: the same incidents through the workflow, within what is left of the budget and sample allowance.
const workflow = [];
if (workflowArm && suite) {
  registerDefaultExecutors();
  const definitionKey = await ensureRcaWorkflow({ model: opt("--model"), effort: opt("--effort") });
  let spent = known_spend_usd;
  let used = samples.length;
  for (const task of suite.filter(
    (t) => !opt("--tasks") || opt("--tasks")!.split(",").includes(t.id),
  )) {
    if (maxSamples != null && used >= maxSamples) break;
    if (budgetUsd != null && spent >= budgetUsd) break;
    const s = await runWorkflowSample(task, 0, { ownerId: user.id, provider, definitionKey });
    workflow.push(s);
    used++;
    spent += s.cost_usd ?? 0;
  }
}
const report = {
  ...summarize(samples, {
    level: live ? "live-provider" : "fixture-simulated-provider",
    sandbox: sandboxed ? "os-sandbox" : "plain-process",
    provider: live ? provider : "simulated",
    model: opt("--model") ?? null,
  }),
  stopped,
  known_spend_usd,
  budget,
  pair_schedule: pairs,
  ...(workflowArm
    ? { workflow_arm: { summary: summarizeWorkflowArm(workflow), samples: workflow } }
    : {}),
  raw_samples: samples,
};
console.log(renderMarkdown(report));
if (stopped) console.log(`\nStopped: ${stopped}`);
const out = opt("--out");
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
await settleBackground();
await pool.end();
