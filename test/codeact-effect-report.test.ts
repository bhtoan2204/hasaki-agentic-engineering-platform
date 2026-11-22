/**
 * CodeAct evaluation report (pure summarization of samples): model identity checks for a controlled A/B comparison,
 * SDK calls vs model turns, cache-inclusive token totals and unknowns that stay unknown. Deterministic samples.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, renderMarkdown, type Sample } from "../src/eval/codeactEffect.ts";

const recovery = {
  execution_failures: 0,
  recovery_attempts: 0,
  recovered: 0,
  recovery_failed: 0,
  fallback_direct: 0,
  abandoned: 0,
  unknown: 0,
  nested_failures_in_ok_executions: 0,
  episodes: [],
};
function sample(o: Partial<Sample>): Sample {
  return {
    task_id: "T03",
    category: "c",
    eligible: true,
    variant: "direct",
    repetition: 0,
    provider: "claude",
    model: null,
    requested_model: "opus",
    effort: "medium",
    provider_models: ["claude-opus-5-5-20261101"],
    model_resolution: "provider_reported",
    codeact_offered: false,
    turn_status: "completed",
    correct: true,
    answered: true,
    unsupported: 0,
    fields: {},
    sdk_calls: 1,
    model_turns: 4,
    provider_tool_uses: 3,
    tool_calls: 3,
    integration_calls: 3,
    codeact_executions: 0,
    codeact_failed: 0,
    nested_calls: 0,
    nested_failures: 0,
    codeact_failures: [],
    recovery,
    composed_tools: [],
    prompt_chars_total: 100,
    prompt_chars_max: 100,
    estimated_prompt_tokens: 25,
    tool_result_chars: 10,
    truncated_results: 0,
    input_tokens: 10,
    output_tokens: 100,
    cache_read_tokens: 1000,
    cache_creation_tokens: 200,
    input_tokens_total: 1210,
    cost_usd: 0.1,
    provider_ms: 1000,
    sandbox_ms: 0,
    latency_ms: 2000,
    evidence_complete: null,
    ...o,
  };
}
const meta = {
  level: "live-provider" as const,
  sandbox: "os-sandbox" as const,
  provider: "claude",
  model: "opus",
};

test("model-matched pairs: same provider-reported model in both variants", () => {
  const r = summarize(
    [sample({}), sample({ variant: "codeact", codeact_offered: true, model_turns: 3 })],
    meta,
  );
  assert.equal(r.model_check.status, "matched");
  assert.deepEqual(r.model_check.models, ["claude-opus-5-5-20261101"]);
  assert.equal(r.paired_codeact_minus_direct.model_turns.mean, -1);
  assert.equal(r.variants.direct.metrics.sdk_calls.mean, 1);
  assert.equal(r.variants.direct.metrics.model_turns.mean, 4);
  assert.equal(r.variants.direct.metrics.input_tokens_total.mean, 1210);
});

test("different models between variants: the comparison is refused as model-matched", () => {
  const r = summarize(
    [
      sample({}),
      sample({ variant: "codeact", provider_models: ["claude-sonnet-5-5"], codeact_offered: true }),
    ],
    meta,
  );
  assert.equal(r.model_check.status, "mismatched");
  assert.deepEqual(r.model_check.mismatched_pairs, ["T03#0"]);
  assert.match(renderMarkdown(r), /NOT model-matched/);
});

test("unresolved model identity: reported as unverified, never as matched", () => {
  const r = summarize(
    [
      sample({ provider_models: [], model_resolution: "unresolved" }),
      sample({ variant: "codeact", provider_models: [], model_resolution: "unresolved" }),
    ],
    meta,
  );
  assert.equal(r.model_check.status, "unverified");
  assert.equal(r.model_check.unresolved_samples, 2);
});

test("an interrupted sample keeps unknown usage: excluded from known counts, never zero", () => {
  const r = summarize(
    [
      sample({}),
      sample({
        variant: "codeact",
        turn_status: "failed",
        correct: false,
        model_turns: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        input_tokens_total: null,
        cost_usd: null,
      }),
    ],
    meta,
  );
  assert.equal(r.variants.codeact.metrics.cost_usd.known, 0);
  assert.equal(r.variants.codeact.metrics.cost_usd.mean, null);
  assert.equal(r.paired_codeact_minus_direct.cost_usd.n, 0);
  assert.equal(r.paired_codeact_minus_direct.correct.mean, -1);
});
