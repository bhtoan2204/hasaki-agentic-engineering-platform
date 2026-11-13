import { liveRuntime } from "../eval/liveRuntime.ts";
/**
 * Post-commit side effects that must not hold up the caller: chat notifications (Telegram / webhook over the network),
 * the run summary snapshot (git + several queries) and memory extraction. An API call such as "approve" commits and
 * returns at once; these run afterwards. Failures are logged, never thrown — they never affect the workflow.
 * `settleBackground()` waits for everything started so far (tests and the CLI drain use it for determinism).
 */
const pending = new Set<Promise<void>>();

export function background(label: string, fn: () => unknown) {
  // Work started from a live evaluation phase must not inherit its sandbox, cwd and budget.
  const p: Promise<void> = liveRuntime
    .exit(() => Promise.resolve().then(fn))
    .then(
      () => {},
      (e) => console.error(`${label}: ${(e as Error)?.message ?? e}`),
    )
    .finally(() => pending.delete(p));
  pending.add(p);
}

export async function settleBackground() {
  while (pending.size) await Promise.allSettled([...pending]);
}
