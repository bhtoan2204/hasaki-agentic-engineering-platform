import { test } from "node:test";
import assert from "node:assert/strict";
import { openPullRequest, pullRequestState } from "../src/bitbucket.ts";
import { config } from "../src/config.ts";

test("Bitbucket refuses a malformed lookup before writing a pull request", async (t) => {
  const original = { ...config.bitbucket };
  Object.assign(config.bitbucket, {
    user: "test-user",
    token: "test-token",
    allowSharedCredentials: true,
  });
  t.after(() => Object.assign(config.bitbucket, original));
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ values: {} }));
  await assert.rejects(
    openPullRequest("team/repo", "feature", "Title", "Description"),
    /invalid pull request response/,
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test("Bitbucket accepts nullable merge metadata and rejects a non-string status", async (t) => {
  const original = { ...config.bitbucket };
  Object.assign(config.bitbucket, {
    user: "test-user",
    token: "test-token",
    allowSharedCredentials: true,
  });
  t.after(() => Object.assign(config.bitbucket, original));
  const prUrl = "https://bitbucket.org/team/repo/pull-requests/1";
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ state: "merged", updated_on: null, merge_commit: null }),
  );
  assert.deepEqual(await pullRequestState("team/repo", prUrl), {
    state: "MERGED",
    merged_at: null,
    merge_commit: null,
  });
  fetch.mock.mockImplementation(async () => Response.json({ state: 1 }));
  await assert.rejects(pullRequestState("team/repo", prUrl), /invalid pull request response/);
});
