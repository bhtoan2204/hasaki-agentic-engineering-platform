/**
 * Process supervision benchmark (ADR 0005): `npm run bench:process`. Runs the same workloads through
 *   legacy      the pre-migration Codex path, verbatim: detached spawn, synchronous /proc scan + SIGKILL on stop
 *   typescript  src/agent/process/supervisor.ts, typescript engine
 *   go          the same adapter, go engine (platform-supervise in a delegated cgroup scope when available)
 * and measures wall time, time to first output, Node event-loop delay, Node CPU and RSS, host PSI (cpu, memory, io
 * stall totals), cleanup latency and surviving processes. Writes docs/architecture/process-supervision.json.
 *
 * Env: BENCH_AGENTS (default 8), BENCH_FLOOD_MB (default 200), BENCH_TREE (processes per tree, default 200).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const AGENTS = Number(process.env.BENCH_AGENTS ?? 8);
const FLOOD_MB = Number(process.env.BENCH_FLOOD_MB ?? 200);
const TREE = Number(process.env.BENCH_TREE ?? 200);
const root = process.env.TEST_ROOT!;
const out = join(root, "bench-bin");
if (
  spawnSync("go", ["build", "-o", `${out}/`, "./cmd/platform-supervise"], {
    cwd: resolve(import.meta.dirname, "../go"),
    stdio: "inherit",
  }).status
)
  throw new Error("build failed");
process.env.PLATFORM_SUPERVISE_BIN = join(out, "platform-supervise");
const { config } = await import("../src/config.ts");
const sup = await import("../src/agent/process/supervisor.ts");
config.supervision.slots = { agent: 0, verification: 0 }; // admission is measured separately, not here

// ---------------------------------------------------------------- the legacy path (src/agent/codex/run.ts before ADR 0005)
function legacyKillTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  const descendants = new Set<number>();
  try {
    const parent = new Map<number, number>();
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
      } catch {
        /* exited */
      }
    }
    descendants.add(pid);
    for (let grew = true; grew;) {
      grew = false;
      for (const [p, pp] of parent)
        if (descendants.has(pp) && !descendants.has(p)) {
          descendants.add(p);
          grew = true;
        }
    }
  } catch {
    /* no /proc */
  }
  for (const target of [-pid, ...descendants])
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* gone */
    }
}

type Engine = "legacy" | "typescript" | "go";
interface Handle {
  child: ChildProcess & { stdout: NonNullable<ChildProcess["stdout"]> };
  stop(): void;
  closed: Promise<void>;
}
function start(
  engine: Engine,
  command: string,
  args: string[],
  cls: "agent" | "verification" = "agent",
): Handle {
  if (engine === "legacy") {
    const child = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>((r) => child.once("close", () => r()));
    child.once("close", () => legacyKillTree(child)); // as Codex did after close
    return { child: child as Handle["child"], stop: () => legacyKillTree(child), closed };
  }
  config.supervision.engine = engine;
  const p = sup.superviseSpawn({
    command,
    args,
    cwd: root,
    env: { PATH: process.env.PATH },
    class: cls,
    graceMs: 0,
  });
  return { child: p.child, stop: p.stop, closed: p.done.then(() => {}) };
}

const psi = () => {
  const read = (n: string) => {
    const m = /some .*total=(\d+)/.exec(readFileSync(`/proc/pressure/${n}`, "utf8"));
    return m ? Number(m[1]) / 1000 : 0;
  };
  return { cpu: read("cpu"), memory: read("memory"), io: read("io") };
};
const procs = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).length;
const survivors = (marker: string) =>
  readdirSync("/proc").filter((d) => {
    try {
      const c = readFileSync(`/proc/${d}/cmdline`, "utf8");
      return c.includes(marker) && c.includes("python3\0-c\0import time");
    } catch {
      return false;
    }
  }).length;
const round = (x: number) => Math.round(x * 10) / 10;

/** Measure one workload: wall, event loop, Node CPU and RSS, PSI deltas. */
async function measure<T extends object>(fn: () => Promise<T>) {
  const el = monitorEventLoopDelay({ resolution: 5 });
  const p0 = psi();
  const c0 = process.cpuUsage();
  let rss = process.memoryUsage().rss;
  const sampler = setInterval(() => (rss = Math.max(rss, process.memoryUsage().rss)), 20);
  el.enable();
  const t = performance.now();
  const extra = await fn();
  const wall = performance.now() - t;
  el.disable();
  clearInterval(sampler);
  const c = process.cpuUsage(c0);
  const p1 = psi();
  return {
    wall_ms: round(wall),
    event_loop_p99_ms: round(el.percentile(99) / 1e6),
    event_loop_max_ms: round(el.max / 1e6),
    node_cpu_ms: round((c.user + c.system) / 1000),
    node_rss_peak_mb: round(rss / 1048576),
    psi_cpu_ms: round(p1.cpu - p0.cpu),
    psi_memory_ms: round(p1.memory - p0.memory),
    psi_io_ms: round(p1.io - p0.io),
    ...extra,
  };
}

const python = (code: string, marker = "") => ["-c", code, ...(marker ? [marker] : [])];

const workloads: Record<string, (e: Engine) => Promise<object>> = {
  // Agent-like: each process streams 2,000 JSONL events with small pauses; the platform parses every line.
  async agents(e) {
    let first = Infinity;
    const t = performance.now();
    const hs = Array.from({ length: AGENTS }, () =>
      start(
        e,
        "python3",
        python(`import json,sys,time
for i in range(2000):
  sys.stdout.write(json.dumps({"type":"item","i":i,"text":"x"*200})+"\\n")
  if i % 100 == 0: sys.stdout.flush(); time.sleep(0.01)`),
      ),
    );
    let lines = 0;
    for (const h of hs) {
      let buf = "";
      h.child.stdout.on("data", (b: Buffer) => {
        first = Math.min(first, performance.now() - t);
        buf += b;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          lines++;
        }
      });
    }
    await Promise.all(hs.map((h) => h.closed));
    return { processes: AGENTS, lines, first_output_ms: round(first) };
  },
  // CPU-intensive build: one busy process per CPU for 2 s (the cgroup does not cap CPU by default).
  async build(e) {
    const n = availableParallelism();
    await Promise.all(
      Array.from(
        { length: n },
        () =>
          start(
            e,
            "python3",
            python("import time\nt=time.time()\nwhile time.time()-t<2: pass"),
            "verification",
          ).closed,
      ),
    );
    return { processes: n };
  },
  // High-volume stdout: BENCH_FLOOD_MB through a pipe the platform drains.
  async flood(e) {
    const h = start(e, "sh", ["-c", `head -c ${FLOOD_MB * 1048576} /dev/zero`]);
    let bytes = 0;
    h.child.stdout.on("data", (b: Buffer) => (bytes += b.length));
    await h.closed;
    return { mb: round(bytes / 1048576) };
  },
  // A large tree: children, setsid sessions and double-forked daemons (reparented away), then a forced stop.
  async tree(e) {
    const marker = `ctp-bench-${e}-${Date.now()}`;
    const sleeper = `python3 -c "import time; time.sleep(600)" ${marker}`;
    const h = start(e, "bash", [
      "-c",
      `for i in $(seq ${TREE / 4}); do (${sleeper}) & setsid ${sleeper} & (setsid ${sleeper} &) ; (${sleeper} &) ; done; wait`,
    ]);
    const before = procs();
    for (let i = 0; i < 400 && survivors(marker) < TREE; i++)
      await new Promise((r) => setTimeout(r, 25));
    const started = survivors(marker);
    const t = performance.now();
    h.stop();
    // A descendant that escaped the stop keeps the stdout pipe open: the process never "closes" for the caller.
    const ok = await Promise.race([
      h.closed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    const closed = performance.now() - t;
    let left = survivors(marker);
    for (let i = 0; i < 40 && left; i++) {
      await new Promise((r) => setTimeout(r, 50));
      left = survivors(marker);
    }
    // Do not leave the host polluted by the legacy engine's survivors.
    for (const d of readdirSync("/proc"))
      try {
        if (readFileSync(`/proc/${d}/cmdline`, "utf8").includes(marker))
          process.kill(Number(d), "SIGKILL");
      } catch {
        /* gone */
      }
    return {
      processes_started: started,
      host_processes_before: before,
      closed: ok,
      cleanup_ms: ok ? round(closed) : null,
      survivors: left,
    };
  },
};

const result: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  host: {
    cpus: availableParallelism(),
    kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
  },
  delegated_cgroup: sup.delegatedScopeAvailable(),
  workloads: {} as Record<string, Record<string, object>>,
};
const res = result.workloads as Record<string, Record<string, object>>;
for (const [name, fn] of Object.entries(workloads)) {
  res[name] = {};
  for (const e of ["legacy", "typescript", "go"] as Engine[]) {
    res[name][e] = await measure(() => fn(e) as Promise<object>);
    console.error(name.padEnd(8), e.padEnd(10), JSON.stringify(res[name][e]));
    await new Promise((r) => setTimeout(r, 1500)); // let PSI settle between runs
  }
}
// Mixed: agents + build + flood at once.
res.mixed = {};
for (const e of ["legacy", "typescript", "go"] as Engine[]) {
  res.mixed[e] = await measure(async () => {
    await Promise.all([workloads.agents(e), workloads.build(e), workloads.flood(e)]);
    return {};
  });
  console.error("mixed".padEnd(8), e.padEnd(10), JSON.stringify(res.mixed[e]));
}
const file = resolve(import.meta.dirname, "../docs/architecture/process-supervision.json");
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.error(`wrote ${file}`);
process.exit(0);
