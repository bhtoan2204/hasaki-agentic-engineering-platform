import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateMetrics,
  firstUsefulLocationMs,
  newMetrics,
  noteToolUse,
} from "../src/agent/metrics.ts";
import { codeRetrievalKey, roleBudget } from "../src/context/pack.ts";
import { evidenceSummary } from "../src/agent/evidence.ts";
import { codexEnabledTools } from "../src/agent/codex/run.ts";
import { CONTEXT_TOOLS } from "../src/agent/contextToolSchemas.ts";
import { eligibleText } from "../src/codeIntelligence/search.ts";

test("measurement: duplicate tool calls, repeated file reads and time to the first useful location come from tool_use events", () => {
  const m = newMetrics("model");
  const read = (file_path: string, offset?: number) => ({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path, ...(offset ? { offset } : {}) } },
      ],
    },
  });
  accumulateMetrics(m, read("/wt/oms-api/app/util.go"));
  accumulateMetrics(m, read("/wt/oms-api/app/util.go")); // exact duplicate
  accumulateMetrics(m, read("/wt/oms-api/app/util.go", 40)); // same file, other range: a re-read, not a duplicate call
  accumulateMetrics(m, {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Grep", input: { pattern: "x", path: "a" } },
        { type: "tool_use", name: "Grep", input: { path: "a", pattern: "x" } },
      ],
    },
  });
  assert.deepEqual(
    m.tool_repeats,
    { calls: 5, duplicate_calls: 2, file_reads: 3, repeated_file_reads: 2, distinct_files_read: 1 },
    "key order does not hide a duplicate",
  );
  const t = newMetrics("model");
  noteToolUse(t, "Read", { file_path: "/wt/oms-api/app/util.go" }, 1000);
  noteToolUse(t, "Read", { file_path: "/wt/oms-api/app/refund.go" }, 4500);
  noteToolUse(t, "Edit", { file_path: "/wt/oms-api/app/refund.go" }, 9000);
  assert.equal(
    firstUsefulLocationMs(t, ["app/refund.go"]),
    3500,
    "first touch of a file the step finally changed",
  );
  assert.equal(firstUsefulLocationMs(t, ["app/other.go"]), null, "unknown is null, never 0");
  assert.equal(firstUsefulLocationMs(newMetrics("m"), ["app/refund.go"]), null);
});

test("adaptive budgets: sized by role, explicit config wins (handled by the caller), unknown roles keep the global default", () => {
  assert.equal(roleBudget({ type: "agent", config: { independent: true } }), 16000);
  assert.equal(roleBudget({ type: "coding_agent", config: {} }), 20000);
  assert.equal(roleBudget({ type: "agent", config: { evidence: { role: "analysis" } } }), 16000);
  assert.equal(
    roleBudget({ type: "agent", config: { evidence: { role: "fix_proposal" } } }),
    20000,
  );
  assert.equal(roleBudget({ type: "agent", config: { evidence: { role: "root_cause" } } }), null);
  assert.equal(roleBudget({ type: "agent", config: {} }), null);
});

test("context cache key: shared across steps of a run, deterministic, and changes with owner, authorization, query, repository state or index version", () => {
  const base = {
    ownerId: 1,
    runId: 2,
    allowed: ["b", "a"],
    query: "refund",
    repos: { a: "fp1:tip1", b: "fp2:tip2" },
    indexVersion: "v1",
  };
  const k = codeRetrievalKey(base);
  assert.equal(
    codeRetrievalKey({ ...base, allowed: ["a", "b"], repos: { b: "fp2:tip2", a: "fp1:tip1" } }),
    k,
    "order-insensitive",
  );
  for (const change of [
    { ownerId: 9 },
    { allowed: ["a"] },
    { query: "refunds" },
    { repos: { a: "fp1-dirty:tip1", b: "fp2:tip2" } },
    { repos: { a: "fp1:tip-moved", b: "fp2:tip2" } },
    { indexVersion: "v2" },
    { runId: 3 },
  ])
    assert.notEqual(codeRetrievalKey({ ...base, ...change }), k, JSON.stringify(change));
});

test("dedup never drops high-risk items: contradicted evidence and unresolved scope violations survive the per-list cap", () => {
  const claims = Array.from({ length: 20 }, (_, i) => ({
    id: `U${i}`,
    claim: `unverified observation number ${i}`,
    classification: "CODE_FACT",
    repository: "svc",
    file_path: `f${i}.go`,
  }));
  claims.push({
    id: "X",
    claim: "refund status is written twice",
    classification: "CODE_FACT",
    repository: "svc",
    file_path: "x.go",
    commit: "abc1234",
    verification_status: "contradicted",
  } as any);
  const s = evidenceSummary({
    root_cause: { status: "COMPLETED", output: { claims } },
    implement: {
      status: "WAITING_INPUT",
      output: {
        scope_check: {
          requires_reapproval: true,
          reapproved: null,
          reasons: ["svc:app/ledger.go is outside the approved scope"],
        },
      },
    },
  })!;
  assert.match(
    s.unverified_or_contradicted[0],
    /^\[CONTRADICTED\] refund status is written twice/,
    "high-risk first, despite arriving last",
  );
  assert.ok(s.unverified_or_contradicted.length <= 13);
  assert.deepEqual((s as any).unresolved_scope_violations, [
    "implement: svc:app/ledger.go is outside the approved scope",
  ]);
  assert.ok((s as any).truncated_items > 0, "ordinary overflow is still reported");
});

test("code intelligence first: Codex may call the native index tools; exact search never reads secret files", () => {
  for (const mode of ["coding", "analysis"] as const)
    for (const t of ["search_code", "get_symbol", "find_dependencies", "get_step_output"])
      assert.ok(codexEnabledTools(mode).includes(t), `${mode}: ${t}`);
  assert.ok(CONTEXT_TOOLS.every((t) => codexEnabledTools("coding").includes(t.name)));
  assert.ok(!codexEnabledTools("analysis").includes("commit_changes"));
  for (const p of ["app.yaml", "config/payment.toml", "logs/app.log", "README.md"])
    assert.ok(eligibleText(p), p);
  for (const p of [
    ".env",
    "deploy/.env.production",
    "certs/server.pem",
    "keys/id_rsa",
    "config/secrets.yaml",
    "node_modules/x/a.js",
    ".git/config",
  ])
    assert.ok(!eligibleText(p), p);
});
