export function splitOperations<T extends { status: string }>(ops: T[]) {
  const pending = ops.filter((o) => o.status === "pending");
  if (pending.length < 2) return { batch: [] as T[], rest: ops };
  return { batch: pending, rest: ops.filter((o) => o.status !== "pending") };
}
