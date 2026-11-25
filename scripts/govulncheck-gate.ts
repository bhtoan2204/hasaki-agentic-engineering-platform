/**
 * `node scripts/govulncheck-gate.ts`: runs govulncheck over go/ and fails only on a REACHABLE vulnerability (one whose
 * trace has a called function) that go/govulncheck-allowlist.json does not list. Each allowlist entry needs a reason and
 * an expiry; an expired or no-longer-reported entry is a warning (so a fix is noticed), never a red build by itself.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AllowEntry {
  id: string;
  reason: string;
  expires: string;
}

/** The OSV ids govulncheck reports as called by this code, from its `-format json` stream. */
export function reachableIds(stream: string): string[] {
  const ids = new Set<string>();
  // The stream is concatenated pretty-printed JSON objects, each starting at column 0.
  for (const chunk of stream.split(/\n(?=\{)/)) {
    let message: { finding?: { osv?: string; trace?: Array<{ function?: string }> } };
    try {
      message = JSON.parse(chunk);
    } catch {
      continue;
    }
    const finding = message.finding;
    if (finding?.osv && finding.trace?.some((frame) => frame.function)) ids.add(finding.osv);
  }
  return [...ids].sort();
}

export function evaluate(reachable: string[], allowlist: AllowEntry[], today: string) {
  const allowed = new Map(allowlist.map((entry) => [entry.id, entry]));
  return {
    failures: reachable.filter((id) => !allowed.has(id)),
    expired: allowlist.filter((entry) => entry.expires < today).map((entry) => entry.id),
    stale: allowlist.filter((entry) => !reachable.includes(entry.id)).map((entry) => entry.id),
  };
}

if (import.meta.main) {
  const goDir = join(import.meta.dirname, "..", "go");
  const allowlist: AllowEntry[] = JSON.parse(
    readFileSync(join(goDir, "govulncheck-allowlist.json"), "utf8"),
  ).allow;
  const run = spawnSync("govulncheck", ["-format", "json", "./..."], {
    cwd: goDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error || !run.stdout.includes('"config"')) {
    console.error(`govulncheck did not run: ${run.error?.message ?? run.stderr}`);
    process.exit(2);
  }
  const reachable = reachableIds(run.stdout);
  const result = evaluate(reachable, allowlist, new Date().toISOString().slice(0, 10));
  console.log(`reachable: ${reachable.join(", ") || "none"}`);
  for (const id of result.expired)
    console.log(`::warning::govulncheck allowlist entry ${id} has expired`);
  for (const id of result.stale)
    console.log(`::warning::govulncheck allowlist entry ${id} is no longer reported; remove it`);
  if (result.failures.length) {
    console.error(`reachable vulnerabilities not in the allowlist: ${result.failures.join(", ")}`);
    process.exit(1);
  }
}
