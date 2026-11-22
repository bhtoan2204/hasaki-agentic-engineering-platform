/** Production Bug Hunter verdict rules: an agent's claim can only lower a status; proof comes from the platform. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRepro,
  decide,
  dedupeCandidates,
  enclosingFunction,
  excerptMatches,
  matchFile,
  normalizeCandidates,
  parseFrames,
  parseVerifierOutput,
  validateReproduction,
  type VerifierVerdict,
} from "../src/bugHunt/logic.ts";
import { huntStatus } from "../src/bugHunt/service.ts";

const verdict = (o: Partial<VerifierVerdict> = {}): VerifierVerdict => ({
  id: "C1",
  verdict: "CONFIRMED",
  reason: "r",
  execution_path: ["Handler → Apply"],
  code_evidence: [],
  alternative_explanations: [],
  incident_link: "SUPPORTED",
  incident_link_reason: "",
  reproduction: null,
  ...o,
});
const onStack = { inPath: true, emitsError: false, incidentEvidence: true, productionMatch: true };

test("CONFIRMED needs the verifier's CONFIRMED and platform proof", () => {
  const base = { verifierRan: true, codeEvidenceVerified: false, link: onStack };
  assert.equal(
    decide({ ...base, verdict: verdict(), repro: { outcome: "reproduced" } })
      .bug_verification_status,
    "CONFIRMED",
  );
  // A passing reproduction refutes the claim, whatever the verifier said.
  assert.equal(
    decide({ ...base, verdict: verdict(), repro: { outcome: "not_reproduced" } })
      .bug_verification_status,
    "SUSPECTED",
  );
  // A reproduction the platform could not run safely is BLOCKED, even with matching code evidence.
  assert.equal(
    decide({
      ...base,
      verdict: verdict(),
      repro: { outcome: "blocked" },
      codeEvidenceVerified: true,
    }).bug_verification_status,
    "BLOCKED",
  );
  assert.equal(
    decide({ ...base, verdict: verdict(), repro: { outcome: "invalid" } }).bug_verification_status,
    "SUSPECTED",
  );
  // No reproduction proposed: code evidence the platform matched + an execution path.
  assert.equal(
    decide({ ...base, verdict: verdict(), repro: null, codeEvidenceVerified: true })
      .bug_verification_status,
    "CONFIRMED",
  );
  assert.equal(
    decide({ ...base, verdict: verdict(), repro: null }).bug_verification_status,
    "SUSPECTED",
  );
  assert.equal(
    decide({
      ...base,
      verdict: verdict({ execution_path: [] }),
      repro: null,
      codeEvidenceVerified: true,
    }).bug_verification_status,
    "SUSPECTED",
  );
  // A reproduction never upgrades a verifier's non-confirmation.
  for (const v of ["SUSPECTED", "REJECTED", "BLOCKED"] as const)
    assert.equal(
      decide({ ...base, verdict: verdict({ verdict: v }), repro: { outcome: "reproduced" } })
        .bug_verification_status,
      v,
    );
  assert.equal(
    decide({ ...base, verdict: null, verifierRan: false, repro: null }).bug_verification_status,
    "BLOCKED",
  );
  assert.equal(
    decide({ ...base, verdict: null, repro: null }).bug_verification_status,
    "SUSPECTED",
  );
});

test("incident causality is a separate verdict: a confirmed bug is not automatically the incident's cause", () => {
  const ok = {
    verdict: verdict(),
    verifierRan: true,
    repro: { outcome: "reproduced" as const },
    codeEvidenceVerified: false,
  };
  assert.equal(decide({ ...ok, link: onStack }).incident_causality_status, "CONFIRMED");
  assert.equal(
    decide({ ...ok, link: { ...onStack, inPath: false } }).incident_causality_status,
    "NOT_SUPPORTED",
  );
  assert.equal(
    decide({ ...ok, link: { ...onStack, inPath: false, calledFromPath: true } })
      .incident_causality_status,
    "PROBABLE",
  );
  assert.equal(
    decide({ ...ok, link: { ...onStack, productionMatch: false } }).incident_causality_status,
    "PROBABLE",
  );
  assert.equal(
    decide({ ...ok, link: { ...onStack, productionMatch: null } }).incident_causality_status,
    "PROBABLE",
  );
  assert.equal(
    decide({ ...ok, verdict: verdict({ incident_link: "UNKNOWN" }), link: onStack })
      .incident_causality_status,
    "PROBABLE",
  );
  assert.equal(
    decide({ ...ok, link: { ...onStack, incidentEvidence: false } }).incident_causality_status,
    "UNKNOWN",
  );
  assert.equal(
    decide({ ...ok, verdict: verdict({ verdict: "REJECTED" }), link: onStack })
      .incident_causality_status,
    "NOT_APPLICABLE",
  );
  // A suspected bug on the stack is at most a PROBABLE cause.
  assert.equal(
    decide({ ...ok, verdict: verdict({ verdict: "SUSPECTED" }), link: onStack })
      .incident_causality_status,
    "PROBABLE",
  );
});

test("verifier output is parsed fail-closed", () => {
  const m = parseVerifierOutput(
    {
      verdicts: [
        { id: "C1", verdict: "definitely" },
        { id: "C9", verdict: "CONFIRMED" },
        { id: "C2", verdict: "rejected" },
      ],
    },
    ["C1", "C2"],
  );
  assert.equal(m.get("C1")!.verdict, "BLOCKED");
  assert.equal(m.has("C9"), false, "claims that were not sent are ignored");
  assert.equal(m.get("C2")!.verdict, "REJECTED");
  assert.equal(parseVerifierOutput(null, ["C1"]).size, 0);
});

test("stack frames, file matching and Go function spans", () => {
  const frames = parseFrames(
    "panic: x\nshop/orders.Format(...)\n\t/build/src/shop/orders/render.go:7 +0x1d\nruntime.goexit()\n\t/usr/lib/go/src/runtime/asm.go:1 +0x1",
    "orders/render.go:7",
  );
  assert.deepEqual(frames, [
    { function: "orders.Format", file: "/build/src/shop/orders/render.go", line: 7 },
  ]);
  assert.equal(
    matchFile("/build/src/shop/orders/render.go", [
      "render.go",
      "orders/render.go",
      "x/orders/loader.go",
    ]),
    "orders/render.go",
  );
  assert.equal(matchFile("/elsewhere/nothing.go", ["orders/render.go"]), null);
  const src =
    "package x\n\nfunc (s *Store) Reserve(q int) bool {\n\treturn true\n}\n\nfunc One() int { return 1 }\n";
  assert.deepEqual(enclosingFunction(src, 4), {
    name: "Reserve",
    receiver: "Store",
    start: 3,
    end: 5,
  });
  assert.equal(enclosingFunction(src, 7)!.name, "One");
  assert.equal(enclosingFunction(src, 1), null);
});

test("candidates: malformed ones are dropped, duplicates merged, ids stable by confidence", () => {
  const { candidates, malformed } = normalizeCandidates([
    {
      repository: "r",
      file_path: "a.go",
      function: "F",
      line_start: 3,
      hypothesis: "h",
      category: "nil pointer",
      confidence: "low",
    },
    {
      repository: "r",
      file_path: "a.go",
      function: "(T).F",
      line_start: 9,
      hypothesis: "h2",
      category: "nil_handling",
      confidence: 0.9,
    },
    { repository: "r", file_path: "../etc/passwd", function: "F", line_start: 1, hypothesis: "h" },
    { repository: "r", function: "F", hypothesis: "h" },
  ]);
  assert.equal(malformed.length, 2);
  const d = dedupeCandidates(candidates);
  assert.equal(d.candidates.length, 1);
  assert.equal(d.candidates[0].id, "C1");
  assert.equal(d.candidates[0].confidence, 0.9);
  assert.equal(d.duplicates[0].merged, 1);
});

test("reproductions: only a new Go test file in the package; outcomes from the named test only", () => {
  const r = {
    package_dir: "pricing",
    test_file: "pricing/x_test.go",
    test_name: "TestX",
    test_code: "package pricing\nfunc TestX(t *testing.T) {}",
  };
  assert.deepEqual(
    validateReproduction(r, () => false),
    { ok: true, command: "go test -count=1 -buildvcs=false -run '^TestX$' ./pricing" },
  );
  assert.equal(validateReproduction(r, () => true).ok, false, "never overwrites an existing file");
  assert.equal(validateReproduction({ ...r, test_file: "pricing/x.go" }, () => false).ok, false);
  assert.equal(validateReproduction({ ...r, test_file: "../x_test.go" }, () => false).ok, false);
  assert.equal(validateReproduction({ ...r, test_name: "TestX; rm -rf /" }, () => false).ok, false);
  assert.equal(validateReproduction({ ...r, package_dir: "other" }, () => false).ok, false);
  assert.equal(
    classifyRepro("TestX", { code: 1, output: "--- FAIL: TestX (0.00s)\nFAIL", timedOut: false })
      .outcome,
    "reproduced",
  );
  assert.equal(
    classifyRepro("TestX", { code: 0, output: "ok  \tshop/pricing\t0.1s", timedOut: false })
      .outcome,
    "not_reproduced",
  );
  assert.equal(
    classifyRepro("TestX", { code: 1, output: "--- FAIL: TestOther\nFAIL", timedOut: false })
      .outcome,
    "invalid",
  );
  assert.equal(
    classifyRepro("TestX", {
      code: 1,
      output: "./x_test.go:3: undefined: Foo\nFAIL\tshop [build failed]",
      timedOut: false,
    }).outcome,
    "invalid",
  );
  assert.equal(
    classifyRepro("TestX", {
      code: 1,
      output: "go: module lookup disabled by GOPROXY=off",
      timedOut: false,
    }).outcome,
    "blocked",
  );
  assert.equal(
    classifyRepro("TestX", { code: null, output: "", timedOut: true }).outcome,
    "timeout",
  );
});

test("code excerpts must be present at the cited lines", () => {
  const src = "a\nb\nfunc F() {\n\treturn price - price*(pct/100)\n}\n";
  assert.equal(
    excerptMatches(src, { line_start: 4, line_end: 4, excerpt: "return price - price*(pct/100)" }),
    true,
  );
  assert.equal(
    excerptMatches(src, {
      line_start: 40,
      line_end: 40,
      excerpt: "return price - price*(pct/100)",
    }),
    false,
  );
  assert.equal(
    excerptMatches(src, { line_start: 4, line_end: 4, excerpt: "return price * 2 // invented" }),
    false,
  );
  assert.equal(
    excerptMatches(src, { line_start: 4, line_end: 4, excerpt: "x" }),
    false,
    "too short to prove anything",
  );
});

test("hunt status comes from the workflow run", () => {
  const steps = (o: Record<string, string>) =>
    ["context", "scope", "hunt", "triage", "verify", "reproduce", "report"].map((key) => ({
      key,
      status: o[key] ?? "PENDING",
    }));
  assert.equal(huntStatus("RUNNING", steps({ context: "READY" }), null), "queued");
  assert.equal(
    huntStatus("RUNNING", steps({ context: "COMPLETED", hunt: "RUNNING" }), null),
    "running",
  );
  assert.equal(
    huntStatus("RUNNING", steps({ context: "COMPLETED", verify: "RUNNING" }), null),
    "verifying",
  );
  assert.equal(huntStatus("COMPLETED", steps({}), { partial: false }), "completed");
  assert.equal(huntStatus("COMPLETED", steps({}), { partial: true }), "partial");
  assert.equal(huntStatus("FAILED", steps({}), null), "failed");
  assert.equal(huntStatus("CANCELED", steps({}), null), "canceled");
});
