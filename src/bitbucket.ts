import { config } from "./config.ts";
import { currentUserId } from "./auth/execution.ts";
import { getUserSecret } from "./auth/secrets.ts";

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
    if (user && token) return { user, token, workspace: config.bitbucket.workspace, reviewers: config.bitbucket.reviewers };
    if (user || token) throw new Error("This account's Bitbucket credentials are incomplete");
  }
  const shared = config.bitbucket;
  if (shared.allowSharedCredentials !== false && shared.user && shared.token) return { user: shared.user, token: shared.token, workspace: shared.workspace, reviewers: shared.reviewers };
  return null;
}

type BitbucketCredentials = NonNullable<Awaited<ReturnType<typeof resolveBitbucket>>>;

async function call(creds: BitbucketCredentials, path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: "Basic " + Buffer.from(`${creds.user}:${creds.token}`).toString("base64"), "Content-Type": "application/json", Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Bitbucket ${res.status}: check credentials and repository permissions in Integrations`);
  return body;
}

function repositoryReference(repo: string, workspace: string) {
  const parts = repo.split("/");
  const ws = parts.length === 2 ? parts[0] : workspace;
  const slug = parts.at(-1)!;
  if (![ws, slug].every((x) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(x))) throw new Error("Invalid Bitbucket repository reference");
  return { ws, slug };
}

/**
 * Open (or update) the PR for branch -> baseBranch.
 * Without credentials we can't call the API, so return Bitbucket's "new PR" link for a human to click.
 */
export async function openPullRequest(repo: string, branch: string, title: string, description: string, opts: { draft?: boolean; dest?: string } = {}) {
  const creds = await resolveBitbucket();
  const { ws, slug } = repositoryReference(repo, creds?.workspace || config.bitbucket.workspace);
  const dest = opts.dest ?? config.baseBranch;
  if (!creds) {
    const url = `https://bitbucket.org/${ws}/${slug}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(dest)}`;
    return { url, created: false, note: "No Bitbucket credentials configured: open this link to create the PR." };
  }

  const q = encodeURIComponent(`source.branch.name="${branch}" AND destination.branch.name="${dest}" AND state="OPEN"`);
  const existing = await call(creds, `/repositories/${ws}/${slug}/pullrequests?q=${q}`);
  const body = JSON.stringify({
    title,
    description,
    source: { branch: { name: branch } },
    destination: { branch: { name: dest } },
    close_source_branch: false,
    ...(opts.draft ? { draft: true } : {}),
    reviewers: creds.reviewers.map((uuid) => ({ uuid })),
  });

  if (existing.values?.length) {
    const pr = existing.values[0];
    await call(creds, `/repositories/${ws}/${slug}/pullrequests/${pr.id}`, { method: "PUT", body });
    return { url: pr.links.html.href as string, created: false, note: "Existing PR updated." };
  }
  const pr = await call(creds, `/repositories/${ws}/${slug}/pullrequests`, { method: "POST", body });
  return { url: pr.links.html.href as string, created: true, note: "PR created." };
}

/** Read-only: pull requests of a repository (optionally filtered by source branch / state). */
export async function listPullRequests(repo: string, opts: { branch?: string; state?: string } = {}) {
  const creds = await resolveBitbucket();
  if (!creds) throw new Error("No Bitbucket credentials for this account");
  const { ws, slug } = repositoryReference(repo, creds.workspace);
  const filters = [`state="${(opts.state ?? "OPEN").toUpperCase()}"`, ...(opts.branch ? [`source.branch.name="${opts.branch.replace(/"/g, "")}"`] : [])];
  const body = await call(creds, `/repositories/${ws}/${slug}/pullrequests?pagelen=20&q=${encodeURIComponent(filters.join(" AND "))}`);
  return (body.values ?? []).map((p: any) => ({
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
