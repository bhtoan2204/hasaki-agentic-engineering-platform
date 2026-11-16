import { test } from "node:test";
import assert from "node:assert/strict";
import { publishReviewComment, reviewCommentBody, reviewMarker } from "../src/git/reviewComment.ts";
import type { GitProvider } from "../src/git/provider.ts";

// Fake provider objects only; nothing reaches a Git host.
const ref = {
  repo: "acme/team/shop",
  url: "https://gitlab.hasaki.work/acme/team/shop/-/merge_requests/7",
  remoteUrl: "https://gitlab.hasaki.work/acme/team/shop.git",
};
const TOKEN = "glpat-TESTTOKEN0000000000";

const upstream = {
  implement: { output: { summary: "done", pull_requests: {} } },
  review: {
    output: {
      approved: false,
      summary: "Two issues",
      findings: [
        {
          severity: "high",
          file: "src/a.ts",
          line: 12,
          issue: `leaks ${TOKEN}`,
          suggestion: "mask it",
        },
        { severity: "low", file: "src/b.ts", issue: "naming" },
      ],
    },
  },
  verify: { output: { verdict: "PASS", findings: [], summary: "ok" } },
};

test("review outputs become one markdown comment with a run marker; secrets are masked", () => {
  const body = reviewCommentBody(upstream, 42)!;
  assert.ok(body.startsWith(reviewMarker(42)));
  assert.match(body, /\*\*review\*\*: changes requested/);
  assert.match(body, /\[high\] `src\/a\.ts:12` leaks .* — suggestion: mask it/);
  assert.match(body, /\[low\] `src\/b\.ts` naming/);
  assert.match(body, /\*\*verify\*\*: PASS[\s\S]*- no findings/);
  assert.ok(!body.includes(TOKEN));
  assert.ok(!body.includes("implement"), "non-review outputs are ignored");
  assert.equal(reviewCommentBody({ implement: upstream.implement }, 42), null);
});

function fakeProvider(existing: string[] = [], fail = false) {
  const posted: string[] = [];
  const provider: GitProvider = {
    name: "gitlab",
    push: async () => ({ commits: "" }),
    openOrUpdatePullRequest: async () => ({ url: ref.url, created: false, note: "" }),
    pullRequestDiscussions: async () => ({
      truncated: false,
      discussions: existing.map((b, i) => ({
        id: String(i),
        resolved: null,
        notes: [{ id: i, author: "bot", body: b, created_at: null, system: false }],
      })),
    }),
    commentOnPullRequest: async (_r, body) => {
      if (fail) throw new Error(`GitLab 500 ${TOKEN}`);
      posted.push(body);
      return { id: 1, url: `${ref.url}#note_1` };
    },
  };
  return { provider, posted };
}

test("the comment is posted once per run and PR; retries skip it", async () => {
  const body = reviewCommentBody(upstream, 42)!;
  const first = fakeProvider();
  assert.deepEqual(await publishReviewComment(first.provider, ref, body, 42), {
    posted: true,
    reason: "posted",
    url: `${ref.url}#note_1`,
  });
  assert.equal(first.posted.length, 1);
  const again = fakeProvider([body]);
  const r = await publishReviewComment(again.provider, ref, body, 42);
  assert.equal(r.posted, false);
  assert.equal(again.posted.length, 0);
  // Another run's comment does not block this run's.
  assert.equal(
    (await publishReviewComment(fakeProvider([reviewMarker(7)]).provider, ref, body, 42)).posted,
    true,
  );
});

test("unsupported providers and failures never throw and never leak tokens", async () => {
  const { provider } = fakeProvider();
  const bare: GitProvider = {
    name: "github",
    push: provider.push,
    openOrUpdatePullRequest: provider.openOrUpdatePullRequest,
  };
  assert.deepEqual(await publishReviewComment(bare, ref, "x", 1), {
    posted: false,
    reason: "comments are unsupported for github",
  });
  const failing = await publishReviewComment(fakeProvider([], true).provider, ref, "x", 1);
  assert.equal(failing.posted, false);
  assert.ok(!failing.reason.includes(TOKEN));
});
