import { redactSecrets } from "../integrations/redact.ts";
import type { GitProvider, PullRequestRef } from "./provider.ts";

/**
 * Posting review results on the pull/merge request. The PR step calls this after it opened or updated the PR, with
 * the outputs of the run's review steps (contract: `{ approved | verdict, findings: [...], summary }`). It is the only
 * place that writes comments, so no free agent tool can post on a PR. One comment per run and PR: a hidden marker
 * makes retries and later PR steps of the same run skip it.
 */

const MAX_BODY = 60_000;
const MAX_FINDINGS = 50;

export const reviewMarker = (runId: number) => `<!-- platform-review:run-${runId} -->`;

type Finding = Record<string, unknown>;
type ReviewOutput = {
  approved?: unknown;
  verdict?: unknown;
  summary?: unknown;
  findings?: unknown;
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const oneLine = (v: unknown) => text(v).replace(/\s+/g, " ").slice(0, 600);

/** A review output: findings plus a decision (`approved` of a code review or `verdict` of a verification). */
function isReview(o: unknown): o is ReviewOutput {
  if (!o || typeof o !== "object") return false;
  const r = o as ReviewOutput;
  return (
    Array.isArray(r.findings) && (typeof r.approved === "boolean" || typeof r.verdict === "string")
  );
}

/** Markdown comment for the run's review outputs (null when there is no review to report). Secrets are masked. */
export function reviewCommentBody(
  upstream: Record<string, { output?: unknown } | undefined>,
  runId: number,
): string | null {
  const reviews = Object.entries(upstream)
    .filter(([, u]) => isReview(u?.output))
    .map(([step, u]) => ({ step, out: u!.output as ReviewOutput }));
  if (!reviews.length) return null;
  const lines = [reviewMarker(runId), `### Automated review (run #${runId})`];
  for (const { step, out } of reviews) {
    const decision =
      typeof out.approved === "boolean"
        ? out.approved
          ? "approved"
          : "changes requested"
        : text(out.verdict);
    lines.push("", `**${step}**: ${decision}`);
    if (text(out.summary)) lines.push("", oneLine(out.summary));
    const findings = (out.findings as unknown[]).filter(
      (f): f is Finding => !!f && typeof f === "object",
    );
    for (const f of findings.slice(0, MAX_FINDINGS)) {
      const where =
        [text(f.repo), text(f.file)].filter(Boolean).join(":") + (f.line ? `:${text(f.line)}` : "");
      const what = oneLine(f.issue ?? f.explanation ?? f.statement);
      const fix = oneLine(f.suggestion);
      lines.push(
        `- [${text(f.severity) || "info"}]${where ? ` \`${where}\`` : ""} ${what}${fix ? ` — suggestion: ${fix}` : ""}`,
      );
    }
    if (findings.length > MAX_FINDINGS) lines.push(`- … ${findings.length - MAX_FINDINGS} more`);
    if (!findings.length) lines.push("- no findings");
  }
  return redactSecrets(lines.join("\n")).slice(0, MAX_BODY);
}

/**
 * Post the review comment once. Returns what happened; never throws (a comment must not fail a published PR).
 */
export async function publishReviewComment(
  provider: GitProvider,
  ref: PullRequestRef,
  body: string,
  runId: number,
): Promise<{ posted: boolean; reason: string; url?: string }> {
  if (!provider.commentOnPullRequest)
    return { posted: false, reason: `comments are unsupported for ${provider.name}` };
  try {
    const marker = reviewMarker(runId);
    if (provider.pullRequestDiscussions) {
      const { discussions } = await provider.pullRequestDiscussions(ref);
      if (discussions.some((d) => d.notes.some((n) => n.body.includes(marker))))
        return { posted: false, reason: "already posted for this run" };
    }
    const r = await provider.commentOnPullRequest(ref, body);
    return { posted: true, reason: "posted", url: r.url };
  } catch (e) {
    return { posted: false, reason: `comment failed: ${redactSecrets((e as Error).message)}` };
  }
}
