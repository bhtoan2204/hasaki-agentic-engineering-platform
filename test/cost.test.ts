import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetLine, parseBudget, summarize, wasteReason, type AttemptCostRow } from "../src/report/cost.ts";

const row = (o: Partial<AttemptCostRow>): AttemptCostRow => ({
  attempt_id: 1, run_id: 1, step_key: "s", step_name: "S", status: "COMPLETED", run_status: "COMPLETED", current_attempt_id: 1,
  provider: "claude", model: "m", cost: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, ...o,
});

test("wasteReason: failed/canceled/stale, superseded completions, failed runs only at work-item level", () => {
  assert.equal(wasteReason(row({ status: "FAILED" })), "failed");
  assert.equal(wasteReason(row({ status: "STALE" })), "stale");
  assert.equal(wasteReason(row({ attempt_id: 1, current_attempt_id: 2 })), "superseded");
  assert.equal(wasteReason(row({})), null);
  assert.equal(wasteReason(row({ status: "RUNNING", current_attempt_id: 9 })), null, "in-flight work is not waste");
  assert.equal(wasteReason(row({ run_status: "FAILED" })), null);
  assert.equal(wasteReason(row({ run_status: "FAILED" }), true), "failed_run");
});

test("summarize: unknown cost stays null; partial availability when some agent attempts reported none", () => {
  assert.equal(summarize([]).availability, "none");
  const unknown = summarize([row({ cost: null, input_tokens: 10 })]);
  assert.equal(unknown.total.cost_usd, null);
  assert.equal(unknown.availability, "unavailable");
  assert.equal(unknown.wasted.pct, null);
  const partial = summarize([row({ cost: 0.5 }), row({ attempt_id: 2, current_attempt_id: 2, cost: null, provider: "codex" })]);
  assert.equal(partial.total.cost_usd, 0.5);
  assert.equal(partial.availability, "partial");
  assert.equal(partial.total.attempts_without_cost, 1);
  const cmd = summarize([row({ provider: null, model: null, cost: null })]);
  assert.equal(cmd.availability, "none", "a command step is not an agent attempt without cost");
  assert.equal(cmd.by_model.length, 0);
});

test("budgetLine thresholds and parseBudget validation", () => {
  assert.equal(budgetLine(null, null, 3).status, "none");
  assert.equal(budgetLine(10, "own", 7.9, 0.8).status, "ok");
  assert.equal(budgetLine(10, "own", 8, 0.8).status, "warning");
  assert.deepEqual(budgetLine(10, "default", 12.5, 0.8), { limit_usd: 10, source: "default", used_usd: 12.5, pct: 125, status: "exceeded" });
  assert.equal(parseBudget(null), null);
  assert.equal(parseBudget(""), null);
  assert.equal(parseBudget("2.555"), 2.56);
  assert.throws(() => parseBudget(0));
  assert.throws(() => parseBudget("abc"));
});
