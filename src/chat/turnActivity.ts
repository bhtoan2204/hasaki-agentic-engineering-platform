/**
 * Chat turns scheduled on this instance, from scheduling until they settle (completed, failed, canceled or claimed
 * elsewhere). Background work that competes with them for CPU and provider processes — conversation titles — waits
 * here instead of polling the database.
 */
const running = new Set<number>();
const settled = new Map<number, Array<() => void>>();
let idle: Array<() => void> = [];

export function turnScheduled(turnId: number) {
  running.add(turnId);
}

export function turnSettled(turnId: number) {
  running.delete(turnId);
  for (const wake of settled.get(turnId) ?? []) wake();
  settled.delete(turnId);
  if (!running.size) {
    const waiting = idle;
    idle = [];
    for (const wake of waiting) wake();
  }
}

export const runningTurns = () => running.size;

function bounded(register: (wake: () => void) => void, maxMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    timer.unref?.();
    register(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Resolves when the turn settles (at once if it is not running here), or after maxMs. */
export function whenTurnSettles(turnId: number, maxMs: number) {
  if (!running.has(turnId)) return Promise.resolve();
  return bounded((wake) => settled.set(turnId, [...(settled.get(turnId) ?? []), wake]), maxMs);
}

/** Resolves when no turn runs here (at once if none does), or after maxMs. */
export function whenNoTurnRuns(maxMs: number) {
  if (!running.size) return Promise.resolve();
  return bounded((wake) => idle.push(wake), maxMs);
}
