import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config, gitlabConfig } from "../src/config.ts";
import { canonicalizeDetectedUrl, repositoryRemote } from "../src/repos/remote.ts";
import { redactSecrets } from "../src/integrations/redact.ts";

const saved = structuredClone(config.gitlab);
beforeEach(() => {
  config.gitlab.instances = [{ host: "gitlab.com" }, { host: "gitlab.hasaki.work" }];
});
afterEach(() => Object.assign(config.gitlab, structuredClone(saved)));

test("Bitbucket and GitHub identities are unchanged (plus their host)", () => {
  assert.deepEqual(repositoryRemote("https://bitbucket.org/Hasaki-Tech/OMS-API"), {
    url: "https://bitbucket.org/hasaki-tech/oms-api.git",
    workspace: "hasaki-tech",
    slug: "oms-api",
    provider: "bitbucket",
    host: "bitbucket.org",
  });
  assert.equal(repositoryRemote("https://github.com/acme/shop.git").provider, "github");
});

test("GitLab URLs on allow-listed hosts canonicalise, including nested groups", () => {
  assert.deepEqual(repositoryRemote("https://GitLab.com/Group/Sub/Deeper/Project"), {
    url: "https://gitlab.com/group/sub/deeper/project.git",
    workspace: "group/sub/deeper",
    slug: "project",
    provider: "gitlab",
    host: "gitlab.com",
  });
  assert.deepEqual(repositoryRemote("https://gitlab.hasaki.work/platform/oms-api.git/"), {
    url: "https://gitlab.hasaki.work/platform/oms-api.git",
    workspace: "platform",
    slug: "oms-api",
    provider: "gitlab",
    host: "gitlab.hasaki.work",
  });
  const deep = Array.from({ length: 20 }, (_, i) => `g${i}`).join("/");
  assert.equal(repositoryRemote(`https://gitlab.com/${deep}/p.git`).workspace, deep);
});

test("GitLab URLs are refused off the allow-list and in every unsafe form", () => {
  for (const bad of [
    "https://gitlab.example.com/group/project.git", // not allow-listed
    "https://user:glpat-x@gitlab.com/group/project.git", // credentials
    "https://user@gitlab.com/group/project.git",
    "https://gitlab.com:8443/group/project.git", // port
    "https://gitlab.com/group/../project.git",
    "https://gitlab.com/group/pro..ject.git",
    "https://gitlab.com/group%2Fsub/project.git",
    "https://gitlab.com/-group/project.git",
    "https://gitlab.com/group/project/-/tree/main",
    "https://gitlab.com/project.git", // no namespace
    "https://gitlab.com/group/project.git?x=1",
    "https://gitlab.com/group/project.git#frag",
    "http://gitlab.com/group/project.git",
    `https://gitlab.com/${Array.from({ length: 21 }, (_, i) => `g${i}`).join("/")}/p.git`,
  ])
    assert.throws(() => repositoryRemote(bad), /HTTPS Git repository URL|Use https:\/\//, bad);
});

test("detected SSH origins of allow-listed GitLab hosts map to the HTTPS identity", () => {
  assert.equal(
    canonicalizeDetectedUrl("git@gitlab.hasaki.work:platform/backend/oms-api.git"),
    "https://gitlab.hasaki.work/platform/backend/oms-api.git",
  );
  assert.equal(
    canonicalizeDetectedUrl("ssh://git@gitlab.com:2222/group/project.git"),
    "https://gitlab.com/group/project.git",
  );
  assert.equal(canonicalizeDetectedUrl("git@gitlab.example.com:group/project.git"), null);
  assert.equal(
    canonicalizeDetectedUrl("git@github.com:acme/shop.git"),
    "https://github.com/acme/shop.git",
  );
});

test("instance config keeps bare lower-case host names only", () => {
  const cfg = gitlabConfig({
    ...config.gitlab,
    instances: [
      { host: "GitLab.Hasaki.Work" },
      { host: "https://evil.example.com" },
      { host: "gitlab.hasaki.work" },
      { host: "localhost" },
      { host: "gitlab.com", caFile: "/ca.pem" },
    ],
  });
  assert.deepEqual(cfg.instances, [
    { host: "gitlab.hasaki.work" },
    { host: "gitlab.com", caFile: "/ca.pem" },
  ]);
});

test("GitLab tokens, PRIVATE-TOKEN headers and URL credentials are redacted; ordinary words are not", () => {
  const t = "glpat-TESTTOKEN0000000000";
  const out = redactSecrets(
    `a ${t} b\nPRIVATE-TOKEN: ${t}\nhttps://oauth2:${t}@gitlab.com/g/p.git`,
  );
  assert.ok(!out.includes(t), out);
  assert.match(out, /https:\/\/oauth2:\*\*\*@gitlab\.com/);
  assert.equal(redactSecrets("global-configuration-value-here"), "global-configuration-value-here");
});
