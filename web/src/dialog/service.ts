import type { AlertOptions, ConfirmOptions, DialogRequest, PromptOptions } from "./types.ts";

type Listener = (current: DialogRequest | null) => void;

const queue: DialogRequest[] = [];
let current: DialogRequest | null = null;
const listeners = new Set<Listener>();

/** Optional hook so `act()` can keep the original click trigger while a modal is open. */
let onOpenChange: ((open: boolean) => void) | null = null;

export function setDialogOpenChange(fn: ((open: boolean) => void) | null) {
  onOpenChange = fn;
}

function publish() {
  onOpenChange?.(!!current || queue.length > 0);
  for (const l of listeners) l(current);
}

function dequeue() {
  current = queue.shift() ?? null;
  publish();
}

function enqueue(req: DialogRequest) {
  if (!current) {
    current = req;
    publish();
  } else queue.push(req);
}

function settle<T>(req: DialogRequest, value: T) {
  if (current !== req) return;
  // Resolve exactly once, then show the next queued dialog (if any).
  current = null;
  publish();
  (req.resolve as (v: T) => void)(value);
  dequeue();
}

/** Subscribe the host. Returns the unsubscribe function. */
export function subscribeDialog(listener: Listener) {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

function cancelRequest(req: DialogRequest) {
  if (req.kind === "confirm") req.resolve(false);
  else if (req.kind === "prompt") req.resolve(null);
  else req.resolve(undefined);
}

/** Dismiss active + queued dialogs as cancel/null. Safe on unmount / navigation — every promise settles. */
export function dismissActiveDialog() {
  const pending = current ? [current, ...queue.splice(0)] : queue.splice(0);
  current = null;
  publish();
  for (const req of pending) cancelRequest(req);
}

export const dialog = {
  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      enqueue({
        kind: "confirm",
        options,
        resolve: (v) => resolve(!!v),
      });
    });
  },

  alert(options: AlertOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      enqueue({
        kind: "alert",
        options,
        resolve: () => resolve(),
      });
    });
  },

  prompt(options: PromptOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      enqueue({
        kind: "prompt",
        options,
        resolve: (v) => resolve(v),
      });
    });
  },

  /** Test / diagnostics. */
  _peek() {
    return { current, queued: queue.length };
  },

  /** Test helper — cancel everything and clear the queue. */
  _reset() {
    dismissActiveDialog();
  },
};

export function resolveDialog(value: boolean | string | null | void) {
  if (!current) return;
  settle(current, value as never);
}
