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
export const childGroups = {
  add: (pgid: number) => groups.add(pgid),
  remove: (pgid: number) => groups.delete(pgid),
  killAll() {
    for (const g of groups) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {}
    }
    groups.clear();
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
  size: () => handles.size,
};
