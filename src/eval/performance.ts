/** Numeric-only measurements for serial fixture evaluations. Never stores statements, parameters or prompts. */
export const platformPerformanceFixtures = [
  {
    id: "small",
    knowledge_items: 10,
    context_entries: 8,
    idle_claims: 2,
    repositories: 2,
    answers: 2,
  },
  {
    id: "medium",
    knowledge_items: 100,
    context_entries: 80,
    idle_claims: 8,
    repositories: 8,
    answers: 8,
  },
  {
    id: "large",
    knowledge_items: 1000,
    context_entries: 800,
    idle_claims: 32,
    repositories: 32,
    answers: 32,
  },
] as const;

export async function measureQueries<A extends unknown[], R, T>(
  target: { query: (...args: A) => Promise<R> },
  action: () => Promise<T>,
) {
  const original = target.query;
  let query_calls = 0,
    query_failures = 0,
    query_elapsed_ms = 0;
  target.query = async function (...args: A) {
    query_calls++;
    const start = performance.now();
    try {
      return await original.apply(target, args);
    } catch (error) {
      query_failures++;
      throw error;
    } finally {
      query_elapsed_ms += performance.now() - start;
    }
  };
  try {
    const value = await action();
    return { value, query_calls, query_failures, query_elapsed_ms };
  } finally {
    target.query = original;
  }
}

export function distribution(values: number[]) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error("Invalid samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)!,
  };
}

/** Refuse to label a dirty worktree as HEAD. The harness snapshot directory is created beside the candidate and is not source. */
export function pinnedCandidateIdentity(statusPorcelain: string, revision: string, tree: string) {
  const dirty = statusPorcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.includes(".performance-baseline-"));
  if (dirty.length)
    throw new Error("Uncommitted candidate changes cannot be reported as the pinned HEAD revision");
  if (!/^[0-9a-f]{40}$/.test(revision) || !/^[0-9a-f]{40}$/.test(tree))
    throw new Error("Pinned candidate revision must be the full HEAD commit and tree");
  return { revision, tree };
}

export interface PerformanceSample {
  fixture: string;
  repetition: number;
  temperature: string;
  wall_ms: number;
  output_hash: string;
}

/** Pair by workload, temperature and repetition, never by arrival order or fastest run. */
export function pairedSummary(baseline: PerformanceSample[], candidate: PerformanceSample[]) {
  const key = (s: PerformanceSample) => JSON.stringify([s.fixture, s.temperature, s.repetition]);
  const index = new Map(candidate.map((s) => [key(s), s]));
  if (
    index.size !== candidate.length ||
    baseline.length !== candidate.length ||
    new Set(baseline.map(key)).size !== baseline.length
  )
    throw new Error("Unmatched or duplicate samples");
  const groups = new Map<string, Array<{ a: number; b: number }>>();
  for (const a of baseline) {
    const b = index.get(key(a));
    if (!b) throw new Error("Unmatched samples");
    if (a.output_hash !== b.output_hash) throw new Error(`Output mismatch: ${a.fixture}`);
    const group = JSON.stringify([a.fixture, a.temperature]);
    const rows = groups.get(group) ?? [];
    rows.push({ a: a.wall_ms, b: b.wall_ms });
    groups.set(group, rows);
  }
  return [...groups].map(([group, rows]) => ({
    fixture: JSON.parse(group)[0] as string,
    temperature: JSON.parse(group)[1] as string,
    pairs: rows.length,
    baseline_ms: distribution(rows.map((r) => r.a)),
    candidate_ms: distribution(rows.map((r) => r.b)),
    delta_ms: distribution(rows.map((r) => r.b - r.a)),
  }));
}
