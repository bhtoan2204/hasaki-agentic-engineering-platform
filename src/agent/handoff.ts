import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { realpath, readFile, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { pool, q, one } from "../db/pool.ts";
import { workspacesOf } from "../git/provider.ts";
import {
  safeDiagnostics,
  normalizeProviderFailure,
  type FailureCategory,
} from "./telemetry.ts";
import { redactContextValue } from "../context/redact.ts";
import { summarizeValue } from "../context/plan.ts";
import { config } from "../config.ts";
import { codexCapabilities } from "./codex/run.ts";
import { cursorCapabilities } from "./cursor/run.ts";
import { antigravityCapabilities } from "./antigravity/capabilities.ts";
import { agentEnvironment } from "./environment.ts";
import type { EffectiveAgent } from "./stepAgent.ts";
import type {
  RunRow,
  StepRow,
  AttemptRow,
  ExecResult,
} from "../workflow/types.ts";

const exec = promisify(execFile);
export const AUTOMATIC_FAILURES: FailureCategory[] = [
  "RATE_LIMIT",
  "QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
];
export const PAUSABLE_FAILURES: FailureCategory[] = [
  ...AUTOMATIC_FAILURES,
  "AUTHENTICATION",
  "CONTEXT_LIMIT",
  "EXECUTION_TIMEOUT",
  "UNKNOWN",
];
export async function providerFailure(
  attemptId: number,
  result: ExecResult,
): Promise<FailureCategory | null> {
  if (result.kind !== "failed") return null;
  const metrics = (
    await one(pool, "SELECT metrics FROM workflow_step_attempts WHERE id=$1", [
      attemptId,
    ])
  )?.metrics;
  // Prefer structured executor/provider diagnostics, then the latest reported session category.
  const detail = result.details as any;
  const normalized = normalizeProviderFailure(
    detail?.provider_error ?? { message: result.error },
  );
  const sessions = Object.values(metrics?.provider_sessions ?? {}) as any[];
  const reported = sessions
    .sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)))
    .find(
      (s) =>
        s.normalized_failure_category &&
        s.normalized_failure_category !== "UNKNOWN",
    )?.normalized_failure_category;
  return normalized !== "UNKNOWN" ? normalized : (reported ?? normalized);
}
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export async function inspectHandoffWorkspace(runId: number) {
  const deadline = AbortSignal.timeout(30000);
  const workspaces = await workspacesOf(runId);
  if (workspaces.length > 30)
    throw new Error("Workspace count exceeds bounded handoff inspection");
  const state = [];
  for (const w of workspaces) {
    const root = await realpath(w.path);
    const git = async (...args: string[]) =>
      (
        await exec(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-C",
            root,
            ...args,
          ],
          {
            signal: deadline,
            timeout: 10000,
            maxBuffer: 5 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          },
        )
      ).stdout;
    if (
      (await realpath((await git("rev-parse", "--show-toplevel")).trim())) !==
      root
    )
      throw new Error("Worktree root changed");
    const branch = (await git("symbolic-ref", "--short", "HEAD")).trim();
    if (branch !== w.branch)
      throw new Error(`Worktree branch changed: ${w.repo}`);
    if (
      (
        await git(
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-only",
          "--diff-filter=U",
        )
      ).trim()
    )
      throw new Error(`Unresolved Git conflicts: ${w.repo}`);
    const head = (await git("rev-parse", "HEAD")).trim();
    const diff = await git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "HEAD",
    );
    const status = await git("status", "--porcelain=v1");
    const names = (
      await git("ls-files", "--others", "--exclude-standard", "-z")
    )
      .split("\0")
      .filter(Boolean);
    if (names.length > 100)
      throw new Error(
        "More than 100 untracked files; reconcile workspace before handoff",
      );
    let bytes = 0;
    const untracked = [];
    for (const name of names) {
      const path = resolve(root, name);
      const rel = relative(root, await realpath(path));
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("Untracked path escapes worktree");
      const stat = await lstat(path);
      bytes += stat.size;
      if (!stat.isFile() || bytes > 5 * 1024 * 1024)
        throw new Error(
          "Untracked state cannot be inspected safely within handoff bounds",
        );
      untracked.push({ path: name, hash: hash(await readFile(path)) });
    }
    state.push({
      repository: w.repo,
      branch,
      path: root,
      head,
      status: status.slice(0, 12000),
      diff_summary: (
        await git("diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD")
      ).slice(0, 12000),
      diff_hash: hash(diff),
      index_hash: hash(
        await git(
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--cached",
          "--binary",
          "HEAD",
        ),
      ),
      untracked,
    });
  }
  return { fingerprint: hash(JSON.stringify(state)), workspaces: state };
}
export async function buildHandoffPackage(
  run: RunRow,
  step: StepRow,
  attempt: AttemptRow,
  reason: string,
) {
  const workspace = await inspectHandoffWorkspace(run.id);
  const [
    continuity,
    packs,
    notes,
    events,
    checkpoints,
    artifacts,
    item,
    observation,
  ] = await Promise.all([
    one(
      pool,
      "SELECT content FROM agent_context_continuity WHERE attempt_id=$1",
      [attempt.id],
    ),
    q(
      pool,
      "SELECT id,snapshot_id FROM agent_context_packs WHERE attempt_id=$1",
      [attempt.id],
    ),
    q(
      pool,
      "SELECT id,data FROM workflow_checkpoints WHERE step_id=$1 ORDER BY id DESC LIMIT 10",
      [step.id],
    ),
    q(
      pool,
      "SELECT id,kind,left(content,2000) AS text,data FROM workflow_events WHERE attempt_id=$1 AND kind IN ('command','tool','tool_result','log') ORDER BY id DESC LIMIT 30",
      [attempt.id],
    ),
    q(
      pool,
      "SELECT id,reason FROM workflow_checkpoints WHERE attempt_id=$1 ORDER BY id DESC LIMIT 20",
      [attempt.id],
    ),
    q(
      pool,
      "SELECT id,kind,name FROM workflow_artifacts WHERE attempt_id=$1 ORDER BY id DESC LIMIT 30",
      [attempt.id],
    ),
    run.work_item_id
      ? one(
          pool,
          "SELECT id,title,description FROM work_items WHERE id=$1 AND owner_id=$2",
          [run.work_item_id, run.owner_id],
        )
      : null,
    one(pool, "SELECT output,metrics FROM workflow_step_attempts WHERE id=$1", [
      attempt.id,
    ]),
  ]);
  const detailed = JSON.stringify(redactContextValue(workspace.workspaces));
  if (detailed.length > 4 * 1024 * 1024)
    throw new Error(
      "Detailed workspace evidence exceeds bounded handoff storage",
    );
  const artifact = await one(
    pool,
    `INSERT INTO workflow_artifacts(run_id,step_id,attempt_id,kind,name,content,data) VALUES($1,$2,$3,'provider_handoff',$4,$5,$6)
 ON CONFLICT(attempt_id,name) WHERE kind='provider_handoff' DO UPDATE SET content=excluded.content RETURNING id`,
    [
      run.id,
      step.id,
      attempt.id,
      `handoff-workspace-${workspace.fingerprint}`,
      detailed,
      JSON.stringify({ fingerprint: workspace.fingerprint }),
    ],
  );
  const content = redactContextValue({
    version: 1,
    workspace_artifact_id: artifact.id,
    workflow_definition_key: run.definition_key,
    definition_version_id: run.definition_version_id,
    run_id: run.id,
    step_id: step.id,
    step_key: step.key,
    source_attempt_id: attempt.id,
    original_task: summarizeValue(
      { item, inputs: run.inputs, instructions: step.config.instructions },
      6000,
    ),
    context_references: {
      transcript_attempt_id: attempt.id,
      snapshot_id: attempt.context_snapshot_id,
      packs,
      artifacts,
      checkpoints,
    },
    business_rules_and_acceptance_criteria:
      "Requirements, enforced rules and remaining criteria are retained in the referenced immutable context pack. Retrieve with platform.get_run_context/get_step_output/search_knowledge; do not discard constraints.",
    repository_state: workspace.workspaces.map((w) => ({
      repository: w.repository,
      branch: w.branch,
      path: w.path,
      head: w.head,
      status: w.status.slice(0, 1000),
      diff_summary: w.diff_summary.slice(0, 1000),
      diff_hash: w.diff_hash,
      index_hash: w.index_hash,
      untracked_count: w.untracked.length,
      details_artifact_id: artifact.id,
    })),
    progress: summarizeValue(
      continuity?.content ?? {
        available: false,
        reason: "No structured progress reported",
        source_output_unverified: observation?.output ?? null,
        verification: observation?.metrics?.verification ?? null,
      },
      10000,
    ),
    previous_decisions_and_pending_work: summarizeValue(notes, 5000),
    commands_tests_and_verification: summarizeValue(events, 6000),
    known_failure: safeDiagnostics(reason),
    safety:
      "Provider-neutral handoff. Inspect current Git state first. Preserve uncommitted changes. Session identifiers are not transferable. Agent claims are not verified completion.",
  });
  if (JSON.stringify(content).length > 128000)
    throw new Error("Handoff metadata exceeds bounded package budget");
  return { content, fingerprint: workspace.fingerprint };
}

/** Readiness checks do not invoke a model or change credentials. Unknown quota/billing is never called available. */
let testReadiness:
  | ((
      a: EffectiveAgent,
    ) => Promise<{ ok: boolean; error?: string; quota: string; cost: string }>)
  | undefined;
export function setHandoffReadinessForTests(value: typeof testReadiness) {
  if (process.env.PLATFORM_TEST !== "1")
    throw new Error("Test readiness override disabled");
  testReadiness = value;
}
export async function handoffReadiness(a: EffectiveAgent) {
  if (testReadiness) return testReadiness(a);
  try {
    if (a.provider === "codex") {
      const c = await codexCapabilities(false, {
        model: a.model ?? "",
        effort: a.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    }
    if (a.provider === "cursor") {
      const c = await cursorCapabilities();
      return {
        ok: c.ok && (!a.model || !!c.supportsModel),
        error:
          c.error ??
          (a.model && !c.supportsModel
            ? "Cursor --model unsupported"
            : undefined),
        quota: "unknown",
        cost: "unknown",
      };
    }
    if (a.provider === "antigravity") {
      const c = await antigravityCapabilities(false, {
        model: a.model ?? "",
        effort: a.reasoning_effort ?? "",
      });
      return { ok: c.ok, error: c.error, quota: "unknown", cost: "unknown" };
    }
    const configured =
      process.env.CLAUDE_CODE_EXECUTABLE || config.agent.claudeBin;
    const bin = configured || "claude";
    const { stdout } = await exec(
      process.execPath === bin
        ? bin
        : bin.endsWith(".js")
          ? process.execPath
          : bin,
      bin.endsWith(".js")
        ? [bin, "auth", "status", "--json"]
        : ["auth", "status", "--json"],
      {
        timeout: 15000,
        maxBuffer: 64000,
        env: agentEnvironment(process.env, "claude"),
      },
    );
    const status = JSON.parse(stdout);
    return {
      ok: status.loggedIn === true,
      error:
        status.loggedIn === true
          ? undefined
          : "Claude authentication readiness not confirmed",
      quota: "unknown",
      cost: "unknown",
    };
  } catch (error) {
    return {
      ok: false,
      error: safeDiagnostics(error),
      quota: "unknown",
      cost: "unknown",
    };
  }
}
