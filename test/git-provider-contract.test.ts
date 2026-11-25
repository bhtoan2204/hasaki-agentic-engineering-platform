import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import {
  bitbucketProvider,
  githubProvider,
  gitlabProvider,
  gitProviderFor,
  registeredGitProviders,
  setGitProvider,
  setGitProviderFor,
  type GitProvider,
} from "../src/git/provider.ts";
import { gitHosts, isGitHost } from "../src/git/hosts.ts";
import { evaluateMergeReadiness } from "../src/git/model.ts";
import { setGitlabSleep } from "../src/gitlab.ts";

/**
 * One contract, every Git hosting adapter. Each host is a small in-memory fake behind a mocked fetch: nothing here
 * reaches Bitbucket, GitHub or GitLab, and only fake tokens are used.
 */

const saved = {
  bitbucket: structuredClone(config.bitbucket),
  github: structuredClone(config.github),
  gitlab: structuredClone(config.gitlab),
};

/** Parsed JSON request body (only the fields the fakes read). */
type Body = {
  title?: string;
  head?: string;
  base?: string;
  source_branch?: string;
  target_branch?: string;
  source?: { branch: { name: string } };
  destination?: { branch: { name: string } };
};
type Pr = { id: number; source: string; target: string; title: string; state: string; url: string };
interface Fake {
  provider: GitProvider;
  repo: string;
  remoteUrl: string;
  prs: Pr[];
  posts: () => number;
  handle(url: URL, method: string, body: Body): Response | null;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function bitbucketFake(): Fake {
  const prs: Pr[] = [];
  let posts = 0;
  const base = "/2.0/repositories/acme/shop/pullrequests";
  const view = (p: Pr) => ({ id: p.id, state: p.state, links: { html: { href: p.url } } });
  return {
    provider: bitbucketProvider,
    repo: "acme/shop",
    remoteUrl: "https://bitbucket.org/acme/shop.git",
    prs,
    posts: () => posts,
    handle(url, method, body) {
      if (url.host !== "api.bitbucket.org") return null;
      if (method === "GET" && url.pathname === base) {
        const q = url.searchParams.get("q") ?? "";
        return json({
          values: prs
            .filter(
              (p) =>
                p.state === "OPEN" && q.includes(`"${p.source}"`) && q.includes(`"${p.target}"`),
            )
            .map(view),
        });
      }
      if (method === "POST" && url.pathname === base) {
        posts++;
        const id = prs.length + 1;
        const p = {
          id,
          source: body.source!.branch.name,
          target: body.destination!.branch.name,
          title: String(body.title),
          state: "OPEN",
          url: `https://bitbucket.org/acme/shop/pull-requests/${id}`,
        };
        prs.push(p);
        return json(view(p), 201);
      }
      const m = /\/pullrequests\/(\d+)$/.exec(url.pathname);
      if (m) {
        const p = prs.find((x) => x.id === Number(m[1]))!;
        if (method === "PUT") p.title = String(body.title);
        return json(view(p));
      }
      return null;
    },
  };
}

function githubFake(): Fake {
  const prs: Pr[] = [];
  let posts = 0;
  const view = (p: Pr) => ({
    number: p.id,
    html_url: p.url,
    state: p.state === "OPEN" ? "open" : "closed",
    merged: p.state === "MERGED",
  });
  return {
    provider: githubProvider,
    repo: "acme/shop",
    remoteUrl: "https://github.com/acme/shop.git",
    prs,
    posts: () => posts,
    handle(url, method, body) {
      if (url.host !== "api.github.com") return null;
      if (method === "GET" && url.pathname === "/repos/acme/shop/pulls") {
        const head = url.searchParams.get("head");
        return json(
          prs
            .filter(
              (p) =>
                p.state === "OPEN" &&
                `acme:${p.source}` === head &&
                p.target === url.searchParams.get("base"),
            )
            .map(view),
        );
      }
      if (method === "POST" && url.pathname === "/repos/acme/shop/pulls") {
        posts++;
        const id = prs.length + 1;
        const p = {
          id,
          source: String(body.head),
          target: String(body.base),
          title: String(body.title),
          state: "OPEN",
          url: `https://github.com/acme/shop/pull/${id}`,
        };
        prs.push(p);
        return json(view(p), 201);
      }
      const m = /\/pulls\/(\d+)$/.exec(url.pathname);
      if (m) {
        const p = prs.find((x) => x.id === Number(m[1]))!;
        if (method === "PATCH") p.title = String(body.title);
        return json(view(p));
      }
      return null;
    },
  };
}

function gitlabFake(): Fake {
  const prs: Pr[] = [];
  let posts = 0;
  const base = "/api/v4/projects/acme%2Fteam%2Fshop/merge_requests";
  const view = (p: Pr) => ({
    iid: p.id,
    web_url: p.url,
    title: p.title,
    state: { OPEN: "opened", MERGED: "merged", DECLINED: "closed" }[p.state],
  });
  return {
    provider: gitlabProvider,
    repo: "acme/team/shop",
    remoteUrl: "https://gitlab.example.work/acme/team/shop.git",
    prs,
    posts: () => posts,
    handle(url, method, body) {
      if (url.host !== "gitlab.example.work") return null;
      // fetch() receives the encoded project id; URL keeps %2F in the path.
      if (method === "GET" && url.pathname === base) {
        const s = url.searchParams;
        return json(
          prs
            .filter(
              (p) =>
                p.state === "OPEN" &&
                p.source === s.get("source_branch") &&
                p.target === s.get("target_branch"),
            )
            .map(view),
        );
      }
      if (method === "POST" && url.pathname === base) {
        posts++;
        const id = prs.length + 1;
        const p = {
          id,
          source: String(body.source_branch),
          target: String(body.target_branch),
          title: String(body.title),
          state: "OPEN",
          url: `https://gitlab.example.work/acme/team/shop/-/merge_requests/${id}`,
        };
        prs.push(p);
        return json(view(p), 201);
      }
      const m = /\/merge_requests\/(\d+)$/.exec(url.pathname);
      if (m) {
        const p = prs.find((x) => x.id === Number(m[1]))!;
        if (method === "PUT") p.title = String(body.title);
        return json(view(p));
      }
      return null;
    },
  };
}

let fakes: Fake[] = [];
beforeEach(() => {
  config.bitbucket.user = "contract-user";
  config.bitbucket.token = "fake-bitbucket-token";
  config.bitbucket.allowSharedCredentials = true;
  config.github.allowSharedCredentials = true;
  config.github.token = "fake-github-token";
  config.gitlab.instances = [{ host: "gitlab.com" }, { host: "gitlab.example.work" }];
  config.gitlab.allowSharedCredentials = true;
  config.gitlab.token = "glpat-CONTRACT000000000000";
  setGitlabSleep(async () => {});
  fakes = [bitbucketFake(), githubFake(), gitlabFake()];
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const body: Body = init.body ? (JSON.parse(String(init.body)) as Body) : {};
      for (const f of fakes) {
        const r = f.handle(url, init.method ?? "GET", body);
        if (r) return r;
      }
      throw new Error(`unexpected request ${init.method ?? "GET"} ${url.host}${url.pathname}`);
    },
  );
});
afterEach(() => {
  mock.restoreAll();
  setGitlabSleep(null);
  Object.assign(config.bitbucket, structuredClone(saved.bitbucket));
  Object.assign(config.github, structuredClone(saved.github));
  Object.assign(config.gitlab, structuredClone(saved.gitlab));
});

for (const name of ["bitbucket", "github", "gitlab"]) {
  const fake = () => fakes.find((f) => f.provider.name === name)!;

  test(`${name}: openOrUpdatePullRequest is idempotent for the same source and target`, async () => {
    const f = fake();
    const pr = {
      repo: f.repo,
      source: "feat/x",
      target: "main",
      description: "d",
      draft: false,
      remoteUrl: f.remoteUrl,
    };
    const first = await f.provider.openOrUpdatePullRequest({ ...pr, title: "one" });
    const second = await f.provider.openOrUpdatePullRequest({ ...pr, title: "two" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.url, first.url);
    assert.equal(f.posts(), 1);
    assert.equal(f.prs[0].title, "two");
    // A different target is a different PR.
    const other = await f.provider.openOrUpdatePullRequest({
      ...pr,
      target: "release",
      title: "r",
    });
    assert.equal(other.created, true);
    assert.notEqual(other.url, first.url);
  });

  test(`${name}: pullRequestState reports the shared state values`, async () => {
    const f = fake();
    const opened = await f.provider.openOrUpdatePullRequest({
      repo: f.repo,
      source: "feat/y",
      target: "main",
      title: "t",
      description: "d",
      draft: false,
      remoteUrl: f.remoteUrl,
    });
    const ref = { repo: f.repo, url: opened.url, remoteUrl: f.remoteUrl };
    assert.equal((await f.provider.pullRequestState!(ref))?.state, "OPEN");
    f.prs[0].state = "MERGED";
    assert.equal((await f.provider.pullRequestState!(ref))?.state, "MERGED");
    f.prs[0].state = "DECLINED";
    assert.equal((await f.provider.pullRequestState!(ref))?.state, "DECLINED");
  });
}

test("dispatch: null/empty is Bitbucket, known hosts map to their adapter, unknown fails closed", () => {
  assert.equal(gitProviderFor(null), bitbucketProvider);
  assert.equal(gitProviderFor(undefined), bitbucketProvider);
  assert.equal(gitProviderFor(""), bitbucketProvider);
  assert.equal(gitProviderFor("bitbucket"), bitbucketProvider);
  assert.equal(gitProviderFor("github"), githubProvider);
  assert.equal(gitProviderFor("gitlab"), gitlabProvider);
  // Legacy rows without a hosted remote keep their previous adapter.
  assert.equal(gitProviderFor("local"), bitbucketProvider);
  assert.throws(() => gitProviderFor("gitea"), /No Git provider registered for "gitea"/);
  assert.ok(["bitbucket", "github", "gitlab"].every((h) => registeredGitProviders().includes(h)));
});

test("setGitProvider overrides every host; setGitProviderFor one host", () => {
  const stub: GitProvider = {
    name: "stub",
    push: async () => ({ commits: "" }),
    openOrUpdatePullRequest: async () => ({ url: "u", created: true, note: "" }),
  };
  try {
    setGitProvider(stub);
    assert.equal(gitProviderFor("github"), stub);
    assert.equal(gitProviderFor("gitea"), stub);
  } finally {
    setGitProvider(bitbucketProvider);
  }
  assert.equal(gitProviderFor("github"), githubProvider);
  try {
    setGitProviderFor("gitlab", stub);
    assert.equal(gitProviderFor("gitlab"), stub);
    assert.equal(gitProviderFor("github"), githubProvider);
  } finally {
    setGitProviderFor("gitlab", null);
  }
  assert.equal(gitProviderFor("gitlab"), gitlabProvider);
});

test("every registered hosting provider has a host adapter (transport, policy, label)", () => {
  for (const host of ["bitbucket", "github", "gitlab"]) {
    assert.ok(isGitHost(host));
    assert.ok(gitHosts[host as "gitlab"].label);
    assert.ok(["strict", "personal", "trusted"].includes(gitHosts[host as "gitlab"].policy()));
  }
  assert.equal(isGitHost("benchmark"), false);
  assert.equal(isGitHost("toString"), false);
});

test("GitLab Git transport uses oauth2 + the instance token; a missing token is actionable and secret-free", async () => {
  const remote = {
    url: "https://gitlab.example.work/acme/team/shop.git",
    workspace: "acme/team",
    slug: "shop",
    provider: "gitlab" as const,
    host: "gitlab.example.work",
  };
  assert.deepEqual(await gitHosts.gitlab.gitCredentials(remote), {
    user: "oauth2",
    token: "glpat-CONTRACT000000000000",
  });
  config.gitlab.allowSharedCredentials = false;
  await assert.rejects(
    gitHosts.gitlab.gitCredentials(remote),
    (e: Error) => /GitLab authentication required/.test(e.message) && !e.message.includes("glpat-"),
  );
  config.gitlab.instances = [{ host: "gitlab.example.work", caFile: "/etc/ssl/hasaki-ca.pem" }];
  assert.deepEqual(gitHosts.gitlab.gitOptions!(remote), [
    "-c",
    "http.https://gitlab.example.work/.sslCAInfo=/etc/ssl/hasaki-ca.pem",
  ]);
});

test("providers without the optional unified methods are detectable (tools answer unsupported)", () => {
  assert.equal(githubProvider.mergePullRequest, undefined);
  assert.equal(bitbucketProvider.pipelines, undefined);
  assert.equal(typeof gitlabProvider.mergePullRequest, "function");
  assert.equal(typeof gitlabProvider.jobLog, "function");
});

test("shared merge policy: unknown or truncated evidence never merges", () => {
  const ok = {
    state: "OPEN" as const,
    draft: false,
    providerStatus: "mergeable",
    hasConflicts: false,
    approvals: { required: 1, given: 1, enforced: true },
    pipeline: { id: 1, status: "success", ref: null, sha: null, url: null, created_at: null },
    pipelineRequired: true,
    headSha: "abc",
  };
  assert.equal(evaluateMergeReadiness(ok).mergeable, true);
  assert.equal(evaluateMergeReadiness({ ...ok, approvals: null }).mergeable, false);
  assert.equal(evaluateMergeReadiness({ ...ok, pipelineUnknown: true }).mergeable, false);
  assert.equal(evaluateMergeReadiness({ ...ok, headSha: null }).mergeable, false);
  assert.equal(evaluateMergeReadiness({ ...ok, hasConflicts: true }).mergeable, false);
  assert.equal(
    evaluateMergeReadiness({ ...ok, pipeline: null, pipelineRequired: false }).mergeable,
    true,
  );
  assert.deepEqual(
    evaluateMergeReadiness({ ...ok, pipeline: { ...ok.pipeline, status: "canceled" } }).reasons,
    ["pipeline canceled"],
  );
});
