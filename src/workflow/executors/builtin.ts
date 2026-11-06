import { spawn } from "node:child_process";
import { config } from "../../config.ts";
import { pool, q } from "../../db/pool.ts";
import { gitProvider, workspacesOf } from "../../git/provider.ts";
import { isAmbiguous, rankRepositories, repositories, type RankedRepository, type RepositoryRow } from "../../repos/service.ts";
import { getPath } from "../graph.ts";
import { classify, goBaseline, knownBaseFailures, parseGoTest } from "./baseline.ts";
import { childGroups } from "../local.ts";
import { askAboutFailure, handleDecision, type Diagnosis } from "./testFailure.ts";
import { dirtyOf, headOf, verificationGate, type PublishState } from "../../agent/independentReview.ts";
import type { ExecResult } from "../types.ts";
import type { ExecutionContext, StepExecutor } from "./registry.ts";

// ---------------------------------------------------------------- human_input

/** Asks the configured questions; answering them completes the step with the answers as output. */
export const humanInputExecutor: StepExecutor = {
  async execute(ctx) {
    const qs = (ctx.step.config.questions as Array<{ question: string; context?: string; options?: string[] }>) ?? [];
    if (!qs.length) return { kind: "failed", error: "human_input step has no config.questions", retryable: false };
    return { kind: "waiting_input", questions: qs };
  },
};

// ---------------------------------------------------------------- human_approval

export const humanApprovalExecutor: StepExecutor = {
  async execute(ctx) {
    const cfg = ctx.step.config;
    const shown = Object.fromEntries(((cfg.show_outputs as string[]) ?? []).map((k) => [k, ctx.input.upstream[k]?.output ?? null]));
    const request: Record<string, unknown> = { message: cfg.message ?? `Approve "${ctx.step.name}"?`, outputs: shown };
    if (cfg.select_repositories) {
      const discovery = Object.values(ctx.input.upstream).find((u) => Array.isArray(u.output?.candidates))?.output;
      // Repositories already chosen for the run: selected at creation, or passed as the `repositories` run input
      // (an array, or a comma-separated string from the API); only ones the run is allowed to touch.
      const raw = ctx.input.run.inputs?.repositories;
      const fromInput = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : []).map((r) => r.trim()).filter(Boolean);
      const preselected = (ctx.run.selected_repositories.length ? ctx.run.selected_repositories : fromInput).filter((r) => ctx.run.allowed_repositories.includes(r));
      if (cfg.auto_approve_preselected && preselected.length)
        return { kind: "completed", output: { approved: true, auto: true, repositories: preselected, selected_repositories: preselected } };
      const recommended: string[] = discovery?.recommended ?? preselected;
      if (cfg.ask_branch) Object.assign(request, { ask_branch: true, branch: typeof ctx.input.run.inputs?.branch === "string" ? ctx.input.run.inputs.branch : "" });
      Object.assign(request, {
        select_repositories: true,
        candidates: discovery?.candidates ?? ctx.run.allowed_repositories.map((r) => ({ repo: r, score: 0, reasons: [] })),
        recommended,
        ambiguous: discovery?.ambiguous ?? true,
        allowed: ctx.run.allowed_repositories,
      });
      if (cfg.auto_approve_unambiguous && discovery && !discovery.ambiguous && recommended.length)
        return { kind: "completed", output: { approved: true, auto: true, repositories: recommended, selected_repositories: recommended } };
    }
    return { kind: "waiting_approval", request };
  },
};

// ---------------------------------------------------------------- condition

const OPS: Record<string, (a: unknown, b: unknown) => boolean> = {
  eq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  ne: (a, b) => JSON.stringify(a) !== JSON.stringify(b),
  gt: (a, b) => Number(a) > Number(b),
  lt: (a, b) => Number(a) < Number(b),
  exists: (a) => a !== undefined && a !== null,
  truthy: (a) => Boolean(a) && !(Array.isArray(a) && a.length === 0),
  contains: (a, b) => (Array.isArray(a) ? a.includes(b) : String(a ?? "").includes(String(b))),
};

/** Pure evaluation over {upstream, inputs, run}: `config = { path: "upstream.review.output.approved", op: "eq", value: true }`. */
export function evaluateCondition(cfg: Record<string, any>, scope: Record<string, unknown>) {
  const op = OPS[cfg.op ?? "truthy"];
  if (!op) throw new Error(`unknown condition op "${cfg.op}"`);
  const value = getPath(scope, cfg.path);
  return { result: op(value, cfg.value), value };
}

export const conditionExecutor: StepExecutor = {
  async execute(ctx) {
    const scope = { upstream: ctx.input.upstream, inputs: ctx.input.run.inputs, run: ctx.input.run, work_item: ctx.input.work_item };
    return { kind: "completed", output: evaluateCondition(ctx.step.config, scope) };
  },
};

// ---------------------------------------------------------------- command

export function runCommand(command: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal: AbortSignal, onChunk?: (text: string) => void) {
  return new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...env }, signal, detached: true });
    // Kill the whole process group (bash + go test + test binaries) on abort/timeout, not only bash.
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    signal.addEventListener("abort", killTree, { once: true });
    if (child.pid) childGroups.add(child.pid);
    let output = "";
    const cap = 512 * 1024;
    let pending = "";
    const flush = () => {
      if (pending && onChunk) onChunk(pending);
      pending = "";
    };
    const ticker = setInterval(flush, 1500);
    const add = (b: Buffer) => {
      const s = b.toString("utf8");
      if (output.length < cap) output += s;
      if (pending.length < 64 * 1024) pending += s;
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.on("error", (e) => {
      output += `\n[spawn error] ${e.message}`;
    });
    child.on("close", (code) => {
      if (child.pid) childGroups.remove(child.pid);
      clearTimeout(t);
      clearInterval(ticker);
      flush();
      resolve({ code, output: output.length >= cap ? output + "\n[output truncated]" : output, timedOut });
    });
  });
}

/**
 * Runs `config.command` in every workspace of the run (or `config.cwd`). Definitions are platform-authored
 * (trusted); commands never run in the primary checkouts because workspaces are always worktrees.
 */
export const commandExecutor: StepExecutor = {
  async execute(ctx) {
    // Per-attempt overrides (e.g. "retry with baseline comparison") arrive through pending input.
    const cfg = { ...ctx.step.config, ...(ctx.input.pending?.config_overrides ?? {}) };
    // Interactive failure handling (default for test steps with baseline comparison): ask the developer instead of failing.
    const interactive = String(cfg.on_failure ?? (cfg.baseline_compare ? "ask" : "fail")) === "ask";
    let decision: any = null;
    const resumed = ctx.input.pending?.resume;
    const priorDiagnosis = resumed?.checkpoint?.test_failure as Diagnosis | undefined;
    if (interactive && priorDiagnosis && resumed?.from_attempt_id) {
      const r = await handleDecision(ctx, priorDiagnosis, resumed.from_attempt_id);
      if (r.result) return r.result;
      decision = r.decision; // rerun: execute the tests again below, in this new attempt
    }
    const timeoutMs = Number(cfg.timeout_seconds ?? 600) * 1000;
    const targets = cfg.cwd ? [{ repo: "(cwd)", path: String(cfg.cwd), branch: ctx.run.branch }] : await workspacesOf(ctx.run.id);
    if (!targets.length) {
      // Nothing was changed (e.g. the coding step concluded the fix already exists): nothing to test.
      if (cfg.require_workspace) return { kind: "failed", error: "no workspace to run in: no coding step prepared a worktree for this run", retryable: false };
      await ctx.log("system", "skipped: this run has no worktree (no code was changed), so there is nothing to run the command in");
      return { kind: "completed", output: { skipped: true, passed: true, reason: "no code changes in this run (no worktree)", results: [] } };
    }
    const results: Array<{ repo: string; exit_code: number | null; timed_out: boolean; artifact_id: number; baseline?: any; passed?: boolean }> = [];
    const outputs: Record<string, string> = {};
    for (const t of targets) {
      await ctx.log("system", `▶ ${t.repo}: running command in ${t.path}`);
      const started = Date.now();
      // Skipping known base failures continues past them without confirmation: opt-in in interactive mode.
      const skipKnown = cfg.skip_known_base_failures ?? !interactive;
      const known = cfg.baseline_compare === "go" && skipKnown ? await knownBaseFailures(t.path) : null;
      if (known?.skipRegex) await ctx.log("system", `skipping ${known.tests.length} test(s) known to fail on ${config.baseBranch}@${known.sha.slice(0, 9)}: ${known.tests.join(", ")}`, { skipped_known_failures: known.tests });
      const r = await runCommand(
        String(cfg.command),
        t.path,
        { BASE_BRANCH: config.baseBranch, REPO: t.repo, BRANCH: t.branch, RUN_ID: String(ctx.run.id), ...(known?.skipRegex ? { GO_TEST_SKIP: known.skipRegex } : {}), ...((cfg.env as Record<string, string>) ?? {}) },
        timeoutMs,
        ctx.signal,
        (chunk) => void ctx.log("log", chunk, { repo: t.repo }),
      );
      await ctx.log("system", `■ ${t.repo}: exit ${r.timedOut ? "timeout" : r.code} after ${Math.round((Date.now() - started) / 1000)}s`, { repo: t.repo, exit_code: r.code, timed_out: r.timedOut });
      const artifactId = await ctx.artifact("log", `${ctx.step.key}-${t.repo}.log`, r.output, { exit_code: r.code, timed_out: r.timedOut });
      const entry: (typeof results)[number] & { skipped_known_failures?: string[] } = { repo: t.repo, exit_code: r.code, timed_out: r.timedOut, artifact_id: artifactId, passed: r.code === 0, ...(known?.tests.length ? { skipped_known_failures: known.tests } : {}) };
      if (r.code !== 0 && !r.timedOut && cfg.baseline_compare === "go") entry.baseline = await compareWithBaseline(ctx, t, r.output, timeoutMs);
      // Auto-accepting failures that also fail on the base branch: opt-in when interactive (the developer confirms instead).
      if (entry.baseline?.regressions && !entry.baseline.regressions.length && (cfg.baseline_auto_accept ?? !interactive)) entry.passed = true;
      outputs[t.repo] = r.output;
      results.push(entry);
    }
    const failed = results.filter((r) => !r.passed);
    const output = { results, passed: failed.length === 0, ...(decision ? { decision } : {}) };
    if (failed.length && !cfg.allow_failure && interactive) {
      // Automatic retries first (max_attempts); when they are exhausted, diagnose and ask the developer.
      if (ctx.step.attempt_count < ctx.step.max_attempts) return { kind: "failed", error: `tests failed (attempt ${ctx.step.attempt_count}/${ctx.step.max_attempts}); retrying`, retryable: true, details: output };
      return askAboutFailure(ctx, { command: String(cfg.command), outputs, results }, decision);
    }
    if (failed.length && !cfg.allow_failure) {
      const why = (f: (typeof results)[number]) => {
        const reg = f.baseline?.regressions;
        if (reg?.length) return `${f.repo}: ${reg.length} regression(s) vs ${config.baseBranch} — ${reg.map((x: any) => [x.package.split("/").slice(-2).join("/"), ...x.tests, ...x.build_errors].slice(0, 4).join(" ")).join("; ")}`;
        return `${f.repo} (exit ${f.timed_out ? "timeout" : f.exit_code}${f.baseline?.note ? `, ${f.baseline.note}` : ""})`;
      };
      return { kind: "failed", error: `command failed in ${failed.map(why).join(" | ")}`, retryable: false, details: output };
    }
    return { kind: "completed", output };
  },
};

/** Re-run the failing Go packages on origin/<base>; failures present there too are pre-existing, not regressions. */
async function compareWithBaseline(ctx: ExecutionContext, t: { repo: string; path: string }, output: string, timeoutMs: number) {
  const branch = parseGoTest(output);
  const failing = Object.entries(branch).filter(([, p]) => p.status === "fail").map(([k]) => k);
  if (!failing.length) {
    await ctx.log("system", `baseline: no parseable go test failure in ${t.repo} (e.g. go build failed); not comparing`);
    return { note: "no go test failure to compare (build or script error)" };
  }
  await ctx.log("system", `◆ ${t.repo}: comparing ${failing.length} failing package(s) with origin/${config.baseBranch}…`);
  try {
    const base = await goBaseline(t.path, failing, (command, cwd) => runCommand(command, cwd, { BASE_BRANCH: config.baseBranch, REPO: t.repo }, timeoutMs, ctx.signal, (chunk) => void ctx.log("log", chunk, { repo: t.repo, baseline: true })));
    const c = classify(branch, base.report);
    await ctx.log(
      "system",
      `◆ ${t.repo}: baseline ${base.sha.slice(0, 9)} → ${c.regressions.length} regression(s), ${c.pre_existing.length} package(s) with pre-existing failures` +
        (base.cached.length ? ` (cached: ${base.cached.length})` : ""),
      { repo: t.repo, ...c },
    );
    return { base_sha: base.sha, ...c };
  } catch (e) {
    await ctx.log("system", `baseline comparison failed for ${t.repo}: ${(e as Error).message}`);
    return { note: `baseline comparison failed: ${(e as Error).message.split("\n")[0]}` };
  }
}

// ---------------------------------------------------------------- integration

/** Optional AI re-ranking hook (set by the Claude executor module); must only reorder/annotate given repos. */
export let aiRepositoryRanker: ((ctx: ExecutionContext, candidates: RankedRepository[], repos: RepositoryRow[]) => Promise<RankedRepository[]>) | null = null;
export function setAiRepositoryRanker(fn: typeof aiRepositoryRanker) {
  aiRepositoryRanker = fn;
}

async function repositoryDiscovery(ctx: ExecutionContext): Promise<ExecResult> {
  const cfg = ctx.step.config;
  const allowed = new Set(ctx.run.allowed_repositories);
  const rows = (await repositories.list()).filter((r) => allowed.has(r.name));
  if (!rows.length) return { kind: "failed", error: "no repositories are allowed for this run (check the repository registry / project mapping)", retryable: false };
  const keywords = Object.values(ctx.input.upstream).flatMap((u) => (Array.isArray(u.output?.keywords) ? u.output.keywords : []));
  const text = [ctx.input.work_item?.title, ctx.input.work_item?.description, ctx.input.run.title, JSON.stringify(ctx.input.run.inputs ?? {})].filter(Boolean).join("\n");
  let ranked = rankRepositories(rows, { text, keywords, project: ctx.context.project });
  let method = "deterministic";
  // Repositories already chosen (explicitly or reused from an earlier run of this work item): nothing to rediscover.
  if (ctx.run.selected_repositories.length && cfg.reuse_selected !== false) {
    await ctx.log("system", `repository discovery: reusing ${ctx.run.selected_repositories.join(", ")} (no re-ranking)`);
    return { kind: "completed", output: { candidates: ranked.slice(0, Number(cfg.max_candidates ?? 5)), recommended: ctx.run.selected_repositories, ambiguous: false, method: "reused", reused: true } };
  }
  // Claude is only consulted when the deterministic ranking cannot decide.
  if (cfg.use_ai && aiRepositoryRanker && isAmbiguous(ranked.slice(0, Number(cfg.max_candidates ?? 5)))) {
    try {
      const ai = await aiRepositoryRanker(ctx, ranked, rows);
      // Never let the model introduce repositories outside the allowed set.
      const safe = ai.filter((r) => allowed.has(r.repo));
      if (safe.length) {
        ranked = safe;
        method = "ai-assisted";
      }
    } catch (e) {
      await ctx.log("system", `AI repository ranking unavailable, using deterministic ranking: ${(e as Error).message}`);
    }
  }
  const max = Number(cfg.max_candidates ?? 5);
  const candidates = ranked.slice(0, max);
  const ambiguous = isAmbiguous(candidates);
  const recommended = candidates.filter((c) => c.score > 0 && c.score >= (candidates[0]?.score ?? 0) * 0.75).map((c) => c.repo);
  const output: Record<string, unknown> = { candidates, recommended, ambiguous, method };
  // Provisional selection unless the user already chose; the confirm step finalises it.
  if (!ctx.run.selected_repositories.length && recommended.length) output.selected_repositories = recommended;
  return { kind: "completed", output };
}

async function selectRepositories(ctx: ExecutionContext): Promise<ExecResult> {
  const repos = ctx.run.selected_repositories.length ? ctx.run.selected_repositories : ((ctx.input.run.inputs?.repositories as string[]) ?? []);
  if (!repos.length) return { kind: "failed", error: "select at least one repository for this run", retryable: false };
  return { kind: "completed", output: { repositories: repos, selected_repositories: repos, branch: ctx.input.run.inputs?.branch ?? null } };
}

function renderFindings(key: string, out: any): string {
  if (!out) return `## ${key}\n\n(no output)\n`;
  const lines = [`## ${key}`, "", out.summary ? String(out.summary) : ""];
  const list = out.findings ?? out.violations ?? [];
  if (Array.isArray(list) && list.length) {
    lines.push("", "| Severity | Location | Issue | Suggestion |", "|---|---|---|---|");
    for (const f of list)
      lines.push(
        `| ${f.severity ?? "-"} | ${[f.repo, f.file, f.line].filter(Boolean).join(":") || f.guideline || "-"} | ${String(f.issue ?? f.detail ?? "").replace(/\|/g, "\\|")} | ${String(f.suggestion ?? "").replace(/\|/g, "\\|")} |`,
      );
  }
  return lines.join("\n") + "\n";
}

async function publishReport(ctx: ExecutionContext): Promise<ExecResult> {
  const from = (ctx.step.config.from as string[]) ?? Object.keys(ctx.input.upstream);
  const title = String(ctx.step.config.title ?? "Report");
  const sections = from.map((k) => renderFindings(k, ctx.input.upstream[k]?.output));
  const md = [`# ${title}`, "", `Run #${ctx.run.id} · ${ctx.run.selected_repositories.join(", ")}`, "", ...sections].join("\n");
  const findings = from.flatMap((k) => {
    const o = ctx.input.upstream[k]?.output;
    return (o?.findings ?? o?.violations ?? []).map((f: any) => ({ ...f, source: k }));
  });
  const artifactId = await ctx.artifact("report", `${title}.md`, md, { findings });
  return { kind: "completed", output: { report_artifact_id: artifactId, findings_count: findings.length, findings } };
}

export const integrationExecutor: StepExecutor = {
  async execute(ctx) {
    switch (ctx.step.config.action) {
      case "repository_discovery":
        return repositoryDiscovery(ctx);
      case "select_repositories":
        return selectRepositories(ctx);
      case "publish_report":
        return publishReport(ctx);
      case "noop":
        return { kind: "completed", output: { ok: true } };
      default:
        return { kind: "failed", error: `unknown integration action "${ctx.step.config.action}"`, retryable: false };
    }
  },
};

// ---------------------------------------------------------------- git_pull_request

/** PR title/summary/decisions for one repo, from the content step's output (shared with the PR preview). */
export function prFields(source: any, repo: string, code: string | undefined, runTitle: string) {
  const content = source?.pull_requests?.[repo] ?? {};
  return {
    title: String(content.title ?? source?.title ?? `${code ? code + ": " : ""}${runTitle}`).slice(0, 250),
    summary: String(content.summary ?? source?.summary ?? ""),
    decisions: (content.decisions ?? source?.decisions ?? []) as Array<{ title: string; detail: string }>,
  };
}

export function prDescription(x: { code?: string; runId: number; summary: string; decisions: Array<{ title: string; detail: string }>; commits: string; testExceptions?: Array<{ step: string; exception: any }>; verificationNotes?: Array<{ step: string; status: string; lines: string[] }> }) {
  const exc = x.testExceptions ?? [];
  const vn = (x.verificationNotes ?? []).filter((n) => n.lines.length);
  return [
    x.code ? `Task: **${x.code}**` : `Workflow run #${x.runId}`,
    "",
    x.summary,
    "",
    x.decisions.length ? "## Decisions\n" + x.decisions.map((d) => `- **${d.title}**: ${d.detail}`).join("\n") : "",
    "",
    "## Commits\n```\n" + x.commits + "\n```",
    "",
    ...(exc.length
      ? [
          "## Test exceptions (accepted by the developer — test result remains FAILED)",
          ...exc.flatMap((e) => [
            `- ${e.step}: failures that also fail on the base branch${e.exception.base_sha ? ` (${String(e.exception.base_sha).slice(0, 9)})` : ""}:`,
            ...e.exception.failures.map((f: any) => `  - ${f.repo} ${f.package ?? ""} ${f.test ?? f.build_error ?? ""}`.trimEnd()),
          ]),
          "",
        ]
      : []),
    ...(vn.length
      ? ["## Verification notes (automated checks were not conclusive — please review)", ...vn.flatMap((n) => [`- ${n.step} (${n.status}):`, ...n.lines.map((l) => `  - ${l}`)]), ""]
      : []),
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
}

/** Accepted baseline test exceptions recorded by upstream command steps of a run (for PR text and reports). */
export async function testExceptionsOf(runId: number) {
  const rows = await q(pool, "SELECT key, output FROM workflow_steps WHERE run_id = $1 AND type = 'command' AND output ? 'accepted_exception' ORDER BY position", [runId]);
  return rows.map((r: any) => ({ step: r.key, exception: r.output.accepted_exception }));
}

/** Harness verification results a reviewer must see: accepted pre-existing failures and needs-review signals. */
export async function verificationNotesOf(runId: number) {
  const rows = await q(pool, "SELECT key, output->'verification' AS v FROM workflow_steps WHERE run_id = $1 AND type = 'coding_agent' AND output ? 'verification' ORDER BY position", [runId]);
  return rows
    .filter((r: any) => r.v && (r.v.status === "accepted_with_preexisting" || r.v.needs_review || r.v.status === "disabled"))
    .map((r: any) => ({
      step: r.key,
      status: String(r.v.status),
      lines: [
        ...(r.v.status === "disabled" ? ["verification disabled by the workflow definition"] : []),
        ...((r.v.last ?? []) as any[]).filter((x) => x.status === "accepted_preexisting").map((x) => `${x.repo}: ${x.note ?? "pre-existing failures accepted"}`),
        ...((r.v.review_reasons ?? []) as string[]),
      ],
    }));
}

const revParse = (path: string, ref: string) =>
  new Promise<string>((resolve) => {
    const p = spawn("git", ["-C", path, "rev-parse", "--verify", "--quiet", ref]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(""));
    p.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
  });

/**
 * Opens (or updates) one PR per workspace with commits. Idempotent across retries: the provider updates the
 * open PR for source→target and `pull_requests` is unique per (provider, repo, source, target).
 * Modes: auto | approval (gate before the step, set up at run start) | draft | none.
 */
export const pullRequestExecutor: StepExecutor = {
  async execute(ctx) {
    const cfg = ctx.step.config;
    const mode = String(cfg.mode ?? "auto");
    if (mode === "none") return { kind: "completed", output: { skipped: true, reason: "PR creation disabled (mode: none)" } };
    const workspaces = await workspacesOf(ctx.run.id);
    if (!workspaces.length) return { kind: "completed", output: { pull_requests: [], note: "no workspace was changed in this run" } };
    const source = ctx.input.upstream[String(cfg.content_from ?? "")]?.output ?? Object.values(ctx.input.upstream).find((u) => u.output?.pull_requests)?.output ?? {};
    const provider = gitProvider();
    const code = ctx.input.work_item?.code;
    const out: any[] = [];
    // Independent verification gate. Steps marked `independent: true` make verification REQUIRED: every one must hold
    // a valid PASS covering every published repo at exactly the commit that would be pushed, from a clean worktree.
    // Workflows without such a step (opted out, FAST profile) keep verification optional.
    const verifiers = await q<{ key: string; status: string; output: any }>(pool, "SELECT key, status, output FROM workflow_steps WHERE run_id = $1 AND config->>'independent' = 'true' ORDER BY position", [ctx.run.id]);
    if (verifiers.length) {
      const publish: Record<string, PublishState> = {};
      for (const w of workspaces.filter((x) => ctx.run.selected_repositories.includes(x.repo)))
        publish[w.repo] = { head: await headOf(w.path).catch(() => ""), branchTip: await revParse(w.path, `refs/heads/${w.branch}`), dirty: await dirtyOf(w.path) };
      const problems = verificationGate(verifiers, publish);
      if (problems.length) {
        await ctx.log("system", `PR blocked by the verification gate:\n- ${problems.join("\n- ")}`);
        return { kind: "failed", error: `independent verification gate: ${problems.join("; ")} — re-run the verification step (or the coding step) before opening the PR`, retryable: false };
      }
    }
    for (const w of workspaces) {
      if (!ctx.run.selected_repositories.includes(w.repo)) {
        await ctx.log("system", `skip PR for ${w.repo}: not in the run's selected repositories`);
        continue;
      }
      const { title, summary, decisions } = prFields(source, w.repo, code, ctx.run.title);
      let commits: string;
      try {
        const pushed = await provider.push(w.path, w.branch);
        commits = pushed.commits;
        if (pushed.note) await ctx.log("system", `${w.repo}: ${pushed.note}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (/no commits ahead/.test(msg)) {
          await ctx.log("system", `${w.repo}: ${msg}; no PR`);
          continue;
        }
        return { kind: "failed", error: `${w.repo}: push failed: ${msg}`, retryable: true };
      }
      const description = prDescription({ code, runId: ctx.run.id, summary, decisions, commits, testExceptions: await testExceptionsOf(ctx.run.id), verificationNotes: await verificationNotesOf(ctx.run.id) });
      const slug = (await repositories.get(w.repo))?.remote_slug || w.repo;
      const pr = await provider.openOrUpdatePullRequest({ repo: slug, source: w.branch, target: config.baseBranch, title, description, draft: mode === "draft" });
      await q(
        pool,
        `INSERT INTO pull_requests (provider, repo, source_branch, target_branch, url, title, summary, decisions, draft, created, work_item_id, run_id, step_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (provider, repo, source_branch, target_branch) DO UPDATE SET url = excluded.url, title = excluded.title, summary = excluded.summary,
           decisions = excluded.decisions, draft = excluded.draft, created = pull_requests.created OR excluded.created,
           run_id = excluded.run_id, step_id = excluded.step_id, work_item_id = COALESCE(excluded.work_item_id, pull_requests.work_item_id), updated_at = now()`,
        [provider.name, w.repo, w.branch, config.baseBranch, pr.url, title, summary, JSON.stringify(decisions), mode === "draft", pr.created, ctx.run.work_item_id, ctx.run.id, ctx.step.id],
      );
      await ctx.log("system", `PR ${w.repo}: ${pr.url} (${pr.note})`);
      out.push({ repo: w.repo, url: pr.url, created: pr.created, note: pr.note, draft: mode === "draft" });
    }
    return { kind: "completed", output: { pull_requests: out } };
  },
};
