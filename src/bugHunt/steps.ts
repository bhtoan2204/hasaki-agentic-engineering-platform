/**
 * Production Bug Hunter — the deterministic workflow steps (integration actions). The two agent steps (hunter and
 * independent verifier) run through the ordinary Agent Harness; these steps collect evidence, bound the scope, decide
 * what is worth verifying, run reproductions in a throwaway sandboxed copy, and apply the verdict rules in logic.ts.
 *
 * Nothing here writes to the original repository: source is read with `git show`/`git ls-files` at the recorded
 * revision; a reproduction runs in a `git archive` export under the data directory (no .git, never committed, removed
 * afterwards) inside the verification sandbox with networking cut and module downloads disabled.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config, codeIntelligenceEnabled } from "../config.ts";
import { pool, q, one } from "../db/pool.ts";
import { repositories } from "../repos/service.ts";
import { checkoutForRun, prepareRepository } from "../repos/workspaces.ts";
import { getIncidentDetail, imageInfo, type GroupRow } from "../prodErrors/scan.ts";
import { navigate } from "../codeIntelligence/lsp/navigate.ts";
import { findReferences } from "../codeIntelligence/search.ts";
import { bwrapAvailable } from "../platform/selfDevelopment.ts";
import type { ExecutionContext } from "../workflow/executors/registry.ts";
import type { ExecResult } from "../workflow/types.ts";
import {
  bareName,
  claimForVerifier,
  classifyRepro,
  decide,
  dedupeCandidates,
  enclosingFunction,
  excerptMatches,
  goFunctions,
  matchFile,
  normalizeCandidates,
  parseFrames,
  parseVerifierOutput,
  REPRO_LIMITS,
  validateReproduction,
  type Candidate,
  type Decision,
  type ReproOutcome,
} from "./logic.ts";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[], max = 16 << 20) =>
  (await exec("git", ["-C", cwd, ...args], { maxBuffer: max, timeout: 30_000 })).stdout;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const fail = (error: string, code: string): ExecResult => ({
  kind: "failed",
  error,
  retryable: false,
  details: { failure_code: code },
});

/** Runs one command in the verification sandbox with networking cut (injected at startup, see executors/index.ts). */
export type IsolatedRunner = (
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<{ code: number | null; output: string; timedOut: boolean }>;
let isolatedRunner: IsolatedRunner | null = null;

/** Registers the bug hunt's integration actions and the sandboxed runner its reproductions use. */
export function registerBugHuntActions(
  register: (name: string, run: (ctx: ExecutionContext) => Promise<ExecResult>) => void,
  runner: IsolatedRunner,
) {
  isolatedRunner = runner;
  register("bug_hunt_context", bugHuntContext);
  register("bug_hunt_scope", bugHuntScope);
  register("bug_hunt_triage", bugHuntTriage);
  register("bug_hunt_reproduce", bugHuntReproduce);
  register("bug_hunt_report", bugHuntReport);
}

/** Scope bounds: a small incident gets a small scope (the hunter may still read around it). */
export const SCOPE_LIMITS = { functions: 6, callers: 10, files: 12 };
export const TRIAGE_DEFAULTS = { minConfidence: 0.5, maxVerify: 3 };

/** The run's read checkout of each selected repository, authorized exactly like an agent step's preflight. */
async function checkouts(ctx: ExecutionContext) {
  const out: Array<{ name: string; path: string }> = [];
  for (const name of ctx.run.selected_repositories) {
    const repo = await repositories.get(name);
    if (
      !repo?.enabled ||
      !repo.allowed_actions.includes("read") ||
      !ctx.run.allowed_repositories.includes(name)
    )
      throw Object.assign(new Error(`Repository ${name} is unavailable or unauthorized`), {
        code: "REPOSITORY_UNAVAILABLE",
      });
    out.push({
      name,
      path: await prepareRepository(repo, false, await checkoutForRun(repo, ctx.run.id)),
    });
  }
  return out;
}

const showFile = (cwd: string, rev: string, path: string) =>
  git(cwd, ["show", `${rev}:${path}`]).catch(() => null);

// ---------------------------------------------------------------- A. incident context

export async function bugHuntContext(ctx: ExecutionContext): Promise<ExecResult> {
  const fp = String(ctx.run.inputs?.fingerprint ?? "");
  let detail: Awaited<ReturnType<typeof getIncidentDetail>>;
  try {
    detail = await getIncidentDetail(fp);
  } catch (e) {
    return fail(`incident ${fp || "(none)"}: ${(e as Error).message}`, "INCIDENT_NOT_FOUND");
  }
  const g = detail.group as unknown as GroupRow & Record<string, unknown>;
  const d = g.detail ?? {};
  if (!ctx.run.selected_repositories.length)
    return fail("no repository selected for the bug hunt", "REPOSITORY_UNAVAILABLE");
  let repos: Array<{ name: string; path: string }>;
  try {
    repos = await checkouts(ctx);
  } catch (e) {
    return fail((e as Error).message, "REPOSITORY_UNAVAILABLE");
  }
  const image = imageInfo(d.image);
  const repositoriesOut = [];
  for (const r of repos) {
    const revision = (await git(r.path, ["rev-parse", "HEAD"])).trim();
    const forThis = image.commit && (repos.length === 1 || image.repo === r.name);
    const prod = forThis
      ? (
          await git(r.path, ["rev-parse", "--verify", "--quiet", `${image.commit}^{commit}`]).catch(
            () => "",
          )
        ).trim()
      : "";
    repositoriesOut.push({
      name: r.name,
      revision,
      production_commit: prod || (forThis ? image.commit : null),
      production_commit_available: !!prod,
      revision_matches_production: prod ? prod === revision : null,
    });
  }
  const frames = parseFrames(d.stack, g.caller);
  const missing: string[] = [];
  if (!d.stack) missing.push("stack trace: not persisted for this incident");
  if (!frames.length)
    missing.push("no source location (stack frame or caller) in the persisted evidence");
  if (!d.request_id && !d.trace_id) missing.push("request/trace id: none persisted");
  missing.push("live logs and traces: not queried (the hunt uses persisted evidence only)");
  for (const r of repositoriesOut)
    if (r.production_commit && !r.production_commit_available)
      missing.push(
        `${r.name}: production commit ${r.production_commit} is not in the local checkout`,
      );
    else if (r.revision_matches_production === false)
      missing.push(
        `${r.name}: investigated revision ${r.revision.slice(0, 12)} is not the production commit ${String(r.production_commit).slice(0, 12)}`,
      );
  const history = await q(
    pool,
    `SELECT fingerprint, signature, caller, day::text AS day, severity, status, today_count, last_at
       FROM prod_error_groups WHERE namespace=$1 AND service=$2 AND fingerprint<>$3
      ORDER BY COALESCE(last_at, first_seen_at) DESC LIMIT 10`,
    [g.namespace, g.service, fp],
  );
  const previous = await q(
    pool,
    `SELECT h.id AS hunt_id, h.run_id, r.status AS run_status, h.created_at,
            (SELECT count(*)::int FROM bug_hunt_findings f WHERE f.hunt_id=h.id AND f.bug_verification_status='CONFIRMED') AS confirmed
       FROM bug_hunts h JOIN workflow_runs r ON r.id=h.run_id WHERE h.fingerprint=$1 AND h.run_id<>$2 ORDER BY h.id DESC LIMIT 5`,
    [fp, ctx.run.id],
  );
  const events = detail.observations.reduce(
    (n, o) => n + Number((o as { event_count?: number }).event_count ?? 0),
    0,
  );
  const output = {
    incident: {
      fingerprint: fp,
      namespace: g.namespace,
      service: g.service,
      level: g.level,
      signature: g.signature,
      caller: g.caller || null,
      error: d.err ?? null,
      observed_symptom: String(g.sample ?? "").slice(0, 2000),
      stack: d.stack ? String(d.stack).slice(0, 6000) : null,
      stack_frames: frames,
      request_id: d.request_id ?? null,
      trace_id: d.trace_id ?? null,
      time_window: {
        first_at: g.first_at ?? g.observed_first_at ?? null,
        last_at: g.last_at ?? g.observed_last_at ?? null,
        day: g.day,
      },
      severity: g.severity,
      events_observed: events,
      production_image: image.repo ? { repo: image.repo, commit: image.commit ?? null } : null,
    },
    repositories: repositoriesOut,
    history: history.map((h) => ({ ...h, same_caller: !!g.caller && h.caller === g.caller })),
    previous_hunts: previous,
    missing_evidence: missing,
  };
  await ctx.log(
    "system",
    `bug hunt context: ${frames.length} source frame(s), ${repositoriesOut.length} repositor${repositoriesOut.length === 1 ? "y" : "ies"}, ${missing.length} evidence gap(s)`,
  );
  return { kind: "completed", output };
}

// ---------------------------------------------------------------- B. scope discovery

interface ScopeFunction {
  repository: string;
  commit: string;
  file_path: string;
  function: string;
  line_start: number;
  line_end: number;
  reason: string;
  source: "stack_frame" | "caller" | "error_text" | "lsp" | "code_intelligence" | "text_search";
}

/** The longest distinctive literal of the incident's error text (what the code would contain to emit it). */
export function errorPhrase(g: {
  signature?: string | null;
  error?: string | null;
}): string | null {
  const text = `${g.error ?? ""}\n${g.signature ?? ""}`;
  const parts = text
    .split(/[:\n"'`{}[\]()=]|\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && /[a-z]/i.test(s) && !/\d{4,}|[0-9a-f]{12,}/i.test(s));
  return parts.sort((a, b) => b.length - a.length)[0]?.slice(0, 80) ?? null;
}

export async function bugHuntScope(ctx: ExecutionContext): Promise<ExecResult> {
  const c = record(ctx.input.upstream.context?.output);
  const incident = record(c.incident);
  const repos = (Array.isArray(c.repositories) ? c.repositories : []) as Array<{
    name: string;
    revision: string;
  }>;
  if (!repos.length)
    return fail(
      "no investigated repository revision from the context step",
      "REPOSITORY_UNAVAILABLE",
    );
  let paths: Array<{ name: string; path: string }>;
  try {
    paths = await checkouts(ctx);
  } catch (e) {
    return fail((e as Error).message, "REPOSITORY_UNAVAILABLE");
  }
  const tools: Record<string, string> = {};
  const limitations: string[] = [];
  const fns: ScopeFunction[] = [];
  const add = (f: ScopeFunction) => {
    if (fns.length >= SCOPE_LIMITS.functions + SCOPE_LIMITS.callers) return;
    if (
      fns.some(
        (x) =>
          x.repository === f.repository && x.file_path === f.file_path && x.function === f.function,
      )
    )
      return;
    fns.push(f);
  };
  const frames = (Array.isArray(incident.stack_frames) ? incident.stack_frames : []) as Array<{
    function: string | null;
    file: string;
    line: number;
  }>;
  const phrase = errorPhrase({
    signature: incident.signature as string,
    error: incident.error as string,
  });
  for (const r of repos) {
    if (ctx.signal.aborted) break;
    const cwd = paths.find((p) => p.name === r.name)?.path;
    if (!cwd) continue;
    const tracked = (await git(cwd, ["ls-tree", "-r", "--name-only", r.revision]))
      .split("\n")
      .filter(Boolean);
    // 1. Stack frames and the logged caller: the code the incident actually executed.
    for (const f of frames) {
      const file = matchFile(f.file, tracked);
      if (!file) continue;
      const src = await showFile(cwd, r.revision, file);
      const span = src && file.endsWith(".go") ? enclosingFunction(src, f.line) : null;
      if (!span) continue;
      add({
        repository: r.name,
        commit: r.revision,
        file_path: file,
        function: span.receiver ? `(${span.receiver}).${span.name}` : span.name,
        line_start: span.start,
        line_end: span.end,
        reason: `incident frame ${f.file}:${f.line}`,
        source: f.function ? "stack_frame" : "caller",
      });
    }
    // 2. Where the incident's error text is produced (bounded exact text search at the revision).
    if (phrase && fns.filter((x) => x.repository === r.name).length < SCOPE_LIMITS.functions) {
      const hits = await git(cwd, [
        "grep",
        "-n",
        "-F",
        "-I",
        "-e",
        phrase,
        r.revision,
        "--",
        "*.go",
      ]).catch(() => "");
      for (const line of hits.split("\n").filter(Boolean).slice(0, 5)) {
        const m = /^[^:]+:([^:]+):(\d+):/.exec(line);
        if (!m) continue;
        const src = await showFile(cwd, r.revision, m[1]);
        const span = src ? enclosingFunction(src, Number(m[2])) : null;
        if (span)
          add({
            repository: r.name,
            commit: r.revision,
            file_path: m[1],
            function: span.receiver ? `(${span.receiver}).${span.name}` : span.name,
            line_start: span.start,
            line_end: span.end,
            reason: `emits the incident's error text "${phrase}"`,
            source: "error_text",
          });
      }
    }
  }
  // 3. Callers of the primary functions: LSP, else Code Intelligence, else a bounded word search.
  const primary = fns.slice(0, SCOPE_LIMITS.functions);
  let callers = 0;
  for (const f of primary) {
    if (callers >= SCOPE_LIMITS.callers || ctx.signal.aborted) break;
    const cwd = paths.find((p) => p.name === f.repository)!.path;
    const name = bareName(f.function);
    const locations: Array<{ path: string; line: number; via: ScopeFunction["source"] }> = [];
    const nav = await navigate(
      { repository: f.repository, path: f.file_path, operation: "incoming_calls", symbol: name },
      { allowed: ctx.run.allowed_repositories, runId: ctx.run.id, signal: ctx.signal },
    ).catch((e) => ({
      status: "unavailable" as const,
      locations: [],
      error: (e as Error).message,
    }));
    tools.lsp =
      nav.status === "ok"
        ? "used"
        : `${nav.status}${"error" in nav && nav.error ? `: ${nav.error}` : ""}`;
    if (nav.status === "ok")
      for (const l of nav.locations) locations.push({ path: l.path, line: l.line, via: "lsp" });
    if (!locations.length && codeIntelligenceEnabled()) {
      const report = { unavailable: [] as string[] };
      const edges = await findReferences(name, {
        repositories: [f.repository],
        allowed: ctx.run.allowed_repositories,
        runId: ctx.run.id,
      }).catch((e) => ((tools.code_intelligence = `unavailable: ${(e as Error).message}`), []));
      if (report.unavailable.length)
        tools.code_intelligence = `stale or unavailable: ${report.unavailable.join(", ")}`;
      for (const e of edges.slice(0, 10))
        locations.push({ path: e.file_path, line: e.line, via: "code_intelligence" });
      if (edges.length) tools.code_intelligence = "used";
    } else if (!codeIntelligenceEnabled())
      tools.code_intelligence = "disabled on this installation";
    if (!locations.length) {
      const hits = await git(cwd, [
        "grep",
        "-n",
        "-w",
        "-I",
        "-e",
        `${name}(`,
        f.commit,
        "--",
        "*.go",
      ]).catch(() => "");
      for (const line of hits.split("\n").filter(Boolean).slice(0, 10)) {
        const m = /^[^:]+:([^:]+):(\d+):/.exec(line);
        if (m && !/_test\.go$/.test(m[1]))
          locations.push({ path: m[1], line: Number(m[2]), via: "text_search" });
      }
      tools.text_search = "used (syntax candidates: a name match is not a resolved call)";
    }
    for (const l of locations) {
      if (callers >= SCOPE_LIMITS.callers) break;
      const src = await showFile(cwd, f.commit, l.path);
      const span = src ? enclosingFunction(src, l.line) : null;
      if (!span || (l.path === f.file_path && span.name === name)) continue;
      const before = fns.length;
      add({
        repository: f.repository,
        commit: f.commit,
        file_path: l.path,
        function: span.receiver ? `(${span.receiver}).${span.name}` : span.name,
        line_start: span.start,
        line_end: span.end,
        reason: `calls ${f.function}`,
        source: l.via,
      });
      if (fns.length > before) callers++;
    }
  }
  if (!frames.length) limitations.push("no stack frame: scope comes from the error text only");
  if (!fns.length)
    limitations.push(
      "no code location could be tied to the incident; the hunter must establish the location itself",
    );
  if (tools.lsp && tools.lsp !== "used") limitations.push(`LSP not used: ${tools.lsp}`);
  const files = [...new Set(fns.map((f) => `${f.repository}:${f.file_path}`))].slice(
    0,
    SCOPE_LIMITS.files,
  );
  await ctx.log("system", `bug hunt scope: ${fns.length} function(s) in ${files.length} file(s)`);
  return {
    kind: "completed",
    output: {
      revisions: Object.fromEntries(repos.map((r) => [r.name, r.revision])),
      functions: fns,
      files,
      error_phrase: phrase,
      tools,
      limitations,
      limits: SCOPE_LIMITS,
    },
  };
}

// ---------------------------------------------------------------- C'. triage (between hunter and verifier)

export async function bugHuntTriage(ctx: ExecutionContext): Promise<ExecResult> {
  const hunt = record(ctx.input.upstream.hunt?.output);
  const scope = record(ctx.input.upstream.scope?.output);
  const revisions = record(scope.revisions) as Record<string, string>;
  const cfg = { ...TRIAGE_DEFAULTS, ...record(ctx.step.config.triage) } as typeof TRIAGE_DEFAULTS;
  const { candidates: raw, malformed } = normalizeCandidates(hunt.candidates);
  let paths: Array<{ name: string; path: string }>;
  try {
    paths = await checkouts(ctx);
  } catch (e) {
    return fail((e as Error).message, "REPOSITORY_UNAVAILABLE");
  }
  const rejected: Array<Candidate & { reason: string }> = [];
  const valid: Candidate[] = [];
  for (const c of raw) {
    const revision = revisions[c.repository];
    const cwd = paths.find((p) => p.name === c.repository)?.path;
    if (!revision || !cwd) {
      rejected.push({ ...c, reason: "repository outside the hunt's authorized scope" });
      continue;
    }
    if (c.commit && !revision.startsWith(c.commit) && c.commit !== revision) {
      rejected.push({
        ...c,
        reason: `cites commit ${c.commit}, but the investigated revision is ${revision}`,
      });
      continue;
    }
    const src = await showFile(cwd, revision, c.file_path);
    if (src === null) {
      rejected.push({ ...c, reason: `${c.file_path} does not exist at ${revision.slice(0, 12)}` });
      continue;
    }
    if (c.line_start > src.split("\n").length) {
      rejected.push({ ...c, reason: `line ${c.line_start} is past the end of ${c.file_path}` });
      continue;
    }
    if (
      c.file_path.endsWith(".go") &&
      !goFunctions(src).some((f) => f.name === bareName(c.function))
    ) {
      rejected.push({ ...c, reason: `function ${c.function} is not declared in ${c.file_path}` });
      continue;
    }
    valid.push({ ...c, commit: revision });
  }
  const { candidates, duplicates } = dedupeCandidates(valid);
  const reused: Array<Candidate & { prior: Record<string, unknown> }> = [];
  const toVerify: Candidate[] = [];
  const deferred: Array<Candidate & { reason: string }> = [];
  for (const c of candidates) {
    // A finding verified before is reused only while its source is byte-identical (same blob of the same file).
    const cwd = paths.find((p) => p.name === c.repository)!.path;
    const blob = (
      await git(cwd, ["rev-parse", `${c.commit}:${c.file_path}`]).catch(() => "")
    ).trim();
    const prior = blob
      ? await one<Record<string, unknown>>(
          pool,
          `SELECT f.id AS finding_id, f.hunt_id, h.run_id, f.bug_verification_status, f.basis, f.commit
             FROM bug_hunt_findings f JOIN bug_hunts h ON h.id=f.hunt_id
            WHERE f.dedupe_key=$1 AND f.file_blob=$2 AND f.reused_from IS NULL AND h.run_id<>$3
              AND h.requested_by IS NOT DISTINCT FROM $4
              AND f.bug_verification_status IN ('CONFIRMED','REJECTED')
            ORDER BY f.id DESC LIMIT 1`,
          [c.dedupe_key, blob, ctx.run.id, ctx.run.owner_id ?? null],
        )
      : null;
    if (prior) reused.push({ ...c, prior });
    else if (c.confidence < cfg.minConfidence)
      deferred.push({
        ...c,
        reason: `confidence ${c.confidence} below the verification threshold ${cfg.minConfidence}`,
      });
    else if (toVerify.length >= cfg.maxVerify)
      deferred.push({
        ...c,
        reason: `verification budget: at most ${cfg.maxVerify} candidates per hunt`,
      });
    else toVerify.push(c);
  }
  await ctx.log(
    "system",
    `bug hunt triage: ${raw.length} candidate(s) → ${toVerify.length} to verify, ${reused.length} reused, ${deferred.length} deferred, ${rejected.length} rejected, ${malformed.length} malformed`,
  );
  return {
    kind: "completed",
    output: {
      verify_needed: toVerify.length > 0,
      to_verify: toVerify.map(claimForVerifier),
      candidates: [...toVerify, ...deferred, ...reused],
      deferred: deferred.map((c) => ({ id: c.id, reason: c.reason })),
      reused: reused.map((c) => ({ id: c.id, prior: c.prior })),
      rejected,
      malformed,
      duplicates,
      thresholds: cfg,
    },
  };
}

// ---------------------------------------------------------------- D'. reproduction (platform-run, isolated)

export interface ReproRun {
  id: string;
  outcome: ReproOutcome | "not_run";
  detail: string;
  command?: string;
  test_file?: string;
  artifact_id?: number;
  duration_ms?: number;
}

export async function bugHuntReproduce(ctx: ExecutionContext): Promise<ExecResult> {
  const verify = ctx.input.upstream.verify;
  if (!verify || verify.status !== "COMPLETED")
    return {
      kind: "completed",
      output: { runs: [], note: "independent verification did not run" },
    };
  const triage = record(ctx.input.upstream.triage?.output);
  const claims = (Array.isArray(triage.to_verify) ? triage.to_verify : []) as Array<
    ReturnType<typeof claimForVerifier>
  >;
  const verdicts = parseVerifierOutput(
    verify.output,
    claims.map((c) => c.id),
  );
  const runs: ReproRun[] = [];
  let paths: Array<{ name: string; path: string }>;
  try {
    paths = await checkouts(ctx);
  } catch (e) {
    return fail((e as Error).message, "REPOSITORY_UNAVAILABLE");
  }
  const sandbox = await bwrapAvailable();
  const runIsolatedCommand = isolatedRunner;
  if (!runIsolatedCommand)
    return fail("no isolated command runner is registered", "GUARANTEE_UNMET");
  for (const claim of claims) {
    const v = verdicts.get(claim.id);
    if (!v || !v.reproduction || (v.verdict !== "CONFIRMED" && v.verdict !== "SUSPECTED")) continue;
    if (runs.length >= REPRO_LIMITS.maxPerHunt) {
      runs.push({
        id: claim.id,
        outcome: "not_run",
        detail: `at most ${REPRO_LIMITS.maxPerHunt} reproductions per hunt`,
      });
      continue;
    }
    const cwd = paths.find((p) => p.name === claim.repository)?.path;
    if (!cwd) {
      runs.push({ id: claim.id, outcome: "blocked", detail: "repository checkout unavailable" });
      continue;
    }
    const tracked = new Set(
      (await git(cwd, ["ls-tree", "-r", "--name-only", claim.commit])).split("\n"),
    );
    const valid = validateReproduction(v.reproduction, (p) => tracked.has(p));
    if (!valid.ok) {
      runs.push({
        id: claim.id,
        outcome: "invalid",
        detail: valid.reason,
        test_file: v.reproduction.test_file,
      });
      continue;
    }
    if (!sandbox) {
      runs.push({
        id: claim.id,
        outcome: "blocked",
        detail:
          "no network-isolated sandbox (bubblewrap) on this worker; reproductions never run unsandboxed",
        command: valid.command,
      });
      continue;
    }
    const root = join(config.dataDir, "bug-hunt-repro");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, `run${ctx.run.id}-${claim.id}-`));
    const t0 = Date.now();
    try {
      // A plain export of the investigated revision: no .git, nothing to commit or push, the checkout is untouched.
      await exec(
        "bash",
        [
          "-c",
          'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"',
          "_",
          cwd,
          claim.commit,
          dir,
        ],
        {
          maxBuffer: 1 << 20,
          timeout: 120_000,
        },
      );
      await writeFile(join(dir, v.reproduction.test_file), v.reproduction.test_code, {
        flag: "wx",
      });
      const r = await runIsolatedCommand(
        valid.command,
        dir,
        {
          GOPROXY: "off",
          GOFLAGS: "-mod=readonly",
          GOTOOLCHAIN: "local",
          BUG_HUNT_REPRODUCTION: "1",
        },
        REPRO_LIMITS.timeoutMs,
        ctx.signal,
      );
      const c = classifyRepro(v.reproduction.test_name, r, ctx.signal.aborted);
      const artifact = await ctx.artifact(
        "bug_hunt_reproduction",
        `${claim.id} ${v.reproduction.test_file}`,
        `$ ${valid.command}\n# exit ${r.code}${r.timedOut ? " (timed out)" : ""}\n\n${r.output}\n\n# test file (${v.reproduction.test_file}):\n${v.reproduction.test_code}`,
        { candidate: claim.id, outcome: c.outcome, exit_code: r.code, command: valid.command },
      );
      runs.push({
        id: claim.id,
        outcome: c.outcome,
        detail: c.detail,
        command: valid.command,
        test_file: v.reproduction.test_file,
        artifact_id: artifact,
        duration_ms: Date.now() - t0,
      });
    } catch (e) {
      runs.push({
        id: claim.id,
        outcome: ctx.signal.aborted ? "canceled" : "blocked",
        detail: `reproduction could not run: ${(e as Error).message.split("\n")[0].slice(0, 300)}`,
        command: valid.command,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  await ctx.log(
    "system",
    `bug hunt reproductions: ${runs.map((r) => `${r.id} ${r.outcome}`).join(", ") || "none proposed"}`,
  );
  return {
    kind: "completed",
    output: { runs, sandbox: sandbox ? "bwrap, network disabled" : "unavailable" },
  };
}

// ---------------------------------------------------------------- final report

export interface FindingOut {
  id: string;
  dedupe_key: string;
  repository: string;
  commit: string;
  file_path: string;
  function: string;
  line_start: number;
  line_end: number;
  category: string;
  hypothesis: string;
  trigger: string;
  expected: string;
  actual: string;
  supporting_evidence: string[];
  reproduction_strategy: string;
  confidence: number;
  uncertainty: string;
  bug_verification_status: Decision["bug_verification_status"];
  basis: string;
  incident_causality_status: Decision["incident_causality_status"];
  causality_basis: string[];
  verification: Record<string, unknown> | null;
  reproduction: ReproRun | null;
  reused_from: Record<string, unknown> | null;
  missing_proof: string[];
  file_blob: string | null;
}

export async function bugHuntReport(ctx: ExecutionContext): Promise<ExecResult> {
  const up = ctx.input.upstream;
  const context = record(up.context?.output);
  const incident = record(context.incident);
  const scope = record(up.scope?.output);
  const triage = record(up.triage?.output);
  const verify = up.verify;
  const repro = record(up.reproduce?.output);
  const evidence = record(up.evidence?.output);
  let paths: Array<{ name: string; path: string }>;
  try {
    paths = await checkouts(ctx);
  } catch (e) {
    return fail((e as Error).message, "REPOSITORY_UNAVAILABLE");
  }
  const verifyStep = await stepRow(ctx.run.id, "verify");
  const candidates = (Array.isArray(triage.candidates) ? triage.candidates : []) as Candidate[];
  const claims = (Array.isArray(triage.to_verify) ? triage.to_verify : []) as Array<{ id: string }>;
  const verifierRan = verify?.status === "COMPLETED";
  const verdicts = verifierRan
    ? parseVerifierOutput(
        verify!.output,
        claims.map((c) => c.id),
      )
    : new Map();
  const runs = (Array.isArray(repro.runs) ? repro.runs : []) as ReproRun[];
  const frames = (Array.isArray(incident.stack_frames) ? incident.stack_frames : []) as Array<{
    file: string;
    line: number;
  }>;
  const scopeFns = (Array.isArray(scope.functions) ? scope.functions : []) as ScopeFunction[];
  const repos = (Array.isArray(context.repositories) ? context.repositories : []) as Array<{
    name: string;
    revision: string;
    production_commit: string | null;
    production_commit_available: boolean;
  }>;
  const deferred = new Map(
    ((triage.deferred ?? []) as Array<{ id: string; reason: string }>).map((d) => [d.id, d.reason]),
  );
  const reused = new Map(
    ((triage.reused ?? []) as Array<{ id: string; prior: Record<string, unknown> }>).map((d) => [
      d.id,
      d.prior,
    ]),
  );
  const incidentEvidence = frames.length > 0 || !!scope.error_phrase;
  const findings: FindingOut[] = [];
  for (const c of candidates) {
    const cwd = paths.find((p) => p.name === c.repository)?.path;
    const src = cwd ? await showFile(cwd, c.commit, c.file_path) : null;
    const blob = cwd
      ? (await git(cwd, ["rev-parse", `${c.commit}:${c.file_path}`]).catch(() => "")).trim() || null
      : null;
    // What the persisted incident evidence says about this location (deterministic, not the agents' opinion).
    const inPath = scopeFns.some(
      (f) =>
        (f.source === "stack_frame" || f.source === "caller") &&
        f.repository === c.repository &&
        f.file_path === c.file_path &&
        bareName(f.function) === bareName(c.function),
    );
    const emitsError = scopeFns.some(
      (f) =>
        f.source === "error_text" &&
        f.repository === c.repository &&
        f.file_path === c.file_path &&
        bareName(f.function) === bareName(c.function),
    );
    // A callee of a failing frame is on the execution path too (a misleading stack shows where it crashed, not why).
    let calledFromPath = false;
    for (const f of scopeFns.filter(
      (x) => (x.source === "stack_frame" || x.source === "caller") && x.repository === c.repository,
    )) {
      if (calledFromPath || !cwd) break;
      const body =
        (await showFile(cwd, f.commit, f.file_path))
          ?.split("\n")
          .slice(f.line_start, f.line_end)
          .join("\n") ?? "";
      calledFromPath = new RegExp(`\\b${bareName(c.function)}\\(`).test(body);
    }
    const repo = repos.find((r) => r.name === c.repository);
    let productionMatch: boolean | null = null;
    if (repo?.production_commit && repo.production_commit_available && cwd)
      productionMatch =
        repo.production_commit === c.commit ||
        (await git(cwd, ["diff", "--quiet", repo.production_commit, c.commit, "--", c.file_path])
          .then(() => true)
          .catch(() => false));
    const link = { inPath, calledFromPath, emitsError, incidentEvidence, productionMatch };
    const base = {
      ...c,
      file_blob: blob,
      reproduction: null,
      verification: null,
      reused_from: null,
      missing_proof: [] as string[],
    };
    const prior = reused.get(c.id);
    if (prior) {
      const status = prior.bug_verification_status as Decision["bug_verification_status"];
      // The earlier verdict stands for the code; the incident link is judged again from THIS incident's evidence,
      // and without a fresh verifier opinion it can be at most PROBABLE.
      const d = decide({
        verdict: null,
        verifierRan: true,
        repro: null,
        codeEvidenceVerified: false,
        link,
      });
      findings.push({
        ...base,
        bug_verification_status: status,
        basis: `reused from hunt #${prior.hunt_id} (run #${prior.run_id}): same defect, byte-identical source; ${prior.basis}`,
        incident_causality_status:
          status === "REJECTED" ? "NOT_APPLICABLE" : d.incident_causality_status,
        causality_basis: d.causality_basis,
        reused_from: prior,
      });
      continue;
    }
    if (deferred.has(c.id)) {
      findings.push({
        ...base,
        bug_verification_status: "SUSPECTED",
        basis: `not sent to independent verification: ${deferred.get(c.id)}`,
        ...pick(
          decide({
            verdict: null,
            verifierRan: true,
            repro: null,
            codeEvidenceVerified: false,
            link,
          }),
        ),
        missing_proof: ["independent verification", "reproduction"],
      });
      continue;
    }
    const v = verdicts.get(c.id) ?? null;
    const run = runs.find((r) => r.id === c.id) ?? null;
    const codeOk =
      !!v &&
      !!src &&
      v.code_evidence.length > 0 &&
      v.code_evidence.every(
        (e: { file_path: string; line_start: number; line_end: number; excerpt: string }) =>
          e.file_path === c.file_path ? excerptMatches(src, e) : false,
      );
    const d = decide({
      verdict: v,
      verifierRan,
      repro: run && run.outcome !== "not_run" ? { outcome: run.outcome, detail: run.detail } : null,
      codeEvidenceVerified: codeOk,
      link,
    });
    const missing: string[] = [];
    if (d.bug_verification_status !== "CONFIRMED" && d.bug_verification_status !== "REJECTED") {
      if (!run || run.outcome !== "reproduced")
        missing.push("a failing focused test on the investigated revision");
      if (!codeOk) missing.push("code excerpts the platform can match at the cited lines");
    }
    findings.push({
      ...base,
      ...d,
      verification: v
        ? {
            verdict: v.verdict,
            reason: v.reason,
            execution_path: v.execution_path,
            alternative_explanations: v.alternative_explanations,
            incident_link: v.incident_link,
            incident_link_reason: v.incident_link_reason,
            code_evidence_verified: codeOk,
            step_id: verifyStep?.id ?? null,
            attempt_id: verifyStep?.current_attempt_id ?? null,
          }
        : null,
      reproduction: run,
      missing_proof: missing,
    });
  }
  const by = (s: string) => findings.filter((f) => f.bug_verification_status === s);
  const partial =
    by("BLOCKED").length > 0 ||
    (claims.length > 0 && !verifierRan) ||
    runs.some((r) => r.outcome === "blocked" || r.outcome === "timeout");
  const telemetry = await q<{
    key: string;
    provider: string | null;
    model: string | null;
    tool_calls: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    reported_cost_usd: number | null;
    wall_duration_ms: number | null;
  }>(
    pool,
    `SELECT s.key, t.provider, t.model, t.tool_calls, t.input_tokens, t.output_tokens, t.reported_cost_usd, t.wall_duration_ms
       FROM execution_attempt_telemetry t JOIN workflow_steps s ON s.id=t.step_id WHERE s.run_id=$1`,
    [ctx.run.id],
  ).catch(() => []);
  const sum = (k: "tool_calls" | "input_tokens" | "output_tokens" | "reported_cost_usd") => {
    const vals = telemetry.map((t) => t[k]).filter((x): x is number => x != null);
    return vals.length ? vals.reduce((a, b) => a + Number(b), 0) : null;
  };
  const cost = sum("reported_cost_usd");
  const platformCalls = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM agent_context_tool_calls WHERE run_id = $1",
    [ctx.run.id],
  ).catch(() => null);
  const started = await one<{ created_at: string }>(
    pool,
    "SELECT created_at FROM workflow_runs WHERE id=$1",
    [ctx.run.id],
  );
  const report = {
    incident: {
      fingerprint: incident.fingerprint,
      service: incident.service,
      namespace: incident.namespace,
      signature: incident.signature,
      observed_symptom: incident.observed_symptom,
      time_window: incident.time_window,
    },
    confirmed: by("CONFIRMED"),
    suspected: by("SUSPECTED"),
    blocked: by("BLOCKED"),
    rejected: [
      ...by("REJECTED"),
      ...((triage.rejected ?? []) as Array<Candidate & { reason: string }>).map((r) => ({
        ...r,
        bug_verification_status: "REJECTED",
        basis: `platform check: ${r.reason}`,
        incident_causality_status: "NOT_APPLICABLE",
      })),
    ],
    root_cause: {
      // Only a confirmed bug with a confirmed incident link is a confirmed root cause.
      confirmed: findings
        .filter(
          (f) =>
            f.bug_verification_status === "CONFIRMED" &&
            f.incident_causality_status === "CONFIRMED",
        )
        .map((f) => f.id),
      investigation: evidence.root_cause ?? null,
      investigation_verification: (record(evidence.verification).status as string) ?? null,
    },
    coverage: {
      revisions: scope.revisions ?? {},
      files_in_scope: scope.files ?? [],
      functions_in_scope: scopeFns.map(
        (f) => `${f.repository}:${f.file_path}:${f.function} (${f.source})`,
      ),
      files_inspected: Array.isArray(record(up.hunt?.output).inspected_files)
        ? record(up.hunt?.output).inspected_files
        : [],
      tools: scope.tools ?? {},
      sources_unavailable: context.missing_evidence ?? [],
      scope_limitations: scope.limitations ?? [],
      candidates: {
        proposed:
          candidates.length +
          ((triage.rejected as unknown[]) ?? []).length +
          ((triage.malformed as unknown[]) ?? []).length,
        verified: claims.length,
        reused: reused.size,
        deferred: deferred.size,
        malformed: ((triage.malformed as unknown[]) ?? []).length,
        duplicates_merged: ((triage.duplicates as Array<{ merged: number }>) ?? []).reduce(
          (n, d) => n + d.merged,
          0,
        ),
      },
    },
    execution: {
      workflow_run_id: ctx.run.id,
      hunter_step: "hunt",
      verification_step_id: verifyStep?.id ?? null,
      providers: [...new Set(telemetry.map((t) => t.provider).filter(Boolean))],
      models: [...new Set(telemetry.map((t) => t.model).filter(Boolean))],
      // Platform tool calls are always recorded; native tool calls only when the provider reports them.
      tool_calls: platformCalls?.n ?? null,
      provider_reported_tool_calls: sum("tool_calls"),
      tokens: { input: sum("input_tokens"), output: sum("output_tokens") },
      cost_usd: cost,
      cost_per_confirmed_bug:
        cost != null && by("CONFIRMED").length ? cost / by("CONFIRMED").length : null,
      duration_ms: started ? Date.now() - new Date(started.created_at).getTime() : null,
      verification: verifierRan ? "completed" : claims.length ? "not completed" : "not needed",
      reproductions: runs.map((r) => ({
        id: r.id,
        outcome: r.outcome,
        artifact_id: r.artifact_id ?? null,
      })),
    },
    partial,
  };
  await persistFindings(ctx, findings, report);
  await ctx.log(
    "system",
    `bug hunt report: ${by("CONFIRMED").length} confirmed, ${by("SUSPECTED").length} suspected, ${report.rejected.length} rejected, ${by("BLOCKED").length} blocked${partial ? " (partial)" : ""}`,
  );
  return { kind: "completed", output: report };
}

const stepRow = (runId: number, key: string) =>
  one<{ id: number; current_attempt_id: number | null; status: string }>(
    pool,
    "SELECT id, current_attempt_id, status FROM workflow_steps WHERE run_id=$1 AND key=$2",
    [runId, key],
  );

const pick = (d: Decision) => ({
  incident_causality_status: d.incident_causality_status,
  causality_basis: d.causality_basis,
});

/** Durable, per-hunt rows (a later hunt never overwrites an earlier one). Replays of this step replace their own rows. */
async function persistFindings(
  ctx: ExecutionContext,
  findings: FindingOut[],
  report: Record<string, unknown>,
) {
  const hunt = await one<{ id: number }>(pool, "SELECT id FROM bug_hunts WHERE run_id=$1", [
    ctx.run.id,
  ]);
  if (!hunt) return;
  const verifyStep = await stepRow(ctx.run.id, "verify");
  const huntStep = await stepRow(ctx.run.id, "hunt");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM bug_hunt_findings WHERE hunt_id=$1", [hunt.id]);
    for (const f of findings)
      await c.query(
        `INSERT INTO bug_hunt_findings (hunt_id, candidate_id, dedupe_key, repository, commit, file_path, function, line_start, line_end,
           category, file_blob, bug_verification_status, incident_causality_status, basis, finding, hunter_attempt_id, verification_step_id,
           verification_attempt_id, reused_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          hunt.id,
          f.id,
          f.dedupe_key,
          f.repository,
          f.commit,
          f.file_path,
          f.function,
          f.line_start,
          f.line_end,
          f.category,
          f.file_blob,
          f.bug_verification_status,
          f.incident_causality_status,
          f.basis.slice(0, 2000),
          JSON.stringify(f),
          huntStep?.current_attempt_id ?? null,
          verifyStep?.id ?? null,
          f.verification ? (verifyStep?.current_attempt_id ?? null) : null,
          f.reused_from ? JSON.stringify(f.reused_from) : null,
        ],
      );
    await c.query("UPDATE bug_hunts SET report=$2, revisions=$3, finished_at=now() WHERE id=$1", [
      hunt.id,
      JSON.stringify(report),
      JSON.stringify(record(report.coverage).revisions ?? {}),
    ]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
