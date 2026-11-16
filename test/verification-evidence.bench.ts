/**
 * Opt-in benchmark: node --disable-warning=ExperimentalWarning --import ./test/env.ts test/verification-evidence.bench.ts
 * The test command is SIMULATED (fixed sleep), so the table measures the evidence cache, not real test time.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EvidenceCache, memoryEvidenceStore } from "../src/agent/verifyEvidence.ts";
import { verifyConfig, verifyWorkspaces, type VerifyDeps } from "../src/agent/verify.ts";

const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 150);
// verification calls per workflow: [coding rounds, regression steps, post-integration checks, publish checks, unchanged?]
const SCENARIOS: Record<string, number> = { MICRO: 2, FAST: 3, STANDARD: 4, DEEP: 6, MULTI_SUBTASK: 9 };

const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe" });
async function scenario(calls: number, cached: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "vbench-"));
  git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.email", "b@b"); git(dir, "config", "user.name", "b");
  writeFileSync(join(dir, "a"), "1"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "i");
  let executed = 0;
  const cfg = { ...verifyConfig({ verify: { command: "sim" } }, "sim")!, baseline: null as any, contractRevision: "c" };
  const mk = (): VerifyDeps => ({
    run: async () => { executed++; await new Promise((r) => setTimeout(r, RUN_MS)); return { code: 0, output: "", timedOut: false }; },
    ...(cached ? { evidence: cache } : {}),
  });
  const cache = new EvidenceCache(memoryEvidenceStore(), { runId: 1, stepKey: "implement" });
  const t0 = Date.now();
  for (let i = 0; i < calls; i++) {
    // the workspace changes once (a repair) after the first call; later calls see the same state
    if (i === 1) writeFileSync(join(dir, "a"), "2");
    await verifyWorkspaces([{ repo: "r", path: dir }], [dir], cfg, i + 1, new AbortController().signal, mk());
  }
  const ms = Date.now() - t0;
  rmSync(dir, { recursive: true, force: true });
  return { ms, executed, saved: cache.stats.saved_ms };
}

console.log(`SIMULATED runner (${RUN_MS}ms per run): measures evidence-cache effect, not real test time.`);
console.log("scenario        calls  off_ms  off_runs  on_ms  on_runs  saved_ms");
for (const [name, calls] of Object.entries(SCENARIOS)) {
  const off = await scenario(calls, false);
  const on = await scenario(calls, true);
  console.log(`${name.padEnd(15)} ${String(calls).padStart(5)} ${String(off.ms).padStart(7)} ${String(off.executed).padStart(9)} ${String(on.ms).padStart(6)} ${String(on.executed).padStart(8)} ${String(on.saved).padStart(9)}`);
}
