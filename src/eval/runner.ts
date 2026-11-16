import { executeLiveCase } from "./liveCase.ts";
import { ownsInstance } from "../instances.ts";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative } from "node:path";
import { config } from "../config.ts";
import { execution } from "../auth/execution.ts";
import { pool, one, q, withTx } from "../db/pool.ts";
import { fixtureGit, fixtureRoot, fixtureName, harnessHash } from "./fixtures.ts";
import { CaseSchema, referencePatches } from "./dataset.ts";
import { scoreEvidence, type Evidence } from "./scoring.ts";
import { IsolationUnavailable } from "./isolation.ts";
import { validateSource } from "./validator.ts";
import { rankRepositories, repositories } from "../repos/service.ts";
import { hybridRank, buildCodeContext, searchCodeExact } from "../codeIntelligence/search.ts";
import { indexRepository } from "../codeIntelligence/indexer.ts";
import { recordWorkspace } from "../git/provider.ts";
import { claudeExecutor } from "../agent/claude.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";

function emptyEvidence(seconds: number): Evidence {
  return {
    environment: false,
    authorized_changes: null,
    side_effects_blocked: null,
    security: null,
    syntax: null,
    regression_failed: 0,
    required_passed: 0,
    required_failed: 0,
    hidden_passed: 0,
    hidden_failed: 0,
    expected_passed: 0,
    expected_total: 1,
    clarification_required: false,
    clarification_passed: false,
    duration_ms: 0,
    runtime_budget_ms: seconds * 1000,
    retries: 0,
    human_interventions: 0,
    repository_correct: null,
    input_tokens: null,
    output_tokens: null,
    cached_tokens: null,
    cost_usd: 0,
    failure_class: null,
    details: {},
  };
}
export async function executeBenchmarkCase(ctx: ExecutionContext): Promise<ExecResult> {
  const cr = await one(
    pool,
    `SELECT cr.*,c.definition,c.task_id,e.configuration,e.scoring,e.owner_id,e.workflow_run_id,e.configuration_hash,s.content_hash AS suite_hash,s.suite_key,s.version,s.manifest
 FROM evaluation_case_runs cr JOIN benchmark_cases c ON c.id=cr.case_id JOIN evaluation_runs e ON e.id=cr.evaluation_id JOIN benchmark_suites s ON s.id=e.suite_id WHERE cr.id=$1 AND e.workflow_run_id=$2 AND e.owner_id=$3`,
    [ctx.step.config.case_run_id, ctx.run.id, ctx.run.owner_id],
  );
  if (!cr) throw new Error("Benchmark step is not linked to its owner-scoped evaluation");
  const prior = await one(
    pool,
    "SELECT id,status,quality_score FROM eval_results WHERE case_run_id=$1",
    [cr.id],
  );
  if (prior)
    return {
      kind: "completed",
      output: {
        evaluation_result_id: prior.id,
        verdict: prior.status,
        quality_score: prior.quality_score,
        reused: true,
      },
    };
  if (cr.configuration.mode === "live") return executeLiveCase(ctx, cr);
  const task = CaseSchema.parse(cr.definition),
    cfg = cr.configuration;
  if (
    config.evaluation.enabled &&
    !cfg.blocked &&
    cfg.mode !== "dry_run" &&
    task.transient_once &&
    ctx.attempt.number === 1
  )
    return {
      kind: "failed",
      error: "ECONNRESET: declared synthetic transient interruption",
      retryable: true,
    };
  if (
    config.evaluation.enabled &&
    !cfg.blocked &&
    cfg.mode !== "dry_run" &&
    task.clarification &&
    (cfg.adapter === "reference" || cfg.adapter === "provider_fixture") &&
    !ctx.input.answers.length
  ) {
    return {
      kind: "waiting_input",
      questions: [
        {
          question: task.clarification.question,
          options: [task.clarification.answer],
        },
      ],
      checkpoint: {
        benchmark_case_run: cr.id,
        pinned_commit: task.base_commit,
        edits_before_question: 0,
        asked_at: new Date().toISOString(),
      },
    };
  }
  const principal = execution.getStore();
  if (!principal) throw new Error("Benchmark execution requires an authenticated owner");
  return execution.run(
    {
      ...principal,
      evaluation: {
        codeIntelligence: cfg.code_intelligence,
        fixtureAgent: cfg.adapter === "agent_fixture",
      },
    },
    () => executeIsolated(ctx, cr, task),
  );
}
async function executeIsolated(
  ctx: ExecutionContext,
  cr: any,
  task: ReturnType<typeof CaseSchema.parse>,
): Promise<ExecResult> {
  const cfg = cr.configuration,
    start = Date.now();
  const first = await one(
    pool,
    "SELECT min(at) AS at FROM (SELECT started_at AS at FROM workflow_step_attempts WHERE step_id=$1 UNION ALL SELECT created_at AS at FROM workflow_events WHERE step_id=$1 AND kind='status') times",
    [ctx.step.id],
  );
  const totalStart = new Date(first?.at ?? start).getTime();
  const e = emptyEvidence(cfg.max_case_seconds);
  if (cfg.provider_sequence) e.cost_usd = null;
  e.retries = (await one(
    pool,
    "SELECT count(*)::int AS n FROM workflow_step_attempts WHERE step_id=$1 AND id<>$2 AND status IN ('FAILED','STALE')",
    [ctx.step.id, ctx.attempt.id],
  ))!.n;
  e.clarification_required = !!task.clarification;
  e.human_interventions = ctx.input.answers.length + (ctx.input.approval?.granted ? 1 : 0);
  e.clarification_passed =
    !!task.clarification &&
    !!ctx.input.approval?.granted &&
    ctx.input.answers.some(
      (a) => a.question === task.clarification!.question && a.answer === task.clarification!.answer,
    ) &&
    ctx.input.pending?.resume?.checkpoint?.edits_before_question === 0;
  const root = join(
      config.dataDir,
      "evaluation-work",
      String(cr.evaluation_id),
      String(cr.id),
      `attempt-${ctx.attempt.id}`,
    ),
    workspace = join(root, "workspaces"),
    validatorRoot = join(root, "validator");
  const created: Array<{ primary: string; path: string; logical: string }> = [];
  let diagnostic: string | null = null;
  const deadline = AbortSignal.timeout(cfg.max_case_seconds * 1000);
  const signal = AbortSignal.any([ctx.signal, deadline]);
  const timings: Record<string, number | null> = {
    first_meaningful_action_ms: ctx.input.pending?.resume?.checkpoint?.asked_at
      ? new Date(ctx.input.pending.resume.checkpoint.asked_at).getTime() - totalStart
      : null,
    first_modification_ms: null,
    implementation_ms: null,
    verified_ms: null,
    first_correct_file_ms: null,
  };
  try {
    if (!config.evaluation.enabled)
      throw new IsolationUnavailable("Evaluation framework disabled on this worker");
    if (cfg.blocked) throw new IsolationUnavailable(cfg.blocked);
    if (cfg.harness_hash !== (await harnessHash()))
      throw new IsolationUnavailable(
        "Harness source differs from the frozen suite; publish a new version",
      );
    if (cfg.mode === "dry_run")
      throw new IsolationUnavailable(
        "Dry run: execution and validation intentionally not performed",
      );
    const expired = await q(
      pool,
      "SELECT id FROM workflow_step_attempts WHERE step_id=$1 AND id<>$2 AND status IN ('FAILED','STALE','CANCELED')",
      [ctx.step.id, ctx.attempt.id],
    );
    for (const old of expired) {
      const staleRoot = join(
        config.dataDir,
        "evaluation-work",
        String(cr.evaluation_id),
        String(cr.id),
        `attempt-${old.id}`,
      );
      for (const logical of task.repositories)
        await fixtureGit(fixtureRoot(fixtureName(logical)), [
          "worktree",
          "remove",
          "--force",
          join(staleRoot, "workspaces", logical),
        ]).catch(() => {});
      await rm(staleRoot, { recursive: true, force: true }).catch(() => {});
    }
    await mkdir(workspace, { recursive: true, mode: 0o755 });
    await mkdir(validatorRoot, { recursive: true, mode: 0o755 });
    for (const logical of task.repositories) {
      signal.throwIfAborted();
      const primary = fixtureRoot(fixtureName(logical)),
        sha = cr.manifest.repositories[logical].commit,
        path = join(workspace, logical);
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new IsolationUnavailable("Fixture commit not pinned");
      if ((await fixtureGit(primary, ["rev-parse", `${sha}^{commit}`])) !== sha)
        throw new IsolationUnavailable("Pinned fixture commit unavailable");
      await fixtureGit(primary, ["worktree", "add", "--detach", path, sha]);
      created.push({ primary, path, logical });
      await recordWorkspace(ctx.run.id, {
        repo: fixtureName(logical),
        path,
        branch: "HEAD",
        created_from: sha,
      });
      if (cfg.code_intelligence)
        await indexRepository(fixtureName(logical), ctx.run.id, signal, undefined, path);
    }
    e.environment = true;
    e.authorized_changes = true;
    e.side_effects_blocked = true;
    const names = task.repositories.map(fixtureName),
      workspaces = Object.fromEntries(created.map((w) => [fixtureName(w.logical), w.path])),
      registry = (await repositories.list()).filter((r) => names.includes(r.name));
    const query = task.validation.export_name ?? task.description;
    const ranked = cfg.code_intelligence
      ? await hybridRank(registry, { text: query })
      : rankRepositories(registry, { text: query });
    timings.first_meaningful_action_ms ??= Date.now() - totalStart;
    const selected = ranked[0]?.repo ?? null;
    e.repository_correct = selected === fixtureName(task.repository);
    let context = {
      body: "",
      metrics: { retrieved_context_size: 0, fallback_count: 0 },
    };
    if (cfg.context_strategy === "symbols")
      context = await buildCodeContext(query, {
        repositories: names,
        allowed: names,
        runId: ctx.run.id,
        workspaces,
      });
    if (e.repository_correct && context.body.includes(task.validation.path))
      timings.first_correct_file_ms = Date.now() - totalStart;
    e.details = {
      mode: cfg.mode,
      adapter: cfg.adapter,
      usage_provenance: "No paid provider invoked; fixture usage is not a live token measurement",
      selected_repository: selected,
      ranking: ranked,
      context_size: context.body.length,
      context_relevance: context.body ? context.body.includes(task.validation.path) : null,
      context_fallbacks: context.metrics.fallback_count,
      retrieval_metrics: context.metrics,
      source_commits: cr.manifest.repositories,
      workflow_version: ctx.run.definition_version_id,
      prompt_version: cfg.prompt_version,
      sandbox: cfg.sandbox,
    };
    let plannedPatches = referencePatches[task.task_id];
    if (cfg.provider_sequence) {
      const phases = await q(
        pool,
        `SELECT p.provider,p.model,p.ordinal,p.role,s.status,s.output,s.current_attempt_id FROM evaluation_provider_phases p JOIN workflow_steps s ON s.run_id=$2 AND s.key=p.step_key WHERE p.case_run_id=$1 ORDER BY p.ordinal`,
        [cr.id, ctx.run.id],
      );
      if (
        phases.length !== cfg.provider_sequence.length ||
        phases.some((p) => p.status !== "COMPLETED" || p.output?.blocked)
      )
        throw new IsolationUnavailable("Provider phase is incomplete or unsupported");
      plannedPatches = phases.flatMap((p) => p.output?.patches ?? []);
      e.details.provider_phases = phases.map((p) => ({
        provider: p.provider,
        model: p.model,
        role: p.role,
        attempt_id: p.current_attempt_id,
      }));
      e.details.evidence_kind = "fixture_control";
      e.details.context_variant = cfg.context_variant;
      const prep = await one(
        pool,
        `SELECT COALESCE(sum(length(p.content::text)),0)::int AS chars,COALESCE(sum((p.content->>'retrieval_calls')::int),0)::int AS retrieval_calls FROM agent_context_packs p JOIN workflow_steps s ON s.id=p.step_id JOIN evaluation_provider_phases ep ON ep.step_key=s.key AND ep.case_run_id=$1 WHERE s.run_id=$2`,
        [cr.id, ctx.run.id],
      );
      e.details.context_size = prep.chars;
      e.details.retrieval_calls = prep.retrieval_calls;
    }
    if (cfg.adapter === "reference" || cfg.adapter === "provider_fixture") {
      for (const patch of plannedPatches) {
        if (
          !task.allowed_changes.some(
            (a) => a.repository === patch.repository && a.path === patch.path,
          )
        )
          throw new Error("Harness attempted an unauthorized fixture patch");
        if (typeof patch.content !== "string" || patch.content.length > 64000)
          throw new Error("Unbounded benchmark patch");
        if (timings.first_modification_ms === null)
          timings.first_modification_ms = Date.now() - totalStart;
        if (
          timings.first_correct_file_ms === null &&
          patch.repository === task.repository &&
          patch.path === task.validation.path
        )
          timings.first_correct_file_ms = Date.now() - totalStart;
        await writeFile(join(workspace, patch.repository, patch.path), patch.content);
      }
    } else if (cfg.adapter === "agent_fixture") {
      const bin = join(import.meta.dirname, "..", "..", "test", "fixtures", "fake-codex.mjs");
      await access(bin, constants.X_OK);
      const prompt =
        cfg.prompt_version === "p2-task-v1"
          ? task.description
          : `${task.description}\nAcceptance behavior:\n${task.expected_behavior.map((b) => "- " + b).join("\n")}`;
      // The bundled provider fixture exercises the actual shared provider executor; its synthetic token counters are discarded.
      const result = await claudeExecutor.execute({
        ...ctx,
        signal,
        context: { ...ctx.context, requestText: task.description },
        input: {
          ...ctx.input,
          run: { ...ctx.input.run, title: task.description },
        },
        run: {
          ...ctx.run,
          agent_provider: "codex",
          selected_repositories: names,
          allowed_repositories: names,
        },
        step: {
          ...ctx.step,
          type: "coding_agent",
          config: {
            instructions: prompt,
            verify: false,
            output_contract: "{ goal, requirements }",
          },
        },
        recordMetrics: async (m) => {
          await ctx.recordMetrics({
            ...m,
            tokens: null,
            cost_usd: null,
            usage_provenance: "synthetic provider fixture; no live usage",
          });
        },
      });
      if (result.kind !== "completed") {
        e.failure_class = "agent_failure";
        diagnostic = "Provider fixture did not complete";
      }
    }
    timings.implementation_ms = Date.now() - totalStart;
    let diff = "";
    for (const w of created) {
      const paths = (
        await fixtureGit(w.path, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"])
      )
        .split("\0")
        .filter(Boolean);
      const untracked = (
        await fixtureGit(w.path, ["ls-files", "--others", "--exclude-standard", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      e.authorized_changes =
        e.authorized_changes &&
        [...paths, ...untracked].every((path) =>
          task.allowed_changes.some((a) => a.repository === w.logical && a.path === path),
        );
      diff += (
        await fixtureGit(w.path, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"])
      ).slice(0, 16000);
      if (
        (await fixtureGit(w.path, ["rev-parse", "HEAD"])) !==
        cr.manifest.repositories[w.logical].commit
      )
        e.authorized_changes = false;
    }
    if (task.validation.type === "freshness") {
      const scope = {
        repositories: [fixtureName(task.repository)],
        allowed: [fixtureName(task.repository)],
        runId: ctx.run.id,
        workspaces,
      };
      if (cfg.code_intelligence) {
        context = await buildCodeContext("SnapshotMarker", scope);
        e.details.stale_fallback = context.metrics.fallback_count;
      } else {
        const hits = await searchCodeExact("SnapshotMarker", scope);
        context = {
          body: hits.map((h) => h.snippet ?? "").join("\n"),
          metrics: { retrieved_context_size: 0, fallback_count: 1 },
        };
      }
      e.details.updated_context_size = context.body.length;
      e.details.fresh_context = context.body.includes('"new"') && !context.body.includes('"old"');
    }
    const validation = await validateSource(
      task,
      workspace,
      validatorRoot,
      cfg.sandbox.image,
      signal,
    );
    e.details.build_passed = "build_passed" in validation ? validation.build_passed : null;
    e.syntax = validation.syntax;
    e.security = validation.security;
    diagnostic = validation.diagnostic ?? diagnostic;
    const required = validation.checks.filter((c) => c.name.startsWith("required:")),
      hidden = validation.checks.filter((c) => c.name.startsWith("hidden:"));
    e.required_passed = required.filter((c) => c.passed).length;
    e.required_failed = required.filter((c) => !c.passed).length;
    e.hidden_passed = hidden.filter((c) => c.passed).length;
    e.hidden_failed = hidden.filter((c) => !c.passed).length;
    e.regression_failed =
      e.required_failed +
      hidden.filter((c) => !c.passed && c.name.startsWith("hidden:regression:")).length;
    e.expected_total = validation.checks.length;
    e.expected_passed = validation.checks.filter((c) => c.passed).length;
    if (task.validation.type === "navigation") {
      e.expected_total = 1;
      e.expected_passed = e.repository_correct ? 1 : 0;
    }
    if (task.validation.type === "freshness") {
      e.expected_total++;
      if (e.details.fresh_context) e.expected_passed++;
    }
    if (!e.syntax || e.expected_passed < e.expected_total) e.failure_class = "validation_failure";
    if (!e.clarification_passed && task.clarification)
      diagnostic =
        "Expected relevant clarification and existing checkpoint resume were not observed";
    e.details.validation_checks = validation.checks;
    e.details.validation_scope =
      "Objective fixture assertions; SQL/proto checks are structural, not database/protoc semantic compilation";
    timings.verified_ms = Date.now() - totalStart;
    const artifact = await ctx.artifact(
      "evaluation",
      "benchmark-evidence.json",
      JSON.stringify(
        {
          task: task.task_id,
          description: task.description,
          expected_behavior: task.expected_behavior,
          changes: diff.slice(0, 16000),
          checks: validation.checks,
          context_provenance: context.body.slice(0, 8000),
          timings,
          diagnostic,
        },
        null,
        2,
      ),
    );
    e.details.artifact_id = artifact;
  } catch (error) {
    e.failure_class = ctx.signal.aborted
      ? "canceled"
      : deadline.aborted || (error as Error).name === "EvaluationTimeout"
        ? "timeout"
        : error instanceof IsolationUnavailable
          ? "infrastructure"
          : "validation_failure";
    diagnostic =
      error instanceof IsolationUnavailable
        ? error.message
        : e.failure_class === "timeout"
          ? "Case runtime budget exceeded"
          : "Fixture preparation or validation failed";
    e.details.diagnostic = diagnostic;
  } finally {
    if (created.length)
      await q(pool, "DELETE FROM execution_workspaces WHERE run_id=$1 AND path=ANY($2::text[])", [
        ctx.run.id,
        created.map((w) => w.path),
      ]).catch(() => {});
    for (const w of created)
      await fixtureGit(w.primary, ["worktree", "remove", "--force", w.path]).catch(() => {});
    // Only this attempt's generated directory can be removed; stale attempts never own another attempt's workspace.
    const rel = relative(join(config.dataDir, "evaluation-work"), root);
    if (rel && !rel.startsWith(".."))
      await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  e.duration_ms = Date.now() - totalStart;
  e.details.timings = timings;
  e.details.diagnostic = diagnostic;
  if (ctx.signal.aborted)
    return {
      kind: "failed",
      error: "Evaluation canceled or worker lease lost",
      retryable: false,
    };
  const scored = scoreEvidence(e, cr.scoring);
  await ctx.recordMetrics({
    evaluation: {
      case_run_id: cr.id,
      quality_score: scored.quality_score,
      ...timings,
      duration_ms: e.duration_ms,
      retries: e.retries,
      context_size: e.details.context_size ?? null,
    },
    tokens: null,
    cost_usd: cfg.provider_sequence ? null : 0,
  });
  const saved = await withTx(async (c) => {
    const run = await one(c, "SELECT status FROM workflow_runs WHERE id=$1 FOR SHARE", [
      ctx.run.id,
    ]);
    const lease = await one(
      c,
      "SELECT id FROM workflow_jobs WHERE id=$1 AND status='running' AND fencing_token=$2 AND lease_expires_at>clock_timestamp() FOR SHARE",
      [ctx.attempt.job_id, ctx.attempt.fencing_token],
    );
    await q(c, "SELECT instance_id FROM platform_instances WHERE instance_id=$1 FOR SHARE", [
      config.instanceId,
    ]);
    if (!lease || !(await ownsInstance(c))) return null;
    const active = await one(
      c,
      "SELECT id FROM workflow_steps WHERE id=$1 AND current_attempt_id=$2 AND status='RUNNING'",
      [ctx.step.id, ctx.attempt.id],
    );
    if (!active || run?.status === "CANCELED") return null;
    return one(
      c,
      `INSERT INTO eval_results(suite,scenario,candidate,status,correct,regression,verdict,repairs,human_gates,wall_s,cost_usd,tokens,run_id,data,case_run_id,owner_id,quality_score,hard_gates_passed,failure_class)
    VALUES($1,$2,$3,$4,$5,$6,$4,$7,$8,$9,$17,NULL,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(case_run_id) DO NOTHING RETURNING id`,
      [
        `${cr.suite_key}@${cr.version}`,
        task.task_id,
        cfg.adapter,
        scored.verdict,
        scored.verdict === "BLOCKED" ? null : scored.verdict === "PASS",
        e.regression_failed > 0,
        e.retries,
        e.human_interventions,
        Math.ceil(e.duration_ms / 1000),
        ctx.run.id,
        JSON.stringify({
          evaluation_id: cr.evaluation_id,
          repetition: cr.repetition,
          suite_hash: cr.suite_hash,
          configuration_hash: cr.configuration_hash,
          evidence: e,
          scoring: scored,
        }),
        cr.id,
        cr.owner_id,
        scored.quality_score,
        scored.hard_gates_passed,
        e.failure_class,
        e.cost_usd,
      ],
    );
  });
  if (!saved)
    return {
      kind: "failed",
      error: "Evaluation result fenced or already persisted",
      retryable: false,
    };
  return {
    kind: "completed",
    output: {
      evaluation_result_id: saved.id,
      verdict: scored.verdict,
      quality_score: scored.quality_score,
      diagnostic,
    },
  };
}
