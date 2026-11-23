import { test } from "node:test";
import assert from "node:assert/strict";
import { symptomFixSignals } from "../src/agent/rootCause.ts";
import { testWeakeningSignals } from "../src/agent/verify.ts";
import { buildFixProof, type FixProofInput } from "../src/agent/proofOfFix.ts";

// ---------------------------------------------------------------- labelled diff fixtures

const diff = (file: string, removed: string[], added: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,${removed.length} +10,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

/** Each fixture names the signal kinds a reviewer should see (empty: a legitimate root-cause change). */
const SYMPTOM_FIXTURES: Array<{ name: string; diff: string; expect: string[] }> = [
  {
    name: "ERROR downgraded to WARN",
    diff: diff(
      "pay/refund.go",
      ['\tlog.Error("refund failed", err)'],
      ['\tlog.Warn("refund failed", err)'],
    ),
    expect: ["log_downgrade"],
  },
  {
    name: "JS empty catch",
    diff: diff(
      "oms/ship.ts",
      ["  await publish(evt);"],
      ["  try { await publish(evt); } catch (e) {}"],
    ),
    expect: ["error_swallowed"],
  },
  {
    name: "promise catch returning null",
    diff: diff(
      "oms/order.ts",
      ["  const r = await load(id);"],
      ["  const r = await load(id).catch(() => null);"],
    ),
    expect: ["error_swallowed"],
  },
  {
    name: "python except pass",
    diff: diff(
      "svc/sync.py",
      ["    push(row)"],
      ["    try:", "        push(row)", "    except Exception:", "        pass"],
    ),
    expect: ["error_swallowed"],
  },
  {
    name: "go error dropped",
    diff: diff(
      "svc/store.go",
      ["\tif err != nil {", "\t\treturn err", "\t}"],
      ["\tif err != nil {", "\t\treturn nil", "\t}"],
    ),
    expect: ["error_swallowed"],
  },
  {
    name: "retry wrapper added",
    diff: diff(
      "pay/client.ts",
      ["  return http.post(url, body);"],
      ["  return withRetry(() => http.post(url, body), { retries: 5 });"],
    ),
    expect: ["retry_added"],
  },
  {
    name: "timeout increased",
    diff: diff(
      "pay/client.go",
      ["\tclient := &http.Client{Timeout: 5 * time.Second}"],
      ["\tclient := &http.Client{Timeout: 60 * time.Second}"],
    ),
    expect: ["limit_raised"],
  },
  {
    name: "validation removed",
    diff: diff(
      "oms/state.ts",
      ["  if (!isValidTransition(from, to)) throw new Error('invalid');", "  order.state = to;"],
      ["  order.state = to;"],
    ),
    expect: ["check_removed"],
  },
  // ---- legitimate changes: nothing to flag
  {
    name: "real fix: nil map initialised",
    diff: diff("svc/cache.go", ["\tvar m map[string]int"], ["\tm := make(map[string]int)"]),
    expect: [],
  },
  {
    name: "real fix: error now propagated",
    diff: diff(
      "svc/store.go",
      ["\t_ = save(ctx, row)"],
      ["\tif err := save(ctx, row); err != nil {", '\t\treturn fmt.Errorf("save: %w", err)', "\t}"],
    ),
    expect: [],
  },
  {
    name: "real fix: off-by-one",
    diff: diff(
      "oms/page.ts",
      ["  for (let i = 0; i <= items.length; i++) {"],
      ["  for (let i = 0; i < items.length; i++) {"],
    ),
    expect: [],
  },
  {
    name: "real fix: validation added",
    diff: diff(
      "pay/amount.ts",
      ["  return charge(amount);"],
      [
        "  if (amount <= 0) throw new RangeError('amount must be positive');",
        "  return charge(amount);",
      ],
    ),
    expect: [],
  },
  {
    name: "catch that rethrows with context",
    diff: diff(
      "oms/ship.ts",
      ["  await publish(evt);"],
      [
        "  try {",
        "    await publish(evt);",
        "  } catch (e) {",
        "    throw new ShipmentError('publish failed', { cause: e });",
        "  }",
      ],
    ),
    expect: [],
  },
  // Ordinary code that only looks like a symptom fix.
  {
    name: "a retryable flag is not a retry",
    diff: diff(
      "pay/err.ts",
      ["  return err;"],
      ["  const retryable = isTransient(err);", "  return { err, retryable };"],
    ),
    expect: [],
  },
  {
    name: "a retries config field alone is not a retry",
    diff: diff(
      "pay/config.ts",
      ["  timeoutMs: 5000,"],
      ["  timeoutMs: 5000,", "  maxRetriesLogged: 3,"],
    ),
    expect: [],
  },
  {
    name: "cleanup of a specific expected exception",
    diff: diff(
      "svc/clean.py",
      ["    os.remove(tmp)"],
      ["    try:", "        os.remove(tmp)", "    except FileNotFoundError:", "        pass"],
    ),
    expect: [],
  },
  {
    name: "existing retry count unchanged, code around it refactored",
    diff: diff(
      "pay/client.ts",
      ["  return withRetry(() => post(url, body), { retries: 3 });"],
      ["  return withRetry(() => post(url, payload(body)), { retries: 3 });"],
    ),
    expect: [],
  },
];

test("symptom-fix detection: precision/recall on labelled fixtures (regression baseline)", () => {
  let tp = 0,
    fp = 0,
    fn = 0;
  const misses: string[] = [];
  for (const f of SYMPTOM_FIXTURES) {
    const got = new Set<string>(symptomFixSignals(f.diff).map((s) => s.kind));
    for (const k of f.expect)
      if (got.has(k)) tp++;
      else {
        fn++;
        misses.push(`FN ${f.name}: ${k}`);
      }
    for (const k of got)
      if (!f.expect.includes(k)) {
        fp++;
        misses.push(`FP ${f.name}: ${k}`);
      }
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  console.log(
    `symptom-fix signals: precision ${precision.toFixed(2)} recall ${recall.toFixed(2)} (tp ${tp}, fp ${fp}, fn ${fn})`,
  );
  assert.deepEqual(misses, [], "every fixture classified as labelled");
  assert.equal(precision, 1);
  assert.equal(recall, 1);
});

test("test weakening in JS/TS, Python and Java: hard (blocks), soft (human review) or nothing", () => {
  type Level = "hard" | "soft" | "none";
  const cases: Array<[string, string, Level]> = [
    [
      "js skip",
      diff("a/order.test.ts", ["  it('ships', () => {"], ["  it.skip('ships', () => {"]),
      "hard",
    ],
    ["js only", diff("a/order.spec.js", ["  test('a', f)"], ["  test.only('a', f)"]), "hard"],
    ["js xit", diff("a/__tests__/x.test.js", ["  it('a', f)"], ["  xit('a', f)"]), "hard"],
    [
      "pytest skip",
      diff(
        "svc/test_sync.py",
        ["def test_push():"],
        ["@pytest.mark.skip(reason='flaky')", "def test_push():"],
      ),
      "hard",
    ],
    [
      "junit disabled",
      diff("src/OrderServiceTest.java", ["  @Test"], ["  @Disabled", "  @Test"]),
      "hard",
    ],
    // Removed or renamed tests: still caught (no VERIFIED), but a human judges them — renames are legitimate.
    [
      "js removed test",
      diff(
        "a/pay.test.ts",
        ["  it('refunds twice', async () => {", "    expect(x).toBe(1);", "  });"],
        [],
      ),
      "soft",
    ],
    [
      "python removed",
      diff("svc/test_sync.py", ["def test_push():", "    assert push() == 1"], []),
      "soft",
    ],
    [
      "js renamed test",
      diff("a/add.test.ts", ["  it('adds', () => {"], ["  it('adds two numbers', () => {"]),
      "soft",
    ],
    [
      "conditional skipif",
      diff(
        "svc/test_os.py",
        [],
        ["@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')"],
      ),
      "soft",
    ],
    // Not weakening at all.
    [
      "legit new test",
      diff(
        "a/order.test.ts",
        [],
        ["  it('rejects negative amounts', () => {", "    expect(() => f(-1)).toThrow();", "  });"],
      ),
      "none",
    ],
    [
      "legit edit keeps test",
      diff(
        "a/order.test.ts",
        ["  it('ships', () => {"],
        ["  it('ships', () => {", "    // arrange"],
      ),
      "none",
    ],
    [
      "test moved to another file",
      [
        diff("a/old.test.ts", ["  it('ships', () => {"], []),
        diff("a/new.test.ts", [], ["  it('ships', () => {"]),
      ].join("\n"),
      "none",
    ],
    [
      "vendored test skipped",
      diff("vendor/lib/foo.test.js", ["  describe('x', f)"], ["  describe.skip('x', f)"]),
      "none",
    ],
    [
      "non-code file named .test.md",
      diff("docs/guide.test.md", [], ["it.skip('example')"]),
      "none",
    ],
  ];
  for (const [name, d, level] of cases) {
    const r = testWeakeningSignals(d);
    const got: Level = r.hard.length ? "hard" : r.soft.length ? "soft" : "none";
    assert.equal(got, level, `${name}: ${JSON.stringify(r)}`);
  }
});

// ---------------------------------------------------------------- verdicts

const verifiedClaim = {
  id: "c1",
  claim: "refund handler reads the stale balance before commit",
  classification: "CODE_FACT",
  source_type: "code",
  source_ref: "payment-src@abc",
  repository: "payment-src",
  commit: "abc",
  file_path: "refund.go",
  line_range: "40-52",
  confidence: "high",
  verification_status: "verified",
  provenance: {
    by: "platform",
    status: "VERIFIED_BY_PLATFORM",
    verifies: "location",
    reason: null,
  },
};
const rootCause = (over: Record<string, unknown> = {}) => ({
  root_cause: "stale balance read",
  root_cause_assessment: {
    status: "CONFIRMED",
    confidence: "high",
    explanation: "read before commit",
    supporting_claims: ["c1"],
  },
  claims: [verifiedClaim],
  ...over,
});
const implement = (over: Record<string, unknown> = {}) => ({
  verification: {
    passed: true,
    needs_review: false,
    review_reasons: [],
    last: [{ repo: "payment-src", weakened: [] }],
  },
  tested_heads: { "payment-src": "head1" },
  regression_proof: {
    status: "verified",
    reason: "fails before, passes after",
    repo: "payment-src",
    test_id: "TestRefundTwice",
    head_sha: "head1",
  },
  remediation: {
    kind: "ROOT_CAUSE_FIX",
    root_cause: "stale read",
    causal_link: "read inside tx",
    justifications: [],
    risks: [],
    follow_ups: [],
  },
  symptom_signals: {},
  ...over,
});
const input = (
  over: Partial<FixProofInput> & {
    rc?: object;
    impl?: object;
    test?: object;
    review?: object;
  } = {},
): FixProofInput => ({
  upstream: {
    root_cause: { output: over.rc ?? rootCause() },
    implement: { output: over.impl ?? implement() },
    regression_test: { output: over.test ?? { passed: true } },
    review: {
      output: over.review ?? { verdict: "PASS", root_cause_check: { addresses_root_cause: true } },
    },
  },
  rootCauseFrom: "root_cause",
  implementFrom: "implement",
  testFrom: "regression_test",
  reviewFrom: "review",
  reviewIndependent: true,
  incident: { title: "Refund paid twice" },
  ...over,
});

test("verdict: complete platform evidence is VERIFIED, with traceable evidence references", () => {
  const r = buildFixProof(input());
  assert.equal(r.verdict, "VERIFIED", r.missing.join("; "));
  assert.equal(r.root_cause.platform_verified, 1);
  assert.equal(r.root_cause.supporting[0].location, "refund.go:40-52");
  assert.equal(r.reproduction.method, "platform_before_after");
});

test("verdict: an LLM explanation alone (agent-reported evidence) can never be VERIFIED", () => {
  const llmOnly = {
    ...verifiedClaim,
    provenance: { by: "platform", status: "AGENT_REPORTED", verifies: null, reason: "no record" },
  };
  const r = buildFixProof(input({ rc: rootCause({ claims: [llmOnly] }) }));
  assert.notEqual(r.verdict, "VERIFIED");
  assert.match(r.missing.join(), /no platform-verified evidence/);
  const noClaims = buildFixProof(input({ rc: rootCause({ claims: [] }) }));
  assert.notEqual(noClaims.verdict, "VERIFIED");
});

test("verdict: unjustified symptom-fix signals keep a fix below VERIFIED; a justification lifts it", () => {
  const sig = { kind: "retry_added", file: "client.ts", line: 12, detail: "retry added" };
  const flagged = buildFixProof(
    input({ impl: implement({ symptom_signals: { "payment-src": [sig] } }) }),
  );
  assert.equal(flagged.verdict, "PARTIAL");
  assert.match(flagged.missing.join(), /unjustified symptom-fix signal.*retry_added client.ts:12/);
  const justified = buildFixProof(
    input({
      impl: implement({ symptom_signals: { "payment-src": [sig] } }),
      review: {
        verdict: "PASS",
        root_cause_check: {
          justified_signals: [
            {
              signal: "retry_added client.ts:12",
              justification: "provider 503 is transient (trace 9f1)",
            },
          ],
        },
      },
    }),
  );
  assert.equal(justified.verdict, "VERIFIED");
});

test("verdict: failing or weakened tests are FAILED, never silently ignored", () => {
  assert.equal(
    buildFixProof(input({ impl: implement({ verification: { passed: false } }) })).verdict,
    "FAILED",
  );
  assert.equal(buildFixProof(input({ test: { passed: false } })).verdict, "FAILED");
  assert.equal(
    buildFixProof(
      input({
        impl: implement({
          verification: { passed: true, last: [{ weakened: ["a.test.ts: test skipped (.skip)"] }] },
        }),
      }),
    ).verdict,
    "FAILED",
  );
  assert.equal(buildFixProof(input({ review: { verdict: "FAIL" } })).verdict, "FAILED");
  assert.equal(
    buildFixProof(
      input({
        impl: implement({
          regression_proof: {
            status: "invalid",
            reason: "passes before the fix",
            repo: "payment-src",
            head_sha: "head1",
          },
        }),
      }),
    ).verdict,
    "FAILED",
  );
  // A human accepting a failure is not a pass: PARTIAL, with the decision recorded as a residual risk.
  const accepted = buildFixProof(
    input({
      test: { passed: false, decision: { action: "continue", reason: "pre-existing flake" } },
    }),
  );
  assert.equal(accepted.verdict, "PARTIAL");
  assert.ok(accepted.residual_risks.some((r) => /decision/.test(r)));
});

test("verdict: missing reproduction, a non-independent reviewer or a mitigation are PARTIAL", () => {
  const unmeasured = buildFixProof(
    input({
      impl: implement({
        regression_proof: null,
        remediation: {
          kind: "ROOT_CAUSE_FIX",
          root_cause: "x",
          causal_link: "y",
          regression_test: { name: "TestX", passes_after: true },
          verification_limitations: "needs a live provider",
        },
      }),
    }),
  );
  assert.equal(unmeasured.verdict, "PARTIAL");
  assert.equal(unmeasured.reproduction.method, "author_reported");
  assert.equal(buildFixProof(input({ reviewIndependent: false })).verdict, "PARTIAL");
  assert.equal(
    buildFixProof(input({ impl: implement({ remediation: { kind: "MITIGATION" } }) })).verdict,
    "PARTIAL",
  );
  // Stale proof (measured on another commit than the tested one).
  const stale = buildFixProof(
    input({ impl: implement({ tested_heads: { "payment-src": "head2" } }) }),
  );
  assert.equal(stale.verdict, "PARTIAL");
  assert.match(stale.missing.join(), /stale/);
});

test("verdict: no established root cause and no demonstrated fix is INCONCLUSIVE", () => {
  const r = buildFixProof(
    input({
      rc: rootCause({
        root_cause_assessment: { status: "INSUFFICIENT_EVIDENCE", explanation: "" },
        claims: [],
      }),
      impl: implement({ verification: { passed: null }, regression_proof: null }),
    }),
  );
  assert.equal(r.verdict, "INCONCLUSIVE");
});

test("diagnosis mode (read-only investigation): verdict from root cause and evidence verification", () => {
  const base = {
    rootCauseFrom: "investigate",
    reportFrom: "report",
    incident: { title: "Latency spike" },
  };
  const ok = buildFixProof({
    ...base,
    upstream: {
      investigate: { output: rootCause() },
      report: { output: { verification: { status: "passed" } } },
    },
  });
  assert.equal(ok.mode, "diagnosis");
  assert.equal(ok.verdict, "VERIFIED");
  const contradicted = buildFixProof({
    ...base,
    upstream: {
      investigate: { output: rootCause() },
      report: { output: { verification: { status: "failed" } } },
    },
  });
  assert.equal(contradicted.verdict, "FAILED");
  const probable = buildFixProof({
    ...base,
    upstream: {
      investigate: {
        output: rootCause({ root_cause_assessment: { status: "PROBABLE", explanation: "x" } }),
      },
      report: { output: { verification: { status: "incomplete" } } },
    },
  });
  assert.equal(probable.verdict, "PARTIAL");
});

test("forged platform evidence: a proof without platform provenance never yields VERIFIED", () => {
  const forged = buildFixProof(
    input({ impl: implement({ regression_proof: { status: "verified", reason: "trust me" } }) }),
  );
  assert.notEqual(forged.verdict, "VERIFIED");
  assert.match(forged.missing.join(), /no platform provenance/);
});

test("the harness drops platform-only keys from an implementer's submission", async () => {
  const { withoutPlatformEvidence } = await import("../src/agent/harness/stages/verify.ts");
  const out = withoutPlatformEvidence({
    summary: "fixed",
    remediation: { kind: "ROOT_CAUSE_FIX" },
    regression_proof: { status: "verified", repo: "payment-src", head_sha: "h1" },
    tested_heads: { "payment-src": "h1" },
    symptom_signals: {},
    verification: { passed: true },
  });
  assert.deepEqual(Object.keys(out).sort(), ["remediation", "summary"]);
});

test("soft verification notes keep a fix below VERIFIED without failing it; the reviewer's kind and justifications rule", () => {
  const soft = buildFixProof(
    input({
      impl: implement({
        verification: {
          passed: true,
          needs_review: true,
          review_reasons: ["a.test.ts: 3 assertion line(s) removed"],
          last: [{ weakened: [] }],
        },
      }),
    }),
  );
  assert.equal(soft.verdict, "PARTIAL");
  assert.match(soft.missing.join(), /needs human review/);
  const downgraded = buildFixProof(
    input({ review: { verdict: "PASS", remediation_kind: "PARTIAL_FIX" } }),
  );
  assert.equal(downgraded.verdict, "PARTIAL");
  assert.equal(downgraded.change.remediation_kind, "PARTIAL_FIX");
  const sig = { kind: "retry_added", file: "client.ts", line: 12, detail: "retry added" };
  const selfJustified = buildFixProof(
    input({
      impl: implement({
        symptom_signals: { "payment-src": [sig] },
        remediation: {
          kind: "ROOT_CAUSE_FIX",
          root_cause: "x",
          causal_link: "y",
          justifications: [{ signal: "retry_added client.ts:12", reason: "trust me" }],
        },
      }),
    }),
  );
  assert.equal(
    selfJustified.verdict,
    "PARTIAL",
    "only the independent reviewer can accept a symptom signal",
  );
});
