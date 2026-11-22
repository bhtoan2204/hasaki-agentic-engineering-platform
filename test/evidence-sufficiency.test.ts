/**
 * Evidence sufficiency of the investigation report (P0): `passed` only when the investigation's declared objectives are
 * met by platform-verified evidence — never because the agent declared nothing missing. `incomplete` for insufficient,
 * stale, truncated or unavailable evidence; `failed` for contradictions, fabricated or foreign citations, and asserted
 * conclusions that break the verification contract. Deterministic records; no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceReport } from "../src/agent/evidenceReport.ts";
import type { ProvenanceEnv } from "../src/agent/provenance.ts";

const TRACES = {
  spans: [
    { order_id: "ORD-5", operation: "provider.refund.http", duration_ms: 7200 },
    { order_id: "ORD-17", operation: "provider.refund.http", duration_ms: 6900 },
  ],
};
const LOGS = { events: [{ order_id: "ORD-5", message: "upstream timeout" }] };
const POOL = { events: [{ order_id: "ORD-3", message: "db pool saturated" }] };
type Row = { status: string; finalized: boolean; result: unknown; tool: string };
const rows: Record<string, Row> = {
  "1:1": {
    status: "ok",
    finalized: true,
    result: { result: TRACES },
    tool: "signoz_search_traces",
  },
  "1:2": { status: "ok", finalized: true, result: { result: LOGS }, tool: "splunk_search" },
  "1:3": { status: "ok", finalized: true, result: { result: POOL }, tool: "splunk_search" },
  "1:4": {
    status: "error",
    finalized: true,
    result: { error: "HTTP 503" },
    tool: "signoz_search_traces",
  },
  "1:5": {
    status: "ok",
    finalized: true,
    result: { truncated: true, head: "{" },
    tool: "signoz_search_traces",
  },
};
// Only this run's records resolve (another run's ids are simply absent here, as runProvenanceEnv scopes them).
const env: ProvenanceEnv = {
  repoPath: async () => null,
  currentRef: async () => null,
  toolCall: async () => null,
  artifact: async () => false,
  codeActCall: async (e, s) => rows[`${e}:${s}`] ?? null,
};
const OBJECTIVES = {
  required_sources: ["trace", "log"],
  require_root_cause: true,
  min_verified_facts: 1,
};

const traceFact = {
  id: "F1",
  claim: "gateway.refund spans of ORD-5 spend 7200 ms in provider.refund.http",
  classification: "OBSERVED_FACT",
  source_type: "trace",
  source_ref: "codeact:1:1",
  verification_status: "verified",
  observed: { pointer: "/spans/0/operation", equals: "provider.refund.http" },
};
const logFact = {
  id: "F2",
  claim: "ORD-5 logged an upstream timeout",
  classification: "OBSERVED_FACT",
  source_type: "log",
  source_ref: "codeact:1:2",
  verification_status: "verified",
  observed: { pointer: "/events/0/message", equals: "upstream timeout" },
};
const cause = (supports: string[]) => ({
  id: "R1",
  claim: "The payment provider's refund HTTP call times out",
  classification: "CONFIRMED_ROOT_CAUSE",
  source_type: "trace",
  source_ref: "codeact:1:1",
  verification_status: "verified",
  supports,
});
const confirmed = (supporting: string[]) => ({
  status: "CONFIRMED",
  confidence: "high",
  explanation: "Slow provider spans and timeout logs for the same orders.",
  supporting_claims: supporting,
});
const report = (
  source: Record<string, unknown>,
  objectives: Record<string, unknown> = OBJECTIVES,
) => buildEvidenceReport(source, env, objectives);

test("zero claims, zero evidence, nothing declared missing: incomplete, never passed", async () => {
  const r = await report({ claims: [], missing_evidence: [] });
  assert.equal(r.verification.status, "incomplete");
  assert.ok(r.verification.sufficiency.reasons.some((x) => /no platform-verified fact/.test(x)));
});

test("claims without references are not evidence: incomplete", async () => {
  const r = await report({
    claims: [
      {
        id: "F1",
        claim: "provider is slow",
        classification: "OBSERVED_FACT",
        verification_status: "verified",
      },
    ],
    root_cause_assessment: confirmed(["F1"]),
  });
  assert.notEqual(r.verification.status, "passed");
});

test("a fabricated CodeAct reference fails", async () => {
  const r = await report({ claims: [{ ...traceFact, source_ref: "codeact:999:1" }] });
  assert.equal(r.verification.status, "failed");
  assert.ok(
    r.verification.failures.some((f) => /not a recorded CodeAct call of this run/.test(f.reason)),
  );
});

test("a reference from another run (absent from this run's records) fails", async () => {
  const r = await report({ claims: [traceFact, { ...logFact, source_ref: "codeact:42:2" }] });
  assert.equal(r.verification.status, "failed");
});

test("a required source with no platform-verified fact: incomplete", async () => {
  const r = await report({
    claims: [traceFact, cause(["F1"])],
    root_cause_assessment: confirmed(["F1", "R1"]),
  });
  assert.equal(r.verification.status, "incomplete");
  assert.deepEqual(r.verification.sufficiency.missing_sources, ["log"]);
});

test("a stale or truncated source does not count: incomplete", async () => {
  const r = await report({
    claims: [{ ...traceFact, source_ref: "codeact:1:5" }, logFact, cause(["F1", "F2"])],
    root_cause_assessment: confirmed(["F1", "F2", "R1"]),
  });
  assert.equal(r.verification.status, "incomplete");
  assert.deepEqual(r.verification.sufficiency.missing_sources, ["trace"]);
});

test("contradictory observations fail", async () => {
  const r = await report({
    claims: [{ ...traceFact, observed: { pointer: "/spans", count: 9 } }, logFact],
  });
  assert.equal(r.verification.status, "failed");
});

test("a correct observation does not make an unsupported causal conclusion verified", async () => {
  // The DB-pool warning exists (verified observation), but nothing else supports it as the cause: trace evidence for
  // the causal link is missing, so the confirmation cannot pass.
  const poolFact = {
    id: "F3",
    claim: "refund-worker logged db pool saturated",
    classification: "OBSERVED_FACT",
    source_type: "log",
    source_ref: "codeact:1:3",
    verification_status: "verified",
    observed: { pointer: "/events/0/message", equals: "db pool saturated" },
  };
  const r = await report({
    claims: [
      poolFact,
      {
        ...cause(["F3"]),
        claim: "DB pool saturation causes the refund timeouts",
        source_ref: "codeact:1:3",
      },
    ],
    root_cause_assessment: confirmed(["F3", "R1"]),
  });
  assert.notEqual(r.verification.status, "passed");
  assert.equal(r.verification.sufficiency.root_cause_supported, false);
});

test("partial integration outage: the failed source is missing evidence, not success", async () => {
  const r = await report({
    claims: [{ ...traceFact, source_ref: "codeact:1:4" }, logFact, cause(["F1", "F2"])],
    root_cause_assessment: confirmed(["F1", "F2", "R1"]),
  });
  assert.equal(r.verification.status, "incomplete");
  assert.deepEqual(r.verification.sufficiency.missing_sources, ["trace"]);
});

test("CONFIRMED resting only on agent-vouched facts is a contract violation: failed", async () => {
  const vouched = (id: string, type: string) => ({
    id,
    claim: `${type} shows the provider timing out (${id})`,
    classification: "OBSERVED_FACT",
    source_type: type,
    source_ref: "kibana link the agent pasted",
    verification_status: "verified",
  });
  const r = await report({
    claims: [
      vouched("F1", "trace"),
      vouched("F2", "log"),
      { ...cause(["F1", "F2"]), source_ref: "agent" },
    ],
    root_cause_assessment: confirmed(["F1", "F2", "R1"]),
  });
  assert.equal(r.verification.status, "failed");
  assert.ok(r.verification.failures.some((f) => /CONFIRMED.*platform-verified/.test(f.reason)));
});

test("an unconfirmed root cause does not meet a root-cause objective: incomplete", async () => {
  const r = await report({
    claims: [traceFact, logFact],
    root_cause_assessment: { ...confirmed(["F1", "F2"]), status: "PROBABLE" },
  });
  assert.equal(r.verification.status, "incomplete");
});

test("a valid, sufficiently supported root cause passes", async () => {
  const r = await report({
    claims: [traceFact, logFact, cause(["F1", "F2"])],
    root_cause_assessment: confirmed(["F1", "F2", "R1"]),
  });
  assert.equal(r.verification.status, "passed", JSON.stringify(r.verification));
  assert.deepEqual(r.verification.sufficiency.covered_sources, ["log", "trace"]);
  assert.equal(r.verification.sufficiency.root_cause_supported, true);
});

test("agent-declared missing_evidence: [] is never proof of completeness (default objectives)", async () => {
  const r = await buildEvidenceReport({ claims: [], missing_evidence: [] }, env);
  assert.equal(r.verification.status, "incomplete");
});

test("a stale code location (file changed since the cited commit) does not count as code evidence", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "evidence-stale-"));
  const git = (...a: string[]) =>
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      ...a,
    ])
      .toString()
      .trim();
  git("init", "-q");
  writeFileSync(join(dir, "client.go"), "package provider\n\nfunc Refund() { /* 5s timeout */ }\n");
  git("add", ".");
  git("commit", "-qm", "one");
  const old = git("rev-parse", "HEAD");
  writeFileSync(
    join(dir, "client.go"),
    "package provider\n\nfunc Refund() { /* 30s timeout */ }\n",
  );
  git("commit", "-qam", "two");
  const codeEnv: ProvenanceEnv = {
    ...env,
    repoPath: async () => dir,
    currentRef: async () => "HEAD",
  };
  const codeFact = {
    id: "K1",
    claim: "Refund uses a 5s timeout",
    classification: "CODE_FACT",
    repository: "payments-svc",
    file_path: "client.go",
    line_range: "3-3",
    commit: old,
    verification_status: "verified",
  };
  const r = await buildEvidenceReport(
    {
      claims: [codeFact, traceFact, logFact, cause(["K1", "F1", "F2"])],
      root_cause_assessment: confirmed(["K1", "F1", "F2", "R1"]),
    },
    codeEnv,
    { required_sources: ["code", "trace", "log"] },
  );
  assert.equal(r.verification.status, "incomplete");
  assert.deepEqual(r.verification.sufficiency.missing_sources, ["code"]);
});

test("a fabricated citation fails even when a verified claim with the same text would absorb it on merge", async () => {
  const r = await report({
    claims: [
      { ...traceFact, source_ref: "codeact:999999:1" },
      traceFact,
      logFact,
      cause(["F1", "F2"]),
    ],
    root_cause_assessment: confirmed(["F1", "F2", "R1"]),
  });
  assert.equal(r.verification.status, "failed", JSON.stringify(r.verification));
  assert.ok(r.verification.failures.some((f) => /999999/.test(f.reason)));
});

test("normalization never merges a contradicted citation into a same-text verified claim", async () => {
  const { normalizeInvestigationOutput } = await import("../src/agent/evidence.ts");
  const { withProvenance } = await import("../src/agent/provenance.ts");
  const claims = await withProvenance(
    [{ ...traceFact, source_ref: "codeact:999999:1" }, traceFact],
    env,
  );
  const n = normalizeInvestigationOutput("root_cause", { claims });
  assert.equal(n.claims.length, 2);
  assert.ok(n.claims.some((c) => c.verification_status === "contradicted"));
});
