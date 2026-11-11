import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ExecResult, StepSpec } from "../workflow/types.ts";
import { approvedScopeIn } from "./evidence.ts";

/**
 * Independent verification of a coding step's result.
 *
 * The verifier runs in a FRESH Claude session (never resumed) and sees only: the original request, pre-implementation
 * analysis (requirements / acceptance criteria), applicable knowledge, the platform-collected git diff and real test
 * evidence. The coding agent's own summary, decisions and reasoning are filtered out — they are claims, not evidence.
 * The verdict is enforced by the platform: PASS continues, FAIL sends findings back to the coding step for a bounded
 * repair-and-reverification round, BLOCKED asks a human. Every verdict records the commit it judged; the PR step
 * refuses to publish code that changed after the last PASS.
 */

const exec = promisify(execFile);

export type Verdict = "PASS" | "FAIL" | "BLOCKED";
export interface Finding {
  severity: "high" | "medium" | "low";
  file: string;
  line: number | null;
  explanation: string;
  evidence: string;
}
export interface VerdictOutput {
  verdict: Verdict;
  findings: Finding[];
  summary: string;
  blocked_reason?: string;
  /** Scope review (evidence-gated workflows): the verifier's check of the diff against the approved scope. */
  scope_check?: Record<string, unknown>;
}

export const isIndependent = (cfg: Record<string, any> | undefined) => cfg?.independent === true;

/**
 * Upstream outputs an independent verifier may see. Coding steps contribute ONLY their platform-generated
 * `verification` record; agent steps downstream of a coding step (other reviews) are dropped; pre-implementation steps
 * (analysis, plan, approvals, discovery) and deterministic steps (tests, commands) are kept.
 */
export function independentUpstream<T extends { output: any }>(
  graph: Array<Pick<StepSpec, "key" | "type" | "depends_on">>,
  upstream: Record<string, T>,
): Record<string, T> {
  const coding = new Set(graph.filter((s) => s.type === "coding_agent").map((s) => s.key));
  const afterCoding = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of graph)
      if (!afterCoding.has(s.key) && s.depends_on.some((d) => coding.has(d) || afterCoding.has(d)))
        (afterCoding.add(s.key), (grew = true));
  }
  const type = new Map(graph.map((s) => [s.key, s.type]));
  const out: Record<string, T> = {};
  for (const [key, u] of Object.entries(upstream)) {
    if (coding.has(key)) {
      // scope_check is platform-computed (files vs approved scope) plus deviations the author admitted: evidence, not claims of success.
      const scope = u.output?.scope_check ? { scope_check: u.output.scope_check } : {};
      out[key] = {
        ...u,
        output: u.output?.verification
          ? {
              verification: u.output.verification,
              ...scope,
              note: "coding agent's own summary/decisions withheld (independent verification)",
            }
          : { ...scope, note: "coding agent output withheld (independent verification)" },
      };
      continue;
    }
    if (afterCoding.has(key) && (type.get(key) === "agent" || type.get(key) === "coding_agent"))
      continue;
    out[key] = u;
  }
  return out;
}

const SEVERITIES = new Set(["high", "medium", "low"]);

/**
 * Parse the verifier's submit_result. Fail-closed: the platform never upgrades a verdict.
 *  - PASS needs an explicit PASS (or legacy `approved: true`) with no high/medium findings; low findings stay attached
 *    as advisory notes.
 *  - FAIL is always kept as FAIL when it has findings — including low-only findings (the verifier's call; the repair
 *    feedback then lists them). FAIL without any finding cannot drive a repair → BLOCKED.
 *  - Missing, unknown or contradictory output (PASS + high/medium findings, verdict vs `approved` disagreeing, malformed
 *    findings) → BLOCKED: a human decides, it is never treated as success.
 */
export function normalizeVerdict(raw: any): VerdictOutput {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const summary = typeof o.summary === "string" ? o.summary : "";
  const blocked = (reason: string, findings: Finding[] = []): VerdictOutput => ({
    verdict: "BLOCKED",
    findings,
    summary,
    blocked_reason: reason,
  });
  const hasVerdict = o.verdict !== undefined && o.verdict !== null;
  const named = typeof o.verdict === "string" ? o.verdict.trim().toUpperCase() : "";
  if (hasVerdict && !["PASS", "FAIL", "BLOCKED"].includes(named))
    return blocked(
      `the verifier returned an unknown verdict ${JSON.stringify(o.verdict).slice(0, 60)}`,
    );
  if (o.findings !== undefined && o.findings !== null && !Array.isArray(o.findings))
    return blocked("the verifier returned malformed findings (not a list)");
  const findings: Finding[] = (o.findings ?? []).map((f: any) => ({
    severity: SEVERITIES.has(String(f?.severity).toLowerCase())
      ? (String(f.severity).toLowerCase() as Finding["severity"])
      : "medium",
    file: String(f?.file ?? ""),
    line:
      Number.isFinite(Number(f?.line)) && f?.line !== null && f?.line !== ""
        ? Number(f.line)
        : null,
    explanation: String(f?.explanation ?? f?.issue ?? ""),
    evidence: String(f?.evidence ?? f?.suggestion ?? ""),
  }));
  let verdict: Verdict | null = hasVerdict ? (named as Verdict) : null;
  if (
    verdict &&
    typeof o.approved === "boolean" &&
    verdict !== "BLOCKED" &&
    o.approved !== (verdict === "PASS")
  )
    return blocked(
      `contradictory verifier output: verdict ${verdict} but approved=${o.approved}`,
      findings,
    );
  if (!verdict && typeof o.approved === "boolean") verdict = o.approved ? "PASS" : "FAIL";
  if (!verdict) return blocked("the verifier returned no PASS/FAIL/BLOCKED verdict", findings);
  if (verdict === "FAIL") {
    const insufficient = findings.find(
      (f) => !f.file.trim() || !f.explanation.trim() || !f.evidence.trim(),
    );
    if (insufficient)
      return blocked(
        "FAIL findings must include a file, an explanation, and concrete evidence or a repair suggestion",
        findings,
      );
  }
  const serious = findings.filter((f) => f.severity !== "low");
  if (verdict === "PASS" && serious.length)
    return blocked(
      `contradictory verifier output: PASS with ${serious.length} high/medium finding(s)`,
      findings,
    );
  if (verdict === "FAIL" && !findings.length)
    return blocked("FAIL without any finding — nothing to repair", findings);
  if (verdict === "BLOCKED")
    return blocked(String(o.blocked_reason ?? "").trim() || "verifier could not decide", findings);
  return { verdict, findings, summary };
}

/**
 * Scope review (evidence-gated workflows): a PASS must also say the diff stays inside the approved scope, implements no
 * unverified hypothesis as fact, adds no unintended state transition and preserves the business invariants. Fail-closed
 * like normalizeVerdict: a PASS that is missing the check, or contradicts it, becomes BLOCKED — passing unit tests never
 * turn a speculative business-state change into a PASS. Without an approved scope upstream (legacy runs) nothing changes.
 */
export function enforceScopeReview(
  v: VerdictOutput,
  raw: any,
  upstream: Record<string, { output: any; status?: string }>,
): VerdictOutput {
  const scope = approvedScopeIn(upstream);
  if (!scope) return v;
  const c = raw && typeof raw === "object" ? raw : null;
  const coding = Object.values(upstream)
    .map((u) => u.output?.scope_check)
    .find(Boolean);
  const out: VerdictOutput = { ...v, scope_check: c ?? undefined } as VerdictOutput;
  if (v.verdict !== "PASS") return out;
  const blocked = (reason: string): VerdictOutput => ({
    ...out,
    verdict: "BLOCKED",
    blocked_reason: reason,
  });
  if (!c)
    return blocked(
      "scope review missing: a PASS must include scope_check against the approved proposal",
    );
  const listed = (k: string) =>
    Array.isArray(c[k]) ? c[k].filter((x: unknown) => String(x ?? "").trim()) : [];
  if (c.in_scope !== true)
    return blocked("the verifier did not confirm that the diff stays inside the approved scope");
  if (listed("unsupported_assumptions").length)
    return blocked(
      `PASS with unsupported assumptions implemented as fact: ${listed("unsupported_assumptions").slice(0, 3).join("; ")}`,
    );
  if (listed("unintended_state_transitions").length)
    return blocked(
      `PASS with unintended state transitions: ${listed("unintended_state_transitions").slice(0, 3).join("; ")}`,
    );
  if (
    c.invariants_preserved === false ||
    (scope.risk === "HIGH" && c.invariants_preserved !== true)
  )
    return blocked("business invariants of the HIGH-risk change were not confirmed preserved");
  if (coding?.requires_reapproval && !coding?.reapproved)
    return blocked(
      `the implementation deviates from the approved scope without renewed approval: ${(coding.reasons ?? []).join("; ")}`,
    );
  return out;
}

export function findingsFeedback(v: VerdictOutput, round: number, max: number) {
  // Low findings are listed only when the FAIL rests on them alone (the verifier's explicit call).
  const serious = v.findings.filter((f) => f.severity !== "low");
  const lines = (serious.length ? serious : v.findings).map(
    (f, i) =>
      `${i + 1}. [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.explanation}${f.evidence ? `\n   evidence: ${f.evidence}` : ""}`,
  );
  return [
    `Independent verification FAILED (repair ${round} of ${max}). Fix every finding below, keep the change minimal, run the relevant tests, commit, then submit_result again.`,
    ...lines,
    v.summary ? `Verifier summary: ${v.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Turn a verdict into the step result. `repairsUsed` = FAIL verdicts already recorded for this step in this run (all
 * generations). `heads` = the commit of every worktree the verdict judged.
 */
export function enforceVerdict(
  v: VerdictOutput,
  opts: {
    repairsUsed: number;
    maxRepairs: number;
    repairTarget: string | null;
    heads: Record<string, string>;
  },
): ExecResult {
  const output = {
    ...v,
    verified_heads: opts.heads,
    verified_at: new Date().toISOString(),
    approved: v.verdict === "PASS",
    independent: true,
  };
  if (v.verdict === "PASS") return { kind: "completed", output };
  if (v.verdict === "BLOCKED")
    return {
      kind: "waiting_input",
      output,
      questions: [
        {
          question: `Independent verification is BLOCKED: ${v.blocked_reason ?? "verifier could not decide"}. How should it proceed?`,
          context: v.summary || undefined,
          options: [
            "Provide the missing information in your answer and re-verify (the PR still requires a PASS)",
          ],
        },
      ],
    } as ExecResult;
  if (opts.repairTarget && opts.repairsUsed < opts.maxRepairs)
    return {
      kind: "reexecute",
      target: opts.repairTarget,
      feedback: findingsFeedback(v, opts.repairsUsed + 1, opts.maxRepairs),
      output,
    } as ExecResult;
  const top = (
    v.findings.some((f) => f.severity !== "low")
      ? v.findings.filter((f) => f.severity !== "low")
      : v.findings
  )
    .slice(0, 3)
    .map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.explanation}`)
    .join(" | ");
  return {
    kind: "failed",
    error: `independent verification FAILED after ${opts.repairsUsed} repair round(s): ${top}`,
    retryable: false,
    details: output,
  };
}

/**
 * Commits the PR would publish vs. the commits the last PASS judged. Returns the repos that are stale: changed since
 * the PASS, or never judged by it (a repo missing from the verified set is not covered — fail closed).
 */
export function staleVerification(
  verified: Record<string, string> | undefined,
  current: Record<string, string>,
): string[] {
  return Object.entries(current)
    .filter(([repo, sha]) => !sha || !verified?.[repo] || verified[repo] !== sha)
    .map(([repo]) => repo);
}

/** Git state of one repository the PR step is about to publish. */
export interface PublishState {
  head: string; // worktree HEAD ("" = unreadable)
  branchTip: string; // tip of the branch that is pushed ("" = unreadable)
  dirty: string; // `git status --porcelain` ("" = clean)
}

/**
 * The PR gate. `verifiers` = every step of the run marked `independent: true` (with its current status/output);
 * none → verification is optional for this workflow and the gate is open. Otherwise EVERY verifier must hold a valid
 * PASS whose `verified_heads` cover every published repository at exactly the commit that would be pushed, from a
 * clean worktree. Returns the reasons the PR must not be opened (empty = allowed).
 */
export function verificationGate(
  verifiers: Array<{ key: string; status: string; output: any }>,
  publish: Record<string, PublishState>,
): string[] {
  const problems: string[] = [];
  for (const [repo, st] of Object.entries(publish)) {
    if (!st.head || !st.branchTip)
      problems.push(`${repo}: cannot read the commit that would be published`);
    else if (st.head !== st.branchTip)
      problems.push(
        `${repo}: worktree HEAD ${st.head.slice(0, 12)} is not the tip of the pushed branch (${st.branchTip.slice(0, 12)})`,
      );
    if (st.dirty)
      problems.push(
        `${repo}: uncommitted changes in the worktree (they were not verified and would not be published as reviewed)`,
      );
  }
  for (const v of verifiers) {
    const o = v.output ?? {};
    if (
      v.status !== "COMPLETED" ||
      o.independent !== true ||
      o.verdict !== "PASS" ||
      o.approved !== true
    ) {
      problems.push(
        `independent verification "${v.key}" has no valid PASS (status ${v.status}${o.verdict ? `, verdict ${o.verdict}` : ""})`,
      );
      continue;
    }
    const heads =
      o.verified_heads && typeof o.verified_heads === "object"
        ? (o.verified_heads as Record<string, string>)
        : null;
    if (!heads) {
      problems.push(`independent verification "${v.key}" recorded no verified commits`);
      continue;
    }
    const current = Object.fromEntries(
      Object.entries(publish).map(([repo, st]) => [repo, st.branchTip]),
    );
    for (const repo of staleVerification(heads, current))
      problems.push(
        heads[repo]
          ? `${repo}: changed after independent verification "${v.key}" (verified ${heads[repo].slice(0, 12)}, now ${current[repo]?.slice(0, 12) || "unknown"})`
          : `${repo}: not covered by independent verification "${v.key}"`,
      );
  }
  return problems;
}

export async function headOf(path: string) {
  return (await exec("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
}

/** The repair target: the workflow's feedback step, else the nearest coding step upstream of the verifier. */
export function repairTargetFor(
  graph: { feedback_step?: string; steps: Array<Pick<StepSpec, "key" | "type" | "depends_on">> },
  stepKey: string,
): string | null {
  if (graph.feedback_step) return graph.feedback_step;
  const byKey = new Map(graph.steps.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const stack = [...(byKey.get(stepKey)?.depends_on ?? [])];
  while (stack.length) {
    const k = stack.shift()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const s = byKey.get(k);
    if (s?.type === "coding_agent") return k;
    stack.push(...(s?.depends_on ?? []));
  }
  return null;
}

/**
 * Platform-collected evidence: the diff vs origin/<base> and the HEAD of every worktree (bounded). `problems` lists
 * what makes the evidence unbindable to a commit (unreadable HEAD, uncommitted changes): a verdict on it would not
 * describe what the PR publishes, so the executor blocks instead of verifying.
 */
export async function collectEvidence(
  workspaces: Array<{ repo: string; path: string; baseBranch?: string }>,
  baseBranch: string,
  maxChars = 60_000,
) {
  const heads: Record<string, string> = {};
  const problems: string[] = [];
  const parts: string[] = [];
  let budget = maxChars;
  for (const w of workspaces) {
    const head = await headOf(w.path).catch(() => "");
    const dirty = await dirtyOf(w.path);
    if (!head) {
      problems.push(`${w.repo}: cannot read HEAD of ${w.path}`);
      continue;
    }
    heads[w.repo] = head;
    if (dirty)
      problems.push(
        `${w.repo}: uncommitted changes in ${w.path} — the coding step must commit before verification:\n${dirty.slice(0, 2000)}`,
      );
    const stat = (
      await exec(
        "git",
        ["-C", w.path, "diff", "--stat", `origin/${w.baseBranch || baseBranch}...HEAD`],
        { maxBuffer: 8 << 20 },
      ).catch(() => ({ stdout: "(diff unavailable)" }))
    ).stdout.trim();
    let diff = (
      await exec(
        "git",
        ["-C", w.path, "diff", "--no-color", `origin/${w.baseBranch || baseBranch}...HEAD`],
        { maxBuffer: 64 << 20 },
      ).catch(() => ({ stdout: "" }))
    ).stdout;
    if (diff.length > budget)
      diff =
        diff.slice(0, Math.max(0, budget)) +
        `\n… diff truncated — run git diff origin/${w.baseBranch || baseBranch}...HEAD in ${w.path} for the rest`;
    budget -= diff.length;
    parts.push(`### ${w.repo} @ ${head.slice(0, 12)} (worktree ${w.path})\n${stat}\n\n${diff}`);
  }
  return { heads, problems, text: parts.join("\n\n") };
}

/** `git status --porcelain` of a worktree; an unreadable status counts as dirty (fail closed). */
export async function dirtyOf(path: string) {
  return (
    await exec("git", ["-C", path, "status", "--porcelain"]).catch((e) => ({
      stdout: `(git status failed: ${(e as Error).message.split("\n")[0]})`,
    }))
  ).stdout.trim();
}

/** Re-read the worktrees after the verifier ran: the verdict only holds if nothing moved meanwhile. */
export async function evidenceDrift(
  workspaces: Array<{ repo: string; path: string }>,
  heads: Record<string, string>,
) {
  const drift: string[] = [];
  for (const w of workspaces) {
    const now = await headOf(w.path).catch(() => "");
    if (now !== heads[w.repo])
      drift.push(
        `${w.repo}: HEAD moved during verification (${(heads[w.repo] ?? "").slice(0, 12)} → ${now.slice(0, 12) || "unreadable"})`,
      );
    else if (await dirtyOf(w.path)) drift.push(`${w.repo}: worktree changed during verification`);
  }
  return drift;
}

/** Real test evidence among upstream outputs (command steps with results). */
export function hasTestEvidence(upstream: Record<string, { output: any }>) {
  return Object.values(upstream).some(
    (u) => Array.isArray(u.output?.results) && u.output.results.length > 0,
  );
}

/**
 * Bump when the verification rules change (normalizeVerdict / gates / review prompt contract): a PASS recorded under an
 * older policy is never reused.
 */
export const REVIEW_POLICY_VERSION = "2026-11-09.1";

/** Test evidence among upstream outputs, reduced to what a verdict depends on (results + the commits they ran on). */
export function testDigestOf(upstream: Record<string, { output: any }>) {
  return Object.entries(upstream)
    .filter(
      ([, u]) =>
        Array.isArray(u.output?.results) || u.output?.tested_heads || u.output?.verification,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, u]) => [
      k,
      u.output?.results ?? null,
      u.output?.tested_heads ?? null,
      u.output?.verification?.passed ?? null,
    ]);
}

/**
 * Identity of everything a verdict depends on: the exact commits, the base they are compared with, the diff shown to the
 * reviewer, the test evidence, the approved scope (incl. a renewed approval's revision) and the review policy (rules
 * version, step configuration, provider). Same key ⇒ the same review would be repeated; any change ⇒ a new review.
 */
export function verificationKey(input: {
  heads: Record<string, string>;
  baseTips: Record<string, string>;
  diffText: string;
  tests: unknown;
  scope: unknown;
  stepConfig: unknown;
  provider: string;
}) {
  const sorted = (o: Record<string, string>) =>
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        REVIEW_POLICY_VERSION,
        sorted(input.heads),
        sorted(input.baseTips),
        createHash("sha256").update(input.diffText).digest("hex"),
        input.tests,
        input.scope,
        input.stepConfig,
        input.provider,
      ]),
    )
    .digest("hex");
}

/** A prior PASS may be reused only for the identical key AND identical verified commits. */
export function reusablePass(
  prior: { output: any } | null | undefined,
  key: string,
  heads: Record<string, string>,
) {
  const o = prior?.output;
  if (
    !o ||
    o.verdict !== "PASS" ||
    o.approved !== true ||
    o.independent !== true ||
    o.verification_key !== key
  )
    return false;
  return (
    staleVerification(o.verified_heads, heads).length === 0 &&
    Object.keys(o.verified_heads ?? {}).length === Object.keys(heads).length
  );
}

/** Deterministic scope results recorded by coding steps that still lack a renewed approval. A PASS cannot override them. */
export function unresolvedScope(rows: Array<{ key: string; sc: any }>) {
  return rows
    .filter((r) => r.sc?.requires_reapproval === true && !r.sc?.reapproved)
    .map((r) => `${r.key}: ${(r.sc.reasons ?? []).slice(0, 3).join("; ") || "scope violation"}`);
}
