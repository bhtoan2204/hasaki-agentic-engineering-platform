/**
 * Deterministic evidence-gated investigation benchmark (offline; no model, network or database).
 *   npm run eval:investigation            → summary
 *   npm run eval:investigation -- --json  → full JSON report
 */
import { runInvestigationBenchmark } from "../eval/investigation.ts";

const r = runInvestigationBenchmark();
if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
else {
  console.log(`Evidence-gated investigation benchmark: ${r.passed}/${r.scenarios} scenarios fully passed`);
  for (const [k, m] of Object.entries(r.metrics)) console.log(`  ${k.padEnd(28)} ${m.passed}/${m.total}  (Wilson 95% ≥ ${m.ci95[0].toFixed(2)})`);
  console.log(`  context summary: avg ${r.token_overhead.avg_summary_tokens} tokens, max ${r.token_overhead.max_summary_tokens} (character estimate)`);
  for (const f of r.failures) console.log(`  FAIL ${f}`);
}
process.exitCode = r.failures.length ? 1 : 0;
