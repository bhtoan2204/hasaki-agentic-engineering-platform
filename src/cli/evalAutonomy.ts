/**
 * Deterministic autonomy evaluation (control-plane): `npm run eval:autonomy -- [--out DIR] [--baseline FILE] [--variant NAME]`.
 * Writes autonomy-<commit>.json (machine-readable) and .md (human-readable) and exits 1 when a safety gate fails in any
 * variant. `--live` (real provider) refuses unless a budget and the enforced sandbox are configured, and is not
 * implemented by this command: it prints the procedure and exits 2 — no live model call ever happens here.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autonomyGate,
  computeAutonomyMetrics,
  type AutonomyMetrics,
  type Episode,
} from "../eval/autonomy.ts";
import { runAutonomySuite, suiteManifest, VARIANTS } from "../eval/autonomySuite.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--live")) {
  const budget = Number(process.env.EVAL_LIVE_BUDGET_USD);
  const problems = [
    ...(!Number.isFinite(budget) || budget <= 0
      ? ["EVAL_LIVE_BUDGET_USD (a positive spending cap) is not set"]
      : []),
    ...(process.env.EVAL_LIVE_ISOLATION !== "enforce"
      ? ["EVAL_LIVE_ISOLATION=enforce (agents in the OS sandbox) is not set"]
      : []),
  ];
  console.error(
    `live autonomy evaluation: BLOCKED — ${problems.length ? problems.join("; ") : "not implemented by this command"}.\n` +
      "Procedure: run the existing live evaluation (src/eval/liveProvider.ts via the evaluation API) on the synthetic repositories with an explicit provider/model/effort and budget; the deterministic suite here stays the release gate.",
  );
  process.exit(2);
}
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a checkout */
}
const manifest = suiteManifest();
const variants = VARIANTS.filter((v) => !opt("variant") || v.name === opt("variant"));
const results = variants.map((v) => {
  const episodes = runAutonomySuite(v);
  const metrics = computeAutonomyMetrics(episodes);
  return { variant: v, metrics, gate: autonomyGate(metrics), episodes };
});
const report = {
  suite: manifest.version,
  manifest_hash: manifest.hash,
  commit,
  generated_at: new Date().toISOString(),
  evidence_kind:
    "control_plane (scripted inputs, real decision code); not coding quality, not production outcomes",
  results,
};

const pct = (r: { value: number | null; numerator: number; denominator: number }) =>
  r.value == null
    ? `n/a (0 eligible)`
    : `${(r.value * 100).toFixed(0)}% (${r.numerator}/${r.denominator})`;
const md = [
  `# Autonomy evaluation — ${commit}`,
  "",
  `Suite ${manifest.version} (manifest ${manifest.hash}); ${report.evidence_kind}. Small fixed sample: no statistical claim.`,
  "",
  "| Variant | Gate | Human-free (eligible) | Policy compliance | Avoidable / mandatory interventions | Auto-recovery | False completion | Unauthorized side effects | Not run |",
  "|---|---|---|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.variant.name} | ${r.gate.passed ? "PASS" : "FAIL"} | ${pct(r.metrics.human_free_completion)} | ${pct(r.metrics.policy_compliance)} | ${r.metrics.interventions.avoidable} / ${r.metrics.interventions.mandatory} | ${pct(r.metrics.auto_recovery)} | ${pct(r.metrics.false_completion)} | ${r.metrics.unauthorized_side_effects} | ${r.metrics.sample.cohorts.not_run} |`,
  ),
  "",
  "## Cases",
  "",
  "| Case | Eligibility | Expected | " + results.map((r) => r.variant.name).join(" | ") + " |",
  "|---|---|---|" + results.map(() => "---").join("|") + "|",
  ...manifest.cases.map((c) => {
    const cells = results.map((r) => {
      const e = r.episodes.find((x) => x.case_id === c.id)!;
      return e.status === "not_run"
        ? "not run"
        : `${e.oracle === true ? "✓" : e.oracle === false ? "✗" : "?"} ${e.claimed}${e.human_events.length ? ` (${e.human_events.length} human)` : ""}`;
    });
    return `| ${c.id} | ${c.eligibility} | ${c.expected} | ${cells.join(" | ")} |`;
  }),
  "",
  ...results.flatMap((r) =>
    r.gate.failures.length
      ? [`**${r.variant.name} gate failures:** ${r.gate.failures.join("; ")}`]
      : [],
  ),
  ...manifest.cases
    .filter((c) => "not_run" in c)
    .map((c) => `- ${c.id}: not run here — ${(c as { not_run?: string }).not_run}`),
].join("\n");

const baselineFile = opt("baseline");
let comparison = "";
if (baselineFile) {
  const base = JSON.parse(readFileSync(baselineFile, "utf8")) as typeof report;
  const rows: string[] = [];
  for (const r of results) {
    const b = base.results.find((x) => x.variant.name === r.variant.name);
    if (!b) {
      rows.push(`| ${r.variant.name} | (absent in baseline) | | |`);
      continue;
    }
    const m = (x: AutonomyMetrics) => x.human_free_completion.value;
    const changed = r.episodes.filter((e) => {
      const old = b.episodes.find((x: Episode) => x.case_id === e.case_id);
      return !old || old.oracle !== e.oracle || old.claimed !== e.claimed;
    });
    rows.push(
      `| ${r.variant.name} | ${m(b.metrics)} → ${m(r.metrics)} | ${changed.map((e) => e.case_id).join(", ") || "none"} | ${base.manifest_hash === manifest.hash ? "same manifest" : "manifest changed"} |`,
    );
  }
  comparison = [
    "",
    `## Baseline ${base.commit} → candidate ${commit}`,
    "",
    "| Variant | Human-free rate | Cases with a changed outcome | Manifest |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const out = opt("out") ?? ".eval/autonomy";
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `autonomy-${commit}.json`), JSON.stringify(report, null, 2));
writeFileSync(join(out, `autonomy-${commit}.md`), md + comparison + "\n");
console.log(md + comparison);
console.log(`\nwritten: ${join(out, `autonomy-${commit}.json`)} and .md`);
process.exit(results.every((r) => r.gate.passed) ? 0 : 1);
