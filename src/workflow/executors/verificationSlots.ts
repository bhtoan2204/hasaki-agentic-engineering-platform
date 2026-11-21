import { availableParallelism } from "node:os";

/**
 * Concurrent verification commands per process: `VERIFY_MAX_CONCURRENT`, default a quarter of the CPUs (min 1) — and,
 * when host-wide admission slots apply (PROCESS_SUPERVISION_ENGINE=go, `hostSlots`), no more than those: a command
 * past them would only wait in the launcher's admission and fail with admission_timeout after
 * supervision.admissionTimeoutMs, while here it waits without a deadline and can be canceled.
 */
export function verificationSlotLimit(env: NodeJS.ProcessEnv = process.env, hostSlots?: number) {
  const n = Number(env.VERIFY_MAX_CONCURRENT);
  if (Number.isInteger(n) && n > 0) return n;
  const cpus = Math.max(1, Math.floor(availableParallelism() / 4));
  return hostSlots && hostSlots > 0 ? Math.min(cpus, hostSlots) : cpus;
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
