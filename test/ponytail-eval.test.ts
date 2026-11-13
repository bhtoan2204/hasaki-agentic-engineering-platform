import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import {
  LiveBudget,
  liveRuntime,
  observeLiveUsage,
  setLiveUsageOffset,
} from "../src/eval/liveRuntime.ts";
import { livePrerequisites } from "../src/eval/livePrerequisites.ts";
import { processStartTime } from "../src/instances.ts";
import { config } from "../src/config.ts";
import { changedCloneCount, diffFootprint } from "../src/eval/ponytailMetrics.ts";
import {
  ponytailConfigurations,
  eligiblePonytailRepositories,
  materializePonytailSuite,
} from "../src/eval/ponytailSuite.ts";
import { agentEnvironment } from "../src/agent/environment.ts";
import {
  EVALUATION_DATABASE_MARKER,
  liveAllowedTools,
  removeEvaluationSecrets,
  sweepEvaluationDatabases,
} from "../src/eval/liveProvider.ts";
import { liveClaudeSandbox } from "../src/eval/liveSandbox.ts";
import { background, settleBackground } from "../src/workflow/background.ts";
import type { RepositoryRow } from "../src/repos/service.ts";
import { addUsage, newMetrics, accumulateMetrics } from "../src/agent/metrics.ts";
import {
  liveApplicationRoot,
  resetSelfRepositoryCache,
  setBwrapForTests,
} from "../src/platform/selfDevelopment.ts";

test("Live budget aborts on cumulative case tokens and costs across sessions, not snapshot sums", () => {
  let aborted = 0;
  const b = new LiveBudget(100, 5, () => aborted++);
  const first = {},
    second = {};
  b.observe(30, 1, first);
  b.observe(30, 1, first);
  assert.equal(b.tokens, 30);
  assert.equal(b.costUsd, 1);
  b.observe(40, 2, second);
  b.observe(70, 4, first);
  assert.equal(b.tokens, 110);
  assert.equal(b.costUsd, 6);
  assert.ok(aborted);
  assert.match(b.reason!, /budget/);
});
test("Live usage stream aborts the supplied signal and estimates unreported Antigravity cost", () => {
  const controller = new AbortController();
  const budget = new LiveBudget(100, 1, () => controller.abort(), 30);
  liveRuntime.run(
    {
      cwd: "/tmp",
      databaseUrl: "postgres://test/test",
      observe: (...args) => budget.observe(...args),
    },
    () => {
      const m = newMetrics("fake");
      addUsage(m, { input_tokens: 80 });
      assert.equal(controller.signal.aborted, false);
      addUsage(m, { output_tokens: 30 });
      assert.equal(controller.signal.aborted, true);
      assert.equal(budget.tokens, 110);
      observeLiveUsage(m);
      assert.equal(budget.tokens, 110);
    },
  );
});
test("Live prerequisites fail closed for disabled connector, missing sequence and absent isolation", async () => {
  const old = config.evaluation.liveEnabled;
  try {
    config.evaluation.liveEnabled = false;
    const cfg = { max_tokens: 100, max_cost_usd: 1, provider_sequence: [{}] };
    assert.match((await livePrerequisites(cfg))!, /off/);
    config.evaluation.liveEnabled = true;
    assert.match((await livePrerequisites({ ...cfg, provider_sequence: undefined }))!, /sequence/);
    setBwrapForTests(null);
    assert.match((await livePrerequisites(cfg))!, /bubblewrap/);
  } finally {
    config.evaluation.liveEnabled = old;
    setBwrapForTests(undefined);
  }
});
test("Ponytail A/B suite fixes four providers and two repetitions without enabling production", async () => {
  const configurations = ponytailConfigurations();
  assert.equal(configurations.length, 8);
  for (const provider of ["claude", "codex", "cursor", "antigravity"]) {
    const pair = configurations.filter((c) => c.provider === provider);
    assert.deepEqual(
      pair.map((c) => c.ponytail),
      [false, true],
    );
    assert.ok(pair.every((c) => c.repetitions === 2));
  }
  assert.deepEqual(await eligiblePonytailRepositories([]), []);
});
test("Live child environment carries only throwaway database credentials", () => {
  liveRuntime.run(
    { cwd: "/tmp", databaseUrl: "postgres://test/platform_eval_test", observe: () => {} },
    () => {
      const env = agentEnvironment(
        {
          DATABASE_URL: "production",
          AUTH_SECRET: "secret",
          PGHOST: "production",
          NODE_OPTIONS: "--require bad",
          PATH: "/bin",
        },
        "codex",
      );
      assert.equal(env.DATABASE_URL, undefined);
      assert.equal(env.AUTH_SECRET, undefined);
      assert.equal(env.PGHOST, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.TEST_DATABASE_URL, "postgres://test/platform_eval_test");
    },
  );
});
test("Evaluation archives remove credential files and symlinks before provider execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponytail-sanitize-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".env"), "secret");
    await writeFile(join(root, "nested", "source.ts"), "export const n = 1;");
    await symlink("/etc/passwd", join(root, "outside"));
    await removeEvaluationSecrets(root);
    await assert.rejects(readFile(join(root, "nested", ".env")));
    await assert.rejects(readFile(join(root, "outside")));
    assert.match(await readFile(join(root, "nested", "source.ts"), "utf8"), /export/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Ponytail metrics count changed-file token clones and added/removed LOC", () => {
  const text = Array.from({ length: 60 }, (_, i) => `value${i}`).join(" ");
  assert.equal(changedCloneCount({ a: text }, { a: text, b: text }), 2);
  assert.deepEqual(diffFootprint("3\t2\ta.ts\n1\t0\tb.ts"), { added: 4, removed: 2, files: 2 });
});

test("Cursor incremental raw usage can abort before final result and unknown usage is not zero", async () => {
  const { cursorUsage } = await import("../src/agent/cursor/stream.ts");
  assert.equal(cursorUsage({ type: "assistant" }), null);
  const usage = cursorUsage({ type: "assistant", usage: { input_tokens: 80, output_tokens: 40 } });
  assert.ok(usage);
  const controller = new AbortController();
  const b = new LiveBudget(100, 1, () => controller.abort());
  liveRuntime.run(
    { cwd: "/tmp", databaseUrl: "test", observe: (...args) => b.observe(...args) },
    () => observeLiveUsage({ tokens: usage.tokens, cost_usd: usage.cost }),
  );
  assert.equal(controller.signal.aborted, true);
});

test("Shared cohort budget limits the next arm by previous suite spend and uses configured estimates", async () => {
  const { remainingLiveBudgets } = await import("../src/eval/liveRuntime.ts");
  const limits = { max_tokens: 1000, max_cost_usd: 10, max_suite_cost_usd: 300 };
  assert.deepEqual(remainingLiveBudgets(limits, { caseTokens: 100, caseCost: 1, suiteCost: 298 }), {
    tokens: 900,
    costUsd: 2,
  });
  assert.equal(
    remainingLiveBudgets(limits, { caseTokens: 0, caseCost: 0, suiteCost: 300 }).costUsd,
    0,
  );
  const budget = new LiveBudget(10000, 1, () => {}, 100);
  budget.observe(5000, null);
  assert.equal(budget.costUsd, 0.5);
});

test("Ponytail report aggregates actual persisted measurements and missing coverage remains unknown", async () => {
  const { aggregatePonytailArm, renderPonytailReport, ponytailAcceptance } =
    await import("../src/eval/ponytailReport.ts");
  const configuration = { provider: "codex" as const, ponytail: false, repetitions: 2 };
  const row = {
    correct: true,
    status: "PASS",
    tokens: "120",
    cost_usd: "0.5",
    repairs: 1,
    regression: false,
    data: {
      evidence: {
        duration_ms: 2000,
        details: {
          evidence_kind: "live_provider",
          footprint: { added: 10, removed: 5, files: 2 },
          new_clones: 1,
          context_tokens: [30, 20],
          activation: [{ state: "activated" }, { state: "injected" }],
        },
      },
    },
  };
  const result = aggregatePonytailArm(configuration, [row, row]);
  assert.equal(result.tokens, 240);
  assert.equal(result.contextTokens, 100);
  assert.equal(result.costUsd, 1);
  assert.equal(result.addedLoc, 20);
  assert.equal(result.newClones, 2);
  assert.equal(result.latencyMs, 2000);
  assert.equal(result.activated, 2);
  assert.equal(result.skills, 4);
  assert.equal(result.coverageSignal, null);
  assert.equal(
    ponytailAcceptance(result, { ...result, ponytail: true, addedLoc: 5 }),
    "INCONCLUSIVE",
  );
  assert.equal(
    ponytailAcceptance(result, { ...result, ponytail: true, verificationPassRate: 0.5 }),
    "FAIL",
  );
  assert.equal(aggregatePonytailArm(configuration, [{ ...row, status: "BLOCKED" }]).tokens, null);
  const report = renderPonytailReport([result], "2026-11-13");
  assert.match(report, /240/);
  assert.match(report, /Activated \/ skills/);
  assert.match(report, /n=2/);
  assert.match(report, /Codex .*post-hoc/);
});
test("Codex is not attested for incremental live usage by default", () => {
  assert.equal(config.evaluation.liveUsageProviders.includes("codex"), false);
});

test("Live budget counts later sessions on top of earlier ones and each streamed message once", () => {
  const budget = new LiveBudget(1_000_000, 100, () => {});
  liveRuntime.run(
    { cwd: "/tmp", databaseUrl: "test", observe: (...args) => budget.observe(...args) },
    () => {
      const m = newMetrics("fake");
      addUsage(m, { input_tokens: 100 });
      setLiveUsageOffset(m);
      m.tokens = null;
      m.cost_usd = null;
      addUsage(m, { input_tokens: 50 });
      assert.equal(budget.tokens, 150);
      const streamed = new LiveBudget(1_000_000, 100, () => {});
      liveRuntime.run(
        { cwd: "/tmp", databaseUrl: "test", observe: (...args) => streamed.observe(...args) },
        () => {
          const s = newMetrics("fake");
          const block = (uuid: string) => ({
            type: "assistant",
            uuid,
            message: { id: "msg_1", usage: { input_tokens: 100, output_tokens: 10 }, content: [] },
          });
          accumulateMetrics(s, block("a"));
          accumulateMetrics(s, block("b"));
          assert.equal(streamed.tokens, 110);
        },
      );
    },
  );
});

test("Evaluation sanitizing removes build and deploy credentials beyond the agent denylist", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponytail-secrets-"));
  try {
    const secrets = [
      "credentials",
      ".npmrc",
      ".netrc",
      ".pgpass",
      ".git-credentials",
      "client.p12",
      "client.pfx",
      "store.jks",
      "secrets.yaml",
      "application-prod.yml",
      "application.properties",
    ];
    for (const name of [...secrets, "main.go", "package.json"])
      await writeFile(join(root, name), "x");
    await removeEvaluationSecrets(root);
    for (const name of secrets) await assert.rejects(readFile(join(root, name)), name);
    for (const name of ["main.go", "package.json"]) await readFile(join(root, name));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Ponytail suite excludes repositories that are this platform under another name", async () => {
  const old = config.platform.repositoryUrl;
  config.platform.repositoryUrl = "https://github.com/acme/platform.git";
  try {
    const row = (name: string, url: string) =>
      ({
        id: 7,
        name,
        path: "",
        provider: "github",
        repository_url: url,
        enabled: true,
      }) as RepositoryRow;
    const eligible = await eligiblePonytailRepositories([
      row("renamed-platform", "https://github.com/acme/platform.git"),
      row("service", "https://github.com/acme/service.git"),
    ]);
    assert.deepEqual(
      eligible.map((r) => r.name),
      ["service"],
    );
  } finally {
    config.platform.repositoryUrl = old;
  }
});
const DEAD_PID = 2 ** 30;
async function fakeDatabase(data: string, owner: object | null) {
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "PG_VERSION"), "17");
  if (owner) await writeFile(join(data, EVALUATION_DATABASE_MARKER), JSON.stringify(owner));
  return join(data, "PG_VERSION");
}
test("Worker start sweeps orphaned evaluation databases", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponytail-sweep-"));
  try {
    const live = join(root, "1", "2", "live");
    const orphan = await fakeDatabase(join(live, "database-00000000-0000-4000-8000-000000000001"), {
      pid: DEAD_PID,
      host: hostname(),
    });
    await writeFile(join(live, "keep.txt"), "x");
    await sweepEvaluationDatabases(root);
    await assert.rejects(readFile(orphan));
    await readFile(join(live, "keep.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function sleeper(argv0: string) {
  const child = spawn("sleep", ["300"], { argv0, stdio: "ignore" });
  await once(child, "spawn");
  return child;
}
test("Database sweep leaves live owners, other hosts and repository content alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponytail-sweep-"));
  const postmaster = await sleeper("postgres");
  try {
    const live = join(root, "1", "2", "live");
    const id = (n: number) => `database-00000000-0000-4000-8000-00000000000${n}`;
    const kept = [
      await fakeDatabase(join(live, id(1)), { pid: process.pid, host: hostname() }),
      await fakeDatabase(join(live, id(2)), { pid: DEAD_PID, host: `${hostname()}-other` }),
      await fakeDatabase(join(live, id(3)), null),
      await fakeDatabase(join(live, "repo", id(4)), { pid: DEAD_PID, host: hostname() }),
      await fakeDatabase(join(live, id(6)), {
        pid: process.pid,
        host: hostname(),
        started: processStartTime(process.pid),
      }),
      await fakeDatabase(join(live, "database-tool"), { pid: DEAD_PID, host: hostname() }),
      await fakeDatabase(join(root, id(5)), { pid: DEAD_PID, host: hostname() }),
    ];
    await writeFile(join(live, id(3), "postmaster.pid"), `${postmaster.pid}\n${live}\n`);
    await sweepEvaluationDatabases(root);
    for (const path of kept) await readFile(path);
  } finally {
    postmaster.kill();
    await rm(root, { recursive: true, force: true });
  }
});
test("Database sweep removes recycled-PID owners and legacy databases without a running postmaster", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponytail-sweep-"));
  const other = await sleeper("node");
  try {
    const live = join(root, "1", "2", "live");
    const id = (n: number) => `database-00000000-0000-4000-8000-00000000000${n}`;
    const recycledSelf = await fakeDatabase(join(live, id(1)), {
      pid: process.pid,
      host: hostname(),
      started: "1",
    });
    const recycledOther = await fakeDatabase(join(live, id(2)), {
      pid: other.pid,
      host: hostname(),
      started: "1",
    });
    const legacy = await fakeDatabase(join(live, id(3)), null);
    const legacyDead = await fakeDatabase(join(live, id(4)), null);
    await writeFile(join(live, id(4), "postmaster.pid"), `${DEAD_PID}\n`);
    await sweepEvaluationDatabases(root);
    for (const path of [recycledSelf, recycledOther, legacy, legacyDead])
      await assert.rejects(readFile(path), path);
  } finally {
    other.kill();
    await rm(root, { recursive: true, force: true });
  }
});
test("Live configurations can only narrow the sandboxed tool set", () => {
  assert.deepEqual(liveAllowedTools(["Read", "WebFetch", "integration:jira", "Bash"]), [
    "Read",
    "Bash",
  ]);
  assert.ok(!liveAllowedTools(undefined).includes("WebFetch"));
  assert.ok(liveAllowedTools(undefined).includes("Edit"));
});
test("Ponytail suite excludes the live checkout and everything when self identity is unknown", async () => {
  const oldUrl = config.platform.repositoryUrl;
  const oldRepos = config.repositories;
  const oldGitDir = process.env.GIT_DIR;
  const row = (name: string) =>
    ({ id: 8, name, path: "", provider: "github", enabled: true }) as RepositoryRow;
  try {
    config.platform.repositoryUrl = "https://github.com/acme/platform.git";
    config.repositories = { ...oldRepos, "live-copy": liveApplicationRoot()! };
    assert.deepEqual(
      (await eligiblePonytailRepositories([row("live-copy"), row("service")])).map((r) => r.name),
      ["service"],
    );
    config.platform.repositoryUrl = "";
    process.env.GIT_DIR = join(tmpdir(), "no-such-git-dir");
    resetSelfRepositoryCache();
    assert.deepEqual(await eligiblePonytailRepositories([row("service")]), []);
    await assert.rejects(materializePonytailSuite([row("service")]), /set platform.repositoryUrl/);
  } finally {
    config.platform.repositoryUrl = oldUrl;
    config.repositories = oldRepos;
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
    resetSelfRepositoryCache();
  }
});
test("Live Claude sandbox fails closed without network and denies credential reads", () => {
  const work = join(config.dataDir, "evaluation-work", "1", "2", "live");
  const sandbox = liveClaudeSandbox("postgres://eval@localhost/db?host=%2Ftmp%2Fsock", work);
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(sandbox.network.allowedDomains, []);
  assert.deepEqual(sandbox.network.allowUnixSockets, ["/tmp/sock"]);
  assert.ok(sandbox.filesystem.denyRead.some((p) => p.endsWith("/.pgpass")));
  assert.ok(sandbox.filesystem.denyRead.includes(config.reposRoot));
  assert.ok(sandbox.filesystem.denyRead.includes(config.dataDir));
  assert.deepEqual(sandbox.filesystem.allowRead, [work]);
});
test("Background work started inside a live phase does not inherit the live runtime", async () => {
  let seen: unknown = "unset";
  liveRuntime.run({ cwd: "/tmp", databaseUrl: "test", observe: () => {} }, () =>
    background("probe", () => {
      seen = liveRuntime.getStore();
    }),
  );
  await settleBackground();
  assert.equal(seen, undefined);
});
