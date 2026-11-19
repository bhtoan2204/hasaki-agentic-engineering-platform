# Agent OS isolation

`src/agent/isolation.ts` is the containment layer for agent processes. Hooks and the tool policy (`toolPolicy.ts`) stay
the semantic layer; they are **not** a security sandbox. Verification commands (`platform/selfDevelopment.ts`
`bwrapArguments`) share the same credential masks.

## Modes (`config.isolation.mode`)

| Mode | What runs | Unattended work |
|---|---|---|
| `off` (default, legacy) | agents run as the worker user, tool policy only; reported as *not isolated* everywhere | never: autonomy `AUTONOMOUS`/`AUTOPILOT` gates return `ISOLATION_NOT_ENFORCED`; automatic recovery never resumes an agent |
| `enforce` | every agent step runs in the sandbox; a host or provider that cannot do it fails the step (`GUARANTEE_UNMET`), no fallback | allowed (still subject to the autonomy/recovery policies) |

## Threat model

Trusted: the worker process (host supervisor, broker, egress proxy), the kernel and bubblewrap, the host administrator,
the provider credential the operator scoped to that provider. Untrusted: repository scripts and dependencies, tool calls,
prompt-injected text (issues, logs, source), every child process of the agent.

Protected: host checkout and `.env`/`config.json`, platform `dataDir` (DB/auth secrets, evidence keys, other runs'
worktrees), host home credentials (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.codex`, …), SSH agent, Docker /
containerd / podman sockets, the user's runtime dir (`/run/user/<uid>`), WSL interop mounts, other processes, the host
network, hook and settings definitions, shared git metadata (refs, objects).

## The sandbox

`systemd-run --user --scope` (cgroup: `MemoryMax`, `MemorySwapMax=0`, `TasksMax`) → `prlimit` (CPU seconds, file size,
open files, no core dumps) → `bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL`:

- read-only `/`; private `/proc` (own pid namespace), `/dev`, `/tmp` (tmpfs);
- hidden (tmpfs or `/dev/null`): `$HOME`, `reposRoot`, `dataDir`, the credential list, host sockets; then re-exposed
  read-only: toolchains on `PATH` (a versioned prefix such as `~/.nvm/versions/node/vX`; a generic `~/.local/bin` alone),
  `isolation.readOnlyPaths`, the provider entry point;
- writable: only the run's own worktrees; per worktree the shared git dir is read-only and only its own admin dir
  (`.git/worktrees/<name>`: index, HEAD) is writable — `git status/diff/add` work, `commit`/`update-ref` do not
  (commits go through the platform's `commit_changes` tool, which runs in the worker with lease and fencing);
- read-only again inside the worktree: `.claude`, `.mcp.json`, `.codex`, `.cursor` (hooks, permissions, MCP servers);
- private HOME per run and provider at `dataDir/sandbox/run-<id>/<provider>` (0700), mounted at `/tmp/.home`, removed by
  the run's cleanup step;
- environment built from an allowlist (`isolatedEnvironment`): no `DATABASE_URL`, `AUTH_SECRET`, Git/integration/cloud
  tokens, `SSH_AUTH_SOCK`, `DOCKER_HOST`, `LD_PRELOAD`, `NODE_OPTIONS` or API billing keys;
- network: no interfaces but `lo`. Provider traffic goes through an in-sandbox forwarder to the host **egress proxy**:
  CONNECT only, exact `host:port` allowlist per provider (`isolation.egress`), names resolved on the host and refused when
  any address is private, loopback, link-local (cloud metadata), CGNAT, multicast or reserved; the tunnel connects to the
  checked address (no DNS re-pointing). Plain HTTP and redirects to other targets are refused. Closing the attempt closes
  the proxy: the sandbox has no network left.

Killing the sandbox (cancel, timeout, lease loss: the SDK abort) kills bwrap's namespace init and with it every
descendant.

## Providers

| Provider | Enforced mode |
|---|---|
| Claude | supported: the SDK spawns the CLI through `spawnClaudeCodeProcess` into the sandbox; hooks and the platform MCP server keep running in the worker over stdio. Auth: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (subscription). API keys are never passed, so there is no fallback to API billing. |
| Codex, Copilot, Antigravity | refused (`os_isolation` unmet) until their adapters spawn through the sandbox and their subscription login can be scoped without copying the host auth directory. Options: use Claude for the step, or run `off` on a trusted single-operator host (unattended work then stays disabled). |
| Cursor | refused for coding in every mode: its watcher acts after a tool starts, it is not a pre-tool hook. |

## Setup (Linux, WSL2)

1. `apt-get install bubblewrap util-linux`; unprivileged user namespaces enabled (`kernel.unprivileged_userns_clone=1`
   where the kernel has that switch).
2. A systemd user session: on WSL2 add `[boot]\nsystemd=true` to `/etc/wsl.conf` and restart WSL.
3. `claude setup-token`, then export `CLAUDE_CODE_OAUTH_TOKEN` for the worker.
4. Toolchains outside `PATH` prefixes (e.g. `~/go/pkg/mod`) go in `isolation.readOnlyPaths`.
5. Set `isolation.mode` to `"enforce"` and check Settings → Agent isolation (`GET /api/admin/isolation`).

## Residual exposure (not claimed as isolated)

- A kernel, bubblewrap or systemd vulnerability, or a malicious host administrator.
- The provider credential is visible inside that provider's sandbox (its shell can read `CLAUDE_CODE_OAUTH_TOKEN`); the
  only network path is the provider allowlist, which limits but does not eliminate exfiltration through the provider API.
- Read access to the rest of the root filesystem that is not on the mask list (system packages, `/etc` files readable by
  the worker user). Add sensitive locations to `isolation.extraMasks`.
- The verification sandbox keeps host network access (Go/Node module downloads) and the host `/tmp`; it hides
  credentials and platform state only.
- `RLIMIT_CPU` is per process; total CPU time is bounded by the step timeout.
