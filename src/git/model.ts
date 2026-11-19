/**
 * Provider-neutral model of a pull request / merge request and its CI. GitHub and Bitbucket pull requests and GitLab
 * merge requests are mapped onto these types by their adapters; workflow code only sees these.
 */

/** Same values pull_requests.state already stores (see learning/outcomes.ts). */
export type ChangeRequestState = "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";

/** Identifies an existing PR/MR by the URL recorded in pull_requests.url. */
export interface PullRequestRef {
  /** repositoryReference(row): "workspace/slug" or "group/subgroup/project". */
  repo: string;
  url: string;
  /** Canonical registry URL. Hosts with several instances (GitLab) need it to know where to call. */
  remoteUrl?: string | null;
}

export interface ChangeRequest {
  id: number;
  url: string;
  title: string;
  description: string;
  state: ChangeRequestState;
  draft: boolean;
  source: string;
  target: string;
  author: string | null;
  head_sha: string | null;
  created_at: string | null;
  updated_at: string | null;
  merged_at: string | null;
  merge_commit: string | null;
  /** Host mergeability when the adapter reads it (null: still computing / not reported). */
  mergeable?: boolean | null;
  conflicts?: boolean | null;
}

export interface ChangeRequestFile {
  path: string;
  old_path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Unified diff of the file; omitted once the overall byte cap is reached. */
  diff?: string;
}

export interface ChangeRequestChanges {
  files: ChangeRequestFile[];
  /** True when files or diff text were cut at the cap: the result is not the complete change. */
  truncated: boolean;
}

export interface ChangeRequestComment {
  id: number;
  author: string | null;
  body: string;
  created_at: string | null;
  /** Inline comment position, when the comment is on a diff line. */
  path?: string | null;
  line?: number | null;
  system: boolean;
}

export interface ChangeRequestDiscussion {
  id: string;
  resolved: boolean | null;
  notes: ChangeRequestComment[];
}

export interface JobSummary {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure: boolean;
  url: string | null;
  failure_reason: string | null;
}

export interface PipelineSummary {
  id: number;
  /** Provider status, lower case (success, failed, running, pending, canceled, skipped, manual, ...). */
  status: string;
  ref: string | null;
  sha: string | null;
  url: string | null;
  created_at: string | null;
  jobs?: JobSummary[];
  /** Jobs were cut at the page cap. */
  jobs_truncated?: boolean;
}

export interface MergeReadiness {
  /** True only when every check passed. Unknown is never mergeable. */
  mergeable: boolean;
  /** Why it is not mergeable (empty when mergeable). */
  reasons: string[];
  approvals: { required: number; given: number; enforced: boolean };
  pipeline: PipelineSummary | null;
  /** The head the readiness was computed for; a merge is pinned to it. */
  head_sha: string | null;
  /** The provider's own mergeability status (GitLab detailed_merge_status). */
  provider_status: string | null;
}

const PIPELINE_OK = new Set(["success"]);
const PIPELINE_RUNNING = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
  "manual",
]);

/**
 * Shared merge policy, independent of the provider: an open, non-draft change request whose provider reports it
 * mergeable, with enough approvals and a successful pipeline when one exists or is required. Anything unknown or
 * truncated refuses.
 */
export function evaluateMergeReadiness(input: {
  state: ChangeRequestState | null;
  draft: boolean;
  providerStatus: string | null;
  hasConflicts: boolean;
  approvals: { required: number; given: number; enforced: boolean } | null;
  pipeline: PipelineSummary | null;
  pipelineRequired: boolean;
  pipelineUnknown?: boolean;
  headSha: string | null;
}): MergeReadiness {
  const reasons: string[] = [];
  if (input.state !== "OPEN") reasons.push(`not open (${input.state ?? "unknown"})`);
  if (input.draft) reasons.push("marked as draft");
  if (input.hasConflicts) reasons.push("has merge conflicts");
  if (input.providerStatus !== "mergeable")
    reasons.push(`provider reports ${input.providerStatus ?? "unknown"} mergeability`);
  const approvals = input.approvals ?? { required: 0, given: 0, enforced: false };
  if (!input.approvals) reasons.push("approval state unknown");
  else if (approvals.given < approvals.required)
    reasons.push(`approvals ${approvals.given}/${approvals.required}`);
  if (input.pipelineUnknown) reasons.push("pipeline status unknown");
  else if (input.pipeline) {
    const s = input.pipeline.status.toLowerCase();
    if (PIPELINE_RUNNING.has(s)) reasons.push(`pipeline not finished (${s})`);
    else if (!PIPELINE_OK.has(s)) reasons.push(`pipeline ${s}`);
  } else if (input.pipelineRequired) reasons.push("required pipeline missing");
  if (!input.headSha) reasons.push("head commit unknown");
  return {
    mergeable: reasons.length === 0,
    reasons,
    approvals,
    pipeline: input.pipeline,
    head_sha: input.headSha,
    provider_status: input.providerStatus,
  };
}
