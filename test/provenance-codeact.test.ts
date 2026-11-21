/** M4: CodeAct references and deterministic `observed` assertions in claim provenance (no database). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkObservation,
  jsonPointer,
  parseCodeActRef,
  verifyClaimProvenance,
  type ProvenanceEnv,
} from "../src/agent/provenance.ts";

const RESULT = { spans: [{ order_id: "ORD-5", operation: "provider.refund.http" }], events: [] };
const env = (
  rows: Record<string, { status: string; finalized: boolean; result: unknown }>,
): ProvenanceEnv => ({
  repoPath: async () => null,
  currentRef: async () => null,
  toolCall: async () => null,
  artifact: async () => false,
  codeActCall: async (e, s) => rows[`${e}:${s}`] ?? null,
});
const recorded = env({
  "7:1": { status: "ok", finalized: true, result: { result: RESULT } },
  "7:2": { status: "error", finalized: true, result: { error: "503" } },
  "8:1": { status: "ok", finalized: false, result: { result: RESULT } },
  "9:1": { status: "ok", finalized: true, result: { truncated: true, head: "{" } },
});
const verify = (claim: Record<string, unknown>) => verifyClaimProvenance(claim, recorded);

test("references and pointers parse strictly", () => {
  assert.deepEqual(parseCodeActRef("codeact:7:1"), { execution: 7, seq: 1 });
  for (const bad of [
    "codeact:7",
    "codeact:x:1",
    "tool_call:7",
    "codeact:7:1:2",
    " codeact:7:1;drop",
  ])
    assert.equal(parseCodeActRef(bad), null, bad);
  assert.equal(jsonPointer(RESULT, "/spans/0/order_id"), "ORD-5");
  assert.equal(jsonPointer(RESULT, "/spans/3/order_id"), undefined);
  assert.equal(jsonPointer({ "a/b": 1 }, "/a~1b"), 1);
});

test("observed assertions: equals, count, includes; mismatches say what the record shows", () => {
  assert.deepEqual(checkObservation(RESULT, { pointer: "/spans", count: 1 }), { ok: true });
  assert.deepEqual(
    checkObservation(RESULT, { pointer: "/spans/0/operation", equals: "provider.refund.http" }),
    {
      ok: true,
    },
  );
  assert.deepEqual(checkObservation(RESULT, { pointer: "/spans/0/order_id", includes: "ORD" }), {
    ok: true,
  });
  const wrong = checkObservation(RESULT, { pointer: "/events", count: 7 });
  assert.equal(wrong.ok, false);
  assert.match((wrong as { reason: string }).reason, /has 0 items at \/events, not 7/);
  assert.equal(checkObservation(RESULT, { pointer: "/nope", equals: 1 }).ok, false);
  assert.equal(
    checkObservation(RESULT, { pointer: "/spans/0", count: 1 }).ok,
    null,
    "not a list: uncheckable",
  );
});

test("a CodeAct citation is verified only for an ok, recorded call of a finalized execution of this run", async () => {
  assert.equal((await verify({ source_ref: "codeact:7:1" })).status, "VERIFIED_BY_PLATFORM");
  assert.equal(
    (await verify({ source_ref: "codeact:7:1", observed: { pointer: "/spans", count: 1 } }))
      .verifies,
    "observation",
  );
  assert.equal(
    (await verify({ source_ref: "codeact:7:1", observed: { pointer: "/spans", count: 2 } })).status,
    "CONTRADICTED",
  );
  assert.equal(
    (await verify({ source_ref: "codeact:6:1" })).status,
    "CONTRADICTED",
    "not a record of this run",
  );
  assert.equal(
    (await verify({ source_ref: "codeact:7:2" })).status,
    "UNVERIFIED",
    "the call failed",
  );
  assert.equal(
    (await verify({ source_ref: "codeact:8:1" })).status,
    "UNVERIFIED",
    "unfinished execution",
  );
  assert.equal(
    (await verify({ source_ref: "codeact:9:1", observed: { pointer: "/x", equals: 1 } })).status,
    "UNVERIFIED",
    "a truncated record cannot confirm an observation",
  );
});
