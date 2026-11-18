import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkpointView,
  latestRecoverable,
  type CheckpointRowInput,
} from "../src/workflow/checkpointView.ts";

const envelope = (attempt: number, generation: number) => ({
  version: 1,
  milestone: "executor_returned",
  binding: { attempt_id: attempt, generation, snapshot_id: 7, context_hash: "ctx-hash" },
  workspace_fingerprint: "fp-1",
  workspace_unavailable: false,
  workspace_artifact_id: 99,
  verification: { digest: "ver-digest", artifact_ids: [5] },
  completed_actions: ["submit_result"],
});
const row = (over: Partial<CheckpointRowInput>): CheckpointRowInput => ({
  id: 1,
  attempt_id: 10,
  reason: "executor_returned",
  data: {},
  execution: envelope(10, 2),
  created_at: "2026-11-18T03:00:00Z",
  ...over,
});
const ctx = (over: Partial<Parameters<typeof checkpointView>[1]> = {}) => ({
  stepGeneration: 2,
  attempts: [{ id: 10, generation: 2, metrics: { verification: { passed: true } } }],
  artifacts: [{ id: 99, size: "2048" }],
  reconciledAt: [],
  ...over,
});

test("progress notes are notes, never recoverable checkpoints", () => {
  for (const reason of ["progress", "submit_result", "skill_read", "profile_transition"]) {
    const v = checkpointView(row({ reason, data: { note: "halfway" }, execution: null }), ctx());
    assert.equal(v.kind, "note", reason);
    assert.equal(v.compatibility, null);
    assert.equal(v.evidence, null);
  }
  assert.equal(
    checkpointView(row({ reason: "progress", data: { note: "halfway" } }), ctx()).note,
    "halfway",
  );
});

test("a recoverable checkpoint shows its workspace, context and verification evidence", () => {
  const v = checkpointView(row({}), ctx());
  assert.equal(v.kind, "recoverable");
  assert.equal(v.compatibility, "compatible");
  assert.deepEqual(v.evidence?.workspace, {
    fingerprint: "fp-1",
    unavailable: false,
    artifact_id: 99,
    bytes: 2048,
  });
  assert.deepEqual(v.evidence?.context, { snapshot_id: 7, context_hash: "ctx-hash" });
  assert.deepEqual(v.evidence?.verification, {
    digest: "ver-digest",
    artifact_ids: [5],
    passed: true,
  });
  assert.ok(!("result" in (v as object)));
});

test("compatibility: legacy, invalidated, stale generation, workspace drift and unknown attempt", () => {
  assert.equal(
    checkpointView(row({ reason: "waiting_input", execution: null }), ctx()).compatibility,
    "legacy",
  );
  assert.equal(
    checkpointView(
      row({}),
      ctx({ attempts: [{ id: 10, generation: 2, invalidated_at: "2026-11-18" }] }),
    ).compatibility,
    "invalidated",
  );
  assert.equal(
    checkpointView(row({ execution: envelope(10, 1) }), ctx()).compatibility,
    "stale_generation",
  );
  assert.equal(
    checkpointView(row({}), ctx({ reconciledAt: [{ created_at: "2026-11-18T03:05:00Z" }] }))
      .compatibility,
    "workspace_changed",
  );
  assert.equal(
    checkpointView(row({}), ctx({ reconciledAt: [{ created_at: "2026-11-18T02:00:00Z" }] }))
      .compatibility,
    "compatible",
    "a reconcile before the checkpoint does not affect it",
  );
  assert.equal(checkpointView(row({ attempt_id: 404 }), ctx()).compatibility, "unknown");
});

test("the latest recoverable checkpoint skips notes and outdated generations", () => {
  const views = [
    checkpointView(row({ id: 1 }), ctx()),
    checkpointView(row({ id: 2, reason: "progress", execution: null }), ctx()),
    checkpointView(row({ id: 3, execution: envelope(10, 1) }), ctx()),
  ];
  assert.equal(latestRecoverable(views)?.id, 1);
  assert.equal(latestRecoverable([views[1]]), null);
});
