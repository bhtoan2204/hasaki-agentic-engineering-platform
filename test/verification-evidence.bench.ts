/**
 * Opt-in benchmark: node --disable-warning=ExperimentalWarning --import ./test/env.ts test/verification-evidence.bench.ts
 * (env.ts needs no PostgreSQL; the benchmark uses an in-memory evidence store and a temp git repo only.)
 * The test command is SIMULATED (fixed sleep), so the table measures the evidence cache, not real test time.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EvidenceCache, memoryEvidenceStore } from "../src/agent/verifyEvidence.ts";
import { verifyConfig, verifyWorkspaces, type VerifyDeps } from "../src/agent/verify.ts";

const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 150);
// Workflow shapes as verification call sequences. verify = a verification of the current state; repair = the agent edits the
// workspace (new fingerprint); integrate = subtask merge / rebase (new HEAD). publish = the final publication regression
// for each completed coding step, which tests the same integrated workspace.
type Op = "verify" | "repair" | "integrate" | "publish";
const SCENARIOS: Record<string, Op[]> = {
  MICRO: ["verify", "publish"],
  FAST: ["verify", "repair", "verify", "publish"],
  STANDARD: ["verify", "repair", "verify", "verify", "publish"],
  DEEP: ["verify", "repair", "verify", "repair", "verify", "verify", "publish"],
  MULTI_SUBTASK: ["verify", "verify", "integrate", "verify", "publish", "publish", "publish"],
};

const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe" });
async function scenario(ops: Op[], cached: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "vbench-"));
  git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.email", "b@b"); git(dir, "config", "user.name", "b");
  writeFileSync(join(dir, "a"), "1"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "i");
  let executed = 0;
  const cfg = { ...verifyConfig({ verify: { command: "sim" } }, "sim")!, baseline: null as null, contractRevision: "c" };
  const mk = (): VerifyDeps => ({
    run: async () => { executed++; await new Promise((r) => setTimeout(r, RUN_MS)); return { code: 0, output: "", timedOut: false }; },
    ...(cached ? { evidence: cache } : {}),
  });
  const cache = new EvidenceCache(memoryEvidenceStore(), { runId: 1, stepKey: "implement" });
  const t0 = Date.now();
  let n = 0;
  for (const op of ops) {
    if (op === "repair") { writeFileSync(join(dir, "a"), `repair-${++n}`); continue; }
    if (op === "integrate") { writeFileSync(join(dir, "b" + ++n), "x"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "merge"); continue; }
    await verifyWorkspaces([{ repo: "r", path: dir }], [dir], cfg, n + 1, new AbortController().signal, mk());
  }
  const ms = Date.now() - t0;
  rmSync(dir, { recursive: true, force: true });
  return { ms, executed, saved: cache.stats.saved_ms };
}

console.log(`SIMULATED runner (${RUN_MS}ms per run): measures evidence-cache effect, not real test time.`);
console.log("scenario        calls  off_ms  off_runs  on_ms  on_runs  saved_ms");
for (const [name, ops] of Object.entries(SCENARIOS)) {
  const calls = ops.filter((o) => o === "verify" || o === "publish").length;
  const off = await scenario(ops, false);
  const on = await scenario(ops, true);
  console.log(`${name.padEnd(15)} ${String(calls).padStart(5)} ${String(off.ms).padStart(7)} ${String(off.executed).padStart(9)} ${String(on.ms).padStart(6)} ${String(on.executed).padStart(8)} ${String(on.saved).padStart(9)}`);
}
