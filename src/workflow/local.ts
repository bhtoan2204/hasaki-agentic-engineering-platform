/**
 * In-process abort handles for jobs this process is executing. Purely an optimisation for fast
 * cancellation: correctness comes from fencing tokens in PostgreSQL (a stale worker's heartbeat fails and
 * its result is discarded), so losing this map on restart is harmless.
 */
const handles = new Map<number, AbortController>();

/**
 * Process groups of commands spawned by command steps. They run detached (so Stop can kill the whole tree), which
 * also means Ctrl+C on the server does not reach them: kill them explicitly when the server exits.
 */
const groups = new Set<number>();
/** Go process launchers (ADR 0005): they get SIGTERM and kill their own cgroup or process tree. */
const launchers = new Set<number>();
export const childGroups = {
  add: (pgid: number) => groups.add(pgid),
  remove: (pgid: number) => groups.delete(pgid),
  addLauncher: (pid: number) => launchers.add(pid),
  removeLauncher: (pid: number) => launchers.delete(pid),
  killAll() {
    for (const g of groups) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {
        /* ignore: process group already gone */
      }
    }
    groups.clear();
    for (const pid of launchers) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore: launcher already gone */
      }
    }
    launchers.clear();
  },
};
process.on("exit", () => childGroups.killAll());

export const localJobs = {
  register(jobId: number, ac: AbortController) {
    handles.set(jobId, ac);
  },
  unregister(jobId: number) {
    handles.delete(jobId);
  },
  abort(jobId: number) {
    handles.get(jobId)?.abort();
  },
  abortAll() {
    for (const ac of handles.values()) ac.abort();
  },
  activeIds: () => [...handles.keys()],
  size: () => handles.size,
};
