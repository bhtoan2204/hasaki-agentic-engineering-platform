/**
 * In-process abort handles for jobs this process is executing. Purely an optimisation for fast
 * cancellation: correctness comes from fencing tokens in PostgreSQL (a stale worker's heartbeat fails and
 * its result is discarded), so losing this map on restart is harmless.
 */
const handles = new Map<number, AbortController>();

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
  size: () => handles.size,
};
