import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecResult, StepSpec } from "../workflow/types.ts";

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
}

export const isIndependent = (cfg: Record<string, any> | undefined) => cfg?.independent === true;

/**
 * Upstream outputs an independent verifier may see. Coding steps contribute ONLY their platform-generated
 * `verification` record; agent steps downstream of a coding step (other reviews) are dropped; pre-implementation steps
 * (analysis, plan, approvals, discovery) and deterministic steps (tests, commands) are kept.
 */
export function independentUpstream<T extends { output: any }>(graph: Array<Pick<StepSpec, "key" | "type" | "depends_on">>, upstream: Record<string, T>): Record<string, T> {
  const coding = new Set(graph.filter((s) => s.type === "coding_agent").map((s) => s.key));
  const afterCoding = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of graph) if (!afterCoding.has(s.key) && s.depends_on.some((d) => coding.has(d) || afterCoding.has(d))) (afterCoding.add(s.key), (grew = true));
  }
  const type = new Map(graph.map((s) => [s.key, s.type]));
  const out: Record<string, T> = {};
  for (const [key, u] of Object.entries(upstream)) {
    if (coding.has(key)) {
      out[key] = { ...u, output: u.output?.verification ? { verification: u.output.verification, note: "coding agent's own summary/decisions withheld (independent verification)" } : { note: "coding agent output withheld (independent verification)" } };
      continue;
    }
    if (afterCoding.has(key) && (type.get(key) === "agent" || type.get(key) === "coding_agent")) continue;
    out[key] = u;
  }
  return out;
}

const SEVERITIES = new Set(["high", "medium", "low"]);

/** Parse the verifier's submit_result; legacy `{ approved }` contracts map to PASS/FAIL. Malformed → BLOCKED. */
export function normalizeVerdict(raw: any): VerdictOutput {
  const o = raw && typeof raw === "object" ? raw : {};
  let verdict: Verdict | null = typeof o.verdict === "string" && ["PASS", "FAIL", "BLOCKED"].includes(o.verdict.toUpperCase()) ? (o.verdict.toUpperCase() as Verdict) : null;
  if (!verdict && typeof o.approved === "boolean") verdict = o.approved ? "PASS" : "FAIL";
  const findings: Finding[] = (Array.isArray(o.findings) ? o.findings : []).map((f: any) => ({
    severity: SEVERITIES.has(String(f?.severity).toLowerCase()) ? (String(f.severity).toLowerCase() as Finding["severity"]) : "medium",
    file: String(f?.file ?? ""),
    line: Number.isFinite(Number(f?.line)) && f?.line !== null && f?.line !== "" ? Number(f.line) : null,
    explanation: String(f?.explanation ?? f?.issue ?? ""),
    evidence: String(f?.evidence ?? f?.suggestion ?? ""),
  }));
  if (!verdict) return { verdict: "BLOCKED", findings, summary: String(o.summary ?? ""), blocked_reason: "the verifier returned no PASS/FAIL/BLOCKED verdict" };
  // A FAIL must be actionable: at least one high/medium finding with a location.
  if (verdict === "FAIL" && !findings.some((f) => f.severity !== "low")) verdict = findings.length ? "PASS" : "BLOCKED";
  return { verdict, findings, summary: String(o.summary ?? ""), ...(verdict === "BLOCKED" ? { blocked_reason: String(o.blocked_reason ?? (o.verdict ? "" : "FAIL without actionable findings")) || "verifier could not decide" } : {}) };
}

export function findingsFeedback(v: VerdictOutput, round: number, max: number) {
  const lines = v.findings
    .filter((f) => f.severity !== "low")
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.explanation}${f.evidence ? `\n   evidence: ${f.evidence}` : ""}`);
  return [
    `Independent verification FAILED (repair ${round} of ${max}). Fix every finding below, keep the change minimal, run the relevant tests, commit, then submit_result again.`,
    ...lines,
    v.summary ? `Verifier summary: ${v.summary}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Turn a verdict into the step result. `repairsUsed` = FAIL verdicts already recorded for this step in this run (all
 * generations). `heads` = the commit of every worktree the verdict judged.
 */
export function enforceVerdict(v: VerdictOutput, opts: { repairsUsed: number; maxRepairs: number; repairTarget: string | null; heads: Record<string, string> }): ExecResult {
  const output = { ...v, verified_heads: opts.heads, verified_at: new Date().toISOString(), approved: v.verdict === "PASS", independent: true };
  if (v.verdict === "PASS") return { kind: "completed", output };
  if (v.verdict === "BLOCKED")
    return {
      kind: "waiting_input",
      output,
      questions: [{ question: `Independent verification is BLOCKED: ${v.blocked_reason ?? "verifier could not decide"}. How should it proceed?`, context: v.summary || undefined, options: ["Provide the missing information in your answer and re-verify", "Accept the risk and let the PR approval decide"] }],
    } as ExecResult;
  if (opts.repairTarget && opts.repairsUsed < opts.maxRepairs)
    return { kind: "reexecute", target: opts.repairTarget, feedback: findingsFeedback(v, opts.repairsUsed + 1, opts.maxRepairs), output } as ExecResult;
  const top = v.findings.filter((f) => f.severity !== "low").slice(0, 3).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.explanation}`).join(" | ");
  return { kind: "failed", error: `independent verification FAILED after ${opts.repairsUsed} repair round(s): ${top}`, retryable: false, details: output };
}

/** Commits the PR would publish vs. the commits the last PASS judged. Returns the repos that changed (stale). */
export function staleVerification(verified: Record<string, string> | undefined, current: Record<string, string>): string[] {
  if (!verified) return [];
  return Object.entries(current).filter(([repo, sha]) => verified[repo] && verified[repo] !== sha).map(([repo]) => repo);
}

export async function headOf(path: string) {
  return (await exec("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
}

/** The repair target: the workflow's feedback step, else the nearest coding step upstream of the verifier. */
export function repairTargetFor(graph: { feedback_step?: string; steps: Array<Pick<StepSpec, "key" | "type" | "depends_on">> }, stepKey: string): string | null {
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

/** Platform-collected evidence: the diff vs origin/<base> and the HEAD of every worktree (bounded). */
export async function collectEvidence(workspaces: Array<{ repo: string; path: string }>, baseBranch: string, maxChars = 60_000) {
  const heads: Record<string, string> = {};
  const parts: string[] = [];
  let budget = maxChars;
  for (const w of workspaces) {
    heads[w.repo] = await headOf(w.path);
    const stat = (await exec("git", ["-C", w.path, "diff", "--stat", `origin/${baseBranch}...HEAD`], { maxBuffer: 8 << 20 }).catch(() => ({ stdout: "(diff unavailable)" }))).stdout.trim();
    let diff = (await exec("git", ["-C", w.path, "diff", "--no-color", `origin/${baseBranch}...HEAD`], { maxBuffer: 64 << 20 }).catch(() => ({ stdout: "" }))).stdout;
    const dirty = (await exec("git", ["-C", w.path, "status", "--porcelain"]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (diff.length > budget) diff = diff.slice(0, Math.max(0, budget)) + `\n… diff truncated — run git diff origin/${baseBranch}...HEAD in ${w.path} for the rest`;
    budget -= diff.length;
    parts.push(`### ${w.repo} @ ${heads[w.repo].slice(0, 12)} (worktree ${w.path})\n${dirty ? `UNCOMMITTED CHANGES (not part of the verified commit):\n${dirty}\n` : ""}${stat}\n\n${diff}`);
  }
  return { heads, text: parts.join("\n\n") };
}

/** Real test evidence among upstream outputs (command steps with results). */
export function hasTestEvidence(upstream: Record<string, { output: any }>) {
  return Object.values(upstream).some((u) => Array.isArray(u.output?.results) && u.output.results.length > 0);
}
