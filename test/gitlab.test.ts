import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import {
  accessLevelVerdict,
  closeGitlabMergeRequest,
  commentOnGitlabMergeRequest,
  draftTitle,
  glab,
  glabAll,
  gitlabJobLog,
  gitlabMergeReadiness,
  gitlabMergeRequestChanges,
  gitlabMergeRequestDiscussions,
  gitlabMergeRequestState,
  gitlabPipelines,
  gitlabRemoteOf,
  gitlabRepositoryAccess,
  GitlabAuthError,
  GitlabConnectivityError,
  GitlabHttpError,
  GitlabPermissionError,
  mergeGitlabMergeRequest,
  openGitlabMergeRequest,
  setGitlabSleep,
} from "../src/gitlab.ts";

// Fake credentials only. Every request goes to the mocked fetch below; nothing reaches a real GitLab.
const TOKEN = "glpat-TESTTOKEN0000000000";
const remote = { host: "gitlab.hasaki.work", workspace: "platform/backend", slug: "oms-api" };
const PID = "platform%2Fbackend%2Foms-api";
const MR_URL = "https://gitlab.hasaki.work/platform/backend/oms-api/-/merge_requests/7";

/** Parsed JSON request body (only the fields the fakes read). */
type Body = { title?: string; state_event?: string } & Record<string, unknown>;
type Call = { url: string; method: string; headers: Headers; body: Body; redirect?: string };
let calls: Call[] = [];
let sleeps: number[] = [];
const saved = structuredClone(config.gitlab);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Route table: first matching [method, regexp] answers. */
function serve(routes: Array<[string, RegExp, (c: Call) => Response | Promise<Response>]>) {
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const c: Call = {
        url: String(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: init.body ? (JSON.parse(String(init.body)) as Body) : {},
        redirect: init.redirect,
      };
      calls.push(c);
      for (const [m, re, h] of routes) if (m === c.method && re.test(c.url)) return h(c);
      return json({ message: "404 Not Found" }, 404);
    },
  );
}

beforeEach(() => {
  calls = [];
  sleeps = [];
  setGitlabSleep(async (ms) => void sleeps.push(ms));
  config.gitlab.instances = [{ host: "gitlab.com" }, { host: "gitlab.hasaki.work" }];
  config.gitlab.allowSharedCredentials = true;
  config.gitlab.token = TOKEN;
  config.gitlab.maxRetries = 3;
});
afterEach(() => {
  mock.restoreAll();
  setGitlabSleep(null);
  Object.assign(config.gitlab, structuredClone(saved));
});

const noToken = (s: string) => assert.ok(!s.includes(TOKEN), `token leaked: ${s}`);

test("requests use the PRIVATE-TOKEN header, encode nested namespaces and refuse redirects", async () => {
  serve([["GET", /\/projects\//, () => json({ id: 1 })]]);
  await glab(remote.host, TOKEN, `/projects/${PID}`);
  assert.equal(calls[0].url, `https://gitlab.hasaki.work/api/v4/projects/${PID}`);
  assert.equal(calls[0].headers.get("PRIVATE-TOKEN"), TOKEN);
  assert.equal(calls[0].redirect, "error");
  noToken(calls[0].url);
});

test("a host outside config.gitlab.instances never receives the token", async () => {
  serve([]);
  await assert.rejects(
    glab("evil.example.com", TOKEN, "/user"),
    /not in config\.gitlab\.instances/,
  );
  assert.equal(calls.length, 0);
});

test("pagination follows x-next-page and reports truncation at the page cap", async () => {
  serve([
    [
      "GET",
      /\/items/,
      (c) => {
        const page = Number(new URL(c.url).searchParams.get("page"));
        return json([{ n: page }], 200, page < 3 ? { "x-next-page": String(page + 1) } : {});
      },
    ],
  ]);
  const all = await glabAll(remote.host, TOKEN, "/items");
  assert.deepEqual(all, { items: [{ n: 1 }, { n: 2 }, { n: 3 }], truncated: false });
  calls = [];
  const capped = await glabAll(remote.host, TOKEN, "/items", 2);
  assert.equal(capped.items.length, 2);
  assert.equal(capped.truncated, true);
});

test("429 honours Retry-After, then succeeds", async () => {
  let n = 0;
  serve([
    [
      "GET",
      /\/user/,
      () => (n++ === 0 ? json({}, 429, { "retry-after": "2" }) : json({ username: "dev" })),
    ],
  ]);
  const res = await glab<{ username: string }>(remote.host, TOKEN, "/user");
  assert.equal(res.body.username, "dev");
  assert.deepEqual(sleeps, [2000]);
});

test("transient 5xx is retried a bounded number of times, then a typed error without the token", async () => {
  serve([["GET", /\/user/, () => json({ message: TOKEN }, 503)]]);
  const err = await glab(remote.host, TOKEN, "/user").catch((e) => e);
  assert.ok(err instanceof GitlabHttpError);
  assert.equal(err.status, 503);
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
  noToken(err.message);
});

test("timeouts and network failures become connectivity errors", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const err = await glab(remote.host, TOKEN, "/user").catch((e) => e);
  assert.ok(err instanceof GitlabConnectivityError);
  assert.match(err.message, /timeout/);
  assert.equal(err.kind, "connectivity");
});

test("401 and 403/404 are classified as authentication and permission errors", async () => {
  serve([
    ["GET", /\/a$/, () => json({ message: "401 Unauthorized" }, 401)],
    ["GET", /\/b$/, () => json({}, 403)],
  ]);
  const auth = await glab(remote.host, TOKEN, "/a").catch((e) => e);
  assert.ok(auth instanceof GitlabAuthError);
  assert.equal(auth.kind, "auth");
  const perm = await glab(remote.host, TOKEN, "/b").catch((e) => e);
  assert.ok(perm instanceof GitlabPermissionError);
  assert.equal(perm.kind, "permission");
  noToken(auth.message + perm.message);
});

test("project access levels map to read/write; 404 is denied; a bad token is unknown", async () => {
  assert.deepEqual(
    accessLevelVerdict({
      permissions: { project_access: { access_level: 30 }, group_access: null },
    }),
    { state: "verified", can_read: true, can_write: true, reason: "verified" },
  );
  assert.equal(
    accessLevelVerdict({ permissions: { group_access: { access_level: 20 } } }).can_write,
    false,
  );
  assert.equal(
    accessLevelVerdict({ permissions: { project_access: { access_level: 10 } } }).state,
    "denied",
  );
  serve([
    [
      "GET",
      new RegExp(`/projects/${PID}$`),
      () => json({ permissions: { group_access: { access_level: 40 } } }),
    ],
    ["GET", /\/projects\/other/, () => json({}, 404)],
  ]);
  assert.equal((await gitlabRepositoryAccess(TOKEN, remote)).can_write, true);
  assert.equal(
    (await gitlabRepositoryAccess(TOKEN, { ...remote, workspace: "other" })).state,
    "denied",
  );
  mock.restoreAll();
  serve([["GET", /./, () => json({}, 401)]]);
  assert.equal((await gitlabRepositoryAccess(TOKEN, remote)).state, "unknown");
});

test("openOrUpdate creates a Draft MR once, then updates the open one", async () => {
  const open: Array<Record<string, unknown>> = [];
  serve([
    [
      "GET",
      new RegExp(`/projects/${PID}/merge_requests\\?`),
      (c) => {
        const q = new URL(c.url).searchParams;
        assert.equal(q.get("state"), "opened");
        return json(
          open.filter(
            (m) =>
              m.source_branch === q.get("source_branch") &&
              m.target_branch === q.get("target_branch"),
          ),
        );
      },
    ],
    [
      "POST",
      new RegExp(`/projects/${PID}/merge_requests$`),
      (c) => {
        const mr = {
          iid: 7,
          web_url: MR_URL,
          ...c.body,
          draft: /^Draft:/.test(String(c.body.title)),
        };
        open.push(mr);
        return json(mr, 201);
      },
    ],
    [
      "PUT",
      new RegExp(`/projects/${PID}/merge_requests/7$`),
      (c) => json({ ...open[0], ...c.body }),
    ],
  ]);
  const first = await openGitlabMergeRequest(remote, "feature/x", "Add GitLab", "body", {
    draft: true,
    dest: "main",
  });
  assert.deepEqual(first, { url: MR_URL, created: true, note: "MR created." });
  assert.equal(calls.find((c) => c.method === "POST")!.body.title, "Draft: Add GitLab");
  const second = await openGitlabMergeRequest(remote, "feature/x", "Add GitLab v2", "body2", {
    draft: true,
    dest: "main",
  });
  assert.equal(second.created, false);
  assert.equal(second.url, MR_URL);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  const put = calls.find((c) => c.method === "PUT")!;
  assert.deepEqual(put.body, { title: "Draft: Add GitLab v2", description: "body2" });
  assert.equal(draftTitle("Draft: x", false), "x");
});

test("without credentials the adapter returns a create-MR link and calls nothing", async () => {
  config.gitlab.allowSharedCredentials = false;
  serve([]);
  const r = await openGitlabMergeRequest(remote, "feature/x", "t", "d", { dest: "main" });
  assert.equal(r.created, false);
  assert.match(
    r.url,
    /^https:\/\/gitlab\.hasaki\.work\/platform\/backend\/oms-api\/-\/merge_requests\/new\?/,
  );
  assert.equal(calls.length, 0);
});

test("merge request states map to the shared OPEN/MERGED/DECLINED values", async () => {
  for (const [state, want] of [
    ["opened", "OPEN"],
    ["merged", "MERGED"],
    ["closed", "DECLINED"],
  ] as const) {
    mock.restoreAll();
    serve([
      [
        "GET",
        /merge_requests\/7$/,
        () => json({ iid: 7, state, merged_at: "2026-01-01", merge_commit_sha: "abc" }),
      ],
    ]);
    const st = await gitlabMergeRequestState(remote, MR_URL);
    assert.equal(st?.state, want);
    assert.equal(st?.merge_commit, want === "MERGED" ? "abc" : null);
  }
  assert.equal(
    await gitlabMergeRequestState(
      remote,
      "https://gitlab.hasaki.work/x/y/-/merge_requests/new?a=b",
    ),
    null,
  );
});

function mrRoutes(opts: {
  mr?: Record<string, unknown>;
  approvals?: Response;
  project?: Record<string, unknown>;
  merge?: (c: Call) => Response;
}): Array<[string, RegExp, (c: Call) => Response]> {
  return [
    [
      "GET",
      /merge_requests\/7$/,
      () =>
        json({
          iid: 7,
          state: "opened",
          draft: false,
          sha: "head123",
          detailed_merge_status: "mergeable",
          has_conflicts: false,
          head_pipeline: { id: 99, status: "success", ref: "feature/x", sha: "head123" },
          ...opts.mr,
        }),
    ],
    [
      "GET",
      /merge_requests\/7\/approvals$/,
      () => opts.approvals ?? json({ approvals_required: 1, approved_by: [{ user: {} }] }),
    ],
    [
      "GET",
      new RegExp(`/projects/${PID}$`),
      () => json({ only_allow_merge_if_pipeline_succeeds: true, ...opts.project }),
    ],
    [
      "PUT",
      /merge_requests\/7\/merge$/,
      opts.merge ?? ((c) => json({ state: "merged", merge_commit_sha: "m1", sent: c.body })),
    ],
  ];
}

test("merge is pinned to the checked head and honours delete-source-branch", async () => {
  serve(mrRoutes({}));
  const r = await mergeGitlabMergeRequest(remote, MR_URL, { deleteSourceBranch: true });
  assert.deepEqual(r, { merged: true, state: "MERGED", merge_commit: "m1", reasons: [] });
  const put = calls.find((c) => c.method === "PUT")!;
  assert.deepEqual(put.body, { sha: "head123", should_remove_source_branch: true });
});

test("merge is refused on a failed or missing required pipeline, missing approvals or GitLab mergeability", async () => {
  const cases: Array<[Parameters<typeof mrRoutes>[0], RegExp]> = [
    [{ mr: { head_pipeline: { id: 1, status: "failed" } } }, /pipeline failed/],
    [{ mr: { head_pipeline: { id: 1, status: "running" } } }, /pipeline not finished/],
    [{ mr: { head_pipeline: null } }, /required pipeline missing/],
    [{ approvals: json({ approvals_required: 2, approved_by: [{}] }) }, /approvals 1\/2/],
    [{ mr: { detailed_merge_status: "not_approved" } }, /not_approved/],
    [{ mr: { draft: true } }, /draft/],
    [{ mr: { state: "closed" } }, /not open/],
  ];
  for (const [routes, reason] of cases) {
    mock.restoreAll();
    calls = [];
    serve(mrRoutes(routes));
    const r = await mergeGitlabMergeRequest(remote, MR_URL, { deleteSourceBranch: false });
    assert.equal(r.merged, false);
    assert.match(r.reasons.join("; "), reason);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "no merge call when not ready");
  }
});

test("Free tier: an approvals endpoint that is not available is labelled not enforced", async () => {
  serve(
    mrRoutes({
      approvals: json({}, 403),
      project: { only_allow_merge_if_pipeline_succeeds: false },
    }),
  );
  const r = await gitlabMergeReadiness(remote, MR_URL);
  assert.deepEqual(r.approvals, { required: 0, given: 0, enforced: false });
  assert.equal(r.mergeable, true);
});

test("GitLab refusing the merge (e.g. head moved: 409) is reported, not thrown", async () => {
  serve(mrRoutes({ merge: () => json({ message: "SHA does not match HEAD" }, 409) }));
  const r = await mergeGitlabMergeRequest(remote, MR_URL, { deleteSourceBranch: false });
  assert.equal(r.merged, false);
  assert.match(r.reasons[0], /409/);
});

test("changes, discussions, comments and close map to the unified model", async () => {
  serve([
    [
      "GET",
      /merge_requests\/7\/diffs/,
      () =>
        json([
          { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" },
          { old_path: "b.ts", new_path: "c.ts", renamed_file: true, diff: "" },
          { old_path: "d.ts", new_path: "d.ts", new_file: true, diff: "x".repeat(5000) },
        ]),
    ],
    [
      "GET",
      /merge_requests\/7\/discussions/,
      () =>
        json([
          {
            id: "d1",
            notes: [
              {
                id: 1,
                body: "nit",
                author: { username: "rev" },
                resolvable: true,
                resolved: false,
                position: { new_path: "a.ts", new_line: 3 },
              },
            ],
          },
        ]),
    ],
    ["POST", /merge_requests\/7\/notes$/, () => json({ id: 55 }, 201)],
    [
      "PUT",
      /merge_requests\/7$/,
      (c) => json({ iid: 7, state: c.body.state_event === "close" ? "closed" : "opened" }),
    ],
  ]);
  const ch = await gitlabMergeRequestChanges(remote, MR_URL, { maxDiffBytes: 1000 });
  assert.deepEqual(
    ch.files.map((f) => [f.path, f.status, !!f.diff]),
    [
      ["a.ts", "modified", true],
      ["c.ts", "renamed", false],
      ["d.ts", "added", false],
    ],
  );
  assert.equal(ch.truncated, true);
  const ds = await gitlabMergeRequestDiscussions(remote, MR_URL);
  assert.equal(ds.discussions[0].resolved, false);
  assert.deepEqual(ds.discussions[0].notes[0], {
    id: 1,
    author: "rev",
    body: "nit",
    created_at: null,
    path: "a.ts",
    line: 3,
    system: false,
  });
  assert.deepEqual(await commentOnGitlabMergeRequest(remote, MR_URL, "LGTM"), {
    id: 55,
    url: `${MR_URL}#note_55`,
  });
  await assert.rejects(commentOnGitlabMergeRequest(remote, MR_URL, "  "), /required/);
  assert.deepEqual(await closeGitlabMergeRequest(remote, MR_URL), { state: "DECLINED" });
});

test("pipelines include jobs of the newest; failed job logs are tail-capped and redacted", async () => {
  serve([
    [
      "GET",
      /\/pipelines\?ref=feature%2Fx/,
      () =>
        json([
          { id: 99, status: "failed", ref: "feature/x", sha: "s" },
          { id: 98, status: "success" },
        ]),
    ],
    [
      "GET",
      /\/pipelines\/99\/jobs/,
      () =>
        json([
          {
            id: 5,
            name: "test",
            stage: "test",
            status: "failed",
            failure_reason: "script_failure",
          },
        ]),
    ],
    [
      "GET",
      /\/jobs\/5\/trace$/,
      () =>
        new Response(
          `line1\n\x1b[31mERROR\x1b[0m using ${TOKEN}\nPRIVATE-TOKEN: ${TOKEN}\nhttps://oauth2:${TOKEN}@gitlab.hasaki.work/x.git\nlast`,
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
    ],
  ]);
  const p = await gitlabPipelines(remote, { ref: "feature/x" });
  assert.equal(p.pipelines[0].status, "failed");
  assert.equal(p.pipelines[0].jobs?.[0].failure_reason, "script_failure");
  assert.equal(p.pipelines[1].jobs, undefined);
  const log = await gitlabJobLog(remote, 5, 4);
  assert.equal(log.truncated, true);
  assert.ok(log.log.endsWith("last"));
  assert.ok(!log.log.includes("\x1b["));
  noToken(log.log);
  await assert.rejects(gitlabJobLog(remote, -1), /Invalid job id/);
});

test("gitlabRemoteOf accepts only canonical GitLab registry URLs", () => {
  assert.deepEqual(
    gitlabRemoteOf("https://gitlab.hasaki.work/platform/backend/oms-api.git"),
    remote,
  );
  assert.throws(() => gitlabRemoteOf("https://github.com/o/r.git"), /Not a GitLab repository/);
  assert.throws(() => gitlabRemoteOf(null), /required/);
});
