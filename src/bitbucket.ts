import { config } from "./config.ts";

const API = "https://api.bitbucket.org/2.0";

function auth() {
  const { user, token } = config.bitbucket;
  return "Basic " + Buffer.from(`${user}:${token}`).toString("base64");
}

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: auth(), "Content-Type": "application/json", Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Bitbucket ${res.status}: ${JSON.stringify(body?.error ?? body)}`);
  return body;
}

/**
 * Open (or update) the PR for branch -> baseBranch.
 * Without credentials we can't call the API, so return Bitbucket's "new PR" link for a human to click.
 */
export async function openPullRequest(repo: string, branch: string, title: string, description: string, opts: { draft?: boolean; dest?: string } = {}) {
  const ws = config.bitbucket.workspace;
  const dest = opts.dest ?? config.baseBranch;
  if (!config.bitbucket.user || !config.bitbucket.token) {
    const url = `https://bitbucket.org/${ws}/${repo}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(dest)}`;
    return { url, created: false, note: "No Bitbucket credentials configured: open this link to create the PR." };
  }

  const q = encodeURIComponent(`source.branch.name="${branch}" AND destination.branch.name="${dest}" AND state="OPEN"`);
  const existing = await call(`/repositories/${ws}/${repo}/pullrequests?q=${q}`);
  const body = JSON.stringify({
    title,
    description,
    source: { branch: { name: branch } },
    destination: { branch: { name: dest } },
    close_source_branch: false,
    ...(opts.draft ? { draft: true } : {}),
    reviewers: config.bitbucket.reviewers.map((uuid) => ({ uuid })),
  });

  if (existing.values?.length) {
    const pr = existing.values[0];
    await call(`/repositories/${ws}/${repo}/pullrequests/${pr.id}`, { method: "PUT", body });
    return { url: pr.links.html.href as string, created: false, note: "Existing PR updated." };
  }
  const pr = await call(`/repositories/${ws}/${repo}/pullrequests`, { method: "POST", body });
  return { url: pr.links.html.href as string, created: true, note: "PR created." };
}

/** Read-only: pull requests of a repository (optionally filtered by source branch / state). */
export async function listPullRequests(repo: string, opts: { branch?: string; state?: string } = {}) {
  if (!config.bitbucket.user || !config.bitbucket.token) throw new Error("Bitbucket credentials not configured (BITBUCKET_USER / BITBUCKET_TOKEN)");
  const filters = [`state="${(opts.state ?? "OPEN").toUpperCase()}"`, ...(opts.branch ? [`source.branch.name="${opts.branch.replace(/"/g, "")}"`] : [])];
  const body = await call(`/repositories/${config.bitbucket.workspace}/${repo}/pullrequests?pagelen=20&q=${encodeURIComponent(filters.join(" AND "))}`);
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
