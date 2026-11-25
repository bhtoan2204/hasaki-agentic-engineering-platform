/**
 * Git hosting credentials come from Integrations only (personal secrets per user): BITBUCKET_*, GITHUB_TOKEN and
 * GITLAB_TOKEN in the environment are not read into the configuration any more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Git host credential variables in the environment are ignored", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      'const { config } = await import("./src/config.ts"); console.log(JSON.stringify({ bb: config.bitbucket, gh: config.github.token, gl: config.gitlab.token }));',
    ],
    {
      env: {
        ...process.env,
        BITBUCKET_USER: "env-user@example.test",
        BITBUCKET_TOKEN: "env-bitbucket-token",
        GITHUB_TOKEN: "env-github-token",
        GITLAB_TOKEN: "env-gitlab-token",
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual([c.bb.user, c.bb.token, c.gh, c.gl], ["", "", "", ""]);
  assert.equal(c.bb.workspace, "example-tech", "non-secret defaults stay");
});
