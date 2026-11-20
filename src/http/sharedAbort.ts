/**
 * Cancellation for work shared by several waiters (singleflight, cache-aside loads): the shared signal aborts only
 * when every waiter has disconnected, so one closed tab never cancels a response another tab is still waiting for.
 */
export class SharedAbort {
  private loads = new Map<string, { ac: AbortController; live: number }>();

  join(key: string, signal?: AbortSignal) {
    let entry = this.loads.get(key);
    if (!entry || entry.ac.signal.aborted) {
      entry = { ac: new AbortController(), live: 0 };
      this.loads.set(key, entry);
    }
    const e = entry;
    e.live++;
    let left = false;
    const leave = (aborted: boolean) => {
      if (left) return;
      left = true;
      signal?.removeEventListener("abort", onAbort);
      if (--e.live > 0) return;
      if (this.loads.get(key) === e) this.loads.delete(key);
      if (aborted) e.ac.abort(signal?.reason);
    };
    const onAbort = () => leave(true);
    if (signal?.aborted) queueMicrotask(onAbort);
    else signal?.addEventListener("abort", onAbort, { once: true });
    return { signal: e.ac.signal, leave: () => leave(false) };
  }

  get size() {
    return this.loads.size;
  }
}
