import { z } from "zod";
import { config } from "./config.ts";
import { currentUserId } from "./auth/execution.ts";
import { getUserSecret } from "./auth/secrets.ts";
import { ignoreError } from "./ignoreError.ts";

const API = "https://api.bitbucket.org/2.0";

/**
 * Personal credentials belong to the run owner. The process config is the explicit shared
 * service account, never another user's saved token.
 */
export async function resolveBitbucket() {
  const userId = currentUserId();
  if (userId) {
    const user = await getUserSecret(userId, "bitbucket_user");
    const token = await getUserSecret(userId, "bitbucket_token");
    if (user && token)
      return {
        user,
        token,
        workspace: config.bitbucket.workspace,
        reviewers: config.bitbucket.reviewers,
      };
    if (user || token) throw new Error("This account's Bitbucket credentials are incomplete");
  }
  const shared = config.bitbucket;
  if (shared.allowSharedCredentials !== false && shared.user && shared.token)
    return {
      user: shared.user,
      token: shared.token,
      workspace: shared.workspace,
      reviewers: shared.reviewers,
    };
  return null;
}

type BitbucketCredentials = NonNullable<Awaited<ReturnType<typeof resolveBitbucket>>>;

const pullRequestLink = z.object({
  links: z.object({ html: z.object({ href: z.url({ protocol: /^https?$/ }) }) }),
});
const branch = z.object({ branch: z.object({ name: z.string().nullish() }).nullish() });
const listedPullRequest = z.object({
  id: z.number().int().positive().nullish(),
  title: z.string().nullish(),
  state: z.string().nullish(),
  source: branch.nullish(),
  destination: branch.nullish(),
  author: z.object({ display_name: z.string().nullish() }).nullish(),
  links: z.object({ html: z.object({ href: z.string().nullish() }).nullish() }).nullish(),
  updated_on: z.string().nullish(),
});
const pullRequestStateResponse = z.object({
  state: z.string().min(1),
  updated_on: z.string().nullish(),
  merge_commit: z.object({ hash: z.string().nullish() }).nullish(),
});

async function responseBody<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("Bitbucket returned an invalid pull request response");
  return parsed.data;
}

async function call(creds: BitbucketCredentials, path: string, init: RequestInit = {}) {
  // Bounded: a hung API call must not hold the step (and its lease) forever. A timed-out create may still have
  // succeeded remotely — the caller reconciles by looking up the open PR before creating another.
  const res = await fetch(API + path, {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.user}:${creds.token}`).toString("base64"),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(ignoreError("bitbucket.cancel_response_body"));
    throw new Error(
      `Bitbucket ${res.status}: check credentials and repository permissions in Integrations`,
    );
  }
  return res;
}

function repositoryReference(repo: string, workspace: string) {
  const parts = repo.split("/");
  const ws = parts.length === 2 ? parts[0] : workspace;
  const slug = parts.at(-1) ?? "";
  if (![ws, slug].every((x) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(x)))
    throw new Error("Invalid Bitbucket repository reference");
  return { ws, slug };
}

/**
 * Open (or update) the PR for branch -> baseBranch.
 * Without credentials we can't call the API, so return Bitbucket's "new PR" link for a human to click.
 */
export async function openPullRequest(
  repo: string,
  branch: string,
  title: string,
  description: string,
  opts: { draft?: boolean; dest?: string } = {},
) {
  const creds = await resolveBitbucket();
  const { ws, slug } = repositoryReference(repo, creds?.workspace || config.bitbucket.workspace);
  const dest = opts.dest ?? config.baseBranch;
  if (!creds) {
    const url = `https://bitbucket.org/${ws}/${slug}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(dest)}`;
    return {
      url,
      created: false,
      note: "No Bitbucket credentials configured: open this link to create the PR.",
    };
  }

  const q = encodeURIComponent(
    `source.branch.name="${branch}" AND destination.branch.name="${dest}" AND state="OPEN"`,
  );
  const existing = await responseBody(
    await call(creds, `/repositories/${ws}/${slug}/pullrequests?q=${q}`),
    z.object({ values: z.array(pullRequestLink.extend({ id: z.number().int().positive() })) }),
  );
  const body = JSON.stringify({
    title,
    description,
    source: { branch: { name: branch } },
    destination: { branch: { name: dest } },
    close_source_branch: false,
    ...(opts.draft ? { draft: true } : {}),
    reviewers: creds.reviewers.map((uuid) => ({ uuid })),
  });

  const [pr] = existing.values;
  if (pr) {
    const updated = await call(creds, `/repositories/${ws}/${slug}/pullrequests/${pr.id}`, {
      method: "PUT",
      body,
    });
    await updated.body?.cancel().catch(ignoreError("bitbucket.cancel_response_body"));
    return { url: pr.links.html.href, created: false, note: "Existing PR updated." };
  }
  const created = await responseBody(
    await call(creds, `/repositories/${ws}/${slug}/pullrequests`, { method: "POST", body }),
    pullRequestLink,
  );
  return { url: created.links.html.href, created: true, note: "PR created." };
}

/** Read-only: lifecycle state of one PR (OPEN / MERGED / DECLINED / SUPERSEDED) from its URL — the proof of a merge. */
export async function pullRequestState(
  repo: string,
  url: string,
): Promise<{ state: string; merged_at: string | null; merge_commit: string | null } | null> {
  const id = url.match(/\/pull-requests\/(\d+)(?:[/?#]|$)/)?.[1];
  if (!id) return null; // a "create PR" link, not a PR
  const creds = await resolveBitbucket();
  if (!creds) throw new Error("No Bitbucket credentials for this account");
  const { ws, slug } = repositoryReference(repo, creds.workspace);
  const pr = await responseBody(
    await call(creds, `/repositories/${ws}/${slug}/pullrequests/${id}`),
    pullRequestStateResponse,
  );
  const state = pr.state.toUpperCase();
  return {
    state,
    merged_at: state === "MERGED" ? (pr.updated_on ?? null) : null,
    merge_commit: pr.merge_commit?.hash ?? null,
  };
}

/** Read-only: pull requests of a repository (optionally filtered by source branch / state). */
export async function listPullRequests(
  repo: string,
  opts: { branch?: string; state?: string } = {},
) {
  const creds = await resolveBitbucket();
  if (!creds) throw new Error("No Bitbucket credentials for this account");
  const { ws, slug } = repositoryReference(repo, creds.workspace);
  const filters = [
    `state="${(opts.state ?? "OPEN").toUpperCase()}"`,
    ...(opts.branch ? [`source.branch.name="${opts.branch.replace(/"/g, "")}"`] : []),
  ];
  const body = await responseBody(
    await call(
      creds,
      `/repositories/${ws}/${slug}/pullrequests?pagelen=20&q=${encodeURIComponent(filters.join(" AND "))}`,
    ),
    z.object({ values: z.array(listedPullRequest) }),
  );
  return body.values.map((p) => ({
    id: p.id,
    title: p.title,
    state: p.state,
    source: p.source?.branch?.name,
    destination: p.destination?.branch?.name,
    author: p.author?.display_name,
    url: p.links?.html?.href,
    updated_on: p.updated_on,
  }));
}
