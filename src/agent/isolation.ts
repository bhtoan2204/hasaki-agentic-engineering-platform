import { execFile } from "node:child_process";
import {
  mkdtempSync,
  chmodSync,
  existsSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { scopeEnvironment, systemdLiteral } from "./process/scope.ts";

const exec = promisify(execFile);

/**
 * OS isolation for agent and verification processes (Linux / WSL2, bubblewrap). One subsystem: the verification
 * sandbox (platform/selfDevelopment.ts) shares the credential masks; agent sandboxes add a private HOME, /tmp, process,
 * IPC and network namespace, cgroup/rlimit limits and an egress proxy that only tunnels allowlisted provider endpoints.
 *
 * Trusted: the host worker (this process), the kernel and bubblewrap, the host administrator, the provider credential
 * the operator scoped for the provider (it is visible inside that provider's sandbox). Untrusted: everything the agent
 * reads or runs — repository scripts and dependencies, tool calls, prompt-injected text, its child processes.
 * Hooks and tool policy remain the semantic layer; this is the containment layer. Nothing here claims absolute isolation:
 * a kernel or bubblewrap vulnerability, or a malicious host administrator, is outside the boundary.
 */

export const ISOLATION_PROFILE_VERSION = "2026-11-19.1";

export interface IsolationRuntime {
  /** Every control the enforced mode needs is present and the probe ran inside a sandbox successfully. */
  available: boolean;
  bwrap: string | null;
  namespaces: boolean;
  network_isolated: boolean;
  cgroup: "systemd-scope" | "none";
  rlimits: boolean;
  problems: string[];
  version: string;
  checked_at: string;
}

let cached: { at: number; value: IsolationRuntime } | null = null;
let override: IsolationRuntime | null = null;
/** Test seam: a fixed runtime (null restores probing). */
export function setIsolationRuntimeForTests(v: IsolationRuntime | null) {
  override = v;
  cached = null;
}

async function which(bin: string) {
  try {
    return (await exec("which", [bin], { timeout: 2000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cheap deterministic probe, cached for five minutes: bubblewrap present, user/pid/net namespaces usable (inside a fresh
 * network namespace only `lo` exists), rlimits via prlimit, and a cgroup scope for memory/pids limits.
 */
export async function probeIsolation(force = false): Promise<IsolationRuntime> {
  if (override) return override;
  if (!force && cached && Date.now() - cached.at < 300_000) return cached.value;
  const problems: string[] = [];
  const bwrap = await which("bwrap");
  let namespaces = false;
  let network_isolated = false;
  if (!bwrap) problems.push("bubblewrap (bwrap) is not installed: apt-get install bubblewrap");
  else
    try {
      const out = (
        await exec(
          bwrap,
          [
            "--unshare-all",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "sh",
            "-c",
            "grep -c : /proc/net/dev",
          ],
          { timeout: 5000 },
        )
      ).stdout.trim();
      namespaces = true;
      network_isolated = out === "1";
      if (!network_isolated)
        problems.push("the sandbox network namespace has interfaces other than lo");
    } catch (e) {
      problems.push(
        `bubblewrap cannot create user/pid/net namespaces (${(e as Error).message.split("\n")[0].slice(0, 160)}): enable unprivileged user namespaces (kernel.unprivileged_userns_clone=1)`,
      );
    }
  const rlimits = !!(await which("prlimit"));
  if (!rlimits)
    problems.push(
      "prlimit (util-linux) is missing: per-process CPU/file-size/open-file limits cannot be enforced",
    );
  let cgroup: IsolationRuntime["cgroup"] = "none";
  try {
    await exec(
      "systemd-run",
      ["--user", "--scope", "-q", "--collect", "-p", "TasksMax=8", "-p", "MemoryMax=64M", "true"],
      {
        timeout: 5000,
        env: { PATH: config.system.path, ...scopeEnvironment() },
      },
    );
    cgroup = "systemd-scope";
  } catch {
    problems.push(
      "no delegated cgroup (systemd --user scope): memory and process-count limits cannot be enforced; enable systemd in WSL (/etc/wsl.conf [boot] systemd=true) or log in with a user session",
    );
  }
  const value: IsolationRuntime = {
    available: !!bwrap && namespaces && network_isolated && rlimits && cgroup !== "none",
    bwrap,
    namespaces,
    network_isolated,
    cgroup,
    rlimits,
    problems,
    version: ISOLATION_PROFILE_VERSION,
    checked_at: new Date().toISOString(),
  };
  cached = { at: Date.now(), value };
  return value;
}

/** The enforced mode applies to this installation (operator configuration), and its runtime is usable right now. */
export async function isolationEnforced() {
  return config.isolation.mode === "enforce" && (await probeIsolation()).available;
}

/** Synchronous view for pure policy code: enforced mode configured and the last probe found the runtime usable. */
export function isolationEnforcedNow() {
  if (config.isolation.mode !== "enforce") return false;
  if (override) return override.available;
  return !!cached?.value.available;
}

// ---------------------------------------------------------------- filesystem view

export const HOME_CREDENTIALS = [
  ".pgpass",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".aws",
  ".ssh",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".claude",
  ".claude.json",
  ".codex",
  ".cursor",
  ".copilot",
  ".gemini",
];

/** Host sockets and runtime directories no sandboxed process may reach (AF_UNIX paths ignore the network namespace). */
function hostSockets() {
  const uid = userInfo().uid;
  return [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/containerd",
    "/run/podman",
    `/run/user/${uid}`,
    "/mnt/wsl",
  ];
}

/** Credentials and platform state hidden even from the verification sandbox (which keeps the rest of the host readable). */
export function credentialMasks(): string[] {
  const home = homedir();
  return [
    ...HOME_CREDENTIALS.map((p) => join(home, p)),
    resolve(config.binaries.configFile ?? "config.json"),
    resolve(".env"),
    config.dataDir,
    ...hostSockets(),
    ...config.isolation.extraMasks,
  ].filter((p, i, a) => a.indexOf(p) === i);
}

let empty: string | null = null;
/** A read-only empty regular file to bind over masked files (a bound /dev/null is unusable: bwrap mounts are nodev). */
function emptyFile() {
  if (empty && existsSync(empty)) return empty;
  const dir = mkdtempSync(join(tmpdir(), "ctp-mask-"));
  empty = join(dir, "empty");
  writeFileSync(empty, "", { mode: 0o444 });
  writeFileSync(join(dir, ".owner-pid"), String(process.pid));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return empty;
}

/**
 * A symlinked credential (common on WSL: ~/.aws → /mnt/c/…) is hidden at its real target: a mount cannot sit on the
 * link itself, and skipping it would leave the target readable through the link.
 */
function maskArgs(paths: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    try {
      out.push(
        ...(statSync(real).isDirectory() ? ["--tmpfs", real] : ["--ro-bind", emptyFile(), real]),
      );
    } catch {
      /* unreadable: nothing to hide from a process of the same user */
    }
  }
  return out;
}

/** Bubblewrap arguments that hide credentials; used by the verification sandbox on top of its read-only root. */
export function credentialMaskArgs() {
  const masks = credentialMasks();
  return [...maskArgs(masks), ...resolverRebinds(masks)];
}

/** Name-resolution configuration a sandboxed process needs (no secrets in any of them). */
export const RESOLVER_FILES = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"];

/**
 * A masked directory can hold the real file behind a resolver symlink: on WSL /etc/resolv.conf → /mnt/wsl/resolv.conf,
 * and /mnt/wsl is masked for its sockets. Without the file, every DNS lookup in the sandbox fails (EAI_AGAIN) and npm
 * crashes with "Exit handler never called!". Each such file alone is bound back read-only after the masks; the rest
 * of the masked directory stays hidden.
 */
export function resolverRebinds(
  masks: string[],
  files: string[] = RESOLVER_FILES,
  real: (p: string) => string | null = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  },
): string[] {
  const hidden = masks.map((m) => real(m)).filter((m): m is string => !!m);
  const out: string[] = [];
  for (const f of files) {
    const target = real(f);
    if (target && target !== f && hidden.some((h) => inside(target, h)))
      out.push("--ro-bind", target, target);
  }
  return out;
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);

/** Toolchain directories the sandbox must still read when their parent tree is hidden (PATH entries, configured). */
function toolchainPaths(hidden: string[]) {
  const out = new Set<string>();
  for (const dir of (config.system.path ?? "").split(":").filter((d) => d.startsWith("/"))) {
    if (!hidden.some((h) => inside(dir, h))) continue;
    // A versioned toolchain (…/versions/node/v22/bin, …/gos/go1.x/bin) needs its prefix; a generic bin dir
    // (~/.local/bin, ~/bin) is bound alone so the rest of that tree (keyrings, app data) stays hidden.
    const parent = dirname(dir);
    const generic = hidden.includes(parent) || parent === join(homedir(), ".local");
    out.add(dir.endsWith("/bin") && !generic ? parent : dir);
  }
  out.add(dirname(dirname(process.execPath)));
  for (const p of config.isolation.readOnlyPaths) out.add(resolve(p));
  if (config.system.extraCaCerts) out.add(resolve(config.system.extraCaCerts));
  return [...out].filter((p) => existsSync(p) && !credentialMasks().some((m) => inside(p, m)));
}

export interface Limits {
  memoryMb: number;
  pids: number;
  cpuSeconds: number;
  fileSizeMb: number;
  openFiles: number;
}

export interface SandboxSpec {
  cwd: string;
  /** Owned worktrees and scratch directories, writable. */
  writable: string[];
  /** Extra read-only paths (e.g. an authorized source checkout). */
  readOnly?: string[];
  /** Git worktrees: shared metadata read-only, only this worktree's own admin dir writable (no commit/ref writes). */
  git?: Array<{ commonDir: string; adminDir: string }>;
  /** Paths made read-only again inside writable trees: hook/settings definitions the agent must not change. */
  protect?: string[];
  /** Per-run private HOME (writable), mounted at SANDBOX_HOME. */
  home: string;
  /** Unix socket directory of the egress proxy, bound at SANDBOX_EGRESS; absent = no network at all. */
  egress?: { dir: string; socket: string; port: number };
  /** Extra unix-socket directories bound in (the worker broker of this attempt). */
  sockets?: string[];
  limits?: Partial<Limits>;
}

/** Mount points live in the sandbox-private /tmp (tmpfs): the read-only root cannot hold new directories. */
export const SANDBOX_HOME = "/tmp/.home";
export const SANDBOX_EGRESS = "/tmp/.egress";
const FORWARDER = fileURLToPath(new URL("./sandboxForwarder.mjs", import.meta.url));

export { scopeEnvironment } from "./process/scope.ts";

/** The full invocation: cgroup scope → rlimits → bubblewrap → (egress forwarder) → command. */
export function sandboxInvocation(
  runtime: IsolationRuntime,
  spec: SandboxSpec,
  command: string,
  args: string[],
): { command: string; args: string[]; env: Record<string, string> } {
  if (!runtime.available || !runtime.bwrap)
    throw new Error("OS isolation is not available on this host");
  const limits = { ...config.isolation.limits, ...(spec.limits ?? {}) };
  const hidden = [homedir(), config.reposRoot, config.dataDir, ...credentialMasks()];
  const bw = [
    // systemd-run needs the user bus; the sandboxed process does not get it (values are passed by env, never argv).
    "--unsetenv",
    "XDG_RUNTIME_DIR",
    "--unsetenv",
    "DBUS_SESSION_BUS_ADDRESS",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...maskArgs([...new Set(hidden)]),
  ];
  for (const p of toolchainPaths(hidden)) bw.push("--ro-bind", p, p);
  for (const p of spec.readOnly ?? []) if (existsSync(p)) bw.push("--ro-bind", p, p);
  for (const g of spec.git ?? []) {
    if (existsSync(g.commonDir)) bw.push("--ro-bind", g.commonDir, g.commonDir);
    if (existsSync(g.adminDir)) bw.push("--bind", g.adminDir, g.adminDir);
  }
  for (const p of spec.writable) if (existsSync(p)) bw.push("--bind", p, p);
  for (const p of spec.protect ?? []) if (existsSync(p)) bw.push("--ro-bind", p, p);
  bw.push("--bind", spec.home, SANDBOX_HOME);
  for (const d of spec.sockets ?? []) if (existsSync(d)) bw.push("--bind", d, d);
  let tail = [command, ...args];
  if (spec.egress) {
    bw.push("--bind", spec.egress.dir, SANDBOX_EGRESS, "--ro-bind", FORWARDER, FORWARDER);
    tail = [
      process.execPath,
      FORWARDER,
      `${SANDBOX_EGRESS}/${spec.egress.socket}`,
      String(spec.egress.port),
      "--",
      ...tail,
    ];
  }
  bw.push("--chdir", spec.cwd, "--", ...tail);
  const rl = [
    `--cpu=${limits.cpuSeconds}`,
    `--fsize=${limits.fileSizeMb * 1024 * 1024}`,
    `--nofile=${limits.openFiles}`,
    "--core=0",
    "--",
    runtime.bwrap,
    ...bw,
  ];
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "-q",
      "--collect",
      "-p",
      `MemoryMax=${limits.memoryMb}M`,
      "-p",
      "MemorySwapMax=0",
      "-p",
      `TasksMax=${limits.pids}`,
      // systemd-run would expand `$` in the sandboxed command line: pass it literally.
      ...systemdLiteral(["prlimit", ...rl]),
    ],
    env: scopeEnvironment(),
  };
}

// ---------------------------------------------------------------- environment

const BASE_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "GOFLAGS",
  "GOPROXY",
  "GONOSUMDB",
  "GOPRIVATE",
  "GOMODCACHE",
  "GOCACHE",
];
/** Provider authentication that stays inside that provider's sandbox: subscription logins only, never API billing keys. */
const PROVIDER_AUTH: Record<string, string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN"],
};

/**
 * Allowlisted environment for a sandboxed process. Nothing of the worker is inherited unless named here: no
 * DATABASE_URL, AUTH_SECRET, integration/Git tokens, SSH agent, Docker host, cloud profiles or API billing keys.
 */
export function isolatedEnvironment(
  provider: string | null,
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV, ...(provider ? (PROVIDER_AUTH[provider] ?? []) : [])])
    if (base[k]) env[k] = String(base[k]);
  if (base.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = String(base.NODE_EXTRA_CA_CERTS);
  Object.assign(env, {
    HOME: SANDBOX_HOME,
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: `${SANDBOX_HOME}/.config`,
    XDG_CACHE_HOME: `${SANDBOX_HOME}/.cache`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    USER: "sandbox",
  });
  const unsafe =
    /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|COOKIE|PRIVATE_KEY|API_KEY|ACCESS_KEY|CONNECTION_STRING|^PG|DATABASE_URL|SSH_AUTH_SOCK|DOCKER_HOST|^AWS_|^GOOGLE_|^AZURE_|^GH_|^GITHUB_|^ANTHROPIC_|^OPENAI_|^PLATFORM_|^NODE_OPTIONS$|^BASH_ENV$|^ENV$|LD_PRELOAD)/i;
  for (const [k, v] of Object.entries(extra)) if (!unsafe.test(k)) env[k] = v;
  return env;
}

// ---------------------------------------------------------------- egress proxy

const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xe0000000, 4],
  [0xf0000000, 4],
];
/** Private, loopback, link-local (incl. cloud metadata), CGNAT, multicast and reserved addresses. */
export function blockedAddress(ip: string) {
  if (isIP(ip) === 4) {
    const n = ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
    return BLOCKED_V4.some(([net, bits]) => n >>> (32 - bits) === net >>> (32 - bits));
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return blockedAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^(fe8|fe9|fea|feb|fc|fd|ff)/.test(v6);
}

export interface EgressProxy {
  dir: string;
  socket: string;
  denied: Array<{ target: string; reason: string }>;
  allowed: string[];
  close(): Promise<void>;
}

/**
 * Host-side egress proxy for one attempt: HTTP CONNECT only, to an exact `host:port` of the allowlist. A hostname is
 * resolved here and every address must be public (no private, loopback, link-local/metadata, CGNAT); the tunnel then
 * connects to that resolved address, so DNS cannot be re-pointed between check and connect. An IP literal is allowed
 * only when the allowlist names that literal (an explicit operator decision). Plain HTTP requests are refused, so a
 * redirect can only be followed through another CONNECT that is checked the same way.
 */
export async function startEgressProxy(allow: string[]): Promise<EgressProxy> {
  const dir = mkdtempSync(join(tmpdir(), "ctp-egress-"));
  chmodSync(dir, 0o700);
  const socket = "proxy.sock";
  const allowed = new Set(allow.map((a) => a.toLowerCase()));
  const denied: EgressProxy["denied"] = [];
  const sockets = new Set<Socket>();
  const refuse = (c: Socket, target: string, reason: string) => {
    denied.push({ target: target.slice(0, 200), reason });
    c.end(`HTTP/1.1 403 Forbidden\r\nX-Egress-Denied: ${reason}\r\n\r\n`);
  };
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    let head = "";
    const onData = async (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192) refuse(client, "?", "header_too_large");
        return;
      }
      client.off("data", onData);
      const [method, target] = head.slice(0, head.indexOf("\r\n")).split(" ");
      if (method !== "CONNECT") return refuse(client, target ?? "?", "not_connect");
      const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target ?? "");
      if (!m) return refuse(client, target ?? "?", "bad_target");
      const host = m[1].toLowerCase();
      const port = Number(m[2]);
      if (!allowed.has(`${host}:${port}`)) return refuse(client, target, "not_allowlisted");
      let address = host;
      if (!isIP(host)) {
        try {
          const all = await lookup(host, { all: true });
          if (!all.length || all.some((a) => blockedAddress(a.address)))
            return refuse(client, target, "resolves_to_private_address");
          address = all[0].address;
        } catch {
          return refuse(client, target, "dns_failure");
        }
      }
      const upstream = connect(port, address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = Buffer.from(head.slice(end + 4), "latin1");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => (sockets.delete(upstream), client.destroy()));
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((ok, fail) => server.listen(join(dir, socket), ok).once("error", fail));
  return {
    dir,
    socket,
    denied,
    allowed: [...allowed],
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- agent sandbox lifecycle

/** Shared git metadata read-only, this worktree's own admin dir writable (index, HEAD); refs/objects stay read-only. */
export async function gitMounts(paths: string[]) {
  const out: Array<{ commonDir: string; adminDir: string }> = [];
  for (const p of paths) {
    try {
      const [common, admin] = (
        await exec(
          "git",
          ["-C", p, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"],
          { timeout: 5000 },
        )
      ).stdout
        .trim()
        .split("\n");
      if (common && admin && common !== admin) out.push({ commonDir: common, adminDir: admin });
    } catch {
      /* not a git worktree: nothing to expose */
    }
  }
  return out;
}

const EGRESS_PORT = 18080;
/** Definitions an agent could rewrite to change its own hooks, permissions or MCP servers: read-only in the sandbox. */
export const PROTECTED_IN_WORKTREE = [
  ".claude",
  ".mcp.json",
  ".codex",
  ".cursor",
  ".github/copilot-instructions.md",
  ".github/hooks",
  ".agents",
  "CLAUDE.md.local",
];

export interface AgentSandbox {
  spec: SandboxSpec;
  egress: EgressProxy;
  /** Spawn a command inside the sandbox; `extraEnv` passes through the allowlist filter. */
  spawn(
    command: string,
    args: string[],
    extraEnv: Record<string, string>,
    signal?: AbortSignal,
  ): import("node:child_process").ChildProcessWithoutNullStreams;
  close(): Promise<void>;
}

/**
 * One sandbox per agent attempt: per-run private HOME (dataDir/sandbox/run-<id>/<provider>, 0700, so a resumed session
 * of the same run finds its state and no other run does), an egress proxy limited to the provider's allowlist, the
 * owned worktrees writable, read-only sources, protected hook/settings files. close() stops the proxy (revoking the
 * only network path) and is idempotent.
 */
export async function prepareAgentSandbox(i: {
  runId: number;
  provider: string;
  cwd: string;
  writable: string[];
  readOnly: string[];
}): Promise<AgentSandbox> {
  const runtime = await probeIsolation();
  if (!runtime.available)
    throw new Error(`OS isolation unavailable: ${runtime.problems.join("; ")}`);
  const { mkdirSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const home = join(config.dataDir, "sandbox", `run-${i.runId}`, i.provider);
  mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
  const egress = await startEgressProxy(config.isolation.egress[i.provider] ?? []);
  const writable = [...new Set(i.writable)];
  const spec: SandboxSpec = {
    cwd: i.cwd,
    writable,
    readOnly: [...new Set([...i.readOnly, ...(writable.includes(i.cwd) ? [] : [i.cwd])])],
    git: await gitMounts([...writable, ...i.readOnly]),
    protect: writable.flatMap((w) => PROTECTED_IN_WORKTREE.map((f) => join(w, f))),
    home,
    egress: { dir: egress.dir, socket: egress.socket, port: EGRESS_PORT },
  };
  let closed = false;
  return {
    spec,
    egress,
    spawn(command, args, extraEnv, signal) {
      // The provider's own entry point (e.g. the SDK's cli.js inside the hidden platform checkout) is read-only visible.
      const entry = args.filter((a) => a.startsWith("/") && existsSync(a)).map((a) => dirname(a));
      const inv = sandboxInvocation(
        runtime,
        { ...spec, readOnly: [...(spec.readOnly ?? []), ...entry] },
        command,
        args,
      );
      const proxyUrl = `http://127.0.0.1:${EGRESS_PORT}`;
      const env = {
        ...inv.env,
        ...isolatedEnvironment(i.provider, {
          ...extraEnv,
          HTTPS_PROXY: proxyUrl,
          HTTP_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          http_proxy: proxyUrl,
          NO_PROXY: "",
        }),
      };
      const child = spawn(inv.command, inv.args, { env, stdio: ["pipe", "pipe", "pipe"], signal });
      child.stderr.on("data", () => {});
      return child;
    },
    async close() {
      if (closed) return;
      closed = true;
      await egress.close();
    },
  };
}

/** Admin diagnostics: the runtime probe and every provider's effective guarantees under the configured mode. */
export async function isolationDiagnostics(force = false) {
  const { guaranteeCheck } = await import("./providerCapabilities.ts");
  const { AGENT_PROVIDERS } = await import("./provider.ts");
  const { supervisionRuntime, supervisionStats, delegatedScopeAvailable } =
    await import("./process/supervisor.ts");
  if (force) await delegatedScopeAvailable(true);
  const runtime = await probeIsolation(force);
  const enforce = config.isolation.mode === "enforce";
  const iso = { enforce, runtimeAvailable: runtime.available };
  return {
    mode: config.isolation.mode,
    enforced: enforce && runtime.available,
    unattended_allowed: enforce && runtime.available,
    runtime,
    limits: config.isolation.limits,
    egress: config.isolation.egress,
    // Process supervision (ADR 0005): engine, launcher, delegated cgroup, PSI and counters since start.
    supervision: { ...(await supervisionRuntime()), stats: supervisionStats },
    providers: AGENT_PROVIDERS.map((p) => ({
      provider: p,
      coding: guaranteeCheck(p, "coding", null, iso),
      analysis: guaranteeCheck(p, "analysis", null, iso),
    })),
  };
}

/**
 * Remove a run's sandbox state (private provider homes). Only the exact `sandbox/run-<id>` directory of that run is
 * touched — never another run's, never a worktree or checkpoint (those live elsewhere and have their own cleanup).
 */
export function removeSandboxState(runId: number) {
  if (!Number.isInteger(runId) || runId <= 0) return false;
  const dir = join(config.dataDir, "sandbox", `run-${runId}`);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
