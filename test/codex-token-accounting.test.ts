import { test } from "node:test";
import assert from "node:assert/strict";
import { codexMetricUsage, parseCodexLine, type CodexUsage } from "../src/agent/codex/stream.ts";
import { addUsage, newMetrics } from "../src/agent/metrics.ts";

const usage = (over: Partial<CodexUsage>): CodexUsage => ({
  input_tokens: null,
  cached_input_tokens: null,
  output_tokens: null,
  reasoning_output_tokens: null,
  ...over,
});
const tokens = (u: CodexUsage) => {
  const m = newMetrics("gpt");
  addUsage(m, codexMetricUsage(u));
  return m.tokens;
};
/** What the run summary and the token benchmark add up: input + cache_read + cache_creation. */
const total = (t: ReturnType<typeof tokens>) =>
  (t?.input ?? 0) + (t?.cache_read ?? 0) + (t?.cache_creation ?? 0);

test("codex input includes the cached part: tokens.input becomes the uncached input, so cached tokens count once", () => {
  const t = tokens(usage({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }));
  assert.deepEqual(t, { input: 200, output: 50, cache_read: 800, cache_creation: null });
  assert.equal(total(t), 1000, "the provider's real input, not 1800");
});

test("a real codex turn.completed line goes through the adapter to the same totals", () => {
  const parsed = parseCodexLine(
    '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":1,"reasoning_output_tokens":1}}',
  );
  assert.ok("event" in parsed && parsed.event.type === "turn.completed" && parsed.event.usage);
  const raw = (parsed.event as { usage: CodexUsage }).usage;
  assert.equal(raw.input_tokens, 5, "the parsed event keeps what the provider reported");
  assert.deepEqual(tokens(raw), {
    input: 3,
    output: 1,
    cache_read: 2,
    cache_creation: null,
    reasoning_output: 1,
  });
});

test("fully cached input, zero values and a cache write are accounted exactly", () => {
  assert.equal(tokens(usage({ input_tokens: 700, cached_input_tokens: 700 }))?.input, 0);
  assert.deepEqual(tokens(usage({ input_tokens: 0, cached_input_tokens: 0 })), {
    input: 0,
    output: null,
    cache_read: 0,
    cache_creation: null,
  });
  assert.equal(tokens(usage({ input_tokens: 90, cached_input_tokens: 0 }))?.input, 90);
  const written = tokens(
    usage({ input_tokens: 90, cached_input_tokens: 30, cache_write_input_tokens: 20 }),
  );
  assert.deepEqual([written?.input, written?.cache_read, written?.cache_creation], [60, 30, 20]);
});

test("missing values stay unknown, never invented or negative", () => {
  assert.equal(
    tokens(usage({ cached_input_tokens: 40 }))?.input ?? null,
    null,
    "no input reported",
  );
  assert.equal(tokens(usage({ cached_input_tokens: 40 }))?.cache_read, 40);
  const noCache = tokens(usage({ input_tokens: 120 }));
  assert.deepEqual(
    [noCache?.input, noCache?.cache_read],
    [120, null],
    "cached unknown: input as reported",
  );
  assert.equal(tokens(usage({})), null, "nothing reported, nothing recorded");
});

test("an inconsistent report (cached above input: not a subset) is kept as reported and never goes negative", () => {
  const t = tokens(usage({ input_tokens: 100, cached_input_tokens: 400 }));
  assert.deepEqual([t?.input, t?.cache_read], [100, 400]);
  assert.ok((t?.input ?? 0) >= 0);
  // Invalid values (negative, NaN, text) are dropped by the parser before they reach the metrics.
  const bad = parseCodexLine(
    '{"type":"turn.completed","usage":{"input_tokens":-5,"cached_input_tokens":"x","output_tokens":2}}',
  );
  const u = (bad as { event: { usage: CodexUsage } }).event.usage;
  assert.deepEqual([u.input_tokens, u.cached_input_tokens], [null, null]);
});

test("other providers' accounting is unchanged: a Claude-style usage keeps input as the uncached input", () => {
  const m = newMetrics("claude-sonnet-5-5");
  addUsage(m, {
    input_tokens: 4,
    output_tokens: 1743,
    cache_read_input_tokens: 35206,
    cache_creation_input_tokens: 93472,
  });
  assert.deepEqual(m.tokens, { input: 4, output: 1743, cache_read: 35206, cache_creation: 93472 });
});
