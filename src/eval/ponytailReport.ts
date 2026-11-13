import type { AgentProvider } from "../agent/provider.ts";
import { ponytailProviders } from "./ponytailSuite.ts";
export interface PonytailResult {
  provider: AgentProvider;
  ponytail: boolean;
  verificationPassRate: number | null;
  coverageSignal: number | null;
  addedLoc: number | null;
  removedLoc?: number | null;
  files?: number | null;
  contextTokens: number | null;
  tokens: number | null;
  costUsd: number | null;
  latencyMs?: number | null;
  newClones?: number | null;
  repairs?: number | null;
  regressions?: number | null;
  activated?: number | null;
  skills?: number | null;
  repetitions: number;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const metric = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const sumKnown = (values: Array<number | null>) =>
  values.length && values.every((v) => v !== null)
    ? values.reduce<number>((n, v) => n + (v ?? 0), 0)
    : null;
export function aggregatePonytailArm(
  configuration: { provider: AgentProvider; ponytail: boolean; repetitions: number },
  cases: unknown[],
): PonytailResult {
  const rows = cases.map((value) => {
    const row = record(value),
      evidence = record(record(row.data).evidence),
      details = record(evidence.details);
    const measured = details.evidence_kind === "live_provider" && row.status !== "BLOCKED";
    return { row, evidence, details, measured };
  });
  const allMeasured = rows.length > 0 && rows.every((r) => r.measured);
  const sum = (select: (r: (typeof rows)[number]) => number | null) =>
    allMeasured ? sumKnown(rows.map(select)) : null;
  const activation = rows.flatMap((r) =>
    Array.isArray(r.details.activation) ? r.details.activation.map(record) : [],
  );
  const latency = sum((r) => metric(r.evidence.duration_ms));
  return {
    ...configuration,
    verificationPassRate:
      allMeasured && rows.every((r) => typeof r.row.correct === "boolean")
        ? rows.filter((r) => r.row.correct === true).length / rows.length
        : null,
    coverageSignal:
      allMeasured && rows.every((r) => metric(r.details.coverage_signal) !== null)
        ? Math.min(...rows.map((r) => metric(r.details.coverage_signal)!))
        : null,
    addedLoc: sum((r) => metric(record(r.details.footprint).added)),
    removedLoc: sum((r) => metric(record(r.details.footprint).removed)),
    files: sum((r) => metric(record(r.details.footprint).files)),
    contextTokens: sum((r) =>
      Array.isArray(r.details.context_tokens)
        ? sumKnown(r.details.context_tokens.map(metric))
        : null,
    ),
    tokens: sum((r) => metric(r.row.tokens)),
    costUsd: sum((r) => metric(r.row.cost_usd)),
    latencyMs: latency === null ? null : latency / rows.length,
    newClones: sum((r) => metric(r.details.new_clones)),
    repairs: sum((r) => metric(r.row.repairs)),
    regressions:
      allMeasured && rows.every((r) => typeof r.row.regression === "boolean")
        ? rows.filter((r) => r.row.regression === true).length
        : null,
    activated:
      allMeasured && rows.every((r) => Array.isArray(r.details.activation))
        ? activation.filter((s) => s.state === "activated").length
        : null,
    skills:
      allMeasured && rows.every((r) => Array.isArray(r.details.activation))
        ? activation.length
        : null,
  };
}
export function ponytailAcceptance(baseline: PonytailResult, candidate: PonytailResult) {
  if (
    (baseline.verificationPassRate !== null &&
      candidate.verificationPassRate !== null &&
      candidate.verificationPassRate < baseline.verificationPassRate) ||
    (baseline.coverageSignal !== null &&
      candidate.coverageSignal !== null &&
      candidate.coverageSignal < baseline.coverageSignal) ||
    (candidate.regressions ?? 0) > (baseline.regressions ?? 0)
  )
    return "FAIL";
  if (
    baseline.verificationPassRate == null ||
    candidate.verificationPassRate == null ||
    baseline.coverageSignal == null ||
    candidate.coverageSignal == null ||
    baseline.repetitions < 2 ||
    candidate.repetitions < 2
  )
    return "INCONCLUSIVE";
  return (candidate.addedLoc !== null &&
    baseline.addedLoc !== null &&
    candidate.addedLoc < baseline.addedLoc) ||
    (candidate.contextTokens != null &&
      baseline.contextTokens != null &&
      candidate.contextTokens < baseline.contextTokens)
    ? "PASS"
    : "NO_GAIN";
}
export function renderPonytailReport(
  results: PonytailResult[],
  date = new Date().toISOString().slice(0, 10),
) {
  const lines = [
    `# Ponytail A/B evaluation — ${date}`,
    "",
    "Suite: knowledge-ponytail-v1. Four providers × baseline/pilot × two repetitions.",
    "",
    "| Provider | Status | Baseline added LOC | Pilot added LOC |",
    "|---|---|---:|---:|",
  ];
  for (const provider of ponytailProviders) {
    const baseline = results.find((r) => r.provider === provider && !r.ponytail),
      candidate = results.find((r) => r.provider === provider && r.ponytail);
    lines.push(
      `| ${provider} | ${baseline && candidate ? ponytailAcceptance(baseline, candidate) : "NOT RUN"} | ${baseline?.addedLoc ?? "—"} | ${candidate?.addedLoc ?? "—"} |`,
    );
  }
  lines.push(
    "",
    "| Provider / arm | Context tokens | Total tokens | Cost USD (reported/estimated) | Mean latency ms | LOC +/− / files | New clones | Verification pass rate | Repairs | Regressions | Activated / skills | Coverage signal |",
    "|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---:|",
  );
  for (const r of results)
    lines.push(
      `| ${r.provider} / ${r.ponytail ? "pilot" : "baseline"} | ${r.contextTokens ?? "—"} | ${r.tokens ?? "—"} | ${r.costUsd ?? "—"} | ${r.latencyMs ?? "—"} | ${r.addedLoc ?? "—"}/${r.removedLoc ?? "—"} / ${r.files ?? "—"} | ${r.newClones ?? "—"} | ${r.verificationPassRate ?? "—"} | ${r.repairs ?? "—"} | ${r.regressions ?? "—"} | ${r.activated ?? "—"} / ${r.skills ?? "—"} | ${r.coverageSignal ?? "—"} |`,
    );
  lines.push(
    "",
    "No missing measurement is counted as zero. Acceptance fails on verification, regression or coverage regression before considering token or LOC savings. Missing coverage remains inconclusive. Costs include configured token estimates when providers do not report spend; they are not invoice totals.",
    "",
    "With n=2 repetitions, results are descriptive for these pinned exploratory tasks; they do not establish general provider superiority. Antigravity includes approximately 10.7k fixed input-token overhead per session. Review tasks require independent review evidence.",
    "",
  );
  return lines.join("\n");
}
