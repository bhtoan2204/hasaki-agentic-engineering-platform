/**
 * The one place that starts and stops supervised processes (ADR 0005): provider CLIs (Codex, Cursor, Copilot,
 * Antigravity) and verification commands. Before this module every provider had its own spawn/kill code (a
 * synchronous /proc scan with an immediate SIGKILL, a group SIGKILL, a SIGTERM-then-SIGKILL of the group) and
 * descendants that called setsid survived all of them.
 *
 *   PROCESS_SUPERVISION_ENGINE=typescript   spawn here, detached; stop = SIGTERM to the group, grace, SIGKILL to
 *                                           the group and to every descendant found under /proc (read async).
 *   PROCESS_SUPERVISION_ENGINE=go           spawn go/cmd/platform-supervise in front of the command, inside a
 *                                           `systemd-run --user --scope -p Delegate=yes` when a delegated cgroup is
 *                                           available: the command gets its own cgroup leaf with limits, cleanup is
 *                                           cgroup.kill (no PID can be confused), admission is host-wide.
 *
 * Either way the caller gets the ChildProcess whose stdin/stdout/stderr are the command's own (the launcher passes
 * its descriptors through), so stream protocols, stdin semantics, exit codes and signals are unchanged. The engine is
 * chosen when the process starts and never changes for it: nothing is ever retried under the other engine.
 */
import { spawn, spawnSync, type ChildProcess, type StdioPipe } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { config, type SupervisionLimits } from "../../config.ts";
import { childGroups } from "../../workflow/local.ts";
import { scopeEnvironment, systemdLiteral } from "./scope.ts";

export type ProcessClass = "agent" | "verification";

export interface SuperviseOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** stdin "ignore" for commands that must not read it; stdout/stderr are always pipes. */
  stdin?: "pipe" | "ignore";
  class: ProcessClass;
  /** SIGTERM-to-SIGKILL grace when stopping; 0 kills at once (the provider's established behaviour). */
  graceMs: number;
  /** Backstop deadline enforced by the Go launcher even if this process is stuck (the watchdog stays here). */
  timeoutMs?: number;
  limits?: Partial<SupervisionLimits>;
  /** Trace correlation only. */
  runId?: number | null;
  attemptId?: number | null;
}

export interface SupervisionReport {
  engine: "typescript" | "go";
  outcome: string;
  exit_code: number | null;
  signal?: string | null;
  isolation?: "cgroup" | "process-tree";
  error?: string;
  admission_wait_ms?: number;
  start_latency_ms?: number;
  duration_ms: number;
  cleanup_ms?: number;
  terminated?: number;
  killed?: number;
  orphans?: number;
  survived?: number;
  usage?: {
    memory_peak_bytes: number;
    oom_kills: number;
    memory_max_events: number;
    pids_max_events: number;
    cpu_ms: number;
    cpu_throttled_ms: number;
    psi: { cpu_some_ms: number; memory_some_ms: number; io_some_ms: number };
  };
}

export interface Supervised {
  engine: "typescript" | "go";
  child: ChildProcess & {
    stdout: NonNullable<ChildProcess["stdout"]>;
    stderr: NonNullable<ChildProcess["stderr"]>;
  };
  /** Stop the command and its descendants (idempotent): graceful first when graceMs > 0. */
  stop(): void;
  /** Resolves after the process closed, with what happened (never rejects). */
  done: Promise<SupervisionReport>;
}

/** Counters since start (GET /api/admin/isolation diagnostics, tests, benchmarks). */
export const supervisionStats = {
  started: { typescript: 0, go: 0 },
  active: 0,
  outcomes: {} as Record<string, number>,
  orphansKilled: 0,
  survivors: 0,
  oomKills: 0,
  limitEvents: 0,
  admissionWaitMs: 0,
  last: null as SupervisionReport | null,
};

const launchers = new Set<ChildProcess>();

function note(r: SupervisionReport) {
  supervisionStats.outcomes[r.outcome] = (supervisionStats.outcomes[r.outcome] ?? 0) + 1;
  supervisionStats.orphansKilled += r.orphans ?? 0;
  supervisionStats.survivors += r.survived ?? 0;
  supervisionStats.oomKills += r.usage?.oom_kills ?? 0;
  supervisionStats.limitEvents +=
    (r.usage?.memory_max_events ?? 0) + (r.usage?.pids_max_events ?? 0);
  supervisionStats.admissionWaitMs += r.admission_wait_ms ?? 0;
  supervisionStats.last = r;
}

/** Start `command` under the configured engine. */
export function superviseSpawn(o: SuperviseOptions): Supervised {
  return config.supervision.engine === "go" ? startGo(o) : startTypescript(o);
}

// ---------------------------------------------------------------- typescript engine

/** Every live process descended from `root`, read without blocking the event loop. */
async function descendantsOf(root: number) {
  const parent = new Map<number, number>();
  for (const d of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(d)) continue;
    const stat = await readFile(`/proc/${d}/stat`, "utf8").catch(() => "");
    if (!stat) continue;
    parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
  }
  const out = new Set<number>([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, pp] of parent)
      if (out.has(pp) && !out.has(p)) {
        out.add(p);
        grew = true;
      }
  }
  out.delete(root);
  return [...out];
}

const signalGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
};

function startTypescript(o: SuperviseOptions): Supervised {
  const started = Date.now();
  const child = spawn(o.command, o.args, {
    cwd: o.cwd,
    env: o.env,
    detached: true,
    shell: false,
    stdio: [o.stdin ?? "pipe", "pipe", "pipe"] as [StdioPipe | "ignore", StdioPipe, StdioPipe],
  });
  const pid = child.pid;
  supervisionStats.started.typescript++;
  supervisionStats.active++;
  if (pid) childGroups.add(pid);
  let stopping: number | null = null;
  let reason = "";
  let descendants: number[] = [];
  // Descendants are collected while the command still runs: once it exits they are reparented and unreachable.
  const force = async () => {
    if (!pid) return;
    descendants = await descendantsOf(pid);
    signalGroup(pid, "SIGKILL");
    for (const d of descendants)
      try {
        process.kill(d, "SIGKILL");
      } catch {
        /* already gone */
      }
  };
  const stop = () => {
    if (stopping !== null || !pid) return;
    stopping = Date.now();
    reason ||= "canceled";
    if (o.graceMs > 0 && child.exitCode === null && child.signalCode === null) {
      if (!signalGroup(pid, "SIGTERM")) child.kill("SIGTERM");
      const t = setTimeout(() => void force(), o.graceMs);
      t.unref();
      child.once("exit", () => {
        clearTimeout(t);
        void force(); // the rest of the group
      });
    } else void force();
  };
  const deadline = o.timeoutMs
    ? setTimeout(() => {
        reason = "timeout";
        stop();
      }, o.timeoutMs)
    : null;
  deadline?.unref();
  // Helpers left behind by a command that exited by itself are orphans: the group goes with it.
  child.once("exit", () => {
    if (stopping === null && pid) signalGroup(pid, "SIGKILL");
  });
  const done = new Promise<SupervisionReport>((resolveDone) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (deadline) clearTimeout(deadline);
      if (pid) childGroups.remove(pid);
      supervisionStats.active--;
      const r: SupervisionReport = {
        engine: "typescript",
        outcome: error ? "start_failed" : reason || (signal ? "signaled" : "exited"),
        exit_code: code,
        signal,
        ...(error ? { error } : {}),
        duration_ms: Date.now() - started,
        ...(stopping !== null ? { cleanup_ms: Date.now() - stopping } : {}),
      };
      note(r);
      resolveDone(r);
    };
    child.once("error", (e) => {
      if (!pid) finish(null, null, e.message);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
  return { engine: "typescript", child: child as Supervised["child"], stop, done };
}

// ---------------------------------------------------------------- go engine

/** The launcher binary: PLATFORM_SUPERVISE_BIN, else the build next to platform-go (src/retrieval/goService.ts). */
export function supervisorBinary() {
  return process.env.PLATFORM_SUPERVISE_BIN ?? join(config.dataDir, "bin", "platform-supervise");
}

let scopeProbe: { at: number; ok: boolean; problem?: string } | null = null;
/** Whether `systemd-run --user --scope -p Delegate=yes` works here (cached 5 minutes). */
export function delegatedScopeAvailable(force = false) {
  if (!force && scopeProbe && Date.now() - scopeProbe.at < 300_000) return scopeProbe.ok;
  const r = spawnSync(
    "systemd-run",
    ["--user", "--scope", "-q", "--collect", "-p", "Delegate=yes", "true"],
    { env: { PATH: process.env.PATH, ...scopeEnvironment() }, timeout: 5000, encoding: "utf8" },
  );
  const ok = r.status === 0;
  scopeProbe = {
    at: Date.now(),
    ok,
    problem: ok
      ? undefined
      : (r.stderr || r.error?.message || "systemd-run failed").trim().slice(0, 300),
  };
  return ok;
}

/** What the Go engine can use on this host (diagnostics). */
export function supervisionRuntime() {
  const bin = supervisorBinary();
  const scope = delegatedScopeAvailable();
  return {
    engine: config.supervision.engine,
    launcher: existsSync(bin) ? bin : null,
    delegated_cgroup: scope,
    cgroup_problem: scope ? null : (scopeProbe?.problem ?? null),
    psi: existsSync("/proc/pressure/memory"),
    limits: config.supervision.limits,
    slots: config.supervision.slots,
  };
}

const flag = (name: string, v: number | undefined) => (v && v > 0 ? [`--${name}=${v}`] : []);

function startGo(o: SuperviseOptions): Supervised {
  const started = Date.now();
  const bin = supervisorBinary();
  if (!existsSync(bin))
    throw new Error(
      `PROCESS_SUPERVISION_ENGINE=go but the launcher ${bin} is missing: run npm run build:go or set PLATFORM_SUPERVISE_BIN`,
    );
  const limits = { ...config.supervision.limits[o.class], ...(o.limits ?? {}) };
  const scope = delegatedScopeAvailable();
  // With isolation enforced a delegated cgroup is mandatory (fail closed); otherwise it is used when present.
  if (!scope && config.isolation.mode === "enforce")
    throw new Error(
      `process supervision needs a delegated cgroup while isolation is enforced: ${scopeProbe?.problem ?? "unavailable"}`,
    );
  const reportDir = join(config.dataDir, "supervisor");
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const report = join(reportDir, `${randomUUID()}.json`);
  const launcherArgs = [
    `--cgroup=${scope ? "require" : "none"}`,
    `--grace=${Math.max(0, o.graceMs)}ms`,
    ...(o.timeoutMs ? [`--timeout=${o.timeoutMs}ms`] : []),
    `--class=${o.class}`,
    ...flag("slots", config.supervision.slots[o.class]),
    ...(config.supervision.slots[o.class] > 0
      ? [
          `--admission-dir=/tmp/ctp-admission-${userInfo().uid}`,
          `--admission-timeout=${config.supervision.admissionTimeoutMs}ms`,
          ...flag("psi-memory", config.supervision.psiMemory),
          ...flag("psi-cpu", config.supervision.psiCpu),
        ]
      : []),
    ...flag("memory-mb", limits.memoryMb),
    ...flag("pids", limits.pids),
    ...flag("cpu-percent", limits.cpuPercent),
    ...flag("cpu-seconds", limits.cpuSeconds),
    ...flag("fsize-mb", limits.fileSizeMb),
    ...flag("nofile", limits.openFiles),
    `--report=${report}`,
    ...(o.runId ? [`--run-id=${o.runId}`] : []),
    ...(o.attemptId ? [`--attempt-id=${o.attemptId}`] : []),
    "--",
    o.command,
    ...o.args,
  ];
  // systemd-run needs the user bus; the command does not get it unless it already had it.
  const busEnv = scope ? scopeEnvironment() : {};
  const unset = Object.keys(busEnv).filter((k) => o.env[k] === undefined);
  const env: NodeJS.ProcessEnv = {
    ...o.env,
    ...busEnv,
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { CTP_SUPERVISE_OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  };
  if (unset.length) launcherArgs.unshift(`--unset=${unset.join(",")}`);
  const [command, args] = scope
    ? [
        "systemd-run",
        [
          "--user",
          "--scope",
          "-q",
          "--collect",
          "-p",
          "Delegate=yes",
          "--",
          ...systemdLiteral([resolve(bin), ...launcherArgs]),
        ],
      ]
    : [bin, launcherArgs];
  const child = spawn(command, args as string[], {
    cwd: o.cwd,
    env,
    shell: false,
    stdio: [o.stdin ?? "pipe", "pipe", "pipe"] as [StdioPipe | "ignore", StdioPipe, StdioPipe],
  });
  supervisionStats.started.go++;
  supervisionStats.active++;
  launchers.add(child);
  if (child.pid) childGroups.addLauncher(child.pid);
  let stopped = false;
  const stop = () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    stopped = true;
    // The launcher terminates gracefully, then kills the whole cgroup (or tree) and reports.
    child.kill("SIGTERM");
  };
  const done = new Promise<SupervisionReport>((resolveDone) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      launchers.delete(child);
      if (child.pid) childGroups.removeLauncher(child.pid);
      supervisionStats.active--;
      let r: SupervisionReport;
      try {
        r = JSON.parse(readFileSync(report, "utf8"));
      } catch {
        r = {
          engine: "go",
          outcome: error ? "start_failed" : signal ? "signaled" : "exited",
          exit_code: code,
          signal,
          ...(error ? { error } : {}),
          duration_ms: Date.now() - started,
        };
      }
      rmSync(report, { force: true });
      note(r);
      resolveDone(r);
    };
    child.once("error", (e) => {
      if (!child.pid) finish(null, null, e.message);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
  return { engine: "go", child: child as Supervised["child"], stop, done };
}

/**
 * One line for the attempt log when supervision itself ended or limited the command (null when nothing notable
 * happened): the reason a provider turn or a verification command failed is otherwise only an exit status.
 */
export function supervisionNote(r: SupervisionReport): string | null {
  const u = r.usage;
  if (r.outcome === "oom" || (u?.oom_kills ?? 0) > 0)
    return `process supervision: killed by the memory limit (peak ${Math.round((u?.memory_peak_bytes ?? 0) / 1048576)} MiB)`;
  if (
    r.outcome === "isolation_unavailable" ||
    r.outcome === "admission_timeout" ||
    r.outcome === "start_failed"
  )
    return `process supervision: the command did not start (${r.outcome}${r.error ? `: ${r.error}` : ""})`;
  if ((u?.pids_max_events ?? 0) > 0)
    return "process supervision: the process-count limit was reached";
  if ((r.survived ?? 0) > 0)
    return `process supervision: ${r.survived} process(es) survived cleanup`;
  if ((r.orphans ?? 0) > 0)
    return `process supervision: ${r.orphans} leftover process(es) were stopped after exit`;
  return null;
}

/** Server shutdown: ask every launcher to clean up its command (they also do on their own when this process dies). */
export async function stopSupervised(waitMs = 6000) {
  const pending = [...launchers];
  for (const c of pending) c.kill("SIGTERM");
  await Promise.race([
    Promise.all(
      pending.map((c) => new Promise((r) => (c.exitCode !== null ? r(null) : c.once("close", r)))),
    ),
    new Promise((r) => setTimeout(r, waitMs).unref()),
  ]);
}
