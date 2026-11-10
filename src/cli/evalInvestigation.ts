/**
 * Deterministic investigation benchmarks (offline; no model, network or database):
 *  - evidence-gated bug investigation (claims, root-cause calibration, fix safety, scope review)
 *  - production incident investigation (synthetic HasakiNOW logs: correlation, timeline, latency, no-hallucination report)
 *   npm run eval:investigation            → summary
 *   npm run eval:investigation -- --json  → full JSON report
 */
import { runInvestigationBenchmark } from "../eval/investigation.ts";
import { runTimelineBenchmark } from "../eval/investigationTimeline.ts";

const r = runInvestigationBenchmark();
const t = runTimelineBenchmark();
if (process.argv.includes("--json")) console.log(JSON.stringify({ evidence_gated: r, production_investigation: t }, null, 2));
else {
  console.log(`Evidence-gated investigation benchmark: ${r.passed}/${r.scenarios} scenarios fully passed`);
  for (const [k, m] of Object.entries(r.metrics)) console.log(`  ${k.padEnd(28)} ${m.passed}/${m.total}  (Wilson 95% ≥ ${m.ci95[0].toFixed(2)})`);
  console.log(`  context summary: avg ${r.token_overhead.avg_summary_tokens} tokens, max ${r.token_overhead.max_summary_tokens} (character estimate)`);
  for (const f of r.failures) console.log(`  FAIL ${f}`);
  console.log(`Production incident investigation benchmark: ${t.passed}/${t.scenarios} scenarios fully passed`);
  for (const [k, m] of Object.entries(t.metrics)) console.log(`  ${k.padEnd(28)} ${m.passed}/${m.total}  (Wilson 95% ≥ ${m.ci95[0].toFixed(2)})`);
  for (const f of t.failures) console.log(`  FAIL ${f}`);
}
process.exitCode = r.failures.length || t.failures.length ? 1 : 0;
