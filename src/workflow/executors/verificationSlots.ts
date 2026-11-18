import { availableParallelism } from "node:os";

/** Concurrent verification commands per process: `VERIFY_MAX_CONCURRENT`, default a quarter of the CPUs (min 1). */
export function verificationSlotLimit(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.VERIFY_MAX_CONCURRENT);
  return Number.isInteger(n) && n > 0 ? n : Math.max(1, Math.floor(availableParallelism() / 4));
}

let busy = 0;
const waiting: Array<() => void> = [];

export const verificationSlotsInUse = () => busy;

/** Wait for a free slot; null when `signal` aborts first. The returned release is idempotent. */
export async function acquireVerificationSlot(
  signal: AbortSignal,
  limit = verificationSlotLimit(),
): Promise<(() => void) | null> {
  while (busy >= limit) {
    if (signal.aborted) return null;
    await new Promise<void>((resolve) => {
      const wake = () => {
        signal.removeEventListener("abort", wake);
        const i = waiting.indexOf(wake);
        if (i >= 0) waiting.splice(i, 1);
        resolve();
      };
      waiting.push(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }
  if (signal.aborted) return null;
  busy++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busy--;
    waiting[0]?.();
  };
}
