import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import {
  compactionDecision,
  contextWindowFor,
  nativeCompactionThreshold,
  sessionStateBlock,
} from "../src/context/compaction.ts";
import { entryHashes, planContextDelivery, WORKSPACE_KEY } from "../src/context/delivery.ts";
import { accumulateMetrics, newMetrics } from "../src/agent/metrics.ts";
import type { ContextEntry, ContextPack } from "../src/context/pack.ts";

const withCompaction = (c: typeof config.agent.compaction, fn: () => void) => {
  const saved = config.agent.compaction;
  config.agent.compaction = c;
  try {
    fn();
  } finally {
    config.agent.compaction = saved;
  }
};

test("pressure is the provider-reported occupancy of the last call over the model window; unknown never compacts", () => {
  assert.equal(contextWindowFor("claude", "opus"), 200_000);
  assert.equal(contextWindowFor("claude", "claude-opus-5-5[1m]"), 1_000_000);
  const none = compactionDecision({ provider: "claude", model: "opus", occupancy: null });
  assert.deepEqual([none.compact, none.reason], [false, "occupancy not reported by the provider"]);
  assert.equal(
    compactionDecision({ provider: "claude", model: "opus", occupancy: 100_000 }).compact,
    false,
  );
  const high = compactionDecision({ provider: "claude", model: "opus", occupancy: 130_000 });
  assert.equal(high.compact, true);
  assert.match(high.reason, /context pressure 65% \(130000\/200000 tokens\) ≥ 60%/);
  assert.equal(
    compactionDecision({ provider: "claude", model: "x[1m]", occupancy: 130_000 }).compact,
    false,
    "a 1M window is not under pressure",
  );
  withCompaction({ mode: "off" }, () =>
    assert.equal(compactionDecision({ provider: "claude", occupancy: 199_000 }).compact, false),
  );
  withCompaction({ pressure: 0.4 }, () =>
    assert.equal(compactionDecision({ provider: "claude", occupancy: 90_000 }).compact, true),
  );
});

test("native mode moves the provider's own auto-compaction to the platform threshold; otherwise it is untouched", () => {
  assert.equal(nativeCompactionThreshold("claude", "opus"), null);
  withCompaction({ mode: "native", pressure: 0.6 }, () => {
    assert.deepEqual(nativeCompactionThreshold("claude", "opus"), { percent: 60, tokens: 120_000 });
    assert.deepEqual(nativeCompactionThreshold("codex", "gpt-5"), { percent: 60, tokens: 120_000 });
  });
});

const entry = (id: string, body: string, section: ContextEntry["section"]): ContextEntry => ({
  id,
  section,
  trust: "untrusted_evidence",
  required: true,
  priority: 1,
  body,
  provenance: {} as ContextEntry["provenance"],
});

test("a workspace revision change invalidates code context the session saw: code entries are resent, the rest is not", () => {
  const pack = {
    entries: [entry("request", "r", "requirements"), entry("search_code", "snippets", "code")],
  } as unknown as ContextPack;
  const manifest = {
    system_hash: "s",
    decisions_hash: "d",
    entries: { ...entryHashes(pack), [WORKSPACE_KEY]: "rev-1" },
  };
  const same = planContextDelivery(manifest, {
    pack,
    systemHash: "s",
    decisionsHash: "d",
    workspaceHash: "rev-1",
  });
  assert.deepEqual(same.mode === "delta" && same.send, []);
  const moved = planContextDelivery(manifest, {
    pack,
    systemHash: "s",
    decisionsHash: "d",
    workspaceHash: "rev-2",
  });
  assert.deepEqual(moved.mode === "delta" && [moved.send, moved.unchanged], [
    ["search_code"],
    ["request"],
  ]);
});

test("the reconstruction is platform state, not a model summary: workspace, verification, prior record and raw evidence references", () => {
  const block = sessionStateBlock({
    reason: "context pressure 70%",
    worktree: "### oms-background\nuncommitted:\n M app/shipping/spx.go",
    verification: [
      {
        repo: "oms-background",
        status: "failed",
        excerpt: "--- FAIL: TestPhone (0.01s)\n    spx_test.go:42: want +84",
      },
    ],
    continuity: {
      outcome: "waiting_input",
      unfinished: { questions: [{ id: 3, question: "Which topic?" }] },
    },
    artifacts: [{ id: 77, name: "verify-1-oms-background.log" }],
    previousAttemptId: 12,
  });
  assert.match(block, /Session compacted \(context pressure 70%\)/);
  assert.match(block, /nothing here is a model summary/);
  assert.match(
    block,
    /Requirements, business invariants, developer decisions, approved scope and rules are in the context pack above, verbatim/,
  );
  assert.match(block, /M app\/shipping\/spx\.go/);
  assert.match(
    block,
    /spx_test\.go:42: want \+84/,
    "the failing evidence and its source location survive",
  );
  assert.match(block, /Which topic\?/);
  assert.match(block, /artifact 77: verify-1-oms-background\.log/);
  assert.match(block, /run\.step_history \(attempt 12\)/);
});

test("occupancy comes from the main session's per-call usage (not cumulative totals, not subagents); provider compactions are recorded", () => {
  const m = newMetrics("opus");
  const call = (
    id: string,
    input: number,
    read: number,
    write: number,
    parent: string | null = null,
  ) =>
    accumulateMetrics(m, {
      type: "assistant",
      parent_tool_use_id: parent,
      message: {
        id,
        content: [],
        usage: {
          input_tokens: input,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: write,
        },
      },
    });
  call("a", 10, 50_000, 5_000);
  call("b", 12, 80_000, 2_000);
  call("sub", 5, 190_000, 0, "toolu_1");
  call("c", 8, 60_000, 0);
  assert.deepEqual(m.context_window, { last_tokens: 60_008, peak_tokens: 82_012 });
  accumulateMetrics(m, {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 160_000 },
  });
  assert.deepEqual(m.compactions, [
    { boundary: "native:auto", pressure: null, occupancy: 160_000, window: 0 },
  ]);
});
