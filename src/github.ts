import { config } from "./config.ts";
import { currentUserId } from "./auth/execution.ts";
import { getUserSecret } from "./auth/secrets.ts";

const API = "https://api.github.com";

/**
 * Personal tokens belong to the run owner. The process token is an explicit shared service account and is never
 * used to decide whether that user may read or write the repository.
 */
export async function resolveGithub() {
  const userId = currentUserId();
  if (userId) {
    const token = await getUserSecret(userId, "github_token");
    if (token) return { token, source: "user" as const };
  }
  if (config.github.allowSharedCredentials && config.github.token)
    return { token: config.github.token, source: "shared" as const };
  return null;
}

function splitRepo(repo: string) {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new Error("Invalid GitHub repository reference");
  if (![parts[0], parts[1]].every((x) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(x)))
    throw new Error("Invalid GitHub repository reference");
  return { owner: parts[0], name: parts[1] };
}

async function gh(token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "hasaki-agentic-engineering-platform");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(API + path, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return body;
}

/**
 * The user's own token against one repository. Write is taken from the permissions object GitHub returns for that
 * token. A missing permissions object does not count as write.
 */
export async function githubRepositoryAccess(
  token: string,
  owner: string,
  repo: string,
): Promise<{
  state: "verified" | "denied" | "unknown";
  can_read: boolean | null;
  can_write: boolean | null;
  reason: string;
}> {
  let res: Response;
  try {
    res = await fetch(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "hasaki-agentic-engineering-platform",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { state: "unknown", can_read: null, can_write: null, reason: "GitHub unreachable" };
  }
  if (res.status === 401)
    return {
      state: "unknown",
      can_read: null,
      can_write: null,
      reason: "personal GitHub token rejected",
    };
  if (res.status === 403 || res.status === 404)
    return {
      state: "denied",
      can_read: false,
      can_write: false,
      reason: `GitHub ${res.status}: no access`,
    };
  if (!res.ok)
    return { state: "unknown", can_read: null, can_write: null, reason: `GitHub ${res.status}` };
  const body = await res.json().catch(() => ({}));
  const perms = body?.permissions ?? {};
  const can_write =
    perms.admin === true || perms.maintain === true || perms.push === true
      ? true
      : perms.push === false
        ? false
        : null;
  return {
    state: "verified",
    can_read: true,
    can_write,
    reason: can_write == null ? "read verified; write not reported by GitHub" : "verified",
  };
}

/** Open or update the pull request for source → target. A second call updates the open PR instead of creating another. */
export async function openGithubPullRequest(
  repo: string,
  branch: string,
  title: string,
  description: string,
  opts: { draft?: boolean; dest?: string } = {},
) {
  const { owner, name } = splitRepo(repo);
  const dest = opts.dest ?? "main";
  const creds = await resolveGithub();
  if (!creds) {
    const url = `https://github.com/${owner}/${name}/compare/${encodeURIComponent(dest)}...${encodeURIComponent(branch)}?expand=1`;
    return {
      url,
      created: false,
      note: "No GitHub credentials configured: open this link to create the PR.",
    };
  }
  const q = new URLSearchParams({
    head: `${owner}:${branch}`,
    base: dest,
    state: "open",
  });
  const existing = await gh(creds.token, `/repos/${owner}/${name}/pulls?${q}`);
  const found = Array.isArray(existing) ? existing[0] : null;
  if (found?.number) {
    const updated = await gh(creds.token, `/repos/${owner}/${name}/pulls/${found.number}`, {
      method: "PATCH",
      body: JSON.stringify({ title, body: description }),
    });
    return {
      url: String(updated.html_url ?? found.html_url),
      created: false,
      note: "Existing PR updated.",
    };
  }
  const pr = await gh(creds.token, `/repos/${owner}/${name}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title,
      head: branch,
      base: dest,
      body: description,
      draft: opts.draft === true,
    }),
  });
  return { url: String(pr.html_url), created: true, note: "PR created." };
}

export async function githubPullRequestState(
  repo: string,
  url: string,
): Promise<{ state: string; merged_at: string | null; merge_commit: string | null } | null> {
  const id = /\/pull\/(\d+)\/?$/.exec(url)?.[1];
  if (!id) return null;
  const creds = await resolveGithub();
  if (!creds) return null;
  const { owner, name } = splitRepo(repo);
  const pr = await gh(creds.token, `/repos/${owner}/${name}/pulls/${id}`);
  if (pr.merged)
    return {
      state: "MERGED",
      merged_at: pr.merged_at ?? null,
      merge_commit: pr.merge_commit_sha ?? null,
    };
  if (pr.state === "open") return { state: "OPEN", merged_at: null, merge_commit: null };
  if (pr.state === "closed") return { state: "DECLINED", merged_at: null, merge_commit: null };
  return null;
}

const prNumber = (url: string) => /\/pull\/(\d+)\/?$/.exec(url)?.[1] ?? null;

/** Read model of one pull request: head SHA, draft and the host's mergeability (null while GitHub is computing it). */
export async function getGithubPullRequest(repo: string, url: string) {
  const id = prNumber(url);
  const creds = await resolveGithub();
  if (!id || !creds)
    throw new Error("GitHub pull request not readable (no credentials or not a PR URL)");
  const { owner, name } = splitRepo(repo);
  const pr = await gh(creds.token, `/repos/${owner}/${name}/pulls/${id}`);
  return {
    id: Number(pr.number),
    url: String(pr.html_url),
    title: String(pr.title ?? ""),
    description: String(pr.body ?? ""),
    state: (pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "DECLINED") as
      "MERGED" | "OPEN" | "DECLINED",
    draft: pr.draft === true,
    source: String(pr.head?.ref ?? ""),
    target: String(pr.base?.ref ?? ""),
    author: pr.user?.login ?? null,
    head_sha: pr.head?.sha ?? null,
    created_at: pr.created_at ?? null,
    updated_at: pr.updated_at ?? null,
    merged_at: pr.merged_at ?? null,
    merge_commit: pr.merge_commit_sha ?? null,
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    conflicts:
      pr.mergeable_state === "dirty"
        ? true
        : typeof pr.mergeable === "boolean"
          ? !pr.mergeable
          : null,
  };
}

/**
 * Check runs of the PR's current head commit as one pipeline: every job is bound to that SHA. Truncated pages are
 * reported, so a partial list never reads as complete.
 */
export async function githubChecks(repo: string, url: string) {
  const pr = await getGithubPullRequest(repo, url);
  const creds = (await resolveGithub())!;
  const { owner, name } = splitRepo(repo);
  if (!pr.head_sha) return { pipelines: [], truncated: false };
  const res = await gh(
    creds.token,
    `/repos/${owner}/${name}/commits/${pr.head_sha}/check-runs?per_page=100`,
  );
  const runs: any[] = Array.isArray(res.check_runs) ? res.check_runs : [];
  const jobs = runs.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    stage: String(r.app?.slug ?? ""),
    status: r.status === "completed" ? String(r.conclusion ?? "unknown") : String(r.status),
    allow_failure: false,
    url: r.html_url ?? null,
    failure_reason: r.output?.title ?? null,
  }));
  const status = !jobs.length
    ? "none"
    : jobs.some((j) =>
          ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(
            j.status,
          ),
        )
      ? "failed"
      : jobs.some((j) =>
            ["queued", "in_progress", "pending", "waiting", "requested"].includes(j.status),
          )
        ? "running"
        : jobs.every((j) => ["success", "neutral", "skipped"].includes(j.status))
          ? "success"
          : "unknown";
  return {
    pipelines: [
      {
        id: 0,
        status,
        ref: pr.source,
        sha: pr.head_sha,
        url,
        created_at: null,
        jobs,
        jobs_truncated: Number(res.total_count ?? 0) > runs.length,
      },
    ],
    truncated: false,
  };
}

/** Reviews as discussions: the latest CHANGES_REQUESTED of a reviewer is an unresolved thread until they approve. */
export async function githubReviewDiscussions(repo: string, url: string) {
  const id = prNumber(url);
  const creds = await resolveGithub();
  if (!id || !creds) throw new Error("GitHub reviews not readable");
  const { owner, name } = splitRepo(repo);
  const reviews: any[] = await gh(
    creds.token,
    `/repos/${owner}/${name}/pulls/${id}/reviews?per_page=100`,
  );
  const latest = new Map<string, any>();
  for (const r of Array.isArray(reviews) ? reviews : [])
    if (r.user?.login && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state))
      latest.set(r.user.login, r);
  return {
    discussions: [...latest.values()].map((r) => ({
      id: String(r.id),
      resolved: r.state !== "CHANGES_REQUESTED",
      notes: [
        {
          id: Number(r.id),
          author: r.user?.login ?? null,
          body: String(r.body ?? ""),
          created_at: r.submitted_at ?? null,
          system: r.user?.type === "Bot",
        },
      ],
    })),
    truncated: Array.isArray(reviews) && reviews.length >= 100,
  };
}
