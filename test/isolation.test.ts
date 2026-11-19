import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import {
  blockedAddress,
  isolatedEnvironment,
  probeIsolation,
  sandboxInvocation,
  startEgressProxy,
  SANDBOX_HOME,
  type EgressProxy,
  type IsolationRuntime,
  type SandboxSpec,
} from "../src/agent/isolation.ts";

/**
 * Real sandbox (bubblewrap) smoke tests on this host: every check runs an actual subprocess (shell, git, node, curl)
 * inside the sandbox. Skipped — reported as skipped, never as passed — on hosts without the runtime.
 */
let runtime: IsolationRuntime;
let skip: string | false = false;
let root: string;
let hostHome: string;
let worktree: string;
let sibling: string;
let live: string;
let home: string;
const SECRET = "fake-secret-0123456789";

before(async () => {
  runtime = await probeIsolation(true);
  if (!runtime.available) skip = `isolation runtime unavailable: ${runtime.problems.join("; ")}`;
  root = mkdtempSync(join(tmpdir(), "iso-"));
  // the test config roots reposRoot/dataDir in a temp dir: build a fake host layout there
  hostHome = join(root, "home");
  mkdirSync(join(hostHome, ".ssh"), { recursive: true });
  writeFileSync(join(hostHome, ".ssh", "id_ed25519"), SECRET);
  const repo = join(config.reposRoot, "iso-repo");
  mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      encoding: "utf8",
    }).trim();
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.json"), "{}");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  worktree = join(config.reposRoot, "wt-own");
  sibling = join(config.reposRoot, "wt-sibling");
  git(repo, "worktree", "add", "-q", "-b", "own", worktree);
  git(repo, "worktree", "add", "-q", "-b", "sib", sibling);
  writeFileSync(join(sibling, "secret.txt"), SECRET);
  live = join(config.dataDir, "live-checkout");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "config.json"), SECRET);
  symlinkSync(join(sibling, "secret.txt"), join(worktree, "link-to-sibling"));
  home = join(root, "sandbox-home");
  mkdirSync(home);
});

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => {
  const common = join(config.reposRoot, "iso-repo", ".git");
  return {
    cwd: worktree,
    writable: [worktree],
    git: [{ commonDir: common, adminDir: join(common, "worktrees", "wt-own") }],
    protect: [join(worktree, ".claude")],
    home,
    ...over,
  };
};

/** Runs `sh -c script` in the sandbox with a hostile-looking host environment; returns exit code and output. */
function sandboxed(script: string, s: SandboxSpec = spec(), extraEnv: Record<string, string> = {}) {
  const inv = sandboxInvocation(runtime, s, "sh", ["-c", script]);
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(inv.command, inv.args, {
      env: {
        ...inv.env,
        ...isolatedEnvironment("claude", extraEnv, {
          ...process.env,
          DATABASE_URL: "postgres://prod",
          AUTH_SECRET: SECRET,
          SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
          AWS_SECRET_ACCESS_KEY: SECRET,
          GH_TOKEN: SECRET,
          ANTHROPIC_API_KEY: "sk-billing",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-subscription",
        }),
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

test("filesystem: own worktree writable, test runs; secrets, sibling worktree, live checkout and host home are not reachable", async (t) => {
  if (skip) return t.skip(skip);
  const ok = await sandboxed(
    `echo edit > a.txt && node -e "console.log(require('fs').readFileSync('a.txt','utf8').trim())"`,
  );
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /edit/);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "edit\n");
  for (const [what, script] of [
    ["sibling read", `cat ${join(sibling, "secret.txt")}`],
    ["sibling write", `echo x > ${join(sibling, "a.txt")}`],
    ["live checkout read", `cat ${join(live, "config.json")}`],
    ["symlink escape", "cat link-to-sibling"],
    [
      "host ssh key",
      `cat ${join(process.env.HOME ?? "/root", ".ssh", "id_ed25519")} ${join(hostHome, ".ssh/id_ed25519")}`,
    ],
    ["data dir", `ls ${config.dataDir}/live-checkout`],
  ] as const) {
    const r = await sandboxed(script);
    assert.notEqual(r.code, 0, `${what} must fail: ${r.out}`);
    assert.doesNotMatch(r.out, new RegExp(SECRET), what);
  }
  assert.equal(readFileSync(join(sibling, "a.txt"), "utf8"), "base\n");
});

test("environment: allowlisted only — no DB/auth/cloud/Git tokens, no SSH agent, no API billing key; subscription token scoped to its provider", async (t) => {
  if (skip) return t.skip(skip);
  const r = await sandboxed("env");
  assert.equal(r.code, 0);
  for (const name of [
    "DATABASE_URL",
    "AUTH_SECRET",
    "SSH_AUTH_SOCK",
    "AWS_SECRET_ACCESS_KEY",
    "GH_TOKEN",
    "ANTHROPIC_API_KEY",
  ])
    assert.doesNotMatch(r.out, new RegExp(`^${name}=`, "m"), name);
  assert.match(r.out, new RegExp(`^HOME=${SANDBOX_HOME}$`, "m"));
  assert.match(r.out, /^CLAUDE_CODE_OAUTH_TOKEN=oauth-subscription$/m);
  assert.equal(
    isolatedEnvironment("codex", {}, { CLAUDE_CODE_OAUTH_TOKEN: "x" }).CLAUDE_CODE_OAUTH_TOKEN,
    undefined,
  );
  assert.equal(
    isolatedEnvironment("claude", { DATABASE_URL: "x", LD_PRELOAD: "/x.so", FOO: "ok" })
      .DATABASE_URL,
    undefined,
  );
  assert.equal(isolatedEnvironment("claude", { LD_PRELOAD: "/x.so" }).LD_PRELOAD, undefined);
});

test("hook definitions and git metadata: .claude settings and shared refs/objects are read-only; status works, commit does not", async (t) => {
  if (skip) return t.skip(skip);
  const hooks = await sandboxed(`echo '{"hooks":{}}' > .claude/settings.json`);
  assert.notEqual(hooks.code, 0);
  assert.equal(readFileSync(join(worktree, ".claude", "settings.json"), "utf8"), "{}");
  const status = await sandboxed("git status --porcelain");
  assert.equal(status.code, 0, status.out);
  const commit = await sandboxed("git -c user.email=a@b -c user.name=a commit -qam x");
  assert.notEqual(
    commit.code,
    0,
    "commits go through the platform's commit_changes tool, not the sandbox",
  );
  const ref = await sandboxed("git update-ref refs/heads/sib HEAD");
  assert.notEqual(ref.code, 0, "another worktree's branch cannot be moved");
});

test("processes and sockets: own pid namespace only, no host unix sockets, killing the sandbox kills every descendant", async (t) => {
  if (skip) return t.skip(skip);
  const ps = await sandboxed("ls /proc | grep -c '^[0-9]'");
  assert.ok(Number(ps.out.trim()) < 10, `only sandbox processes are visible: ${ps.out}`);
  const docker = await sandboxed(
    `test -S /var/run/docker.sock && echo SOCKET || echo none; ls /run/user/$(id -u) 2>&1 | head -1`,
  );
  assert.doesNotMatch(docker.out, /SOCKET/);
  const marker = `sleep-${process.pid}-${Date.now()}`;
  const hold = `node -e "setTimeout(() => {}, 300000)" ${marker}`;
  const inv = sandboxInvocation(runtime, spec(), "sh", ["-c", `${hold} & ${hold} & wait`]);
  const child = spawn(inv.command, inv.args, { env: { ...inv.env, ...isolatedEnvironment(null) } });
  await new Promise((r) => setTimeout(r, 400));
  const count = () => {
    try {
      return execFileSync("pgrep", ["-fc", `^node -e .* ${marker}$`], { encoding: "utf8" }).trim();
    } catch {
      return "0";
    }
  };
  assert.equal(count(), "2");
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(count(), "0", "descendants died with the sandbox");
});

test("resource limits: the process-count limit stops a fork storm inside the sandbox", async (t) => {
  if (skip) return t.skip(skip);
  const r = await sandboxed(
    "i=0; while [ $i -lt 60 ]; do sleep 5 & i=$((i+1)); done; wait",
    spec({ limits: { pids: 20 } }),
  );
  assert.notEqual(r.code, 0);
  assert.match(r.out, /fork|Resource temporarily unavailable|Cannot fork/i);
});

let upstream: Server;
let other: Server;
let proxy: EgressProxy;
let allowedPort = 0;
let otherPort = 0;
before(async () => {
  const listen = (s: Server) =>
    new Promise<number>((ok) =>
      s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)),
    );
  other = createServer((_, res) => res.end("disallowed-reached"));
  otherPort = await listen(other);
  upstream = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/` });
      return res.end();
    }
    res.end("allowed-ok");
  });
  allowedPort = await listen(upstream);
  proxy = await startEgressProxy([`127.0.0.1:${allowedPort}`]);
});
after(async () => {
  await proxy?.close();
  upstream?.close();
  other?.close();
});

test("network: no direct egress; the proxy tunnels only the allowlisted endpoint and refuses others, metadata and redirects", async (t) => {
  if (skip) return t.skip(skip);
  const direct = await sandboxed(`curl -s -m 3 http://127.0.0.1:${allowedPort}/ || echo BLOCKED`);
  assert.match(direct.out, /BLOCKED/);
  assert.doesNotMatch(direct.out, /allowed-ok/);
  const withProxy = spec({ egress: { dir: proxy.dir, socket: proxy.socket, port: 18080 } });
  const env = { HTTPS_PROXY: "http://127.0.0.1:18080", HTTP_PROXY: "http://127.0.0.1:18080" };
  const ok = await sandboxed(
    `curl -s -m 5 -p -x http://127.0.0.1:18080 http://127.0.0.1:${allowedPort}/`,
    withProxy,
    env,
  );
  assert.match(ok.out, /allowed-ok/, ok.out);
  const denied = await sandboxed(
    `curl -s -m 5 -p -x http://127.0.0.1:18080 http://127.0.0.1:${otherPort}/ || echo DENIED`,
    withProxy,
    env,
  );
  assert.doesNotMatch(denied.out, /disallowed-reached/);
  const metadata = await sandboxed(
    `curl -s -m 5 -p -x http://127.0.0.1:18080 http://169.254.169.254/latest/ || echo DENIED`,
    withProxy,
    env,
  );
  assert.match(metadata.out, /DENIED/);
  const redirect = await sandboxed(
    `curl -s -L -m 5 -p -x http://127.0.0.1:18080 http://127.0.0.1:${allowedPort}/redirect || echo DENIED`,
    withProxy,
    env,
  );
  assert.doesNotMatch(redirect.out, /disallowed-reached/);
  const plain = await sandboxed(
    `curl -s -m 5 -x http://127.0.0.1:18080 http://127.0.0.1:${allowedPort}/ -o /dev/null -w '%{http_code}'`,
    withProxy,
    env,
  );
  assert.equal(plain.out.trim(), "403", "plain HTTP through the proxy is refused");
  assert.ok(proxy.denied.some((d) => d.reason === "not_allowlisted"));
  assert.ok(proxy.denied.some((d) => d.reason === "not_connect"));
});

test("address policy: private, loopback, link-local/metadata, CGNAT and IPv6 local ranges are blocked; public is not", () => {
  for (const ip of [
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1",
  ])
    assert.equal(blockedAddress(ip), true, ip);
  for (const ip of ["1.1.1.1", "160.79.104.10", "2606:4700::1111"])
    assert.equal(blockedAddress(ip), false, ip);
});

test("performance: sandbox setup overhead on a no-op command (p50/p95, deterministic fixture)", async (t) => {
  if (skip) return t.skip(skip);
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    const r = await sandboxed("true");
    assert.equal(r.code, 0);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p = (q: number) =>
    Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]);
  console.log(
    `isolation-overhead ${JSON.stringify({ runs: times.length, p50_ms: p(0.5), p95_ms: p(0.95) })}`,
  );
  assert.ok(existsSync(worktree));
});

import { guaranteeCheck } from "../src/agent/providerCapabilities.ts";
import { prepareAgentSandbox } from "../src/agent/isolation.ts";
import { startBroker } from "../src/agent/broker/server.ts";
import { connect } from "node:net";

test("provider matrix: effective guarantees follow the runtime and the adapter, not the advertised table", () => {
  const on = { enforce: true, runtimeAvailable: true };
  const down = { enforce: true, runtimeAvailable: false };
  assert.deepEqual(guaranteeCheck("claude", "coding", null, on).unmet, []);
  assert.deepEqual(guaranteeCheck("claude", "analysis", null, on).unmet, []);
  assert.ok(
    guaranteeCheck("claude", "coding", null, down).unmet.includes("os_isolation"),
    "missing runtime fails closed",
  );
  for (const p of ["codex", "copilot", "antigravity"] as const) {
    const c = guaranteeCheck(p, "coding", null, on);
    assert.ok(c.unmet.includes("os_isolation"), `${p} has no sandboxed adapter yet`);
    assert.ok(
      !c.provided.includes("network_isolation") || c.provided.includes("os_isolation"),
      `${p}: advertised network isolation is not counted`,
    );
  }
  const cursor = guaranteeCheck("cursor", "coding", null, on);
  assert.ok(
    cursor.unmet.includes("pre_tool_policy"),
    "a post-execution watcher is not a pre-tool hook",
  );
  // legacy mode is unchanged (and never counts as isolated)
  assert.deepEqual(guaranteeCheck("claude", "coding").unmet, []);
  assert.ok(!guaranteeCheck("claude", "coding").provided.includes("os_isolation"));
  assert.ok(guaranteeCheck("cursor", "coding").unmet.includes("pre_tool_policy"));
});

test("agent sandbox lifecycle: provider entry point hidden on the host still runs; private config dir; egress only via the allowlist; close() revokes it", async (t) => {
  if (skip) return t.skip(skip);
  const previous = config.isolation.egress.claude;
  config.isolation.egress.claude = [`127.0.0.1:${allowedPort}`];
  const cli = join(config.dataDir, "fake-provider", "cli.sh");
  mkdirSync(join(config.dataDir, "fake-provider"), { recursive: true });
  writeFileSync(
    cli,
    [
      'touch "$CLAUDE_CONFIG_DIR/session" && echo CONFIG-OK',
      `cat ${join(config.dataDir, "live-checkout", "config.json")} 2>/dev/null || echo PLATFORM-HIDDEN`,
      `curl -s -m 5 -p -x "$HTTPS_PROXY" http://127.0.0.1:${allowedPort}/ && echo`,
      `curl -s -m 5 -p -x "$HTTPS_PROXY" http://127.0.0.1:${otherPort}/ || echo OTHER-DENIED`,
      "env | grep -c '^DATABASE_URL=' || true",
    ].join("\n"),
  );
  const sandbox = await prepareAgentSandbox({
    runId: 4242,
    provider: "claude",
    cwd: worktree,
    writable: [worktree],
    readOnly: [],
  });
  try {
    const run = (extra: Record<string, string>) =>
      new Promise<string>((done) => {
        const child = sandbox.spawn("sh", [cli], {
          CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude`,
          ...extra,
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", () => done(out));
      });
    const out = await run({ DATABASE_URL: "postgres://prod" });
    assert.match(out, /CONFIG-OK/);
    assert.match(out, /PLATFORM-HIDDEN/);
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.match(out, /allowed-ok/);
    assert.match(out, /OTHER-DENIED/);
    assert.doesNotMatch(out, /disallowed-reached/);
    assert.match(out, /^0$/m, "no DATABASE_URL inside");
    assert.ok(
      existsSync(join(config.dataDir, "sandbox", "run-4242", "claude", ".claude", "session")),
      "per-run state persisted for resume",
    );
    await sandbox.close();
    const after = await run({});
    assert.doesNotMatch(
      after,
      /allowed-ok/,
      "after close() the sandbox has no network path at all",
    );
  } finally {
    await sandbox.close();
    config.isolation.egress.claude = previous;
  }
});

test("broker: a wrong token is refused and a closed broker cannot be reused", async () => {
  const broker = await startBroker({
    policy: { mode: "coding" },
    cwd: "/",
    decideHook: () => ({ allow: true }),
    dispatch: async () => "ok",
  });
  const ask = (token: string) =>
    new Promise<string>((done) => {
      const s = connect(broker.socketPath);
      s.on("error", (e) => done(`error:${(e as NodeJS.ErrnoException).code}`));
      s.on("data", (d) => (done(String(d)), s.destroy()));
      s.write(JSON.stringify({ token, kind: "tool", name: "post_update", args: {} }) + "\n");
    });
  assert.match(await ask("forged"), /unauthorized/);
  assert.match(await ask(broker.token), /"ok":true/);
  await broker.close();
  assert.match(await ask(broker.token), /^error:/);
});
