import { config } from "./config.ts";
import { currentUserId } from "./auth/execution.ts";
import { getUserSecret } from "./auth/secrets.ts";
import { gitlabHosts, repositoryRemote } from "./repos/remote.ts";
import { redactSecrets } from "./integrations/redact.ts";
import {
  evaluateMergeReadiness,
  type ChangeRequest,
  type ChangeRequestChanges,
  type ChangeRequestDiscussion,
  type ChangeRequestFile,
  type ChangeRequestState,
  type JobSummary,
  type MergeReadiness,
  type PipelineSummary,
} from "./git/model.ts";

/**
 * GitLab REST v4 client for gitlab.com and allow-listed self-hosted instances (config.gitlab.instances).
 * The API base is always derived from the canonical repository URL's host, so a token can only reach a registered
 * instance. Tokens travel in the PRIVATE-TOKEN header (personal and project access tokens), never in a URL, and no
 * error carries a response body, header or URL.
 */

export type GitlabRemote = { host: string; workspace: string; slug: string };

/** The parts of GitLab REST responses this client reads. Every field is optional and read defensively. */
type GlUser = { username?: string | null } | null;
export interface GlPipeline {
  id?: number;
  status?: string;
  ref?: string | null;
  sha?: string | null;
  web_url?: string | null;
  created_at?: string | null;
}
export interface GlMergeRequest {
  iid?: number;
  web_url?: string;
  title?: string;
  description?: string | null;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch?: string;
  target_branch?: string;
  author?: GlUser;
  sha?: string | null;
  diff_refs?: { head_sha?: string | null } | null;
  created_at?: string | null;
  updated_at?: string | null;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  detailed_merge_status?: string | null;
  merge_status?: string | null;
  has_conflicts?: boolean;
  head_pipeline?: GlPipeline | null;
}
interface GlJob {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  allow_failure?: boolean;
  web_url?: string | null;
  failure_reason?: string | null;
}
interface GlDiff {
  old_path?: string;
  new_path?: string;
  diff?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  too_large?: boolean;
  collapsed?: boolean;
}
interface GlNote {
  id?: number;
  body?: string;
  author?: GlUser;
  created_at?: string | null;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
}
interface GlDiscussion {
  id?: string;
  notes?: GlNote[];
}
type GlAccess = { access_level?: number } | null;
export interface GlProject {
  permissions?: { project_access?: GlAccess; group_access?: GlAccess } | null;
  only_allow_merge_if_pipeline_succeeds?: boolean;
  default_branch?: string | null;
  visibility?: string | null;
  web_url?: string | null;
}
interface GlApprovals {
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: unknown[];
}
export interface GlToken {
  scopes?: unknown[];
  active?: boolean;
  revoked?: boolean;
}
interface GlNoteCreated {
  id?: number;
}

export class GitlabError extends Error {
  readonly kind: "auth" | "permission" | "connectivity" | "http";
  readonly status: number | null;
  constructor(kind: GitlabError["kind"], message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}
/** 401: the token is invalid, expired or revoked. */
export class GitlabAuthError extends GitlabError {
  constructor(host: string) {
    super(
      "auth",
      `GitLab ${host} rejected the token (401): save a valid access token in Integrations`,
      401,
    );
  }
}
/** 403/404: the token is valid but cannot see or change this resource. */
export class GitlabPermissionError extends GitlabError {
  constructor(host: string, status: number) {
    super(
      "permission",
      `GitLab ${host} ${status}: no permission for this project or operation`,
      status,
    );
  }
}
/** DNS, TLS, timeout or connection failure. */
export class GitlabConnectivityError extends GitlabError {
  constructor(host: string, detail: string) {
    super("connectivity", `GitLab ${host} unreachable (${detail})`);
  }
}
export class GitlabHttpError extends GitlabError {
  constructor(host: string, status: number) {
    super("http", `GitLab ${host} ${status}`, status);
  }
}

/** Test seam: retry backoff without real waiting. */
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function setGitlabSleep(fn: ((ms: number) => Promise<void>) | null) {
  sleep = fn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
}

const MAX_RETRY_AFTER_MS = 30_000;
/** ANSI colour sequences in CI job logs (ESC [ ... letter). */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const DEFAULT_MAX_PAGES = 20;

export const gitlabSecretKey = (host: string) => `gitlab_token:${host.toLowerCase()}`;

function assertAllowedHost(host: string) {
  if (!gitlabHosts().includes(host.toLowerCase()))
    throw new Error(`GitLab host ${host} is not in config.gitlab.instances`);
  return host.toLowerCase();
}

/**
 * Personal tokens belong to the run owner. The process token is an explicit shared service account and is never
 * used to decide whether that user may read or write the repository.
 */
export async function resolveGitlab(host: string) {
  const h = assertAllowedHost(host);
  const userId = currentUserId();
  if (userId) {
    const token = await getUserSecret(userId, gitlabSecretKey(h));
    if (token) return { token, source: "user" as const };
  }
  if (config.gitlab.allowSharedCredentials && config.gitlab.token)
    return { token: config.gitlab.token, source: "shared" as const };
  return null;
}

/** URL-encoded project id ("group/sub/project" → "group%2Fsub%2Fproject"). */
export const projectId = (r: GitlabRemote) => encodeURIComponent(`${r.workspace}/${r.slug}`);

/** The GitLab remote of a registry row: host from the canonical URL, path from the reference. */
export function gitlabRemoteOf(remoteUrl: string | null | undefined): GitlabRemote {
  if (!remoteUrl) throw new Error("GitLab repository URL is required");
  const remote = repositoryRemote(remoteUrl);
  if (remote.provider !== "gitlab") throw new Error("Not a GitLab repository");
  return { host: remote.host, workspace: remote.workspace, slug: remote.slug };
}

function retryAfterMs(res: Response, attempt: number) {
  const raw = res.headers.get("retry-after");
  const seconds = raw != null && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return backoffMs(attempt);
}
const backoffMs = (attempt: number) => Math.min(250 * 2 ** attempt, 8_000);

export interface GlabResponse<T = unknown> {
  body: T;
  headers: Headers;
  status: number;
}

/**
 * One request with bounded retries: 429 honours Retry-After (capped), 502/503/504 and network failures back off
 * exponentially. Redirects are refused so the token cannot follow a Location header to another host.
 */
export async function glab<T = unknown>(
  host: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<GlabResponse<T>> {
  const h = assertAllowedHost(host);
  if (!path.startsWith("/")) throw new Error("GitLab API path must be absolute");
  const attempts = Math.max(1, Math.min(6, Number(config.gitlab.maxRetries ?? 3)));
  const timeout = Math.max(1_000, Number(config.gitlab.requestTimeoutMs ?? 30_000));
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= attempts - 1;
    let res: Response;
    try {
      res = await fetch(`https://${h}/api/v4${path}`, {
        method: init.method ?? "GET",
        headers: {
          "PRIVATE-TOKEN": token,
          Accept: init.accept ?? "application/json",
          "User-Agent": "hasaki-agentic-engineering-platform",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      const detail =
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network or TLS error";
      if (last) throw new GitlabConnectivityError(h, detail);
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      if (!last) {
        await res.body?.cancel().catch(() => {});
        await sleep(res.status === 429 ? retryAfterMs(res, attempt) : backoffMs(attempt));
        continue;
      }
    }
    if (res.status === 401) throw new GitlabAuthError(h);
    if (res.status === 403 || res.status === 404) throw new GitlabPermissionError(h, res.status);
    if (!res.ok) throw new GitlabHttpError(h, res.status);
    const text = await res.text();
    let body: unknown = text;
    if ((init.accept ?? "application/json") === "application/json") {
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
    }
    return { body: body as T, headers: res.headers, status: res.status };
  }
}

/** Follow x-next-page (or Link rel="next") up to `maxPages`. `truncated` is true when more pages remained. */
export async function glabAll<T = unknown>(
  host: string,
  token: string,
  path: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  let page = 1;
  for (let n = 0; n < maxPages; n++) {
    const res = await glab<T[]>(host, token, `${path}${sep}per_page=100&page=${page}`);
    if (Array.isArray(res.body)) items.push(...res.body);
    const next = nextPage(res.headers);
    if (!next) return { items, truncated: false };
    page = next;
  }
  return { items, truncated: true };
}

function nextPage(headers: Headers): number | null {
  const x = headers.get("x-next-page");
  if (x && /^\d+$/.test(x.trim())) return Number(x);
  const link = headers.get("link") ?? "";
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const m = /[?&]page=(\d+)/.exec(part);
    if (m) return Number(m[1]);
  }
  return null;
}

type Verdict = {
  state: "verified" | "denied" | "unknown";
  can_read: boolean | null;
  can_write: boolean | null;
  reason: string;
};

/** GitLab access levels: 10 guest, 20 reporter, 30 developer, 40 maintainer, 50 owner. */
export function accessLevelVerdict(project: GlProject | null | undefined): Verdict {
  const p = project?.permissions ?? {};
  const levels = [p.project_access?.access_level, p.group_access?.access_level].filter(
    (x): x is number => typeof x === "number",
  );
  const level = levels.length ? Math.max(...levels) : null;
  if (level == null)
    // Public/internal projects are readable without membership; write is not reported.
    return {
      state: "verified",
      can_read: true,
      can_write: null,
      reason: "read verified; no membership reported by GitLab",
    };
  if (level < 20)
    return {
      state: "denied",
      can_read: false,
      can_write: false,
      reason: `GitLab access level ${level}: no repository access`,
    };
  return {
    state: "verified",
    can_read: true,
    can_write: level >= 30,
    reason: level >= 30 ? "verified" : `GitLab access level ${level}: read only`,
  };
}

/** The user's own token against one project. Never throws: unreachable or rejected tokens are "unknown". */
export async function gitlabRepositoryAccess(
  token: string,
  remote: GitlabRemote,
): Promise<Verdict> {
  try {
    const { body } = await glab<GlProject>(remote.host, token, `/projects/${projectId(remote)}`);
    return accessLevelVerdict(body);
  } catch (e) {
    if (e instanceof GitlabPermissionError)
      return {
        state: "denied",
        can_read: false,
        can_write: false,
        reason: `GitLab ${e.status}: no access`,
      };
    if (e instanceof GitlabAuthError)
      return {
        state: "unknown",
        can_read: null,
        can_write: null,
        reason: "personal GitLab token rejected",
      };
    if (e instanceof GitlabConnectivityError)
      return { state: "unknown", can_read: null, can_write: null, reason: "GitLab unreachable" };
    return {
      state: "unknown",
      can_read: null,
      can_write: null,
      reason: e instanceof GitlabError ? e.message : "GitLab check failed",
    };
  }
}

async function credentials(remote: GitlabRemote) {
  const creds = await resolveGitlab(remote.host);
  if (!creds)
    throw new Error(
      `GitLab authentication required: save a personal or project access token for ${remote.host} in Integrations`,
    );
  return creds.token;
}

export const mergeRequestIid = (url: string) =>
  /\/-\/merge_requests\/(\d+)\/?$/.exec(url)?.[1] ?? null;

function mapState(mr: GlMergeRequest | null | undefined): ChangeRequestState | null {
  if (mr?.state === "merged") return "MERGED";
  if (mr?.state === "opened" || mr?.state === "locked") return "OPEN";
  if (mr?.state === "closed") return "DECLINED";
  return null;
}

export function toChangeRequest(mr: GlMergeRequest): ChangeRequest {
  return {
    id: Number(mr.iid),
    url: String(mr.web_url ?? ""),
    title: String(mr.title ?? ""),
    description: String(mr.description ?? ""),
    state: mapState(mr) ?? "OPEN",
    draft: mr.draft === true || mr.work_in_progress === true,
    source: String(mr.source_branch ?? ""),
    target: String(mr.target_branch ?? ""),
    author: mr.author?.username ?? null,
    head_sha: mr.sha ?? mr.diff_refs?.head_sha ?? null,
    created_at: mr.created_at ?? null,
    updated_at: mr.updated_at ?? null,
    merged_at: mr.merged_at ?? null,
    merge_commit: mr.merge_commit_sha ?? mr.squash_commit_sha ?? null,
  };
}

const DRAFT = /^(?:draft:|\[draft\]|\(draft\)|wip:)\s*/i;
export const draftTitle = (title: string, draft: boolean) => {
  const plain = title.replace(DRAFT, "");
  return draft ? `Draft: ${plain}` : plain;
};

/** Open or update the merge request for source → target. A second call updates the open MR instead of creating another. */
export async function openGitlabMergeRequest(
  remote: GitlabRemote,
  branch: string,
  title: string,
  description: string,
  opts: { draft?: boolean; dest?: string } = {},
) {
  const dest = opts.dest ?? "main";
  const creds = await resolveGitlab(remote.host);
  const base = `https://${remote.host}/${remote.workspace}/${remote.slug}`;
  if (!creds) {
    const q = new URLSearchParams({
      "merge_request[source_branch]": branch,
      "merge_request[target_branch]": dest,
    });
    return {
      url: `${base}/-/merge_requests/new?${q}`,
      created: false,
      note: "No GitLab credentials configured: open this link to create the MR.",
    };
  }
  const id = projectId(remote);
  const q = new URLSearchParams({ state: "opened", source_branch: branch, target_branch: dest });
  const { body: existing } = await glab<GlMergeRequest[]>(
    remote.host,
    creds.token,
    `/projects/${id}/merge_requests?${q}`,
  );
  const found = Array.isArray(existing) ? existing[0] : null;
  const fullTitle = draftTitle(title, opts.draft === true);
  if (found?.iid) {
    const { body: updated } = await glab<GlMergeRequest>(
      remote.host,
      creds.token,
      `/projects/${id}/merge_requests/${found.iid}`,
      {
        method: "PUT",
        // Like the GitHub update: title and description change, the MR keeps its current draft status.
        body: { title: draftTitle(title, toChangeRequest(found).draft), description },
      },
    );
    return {
      url: String(updated.web_url ?? found.web_url),
      created: false,
      note: "Existing MR updated.",
    };
  }
  const { body: mr } = await glab<GlMergeRequest>(
    remote.host,
    creds.token,
    `/projects/${id}/merge_requests`,
    {
      method: "POST",
      body: { source_branch: branch, target_branch: dest, title: fullTitle, description },
    },
  );
  return { url: String(mr.web_url), created: true, note: "MR created." };
}

export async function gitlabMergeRequestState(remote: GitlabRemote, url: string) {
  const iid = mergeRequestIid(url);
  if (!iid) return null;
  const creds = await resolveGitlab(remote.host);
  if (!creds) return null;
  const { body: mr } = await glab<GlMergeRequest>(
    remote.host,
    creds.token,
    `/projects/${projectId(remote)}/merge_requests/${iid}`,
  );
  const state = mapState(mr);
  if (!state) return null;
  return {
    state,
    merged_at: state === "MERGED" ? (mr.merged_at ?? null) : null,
    merge_commit: state === "MERGED" ? (mr.merge_commit_sha ?? mr.squash_commit_sha ?? null) : null,
  };
}

function requireIid(url: string) {
  const iid = mergeRequestIid(url);
  if (!iid) throw new Error("Not a GitLab merge request URL");
  return iid;
}

export async function getGitlabMergeRequest(
  remote: GitlabRemote,
  url: string,
): Promise<ChangeRequest> {
  const token = await credentials(remote);
  const { body } = await glab<GlMergeRequest>(
    remote.host,
    token,
    `/projects/${projectId(remote)}/merge_requests/${requireIid(url)}`,
  );
  return toChangeRequest(body);
}

function fileStatus(d: GlDiff): ChangeRequestFile["status"] {
  if (d.new_file) return "added";
  if (d.deleted_file) return "deleted";
  if (d.renamed_file) return "renamed";
  return "modified";
}

/** Changed files with unified diffs, capped by file count and total diff bytes. */
export async function gitlabMergeRequestChanges(
  remote: GitlabRemote,
  url: string,
  opts: { maxFiles?: number; maxDiffBytes?: number } = {},
): Promise<ChangeRequestChanges> {
  const token = await credentials(remote);
  const maxFiles = Math.max(1, Math.min(1000, opts.maxFiles ?? 300));
  const maxBytes = Math.max(1_000, Math.min(2_000_000, opts.maxDiffBytes ?? 200_000));
  const { items, truncated: pagesCut } = await glabAll<GlDiff>(
    remote.host,
    token,
    `/projects/${projectId(remote)}/merge_requests/${requireIid(url)}/diffs`,
    Math.ceil(maxFiles / 100),
  );
  let used = 0;
  let truncated = pagesCut || items.length > maxFiles;
  const files = items.slice(0, maxFiles).map((d) => {
    const f: ChangeRequestFile = {
      path: String(d.new_path ?? d.old_path ?? ""),
      old_path: String(d.old_path ?? d.new_path ?? ""),
      status: fileStatus(d),
    };
    const diff = typeof d.diff === "string" ? d.diff : "";
    if (d.too_large || d.collapsed) truncated = true;
    if (diff && used + diff.length <= maxBytes) {
      f.diff = diff;
      used += diff.length;
    } else if (diff) truncated = true;
    return f;
  });
  return { files, truncated };
}

export async function gitlabMergeRequestDiscussions(
  remote: GitlabRemote,
  url: string,
): Promise<{ discussions: ChangeRequestDiscussion[]; truncated: boolean }> {
  const token = await credentials(remote);
  const { items, truncated } = await glabAll<GlDiscussion>(
    remote.host,
    token,
    `/projects/${projectId(remote)}/merge_requests/${requireIid(url)}/discussions`,
  );
  return {
    truncated,
    discussions: items.map((d) => {
      const notes = Array.isArray(d.notes) ? d.notes : [];
      const resolvable = notes.filter((n) => n.resolvable);
      return {
        id: String(d.id),
        resolved: resolvable.length ? resolvable.every((n) => n.resolved === true) : null,
        notes: notes.map((n) => ({
          id: Number(n.id),
          author: n.author?.username ?? null,
          body: String(n.body ?? ""),
          created_at: n.created_at ?? null,
          path: n.position?.new_path ?? n.position?.old_path ?? null,
          line: n.position?.new_line ?? n.position?.old_line ?? null,
          system: n.system === true,
        })),
      };
    }),
  };
}

export async function commentOnGitlabMergeRequest(remote: GitlabRemote, url: string, body: string) {
  const text = String(body ?? "").trim();
  if (!text) throw new Error("Comment body is required");
  const token = await credentials(remote);
  const { body: note } = await glab<GlNoteCreated>(
    remote.host,
    token,
    `/projects/${projectId(remote)}/merge_requests/${requireIid(url)}/notes`,
    { method: "POST", body: { body: text.slice(0, 100_000) } },
  );
  return { id: Number(note.id), url: `${url}#note_${note.id}` };
}

function toPipeline(remote: GitlabRemote, p: GlPipeline): PipelineSummary {
  return {
    id: Number(p.id),
    status: String(p.status ?? "unknown").toLowerCase(),
    ref: p.ref ?? null,
    sha: p.sha ?? null,
    url:
      p.web_url ?? `https://${remote.host}/${remote.workspace}/${remote.slug}/-/pipelines/${p.id}`,
    created_at: p.created_at ?? null,
  };
}

function toJob(j: GlJob): JobSummary {
  return {
    id: Number(j.id),
    name: String(j.name ?? ""),
    stage: String(j.stage ?? ""),
    status: String(j.status ?? "unknown").toLowerCase(),
    allow_failure: j.allow_failure === true,
    url: j.web_url ?? null,
    failure_reason: j.failure_reason ?? null,
  };
}

async function withJobs(
  remote: GitlabRemote,
  token: string,
  p: PipelineSummary,
): Promise<PipelineSummary> {
  const { items, truncated } = await glabAll<GlJob>(
    remote.host,
    token,
    `/projects/${projectId(remote)}/pipelines/${p.id}/jobs?include_retried=false`,
    3,
  );
  return { ...p, jobs: items.map(toJob), jobs_truncated: truncated };
}

/** Recent pipelines of a branch or a merge request; the newest one includes its jobs. */
export async function gitlabPipelines(
  remote: GitlabRemote,
  q: { ref?: string; url?: string; limit?: number },
): Promise<{ pipelines: PipelineSummary[]; truncated: boolean }> {
  const token = await credentials(remote);
  if (!q.url && !q.ref) throw new Error("A branch or merge request is required");
  const limit = Math.max(1, Math.min(20, q.limit ?? 5));
  const path = q.url
    ? `/projects/${projectId(remote)}/merge_requests/${requireIid(q.url)}/pipelines`
    : `/projects/${projectId(remote)}/pipelines?ref=${encodeURIComponent(q.ref ?? "")}&order_by=id&sort=desc`;
  const { body } = await glab<GlPipeline[]>(
    remote.host,
    token,
    `${path}${path.includes("?") ? "&" : "?"}per_page=${limit}`,
  );
  const list = (Array.isArray(body) ? body : []).map((p) => toPipeline(remote, p));
  if (list[0]) list[0] = await withJobs(remote, token, list[0]);
  return { pipelines: list, truncated: false };
}

/** Tail of a job log, secrets redacted. */
export async function gitlabJobLog(
  remote: GitlabRemote,
  jobId: number,
  tail = 200,
): Promise<{ log: string; truncated: boolean }> {
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error("Invalid job id");
  const token = await credentials(remote);
  const { body } = await glab<string>(
    remote.host,
    token,
    `/projects/${projectId(remote)}/jobs/${jobId}/trace`,
    {
      accept: "text/plain",
    },
  );
  const lines = String(body ?? "")
    // ANSI colour and GitLab section markers make the log unreadable to an agent.
    .replace(ANSI_ESCAPE, "")
    .replace(/section_(?:start|end):\d+:[^\r\n]*\r?/g, "")
    .split(/\r?\n/);
  const n = Math.max(1, Math.min(2000, tail));
  const kept = lines.slice(-n).join("\n");
  return { log: redactSecrets(kept).slice(-200_000), truncated: lines.length > n };
}

async function approvals(remote: GitlabRemote, token: string, iid: string) {
  try {
    const { body } = await glab<GlApprovals>(
      remote.host,
      token,
      `/projects/${projectId(remote)}/merge_requests/${iid}/approvals`,
    );
    const given = Array.isArray(body?.approved_by) ? body.approved_by.length : 0;
    const required =
      typeof body?.approvals_required === "number"
        ? body.approvals_required
        : typeof body?.approvals_left === "number"
          ? given + body.approvals_left
          : 0;
    return { required, given, enforced: typeof body?.approvals_required === "number" };
  } catch (e) {
    // Free tier / older instances: approval rules are not enforced by GitLab.
    if (e instanceof GitlabPermissionError) return { required: 0, given: 0, enforced: false };
    return null;
  }
}

/** Mergeability as GitLab reports it, plus approvals and the head pipeline, under the shared merge policy. */
export async function gitlabMergeReadiness(
  remote: GitlabRemote,
  url: string,
): Promise<MergeReadiness> {
  const token = await credentials(remote);
  const iid = requireIid(url);
  const id = projectId(remote);
  const { body: mr } = await glab<GlMergeRequest>(
    remote.host,
    token,
    `/projects/${id}/merge_requests/${iid}`,
  );
  const { body: project } = await glab<GlProject>(remote.host, token, `/projects/${id}`);
  const head = mr.head_pipeline ? toPipeline(remote, mr.head_pipeline) : null;
  const providerStatus: string | null =
    mr.detailed_merge_status ??
    (mr.merge_status === "can_be_merged" ? "mergeable" : (mr.merge_status ?? null));
  return evaluateMergeReadiness({
    state: mapState(mr),
    draft: toChangeRequest(mr).draft,
    providerStatus,
    hasConflicts: mr.has_conflicts === true,
    approvals: await approvals(remote, token, iid),
    pipeline: head,
    pipelineRequired: project?.only_allow_merge_if_pipeline_succeeds === true,
    headSha: mr.sha ?? null,
  });
}

/**
 * Merge only when the shared policy says so, pinned to the head the check saw (GitLab refuses with 409 if the head
 * moved). GitLab still enforces protected branches and approval rules server-side.
 */
export async function mergeGitlabMergeRequest(
  remote: GitlabRemote,
  url: string,
  opts: { deleteSourceBranch: boolean },
): Promise<{
  merged: boolean;
  state: ChangeRequestState | null;
  merge_commit: string | null;
  reasons: string[];
}> {
  const readiness = await gitlabMergeReadiness(remote, url);
  if (!readiness.mergeable)
    return { merged: false, state: null, merge_commit: null, reasons: readiness.reasons };
  const token = await credentials(remote);
  try {
    const { body } = await glab<GlMergeRequest>(
      remote.host,
      token,
      `/projects/${projectId(remote)}/merge_requests/${requireIid(url)}/merge`,
      {
        method: "PUT",
        body: {
          sha: readiness.head_sha,
          should_remove_source_branch: opts.deleteSourceBranch === true,
        },
      },
    );
    return {
      merged: body?.state === "merged",
      state: mapState(body),
      merge_commit: body?.merge_commit_sha ?? body?.squash_commit_sha ?? null,
      reasons: body?.state === "merged" ? [] : [`GitLab left the MR ${body?.state ?? "unknown"}`],
    };
  } catch (e) {
    if (
      e instanceof GitlabHttpError &&
      (e.status === 405 || e.status === 406 || e.status === 409 || e.status === 422)
    )
      return {
        merged: false,
        state: null,
        merge_commit: null,
        reasons: [`GitLab refused the merge (${e.status})`],
      };
    throw e;
  }
}

export async function closeGitlabMergeRequest(remote: GitlabRemote, url: string) {
  const token = await credentials(remote);
  const { body } = await glab<GlMergeRequest>(
    remote.host,
    token,
    `/projects/${projectId(remote)}/merge_requests/${requireIid(url)}`,
    { method: "PUT", body: { state_event: "close" } },
  );
  return { state: mapState(body) };
}

/** Default branch and protected branches of a project (metadata for discovery and the UI). */
export async function gitlabProjectMetadata(remote: GitlabRemote) {
  const token = await credentials(remote);
  const id = projectId(remote);
  const { body: project } = await glab<GlProject>(remote.host, token, `/projects/${id}`);
  const { items, truncated } = await glabAll<{ name?: string }>(
    remote.host,
    token,
    `/projects/${id}/protected_branches`,
    3,
  );
  return {
    default_branch: project?.default_branch ?? null,
    visibility: project?.visibility ?? null,
    web_url: project?.web_url ?? null,
    protected_branches: items.map((b) => String(b.name ?? "")),
    protected_branches_truncated: truncated,
  };
}
