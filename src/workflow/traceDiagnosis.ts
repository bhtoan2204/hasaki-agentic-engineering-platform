import { normalizeProviderFailure, type FailureCategory } from "../agent/telemetry.ts";
import { redactSecrets } from "../integrations/redact.ts";
import type { TraceNode } from "./trace.ts";

export type FindingKind =
  | "failure"
  | "git_worktree_conflict"
  | "repeated_failure"
  | "duplicate_execution"
  | "retry_loop"
  | "stuck"
  | "bottleneck"
  | "token_heavy";

export type FailureSource = "provider" | "tool" | "scheduler" | "workflow_engine" | "unknown";

export interface Finding {
  kind: FindingKind;
  source: FailureSource;
  category: FailureCategory | null;
  summary: string;
  /** Node ids (and event ids) the conclusion rests on — every finding must cite evidence. */
  evidence: string[];
  suggestion: string;
}

export interface DiagnosisOptions {
  /** A step whose attempts exceed this count is reported as a retry loop. */
  loopAttempts?: number;
  /** An attempt that takes more than this share of the run's attempt time is a bottleneck. */
  bottleneckShare?: number;
  tokenThreshold?: number;
  stuckGraceMs?: number;
  now?: number;
}

const sourceOf = (c: FailureCategory): FailureSource =>
  c === "TOOL_FAILURE"
    ? "tool"
    : c === "UNKNOWN"
      ? "unknown"
      : c === "CANCELED"
        ? "workflow_engine"
        : "provider";

const RAW_GIT_CONFLICT = /is already checked out at|is already used by worktree/i;

const errorText = (n: TraceNode) => {
  const e = n.attrs.error as { message?: unknown; error?: unknown } | string | null;
  if (e == null) return "";
  return redactSecrets(typeof e === "string" ? e : String(e.message ?? e.error ?? JSON.stringify(e)));
};

function flatten(n: TraceNode, out: TraceNode[] = []) {
  out.push(n);
  n.children.forEach((c) => flatten(c, out));
  return out;
}

/**
 * Deterministic diagnosis over a built trace. It only states what the trace shows; categories come from the existing
 * normalizeProviderFailure taxonomy, never from a second one.
 */
export function diagnoseTrace(root: TraceNode, opts: DiagnosisOptions = {}): Finding[] {
  const loopAttempts = opts.loopAttempts ?? 3;
  const share = opts.bottleneckShare ?? 0.6;
  const tokenThreshold = opts.tokenThreshold ?? 1_000_000;
  const stuckGraceMs = opts.stuckGraceMs ?? 120_000;
  const now = opts.now ?? Date.now();
  const findings: Finding[] = [];
  const nodes = flatten(root);
  const attempts = nodes.filter((n) => n.type === "attempt");

  for (const step of nodes.filter((n) => n.type === "step")) {
    const list = step.children.filter((c) => c.type === "attempt");
    const failed = list.filter((a) => a.status === "FAILED");
    for (const a of failed) {
      const text = errorText(a);
      const events = (a.attrs.worktreeConflicts as string[] | undefined) ?? [];
      const conflict =
        a.attrs.workspaceConflict === true || events.length > 0 || RAW_GIT_CONFLICT.test(text);
      const recorded = a.attrs.failureCategory as FailureCategory | null;
      const known = recorded != null && recorded !== "UNKNOWN";
      const cat = known ? recorded : normalizeProviderFailure({ message: text });
      if (conflict)
        findings.push({
          kind: "git_worktree_conflict",
          source: "workflow_engine",
          category: null,
          summary: `Step ${step.label}: prepare_branch hit a git worktree conflict (job ${a.ids.jobId ?? "unknown"}, attempt ${a.ids.attemptId}).`,
          evidence: [a.id, step.id, ...events],
          suggestion:
            "Remove the stale worktree or branch lease for this run and retry; a retry on the same branch fails again while the old worktree still holds it.",
        });
      findings.push({
        kind: "failure",
        source: sourceOf(cat),
        category: cat,
        summary: `Attempt ${a.ids.attemptId} of ${step.label} failed (${cat}).`,
        evidence: [a.id],
        suggestion:
          cat === "RATE_LIMIT" || cat === "PROVIDER_UNAVAILABLE"
            ? "Transient provider condition: retry later or hand off to another provider."
            : "Inspect the attempt error and its last tool calls.",
      });
    }
    // Same error again and again: explains why a retry keeps failing.
    const texts = failed.map(errorText).filter(Boolean);
    if (texts.length >= 2 && new Set(texts).size === 1)
      findings.push({
        kind: "repeated_failure",
        source: "unknown",
        category: null,
        summary: `Step ${step.label} failed ${texts.length} times with an identical error, so retrying does not change the outcome.`,
        evidence: failed.map((a) => a.id),
        suggestion: "Fix the cause (see the first failure) before retrying.",
      });
    if (list.length > loopAttempts)
      findings.push({
        kind: "retry_loop",
        source: "workflow_engine",
        category: null,
        summary: `Step ${step.label} has ${list.length} attempts (limit ${loopAttempts}).`,
        evidence: list.map((a) => a.id),
        suggestion: "Check max_attempts and the failure that triggers each retry.",
      });
    // Two attempts of one generation that overlap in time = duplicate execution.
    const byGen = new Map<number, TraceNode[]>();
    for (const a of list) {
      const g = Number(a.attrs.generation ?? 0);
      byGen.set(g, [...(byGen.get(g) ?? []), a]);
    }
    for (const group of byGen.values()) {
      const open = group.filter((a) => a.status === "RUNNING");
      if (open.length > 1)
        findings.push({
          kind: "duplicate_execution",
          source: "scheduler",
          category: null,
          summary: `Step ${step.label} has ${open.length} attempts running at the same time in one generation.`,
          evidence: open.map((a) => a.id),
          suggestion: "Check worker leases and fencing tokens for a double claim.",
        });
    }
    const lastEnd = Math.max(
      ...list.map((a) => (a.startedAt ? new Date(a.startedAt).getTime() + (a.durationMs ?? 0) : 0)),
    );
    const job = step.attrs.liveJob as {
      status: string;
      availableAt: string | null;
      leaseExpiresAt: string | null;
    } | null;
    const at = (v: string | null) => (v ? new Date(v).getTime() : NaN);
    const jobStalled = job
      ? job.status === "queued"
        ? now - at(job.availableAt) >= stuckGraceMs
        : at(job.leaseExpiresAt) < now
      : list.length > 0 &&
        list.every((a) => a.status !== "RUNNING") &&
        now - lastEnd >= stuckGraceMs;
    if (step.status === "RUNNING" && jobStalled)
      findings.push({
        kind: "stuck",
        source: "scheduler",
        category: null,
        summary: !job
          ? `Step ${step.label} is RUNNING but none of its attempts is.`
          : job.status === "queued"
            ? `Step ${step.label} has a job queued since ${job.availableAt} that no worker has claimed.`
            : `Step ${step.label} has a running job whose lease expired at ${job.leaseExpiresAt}.`,
        evidence: [step.id, ...list.map((a) => a.id)],
        suggestion: !job
          ? "No attempt holds the step: recovery or the job queue has not picked it up."
          : job.status === "queued"
            ? "Check that a worker with a matching step type is running and not saturated."
            : "The worker holding the lease is gone: check that the lease reaper is running.",
      });
  }

  const total = attempts.reduce((s, a) => s + (a.durationMs ?? 0), 0);
  if (attempts.length > 1 && total > 0)
    for (const a of attempts)
      if ((a.durationMs ?? 0) / total >= share)
        findings.push({
          kind: "bottleneck",
          source: "unknown",
          category: null,
          summary: `Attempt ${a.ids.attemptId} took ${Math.round(((a.durationMs ?? 0) / total) * 100)}% of all attempt time.`,
          evidence: [a.id],
          suggestion: "Look at its slowest tool calls in the waterfall.",
        });
  for (const a of attempts) {
    const tokens = Number(a.attrs.inputTokens ?? 0) + Number(a.attrs.outputTokens ?? 0);
    if (tokens > tokenThreshold)
      findings.push({
        kind: "token_heavy",
        source: "provider",
        category: null,
        summary: `Attempt ${a.ids.attemptId} used ${tokens} tokens.`,
        evidence: [a.id],
        suggestion: "Reduce the context handed to the step or split it.",
      });
  }
  return findings;
}
