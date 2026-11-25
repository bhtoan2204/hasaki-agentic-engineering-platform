import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, gitlabConfig } from "../src/config.ts";
import { gitHosts, knownHostsFor, sshUrlOf } from "../src/git/hosts.ts";
import { sshGitSetup } from "../src/repos/git.ts";
import { gitlabProjectMetadata, validSshPrivateKey } from "../src/gitlab.ts";
import { redactTraceValue } from "../src/workflow/trace.ts";

/**
 * SSH transport for GitLab. Fake keys only. The end-to-end check runs the real git binary against a fake `ssh`
 * executable on PATH that records its arguments and exits: nothing connects to a network host.
 */
const exec = promisify(execFile);
const FAKE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfakekeymaterialforthetestonly0000000000\n-----END OPENSSH PRIVATE KEY-----";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTestsOnly000000000000000000";
const remote = {
  url: "https://gitlab.example.work/platform/backend/oms-api.git",
  workspace: "platform/backend",
  slug: "oms-api",
  provider: "gitlab" as const,
  host: "gitlab.example.work",
};
const saved = structuredClone(config.gitlab);
beforeEach(() => {
  config.gitlab.instances = [
    { host: "gitlab.example.work", sshHostKeys: [HOST_KEY], sshPort: 2222 },
  ];
});
afterEach(() => {
  mock.restoreAll();
  Object.assign(config.gitlab, structuredClone(saved));
});

test("SSH URL and known_hosts are derived from the canonical identity and the pinned keys", () => {
  assert.equal(sshUrlOf(remote, null), "ssh://git@gitlab.example.work/platform/backend/oms-api.git");
  assert.equal(
    sshUrlOf(remote, 2222),
    "ssh://git@gitlab.example.work:2222/platform/backend/oms-api.git",
  );
  assert.equal(
    knownHostsFor("gitlab.example.work", null, [HOST_KEY]),
    `gitlab.example.work ${HOST_KEY}\n`,
  );
  assert.equal(
    knownHostsFor("gitlab.example.work", 2222, [HOST_KEY]),
    `[gitlab.example.work]:2222 ${HOST_KEY}\n`,
  );
});

test("instance config keeps only well-formed host keys and a non-default port", () => {
  const cfg = gitlabConfig({
    ...config.gitlab,
    instances: [
      {
        host: "gitlab.example.work",
        sshHostKeys: [`${HOST_KEY} comment@host`, "not a key", "ssh-dss AAAA"],
        sshPort: 2222,
      },
      { host: "gitlab.com", sshHostKeys: [], sshPort: 22 },
    ],
  });
  assert.deepEqual(cfg.instances, [
    { host: "gitlab.example.work", sshHostKeys: [HOST_KEY], sshPort: 2222 },
    { host: "gitlab.com" },
  ]);
});

test("only unencrypted OpenSSH/PEM private keys are accepted", () => {
  assert.equal(validSshPrivateKey(FAKE_KEY), true);
  assert.equal(validSshPrivateKey("ssh-ed25519 AAAA public"), false);
  assert.equal(
    validSshPrivateKey(
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nabc\n-----END RSA PRIVATE KEY-----",
    ),
    false,
  );
  assert.equal(
    validSshPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"),
    false,
  );
});

test("without a run owner (or without pinned host keys) GitLab falls back to the HTTPS token transport", async () => {
  assert.equal(await gitHosts.gitlab.sshTransport!(remote), null);
  config.gitlab.instances = [{ host: "gitlab.example.work" }];
  assert.equal(await gitHosts.gitlab.sshTransport!(remote), null);
});

test("SSH setup: 0600 key and known_hosts files, strict host key checking, rewrite only on the command line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ssh-setup-"));
  const ssh = {
    url: sshUrlOf(remote, 2222),
    privateKey: FAKE_KEY,
    knownHosts: knownHostsFor(remote.host, 2222, [HOST_KEY]),
  };
  const setup = await sshGitSetup(dir, ssh, remote.url);
  assert.equal(statSync(join(dir, "id_key")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "known_hosts")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "id_key"), "utf8"), FAKE_KEY + "\n");
  const cmd = setup.env.GIT_SSH_COMMAND;
  for (const opt of [
    "StrictHostKeyChecking=yes",
    "BatchMode=yes",
    "IdentitiesOnly=yes",
    "GlobalKnownHostsFile=/dev/null",
  ])
    assert.ok(cmd.includes(opt), opt);
  assert.ok(!cmd.includes("accept-new") && !cmd.includes("StrictHostKeyChecking=no"));
  assert.ok(!cmd.includes("AAAAfakekey"), "the key material is never in the command");
  assert.deepEqual(setup.config, [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.ssh.allow=always",
    "-c",
    `url.${ssh.url}.insteadOf=${remote.url}`,
  ]);
});

test("real git uses the pinned SSH command for the canonical URL and keeps HTTPS refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ssh-git-"));
  const bin = mkdtempSync(join(tmpdir(), "fake-ssh-bin-"));
  const log = join(dir, "ssh-args.log");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 255\n`);
  chmodSync(join(bin, "ssh"), 0o700);
  const ssh = {
    url: sshUrlOf(remote, 2222),
    privateKey: FAKE_KEY,
    knownHosts: knownHostsFor(remote.host, 2222, [HOST_KEY]),
  };
  const setup = await sshGitSetup(dir, ssh, remote.url);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...setup.env,
  };
  await assert.rejects(
    exec("git", [...setup.config, "ls-remote", "--", remote.url, "HEAD"], { cwd: dir, env }),
  );
  const args = readFileSync(log, "utf8").split("\n");
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes(join(dir, "id_key")));
  assert.ok(args.includes(`UserKnownHostsFile=${join(dir, "known_hosts")}`));
  assert.ok(args.includes("git@gitlab.example.work"));
  assert.ok(args.includes("2222"));
  assert.ok(args.some((a) => a.includes("platform/backend/oms-api.git")));
  // Any other HTTPS URL is not rewritten and https itself is not allowed on the SSH branch.
  const other = await exec(
    "git",
    [...setup.config, "ls-remote", "--", "https://gitlab.example.work/x/y.git"],
    {
      cwd: dir,
      env,
    },
  ).catch((e) => e);
  assert.match(String(other.stderr), /transport 'https' not allowed/);
});

test("project metadata exposes default and protected branches", async () => {
  config.gitlab.instances = [{ host: "gitlab.example.work" }];
  config.gitlab.allowSharedCredentials = true;
  config.gitlab.token = "glpat-TESTTOKEN0000000000";
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/protected_branches"))
      return new Response(JSON.stringify([{ name: "main" }, { name: "release/*" }]), {
        status: 200,
      });
    return new Response(
      JSON.stringify({ default_branch: "main", visibility: "private", web_url: "w" }),
      { status: 200 },
    );
  });
  assert.deepEqual(await gitlabProjectMetadata(remote), {
    default_branch: "main",
    visibility: "private",
    web_url: "w",
    protected_branches: ["main", "release/*"],
    protected_branches_truncated: false,
  });
});

test("trace values mask GitLab tokens", () => {
  const out = JSON.stringify(redactTraceValue({ note: "using glpat-TESTTOKEN0000000000 now" }));
  assert.ok(!out.includes("glpat-TESTTOKEN"), out);
});
